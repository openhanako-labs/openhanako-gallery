/**
 * export.js
 * 索引导出备份工具
 *
 * 将图库索引导出为 JSON 或拷贝 SQLite 文件。
 * JSON 格式包含所有图片、标签和关联数据，便于迁移和归档。
 */

import fs from 'fs';
import path from 'path';

const name = 'gallery_export';
const description = `导出图库索引。支持 JSON 格式和 SQLite 文件拷贝。`;

const parameters = {
  type: 'object',
  properties: {
    format: {
      type: 'string',
      description: '导出格式：json（结构化数据）/ sqlite（数据库文件拷贝）',
      enum: ['json', 'sqlite'],
      default: 'json'
    },
    output: {
      type: 'string',
      description: '输出文件路径。不传则自动生成到 gallery 根目录。'
    }
  },
  required: []
};

async function execute(input, ctx) {
  try {
    const galleryRoot = ctx?.config?.['gallery.galleryRoot'] || path.join(process.cwd(), 'gallery');
    const fmt = input.format || 'json';

    if (fmt === 'sqlite') {
      // SQLite 文件拷贝
      const src = path.resolve(galleryRoot, '_index.db');
      const dst = input.output || path.resolve(galleryRoot, `_index_${Date.now()}.db`);

      if (!fs.existsSync(src)) {
        return JSON.stringify({ status: 'error', message: '数据库文件不存在' }, null, 2);
      }

      fs.copyFileSync(src, dst);
      const stat = fs.statSync(dst);

      return JSON.stringify({
        status: 'ok',
        format: 'sqlite',
        output: dst,
        size_bytes: stat.size
      }, null, 2);
    }

    // JSON 导出
    const { initDb, queryAll } = await import('../lib/db.js');
    await initDb(ctx);

    const images = queryAll('SELECT * FROM images ORDER BY date_imported DESC');
    const tags = queryAll('SELECT * FROM tags ORDER BY name');
    const imageTags = queryAll('SELECT * FROM image_tags');

    // 组装导出数据
    const exportData = {
      exported_at: new Date().toISOString(),
      plugin_version: '0.3.0',
      stats: {
        images: images.length,
        tags: tags.length,
        relations: imageTags.length
      },
      images: images.map(i => ({
        id: i.id,
        file_hash: i.file_hash,
        path: i.path,
        filename: i.filename,
        ext: i.ext,
        size_bytes: i.size_bytes,
        width: i.width,
        height: i.height,
        date_taken: i.date_taken,
        date_imported: i.date_imported,
        date_modified: i.date_modified,
        camera_make: i.camera_make,
        camera_model: i.camera_model,
        thumbnail_path: i.thumbnail_path,
        hidden: !!i.hidden
      })),
      tags: tags.map(t => ({ id: t.id, name: t.name })),
      image_tags: imageTags.map(it => ({ image_id: it.image_id, tag_id: it.tag_id }))
    };

    const dst = input.output || path.resolve(galleryRoot, `_index_${Date.now()}.json`);
    fs.writeFileSync(dst, JSON.stringify(exportData, null, 2), 'utf-8');

    const stat = fs.statSync(dst);
    return JSON.stringify({
      status: 'ok',
      format: 'json',
      output: dst,
      size_bytes: stat.size
    }, null, 2);

  } catch (e) {
    return JSON.stringify({ status: 'error', error: e.message }, null, 2);
  }
}

export { name, description, parameters, execute };