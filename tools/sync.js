/**
 * sync.js
 * 同步图库图片到博客目录
 *
 * Phase 4 路径对齐工具。
 * 将图库中索引的图片拷贝到博客的 public/images/gallery/ 目录，
 * 确保 Markdown 引用中的路径在博客中可访问。
 */

import fs from 'fs';
import path from 'path';

const name = 'gallery_sync';
const description = `同步图库图片到博客目录。确保 Markdown 引用路径在博客中可访问。`;

const parameters = {
  type: 'object',
  properties: {
    dest: {
      type: 'string',
      description: '博客图片目录路径。不传则使用 blogImagesPath 拼接。'
    },
    dry_run: {
      type: 'boolean',
      description: '仅预览，不实际拷贝',
      default: false
    }
  },
  required: []
};

async function execute(input, ctx) {
  try {
    const galleryRoot = ctx?.config?.['gallery.galleryRoot'] || path.join(process.cwd(), 'gallery');
    const blogPath = ctx?.config?.['gallery.blogImagesPath'] || 'public/images/gallery';

    // 如果 dest 没传，从 blogImagesPath 推算博客项目位置
    // blogImagesPath 是项目相对路径，需要找到博客项目根目录
    let destDir = input.dest;
    if (!destDir) {
      // 从配置中的 blogImagesPath + 插件目录推算博客位置
      const pluginDir = ctx?.pluginDir || '';
      // 尝试从插件目录上溯到 projects
      const parts = pluginDir.replace(/\\/g, '/').split('/');
      const blogIdx = parts.indexOf('lore-blog');
      if (blogIdx >= 0) {
        const base = parts.slice(0, blogIdx + 1).join('/');
        destDir = base + '/XHBlogs/' + blogPath;
      }
      if (!destDir || !fs.existsSync(destDir)) {
        // 降级：用默认路径
        destDir = 'W:/Games/Hanako/Work/lore-blog/XHBlogs/' + blogPath;
      }
      if (!fs.existsSync(destDir.replace(/\\/g, '/'))) {
        return JSON.stringify({
          status: 'error',
          message: '无法定位博客目录，请指定 dest 参数',
          hint: 'gallery_sync dest="D:/MyBlog/public/images/gallery"'
        }, null, 2);
      }
    }

    const { initDb, queryAll } = await import('../lib/db.js');
    await initDb(ctx);

    const images = queryAll('SELECT path, filename, ext FROM images WHERE hidden = 0');

    if (images.length === 0) {
      return JSON.stringify({ status: 'ok', message: '图库为空，无需同步', count: 0 }, null, 2);
    }

    let copied = 0;
    let skipped = 0;
    const errors = [];

    for (const img of images) {
      const src = path.resolve(galleryRoot, img.path);
      const dst = path.resolve(destDir, img.path);

      if (!fs.existsSync(src)) {
        errors.push({ file: img.path, error: '源文件不存在' });
        continue;
      }

      if (fs.existsSync(dst)) {
        skipped++;
        continue;
      }

      if (input.dry_run) {
        skipped++;
        continue;
      }

      // 确保目标目录存在
      const dstDir = path.dirname(dst);
      if (!fs.existsSync(dstDir)) {
        fs.mkdirSync(dstDir, { recursive: true });
      }

      try {
        fs.copyFileSync(src, dst);
        copied++;
      } catch (e) {
        errors.push({ file: img.path, error: e.message });
      }
    }

    return JSON.stringify({
      status: 'ok',
      action: input.dry_run ? 'dry_run' : 'sync',
      dest: destDir,
      summary: {
        total: images.length,
        copied,
        skipped,
        errors: errors.length
      },
      errors: errors.length > 0 ? errors : undefined
    }, null, 2);

  } catch (e) {
    return JSON.stringify({ status: 'error', error: e.message }, null, 2);
  }
}

export { name, description, parameters, execute };