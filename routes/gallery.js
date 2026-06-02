/**
 * routes/gallery.js - Gallery page + API routes
 */
import fs from 'node:fs';
import path from 'node:path';

export default function (app, ctx) {
  const pluginDir = ctx.pluginDir;
  const normalizePath = (p) => p.replace(/\\/g, '/');

  app.get('/gallery', async (c) => {
    const htmlPath = path.join(pluginDir, 'pages', 'gallery.html');
    try {
      const theme = c.req.query('hana-theme') || 'dark';
      let html = fs.readFileSync(htmlPath, 'utf-8');
      html = html.replace('<body', '<body data-hana-theme="' + theme.replace(/["'`<>]/g, '') + '" data-surface="page"');
      return c.html(html);
    } catch {
      return c.html('<html><body data-hana-theme="dark" data-surface="page" style="background:#faf8f0;color:#5a4a3a;display:flex;align-items:center;justify-content:center;height:100vh"><h1>Gallery</h1></body></html>');
    }
  });

  /* ── Search ── */
  app.get('/api/gallery/search', async (c) => {
    try {
      const { initDb, queryAll, queryOne } = await import('../lib/db.js');
      await initDb(ctx);
      const keyword = c.req.query('keyword') || '';
      const tag = c.req.query('tag') || '';
      const pageSize = parseInt(c.req.query('pageSize') || '50', 10);
      const page = Math.max(1, parseInt(c.req.query('page') || '1', 10));
      const offset = (page - 1) * pageSize;
      const conditions = ['hidden = 0']; const params = [];
      if (keyword) { conditions.push('(filename LIKE ? OR path LIKE ?)'); params.push('%' + keyword + '%', '%' + keyword + '%'); }

      // 总数
      const totalRow = queryOne('SELECT COUNT(*) as cnt FROM images ' + (conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''), params.slice());
      const total = totalRow ? totalRow.cnt : 0;
      const totalPages = Math.max(1, Math.ceil(total / pageSize));

      // 分页查询
      let rows = queryAll('SELECT * FROM images ' + (conditions.length ? 'WHERE ' + conditions.join(' AND ') : '') + ' ORDER BY COALESCE(date_taken, date_imported) DESC LIMIT ? OFFSET ?', [...params, Math.min(pageSize, 500), offset]);
      if (tag) {
        const { findImagesByTags } = await import('../lib/tagger.js');
        const ids = new Set(findImagesByTags([tag]).map(function(r){ return r.image_id; }));
        rows = rows.filter(function(r){ return ids.has(r.id); });
      }
      const { getImageTags } = await import('../lib/tagger.js');
      const results = rows.map(function(img){ return { id: img.id, path: img.path, filename: img.filename, ext: img.ext, size_bytes: img.size_bytes, width: img.width, height: img.height, date_taken: img.date_taken, date_imported: img.date_imported, tags: getImageTags(img.id) }; });
      return c.json({ status: 'ok', count: results.length, total, page, totalPages, pages: totalPages, results: results });
    } catch (e) { ctx.log.warn('search error:', e.message); return c.json({ status: 'error', error: e.message }, 500); }
  });

  /* ── Tags ── */
  app.get('/api/gallery/tags', async (c) => {
    try {
      const { initDb } = await import('../lib/db.js');
      await initDb(ctx);
      const { listTags } = await import('../lib/tagger.js');
      return c.json({ status: 'ok', count: 0, tags: listTags(true) });
    } catch (e) { return c.json({ status: 'error', error: e.message }, 500); }
  });

  /* ── Image file ── */
  app.get('/api/gallery/image/:id', async (c) => {
    try {
      const id = c.req.param('id'); if (!id) return c.json({ error: 'missing id' }, 400);
      const { initDb, queryOne } = await import('../lib/db.js');
      await initDb(ctx);
      const img = queryOne('SELECT path FROM images WHERE id = ?', [id]);
      if (!img) return c.json({ error: 'not found' }, 404);
      // 外部链接：重定向
      if (img.path && img.path.startsWith('ext:')) {
        const externalUrl = img.path.substring(4);
        return c.redirect(externalUrl, 302);
      }
      // 纯索引模式：path 是绝对路径
      const fp = img.path;
      if (!fs.existsSync(fp)) return c.json({ error: 'file not found on disk' }, 404);
      const ext = path.extname(fp).toLowerCase();
      const mime = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp' };
      return c.body(fs.readFileSync(fp), 200, { 'Content-Type': mime[ext] || 'application/octet-stream' });
    } catch (e) { ctx.log.warn('image error:', e.message); return c.json({ error: e.message }, 500); }
  });

  /* ── Config: GET ── */
  app.get('/api/gallery/config', async (c) => {
    try {
      const { initDb, queryAll, queryOne } = await import('../lib/db.js');
      await initDb(ctx);

      // 从 SQLite config 表读取持久化的 scanPaths
      let dbScanPaths = [];
      try {
        const row = queryOne("SELECT value FROM config WHERE key = 'scanPaths'");
        if (row && row.value) {
          dbScanPaths = JSON.parse(row.value);
        }
      } catch (_) { /* config 表可能不存在 */ }

      // 优先使用数据库里的 scanPaths，否则回退到 ctx.config
      const scanPaths = dbScanPaths.length > 0 ? dbScanPaths : ([]).concat(ctx.config?.['gallery.scanPaths'] || [[]]);

      return c.json({
        status: 'ok',
        config: {
          galleryRoot: ctx.config?.['gallery.galleryRoot'] || path.join(process.cwd(), 'gallery'),
          scanPaths: scanPaths,
          thumbnailSize: ctx.config?.['gallery.thumbnailSize'] || 300,
          autoClassify: ctx.config?.['gallery.autoClassify'] ?? true,
          blogImagesPath: ctx.config?.['gallery.blogImagesPath'] || 'public/images/gallery'
        }
      });
    } catch (e) { return c.json({ status: 'error', error: e.message }, 500); }
  });

  /* ── Config: POST (save via ctx) ── */
  app.post('/api/gallery/config', async (c) => {
    try {
      const body = await c.req.json();
      const { initDb, runSql, flush, queryOne, queryAll, closeDb, getDb } = await import('../lib/db.js');
      // 先关闭旧实例，强制从磁盘重新加载（确保 ALTER TABLE 的列变更生效）
      if (getDb()) closeDb(ctx);
      await initDb(ctx);

      // scanPaths 直接写入 SQLite 的配置表
      if (body.scanPaths && Array.isArray(body.scanPaths)) {
        const existing = queryOne("SELECT * FROM config WHERE key = 'scanPaths'");
        const val = JSON.stringify(body.scanPaths);
        if (existing) {
          runSql("UPDATE config SET value = ? WHERE key = 'scanPaths'", [val]);
        } else {
          runSql("INSERT INTO config (key, value) VALUES ('scanPaths', ?)", [val]);
        }
      }

      // 清理：当新 scanPaths 中不存在的路径，删除该来源目录下的图片记录 + 缩略图（不删源文件）
      const newPaths = body.scanPaths || [];
      if (body._oldPaths && Array.isArray(body._oldPaths)) {
        const oldPathsSet = new Set(body._oldPaths);
        const keepSet = new Set(newPaths);
        const removed = oldPathsSet.difference(keepSet);
        if (removed.size > 0) {
          const galleryRoot = ctx.config?.['gallery.galleryRoot'] || path.join(process.cwd(), 'gallery');
          for (const oldPath of removed) {
            const oldPathNorm = normalizePath(oldPath);
            const rows = queryAll("SELECT id, thumbnail_path FROM images WHERE source_path = ?", [oldPathNorm]);
            let cleaned = 0;
            for (const row of rows) {
              if (row.thumbnail_path) {
                const thumbFp = path.resolve(galleryRoot, row.thumbnail_path);
                try { fs.unlinkSync(thumbFp); } catch (_) {}
              }
              runSql("DELETE FROM image_tags WHERE image_id = ?", [row.id]);
              runSql("DELETE FROM images WHERE id = ?", [row.id]);
              cleaned++;
            }
            if (cleaned > 0) ctx.log.info(`Removed ${cleaned} images from deleted path: ${oldPath}`);
          }
        }
      }

      // 其他配置项暂不持久化（仍需在 Hanako 设置中修改）
      ctx.log.info('gallery config update requested:', JSON.stringify(body));
      flush();
      return c.json({ status: 'ok', message: '配置已更新' });
    } catch (e) { return c.json({ status: 'error', error: e.message }, 500); }
  });

  /* ── Rebuild ── */
  app.post('/api/gallery/rebuild', async (c) => {
    try {
      const galleryRoot = ctx.config?.['gallery.galleryRoot'] || path.join(process.cwd(), 'gallery');
      const { initDb, runSql, flush, queryOne, closeDb, getDb } = await import('../lib/db.js');
      // 强制刷新 DB 实例，确保 schema 变更生效
      if (getDb()) closeDb(ctx);
      await initDb(ctx);
      const { rebuildIndex } = await import('../lib/scanner.js');
      const result = await rebuildIndex(galleryRoot);
      return c.json({ status: 'ok', ...result });
    } catch (e) { return c.json({ status: 'error', error: e.message }, 500); }
  });

  /* ── Import ── */
  app.post('/api/gallery/import', async (c) => {
    try {
      const body = await c.req.json();
      const galleryRoot = ctx.config?.['gallery.galleryRoot'] || path.join(process.cwd(), 'gallery');
      const autoClassify = ctx.config?.['gallery.autoClassify'] ?? true;
      // 优先使用前端传来的 paths，否则用配置的 scanPaths
      const scanPaths = (body.paths && Array.isArray(body.paths) && body.paths.length) 
        ? body.paths 
        : [].concat(ctx.config?.['gallery.scanPaths'] || [[]]);
      const { initDb, closeDb, getDb } = await import('../lib/db.js');
      if (getDb()) closeDb(ctx);
      await initDb(ctx);
      const { scanImport } = await import('../lib/scanner.js');
      let totalImported = 0;
      for (const sp of scanPaths) {
        const r = await scanImport(galleryRoot, sp, autoClassify);
        totalImported += r.summary.imported;
      }
      return c.json({ status: 'ok', totalImported: totalImported });
    } catch (e) { return c.json({ status: 'error', error: e.message }, 500); }
  });

  /* ── Rename image ── */
  app.post('/api/gallery/rename', async (c) => {
    try {
      const body = await c.req.json();
      const id = body.id; const name = body.name;
      if (!id || !name) return c.json({ status: 'error', error: 'missing id or name' }, 400);
      const { initDb, runSql, flush, queryOne } = await import('../lib/db.js');
      await initDb(ctx);
      // 从数据库获取实际扩展名
      const img = queryOne('SELECT ext FROM images WHERE id = ?', [id]);
      if (!img) return c.json({ status: 'error', error: 'image not found' }, 404);
      runSql('UPDATE images SET filename = ? WHERE id = ?', [name + '.' + img.ext, id]);
      flush();
      return c.json({ status: 'ok' });
    } catch (e) { return c.json({ status: 'error', error: e.message }, 500); }
  });

  /* ── Tag image ── */
  app.post('/api/gallery/tag', async (c) => {
    try {
      const body = await c.req.json();
      const id = body.id; const tags = body.tags;
      if (!id || !tags) return c.json({ status: 'error', error: 'missing id or tags' }, 400);
      const { initDb } = await import('../lib/db.js');
      await initDb(ctx);
      const { addTags, removeTags } = await import('../lib/tagger.js');
      if (body.action === 'remove') removeTags([id], tags);
      else addTags([id], Array.isArray(tags) ? tags : [tags]);
      return c.json({ status: 'ok' });
    } catch (e) { return c.json({ status: 'error', error: e.message }, 500); }
  });

  /* Import from URL */
  app.post('/api/gallery/import-url', async (c) => {
    try {
      const body = await c.req.json();
      const url = body.url;
      if (!url) return c.json({ status: 'error', error: 'missing url' }, 400);
      const galleryRoot = ctx.config?.['gallery.galleryRoot'] || path.join(process.cwd(), 'gallery');
      const importDir = galleryRoot + '/netimports';
      if (!fs.existsSync(importDir)) fs.mkdirSync(importDir, { recursive: true });
      const urlPath = new URL(url).pathname;
      const ext = urlPath.substring(urlPath.lastIndexOf('.')) || '.jpg';
      const filename = 'url_' + Date.now() + '.jpg';
      const filepath = importDir + '/' + filename;
      const resp = await fetch(url);
      if (!resp.ok) return c.json({ status: 'error', error: 'download failed: ' + resp.status }, 400);
      const buf = Buffer.from(await resp.arrayBuffer());
      fs.writeFileSync(filepath, buf);
      // 自动入库：用 scanImport 导入到图库
      const { initDb } = await import('../lib/db.js');
      await initDb(ctx);
      const { scanImport } = await import('../lib/scanner.js');
      const result = await scanImport(galleryRoot, importDir, true);
      return c.json({ status: 'ok', filename: filename, imported: result.summary.imported });
    } catch (e) { return c.json({ status: 'error', error: e.message }, 500); }
  });

  /* Add external image URL (no download) */
  app.post('/api/gallery/add-external', async (c) => {
    try {
      const body = await c.req.json();
      const url = body.url; const tags = body.tags || [];
      if (!url) return c.json({ status: 'error', error: 'missing url' }, 400);
      const { initDb, runSql, flush, closeDb, getDb } = await import('../lib/db.js');
      if (getDb()) closeDb(ctx);
      await initDb(ctx);
      const { randomUUID } = await import('crypto');
      const id = randomUUID();
      const now = new Date().toISOString();
      const filename = url.split('/').pop() || 'external.jpg';
      const ext = filename.includes('.') ? filename.split('.').pop() : 'jpg';
      runSql(`INSERT INTO images (id, file_hash, path, filename, ext, size_bytes, date_imported, date_modified, hidden, source_path)
        VALUES (?, ?, ?, ?, ?, 0, ?, ?, 0, NULL)`, [id, 'ext_' + id, 'ext:' + url, filename, ext, now, now]);
      // 添加标签
      if (tags.length) {
        const { addTags } = await import('../lib/tagger.js');
        addTags([id], Array.isArray(tags) ? tags : [tags]);
      }
      flush();
      return c.json({ status: 'ok', id: id, filename: filename });
    } catch (e) { return c.json({ status: 'error', error: e.message }, 500); }
  });

  /* ── Delete image ── */
  app.post('/api/gallery/delete', async (c) => {
    try {
      const body = await c.req.json();
      const id = body.id;
      if (!id) return c.json({ status: 'error', error: 'missing id' }, 400);
      const galleryRoot = ctx.config?.['gallery.galleryRoot'] || path.join(process.cwd(), 'gallery');
      const { initDb, runSql, flush, queryOne } = await import('../lib/db.js');
      await initDb(ctx);
      const img = queryOne('SELECT path, thumbnail_path FROM images WHERE id = ?', [id]);
      if (!img) return c.json({ status: 'error', error: 'image not found' }, 404);
      // 1. 删除缩略图（galleryRoot/thumbs/xxx.jpg）
      if (img.thumbnail_path) {
        const thumbPath = path.resolve(galleryRoot, img.thumbnail_path);
        try { fs.unlinkSync(thumbPath); } catch (_) {}
      }
      // 2. 从 image_tags 中移除标签
      runSql('DELETE FROM image_tags WHERE image_id = ?', [id]);
      // 3. 从 images 表中删除（纯索引模式不删源文件）
      runSql('DELETE FROM images WHERE id = ?', [id]);
      flush();
      return c.json({ status: 'ok' });
    } catch (e) { return c.json({ status: 'error', error: e.message }, 500); }
  });
}