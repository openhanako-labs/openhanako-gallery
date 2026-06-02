/**
 * ping.js
 * 心跳检测工具
 *
 * Phase 0 骨架工具——验证插件已注册到 Hanako 并可正常调用。
 * 首次运行时自动初始化数据库（sql.js），创建表结构，返回连接状态和统计。
 */

const name = 'gallery_ping';
const description = `图库插件心跳检测。验证插件已加载、数据库可连接、基础配置可读取。`;

const parameters = {
  type: 'object',
  properties: {},
  required: []
};

async function execute(input, ctx) {
  const result = {
    status: 'ok',
    plugin: 'hanako-gallery',
    version: '0.1.0',
    timestamp: new Date().toISOString(),
    db: 'not_initialized',
    config: {}
  };

  // 读取配置
  try {
    result.config = {
      galleryRoot: ctx.config?.['gallery.galleryRoot'] || path.join(process.cwd(), 'gallery'),
      scanPaths: ctx.config?.['gallery.scanPaths'] || [[]],
      thumbnailSize: ctx.config?.['gallery.thumbnailSize'] || 300,
      autoClassify: ctx.config?.['gallery.autoClassify'] ?? true,
      blogImagesPath: ctx.config?.['gallery.blogImagesPath'] || 'public/images/gallery'
    };
  } catch (e) {
    result.config = { error: e.message };
  }

  // 初始化数据库并获取统计
  try {
    const { initDb, queryOne } = await import('../lib/db.js');
    await initDb(ctx);
    const count = queryOne('SELECT COUNT(*) as count FROM images');
    result.db = `connected (${count?.count || 0} images indexed)`;
  } catch (e) {
    result.db = `error: ${e.message}`;
  }

  return JSON.stringify(result, null, 2);
}

export { name, description, parameters, execute };