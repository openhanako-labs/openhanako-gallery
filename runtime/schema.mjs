/**
 * runtime/schema.mjs — 图库索引库的建表与迁移（唯一入口）。
 *
 * 为什么单独一个文件
 *   原来的建表 SQL、`PRAGMA table_info` + `ALTER TABLE ADD COLUMN` 全塞在
 *   service.mjs 的 `openDb()` 里，混在几千行业务代码中间。每次加列都要改一个
 *   巨大的函数，加一次容易把别的 SQL 误改。抽出来之后：
 *     · schema 的读、改、验收都在这一个文件里
 *     · 迁移是**版本化的**（`PRAGMA user_version` 驱动），每次启动只跑没跑过的
 *     · 老库升级 = 追加 MIGRATIONS 末尾一项，不改前面任何一项
 *
 * 版本化机制
 *   MIGRATIONS[i] 执行后把 `PRAGMA user_version` 设为 i+1。启动时读到 v，
 *   只跑 MIGRATIONS[v..n-1]。这样老库不会重复跑，新库一步到位。
 *
 * 纪律：迁移函数**只允许 CREATE (IF NOT EXISTS) 和 ALTER TABLE ... ADD COLUMN**。
 *   禁止 DROP / RENAME / UPDATE 已有列。破坏性操作会连累老库用户，加一步就
 *   收不回来。两个例外，都写在函数注释里明确标注：
 *     · 版本 4：FTS5 虚拟表**不能 ALTER**（SQLite 硬限制），必须整表重建
 *     · 版本 7：契约要求的一次性数据迁移（INSERT … 不 UPDATE 已有列）
 *   其他 MIGRATIONS 请严格遵守纪律，违反即回滚。
 */

import { DatabaseSync } from "node:sqlite";

// ── CJK 分段（FTS5 触发器里用） ──
// 原来在 service.mjs，随迁移一并搬过来。触发器调用的是注册进数据库的 `hana_seg`
// 函数，注册必须在 ensureSchema 里、且在 MIGRATIONS 之前完成。

const CJK = /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uAC00-\uD7AF]/;

/** CJK 逐字切分：unicode61 会把连续汉字当单个 token，中文检索必须逐字拆。 */
export function seg(value) {
  if (value == null) return "";
  let out = "";
  for (const ch of String(value)) {
    if (CJK.test(ch)) out += ` ${ch}`;
    else if (/[A-Za-z0-9]/.test(ch)) out += ch;
    else out += " ";
  }
  return out.replace(/\s+/g, " ").trim();
}

/**
 * 迁移列表。
 *
 * 前 6 项是从 service.mjs `openDb()` 原样搬过来的（MIGRATIONS[0..5]），
 * 顺序、SQL 文本都与原实现一致，保证老库升级路径完全等价。
 * 第 7 项是本任务新增：AI 三层分离的一次性数据迁移。
 *
 * 追加新迁移：MIGRATIONS 末尾加一项，别改前面任何一项——老库的 user_version
 * 已经记到那个值了，改了前面的 SQL 就等于让所有老库跑错版本。
 */
const MIGRATIONS = [
  // ── 版本 1：建表 ────────────────────────────────────────────────────────
  // images / tags / image_tags 三张业务表 + 三个索引 + images_fts 虚拟表 +
  // 三个触发器。与 openDb 里的原始 SQL 一致。
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS images (
        id             TEXT PRIMARY KEY,
        file_hash      TEXT NOT NULL UNIQUE,
        path           TEXT NOT NULL,
        filename       TEXT NOT NULL,
        ext            TEXT NOT NULL,
        size_bytes     INTEGER,
        width          INTEGER,
        height         INTEGER,
        date_taken     TEXT,
        date_imported  TEXT NOT NULL,
        date_modified  TEXT,
        camera_make    TEXT,
        camera_model   TEXT,
        thumbnail_path TEXT,
        hidden         INTEGER DEFAULT 0,
        source_path    TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_date_taken ON images(date_taken);
      CREATE INDEX IF NOT EXISTS idx_date_imported ON images(date_imported);
      CREATE INDEX IF NOT EXISTS idx_ext ON images(ext);

      CREATE TABLE IF NOT EXISTS tags (
        id    INTEGER PRIMARY KEY AUTOINCREMENT,
        name  TEXT NOT NULL UNIQUE
      );
      CREATE TABLE IF NOT EXISTS image_tags (
        image_id TEXT NOT NULL REFERENCES images(id),
        tag_id   INTEGER NOT NULL REFERENCES tags(id),
        PRIMARY KEY (image_id, tag_id)
      );
      CREATE INDEX IF NOT EXISTS idx_image_tags_tag ON image_tags(tag_id);

      CREATE VIRTUAL TABLE IF NOT EXISTS images_fts USING fts5(
        image_id UNINDEXED, filename, path, tokenize='unicode61 remove_diacritics 1'
      );
      CREATE TRIGGER IF NOT EXISTS images_fts_ai AFTER INSERT ON images BEGIN
        INSERT INTO images_fts(image_id, filename, path)
        VALUES (new.id, hana_seg(new.filename), hana_seg(new.path));
      END;
      CREATE TRIGGER IF NOT EXISTS images_fts_au AFTER UPDATE OF filename, path ON images BEGIN
        DELETE FROM images_fts WHERE image_id = old.id;
        INSERT INTO images_fts(image_id, filename, path)
        VALUES (new.id, hana_seg(new.filename), hana_seg(new.path));
      END;
      CREATE TRIGGER IF NOT EXISTS images_fts_ad AFTER DELETE ON images BEGIN
        DELETE FROM images_fts WHERE image_id = old.id;
      END;
    `);
  },

  // ── 版本 2：mtime_ms ────────────────────────────────────────────────────
  // 增量扫描靠 (size, mtime) 判「文件是否变过」。旧库没这列，补上。
  // 已有行的 mtime_ms 为 NULL，首次增量重扫时会各哈希一遍，之后就是零成本跳过。
  (db) => {
    const cols = db.prepare("PRAGMA table_info(images)").all().map((c) => c.name);
    if (!cols.includes("mtime_ms")) db.exec("ALTER TABLE images ADD COLUMN mtime_ms INTEGER");
  },

  // ── 版本 3：description / ai_name ───────────────────────────────────────
  // 识图写的描述落 images.description（并进 FTS，下一版本重建 FTS 才能搜得到）。
  // 模型给的文件名短名落 images.ai_name（面板「命名 / 批量命名」用它，
  // 而不是从标签里挑——标签是检索维度，不是命名维度）。
  (db) => {
    const cols = db.prepare("PRAGMA table_info(images)").all().map((c) => c.name);
    if (!cols.includes("description")) db.exec("ALTER TABLE images ADD COLUMN description TEXT");
    if (!cols.includes("ai_name")) db.exec("ALTER TABLE images ADD COLUMN ai_name TEXT");
  },

  // ── 版本 4：FTS 重建（加入 description 列） ─────────────────────────────
  // 例外：FTS5 虚拟表**不能 ALTER**（SQLite 文档明确写的），只能整表重建。
  // 所以这里必须 DROP + CREATE + 重新灌数据 + 重挂触发器。
  // 迁移幂等：FTS 表自身 SQL 已含 description 就跳过（幂等性靠 sqlite_master）。
  (db) => {
    const ftsSql = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'images_fts'").get()?.sql || "";
    if (/description/.test(ftsSql)) return;
    db.exec(`
      DROP TRIGGER IF EXISTS images_fts_ai;
      DROP TRIGGER IF EXISTS images_fts_au;
      DROP TRIGGER IF EXISTS images_fts_ad;
      DROP TABLE IF EXISTS images_fts;
      CREATE VIRTUAL TABLE images_fts USING fts5(
        image_id UNINDEXED, filename, path, description, tokenize='unicode61 remove_diacritics 1'
      );
      CREATE TRIGGER images_fts_ai AFTER INSERT ON images BEGIN
        INSERT INTO images_fts(image_id, filename, path, description)
        VALUES (new.id, hana_seg(new.filename), hana_seg(new.path), hana_seg(COALESCE(new.description, '')));
      END;
      CREATE TRIGGER images_fts_au AFTER UPDATE OF filename, path, description ON images BEGIN
        DELETE FROM images_fts WHERE image_id = old.id;
        INSERT INTO images_fts(image_id, filename, path, description)
        VALUES (new.id, hana_seg(new.filename), hana_seg(new.path), hana_seg(COALESCE(new.description, '')));
      END;
      CREATE TRIGGER images_fts_ad AFTER DELETE ON images BEGIN
        DELETE FROM images_fts WHERE image_id = old.id;
      END;
      INSERT INTO images_fts(image_id, filename, path, description)
        SELECT id, hana_seg(filename), hana_seg(path), hana_seg(COALESCE(description, '')) FROM images;
    `);
  },

  // ── 版本 5：ai_content 表 ───────────────────────────────────────────────
  // AI 三层分离的权威层。images.description / ai_name 降级为「FTS 投影」——
  // AI 写入时同步写这两个列，好让 FTS5 继续搜得到，但权威在 ai_content。
  // 保留两个列不删：迁移只加不改，老代码和搜索逻辑都不用改。
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ai_content (
        image_id     TEXT PRIMARY KEY REFERENCES images(id),
        description  TEXT,
        tags_json    TEXT NOT NULL DEFAULT '[]',
        model        TEXT,
        model_version TEXT,
        analyzed_at  TEXT
      );
    `);
  },

  // ── 版本 6：image_tags.source ───────────────────────────────────────────
  // 标来源：'user' = 用户手动打的，'ai' = AI 识图打的。
  // 默认 'user' 是老行不会错——老行本来就不含 AI 标。
  (db) => {
    const cols = db.prepare("PRAGMA table_info(image_tags)").all().map((c) => c.name);
    if (!cols.includes("source")) {
      db.exec("ALTER TABLE image_tags ADD COLUMN source TEXT NOT NULL DEFAULT 'user'");
    }
  },

  // ── 版本 7：一次性数据迁移（老 description → ai_content） ────
  // 例外：契约要求的一次性数据迁移，涉及 INSERT（但**不** UPDATE 已有列）。
  // 只在 user_version=6 → 7 时跑一次；之后 ai_content 是权威层，images 里的
  // description / ai_name 不再单独写——它们只是 FTS 投影，跟随 AI 写入路径。
  //
  // 只迁 description，不迁 ai_name：ai_name 是「批量命名」用的短名（"短发少女"、"猫"），
  // 把它塞进 ai_content.description 会让权威层变成"看起来是描述、其实是标签"的混淆层。
  // ai_name 本就是 images 表的独立列，保留不删，/ai/clear 清投影时照样能清掉。
  //
  // 幂等：靠 INSERT OR IGNORE 保证——ai_content.image_id 是 PK，重复执行遇到冲突行
  // 静默忽略继续跑完。这在断电、宿主超时杀子进程导致「INSERT 已写、user_version 没 bump」
  // 的半状态重启时是必需的：不幂等就等于 openDb 抛错、图库整个打不开。
  // （原先注释写"天然幂等"是错的：PK 冲突在 INSERT 里没有 IGNORE 会抛 UNIQUE constraint。）
  //
  // 历史备注：本项在发布前修正过（原先把 ai_name 也迁进 description，会造成"只有 ai_name"
  // 的图被误建 ai_content 行；已改为只迁 description）。若发现已有库 user_version=7，
  // 需人工核对 ai_content 里是否有仅由 ai_name 迁移来的行（description 形如短名）。
  (db) => {
    db.exec(`
      INSERT OR IGNORE INTO ai_content (image_id, description, tags_json, model, model_version, analyzed_at)
      SELECT id,
             description,
             '[]',
             NULL,
             NULL,
             NULL
      FROM images
      WHERE description IS NOT NULL AND description != ''
    `);
  },
];

/**
 * 建库并跑完所有未完成的迁移。
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {{ warn?: (msg: any) => void, info?: (msg: any) => void }} [log]
 * @returns {{ version: number, migrationsRun: number }}
 */
export function ensureSchema(db, log) {
  if (!(db instanceof DatabaseSync)) {
    throw new TypeError("ensureSchema: db 必须是 node:sqlite DatabaseSync 实例");
  }

  // 触发器要用到 `hana_seg` 分段函数（见文件顶部）。
  // 幂等：DatabaseSync 的 function() 是实例级注册，重复注册同名同签名不报错。
  db.function("hana_seg", { deterministic: true }, seg);

  // 读当前版本
  const startVersion = Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);

  // 逐条跑未完成的迁移。每次只跑一个，跑完立刻 bump 版本号——
  // 中途崩溃时重启会重跑失败的那一条，不会跳到下一条（每条都幂等）。
  let i = startVersion;
  let ran = 0;
  while (i < MIGRATIONS.length) {
    MIGRATIONS[i](db);
    db.exec(`PRAGMA user_version = ${i + 1}`);
    ran++;
    i++;
    log?.info?.({ msg: `schema migration ${i - 1} → ${i}`, db: "hanako-gallery" });
  }

  // 外键约束（幂等）。原本 openDb 里也没设，但既然抽出来了顺手开起来。
  //
  // 为什么开：image_tags / ai_content 都带 image_id REFERENCES images(id)，
  //   没有外键的话，孤儿行会静默残留——删一张图，它的标签和 AI 内容还在库里躺着。
  //
  // 为什么没有 ON DELETE CASCADE：SQLite 不能用 ALTER TABLE 给已建表补外键约束，
  //   v1 就建好的 image_tags 动不了；把整表 DROP + 重建等于破坏性迁移，代价大于收益。
  //
  // 结果：所有 DELETE FROM images 的路径**必须自己先清** image_tags + ai_content，
  //   否则外键约束抛 FOREIGN KEY constraint failed。见 service.mjs 中：
  //   /config/set、/scan 去重分支、/missing/purge、/delete、/forget。
  //   ai_content 的清理是 F3 新增（P0 回归）——被 AI 描述过的图片以前会直接删不掉。
  try { db.exec("PRAGMA foreign_keys = ON"); } catch { /* 极老 SQLite 没有 */ }

  return { version: i, migrationsRun: ran };
}
