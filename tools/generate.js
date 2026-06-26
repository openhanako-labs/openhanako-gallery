/**
 * generate.js
 * 生成 HTML 画廊页
 *
 * 按日期分组 + 标签筛选，生成独立 HTML 画廊页面。
 * 查询图片信息后直接嵌入 HTML（缩略图路径引用 gallery 内的资源）。
 */

import fs from 'fs';
import path from 'path';

const name = 'gallery_generate';
const description = `生成 HTML 画廊页。按日期分组显示图片，支持标签筛选。输出独立 HTML 文件。`;

const parameters = {
  type: 'object',
  properties: {
    tag: {
      type: 'string',
      description: '按标签筛选'
    },
    date_from: {
      type: 'string',
      description: '起始日期 (YYYY-MM-DD)'
    },
    date_to: {
      type: 'string',
      description: '结束日期 (YYYY-MM-DD)'
    },
    limit: {
      type: 'number',
      description: '图片数量上限',
      default: 200
    },
    output: {
      type: 'string',
      description: '输出 HTML 文件路径（可选，默认输出到 gallery 根目录）'
    }
  },
  required: []
};

async function execute(input, ctx) {
  try {
    const galleryRoot = ctx?.config?.['gallery.galleryRoot'] || path.join(process.cwd(), 'gallery');

    const { initDb, queryAll } = await import('../lib/db.js');
    await initDb(ctx);

    // 构建查询
    const conditions = ['hidden = 0'];
    const params = [];

    if (input.date_from) {
      conditions.push('date_taken >= ?');
      params.push(input.date_from);
    }
    if (input.date_to) {
      conditions.push('date_taken <= ?');
      params.push(input.date_to + 'T23:59:59');
    }

    const limit = Math.min(input.limit || 200, 500);
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const rows = queryAll(
      `SELECT id, path, filename, ext, date_taken, date_imported, thumbnail_path FROM images ${where} ORDER BY COALESCE(date_taken, date_imported) DESC LIMIT ?`,
      [...params, limit]
    );

    // 如果按标签筛选，过滤
    let filteredRows = rows;
    if (input.tag) {
      const { findImagesByTags, getImageTags } = await import('../lib/tagger.js');
      const tagged = findImagesByTags([input.tag]);
      const taggedIds = new Set(tagged.map(r => r.image_id));
      filteredRows = rows.filter(r => taggedIds.has(r.id));
    }

    if (filteredRows.length === 0) {
      return JSON.stringify({
        status: 'ok',
        message: '没有找到符合条件的图片',
        count: 0
      }, null, 2);
    }

    // 按日期分组
    const groups = {};
    for (const img of filteredRows) {
      const date = (img.date_taken || img.date_imported || '').split('T')[0] || '未知日期';
      if (!groups[date]) groups[date] = [];
      groups[date].push(img);
    }

    // 获取标签 — 仅在按标签筛选时获取（避免对每张图的 N 次 SQL 查询）
    const imageTags = {};
    if (input.tag) {
      const { getImageTags } = await import('../lib/tagger.js');
      for (const img of filteredRows) {
        imageTags[img.id] = getImageTags(img.id);
      }
    }

    // 计算输出目录（用于图片相对路径推算）
    const outputPath = input.output || `${galleryRoot}/_gallery.html`;
    const outputDir = path.dirname(path.resolve(outputPath));

    // URL 路径转换：图片路径相对于 HTML 输出位置
    function imgUrl(relPath) {
      const absPath = path.resolve(galleryRoot, relPath);
      const rel = path.relative(outputDir, absPath);
      // 确保使用正斜杠
      return rel.replace(/\\/g, '/');
    }

    // HTML 转义工具
    function html(s) {
      return (s == null ? '' : String(s))
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    // 生成 HTML
    const dateKeys = Object.keys(groups).sort((a, b) => b.localeCompare(a));
    let galleryHtml = '';
    for (const date of dateKeys) {
      const items = groups[date].map(img => {
        const thumb = img.thumbnail_path || img.path;
        const tags = (imageTags[img.id] || []).map(t => `<span class="tag">${html(t)}</span>`).join('');
        return `
          <div class="gallery-item" data-id="${html(img.id)}" data-img="${html(thumb)}" data-name="${html(img.filename)}">
            <img src="${html(thumb)}" alt="${html(img.filename)}" loading="lazy">
            <div class="info">${html(img.filename)}</div>
            <div class="tags">${tags}</div>
          </div>`;
      }).join('');

      galleryHtml += `
        <div class="date-group">
          <h2 class="date-header">${html(date)} <span class="count">${groups[date].length}</span></h2>
          <div class="items">${items}</div>
        </div>`;
    }

    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>图库画廊</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, system-ui, sans-serif; background: #f5f5f7; color: #1d1d1f; }
.header { background: #fff; padding: 24px 32px; border-bottom: 1px solid #e5e5ea; }
.header h1 { font-size: 24px; font-weight: 600; }
.header p { color: #86868b; font-size: 14px; margin-top: 4px; }
.container { max-width: 1200px; margin: 0 auto; padding: 24px 16px; }
.date-group { margin-bottom: 32px; }
.date-header { font-size: 18px; font-weight: 600; margin-bottom: 12px; display: flex; align-items: center; gap: 8px; }
.count { font-size: 13px; color: #86868b; font-weight: 400; background: #e8e8ed; padding: 2px 10px; border-radius: 10px; }
.items { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; }
.gallery-item { background: #fff; border-radius: 12px; overflow: hidden; cursor: pointer; transition: transform 0.15s; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
.gallery-item:hover { transform: translateY(-2px); box-shadow: 0 4px 12px rgba(0,0,0,0.12); }
.gallery-item img { width: 100%; height: 180px; object-fit: cover; display: block; }
.gallery-item .info { padding: 6px 12px 2px; font-size: 12px; color: #1d1d1f; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gallery-item .tags { padding: 0 12px 8px; display: flex; gap: 4px; flex-wrap: wrap; }
.tag { font-size: 11px; background: #e8e8ed; color: #515154; padding: 1px 8px; border-radius: 6px; }
.modal { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.8); z-index: 1000; justify-content: center; align-items: center; }
.modal.active { display: flex; }
.modal img { max-width: 90vw; max-height: 85vh; border-radius: 8px; box-shadow: 0 8px 32px rgba(0,0,0,0.4); }
.modal .close { position: absolute; top: 20px; right: 20px; color: #fff; font-size: 28px; cursor: pointer; width: 40px; height: 40px; display: flex; align-items: center; justify-content: center; border-radius: 50%; background: rgba(0,0,0,0.3); }
.modal .filename { position: absolute; bottom: 20px; left: 50%; transform: translateX(-50%); color: #fff; font-size: 14px; background: rgba(0,0,0,0.5); padding: 6px 16px; border-radius: 8px; }
</style>
</head>
<body>
<div class="header">
  <h1>📷 图库画廊</h1>
  <p>共 ${filteredRows.length} 张图片 · 按日期分组</p>
</div>
<div class="container">
  ${galleryHtml}
</div>
<div class="modal" id="modal">
  <span class="close" id="modal-close">&times;</span>
  <img id="modal-img" src="" alt="">
  <div class="filename" id="modal-filename"></div>
</div>
<script>
document.querySelector('.container').addEventListener('click', function(e) {
  var card = e.target.closest('.gallery-item');
  if (!card) return;
  document.getElementById('modal-img').src = card.getAttribute('data-img');
  document.getElementById('modal-filename').textContent = card.getAttribute('data-name');
  document.getElementById('modal').classList.add('active');
});

document.getElementById('modal').addEventListener('click', function(e) {
  if (e.target === this || e.target.id === 'modal-close') {
    this.classList.remove('active');
  }
});

document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') document.getElementById('modal').classList.remove('active');
});
</script>
</body>
</html>`;

    // 写入文件
    fs.writeFileSync(outputPath, html, 'utf-8');

    return JSON.stringify({
      status: 'ok',
      count: filteredRows.length,
      groups: dateKeys.length,
      output: outputPath
    }, null, 2);

  } catch (e) {
    return JSON.stringify({ status: 'error', error: e.message, stack: (e.stack || '').split('\n').slice(0, 3) }, null, 2);
  }
}

export { name, description, parameters, execute };