/**
 * import.js
 * 扫描目录入库工具
 */

const name = 'gallery_import';
const description = `扫描图片目录导入图库。自动读取 EXIF、去重、分类存储。`;

const parameters = {
  type: 'object',
  properties: {
    path: { type: 'string', description: '要扫描的目录路径。' },
    rebuild: { type: 'boolean', description: '是否重建索引', default: false }
  },
  required: []
};

async function execute(input, ctx) {
  try {
    const galleryRoot = ctx.config?.['gallery.galleryRoot'] || path.join(process.cwd(), 'gallery');
    const autoClassify = ctx.config?.['gallery.autoClassify'] ?? true;
    const configScanPaths = [].concat(ctx.config?.['gallery.scanPaths'] || [[]]);

    const { initDb } = await import('../lib/db.js');
    await initDb(ctx);

    if (input.rebuild) {
      const { rebuildIndex } = await import('../lib/scanner.js');
      const result = await rebuildIndex(galleryRoot);
      return JSON.stringify({ status: 'ok', action: 'rebuild', ...result }, null, 2);
    }

    const scanPaths = input.path ? [input.path] : configScanPaths;
    const { scanImport } = await import('../lib/scanner.js');
    const allResults = [];

    for (const sp of scanPaths) {
      const result = await scanImport(galleryRoot, sp, autoClassify);
      allResults.push({ path: sp, ...result });
    }

    const totalImported = allResults.reduce((s, r) => s + (r.summary?.imported || 0), 0);
    const totalSkipped = allResults.reduce((s, r) => s + (r.summary?.skipped || 0), 0);
    const totalFailed = allResults.reduce((s, r) => s + (r.summary?.failed || 0), 0);

    return JSON.stringify({
      status: 'ok', action: 'import',
      totalImported, totalSkipped, totalFailed,
      paths: allResults.map(r => ({
        path: r.path, total: r.summary?.total || 0,
        imported: r.summary?.imported || 0, skipped: r.summary?.skipped || 0,
        failed: r.summary?.failed || 0
      }))
    }, null, 2);

  } catch (e) {
    return JSON.stringify({ status: 'error', error: e.message, stack: (e.stack || '').split('\n').slice(0, 5) }, null, 2);
  }
}

export { name, description, parameters, execute };