/**
 * shared.js
 * 图库共用工具函数 — 文件遍历、哈希、扩展名判定
 *
 * 从 scanner.js 和 rebuild.js 中抽取的重复逻辑。
 * lib 文件使用静态顶层 import（仅限内置模块）。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** 支持的图片扩展名 */
export const IMAGE_EXTS = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.bmp', '.tiff', '.tif'
]);

/** 路径反斜杠统一为正斜杠 */
export function normalizePath(p) {
  return p.replace(/\\/g, '/');
}

/** 递归遍历目录，返回所有图片文件绝对路径 */
export function walkDir(dirPath) {
  const files = [];
  if (!fs.existsSync(dirPath)) return files;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith('_')) continue;
      files.push(...walkDir(fullPath));
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (IMAGE_EXTS.has(ext)) files.push(fullPath);
    }
  }
  return files;
}

/** 计算文件 SHA-256 哈希 */
export function fileHash(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', d => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}
