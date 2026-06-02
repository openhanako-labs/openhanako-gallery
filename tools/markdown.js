/**
 * markdown.js
 * 生成 Markdown 图片引用代码
 *
 * 基于 blogImagesPath 配置，将图库图片路径转换为博客可用的 Markdown 引用。
 * 博客是 Next.js（XHBlogs），public/ 目录中的文件通过 / 根路径访问。
 */

const name = 'gallery_markdown';
const description = `生成 Markdown 图片引用代码。基于博客路径配置，输出直接可粘贴的引用格式。`;

const parameters = {
  type: 'object',
  properties: {
    id: {
      type: 'string',
      description: '图片 ID（必填）'
    },
    alt_text: {
      type: 'string',
      description: '图片替代文本（可选，默认使用文件名）'
    },
    size: {
      type: 'string',
      description: '引用尺寸：raw（原图）/ thumb（缩略图）',
      enum: ['raw', 'thumb'],
      default: 'raw'
    },
    format: {
      type: 'string',
      description: '输出格式：markdown / url / path',
      enum: ['markdown', 'url', 'path'],
      default: 'markdown'
    }
  },
  required: ['id']
};

async function execute(input, ctx) {
  try {
    const { initDb, queryOne } = await import('../lib/db.js');
    await initDb(ctx);

    // 查图片
    const img = queryOne('SELECT * FROM images WHERE id = ?', [input.id]);
    if (!img) {
      return JSON.stringify({ status: 'error', message: `图片 ${input.id} 不存在` }, null, 2);
    }

    // 获取配置
    const blogPath = ctx?.config?.['gallery.blogImagesPath'] || 'public/images/gallery';
    const galleryRoot = ctx?.config?.['gallery.galleryRoot'] || path.join(process.cwd(), 'gallery');

    // 确定引用路径
    let useUrl = img.path;
    let isExternal = false;

    if (img.path && img.path.startsWith('ext:')) {
      // 外部图床链接，直接使用
      useUrl = img.path.substring(4);
      isExternal = true;
    }

    // 如果是 thumb 尺寸且图片有缩略图，用缩略图路径
    if (input.size === 'thumb' && img.thumbnail_path) {
      useUrl = img.thumbnail_path;
      isExternal = false;
    }

    // 外部链接直接输出
    if (isExternal) {
      const alt = input.alt_text || img.filename || 'image';
      const fmt = input.format || 'markdown';
      switch (fmt) {
        case 'markdown': return JSON.stringify({ status: 'ok', format: 'markdown', markdown: `![${alt}](${useUrl})`, alt, url: useUrl, image: { id: img.id, filename: img.filename } }, null, 2);
        case 'url': return JSON.stringify({ status: 'ok', format: 'url', url: useUrl, alt, image: { id: img.id, filename: img.filename } }, null, 2);
        default: return JSON.stringify({ status: 'error', message: `未知格式: ${fmt}` }, null, 2);
      }
    }

    // 拼接博客路径
    const blogRelPath = `${blogPath}/${img.path}`.replace(/\/\//g, '/');
    // URL 路径：去掉 public/ 前缀（Next.js 约定）
    const urlPath = blogRelPath.replace(/^public\//, '');
    const absoluteUrl = `/${urlPath}`.replace(/\/\//g, '/');

    // 替代文本
    const alt = input.alt_text || img.filename || 'image';

    // 根据格式输出（默认值兜底：schema default 可能未被运行时应用）
    const fmt = input.format || 'markdown';
    switch (fmt) {
      case 'markdown':
        return JSON.stringify({
          status: 'ok',
          format: 'markdown',
          markdown: `![${alt}](${absoluteUrl})`,
          alt,
          url: absoluteUrl,
          image: { id: img.id, filename: img.filename }
        }, null, 2);

      case 'url':
        return JSON.stringify({
          status: 'ok',
          format: 'url',
          url: absoluteUrl,
          alt,
          image: { id: img.id, filename: img.filename }
        }, null, 2);

      case 'path':
        return JSON.stringify({
          status: 'ok',
          format: 'path',
          blog_path: blogRelPath,
          filesystem_path: img.path,
          alt,
          image: { id: img.id, filename: img.filename }
        }, null, 2);

      default:
        return JSON.stringify({ status: 'error', message: `未知格式: ${input.format}` }, null, 2);
    }

  } catch (e) {
    return JSON.stringify({ status: 'error', error: e.message }, null, 2);
  }
}

export { name, description, parameters, execute };