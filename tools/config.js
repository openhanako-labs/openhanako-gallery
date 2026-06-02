/**
 * config.js
 * 配置查看/修改工具
 *
 * 基于 manifest.json 中注册的 configuration schema。
 * get：查看所有配置或指定 key 的值。
 * set：修改指定 key 的值（需用户确认，实际改的是 Hanako 设置）。
 */

const name = 'gallery_config';
const description = `查看图库配置。可查看所有配置或单个 key（只读）。修改请在 Hanako 设置 → 插件 → Hanako Gallery 中操作。`;

const parameters = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      description: '操作类型',
      enum: ['get'],
      default: 'get'
    },
    key: {
      type: 'string',
      description: '配置键名，如 galleryRoot、scanPaths、thumbnailSize、autoClassify、defaultView、blogImagesPath'
    }
  },
  required: ['action']
};

/** 配置键的显示名映射 */
const KEY_MAP = {
  galleryRoot: 'gallery.galleryRoot',
  scanPaths: 'gallery.scanPaths',
  thumbnailSize: 'gallery.thumbnailSize',
  autoClassify: 'gallery.autoClassify',
  defaultView: 'gallery.defaultView',
  blogImagesPath: 'gallery.blogImagesPath'
};

/** 将短名映射到完整配置键 */
function resolveKey(key) {
  if (!key) return null;
  if (key.startsWith('gallery.')) return key;
  return KEY_MAP[key] || null;
}

async function execute(input, ctx) {
  if (input.action === 'get') {
    const configKey = resolveKey(input.key);

    if (configKey) {
      // 单个配置项
      const value = ctx.config?.[configKey];
      return JSON.stringify({
        status: 'ok',
        action: 'get',
        key: configKey,
        value: value !== undefined ? value : null
      }, null, 2);
    }

    // 列出所有配置
    return JSON.stringify({
      status: 'ok',
      action: 'get',
      config: {
        galleryRoot: ctx.config?.['gallery.galleryRoot'] || path.join(process.cwd(), 'gallery'),
        scanPaths: ctx.config?.['gallery.scanPaths'] || [],
        thumbnailSize: ctx.config?.['gallery.thumbnailSize'] || 300,
        autoClassify: ctx.config?.['gallery.autoClassify'] ?? true,
        defaultView: ctx.config?.['gallery.defaultView'] || 'date',
        blogImagesPath: ctx.config?.['gallery.blogImagesPath'] || 'public/images/gallery'
      }
    }, null, 2);
  }



  return JSON.stringify({ status: 'error', message: '未知操作' }, null, 2);
}

export { name, description, parameters, execute };