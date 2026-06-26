/**
 * routes/gallery.js - Gallery page + API routes
 */
import fs from 'node:fs';
import path from 'node:path';

export default function (app, ctx) {
  const pluginDir = ctx.pluginDir;
  const normalizePath = (p) => (typeof p !== 'string' ? '' : p).replace(/\\/g, '/');
  let _SQL_module = null;

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

  /* ── Search (unified: images + media_items) ── */
  app.get('/api/gallery/search', async (c) => {
    try {
      const { initDb, queryAll, queryOne } = await import('../lib/db.js');
      await initDb(ctx);
      const keyword = c.req.query('keyword') || '';
      const tag = c.req.query('tag') || '';
      const pageSize = parseInt(c.req.query('pageSize') || '50', 10);
      const page = Math.max(1, parseInt(c.req.query('page') || '1', 10));
      const offset = (page - 1) * pageSize;

      // 统一查询参数
      const showGenerated = c.req.query('showGenerated') !== 'false'; // 默认 true
      const showVideo = c.req.query('showVideo') === 'true';           // 默认 false

      let allResults = [];
      let totalLocal = 0;
      let totalGen = 0;

      // ── 1. 查询原 images 表（本地导入） ──
      const localConditions = ['hidden = 0'];
      const localParams = [];
      if (keyword) { localConditions.push('(filename LIKE ? OR path LIKE ?)'); localParams.push('%' + keyword + '%', '%' + keyword + '%'); }

      const totalLocalRow = queryOne('SELECT COUNT(*) as cnt FROM images ' + (localConditions.length ? 'WHERE ' + localConditions.join(' AND ') : ''), localParams.slice());
      totalLocal = totalLocalRow ? totalLocalRow.cnt : 0;

      let localRows = queryAll('SELECT * FROM images ' + (localConditions.length ? 'WHERE ' + localConditions.join(' AND ') : '') + ' ORDER BY COALESCE(date_taken, date_imported) DESC LIMIT ? OFFSET ?', [...localParams, Math.min(pageSize, 500), offset]);

      const { getImageTags } = await import('../lib/tagger.js');
      allResults = localRows.map(function(img){
        return {
          id: img.id, path: img.path, filename: img.filename, ext: img.ext,
          size_bytes: img.size_bytes, width: img.width, height: img.height,
          date_taken: img.date_taken, date_imported: img.date_imported,
          source: 'import', media_type: 'image',
          tags: getImageTags(img.id),
          prompt: null, model_id: null
        };
      });

      // ── 2. 查询 media_items 表（AI 生成） ──
      if (showGenerated) {
        // 直接用 gallery 自己的 sql.js 打开 media-hub 的数据库文件
        const hubDbPath = path.resolve(ctx.config?.['mediaHub.galleryRoot'] || 'D:/Pictures/gallery', '_media_hub.db');
        let hubDb = null;
        try {
          if (fs.existsSync(hubDbPath)) {
            if (!_SQL_module) _SQL_module = await import('sql.js').then(m => m.default || m).then(init => init());
            const buf = fs.readFileSync(hubDbPath);
            hubDb = new _SQL_module.Database(new Uint8Array(buf));
          }
        } catch(_) {}
        if (!hubDb) { /* media-hub DB 不存在，跳过 */ }
        else {
        const _hubQueryAll = (sql, params=[]) => { const stmt=hubDb.prepare(sql); if(params.length)stmt.bind(params); const r=[]; while(stmt.step())r.push(stmt.getAsObject()); stmt.free(); return r; };
        const _hubQueryOne = (sql, params=[]) => { const stmt=hubDb.prepare(sql); if(params.length)stmt.bind(params); let r=null; if(stmt.step())r=stmt.getAsObject(); stmt.free(); return r; };
        const genConditions = ['hidden = 0'];
        const genParams = [];
        if (keyword) { genConditions.push('(filename LIKE ? OR prompt LIKE ? OR path LIKE ?)'); genParams.push('%' + keyword + '%', '%' + keyword + '%', '%' + keyword + '%'); }
        if (showVideo) { genConditions.push('media_type IN ("image","video")'); }

        const totalGenRow = _hubQueryOne('SELECT COUNT(*) as cnt FROM media_items ' + (genConditions.length ? 'WHERE ' + genConditions.join(' AND ') : ''), genParams.slice());
        totalGen = totalGenRow ? totalGenRow.cnt : 0;

        let genRows = _hubQueryAll(
          'SELECT id, filename, ext, path, size_bytes, width, height, date_taken, date_imported, prompt, model_id, source, media_type, favorited FROM media_items ' +
          (genConditions.length ? 'WHERE ' + genConditions.join(' AND ') : '') +
          ' ORDER BY COALESCE(date_taken, date_imported) DESC LIMIT ? OFFSET ?',
          [...genParams, Math.min(pageSize, 500), offset]
        );

        // 标签查询（media_items 用 image_tags + tags 表）
        if (tag) {
          const taggedIds = _hubQueryAll('SELECT DISTINCT image_id FROM image_tags WHERE tag_id IN (SELECT id FROM tags WHERE name = ?)', [tag]);
          const taggedSet = new Set(taggedIds.map(r => r.image_id));
          genRows = genRows.filter(r => taggedSet.has(r.id));
        }

        genRows.forEach(function(img) {
          // 检查是否与本地图片重复（相同 id 或相同 path）
          const dup = allResults.find(function(a){ return a.id === img.id || a.path === img.path; });
          if (!dup) {
            allResults.push({
              id: img.id, path: img.path, filename: img.filename, ext: img.ext,
              size_bytes: img.size_bytes, width: img.width, height: img.height,
              date_taken: img.date_taken, date_imported: img.date_imported,
              source: img.source || 'generated', media_type: img.media_type || 'image',
              tags: [], prompt: img.prompt, model_id: img.model_id,
              favorited: img.favorited
            });
          }
        });
        } // end if hubDb
      }

      // ── 3. 合并总数和分页 ──
      const total = totalLocal + totalGen;
      const totalPages = Math.max(1, Math.ceil(total / pageSize));

      return c.json({
        status: 'ok',
        count: allResults.length,
        total: total,
        page: page,
        totalPages: totalPages,
        pages: totalPages,
        results: allResults,
        totalLocal: totalLocal,
        totalGenerated: totalGen
      });
    } catch (e) { ctx.log.warn('search error:', e.message); return c.json({ status: 'error', error: e.message }, 500); }
  });

  /* ── Tags ── */
  app.get('/api/gallery/tags', async (c) => {
    try {
      const { initDb } = await import('../lib/db.js');
      await initDb(ctx);
      const { listTags } = await import('../lib/tagger.js');
      const tags = listTags(true);
      // 补充 media_items 的标签
      try {
        const hubDbPath = path.resolve(ctx.config?.['mediaHub.galleryRoot'] || 'D:/Pictures/gallery', '_media_hub.db');
        if (fs.existsSync(hubDbPath)) {
          if (!_SQL_module) _SQL_module = await import('sql.js').then(m => m.default || m).then(init => init());
          const hubDb2 = new _SQL_module.Database(new Uint8Array(fs.readFileSync(hubDbPath)));
          const stmt2 = hubDb2.prepare('SELECT DISTINCT t.name, COUNT(it.image_id) as cnt FROM tags t JOIN image_tags it ON t.id = it.tag_id GROUP BY t.name ORDER BY cnt DESC');
          while (stmt2.step()) { const row = stmt2.getAsObject(); if (!tags.find(function(t){ return t.name === row.name; })) tags.push({ name: row.name, image_count: row.cnt }); }
          stmt2.free(); hubDb2.close();
        }
      } catch(_) {}
      return c.json({ status: 'ok', count: tags.length, tags: tags });
    } catch (e) { return c.json({ status: 'error', error: e.message }, 500); }
  });

  /* ── Image/Video file ── */
  app.get('/api/gallery/image/:id', async (c) => {
    try {
      const id = c.req.param('id'); if (!id) return c.json({ error: 'missing id' }, 400);
      const { initDb, queryOne } = await import('../lib/db.js');
      await initDb(ctx);

      // 先查 images 表
      let img = queryOne('SELECT path FROM images WHERE id = ?', [id]);
      let source = 'import';

      // 没找到，查 media_items 表
      if (!img) {
        try {
          const hubDbPath3 = path.resolve(ctx.config?.['mediaHub.galleryRoot'] || 'D:/Pictures/gallery', '_media_hub.db');
          if (fs.existsSync(hubDbPath3)) {
            if (!_SQL_module) _SQL_module = await import('sql.js').then(m => m.default || m).then(init => init());
            const hubDb3 = new _SQL_module.Database(new Uint8Array(fs.readFileSync(hubDbPath3)));
            const stmt3 = hubDb3.prepare('SELECT path FROM media_items WHERE id = ?'); stmt3.bind([id]);
            if (stmt3.step()) img = stmt3.getAsObject();
            stmt3.free(); hubDb3.close();
            if (img) source = 'media_hub';
          }
        } catch(_) {}
      }

      if (!img) return c.json({ error: 'not found' }, 404);

      // 外部链接：重定向
      if (img.path && img.path.startsWith('ext:')) {
        const externalUrl = img.path.substring(4);
        return c.redirect(externalUrl, 302);
      }

      // media-hub 的 path 可能是绝对路径
      const fp = img.path;
      if (!fs.existsSync(fp)) return c.json({ error: 'file not found on disk' }, 404);
      const ext = path.extname(fp).toLowerCase();
      const mime = {
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
        '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
        '.tiff': 'image/tiff', '.tif': 'image/tiff', '.avif': 'image/avif',
        '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime'
      };
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