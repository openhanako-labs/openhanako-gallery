/**
 * hanako-gallery 插件生命周期入口
 *
 * onload：启动时预热图库目录和数据库。
 * onunload：卸载时刷新数据库缓存。
 * 延迟任务：注册防抖写入的周期性 flush。
 */

import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_GALLERY_ROOT = 'D:/Pictures/gallery';

export default class HanakoGalleryPlugin {
  async onload() {
    const { log, pluginDir, config } = this.ctx;
    log.info('hanako-gallery plugin loaded');

    const galleryRoot = config?.['gallery.galleryRoot'] || DEFAULT_GALLERY_ROOT;

    // 1. 清理旧模块状态（热重载后 ESM 缓存不刷新，需要主动重置）
    this._resetModule(log);

    // 2. 目录结构预热
    ensureDirectories(galleryRoot, log);

    // 3. 数据库预热（异步，不阻塞生命周期）
    this._warmDb(galleryRoot, log);

    // 4. 注册定时 flush（每 30 秒，确保防抖写入的数据不会丢太久）
    this._flushTimer = setInterval(() => this._flushDb(log), 30000);

    // 5. 注册卸载清理
    this.register(() => {
      this._cleanup(log);
    });
  }

  /** 异步预热数据库 */
  async _warmDb(galleryRoot, log) {
    try {
      const { initDb, flush } = await import('./lib/db.js');
      // 构造一个最小 ctx 供 initDb 初始化用
      const ctx = {
        config: {
          'gallery.galleryRoot': galleryRoot,
          'gallery.autoClassify': true
        }
      };
      await initDb(ctx);
      log.info('hanako-gallery: 数据库预热完成');
    } catch (e) {
      log.info('hanako-gallery: 数据库预热延迟（工具首次调用时初始化）');
    }
  }

  /** 周期 flush */
  async _flushDb(log) {
    try {
      const { flush } = await import('./lib/db.js');
      flush();
    } catch (e) {
      // 数据库未初始化，忽略
    }
  }

  /** 卸载清理 */
  _cleanup(log) {
    if (this._flushTimer) {
      clearInterval(this._flushTimer);
      this._flushTimer = null;
    }
    // 最终 flush 并关闭数据库，同时清空模块级变量（_db, _SQL, _ctx, _dirty）
    import('./lib/db.js').then(({ closeDb }) => closeDb()).catch(() => {});
    log.info('hanako-gallery: 已清理');
  }

  /** 预热前确保模块级状态已重置（应对插件热重载后 ESM 缓存不刷新） */
  async _resetModule(log) {
    try {
      const mod = await import('./lib/db.js');
      if (mod.closeDb) mod.closeDb();
    } catch (e) {
      // 数据库尚未初始化，忽略
    }
  }
}

/**
 * 确保图库目录结构存在
 */
function ensureDirectories(galleryRoot, log) {
  const dirs = [
    galleryRoot,
    path.join(galleryRoot, '_uncategorized'),
    path.join(galleryRoot, '_thumbnails')
  ];

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        log.info(`hanako-gallery: 已创建目录 ${dir}`);
      } catch (e) {
        log.warn(`hanako-gallery: 创建目录失败 ${dir}`, e.message);
      }
    }
  }
}