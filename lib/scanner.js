/**
 * scanner.js
 * 文件扫描 + EXIF 提取 + 索引（纯索引模式，不复制文件）
 */

import fs from 'node:fs';
import path from 'path';
import crypto from 'crypto';
import * as exifr from 'exifr';

import { queryOne, runSql, flush } from './db.js';
import { IMAGE_EXTS, normalizePath, walkDir, fileHash } from './shared.js';

function isDuplicate(hash) {
  return !!queryOne('SELECT id FROM images WHERE file_hash = ?', [hash]);
}

async function processFile(galleryRoot, filePath, autoClassify, sourcePath) {
  const filename = path.basename(filePath);

  let dateTaken = null;
  let cameraMake = null, cameraModel = null, width = null, height = null;
  try {
    const exifData = await exifr.parse(filePath, ['DateTimeOriginal', 'Make', 'Model', 'ImageWidth', 'ImageHeight']);
    if (exifData) {
      dateTaken = exifData.DateTimeOriginal ? new Date(exifData.DateTimeOriginal).toISOString() : null;
      cameraMake = exifData.Make || null;
      cameraModel = exifData.Model || null;
      width = exifData.ImageWidth || null;
      height = exifData.ImageHeight || null;
    }
  } catch (e) {}

  if (!dateTaken) {
    try { dateTaken = new Date(fs.statSync(filePath).mtime).toISOString(); }
    catch (e) { dateTaken = new Date().toISOString(); }
  }

  let hash;
  try { hash = await fileHash(filePath); }
  catch (e) { return { ok: false, file: filePath, error: `哈希失败: ${e.message}` }; }

  if (isDuplicate(hash)) return { ok: false, file: filePath, error: '重复', skipped: true };

  const relPath = normalizePath(filePath);
  const stat = fs.statSync(filePath);
  const now = new Date().toISOString();
  const id = crypto.randomUUID();

  return {
    ok: true, file: filePath,
    record: { id, file_hash: hash, path: relPath, filename: filename, ext: path.extname(filename).toLowerCase().replace('.', ''),
      size_bytes: stat.size, width, height, date_taken: dateTaken, date_imported: now, date_modified: now,
      camera_make: cameraMake, camera_model: cameraModel, thumbnail_path: null, hidden: 0,
      source_path: sourcePath || normalizePath(filePath) }
  };
}

function insertRecord(rec) {
  runSql(`INSERT INTO images (id, file_hash, path, filename, ext, size_bytes, width, height,
    date_taken, date_imported, date_modified, camera_make, camera_model, thumbnail_path, hidden, source_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    rec.id, rec.file_hash, rec.path, rec.filename, rec.ext,
    rec.size_bytes, rec.width, rec.height,
    rec.date_taken, rec.date_imported, rec.date_modified,
    rec.camera_make, rec.camera_model, rec.thumbnail_path, rec.hidden,
    rec.source_path || null
  ]);
}

export async function scanImport(galleryRoot, scanPath, autoClassify = true) {
  const start = Date.now();
  const files = walkDir(scanPath);
  if (files.length === 0) return { summary: { total: 0, imported: 0, skipped: 0, failed: 0, duration_ms: 0 }, results: [] };

  let imported = 0, skipped = 0, failed = 0;
  const results = [];
  const sourcePathNorm = normalizePath(scanPath);

  for (const f of files) {
    const r = await processFile(galleryRoot, f, autoClassify, sourcePathNorm);
    results.push({ ok: r.ok, file: r.file, imported: r.imported || null, error: r.error || null, skipped: r.skipped || false });
    if (!r.ok) { if (r.skipped) skipped++; else failed++; continue; }
    try { insertRecord(r.record); imported++; }
    catch (e) { failed++; }
  }

  flush();
  return { summary: { total: files.length, imported, skipped, failed, duration_ms: Date.now() - start }, results };
}

export async function rebuildIndex(galleryRoot) {
  runSql('DELETE FROM image_tags'); runSql('DELETE FROM tags'); runSql('DELETE FROM images');
  flush();

  const files = walkDir(galleryRoot).filter(f => { const rel = path.relative(galleryRoot, f); return !rel.startsWith('_'); });
  if (files.length === 0) return { summary: { total: 0, imported: 0 } };

  let imported = 0;
  for (const f of files) {
    const hash = await fileHash(f);
    if (isDuplicate(hash)) continue;
    const stat = fs.statSync(f);
    const relPath = normalizePath(path.relative(galleryRoot, f));
    const filename = path.basename(f);
    let dateTaken = null;
    try {
      const exifData = await exifr.parse(f, ['DateTimeOriginal']);
      dateTaken = exifData?.DateTimeOriginal ? new Date(exifData.DateTimeOriginal).toISOString() : null;
    } catch (e) {}
    const now = new Date().toISOString();
    insertRecord({
      id: crypto.randomUUID(), file_hash: hash, path: relPath, filename,
      ext: path.extname(filename).toLowerCase().replace('.', ''), size_bytes: stat.size,
      width: null, height: null, date_taken: dateTaken, date_imported: now, date_modified: now,
      camera_make: null, camera_model: null, thumbnail_path: null, hidden: 0,
      source_path: null
    });
    imported++;
  }

  flush();
  return { summary: { total: files.length, imported } };
}

export { fileHash };
