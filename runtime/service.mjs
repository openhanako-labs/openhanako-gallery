/**
 * runtime/service.mjs — 受管图库服务（独立进程，native profile）。
 *
 * 为什么图库后端必须在这里而不是在 AppHost：
 *   AppHost 及其一切子进程都跑在 Node 权限模型里，**读不到 app-data 之外的文件**。
 *   图库的全部意义恰恰是读用户的图片目录（默认取用户 Pictures 下的 gallery，可配置到任意盘）。
 *   所以扫描、EXIF、缩略图、取图全在这个进程里做；AppHost 只转发。
 *
 * 用什么 profile：local-machine（曾用 native，已换）。
 *   受管进程以当前 OS 用户权限运行 —— 跟 AppHost 只差「能不能读 app-data 之外」这一件事，
 *   而这恰好就是图库需要的全部。不需要管理员初始化，也不受 HANA_HOME 路径形态影响。
 *   代价：这个应用没有文件系统隔离（见 lib/runtime-host.mjs 顶部的完整说明）。
 *
 * 进程内职责：
 *   · node:sqlite 索引库（存在 app-data，图片本体留在原处）
 *   · 目录扫描 + EXIF 读取 + 去重
 *   · 缩略图生成（sharp；不可用时降级为「原图直出」并如实上报）
 *   · 图片字节读取，base64 回传（受 MAX_IMAGE_BYTES 限制）
 *
 * 启动参数：argv[2] = 数据目录，argv[3] = 监听端口。
 */

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const DATA_DIR = process.argv[2] || process.env.HANAKO_PLUGIN_DATA || "";
const PORT = Number(process.argv[3]) || 43180;
/**
 * HANA_HOME（argv[4]，可缺省）。
 *
 * 不要从 DATA_DIR 向上推 —— 那只在目录布局恰好固定时才成立。
 * 由 AppHost 显式传入，拿不到时再回退推导。
 */
const HANA_HOME = process.argv[4] || process.env.HANA_HOME || path.dirname(path.dirname(DATA_DIR));
const READY_MARKER = "HANA_GALLERY_SERVICE_READY";

/** 单张图片回传上限。base64 后约 1.33 倍，卡在宿主 4MB 响应上限内。 */
const MAX_IMAGE_BYTES = 2.5 * 1024 * 1024;

/** URL 导入单文件上限。 */
const MAX_IMPORT_BYTES = 64 * 1024 * 1024;

/** 收藏用的约定标签名（与 v1 一致，存成普通标签）。 */
const FAVORITE_TAG = "☆收藏";

/** 支持的图片扩展名。 */
const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".avif", ".tif", ".tiff"]);

/** 视频扩展名。默认不入库（要显式开 showVideo），与 v1 一致。 */
const VIDEO_EXTS = new Set([".mp4", ".webm", ".mov", ".avi", ".mkv"]);

/** 扩展名 → MIME。图片 + 视频共用。 */
const MIME = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
  gif: "image/gif", bmp: "image/bmp", avif: "image/avif", tif: "image/tiff", tiff: "image/tiff",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", avi: "video/x-msvideo", mkv: "video/x-matroska",
};

const CONFIG_PATH = path.join(DATA_DIR, "config.json");
const DB_PATH = path.join(DATA_DIR, "_index.db");
const THUMB_DIR = path.join(DATA_DIR, "_thumbnails");
/** 导出产物默认落这里（app-data 内，AppHost 与卡片都能读）。 */
const EXPORT_DIR = path.join(DATA_DIR, "exports");

/**
 * 默认图库根目录。
 *
 * 不能用 USERPROFILE —— 受管运行时的 env 是宿主白名单，
 * 实测 USERPROFILE 被指向了 .runtime-tmp（重启就变），
 * 拿它拼路径会得到一个每次都不一样的临时目录。
 *
 * 改用 HANA_HOME 的父目录（就是用户主目录）推导；
 * 仍拿不到就退回 app-data 下的 gallery/，至少是稳定的。
 */
function defaultGalleryRoot() {
  try {
    const home = path.dirname(HANA_HOME);          // <用户主目录>
    if (home && home !== HANA_HOME && path.basename(HANA_HOME).startsWith(".")) {
      return path.join(home, "Pictures", "gallery");
    }
  } catch { /* 退到下一条 */ }
  return path.join(DATA_DIR, "gallery");
}

/** 配置默认值。 */
const DEFAULT_CONFIG = {
  galleryRoot: defaultGalleryRoot(),
  scanPaths: [],
  thumbnailSize: 300,
  blogImagesPath: "public/images/gallery",
  autoClassify: true,
};

// ── 能力探测（启动时一次，结果如实上报给 UI） ──
//
// sharp 是原生模块（含 18 MB libvips DLL），所以精简发行包不带它。
// 但受管服务是 native profile、能读用户文件 —— 可以就地复用 v1 插件目录里
// 已有的那份 sharp（同一台机器、同一 Node ABI），从而在不为发行包背 19 MB 的
// 前提下恢复缩略图能力。找不到就降级，不报错。
const capabilities = {
  sharp: false,
  sharpError: null,
  sharpSource: null,   // 'bundled' | 'legacy-plugin' | null
  exifr: false,
  exifrError: null,
  exifrSource: null,
  sqlite: true,
};

/** 从 HANA_HOME 推导 v1 插件目录（dataDir = <HOME>/app-data/<id>）。 */
function legacyPluginDir() {
  try {
    const home = path.dirname(path.dirname(DATA_DIR));          // <HOME>
    return path.join(home, "plugins", "hanako-gallery", "node_modules");
  } catch { return null; }
}

/** 本应用自己的依赖目录：搬运过来的 sharp 放这里，与 v1 解耦。 */
function localDepsDir() {
  return path.join(DATA_DIR, "node_modules");
}

/**
 * 自动发现的「生成图」来源目录。
 *
 * 不写死某个插件名：扫描 <HANA_HOME> 下 plugin-data 与 app-data 的
 * 每个子目录里的 generated/，凡存在的一律收录。
 * 这样 image-gen、jimeng-cli、bilibili-intake 等任何产出都自动进入图库，
 * 不再依赖我猜测某个固定目录名。
 *
 * 可用 body.sources 显式指定目录列表覆盖自动发现。
 */
function discoverGeneratedDirs() {
  const out = [];
  for (const rootName of ["plugin-data", "app-data"]) {
    const root = path.join(HANA_HOME, rootName);
    let entries;
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const gen = path.join(root, e.name, "generated");
      try { if (!fs.statSync(gen).isDirectory()) continue; } catch { continue; }
      out.push({ dir: gen, owner: `${rootName}/${e.name}` });
    }
  }
  return out;
}

/** 找最新版的 artifacts/server 根目录（宿主发布包，含内置素材）。 */
function builtinServerRoot() {
  const base = path.join(HANA_HOME, "artifacts", "server");
  let ents;
  try { ents = fs.readdirSync(base, { withFileTypes: true }); } catch { return null; }
  const dirs = ents.filter((e) => e.isDirectory()).map((e) => e.name);
  if (!dirs.length) return null;
  // 版本号按点分数字降序，避免字符串比较把 0.946 排在 0.951 前面
  dirs.sort((a, b) => {
    const pa = a.split(/[.\-]/).map((x) => Number(x) || 0);
    const pb = b.split(/[.\-]/).map((x) => Number(x) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const x = pa[i] || 0, y = pb[i] || 0;
      if (x !== y) return y - x;
    }
    return 0;
  });
  return path.join(base, dirs[0]);
}

/**
 * 随宿主发布的内置素材目录（只读）。
 * cover-gallery 是封面图库，character-cards 是助手角色卡，
 * textures 含叶片叠层视频，welcome/* 是引导页背景。
 */
function discoverBuiltinDirs() {
  const root = builtinServerRoot();
  if (!root) return [];
  const rel = [
    ["desktop/src/assets/cover-gallery", "cover-gallery"],
    ["desktop/src/assets/character-cards", "character-cards"],
    ["desktop/dist-renderer/assets/textures", "textures"],
    ["desktop/dist-renderer/assets/welcome/loading", "welcome/loading"],
    ["desktop/dist-renderer/assets/welcome/onboarding", "welcome/onboarding"],
    ["desktop/dist-renderer/assets/welcome/preparing", "welcome/preparing"],
  ];
  const out = [];
  for (const [r, owner] of rel) {
    const d = path.join(root, r);
    try { if (fs.statSync(d).isDirectory()) out.push({ dir: d, owner }); } catch { /* 该版本没有 */ }
  }
  return out;
}

/**
 * 从一组目录列出媒体文件，合成统一格式的条目。
 * prefix = id 前缀（gen_ / builtin_）；source = 条目来源标记。
 */
function listFromDirs(dirs, { prefix, source, includeVideo = false, keyword = "" }) {
  const out = [];
  for (const { dir, owner } of dirs) {
    if (!dir || !fs.existsSync(dir)) continue;
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const f of names) {
      const ext = path.extname(f).toLowerCase();
      const isVid = VIDEO_EXTS.has(ext);
      if (!IMAGE_EXTS.has(ext) && !isVid) continue;
      if (isVid && !includeVideo) continue;
      if (keyword && !f.toLowerCase().includes(String(keyword).toLowerCase())) continue;
      const fp = path.join(dir, f);
      let st;
      try { st = fs.statSync(fp); if (!st.isFile()) continue; } catch { continue; }
      const iso = st.mtime.toISOString();
      // owner 里的 / 会跑进 URL 路径，换成 - 避免转义麻烦
      const safeOwner = owner.replace(/[\/\\]/g, "-");
      out.push({
        id: `${prefix}${safeOwner}__${f}`, path: fp, filename: f,
        ext: ext.replace(".", ""), size_bytes: st.size,
        width: 0, height: 0, date_taken: iso, date_imported: iso,
        thumbnail_path: null, tags: [],
        media_type: isVid ? "video" : "image",
        source, generator: owner, favorited: 0,
      });
    }
  }
  out.sort((a, b) => (a.date_taken < b.date_taken ? 1 : -1));
  return out;
}

/**
 * 追加来源（生成图/内置素材/媒体库）的内存排序。
 * 与 ORDER_BY 六种排序一一对应 —— SQL 管不到不入库的条目，
 * 但它们也得跟随用户选的排序，否则切排序对它们毫无反应。
 */
const SORT_CMP = {
  date_desc: (a, b) => (a.date_taken < b.date_taken ? 1 : a.date_taken > b.date_taken ? -1 : 0),
  date_asc:  (a, b) => (a.date_taken < b.date_taken ? -1 : a.date_taken > b.date_taken ? 1 : 0),
  name_asc:  (a, b) => String(a.filename).localeCompare(String(b.filename), "zh-Hans-CN"),
  name_desc: (a, b) => String(b.filename).localeCompare(String(a.filename), "zh-Hans-CN"),
  size_desc: (a, b) => (Number(b.size_bytes) || 0) - (Number(a.size_bytes) || 0),
  size_asc:  (a, b) => (Number(a.size_bytes) || 0) - (Number(b.size_bytes) || 0),
};

/**
 * 统计一组目录里的图片/视频数量（分开报）。
 * 分开是必要的：图库默认只显示图片，标签上的数字必须和点进去看到的一致，
 * 否则会出“标签写 54、点进去只有 53”这种看起来像 bug 的差一个。
 */
function countMediaInDirs(dirs) {
  return dirs.map((d) => {
    let imageCount = 0, videoCount = 0;
    try {
      for (const f of fs.readdirSync(d.dir)) {
        const e = path.extname(f).toLowerCase();
        if (IMAGE_EXTS.has(e)) imageCount++;
        else if (VIDEO_EXTS.has(e)) videoCount++;
      }
    } catch { /* 目录读不到就是 0 */ }
    return { owner: d.owner, dir: d.dir, imageCount, videoCount, mediaCount: imageCount + videoCount };
  });
}

/** sources 接口返回的 total：跟当前 showVideo 状态一致。 */
function sourceTotal(dirs, includeVideo) {
  return dirs.reduce((a, d) => a + (includeVideo ? d.mediaCount : d.imageCount), 0);
}

/**
 * 列出生成目录里的图片/视频，合成 `gen_<owner>__<文件名>` 条目。
 * id 带 owner 前缀，避免不同插件同名文件互相覆盖。
 */
function listGenerated({ includeVideo = false, keyword = "", sources = null } = {}) {
  const dirs = Array.isArray(sources) && sources.length
    ? sources.map((d) => ({ dir: String(d), owner: path.basename(path.dirname(String(d))) }))
    : discoverGeneratedDirs();
  return listFromDirs(dirs, { prefix: "gen_", source: "generated", includeVideo, keyword });
}

/**
 * 解析 `<prefix><owner>__<文件名>` 形式的 id → 真实文件路径。
 * owner 里的 / 在生成 id 时被换成了 -，比较时同样归一化。
 */
function resolvePrefixedId(id, prefix, discover) {
  const rest = id.slice(prefix.length);
  const sep = rest.indexOf("__");
  if (sep < 0) return null;
  const ownerKey = rest.slice(0, sep);
  const name = rest.slice(sep + 2);
  if (!ownerKey || !name || name.includes("/") || name.includes("\\")) return null;
  const dir = discover().find((d) => d.owner.replace(/[\/\\]/g, "-") === ownerKey);
  return dir ? path.join(dir.dir, name) : null;
}

function resolveGeneratedPath(id) {
  return resolvePrefixedId(id, "gen_", discoverGeneratedDirs);
}

/**
 * hana 内置素材：随宿主版本发布的封面图库、角色卡、纹理。
 * 只读引用——不入库、不建缩略图、不参与扫描去重。
 */
function listBuiltin({ includeVideo = false, keyword = "", sources = null } = {}) {
  const dirs = Array.isArray(sources) && sources.length
    ? sources.map((d) => ({ dir: String(d), owner: path.basename(String(d)) }))
    : discoverBuiltinDirs();
  return listFromDirs(dirs, { prefix: "builtin_", source: "builtin", includeVideo, keyword });
}

function resolveBuiltinPath(id) {
  return resolvePrefixedId(id, "builtin_", discoverBuiltinDirs);
}

/** 媒体库目录名。宿主固定叫这个名字，不随语言变。 */
const MEDIA_LIB_DIRNAME = "OH-媒体库";
/** 媒体库在 id 里用的 owner 段。用英文保持 URL 干净 —— 中文会被全部 %xx 转义。 */
const MEDIA_LIB_OWNER = "media-library";

/**
 * 读 Hana 用户偏好（<HANA_HOME>/user/preferences.json）。
 * 只读不改。这个文件是宿主的私有存储，格式可能随版本变化，
 * 任何异常都返回空对象——读不到偏好不该让图库罢工。
 */
function readHanaPreferences() {
  try {
    const p = path.join(HANA_HOME, "user", "preferences.json");
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch { return {}; }
}

/**
 * 媒体库位置：AI 生图/生视频/生音频的落地目录。
 *
 * 优先级从高到低：
 *   1. 图库自己的 mediaLibraryPath（图库设置里填的，最精确）
 *   2. Hana 的 mediaLibrary.location（设置页「媒体库位置」，用户改过就听他的）
 *   3. Hana 下发的 mediaLibrary.defaultLocation（服务端算的默认值，跟着界面语言和
 *      默认工作空间走，只有宿主算得准，我们不复刻它的逻辑）
 *   4. 自动探测：遍历 Hana 记录过的工作空间（按最近使用时间），找哪个下面有 OH-媒体库
 *   5. 兜底：最近使用的工作空间 + OH-媒体库
 *
 * 与宿主语义一致：留空 = 用默认，不是「没有媒体库」。
 * 返回 { dir, from, workspace?, missing? }；missing = 目录还不存在（正常，还没生成过东西）。
 */
function resolveMediaLibraryDir() {
  const cfg = readConfig();
  if (typeof cfg.mediaLibraryPath === "string" && cfg.mediaLibraryPath.trim()) {
    const p = cfg.mediaLibraryPath.trim();
    try { if (fs.statSync(p).isDirectory()) return { dir: p, from: "gallery-config" }; } catch { /* 路径无效，继续 */ }
  }

  const ml = readHanaPreferences().mediaLibrary;
  if (ml && typeof ml.location === "string" && ml.location.trim()) {
    const p = ml.location.trim();
    try { if (fs.statSync(p).isDirectory()) return { dir: p, from: "hana-location" }; } catch { /* 目录还没建 */ }
    return { dir: p, from: "hana-location", missing: true };
  }
  if (ml && typeof ml.defaultLocation === "string" && ml.defaultLocation.trim()) {
    return { dir: ml.defaultLocation.trim(), from: "hana-default", missing: true };
  }

  const ws = readHanaPreferences().workspace_ui_state?.workspaces || {};
  const roots = Object.keys(ws).sort((a, b) => (ws[b]?.updatedAt || 0) - (ws[a]?.updatedAt || 0));
  for (const r of roots) {
    const p = path.join(String(r).replace(/\\/g, "/"), MEDIA_LIB_DIRNAME);
    try { if (fs.statSync(p).isDirectory()) return { dir: p, from: "detected", workspace: r }; } catch { /* 没有 */ }
  }
  if (roots.length) {
    return { dir: path.join(roots[0], MEDIA_LIB_DIRNAME), from: "inferred", workspace: roots[0], missing: true };
  }
  return null;
}

/** 媒体库目录。与生成图/内置素材并列的第三个来源。 */
function discoverMediaLibDirs() {
  const r = resolveMediaLibraryDir();
  if (!r) return [];
  return [{ dir: r.dir, owner: MEDIA_LIB_OWNER }];
}

/**
 * hana 集中媒体库：AI 生成产物的落地处，用户可在设置里改位置。
 * 只读引用，不入库。位置从 Hana 偏好动态读取，改完设置无需重启图库。
 */
function listMediaLib({ includeVideo = false, keyword = "" } = {}) {
  return listFromDirs(discoverMediaLibDirs(), { prefix: "medlib_", source: "media-lib", includeVideo, keyword });
}

function resolveMediaLibPath(id) {
  return resolvePrefixedId(id, "medlib_", discoverMediaLibDirs);
}

/**
 * 依次尝试的依赖查找目录（后者仅在前者找不到时使用）。
 * 顺序：应用自己的 app-data 依赖 → v1 插件目录。
 */
function depSearchDirs() {
  return [
    { dir: localDepsDir(), source: "app-data" },
    { dir: legacyPluginDir(), source: "legacy-plugin" },
  ].filter((d) => d.dir && fs.existsSync(d.dir));
}

/**
 * 加载一个依赖：先试包内 node_modules，失败再到各备用目录借。
 * @returns {{mod: any, source: string}}
 */
async function loadDep(name) {
  let firstErr = null;
  try {
    return { mod: await import(name), source: "bundled" };
  } catch (e) {
    firstErr = e;
  }
  const { createRequire } = await import("node:module");
  for (const { dir, source } of depSearchDirs()) {
    try {
      const req = createRequire(path.join(dir, "noop.js"));
      const resolved = req.resolve(name);
      return { mod: await import(pathToFileURL(resolved).href), source };
    } catch { /* 试下一个目录 */ }
  }
  throw firstErr;   // 报原始错误，避免误导
}

let sharpLib = null;
try {
  const r = await loadDep("sharp");
  sharpLib = r.mod.default ?? r.mod;
  capabilities.sharp = true;
  capabilities.sharpSource = r.source;
} catch (e) {
  capabilities.sharpError = String(e?.message || e).slice(0, 200);
}

let exifrLib = null;
try {
  const r = await loadDep("exifr");
  exifrLib = r.mod;
  capabilities.exifr = true;
  capabilities.exifrSource = r.source;
} catch (e) {
  capabilities.exifrError = String(e?.message || e).slice(0, 200);
}

// ── 配置 ──
function readConfig() {
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function writeConfig(patch) {
  const clean = { ...(patch || {}) };
  // v1 前端会附带 _oldPaths（用于清理被移除扫描目录的旧记录），不是配置项。
  delete clean._oldPaths;
  if (clean.thumbnailSize != null) {
    const n = parseInt(clean.thumbnailSize, 10);
    clean.thumbnailSize = Number.isFinite(n) && n > 0 ? n : DEFAULT_CONFIG.thumbnailSize;
  }
  if (Array.isArray(clean.scanPaths)) {
    clean.scanPaths = clean.scanPaths.map((p) => String(p || "").trim()).filter(Boolean);
  }
  const next = { ...readConfig(), ...clean };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2));
  return next;
}

// ── 数据库 ──
let db = null;

const CJK = /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uAC00-\uD7AF]/;

/** CJK 逐字切分：unicode61 会把连续汉字当单个 token，中文检索必须逐字拆。 */
function seg(value) {
  if (value == null) return "";
  let out = "";
  for (const ch of String(value)) {
    if (CJK.test(ch)) out += ` ${ch} `;
    else if (/[A-Za-z0-9]/.test(ch)) out += ch;
    else out += " ";
  }
  return out.replace(/\s+/g, " ").trim();
}

/** 查询转 MATCH 表达式。前缀通配必须写成 "tokens"*（引号闭合后再加 *）。 */
function toMatchQuery(value) {
  if (value == null) return "";
  const parts = [];
  for (const term of String(value).trim().split(/\s+/).filter(Boolean)) {
    const s = seg(term);
    if (!s) continue;
    parts.push('"' + s.split(" ").join(" ") + '"*');
  }
  return parts.join(" AND ");
}

function openDb() {
  if (db) return db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.function("hana_seg", { deterministic: true }, seg);
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
  fs.mkdirSync(THUMB_DIR, { recursive: true });
  return db;
}

const q = (sql, params = []) => { const s = openDb().prepare(sql); return params.length ? s.all(...params) : s.all(); };
const q1 = (sql, params = []) => { const s = openDb().prepare(sql); return (params.length ? s.get(...params) : s.get()) ?? null; };
const run = (sql, params = []) => { const s = openDb().prepare(sql); return params.length ? s.run(...params) : s.run(); };

// ── 文件工具 ──
/** 按扩展名集合递归扫目录。includeVideo 时连视频一起收。 */
function walkImages(root, limit = 200000, includeVideo = false) {
  const exts = includeVideo ? new Set([...IMAGE_EXTS, ...VIDEO_EXTS]) : IMAGE_EXTS;
  const out = [];
  const stack = [root];
  while (stack.length && out.length < limit) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { stack.push(full); continue; }
      if (e.isFile() && exts.has(path.extname(e.name).toLowerCase())) out.push(full);
    }
  }
  return out;
}

function hashFile(file) {
  const h = crypto.createHash("sha256");
  h.update(fs.readFileSync(file));
  return h.digest("hex");
}

/** 目标路径已存在时追加 -1 / -2 …，直到不冲突。 */
function uniquePath(target) {
  if (!fs.existsSync(target)) return target;
  const dir = path.dirname(target);
  const ext = path.extname(target);
  const base = path.basename(target, ext);
  for (let i = 1; i < 10000; i++) {
    const p = path.join(dir, `${base}-${i}${ext}`);
    if (!fs.existsSync(p)) return p;
  }
  return path.join(dir, `${base}-${Date.now()}${ext}`);
}

/**
 * 读取图片尺寸。
 * EXIF 优先（连拍摄信息一起拿），EXIF 没有宽高时用 sharp 从像素头读。
 * 无 EXIF 的 PNG/截图很常见，只靠 exifr 会得到一堆 null。
 */
async function readDimensions(file) {
  if (!sharpLib) return {};
  try {
    const m = await sharpLib(file).metadata();
    return { width: m?.width ?? null, height: m?.height ?? null };
  } catch {
    return {};
  }
}

/** 读取 EXIF；无 exifr 时降级为文件 mtime。 */
async function readExif(file) {
  let base = {};
  if (exifrLib) {
    try {
      const d = await exifrLib.parse(file, ["DateTimeOriginal", "Make", "Model", "ImageWidth", "ImageHeight"]);
      if (d) {
        base = {
          date_taken: d.DateTimeOriginal ? new Date(d.DateTimeOriginal).toISOString() : null,
          camera_make: d.Make || null,
          camera_model: d.Model || null,
          width: d.ImageWidth || null,
          height: d.ImageHeight || null,
        };
      }
    } catch { /* 无 EXIF 或解析失败 */ }
  }
  if (!base.width || !base.height) {
    const dim = await readDimensions(file);
    if (dim.width) base.width = dim.width;
    if (dim.height) base.height = dim.height;
  }
  return base;
}

// ── HTTP ──
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * GET query 参数的类型规范化。
 *
 * 前端用 GET 调 /search，参数在 query string 里；而 handler 统一读 body。
 * 不合并的话 body 永远是 {}，sort / keyword / tag / page 全部丢失 ——
 * 表现就是「排序下拉框切了没反应」。
 * 同时要还原真值：query 里只有字符串，而后端大量用 `=== true` 严格判断，
 * 字符串 "true" 过不了这个判断。
 * 空串原样返回（前端用 ratio="" 表示「不过滤」）。
 */
function coerceQuery(v) {
  if (v === "true") return true;
  if (v === "false") return false;
  if (v !== "" && Number.isFinite(Number(v))) return Number(v);
  return v;
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 8 * 1024 * 1024) { req.destroy(); resolve({}); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8"))); }
      catch { resolve({}); }
    });
    req.on("error", () => resolve({}));
  });
}

/** 时间戳（用于默认文件名）。 */
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 解析输出路径；缺省落到 app-data/exports/。 */
function resolveOutput(output, defaultName) {
  if (typeof output === "string" && output.trim()) return path.resolve(output.trim());
  return path.join(EXPORT_DIR, defaultName);
}

/** 由查询参数构造筛选条件（generate 用）。 */
function buildSelection(body = {}) {
  const conds = ["hidden = 0"];
  const params = [];
  if (body.tag) {
    conds.push("id IN (SELECT image_id FROM image_tags WHERE tag_id IN (SELECT id FROM tags WHERE name = ?))");
    params.push(body.tag);
  }
  if (body.date_from) { conds.push("date_taken >= ?"); params.push(body.date_from); }
  if (body.date_to) { conds.push("date_taken <= ?"); params.push(body.date_to + "T23:59:59"); }
  if (body.ext) { conds.push("ext = ?"); params.push(String(body.ext).toLowerCase().replace(".", "")); }
  return { where: conds.join(" AND "), params, limit: Math.min(Number(body.limit) || 500, 5000) };
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** 把本地绝对路径转成 file:/// URL（HTML 打开时能直接加载图片）。 */
function fileUrl(p) {
  const norm = String(p).replace(/\\/g, "/");
  return "file:///" + (norm.startsWith("/") ? norm.slice(1) : norm);
}

/** 生成自包含的静态画廊页。 */
function renderGalleryHtml(rows, title, cfg) {
  const byDate = new Map();
  for (const r of rows) {
    const day = (r.date_taken || "").slice(0, 10) || "未知日期";
    if (!byDate.has(day)) byDate.set(day, []);
    byDate.get(day).push(r);
  }

  const sections = [...byDate.entries()].map(([day, items]) => {
    const cards = items.map((r) => {
      const dim = r.width && r.height ? `${r.width}×${r.height}` : "";
      const size = r.size_bytes ? `${(r.size_bytes / 1024).toFixed(0)} KB` : "";
      return `      <figure class="card">
        <img loading="lazy" src="${escapeHtml(fileUrl(r.path))}" alt="${escapeHtml(r.filename)}">
        <figcaption><span class="nm">${escapeHtml(r.filename)}</span>${dim || size ? `<span class="mt">${escapeHtml([dim, size].filter(Boolean).join(" · "))}</span>` : ""}</figcaption>
      </figure>`;
    }).join("\n");
    return `  <section>
    <h2>${escapeHtml(day)} <span class="n">${items.length}</span></h2>
    <div class="grid">
${cards}
    </div>
  </section>`;
  }).join("\n");

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root{--bg:#faf8f3;--ink:#3d3833;--soft:#8a8078;--line:#e8e2d8;--panel:#fffdf9}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.6 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;padding:32px 24px 64px}
header{max-width:1200px;margin:0 auto 28px;border-bottom:1px solid var(--line);padding-bottom:14px}
h1{margin:0;font-size:20px;font-weight:600;letter-spacing:.4px}
.meta{margin-top:6px;font-size:12px;color:var(--soft)}
section{max-width:1200px;margin:0 auto 32px}
h2{font-size:13px;font-weight:600;color:var(--soft);letter-spacing:.6px;margin:0 0 12px}
h2 .n{font-weight:400;opacity:.7}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px}
.card{margin:0;border:1px solid var(--line);border-radius:10px;overflow:hidden;background:var(--panel);transition:border-color .12s}
.card:hover{border-color:#a8916c}
.card img{width:100%;aspect-ratio:1;object-fit:cover;display:block;background:#f2eee6}
figcaption{padding:7px 9px;font-size:11px;line-height:1.4}
figcaption .nm{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
figcaption .mt{display:block;color:var(--soft);font-size:10px;margin-top:2px}
.empty{max-width:1200px;margin:80px auto;text-align:center;color:var(--soft)}
footer{max-width:1200px;margin:40px auto 0;font-size:11px;color:var(--soft);border-top:1px solid var(--line);padding-top:12px}
</style>
</head>
<body>
<header>
  <h1>${escapeHtml(title)}</h1>
  <div class="meta">${rows.length} 张图片 · 导出于 ${escapeHtml(new Date().toLocaleString("zh-CN"))}</div>
</header>
${sections || '  <div class="empty">没有匹配的图片。</div>'}
<footer>由 Hanako Gallery 生成 · 图片引用本地文件路径</footer>
</body>
</html>
`;
}

const routes = {
  /** 环境与能力探测。UI 首屏据此决定是否提示"缩略图降级"。 */
  "/status": async () => ({
    ok: true,
    dataDir: DATA_DIR,
    config: readConfig(),
    capabilities,
    db: (() => {
      try {
        const d = openDb();
        const cnt = q1("SELECT COUNT(*) AS c FROM images")?.c ?? 0;
        const tags = q1("SELECT COUNT(*) AS c FROM tags")?.c ?? 0;
        return { ok: true, images: cnt, tags, path: DB_PATH };
      } catch (e) {
        return { ok: false, error: String(e?.message || e) };
      }
    })(),
    /** 实测：native 服务能否读到配置的图库根目录（这是整条路是否成立的关键）。 */
    fsAccess: (() => {
      const root = readConfig().galleryRoot;
      try {
        const ok = fs.existsSync(root);
        const items = ok ? fs.readdirSync(root).slice(0, 5) : [];
        return { ok, root, exists: ok, sample: items };
      } catch (e) {
        return { ok: false, root, error: String(e?.message || e) };
      }
    })(),
  }),

  "/config/get": async () => ({ ok: true, status: "ok", config: readConfig() }),

  /** 列出自动发现的生成图来源目录（UI 可展示，也便于排障）。 */
  "/generated/sources": async (_req, body) => {
    const includeVideo = body.includeVideo === true;
    const dirs = countMediaInDirs(discoverGeneratedDirs());
    const totalMedia = dirs.reduce((a, b) => a + b.mediaCount, 0);
    return { ok: true, sources: dirs, total: sourceTotal(dirs, includeVideo), totalMedia, includeVideo };
  },

  /** 列出随宿主发布的内置素材目录（UI 可展示，也便于排障）。 */
  "/builtin/sources": async (_req, body) => {
    const includeVideo = body.includeVideo === true;
    const dirs = countMediaInDirs(discoverBuiltinDirs());
    const totalMedia = dirs.reduce((a, b) => a + b.mediaCount, 0);
    return {
      ok: true,
      serverVersion: builtinServerRoot() ? path.basename(builtinServerRoot()) : null,
      sources: dirs,
      total: sourceTotal(dirs, includeVideo),
      totalMedia,
      includeVideo,
    };
  },

  /**
   * 集中媒体库位置与内容。
   * dir 是实际落地目录，from 标明位置从哪儿来（便于知道用户改没改过）。
   */
  "/media-library/sources": async (_req, body) => {
    const includeVideo = body.includeVideo === true;
    const r = resolveMediaLibraryDir();
    if (!r) return { ok: true, sources: [], total: 0, dir: null, from: null, note: "未找到媒体库位置" };
    const dirs = countMediaInDirs([{ dir: r.dir, owner: MEDIA_LIB_OWNER }]);
    const totalMedia = dirs.reduce((a, b) => a + b.mediaCount, 0);
    return {
      ok: true, dir: r.dir, from: r.from, workspace: r.workspace || null, missing: !!r.missing,
      sources: dirs, total: sourceTotal(dirs, includeVideo), totalMedia, includeVideo,
    };
  },

  /**
   * 写配置。收平铺字段（v1 前端格式）或 { patch } 包裹。
   * 若传了 _oldPaths，则把已从 scanPaths 移除的目录下的旧记录一并清掉
   * （与 v1 行为一致；只删库记录，不动磁盘文件）。
   */
  "/config/set": async (_req, body) => {
    const patch = body.patch && typeof body.patch === "object" ? { ...body.patch } : { ...body };
    const oldPaths = Array.isArray(patch._oldPaths) ? patch._oldPaths.map((p) => String(p || "")) : null;
    const next = writeConfig(patch);

    let pruned = 0;
    if (oldPaths) {
      const keep = new Set(next.scanPaths || []);
      for (const old of oldPaths) {
        if (keep.has(old)) continue;
        const norm = String(old).replace(/\\/g, "/");
        const rows = q("SELECT id, thumbnail_path FROM images WHERE source_path = ? OR source_path = ?", [norm, String(old)]);
        for (const r of rows) {
          if (r.thumbnail_path) { try { fs.unlinkSync(r.thumbnail_path); } catch { /* 已不存在 */ } }
          run("DELETE FROM image_tags WHERE image_id = ?", [r.id]);
          run("DELETE FROM images WHERE id = ?", [r.id]);
          pruned++;
        }
      }
    }
    return { ok: true, status: "ok", config: next, pruned };
  },

  /** 扫描并入库。同步实现；图片多时由 AppHost 侧轮询超时保护。 */
  "/scan": async (_req, body) => {
    const cfg = readConfig();
    // 显式目标可以是 paths 数组，也可以是单个 path —— 两种写法都认，
    // 免得调用方传了 path 却被静默忽略、回退到配置根。
    const explicit = (Array.isArray(body.paths) && body.paths.length)
      ? body.paths
      : (typeof body.path === "string" && body.path.trim() ? [body.path.trim()] : []);
    const targets = explicit.length
      ? explicit
      : (cfg.scanPaths?.length ? cfg.scanPaths : [cfg.galleryRoot]);
    const started = Date.now();
    let imported = 0, skipped = 0, failed = 0, scanned = 0;
    const errors = [];

    for (const target of targets) {
      if (!fs.existsSync(target)) { errors.push({ path: target, error: "目录不存在" }); continue; }
      const files = walkImages(target, 200000, body.showVideo === true);
      scanned += files.length;
      for (const file of files) {
        try {
          const hash = hashFile(file);
          if (q1("SELECT id FROM images WHERE file_hash = ?", [hash])) { skipped++; continue; }
          const st = fs.statSync(file);
          const ex = await readExif(file);
          const now = new Date().toISOString();
          run(`INSERT INTO images (id, file_hash, path, filename, ext, size_bytes, width, height,
               date_taken, date_imported, date_modified, camera_make, camera_model, thumbnail_path, hidden, source_path)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)`, [
            crypto.randomUUID(), hash, file, path.basename(file),
            path.extname(file).toLowerCase().replace(".", ""), st.size,
            ex.width ?? null, ex.height ?? null,
            ex.date_taken || st.mtime.toISOString(), now, now,
            ex.camera_make ?? null, ex.camera_model ?? null,
            null,   // thumbnail_path：首次入库尚未生成
            target, // source_path（存归一化路径，与 v1 一致，便于移除目录时清理）
          ]);
          imported++;
        } catch (e) {
          failed++;
          if (errors.length < 10) errors.push({ file, error: String(e?.message || e).slice(0, 150) });
        }
      }
    }
    return { ok: true, summary: { scanned, imported, skipped, failed, duration_ms: Date.now() - started, targets }, errors };
  },

  /**
   * 搜索。FTS5 优先，无词元或无命中时回退 LIKE。返回含标签的卡片所需字段。
   *
   * 同时兼容两套分页/筛选参数：
   *   v1 风格  page + pageSize
   *   v2 风格  offset + limit
   * 排序与比例筛选在 SQL 里做，保证分页总数正确（前端不再重复过滤）。
   */
  "/search": async (_req, body) => {
    const pageSize = Math.min(Number(body.pageSize) || Number(body.limit) || 60, 500);
    const page = Math.max(Number(body.page) || 1, 1);
    const offset = body.offset != null ? Math.max(Number(body.offset) || 0, 0) : (page - 1) * pageSize;
    const limit = pageSize;
    const conds = ["hidden = 0"];
    const params = [];

    if (body.keyword) {
      const match = toMatchQuery(body.keyword);
      let used = false;
      if (match) {
        try {
          const hit = q1("SELECT image_id FROM images_fts WHERE images_fts MATCH ? LIMIT 1", [match]);
          if (hit) { conds.push("id IN (SELECT image_id FROM images_fts WHERE images_fts MATCH ?)"); params.push(match); used = true; }
        } catch { /* 语法异常 → 回退 */ }
      }
      if (!used) {
        conds.push("(filename LIKE ? OR path LIKE ?)");
        params.push(`%${body.keyword}%`, `%${body.keyword}%`);
      }
    }
    if (body.tag) {
      conds.push("id IN (SELECT image_id FROM image_tags WHERE tag_id IN (SELECT id FROM tags WHERE name = ?))");
      params.push(body.tag);
    }
    if (body.date_from) { conds.push("date_taken >= ?"); params.push(body.date_from); }
    if (body.date_to) { conds.push("date_taken <= ?"); params.push(body.date_to + "T23:59:59"); }
    if (body.ext) { conds.push("ext = ?"); params.push(String(body.ext).toLowerCase().replace(".", "")); }

    // 比例 / 收藏筛选。阈值与 v1 服务端一致（1.2 / 0.8 / 0.9-1.1）。
    const ratio = String(body.ratio || "");
    if (ratio === "favorite") {
      conds.push("id IN (SELECT image_id FROM image_tags WHERE tag_id IN (SELECT id FROM tags WHERE name = ?))");
      params.push(FAVORITE_TAG);
    } else if (ratio === "wide") {
      conds.push("width > 0 AND height > 0 AND CAST(width AS REAL) / CAST(height AS REAL) > 1.2");
    } else if (ratio === "tall") {
      conds.push("width > 0 AND height > 0 AND CAST(width AS REAL) / CAST(height AS REAL) < 0.8");
    } else if (ratio === "square") {
      conds.push("width > 0 AND height > 0 AND CAST(width AS REAL) / CAST(height AS REAL) BETWEEN 0.9 AND 1.1");
    }

    const ORDER_BY = {
      date_desc: "date_taken DESC, date_imported DESC",
      date_asc: "date_taken ASC, date_imported ASC",
      name_asc: "filename ASC",
      name_desc: "filename DESC",
      size_desc: "size_bytes DESC",
      size_asc: "size_bytes ASC",
    };
    const orderBy = ORDER_BY[String(body.sort || "date_desc")] || ORDER_BY.date_desc;

    // 来源过滤。三个外部来源不入库，不走 SQL，单独取、单独分页。
    // 否则「点了一个分组却什么都看不到」—— 它们根本不在 images 表里。
    const wantSource = String(body.source || "").trim();
    if (wantSource === "builtin" || wantSource === "generated" || wantSource === "media-lib") {
      const pick = { includeVideo: body.showVideo === true, keyword: body.keyword || "" };
      let all;
      if (wantSource === "generated") all = listGenerated({ ...pick, sources: body.generatedSources || null });
      else if (wantSource === "builtin") all = listBuiltin({ ...pick, sources: body.builtinSources || null });
      else all = listMediaLib(pick);
      all.sort(SORT_CMP[String(body.sort || "date_desc")] || SORT_CMP.date_desc);
      const t = all.length;
      const off = Math.min(offset, Math.max(0, t));
      const slice = all.slice(off, off + limit);
      const tp = Math.max(1, Math.ceil(t / limit));
      return {
        ok: true, status: "ok", total: t, count: slice.length, offset: off, limit,
        page, totalPages: tp, pages: tp, results: slice, source: wantSource,
        totalGenerated: wantSource === "generated" ? t : 0,
        totalBuiltin: wantSource === "builtin" ? t : 0,
        totalMediaLib: wantSource === "media-lib" ? t : 0,
      };
    }
    if (wantSource === "import" || wantSource === "external") {
      conds.push(wantSource === "external" ? "path LIKE 'ext:%'" : "path NOT LIKE 'ext:%'");
    }

    const where = conds.join(" AND ");
    const total = q1(`SELECT COUNT(*) AS c FROM images WHERE ${where}`, params)?.c ?? 0;
    const rows = q(`SELECT id, filename, ext, path, size_bytes, width, height, date_taken, date_imported, thumbnail_path
                    FROM images WHERE ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
      [...params, limit, offset]);

    for (const r of rows) {
      r.tags = q("SELECT t.name FROM tags t JOIN image_tags it ON t.id = it.tag_id WHERE it.image_id = ? ORDER BY t.name", [r.id]).map(x => x.name);
      r.media_type = VIDEO_EXTS.has("." + String(r.ext).toLowerCase()) ? "video" : "image";
      r.source = String(r.path).startsWith("ext:") ? "external" : "import";
      r.favorited = r.tags.includes(FAVORITE_TAG) ? 1 : 0;
    }
    const totalPages = Math.max(1, Math.ceil(total / limit));
    let results = rows;

    // 生成图（自动发现的各种 generated/ 目录）只在第一页尾部追加，不参与总数与分页。
    // 内置素材（随宿主发布的封面图库/角色卡/纹理）与集中媒体库（AI 生成产物的落地处）
    // 同样走尾部追加，三者合并去重后**按 sort 重新排** —— 否则切换排序对它不生效，
    // 因为这三个来源不入库，SQL 的 ORDER BY 管不到它们。
    if (body.showGenerated !== false && !body.tag && !body.ratio && offset === 0) {
      const pick = { includeVideo: body.showVideo === true, keyword: body.keyword || "" };
      const gen = listGenerated({ ...pick, sources: body.generatedSources || null });
      const builtin = listBuiltin({ ...pick, sources: body.builtinSources || null });
      const medlib = listMediaLib(pick);
      const seen = new Set(rows.map((r) => r.path));
      const extra = gen.concat(builtin, medlib)
        .filter((g) => !seen.has(g.path))
        .sort(SORT_CMP[String(body.sort || "date_desc")] || SORT_CMP.date_desc);
      results = rows.concat(extra.slice(0, Math.max(0, limit - rows.length)));
    }
    return {
      ok: true, status: "ok", total, count: results.length, offset, limit,
      page, totalPages, pages: totalPages, results, source: wantSource || "import",
      totalGenerated: results.filter((r) => r.source === "generated").length,
      totalBuiltin: results.filter((r) => r.source === "builtin").length,
      totalMediaLib: results.filter((r) => r.source === "media-lib").length,
    };
  },

  /** 标签列表。image_count 是 v1 前端用的字段名。 */
  "/tags/list": async () => ({
    ok: true,
    status: "ok",
    tags: q(`SELECT t.id, t.name, COUNT(it.image_id) AS image_count FROM tags t
             LEFT JOIN image_tags it ON t.id = it.tag_id GROUP BY t.id ORDER BY t.name`),
  }),

  /** 标签增删（v1 前端格式：{ id, tags: [...], action?: 'add'|'remove' }）。 */
  "/tags": async (_req, body) => {
    const id = body.id || body.imageId;
    if (!id) return { ok: false, status: "error", error: "missing id" };
    const names = (Array.isArray(body.tags) ? body.tags : [body.tags])
      .map((s) => String(s || "").trim()).filter(Boolean);
    const remove = body.action === "remove";

    for (const name of names) {
      let t = q1("SELECT id FROM tags WHERE name = ?", [name]);
      if (remove) {
        if (t) run("DELETE FROM image_tags WHERE image_id = ? AND tag_id = ?", [id, t.id]);
        continue;
      }
      if (!t) { run("INSERT OR IGNORE INTO tags (name) VALUES (?)", [name]); t = q1("SELECT id FROM tags WHERE name = ?", [name]); }
      if (t) run("INSERT OR IGNORE INTO image_tags (image_id, tag_id) VALUES (?, ?)", [id, t.id]);
    }
    return { ok: true, status: "ok" };
  },

  /** 重命名：改磁盘文件名 + 同步库记录（缩略图不受影响，按 id 缓存）。 */
  "/rename": async (_req, body) => {
    const img = q1("SELECT id, path, filename, ext FROM images WHERE id = ?", [body.id]);
    if (!img) return { ok: false, status: "error", error: "图片不存在" };
    const raw = String(body.name || "").trim().replace(/[\\/:*?"<>|]/g, "_");
    if (!raw) return { ok: false, status: "error", error: "名称不能为空" };
    const base = raw.replace(/\.[^.]+$/, "");
    const newName = `${base}${img.ext ? "." + img.ext : ""}`;
    if (newName === img.filename) return { ok: true, status: "ok", filename: newName, unchanged: true };

    const dir = path.dirname(img.path);
    let target = path.join(dir, newName);
    if (fs.existsSync(target)) return { ok: false, status: "error", error: "同名文件已存在" };

    try {
      fs.renameSync(img.path, target);
    } catch (e) {
      return { ok: false, status: "error", error: `重命名失败：${e.message}` };
    }
    run("UPDATE images SET path = ?, filename = ? WHERE id = ?", [target, newName, img.id]);
    return { ok: true, status: "ok", id: img.id, filename: newName, path: target };
  },

  /**
   * 删除。默认只删库记录（不动磁盘，与 /forget 一致）；
   * 传 deleteFile: true 时连磁盘文件一起删。
   */
  "/delete": async (_req, body) => {
    const ids = Array.isArray(body.ids) ? body.ids : [body.id].filter(Boolean);
    if (!ids.length) return { ok: false, status: "error", error: "missing id" };
    let removed = 0, filesDeleted = 0;
    const errors = [];
    for (const id of ids) {
      const img = q1("SELECT id, path, thumbnail_path FROM images WHERE id = ?", [id]);
      if (!img) continue;
      if (body.deleteFile === true && img.path && !String(img.path).startsWith("ext:")) {
        try { fs.unlinkSync(img.path); filesDeleted++; }
        catch (e) { errors.push({ id, error: String(e.message).slice(0, 120) }); }
      }
      if (img.thumbnail_path) { try { fs.unlinkSync(img.thumbnail_path); } catch { /* 已不存在 */ } }
      run("DELETE FROM image_tags WHERE image_id = ?", [id]);
      run("DELETE FROM images WHERE id = ?", [id]);
      removed++;
    }
    return { ok: true, status: "ok", removed, filesDeleted, errors };
  },

  /** 从 URL 下载图片入库。文件名取 URL 末段，冲突时加序号。 */
  "/import-url": async (_req, body) => {
    const raw = String(body.url || "").trim();
    if (!/^https?:\/\//i.test(raw)) return { ok: false, status: "error", error: "需要 http(s) URL" };
    const cfg = readConfig();
    const destDir = (typeof body.dir === "string" && body.dir.trim()) ? body.dir.trim() : cfg.galleryRoot;

    let u;
    try { u = new URL(raw); } catch { return { ok: false, status: "error", error: "URL 无法解析" }; }
    let name = decodeURIComponent(path.basename(u.pathname)) || `download-${stamp()}`;
    if (!/\.[a-z0-9]{2,5}$/i.test(name)) name += ".jpg";
    name = name.replace(/[\\/:*?"<>|]/g, "_");

    let buf, mime = "";
    try {
      const res = await fetch(raw, { redirect: "follow" });
      if (!res.ok) return { ok: false, status: "error", error: `下载失败：HTTP ${res.status}` };
      mime = res.headers.get("content-type") || "";
      buf = Buffer.from(await res.arrayBuffer());
    } catch (e) {
      return { ok: false, status: "error", error: `下载失败：${e.message}` };
    }
    if (!buf?.length) return { ok: false, status: "error", error: "下载内容为空" };
    if (buf.length > MAX_IMPORT_BYTES) {
      return { ok: false, status: "error", error: `文件过大（${(buf.length / 1048576).toFixed(1)} MB > ${MAX_IMPORT_BYTES / 1048576} MB）` };
    }

    fs.mkdirSync(destDir, { recursive: true });
    const target = uniquePath(path.join(destDir, name));
    try { fs.writeFileSync(target, buf); }
    catch (e) { return { ok: false, status: "error", error: `写入失败：${e.message}` }; }

    const ext = path.extname(target).toLowerCase().replace(".", "");
    const hash = crypto.createHash("sha256").update(buf).digest("hex");
    const ex = await readExif(target);
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    run(`INSERT INTO images (id, file_hash, path, filename, ext, size_bytes, width, height,
         date_taken, date_imported, date_modified, camera_make, camera_model, thumbnail_path, hidden, source_path)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)`, [
      id, hash, target, path.basename(target), ext, buf.length,
      ex.width ?? null, ex.height ?? null,
      ex.date_taken || now, now, now,
      ex.camera_make ?? null, ex.camera_model ?? null, null, "url-import",
    ]);
    return { ok: true, status: "ok", id, filename: path.basename(target), path: target, bytes: buf.length, mime };
  },

  /**
   * 登记外部图床链接（不下载）。path 存成 `ext:<url>`，取图时 302 重定向。
   */
  "/add-external": async (_req, body) => {
    const raw = String(body.url || "").trim();
    if (!/^https?:\/\//i.test(raw)) return { ok: false, status: "error", error: "需要 http(s) URL" };
    const tags = (Array.isArray(body.tags) ? body.tags : []).map((s) => String(s || "").trim()).filter(Boolean);
    const filename = decodeURIComponent(raw.split("?")[0].split("/").pop() || "external");
    const ext = (path.extname(filename).toLowerCase().replace(".", "") || "jpg");
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    const hash = crypto.createHash("sha256").update(raw).digest("hex");
    if (q1("SELECT id FROM images WHERE file_hash = ?", [hash])) {
      return { ok: false, status: "error", error: "该链接已存在", duplicate: true };
    }
    run(`INSERT INTO images (id, file_hash, path, filename, ext, size_bytes, width, height,
         date_taken, date_imported, date_modified, camera_make, camera_model, thumbnail_path, hidden, source_path)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)`, [
      id, hash, `ext:${raw}`, filename, ext, 0, 0, 0, now, now, now, null, null, null, "external",
    ]);
    for (const name of tags) {
      let t = q1("SELECT id FROM tags WHERE name = ?", [name]);
      if (!t) { run("INSERT OR IGNORE INTO tags (name) VALUES (?)", [name]); t = q1("SELECT id FROM tags WHERE name = ?", [name]); }
      if (t) run("INSERT OR IGNORE INTO image_tags (image_id, tag_id) VALUES (?, ?)", [id, t.id]);
    }
    return { ok: true, status: "ok", id, filename, url: raw };
  },

  "/tags/add": async (_req, body) => {
    const ids = Array.isArray(body.imageIds) ? body.imageIds : [body.imageIds];
    const names = (Array.isArray(body.tags) ? body.tags : [body.tags]).map(s => String(s || "").trim()).filter(Boolean);
    for (const name of names) {
      let t = q1("SELECT id FROM tags WHERE name = ?", [name]);
      if (!t) { run("INSERT OR IGNORE INTO tags (name) VALUES (?)", [name]); t = q1("SELECT id FROM tags WHERE name = ?", [name]); }
      if (!t) continue;
      for (const id of ids) run("INSERT OR IGNORE INTO image_tags (image_id, tag_id) VALUES (?, ?)", [id, t.id]);
    }
    return { ok: true };
  },

  "/tags/remove": async (_req, body) => {
    const ids = Array.isArray(body.imageIds) ? body.imageIds : [body.imageIds];
    const names = (Array.isArray(body.tags) ? body.tags : [body.tags]).map(s => String(s || "").trim()).filter(Boolean);
    for (const name of names) {
      const t = q1("SELECT id FROM tags WHERE name = ?", [name]);
      if (!t) continue;
      for (const id of ids) run("DELETE FROM image_tags WHERE image_id = ? AND tag_id = ?", [id, t.id]);
    }
    return { ok: true };
  },

  /** 生成（并缓存）缩略图，返回 app-data 内的相对路径。sharp 不可用时原样返回原图路径。 */
  "/thumb": async (_req, body) => {
    const id = String(body.id || "");
    // 生成图与内置素材不进库，直接回退原图。
    if (id.startsWith("gen_") || id.startsWith("builtin_") || id.startsWith("medlib_")) return { ok: false, error: "无缩略图", fallbackOriginal: true };
    const img = q1("SELECT id, path, thumbnail_path, ext FROM images WHERE id = ?", [id]);
    if (!img) return { ok: false, error: "图片不存在" };
    // 外部链接 / 视频：没有可生成的缩略图，回退到原图（前端再决定怎么展示）。
    if (String(img.path).startsWith("ext:") || VIDEO_EXTS.has("." + String(img.ext).toLowerCase())) {
      return { ok: false, error: "无可生成的缩略图", fallbackOriginal: true, originalPath: img.path };
    }
    if (img.thumbnail_path && fs.existsSync(img.thumbnail_path)) {
      return { ok: true, path: img.thumbnail_path, cached: true };
    }
    if (!sharpLib) return { ok: false, error: "sharp 不可用", fallbackOriginal: true, originalPath: img.path };
    if (!fs.existsSync(img.path)) return { ok: false, error: "源文件不存在" };

    const size = readConfig().thumbnailSize || 300;
    fs.mkdirSync(THUMB_DIR, { recursive: true });
    const outPath = path.join(THUMB_DIR, `${img.id}.webp`);
    await sharpLib(img.path).rotate().resize(size, size, { fit: "inside", withoutEnlargement: true }).webp({ quality: 82 }).toFile(outPath);
    run("UPDATE images SET thumbnail_path = ? WHERE id = ?", [outPath, img.id]);
    return { ok: true, path: outPath, cached: false };
  },

  /**
   * 读取图片字节，base64 回传。
   * 外部链接（path 以 ext: 开头）不走这里 —— 由 http/ui.js 直接 302。
   */
  "/image": async (_req, body) => {
    const id = String(body.id || "");
    // 生成图/内置素材/媒体库都不入库：id 形如 gen_<owner>__<文件名>、builtin_<owner>__<文件名> 或 medlib_<owner>__<文件名>，解析后直读。
    if (id.startsWith("gen_") || id.startsWith("builtin_") || id.startsWith("medlib_")) {
      const fp = id.startsWith("gen_") ? resolveGeneratedPath(id)
        : id.startsWith("builtin_") ? resolveBuiltinPath(id) : resolveMediaLibPath(id);
      if (!fp || !fs.existsSync(fp)) return { ok: false, error: "文件不存在" };
      const st = fs.statSync(fp);
      if (st.size > MAX_IMAGE_BYTES) {
        return { ok: false, error: "文件超过回传上限", tooLarge: true, size: st.size, limit: MAX_IMAGE_BYTES };
      }
      const ext = path.extname(fp).toLowerCase().replace(".", "");
      return { ok: true, mime: MIME[ext] || "application/octet-stream", base64: fs.readFileSync(fp).toString("base64") };
    }

    const img = q1("SELECT path, ext FROM images WHERE id = ?", [id]);
    if (!img) return { ok: false, error: "图片不存在" };
    if (String(img.path).startsWith("ext:")) {
      return { ok: false, error: "外部链接", external: true, url: String(img.path).slice(4) };
    }
    if (!fs.existsSync(img.path)) return { ok: false, error: "源文件不存在" };
    const st = fs.statSync(img.path);
    if (st.size > MAX_IMAGE_BYTES) {
      return { ok: false, error: "图片超过回传上限", tooLarge: true, size: st.size, limit: MAX_IMAGE_BYTES };
    }
    const ext = String(img.ext).toLowerCase();
    return { ok: true, mime: MIME[ext] || "application/octet-stream", base64: fs.readFileSync(img.path).toString("base64") };
  },

  /** 删除入库记录（不动磁盘文件）。 */
  "/forget": async (_req, body) => {
    const ids = Array.isArray(body.imageIds) ? body.imageIds : [body.imageIds];
    for (const id of ids) {
      const img = q1("SELECT thumbnail_path FROM images WHERE id = ?", [id]);
      if (img?.thumbnail_path) { try { fs.unlinkSync(img.thumbnail_path); } catch { /* 已不存在 */ } }
      run("DELETE FROM image_tags WHERE image_id = ?", [id]);
      run("DELETE FROM images WHERE id = ?", [id]);
    }
    return { ok: true, removed: ids.length };
  },

  "/db/rebuild": async () => {    const d = openDb();
    d.exec("DELETE FROM images_fts");
    d.exec("INSERT INTO images_fts(image_id, filename, path) SELECT id, hana_seg(filename), hana_seg(path) FROM images");
    return { ok: true, fts: q1("SELECT COUNT(*) AS c FROM images_fts")?.c ?? 0 };
  },

  /** 生成 Markdown 引用片段；纯计算，不写文件。 */
  "/markdown": async (_req, body) => {
    const img = q1("SELECT id, filename, path FROM images WHERE id = ?", [body.id]);
    if (!img) return { ok: false, error: "图片不存在" };
    const cfg = readConfig();
    const rel = (typeof body.base === "string" && body.base.trim())
      ? body.base.trim()
      : (cfg.blogImagesPath || "public/images/gallery");
    const base = String(rel).replace(/[\\/]+$/, "");
    const alt = (typeof body.alt_text === "string" && body.alt_text.trim())
      ? body.alt_text.trim()
      : img.filename.replace(/\.[^.]+$/, "");
    const fmt = body.format || "markdown";

    if (fmt === "path") return { ok: true, format: "path", text: img.path };
    if (fmt === "thumb") {
      const t = q1("SELECT thumbnail_path FROM images WHERE id = ?", [body.id]);
      if (!t?.thumbnail_path) return { ok: false, error: "该图片还没有缩略图，先调 /thumb 生成" };
      return { ok: true, format: "thumb", text: t.thumbnail_path };
    }
    const url = `${base}/${img.filename}`;
    if (fmt === "url") return { ok: true, format: "url", text: url };
    return { ok: true, format: "markdown", text: `![${alt}](${url})` };
  },

  /** 导出静态 HTML 画廊页。 */
  "/generate": async (_req, body) => {
    const sel = buildSelection(body);
    const rows = q(`SELECT id, filename, path, width, height, size_bytes, date_taken FROM images
                    WHERE ${sel.where} ORDER BY date_taken DESC, date_imported DESC LIMIT ?`,
      [...sel.params, sel.limit]);
    const cfg = readConfig();
    const title = (typeof body.title === "string" && body.title.trim()) ? body.title.trim() : "图库";
    const html = renderGalleryHtml(rows, title, cfg);
    const out = resolveOutput(body.output, `gallery-${stamp()}.html`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, html);
    return { ok: true, count: rows.length, output: out, bytes: Buffer.byteLength(html) };
  },

  /** 导出索引（JSON 或 SQLite 快照）。 */
  "/export": async (_req, body) => {
    const fmt = body.format === "sqlite" ? "sqlite" : "json";
    const out = resolveOutput(body.output, `gallery-index-${stamp()}.${fmt === "sqlite" ? "db" : "json"}`);
    fs.mkdirSync(path.dirname(out), { recursive: true });

    if (fmt === "sqlite") {
      // VACUUM INTO 产生一致快照，比直接复制更安全（无 journal 竞态）
      try { fs.unlinkSync(out); } catch { /* 目标不存在 */ }
      openDb().exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
      return { ok: true, format: "sqlite", output: out, bytes: fs.statSync(out).size };
    }

    const data = {
      exportedAt: new Date().toISOString(),
      app: "hanako-gallery",
      config: readConfig(),
      images: q("SELECT * FROM images"),
      tags: q("SELECT * FROM tags"),
      imageTags: q("SELECT * FROM image_tags"),
    };
    fs.writeFileSync(out, JSON.stringify(data, null, 2));
    return {
      ok: true, format: "json", output: out,
      counts: { images: data.images.length, tags: data.tags.length, links: data.imageTags.length },
      bytes: fs.statSync(out).size,
    };
  },

  /**
   * 把库里的图片复制到一个目标目录（默认博客图片目录）。
   * 只复制、不移动，已成同名文件则跳过；支持 dry_run 预演。
   * 单向推送（push），不是双向同步 —— 路由名原为 /sync，v0.6.0 正名为 /push。
   *
   * 注：受管服务是 native profile，对当前用户可读的文件有写权限；
   * 若目标目录因平台写限制拒写，会在 errors 里如实回报。
   */
  "/push": async (_req, body) => {
    const cfg = readConfig();
    const dest = (typeof body.dest === "string" && body.dest.trim()) ? body.dest.trim() : cfg.blogImagesPath;
    if (!dest) return { ok: false, error: "需要 dest 参数，或在配置里设置 blogImagesPath" };

    const rows = q("SELECT id, filename, path FROM images WHERE hidden = 0");
    const dry = body.dry_run === true;
    let copied = 0, skipped = 0, failed = 0;
    const errors = [];

    if (!dry) {
      try { fs.mkdirSync(dest, { recursive: true }); }
      catch (e) { return { ok: false, error: `无法创建目标目录：${e.message}`, dest }; }
    }

    for (const r of rows) {
      const target = path.join(dest, r.filename);
      if (fs.existsSync(target)) { skipped++; continue; }
      if (dry) { copied++; continue; }
      if (!fs.existsSync(r.path)) {
        failed++; if (errors.length < 10) errors.push({ file: r.filename, error: "源文件不存在" });
        continue;
      }
      try { fs.copyFileSync(r.path, target); copied++; }
      catch (e) {
        failed++;
        if (errors.length < 10) errors.push({ file: r.filename, error: String(e.message).slice(0, 140) });
      }
    }
    return { ok: true, dryRun: dry, dest, total: rows.length, copied, skipped, failed, errors };
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const handler = routes[url.pathname];
  if (!handler) return json(res, 404, { ok: false, error: "no such route: " + url.pathname });
  let body = {};
  // GET：query string 是参数来源；POST：body 是参数来源。两边可叠加。
  for (const [k, v] of url.searchParams) body[k] = coerceQuery(v);
  if (req.method === "POST") Object.assign(body, await readBody(req));
  try {
    json(res, 200, await handler(req, body));
  } catch (e) {
    json(res, 500, { ok: false, error: String(e?.stack || e).slice(0, 800) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(READY_MARKER, JSON.stringify({
    port: PORT,
    dataDir: DATA_DIR,
    sharp: capabilities.sharp,
    exifr: capabilities.exifr,
  }));
});
