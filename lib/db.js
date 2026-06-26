/**
 * db.js
 * SQLite 数据库初始化 + 查询封装
 *
 * 使用 sql.js（纯 WASM）实现，存储在 _index.db 文件中。
 * 读写流程：加载 → 内存操作 → 保存回文件。
 *
 * 注意：sql.js 使用动态 import() 加载，不能放在顶层静态 import。
 *       这是因为 sql.js 的 WASM 初始化是异步的，静态 import 在插件加载阶段会失败。
 */

import path from 'path';
import fs from 'fs';

/** 数据库目录（图库根目录） */
function getGalleryRoot(ctx) {
  return ctx.config?.['gallery.galleryRoot'] || path.join(process.cwd(), 'gallery');
}

/** 数据库文件路径 */
function getDbPath(ctx) {
  return path.resolve(getGalleryRoot(ctx), '_index.db');
}

/** 确保目录存在 */
function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** 数据库实例缓存 */
let _SQL = null;   // 已初始化的 sql.js 模块（含 Database 构造函数）
let _db = null;    // Database 实例
let _ctx = null;   // 最后一次初始化时的 ctx
let _dirty = false; // 是否需要保存

/** 将数据库保存到文件 */
function saveDb(ctx) {
  if (!_db || !_dirty) return;
  const dbPath = getDbPath(ctx);
  try {
    const data = _db.export();
    fs.writeFileSync(dbPath, Buffer.from(data));
    // 二次检查：在 export 期间如果有其他 runSql 设了 _dirty，则再存一次
    if (_dirty) {
      const data2 = _db.export();
      fs.writeFileSync(dbPath, Buffer.from(data2));
    }
    _dirty = false;
  } catch (e) {
    console.error(`[gallery] Failed to save DB: ${e.message}`);
  }
}

/** 防抖保存 — 延迟写入，避免批量操作时的频繁全量序列化 */
let _saveTimer = null;
function debouncedSave(ctx, delay = 500) {
  _dirty = true;
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    saveDb(ctx);
    _saveTimer = null;
  }, delay);
}

/** 初始化 / 获取数据库实例 */
export async function initDb(ctx) {
  if (_db && _ctx === ctx) return _db;

  _ctx = ctx;
  const dbPath = getDbPath(ctx);
  ensureDir(path.dirname(dbPath));

  // 动态加载并初始化 sql.js
  // import('sql.js') 返回 { default: initSqlJsFunction }
  // initSqlJs() 返回已初始化的模块 { Database, Statement, ... }
  if (!_SQL) {
    const sqlJsModule = await import('sql.js');
    const initSqlJs = sqlJsModule.default || sqlJsModule;
    _SQL = await initSqlJs();
  }

  // 如果已有数据库文件，加载它
  if (fs.existsSync(dbPath)) {
    const fileBuffer = fs.readFileSync(dbPath);
    _db = new _SQL.Database(new Uint8Array(fileBuffer));
  } else {
    _db = new _SQL.Database();
  }

  // 创建表结构 (IF NOT EXISTS 保证幂等)
  _db.run(`
    CREATE TABLE IF NOT EXISTS images (
      id             TEXT PRIMARY KEY,     -- UUID v4
      file_hash      TEXT NOT NULL UNIQUE, -- SHA-256 文件哈希（去重用）
      path           TEXT NOT NULL,        -- gallery/ 下的相对路径
      filename       TEXT NOT NULL,
      ext            TEXT NOT NULL,        -- jpg / png / webp / gif
      size_bytes     INTEGER,
      width          INTEGER,
      height         INTEGER,
      date_taken     TEXT,                 -- EXIF DateTimeOriginal (ISO 8601)
      date_imported  TEXT NOT NULL,        -- 入库时间
      date_modified  TEXT,                 -- 文件修改时间
      camera_make    TEXT,
      camera_model   TEXT,
      thumbnail_path TEXT,                 -- 缩略图相对路径
      hidden         INTEGER DEFAULT 0,     -- 软删除/隐藏
      source_path    TEXT                  -- 导入来源目录（用于删除联动）
    )
  `);

  // 创建索引（IF NOT EXISTS 确保幂等）
  _db.run('CREATE INDEX IF NOT EXISTS idx_date_taken ON images(date_taken)');
  _db.run('CREATE INDEX IF NOT EXISTS idx_date_imported ON images(date_imported)');
  _db.run('CREATE INDEX IF NOT EXISTS idx_ext ON images(ext)');

  _db.run(`
    CREATE TABLE IF NOT EXISTS tags (
      id    INTEGER PRIMARY KEY AUTOINCREMENT,
      name  TEXT NOT NULL UNIQUE
    )
  `);

  _db.run(`
    CREATE TABLE IF NOT EXISTS image_tags (
      image_id TEXT NOT NULL REFERENCES images(id),
      tag_id   INTEGER NOT NULL REFERENCES tags(id),
      PRIMARY KEY (image_id, tag_id)
    )
  `);

  _db.run('CREATE INDEX IF NOT EXISTS idx_image_tags_tag ON image_tags(tag_id)');

  // 配置表
  _db.run(`
    CREATE TABLE IF NOT EXISTS config (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  // 触发首次写入（新数据库）
  _dirty = true;
  saveDb(ctx);

  return _db;
}

/** 获取当前数据库（需先调用 initDb） */
export function getDb() {
  return _db;
}

/** 执行查询，返回数组 [{col: val, ...}] */
export function queryAll(sql, params = []) {
  if (!_db) return [];

  const stmt = _db.prepare(sql);
  if (params.length > 0) stmt.bind(params);

  const results = [];
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

/** 执行单行查询，返回对象或 null */
export function queryOne(sql, params = []) {
  if (!_db) return null;

  const stmt = _db.prepare(sql);
  if (params.length > 0) stmt.bind(params);

  let result = null;
  if (stmt.step()) {
    result = stmt.getAsObject();
  }
  stmt.free();
  return result;
}

/** 执行写入操作，使用防抖保存 */
export function runSql(sql, params = []) {
  if (!_db) return;

  const stmt = _db.prepare(sql);
  if (params.length > 0) stmt.bind(params);
  stmt.step();
  stmt.free();

  if (_ctx) debouncedSave(_ctx);
}

/** 立即保存（用于关键操作后的持久化） */
export function flush(ctx) {
  const c = ctx || _ctx;
  if (_saveTimer) {
    clearTimeout(_saveTimer);
    _saveTimer = null;
  }
  saveDb(c);
}

/** 关闭数据库并保存 — 同时清空模块级缓存，支持热重载后重新初始化 */
export function closeDb(ctx) {
  if (_db) {
    flush(ctx || _ctx);
    _db.close();
    _db = null;
  }
  _SQL = null;
  _ctx = null;
  _dirty = false;
}

export { getDbPath };