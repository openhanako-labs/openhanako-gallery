/**
 * search.js
 * 搜索图片 + 单张图片详情
 */

import crypto from 'crypto';
import path from 'path';
import fs from 'fs';

const name = 'gallery_search';
const description = `搜索图片。支持关键词、标签、日期范围、扩展名筛选。返回图片信息和缩略图路径。`;

const parameters = {
  type: 'object',
  properties: {
    keyword: {
      type: 'string',
      description: '关键词（匹配文件名）'
    },
    tag: {
      type: 'string',
      description: '标签名称（筛选带此标签的图片）'
    },
    tags: {
      type: 'array',
      items: { type: 'string' },
      description: '多个标签（默认 OR，配合 matchAll 使用 AND）'
    },
    matchAll: {
      type: 'boolean',
      description: '标签筛选模式：true=必须包含所有标签，false=任一标签',
      default: false
    },
    date_from: {
      type: 'string',
      description: '起始日期 (YYYY-MM-DD)'
    },
    date_to: {
      type: 'string',
      description: '结束日期 (YYYY-MM-DD)'
    },
    ext: {
      type: 'string',
      description: '文件扩展名筛选（如 jpg, png）'
    },
    hidden: {
      type: 'boolean',
      description: '是否包含隐藏图片',
      default: false
    },
    limit: {
      type: 'number',
      description: '返回条数上限',
      default: 50
    },
    offset: {
      type: 'number',
      description: '偏移量（分页用，从第几条开始）',
      default: 0
    },
    include_thumbnails: {
      type: 'boolean',
      description: '是否生成并返回缩略图路径',
      default: true
    },
    id: {
      type: 'string',
      description: '图片 ID（传此参数时返回单张图片详情，忽略其他筛选条件）'
    }
  },
  required: []
};

async function execute(input, ctx) {
  const { initDb, queryAll, queryOne, getDbPath } = await import('../lib/db.js');
  await initDb(ctx);

  // 如果是按 ID 查询，返回单张详情
  if (input.id) {
    const img = queryOne('SELECT * FROM images WHERE id = ?', [input.id]);
    if (!img) {
      return JSON.stringify({ status: 'error', message: `图片 ${input.id} 不存在` }, null, 2);
    }

    const { getImageTags } = await import('../lib/tagger.js');
    const tags = getImageTags(img.id);

    let thumbnail = null;
    if (input.include_thumbnails !== false) {
      try {
        const { getThumbnail } = await import('../lib/thumbnail.js');
        thumbnail = await getThumbnail(ctx, img.id);
      } catch (e) {
        thumbnail = { error: e.message };
      }
    }

    return JSON.stringify({
      status: 'ok',
      image: { ...img, tags, thumbnail }
    }, null, 2);
  }

  // 构建搜索条件
  const conditions = [];
  const params = [];

  // 关键词（文件名模糊匹配）
  if (input.keyword) {
    conditions.push('(filename LIKE ? OR path LIKE ?)');
    params.push(`%${input.keyword}%`, `%${input.keyword}%`);
  }

  // 标签（提到 SQL 层，先过滤再 limit）
  let tagImageIds = [];
  const tagNames = [];
  if (input.tag) tagNames.push(input.tag);
  if (input.tags) tagNames.push(...(Array.isArray(input.tags) ? input.tags : [input.tags]));

  if (tagNames.length > 0) {
    const { findImagesByTags } = await import('../lib/tagger.js');
    const tagged = findImagesByTags(tagNames, input.matchAll);
    tagImageIds = tagged.map(r => r.image_id);
    if (tagImageIds.length > 0) {
      conditions.push(`id IN (${tagImageIds.map(() => '?').join(',')})`);
      params.push(...tagImageIds);
    } else {
      // 没有图片匹配，直接返回空
      return JSON.stringify({ status: 'ok', count: 0, total: 0, results: [] }, null, 2);
    }
  }

  // 日期范围
  if (input.date_from) {
    conditions.push('date_taken >= ?');
    params.push(input.date_from);
  }
  if (input.date_to) {
    conditions.push('date_taken <= ?');
    params.push(input.date_to + 'T23:59:59');
  }

  // 扩展名
  if (input.ext) {
    conditions.push('ext = ?');
    params.push(input.ext.toLowerCase().replace('.', ''));
  }

  // 隐藏图片
  if (!input.hidden) {
    conditions.push('hidden = 0');
  }

  const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
  const orderBy = 'ORDER BY date_taken DESC, date_imported DESC';
  const safeLimit = Math.min(input.limit || 50, 200);
  const safeOffset = Math.max(input.offset || 0, 0);
  const limitClause = `LIMIT ${safeLimit} OFFSET ${safeOffset}`;

  const rows = queryAll(`SELECT * FROM images ${whereClause} ${orderBy} ${limitClause}`, params);

  // 获取标签和缩略图
  const { getImageTags } = await import('../lib/tagger.js');
  const results = [];

  // 并行生成前 20 张缩略图
  const { getThumbnail } = await import('../lib/thumbnail.js');
  const thumbRows = rows.slice(0, 20);
  const thumbResults = await Promise.allSettled(
    thumbRows.map(img => getThumbnail(ctx, img.id))
  );
  const thumbMap = {};
  thumbResults.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value) {
      thumbMap[thumbRows[i].id] = r.value;
    }
  });

  for (const img of rows) {
    const tags = getImageTags(img.id);
    const thumb = thumbMap[img.id];

    results.push({
      id: img.id,
      path: img.path,
      filename: img.filename,
      ext: img.ext,
      size_bytes: img.size_bytes,
      width: img.width,
      height: img.height,
      date_taken: img.date_taken,
      date_imported: img.date_imported,
      tags,
      thumbnail: thumb ? { path: thumb.path, cached: thumb.cached } : null
    });
  }

  // 获取总匹配数（不含 LIMIT/OFFSET）用于前端分页
  const countRow = queryOne(`SELECT COUNT(*) as cnt FROM images ${whereClause}`, params);

  return JSON.stringify({
    status: 'ok',
    count: results.length,
    total: countRow ? countRow.cnt : 0,
    offset: safeOffset,
    limit: safeLimit,
    results
  }, null, 2);
}

export { name, description, parameters, execute };