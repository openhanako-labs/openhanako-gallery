// gallery.js - Gallery page + API routes
import fs from 'node:fs';
import path from 'node:path';

export default function (app, ctx) {
  const pluginDir = ctx.pluginDir;
  const normalizePath = (p) => (typeof p !== 'string' ? '' : p).replace(/\\/g, '/');
  let _SQL_module = null;

  app.get('/gallery', async (c) => {
    const html = fs.readFileSync(path.join(pluginDir, 'pages', 'gallery.html'), 'utf-8');
    return c.html(html);
  });

  /* ── Search ── */
  app.get('/api/gallery/search', async (c) => {
    try {
      const { initDb, queryAll, queryOne } = await import('../lib/db.js');
      await initDb(ctx);

      const page = parseInt(c.req.query('page') || '1', 10);
      const pageSize = Math.min(parseInt(c.req.query('pageSize') || '50', 10), 500);
      const keyword = c.req.query('keyword') || '';
      const tag = c.req.query('tag') || '';
      const sort = c.req.query('sort') || 'date_desc';
      const ratio = c.req.query('ratio') || '';
      const showGenerated = c.req.query('showGenerated') !== 'false';
      const showVideo = c.req.query('showVideo') === 'true';
      const offset = (page - 1) * pageSize;

      // ── 1. 查询本地 images 表 ──
      let totalLocal = 0;
      let allResults = [];

      const conditions = ['hidden = 0'];
      const params = [];
      if (keyword) { conditions.push('(filename LIKE ? OR path LIKE ?)'); params.push('%' + keyword + '%', '%' + keyword + '%'); }
      if (tag) {
        conditions.push('id IN (SELECT image_id FROM image_tags WHERE tag_id IN (SELECT id FROM tags WHERE name = ?))');
        params.push(tag);
      }
      if (ratio) {
        if (ratio === 'favorite') conditions.push("id IN (SELECT image_id FROM image_tags WHERE tag_id IN (SELECT id FROM tags WHERE name = '☆收藏'))");
        else if (ratio === 'wide') conditions.push('CAST(width AS REAL) / CAST(height AS REAL) > 1.2');
        else if (ratio === 'tall') conditions.push('CAST(width AS REAL) / CAST(height AS REAL) < 0.8');
        else if (ratio === 'square') conditions.push('CAST(width AS REAL) / CAST(height AS REAL) BETWEEN 0.9 AND 1.1');
      }

      const totalRow = queryOne('SELECT COUNT(*) as cnt FROM images WHERE ' + conditions.join(' AND '), params.slice());
      totalLocal = totalRow ? totalRow.cnt : 0;

      let sortClause = 'date_taken DESC';
      if (sort === 'date_asc') sortClause = 'date_taken ASC';
      else if (sort === 'name_asc') sortClause = 'filename ASC';
      else if (sort === 'name_desc') sortClause = 'filename DESC';
      else if (sort === 'size_desc') sortClause = 'size_bytes DESC';
      else if (sort === 'size_asc') sortClause = 'size_bytes ASC';

      let localRows = queryAll(
        'SELECT id, filename, ext, path, size_bytes, width, height, date_taken, date_imported FROM images WHERE ' + conditions.join(' AND ') + ' ORDER BY ' + sortClause + ' LIMIT ? OFFSET ?',
        [...params, pageSize, offset]
      );

      const { getImageTags } = await import('../lib/tagger.js');
      localRows.forEach(function(img) {
        allResults.push({
          id: img.id, path: img.path, filename: img.filename, ext: img.ext,
          size_bytes: img.size_bytes, width: img.width, height: img.height,
          date_taken: img.date_taken, date_imported: img.date_imported,
          source: 'import', media_type: 'image',
          tags: getImageTags(img.id),
          prompt: null, model_id: null,
          favorited: 0
        });
      });

      // ── 2. 扫描 image-gen 生成目录（AI 生成） ──
      let totalGen = 0;
      if (showGenerated) {
        // 从 hanako 数据目录读取 image-gen 路径，不硬编码
        const os = await import('os');
        const hanakoHome = process.env.HANAKO_DATA_DIR || path.join(os.homedir(), '.hanako');
        const genDir = path.join(hanakoHome, 'plugin-data', 'image-gen', 'generated');
        if (fs.existsSync(genDir)) {
          const genItems = [];
          const files = fs.readdirSync(genDir);
          for (const f of files) {
            const fp = path.join(genDir, f);
            try { if (!fs.statSync(fp).isFile()) continue; } catch(_) { continue; }
            const ext = path.extname(f).toLowerCase();
            const isImg = ['.png','.jpg','.jpeg','.webp','.gif'].includes(ext);
            const isVid = ['.mp4','.webm','.mov','.avi','.mkv'].includes(ext);
            if (!isImg && !isVid) continue;
            if (!showVideo && isVid) continue;
            if (keyword && !f.toLowerCase().includes(keyword.toLowerCase())) continue;
            try {
              const stat = fs.statSync(fp);
              genItems.push({
                id: 'gen_' + f,
                path: fp,
                filename: f,
                ext: ext.replace('.',''),
                size_bytes: stat.size,
                width: 0, height: 0,
                date_taken: stat.mtime.toISOString(),
                date_imported: stat.mtime.toISOString(),
                source: 'generated',
                media_type: isVid ? 'video' : 'image',
                tags: [], prompt: null, model_id: null,
                favorited: 0
              });
            } catch(_) {}
          }
          genItems.sort((a,b) => new Date(b.date_taken) - new Date(a.date_taken));
          totalGen = genItems.length;
          const pageItems = genItems.slice(offset, offset + Math.min(pageSize, 500));
          pageItems.forEach(function(img) {
            const dup = allResults.find(function(a){ return a.path === img.path; });
            if (!dup) allResults.push(img);
          });
        }
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

      // 没找到，检查是否是 gen_ 开头（image-gen generated）
      if (!img && id.startsWith('gen_')) {
        const filename = id.substring(4); // 去掉 gen_
        const os = await import('os');
        const hanakoHome = process.env.HANAKO_DATA_DIR || path.join(os.homedir(), '.hanako');
        const genDir = path.join(hanakoHome, 'plugin-data', 'image-gen', 'generated');
        const fp = path.join(genDir, filename);
        if (fs.existsSync(fp)) {
          img = { path: fp };
          source = 'generated';
        }
      }

      if (!img) return c.json({ error: 'not found' }, 404);

      // 外部链接：重定向
      if (img.path && img.path.startsWith('ext:')) {
        const externalUrl = img.path.substring(4);
        return c.redirect(externalUrl, 302);
      }

      const filePath = img.path;
      if (!fs.existsSync(filePath)) return c.json({ error: 'file not found on disk' }, 404);

      const ext = path.extname(filePath).toLowerCase();
      const mimeTypes = {
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
        '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
        '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime'
      };
      const mime = mimeTypes[ext] || 'application/octet-stream';
      const data = fs.readFileSync(filePath);
      return new Response(new Uint8Array(data), {
        headers: {
          'Content-Type': mime,
          'Cache-Control': 'public, max-age=3600'
        }
      });
    } catch (e) { return c.json({ status: 'error', error: e.message }, 500); }
  });

  /* ── Config ── */
  app.get('/api/gallery/config', async (c) => {
    try {
      const { initDb, queryOne } = await import('../lib/db.js');
      await initDb(ctx);
      const galleryRoot = queryOne("SELECT value FROM config WHERE key = 'galleryRoot'")?.value || ctx.config?.['gallery.galleryRoot'] || path.join(process.cwd(), 'gallery');
      const blogImagesPath = queryOne("SELECT value FROM config WHERE key = 'blogImagesPath'")?.value || ctx.config?.['gallery.blogImagesPath'] || 'public/images/gallery';
      const thumbnailSize = parseInt(queryOne("SELECT value FROM config WHERE key = 'thumbnailSize'")?.value || ctx.config?.['gallery.thumbnailSize'] || '300');
      const autoClassify = ctx.config?.['gallery.autoClassify'] !== false;
      const scanRow = queryOne("SELECT value FROM config WHERE key = 'scanPaths'");
      let scanPaths = [];
      try { scanPaths = JSON.parse(scanRow?.value || '[]'); } catch(_) {}
      if (!Array.isArray(scanPaths)) scanPaths = [];
      return c.json({ status: 'ok', config: { galleryRoot, scanPaths, thumbnailSize, autoClassify, blogImagesPath } });
    } catch (e) { return c.json({ status: 'error', error: e.message }, 500); }
  });

  app.post('/api/gallery/config', async (c) => {
    try {
      const body = await c.req.json();
      const { initDb, runSql, flush, queryOne, queryAll, closeDb, getDb } = await import('../lib/db.js');
      if (getDb()) closeDb(ctx);
      await initDb(ctx);

      if (body.scanPaths && Array.isArray(body.scanPaths)) {
        const cleanPaths = body.scanPaths.filter(p => typeof p === 'string' && p.trim()).map(p => p.trim());
        const existing = queryOne("SELECT * FROM config WHERE key = 'scanPaths'");
        const val = JSON.stringify(cleanPaths);
        if (existing) {
          runSql("UPDATE config SET value = ? WHERE key = 'scanPaths'", [val]);
        } else {
          runSql("INSERT INTO config (key, value) VALUES ('scanPaths', ?)", [val]);
        }
      }

      // 保存 galleryRoot, blogImagesPath, thumbnailSize
      if (typeof body.galleryRoot === 'string' && body.galleryRoot.trim()) {
        const existing = queryOne("SELECT * FROM config WHERE key = 'galleryRoot'");
        if (existing) runSql("UPDATE config SET value = ? WHERE key = 'galleryRoot'", [body.galleryRoot.trim()]);
        else runSql("INSERT INTO config (key, value) VALUES ('galleryRoot', ?)", [body.galleryRoot.trim()]);
      }
      if (typeof body.blogImagesPath === 'string' && body.blogImagesPath.trim()) {
        const existing = queryOne("SELECT * FROM config WHERE key = 'blogImagesPath'");
        if (existing) runSql("UPDATE config SET value = ? WHERE key = 'blogImagesPath'", [body.blogImagesPath.trim()]);
        else runSql("INSERT INTO config (key, value) VALUES ('blogImagesPath', ?)", [body.blogImagesPath.trim()]);
      }
      if (body.thumbnailSize) {
        const existing = queryOne("SELECT * FROM config WHERE key = 'thumbnailSize'");
        if (existing) runSql("UPDATE config SET value = ? WHERE key = 'thumbnailSize'", [String(body.thumbnailSize)]);
        else runSql("INSERT INTO config (key, value) VALUES ('thumbnailSize', ?)", [String(body.thumbnailSize)]);
      }

      const newPaths = (body.scanPaths || []).filter(p => typeof p === 'string' && p.trim());
      if (body._oldPaths && Array.isArray(body._oldPaths)) {
        const oldPathsSet = new Set(body._oldPaths.filter(p => typeof p === 'string'));
        const keepSet = new Set(newPaths);
        for (const oldPath of oldPathsSet) {
          if (!keepSet.has(oldPath)) {
            const oldPathNorm = normalizePath(oldPath);
            const rows = queryAll("SELECT id, thumbnail_path FROM images WHERE source_path = ?", [oldPathNorm]);
            const galleryRoot = ctx.config?.['gallery.galleryRoot'] || path.join(process.cwd(), 'gallery');
            for (const row of rows) {
              if (row.thumbnail_path) {
                const thumbFp = path.resolve(galleryRoot, row.thumbnail_path);
                try { fs.unlinkSync(thumbFp); } catch (_) {}
              }
              runSql("DELETE FROM image_tags WHERE image_id = ?", [row.id]);
              runSql("DELETE FROM images WHERE id = ?", [row.id]);
            }
          }
        }
      }

      ctx.log.info('gallery config update requested:', JSON.stringify(body));
      flush();
      return c.json({ status: 'ok', message: '配置已更新' });
    } catch (e) { return c.json({ status: 'error', error: e.message }, 500); }
  });

  /* ── Rebuild ── */
  app.post('/api/gallery/rebuild', async (c) => {
    try {
      const galleryRoot = ctx.config?.['gallery.galleryRoot'] || path.join(process.cwd(), 'gallery');
      const { initDb, runSql } = await import('../lib/db.js');
      await initDb(ctx);
      const { scanImport: scanDirectories } = await import('../lib/scanner.js');
      const scanRow = (await import('../lib/db.js')).queryOne("SELECT value FROM config WHERE key = 'scanPaths'");
      let scanPaths = [];
      try { scanPaths = JSON.parse(scanRow?.value || '[]'); } catch(_) {}
      if (!Array.isArray(scanPaths)) scanPaths = [];
      const stats = scanDirectories(scanPaths, galleryRoot, ctx);
      return c.json({ status: 'ok', ...stats });
    } catch (e) { return c.json({ status: 'error', error: e.message }, 500); }
  });

  /* ── Import ── */
  app.post('/api/gallery/import', async (c) => {
    try {
      const body = await c.req.json();
      const { initDb } = await import('../lib/db.js');
      await initDb(ctx);
      const { scanImport: importFromDirectory } = await import('../lib/scanner.js');
      const galleryRoot = ctx.config?.['gallery.galleryRoot'] || path.join(process.cwd(), 'gallery');
      const stats = importFromDirectory(body.path, galleryRoot, ctx);
      return c.json({ status: 'ok', ...stats });
    } catch (e) { return c.json({ status: 'error', error: e.message }, 500); }
  });

  /* ── Tag management ── */
  app.get('/api/gallery/tag/list', async (c) => {
    try {
      const { initDb } = await import('../lib/db.js');
      await initDb(ctx);
      const { listTags } = await import('../lib/tagger.js');
      return c.json({ status: 'ok', tags: listTags(true) });
    } catch (e) { return c.json({ status: 'error', error: e.message }, 500); }
  });

  app.post('/api/gallery/tag/add', async (c) => {
    try {
      const body = await c.req.json();
      const { initDb } = await import('../lib/db.js');
      await initDb(ctx);
      const { addTag } = await import('../lib/tagger.js');
      addTag(body.imageId, body.tag);
      return c.json({ status: 'ok' });
    } catch (e) { return c.json({ status: 'error', error: e.message }, 500); }
  });

  app.post('/api/gallery/tag/remove', async (c) => {
    try {
      const body = await c.req.json();
      const { initDb } = await import('../lib/db.js');
      await initDb(ctx);
      const { removeTag } = await import('../lib/tagger.js');
      removeTag(body.imageId, body.tag);
      return c.json({ status: 'ok' });
    } catch (e) { return c.json({ status: 'error', error: e.message }, 500); }
  });

  /* ── Sync ── */
  app.post('/api/gallery/sync', async (c) => {
    try {
      const galleryRoot = ctx.config?.['gallery.galleryRoot'] || path.join(process.cwd(), 'gallery');
      const blogImagesPath = ctx.config?.['gallery.blogImagesPath'] || 'public/images/gallery';
      const dest = path.resolve(galleryRoot, blogImagesPath);
      const { initDb, queryAll } = await import('../lib/db.js');
      await initDb(ctx);
      const images = queryAll('SELECT id, path FROM images');
      let synced = 0;
      for (const img of images) {
        const src = img.path;
        if (!fs.existsSync(src)) continue;
        const destPath = path.join(dest, path.basename(src));
        if (!fs.existsSync(destPath)) {
          try { fs.mkdirSync(path.dirname(destPath), { recursive: true }); fs.copyFileSync(src, destPath); synced++; } catch(_) {}
        }
      }
      return c.json({ status: 'ok', synced });
    } catch (e) { return c.json({ status: 'error', error: e.message }, 500); }
  });

  /* ── Export ── */
  app.get('/api/gallery/export', async (c) => {
    try {
      const format = c.req.query('format') || 'json';
      const { initDb, queryAll } = await import('../lib/db.js');
      await initDb(ctx);
      const images = queryAll('SELECT * FROM images');
      if (format === 'sqlite') {
        return c.json({ status: 'ok', message: 'Use tool export instead' });
      }
      return c.json({ status: 'ok', count: images.length, images });
    } catch (e) { return c.json({ status: 'error', error: e.message }, 500); }
  });

  /* ── Ping ── */
  app.get('/api/gallery/ping', async (c) => {
    return c.json({ status: 'ok', message: 'pong', time: Date.now() });
  });

  /* ── Thumbnail ── */
  app.get('/api/gallery/thumb/:id', async (c) => {
    try {
      const id = c.req.param('id');
      const { initDb, queryOne } = await import('../lib/db.js');
      await initDb(ctx);
      let img = queryOne('SELECT thumbnail_path, path FROM images WHERE id = ?', [id]);

      // 检查 gen_ 前缀（image-gen generated）
      if (!img && id.startsWith('gen_')) {
        const filename = id.substring(4);
        const os = await import('os');
        const hanakoHome = process.env.HANAKO_DATA_DIR || path.join(os.homedir(), '.hanako');
        const genDir = path.join(hanakoHome, 'plugin-data', 'image-gen', 'generated');
        const fp = path.join(genDir, filename);
        if (fs.existsSync(fp)) {
          img = { path: fp, thumbnail_path: null };
        }
      }

      if (!img) return c.json({ error: 'not found' }, 404);
      const filePath = img.thumbnail_path ? path.resolve(ctx.config?.['gallery.galleryRoot'] || path.join(process.cwd(), 'gallery'), img.thumbnail_path) : img.path;
      if (!fs.existsSync(filePath)) return c.json({ error: 'file not found' }, 404);
      const ext = path.extname(filePath).toLowerCase();
      const mimeTypes = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.mp4': 'video/mp4', '.webm': 'video/webm' };
      const mime = mimeTypes[ext] || 'application/octet-stream';
      const data = fs.readFileSync(filePath);
      return new Response(new Uint8Array(data), { headers: { 'Content-Type': mime, 'Cache-Control': 'public, max-age=3600' } });
    } catch (e) { return c.json({ status: 'error', error: e.message }, 500); }
  });
}
