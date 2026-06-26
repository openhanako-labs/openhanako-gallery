/**
 * rebuild.js
 * 重建图库索引 — 扫描图库目录，重建数据库索引
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const name = 'gallery_rebuild';
const description = `重建图库索引。扫描图库目录所有图片，重新建立数据库索引。`;

const parameters = { type: 'object', properties: {}, required: [] };

async function execute(input, ctx) {
  try {
    const galleryRoot = ctx.config?.['gallery.galleryRoot'] || path.join(process.cwd(), 'gallery');

    // 初始化数据库
    const { initDb, runSql, flush, queryOne } = await import('../lib/db.js');
    await initDb(ctx);

    // 从共享模块导入共用函数（避免与 scanner.js 重复）
    const { normalizePath, walkDir, fileHash, IMAGE_EXTS } = await import('../lib/shared.js');

    // 清空索引
    runSql('DELETE FROM image_tags');
    runSql('DELETE FROM tags');
    runSql('DELETE FROM images');
    flush();

    // 扫描文件
    const allFiles = [];
    if (fs.existsSync(galleryRoot)) {
      for (const e of fs.readdirSync(galleryRoot, { withFileTypes: true })) {
        const fp = path.join(galleryRoot, e.name);
        if (e.isDirectory()) {
          if (e.name.startsWith('_')) continue;
          allFiles.push(...walkDir(fp));
        } else if (e.isFile()) {
          if (IMAGE_EXTS.has(path.extname(e.name).toLowerCase())) allFiles.push(fp);
        }
      }
    }

    const { parse: exifParse } = await import('exifr');
    let imported = 0;
    for (const f of allFiles) {
      const stat = fs.statSync(f);
      const relPath = normalizePath(path.relative(galleryRoot, f));
      const filename = path.basename(f);

      const hash = await fileHash(f);
      if (queryOne('SELECT id FROM images WHERE file_hash = ?', [hash])) continue;

      let dateTaken = null;
      try {
        const exifData = await exifParse(f, ['DateTimeOriginal']);
        dateTaken = exifData?.DateTimeOriginal ? new Date(exifData.DateTimeOriginal).toISOString() : null;
      } catch (e) {}

      const now = new Date().toISOString();
      try {
        runSql(`INSERT INTO images (id, file_hash, path, filename, ext, size_bytes, date_taken, date_imported, date_modified, hidden)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`, [
          crypto.randomUUID(), hash, relPath, filename,
          path.extname(filename).toLowerCase().replace('.', ''),
          stat.size, dateTaken, now, now
        ]);
        imported++;
      } catch (e) {}
    }

    flush();

    return JSON.stringify({
      status: 'ok', action: 'rebuild',
      summary: { total: allFiles.length, imported }
    }, null, 2);

  } catch (e) {
    return JSON.stringify({ status: 'error', error: e.message, stack: (e.stack || '').split('\n').slice(0, 5) }, null, 2);
  }
}

export { name, description, parameters, execute };