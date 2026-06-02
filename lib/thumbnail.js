/**
 * thumbnail.js
 * 缩略图按需生成 (sharp + EXIF Orientation 自动旋转)
 *
 * 缩略图缓存存储在 gallery/_thumbnails/ 目录，结构与原图平行。
 * 首次访问时生成，后续直接读取缓存。
 */

import path from 'path';
import fs from 'fs';
import sharp from 'sharp';

import { runSql, queryOne, flush } from './db.js';

/** 获取缩略图目录 */
function getThumbDir(ctx) {
  const root = ctx.config?.['gallery.galleryRoot'] || path.join(process.cwd(), 'gallery');
  return path.resolve(root, '_thumbnails');
}

/** 获取缩略图文件路径 */
function getThumbPath(ctx, relPath, size) {
  const thumbDir = getThumbDir(ctx);
  // 保持目录结构平行，如 _thumbnails/2025/03/15/IMG_2847__300.jpg
  const parsed = path.parse(relPath);
  const thumbFilename = `${parsed.name}__${size}${parsed.ext}`;
  const thumbRel = path.join(parsed.dir, thumbFilename);
  return {
    thumbDir: path.resolve(thumbDir, parsed.dir),
    thumbFile: path.resolve(thumbDir, thumbRel),
    thumbRel: path.join(parsed.dir, thumbFilename).replace(/\\/g, '/')
  };
}

/** 检查缩略图是否存在 */
function thumbExists(ctx, relPath, size) {
  const { thumbFile } = getThumbPath(ctx, relPath, size);
  return fs.existsSync(thumbFile);
}

/** 生成单张缩略图 */
export async function generateThumbnail(ctx, imageId, size) {
  const sizePx = size || ctx.config?.['gallery.thumbnailSize'] || 300;

  // 查找图片记录
  const img = queryOne('SELECT * FROM images WHERE id = ?', [imageId]);
  if (!img) throw new Error(`图片 ${imageId} 不存在`);

  const root = ctx.config?.['gallery.galleryRoot'] || path.join(process.cwd(), 'gallery');
  const sourcePath = path.resolve(root, img.path);

  if (!fs.existsSync(sourcePath)) {
    throw new Error(`源文件不存在: ${img.path}`);
  }

  // 计算缩略图路径
  const { thumbDir, thumbFile, thumbRel } = getThumbPath(ctx, img.path, sizePx);

  // 如果缩略图已存在，直接返回
  if (fs.existsSync(thumbFile)) {
    return { path: thumbRel, fullPath: thumbFile, cached: true };
  }

  // 创建目录
  if (!fs.existsSync(thumbDir)) {
    fs.mkdirSync(thumbDir, { recursive: true });
  }

  // 生成缩略图（自动处理 EXIF Orientation）
  try {
    await sharp(sourcePath)
      .rotate()            // 自动读取 EXIF Orientation 并旋转
      .resize(sizePx, null, { fit: 'inside', withoutEnlargement: true })
      .toFile(thumbFile);
  } catch (e) {
    throw new Error(`缩略图生成失败: ${e.message}`);
  }

  // 更新数据库中的缩略图路径
  runSql('UPDATE images SET thumbnail_path = ? WHERE id = ?', [thumbRel, imageId]);
  flush();

  return { path: thumbRel, fullPath: thumbFile, cached: false };
}

/** 批量生成缩略图（仅用于首次导入后的预热） */
export async function generateThumbnailsBatch(ctx, imageIds, size) {
  const results = [];
  for (const id of imageIds) {
    try {
      const r = await generateThumbnail(ctx, id, size);
      results.push({ imageId: id, ok: true, cached: r.cached });
    } catch (e) {
      results.push({ imageId: id, ok: false, error: e.message });
    }
  }
  return results;
}

/** 获取图片的缩略图路径（按需生成） */
export async function getThumbnail(ctx, imageId) {
  const img = queryOne('SELECT * FROM images WHERE id = ?', [imageId]);
  if (!img) return null;

  const sizePx = ctx.config?.['gallery.thumbnailSize'] || 300;

  // 如果已有缩略图路径且文件存在，直接返回
  if (img.thumbnail_path) {
    const root = ctx.config?.['gallery.galleryRoot'] || path.join(process.cwd(), 'gallery');
    const fullPath = path.resolve(root, img.thumbnail_path);
    if (fs.existsSync(fullPath)) {
      return { id: imageId, path: img.thumbnail_path, fullPath, cached: true };
    }
  }

  // 生成缩略图
  return await generateThumbnail(ctx, imageId, sizePx);
}