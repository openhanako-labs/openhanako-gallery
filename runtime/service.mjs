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
import { spawn as spawnProcess, spawnSync } from "node:child_process";
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
  // 视频抽帧用的 ffmpeg。留空则走 PATH。不写死本机路径 —— 这是要发给别人的应用。
  ffmpegPath: "",
  // 识图用的视觉模型（由面板写入）。
  aiModel: null,
  // 语义向量。默认走 HANA_HOME 里已配好的 provider（source: 'hana' 就从
  // provider-catalog.json / models.json 里取 baseUrl 与 key，不重复问用户要）。
  // source: 'custom' 时用自定义 baseUrl/model；**apiKey 不落盘**（见 writeConfig）。
  embed: {
    source: "hana",
    providerId: "siliconflow",
    model: "BAAI/bge-m3",
    baseUrl: "",
    apiKey: "",
    dimensions: 1024,
  },
  // 标签栏的手动顺序（用户拖出来的）。不在表里的标签排在后面，按名字。
  tagOrder: [],
  // 识图后是否自动改磁盘文件名。默认关 —— 改名动的是用户的真文件，得他主动开。
  aiRenameOnDescribe: false,
};

/**
 * 自定义 embedding key 的**内存副本**（绝不写盘）。
 *
 * 用户明确要求（2026-09-24）：key 不要落在磁盘上。
 * 所以 config.json 里的 embed.apiKey 永远是空串，真正的 key 只活在这个变量里 ——
 * 代价是服务重启后要重填。`/embed/sources` 会把「key 在不在内存里」如实报给 UI。
 * 注：用 var 而不是 let —— writeConfig 定义在这行之前，用 let 会踩 TDZ。
 */
var _embedKeyOverride = "";

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
  ffmpeg: false,
  ffmpegPath: null,
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
  // 关掉 libvips 的 operation cache。
  //
  // 不是性能洁癖，是「删不掉」的元凶：cache 打开时 sharp(path) 会把源文件的 fd
  // 一直攥在手里（libvips 惰性 mmap），Windows 上就等于文件被占用 ——
  // 于是「看着这张图 → 勾选连磁盘文件一起删」必然 EBUSY，因为刚为它生成过缩略图。
  // 关掉之后每次操作结束就松手（实测：path 进 sharp 也能立刻 unlink）。
  // 本应用的缩略图本来就落在 THUMB_DIR，不指望这个 cache。
  try { sharpLib.cache(false); } catch { /* 老版本没有这个 API，忽略 */ }
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

// ffmpeg：只用于给视频抽一帧当缩略图。找不到就如实降级（视频卡片显示占位）。
// 顺序：配置里的 ffmpegPath → PATH。不写死本机路径。
let ffmpegPath = null;
{
  const cand = String(readConfig().ffmpegPath || "").trim() || "ffmpeg";
  try {
    const r = spawnSync(cand, ["-version"], { stdio: "ignore", timeout: 5000, windowsHide: true });
    if (r.status === 0) { ffmpegPath = cand; capabilities.ffmpeg = true; capabilities.ffmpegPath = cand; }
  } catch { /* 保持 ffmpeg = false */ }
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
  if (typeof clean.ffmpegPath === "string") clean.ffmpegPath = clean.ffmpegPath.trim();
  // 识图用的模型：只收 { provider, model } 两个 ASCII 标识符，其它形状一律归 null。
  // 宿主对这两个字段有字符集要求，脏值存进配置只会在调用时才爆 —— 不如入库前就卡掉。
  if (clean.aiModel !== undefined) {
    const p = String(clean.aiModel?.provider || "").trim();
    const m = String(clean.aiModel?.model || "").trim();
    clean.aiModel = p && m ? { provider: p, model: m } : null;
  }
  // 语义向量配置：只收已知字段，dimensions 转成正整数。
  // **apiKey 不落盘**：非空的 key 只放进内存副本，写到磁盘的值一律清空。
  if (clean.embed !== undefined) {
    const e = clean.embed || {};
    const dims = parseInt(e.dimensions, 10);
    const k = String(e.apiKey || "").trim();
    // 字段“出现”就接管内存副本（空串 = 清掉），这样 UI 上清空输入框能真的清掉；
    // 字段不出现则不动（例如只改 source/model 的请求）。
    if (e.apiKey !== undefined) _embedKeyOverride = k;
    clean.embed = {
      source: e.source === "custom" ? "custom" : "hana",
      providerId: String(e.providerId || "siliconflow").trim(),
      model: String(e.model || "").trim(),
      baseUrl: String(e.baseUrl || "").trim(),
      apiKey: "",
      dimensions: Number.isFinite(dims) && dims > 0 ? dims : 1024,
    };
  }
  if (clean.aiRenameOnDescribe !== undefined) clean.aiRenameOnDescribe = clean.aiRenameOnDescribe === true;
  // 标签手动顺序：字符串数组，去重、限长。
  if (Array.isArray(clean.tagOrder)) {
    const seen = new Set();
    clean.tagOrder = clean.tagOrder
      .map((x) => String(x || "").trim())
      .filter((x) => x && !seen.has(x) && seen.add(x))
      .slice(0, 500);
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
  // 增量扫描靠 (size, mtime) 判「文件是否变过」，旧库没这列 —— 补上。
  // 已有行的 mtime_ms 为 NULL，首次增量重扫时会各哈希一遍，之后就是零成本跳过了。
  try {
    const cols = db.prepare("PRAGMA table_info(images)").all().map((c) => c.name);
    if (!cols.includes("mtime_ms")) db.exec("ALTER TABLE images ADD COLUMN mtime_ms INTEGER");
  } catch { /* 补列失败不致命，退化为每次都哈希 */ }

  // 识图写的描述（模型看图说的那句中文）落在 images.description，并进 FTS。
  //
  // 两个坑：
  //   1. FTS5 虚拟表**不能 ALTER 加列**，只能整表重建 + 重灌。
  //   2. 旧触发器是 `AFTER UPDATE OF filename, path` —— 只写 description 不会触发
  //      重索引，表现就是「识图跑完了但搜不到」。改成 `OF filename, path, description`。
  // 用 fts 表自身的 SQL 文本判断是否已迁移，跑一次就跳过。
  try {
    const cols2 = db.prepare("PRAGMA table_info(images)").all().map((c) => c.name);
    if (!cols2.includes("description")) db.exec("ALTER TABLE images ADD COLUMN description TEXT");
    // 模型给的文件名短名（面板的「命名 / 批量命名」用它，而不是从标签里挑 ——
    // 标签是检索维度，不是命名维度：实测挑出过 `C-二次元` 这种名字）。
    if (!cols2.includes("ai_name")) db.exec("ALTER TABLE images ADD COLUMN ai_name TEXT");
    const ftsSql = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'images_fts'").get()?.sql || "";
    if (!/description/.test(ftsSql)) {
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
    }
  } catch { /* 迁移失败不致命：描述仍写进 images，只是搜不到 */ }
  fs.mkdirSync(THUMB_DIR, { recursive: true });
  return db;
}

const q = (sql, params = []) => { const s = openDb().prepare(sql); return params.length ? s.all(...params) : s.all(); };
const q1 = (sql, params = []) => { const s = openDb().prepare(sql); return (params.length ? s.get(...params) : s.get()) ?? null; };
const run = (sql, params = []) => { const s = openDb().prepare(sql); return params.length ? s.run(...params) : s.run(); };

// ── 文件工具 ──
/** 按扩展名集合递归扫目录。includeVideo 时连视频一起收。
 *  stats 可选：传入对象时会把「因未开视频而被跳过的文件数」记到 videosSkipped，
 *  供 /scan 如实上报 —— 否则用户收完提示根本不知道视频被静默跳过了。 */
function walkImages(root, limit = 200000, includeVideo = false, stats = null) {
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
      if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        if (exts.has(ext)) { out.push(full); continue; }
        if (stats && !includeVideo && VIDEO_EXTS.has(ext)) stats.videosSkipped++;
      }
    }
  }
  return out;
}

function hashFile(file) {
  const h = crypto.createHash("sha256");
  h.update(fs.readFileSync(file));
  return h.digest("hex");
}

/**
 * 删磁盘文件，占用类错误重试几轮。
 *
 * Windows 上「文件被占用」是常态而不是异常：缩略图刚生成完、杀软正在扫、
 * 资源管理器的预览窗格、刚才那次 sharp 读过它 —— 都是几百毫秒级的占用。
 * 早先的实现只有一次 unlinkSync + 一个空 catch，于是失败得无声无息：
 * 库里记录没了、磁盘文件还在，前端还报「已删除（含磁盘文件）」。
 *
 * 现在：短暂占用退避重试；重试还不行就把真实原因带回去（绝不吞）。
 * ENOENT 视为成功 —— 目的就是「让它不在」，它已经不在。
 */
async function unlinkWithRetry(file, tries = 4) {
  let last = "";
  for (let i = 0; i < tries; i++) {
    try { fs.unlinkSync(file); return { ok: true }; }
    catch (e) {
      if (e.code === "ENOENT") return { ok: true };
      last = `${e.code || ""}: ${e.message}`.replace(/^:\s*/, "").trim();
      // 只对「可能马上就好」的错误重试；路径非法之类重试没意义。
      if (!["EBUSY", "EPERM", "EACCES", "EMFILE", "ENFILE"].includes(e.code)) break;
      await new Promise((r) => setTimeout(r, 150 * (i + 1)));
    }
  }
  return { ok: false, error: last };
}

/**
 * 缩略图缓存 key。
 *
 * 旧实现用 DB id（uuid），有三个硬伤：
 *   1. 不入库的三类来源（gen_/builtin_/medlib_）拿不到 uuid → 没缩略图。
 *   2. 同一个 id、源文件被替换 → 缓存命中旧图（key 没变）。
 *   3. 同内容的两个不同文件各自生成一份缩略图（浪费磁盘，但无害）。
 *
 * 新 key = sha256(size + mtimeMs) 截断 20 字符：
 *   · O(1) 计算，只 statSync，不读文件内容 —— 11MB 的 PNG 也不卡。
 *   · 源文件被替换时 mtime 必变 → key 变 → 缓存失效 → 重新生成。
 *   · 入库图的去重已由 DB 的 file_hash UNIQUE 保证，此处不再重复做。
 *
 * statSync 失败时返回 null，调用方降级为「无法缓存，直出原图」。
 */
function computeThumbKey(filePath) {
  try {
    const st = fs.statSync(filePath);
    return crypto.createHash("sha256")
      .update(`${st.size}:${st.mtimeMs}`)
      .digest("hex").slice(0, 20);
  } catch { return null; }
}

/** 把缩略图文件读成响应体。失败时返回 { ok: false } 让上层降级。
 *  不回传绝对路径 —— 客户端拿不到也不需要，少一处本地路径外泄。 */
function readThumbResponse(thumbPath, meta = {}) {
  try {
    const buf = fs.readFileSync(thumbPath);
    return { ok: true, base64: buf.toString("base64"), mime: "image/webp", size: buf.length, ...meta };
  } catch {
    return { ok: false, error: "读取缩略图失败", fallbackOriginal: true };
  }
}

/**
 * 原图超过 MAX_IMAGE_BYTES 时的回传策略。
 *
 * 这个上限是给「把一张图塞进 base64 走 JSON-RPC」定的，不是给「看大图」定的。
 * 直接 413 会让详情弹窗一片空白，所以 sharp 可用时给一张 1600px 的降采样预览，
 * 并用 downscaled: true 如实标注（前端据此提示「已降采样」）—— 宁可看清是缩过的，
 * 也不要让用户以为自己在看原图。sharp 不可用就退回如实报错。
 */
async function oversizedImageResponse(srcPath, st, isVideo = false) {
  // 视频不试降采样：sharp 解不了 mp4，硬跑只会慢一遍再失败。
  if (sharpLib && !isVideo) {
    try {
      fs.mkdirSync(THUMB_DIR, { recursive: true });
      const key = computeThumbKey(srcPath) || crypto.randomUUID();
      const previewPath = path.join(THUMB_DIR, `${key}@preview.webp`);
      if (!fs.existsSync(previewPath)) {
        await sharpLib(srcPath).rotate().resize(1600, 1600, { fit: "inside", withoutEnlargement: true })
          .webp({ quality: 86 }).toFile(previewPath);
      }
      const buf = fs.readFileSync(previewPath);
      return {
        ok: true, mime: "image/webp", base64: buf.toString("base64"),
        downscaled: true, originalSize: st.size, limit: MAX_IMAGE_BYTES,
      };
    } catch { /* 降采样失败 → 落到下面的如实报错 */ }
  }
  return { ok: false, error: "图片超过回传上限", tooLarge: true, size: st.size, limit: MAX_IMAGE_BYTES };
}

/** id → 真实文件路径（覆盖三类外部来源）。DB 内的 id 返回 null。 */
function resolvePathById(id) {
  if (id.startsWith("gen_")) return resolveGeneratedPath(id);
  if (id.startsWith("builtin_")) return resolveBuiltinPath(id);
  if (id.startsWith("medlib_")) return resolveMediaLibPath(id);
  return null;
}

/**
 * 用 ffmpeg 从视频里抽一帧当缩略图，落到 _thumbnails/ 缓存。
 *
 * 两段式：ffmpeg 先出 PNG（各平台 ffmpeg 都保证支持），再由 sharp 转 webp；
 * sharp 缺席时直接留 PNG 用 —— 少见，但别让功能整个消失（所以 mime 要跟着走）。
 * 抽帧点先试 0.5s（避开片头黑帧），短视频抽不到就退回第 0 帧。
 *
 * @returns {Promise<{path: string, mime: string}|null>}
 */
async function videoFrame(srcPath, size) {
  if (!ffmpegPath) return null;
  const key = computeThumbKey(srcPath) || crypto.randomUUID();
  const pngPath = path.join(THUMB_DIR, `${key}.frame.png`);
  const webpPath = path.join(THUMB_DIR, `${key}.webp`);
  const vf = `scale=${size}:${size}:force_original_aspect_ratio=decrease`;
  const grab = (ss) => spawnSync(ffmpegPath, [
    "-y", "-v", "error", "-ss", String(ss), "-i", srcPath,
    "-frames:v", "1", "-vf", vf, pngPath,
  ], { timeout: 20000, windowsHide: true });
  try {
    fs.mkdirSync(THUMB_DIR, { recursive: true });
    let r = grab(0.5);
    if (r.status !== 0 || !fs.existsSync(pngPath)) r = grab(0);
    if (r.status !== 0 || !fs.existsSync(pngPath)) return null;
    if (!sharpLib) return { path: pngPath, mime: "image/png" };
    await sharpLib(pngPath).webp({ quality: 82 }).toFile(webpPath);
    try { fs.unlinkSync(pngPath); } catch { /* 清理失败无妨，下次覆盖 */ }
    return { path: webpPath, mime: "image/webp" };
  } catch { return null; }
}

/**
 * 用系统默认程序打开一个文件（视频 → 默认播放器，图片 → 默认看图器）。
 *
 * 为什么用 explorer.exe 而不是 powershell 或 cmd：
 *   explorer.exe 在 System32，任何 PATH 都在，且不需要引号游戏。
 *   实测（2026-09-24）从受管服务里 spawn("powershell") 什么也没发生 ——
 *   powershell 不在这个进程的 PATH 里，而 spawn 的失败是**异步**的，
 *   上一版因此返回了假的 ok:true（点了没反应就是这个原因）。
 *   现在一律 spawnSync 并如实上报。
 *
 * 只接受**服务端自己解析出来的**绝对路径 —— 路径绝不能从客户端传进来，
 * 否则这两个路由就成了任意程序启动器。
 *
 * @returns {{ok: boolean, via?: string, code?: number, error?: string}}
 */
function openWithSystemDefault(filePath) {
  const attempts = process.platform === "win32"
    ? [
        { bin: "explorer.exe", args: [filePath] },
        { bin: "cmd.exe", args: ["/c", "start", "", filePath] },
      ]
    : process.platform === "darwin"
      ? [{ bin: "open", args: [filePath] }]
      : [{ bin: "xdg-open", args: [filePath] }];
  let lastErr = "";
  for (const a of attempts) {
    let r;
    try {
      r = spawnSync(a.bin, a.args, { timeout: 8000, windowsHide: true });
    } catch (e) {
      lastErr = `${a.bin}: ${String(e?.message || e).slice(0, 160)}`;
      continue;
    }
    if (!r.error) {
      // explorer.exe 成功时也常常返回非 0，所以判定标准是「没抛 spawn 错误」；
      // 但把 code 一并回上去，以后真出问题时能看出来。
      return { ok: true, via: a.bin, code: r.status };
    }
    lastErr = `${a.bin}: ${String(r.error?.message || r.error).slice(0, 160)}`;
  }
  return { ok: false, error: lastErr || "未找到可用的启动器" };
}

/**
 * 「打开所在文件夹，并把它顶到前台」—— 整件事一次 PowerShell 全包。
 *
 * 为什么要这么绕：
 * 1) Windows 有前台锁（当年防弹窗骚扰的机制），后台进程调起的窗口只能落在最下面。
 *    实测每次 explorer /select, 都真的开了窗（我数到过 19 个），但它们全堆在 Hana 后面
 *    —— 用户看到的就是「点了没反应」。
 *    破法：AttachThreadInput 把自己的线程接到当前前台线程的输入队列上，
 *    借到前台权限后再 SetForegroundWindow（这是绕前台锁的标准做法）。
 * 2) explorer /select, 每调一次就新开一个窗口，点十次堆十个。
 *    所以先找这个目录已有的窗口：找到就只置前，不再开新的。
 *
 * 输出协议（Node 侧按行解析）：
 *   REUSED focused / REUSED unfocused         已有窗口，置前 / 未置前
 *   OPENED focused / OPENED unfocused / OPENED no-window
 *   ERR-addtype / ERR-nofile
 */
const REVEAL_PS_LINES = [
  "$ErrorActionPreference='Stop'",
  'try {',
  '  Add-Type -Namespace HanaFg -Name Win -MemberDefinition @\'',
  '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);',
  '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);',
  '[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);',
  '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
  '[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr pid);',
  '[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();',
  '[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);',
  "'@",
  "} catch { 'ERR-addtype'; exit 3 }",
  '$file = $env:HANA_GALLERY_REVEAL_FILE',
  '$dir = $env:HANA_GALLERY_REVEAL_DIR',
  "if (-not $file -or -not $dir) { 'ERR-nofile'; exit 4 }",
  '$want = $dir.Replace([char]92, "/")',
  '$sh = New-Object -ComObject Shell.Application',
  'function Find-Target {',
  '  foreach ($w in @($sh.Windows())) {',
  '    try {',
  '      $u = [System.Uri]::UnescapeDataString([string]$w.LocationURL)',
  '      if ($u -like "*$want") { return $w }',
  '    } catch { }',
  '  }',
  '  return $null',
  '}',
  'function Set-Front($w) {',
  '  $h = [IntPtr]$w.HWND',
  '  $fg = [HanaFg.Win]::GetForegroundWindow()',
  '  $fgT = [HanaFg.Win]::GetWindowThreadProcessId($fg, [IntPtr]::Zero)',
  '  $myT = [HanaFg.Win]::GetCurrentThreadId()',
  '  [void][HanaFg.Win]::AttachThreadInput($myT, $fgT, $true)',
  '  [void][HanaFg.Win]::ShowWindow($h, 9)',   // 9 = SW_RESTORE
  '  [void][HanaFg.Win]::BringWindowToTop($h)',
  '  $ok = [HanaFg.Win]::SetForegroundWindow($h)',
  '  [void][HanaFg.Win]::AttachThreadInput($myT, $fgT, $false)',
  '  return $ok',
  '}',
  '$win = Find-Target',
  'if ($win) {',
  "  if (Set-Front $win) { 'REUSED focused' } else { 'REUSED unfocused' }",
  '  exit 0',
  '}',
  "Start-Process -FilePath 'explorer.exe' -ArgumentList '/select,', $file",
  'for ($i = 0; $i -lt 8 -and -not $win; $i++) {',
  '  Start-Sleep -Milliseconds 350',
  '  $win = Find-Target',
  '}',
  "if (-not $win) { 'OPENED no-window'; exit 0 }",
  "if (Set-Front $win) { 'OPENED focused' } else { 'OPENED unfocused' }",
];
const REVEAL_PS_B64 = Buffer.from(REVEAL_PS_LINES.join("\r\n"), "utf16le").toString("base64");

/**
 * 找 PowerShell 的绝对路径。
 * 不靠 PATH —— 受管服务进程的 PATH 是宿主白名单，裸名 `powershell` 实测调不起来。
 */
function findPowershell() {
  const root = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  const p = path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return fs.existsSync(p) ? p : "powershell.exe";
}

/**
 * 在系统文件管理器里定位到某个文件（打开所在文件夹并选中），并把窗口顶到前台。
 * 只收服务端解析出来的路径。返回 { ok, via, mode, focused, detail }。
 *
 * PowerShell 跑不通时（被拦/不在）退回直接 explorer /select,：窗口能开出来，
 * 但会落在 Hana 后面 —— 如实报 focused:false，不假报成功。
 */
function revealInExplorer(filePath) {
  if (process.platform !== "win32") return openWithSystemDefault(path.dirname(filePath));
  const dir = path.dirname(filePath);
  let out = "";
  let err = "";
  try {
    const r = spawnSync(
      findPowershell(),
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", REVEAL_PS_B64],
      {
        timeout: 25000,
        windowsHide: true,
        encoding: "utf8",
        env: { ...process.env, HANA_GALLERY_REVEAL_FILE: filePath, HANA_GALLERY_REVEAL_DIR: dir },
      },
    );
    out = String(r.stdout || "").trim();
    err = r.error ? String(r.error.message) : "";
  } catch (e) {
    err = String(e?.message || e);
  }

  const m = out.match(/\b(REUSED|OPENED)\b[ \t]*(focused|unfocused|no-window)?/);
  if (m) {
    return {
      ok: true,
      via: "powershell+explorer",
      mode: m[1].toLowerCase(),
      focused: m[2] === "focused",
      detail: out.slice(0, 160),
    };
  }

  const detail = (out || err || "no-output").slice(0, 160);
  try {
    const r2 = spawnSync("explorer.exe", ["/select,", filePath], { timeout: 8000 });
    if (r2.error) return { ok: false, error: `${detail} / explorer: ${String(r2.error.message).slice(0, 120)}` };
    return { ok: true, via: "explorer.exe", mode: "fallback", focused: false, detail };
  } catch (e) {
    return { ok: false, error: `${detail} / ${String(e?.message || e).slice(0, 120)}` };
  }
}

/* ═══════ 语义向量（embedding）═══════
 *
 * 为什么绕开宿主契约：`app/models.infer` 的 stream 是给对话用的，而且它的标识符
 * 校验（^[A-Za-z0-9._:-]{1,128}$）会把 `BAAI/bge-m3` 这种带斜杠的 embedding 模型名拒掉。
 * 所以这里**由图库服务直连 provider 的 /embeddings**，key 从 HANA_HOME 里读
 * （provider-catalog.json / models.json）—— 跟表情包插件的做法一致，不重复问用户要 key。
 *
 * 向量不进 sqlite：几万个 float 塞进库只会拖慢一切。单独一个二进制文件（Float32）
 * 配一个 meta.json（id / 文本指纹 / 模型 / 维度），内存里算余弦，不引 FAISS。
 */
const VECTORS_BIN = path.join(DATA_DIR, "_vectors.bin");
const VECTORS_META = path.join(DATA_DIR, "_vectors.meta.json");

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return null; }
}

/** 从 HANA_HOME 认出可用的 embedding 候选（只报有没有 key，绝不回传 key 本身）。 */
function discoverEmbedCandidates() {
  const models = readJsonSafe(path.join(HANA_HOME, "models.json"));
  const catalog = readJsonSafe(path.join(HANA_HOME, "provider-catalog.json"));
  const providers = models?.providers || {};
  const out = [];
  for (const [pid, pv] of Object.entries(providers)) {
    const list = Array.isArray(pv?.models) ? pv.models : [];
    for (const m of list) {
      const id = String(m?.id || m?.model || "");
      // 认名字：带 bge/embed/gte/m3 的当 embedding；带 rerank 的一律排除（它不是 embedding）。
      if (!/bge|embed|gte-|m3/i.test(id) || /rerank/i.test(id)) continue;
      const key = String(catalog?.providers?.[pid]?.api_key || pv?.apiKey || "").trim();
      const base = String(catalog?.providers?.[pid]?.base_url || pv?.baseUrl || "").trim();
      out.push({
        providerId: pid,
        model: id,
        name: String(m?.name || id),
        baseUrl: base,
        hasKey: !!key,
      });
    }
  }
  return out;
}

/** 解析出真正要用的 { baseUrl, apiKey, model, dimensions }。 */
function resolveEmbedApi(cfg) {
  const c = cfg || readConfig().embed || {};
  if (c.source === "custom") {
    return {
      baseUrl: String(c.baseUrl || ""),
      // 盘上的 apiKey 永远是空串 —— 真正的 key 在内存副本里。
      apiKey: _embedKeyOverride || String(c.apiKey || ""),
      model: String(c.model || ""),
      dimensions: Number(c.dimensions) || 1024,
    };
  }
  const pid = String(c.providerId || "siliconflow");
  const catalog = readJsonSafe(path.join(HANA_HOME, "provider-catalog.json"));
  const models = readJsonSafe(path.join(HANA_HOME, "models.json"));
  const pv = models?.providers?.[pid] || {};
  return {
    baseUrl: String(catalog?.providers?.[pid]?.base_url || pv?.baseUrl || ""),
    apiKey: String(catalog?.providers?.[pid]?.api_key || pv?.apiKey || ""),
    model: String(c.model || ""),
    dimensions: Number(c.dimensions) || 1024,
  };
}

/** 调一次 /embeddings。批量传，但调用方要控制每批大小。 */
async function embedTexts(texts, cfg) {
  const list = (Array.isArray(texts) ? texts : [texts]).map((t) => String(t ?? "").slice(0, 4000));
  if (!list.length) return { ok: true, vectors: [] };
  const { baseUrl, apiKey, model } = resolveEmbedApi(cfg);
  if (!baseUrl || !apiKey || !model) {
    return { ok: false, error: "embedding 配置不完整（缺 baseUrl / apiKey / model）" };
  }
  if (typeof fetch !== "function") return { ok: false, error: "当前运行时没有 fetch" };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const resp = await fetch(`${baseUrl.replace(/\/+$/, "")}/embeddings`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, input: list }),
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      return { ok: false, error: `Embedding API HTTP ${resp.status}: ${String(t).slice(0, 200)}` };
    }
    const data = await resp.json();
    const arr = Array.isArray(data?.data) ? data.data : [];
    const vectors = arr.map((d) => (Array.isArray(d?.embedding) ? d.embedding : null)).filter(Boolean);
    if (vectors.length !== list.length) {
      return { ok: false, error: `返回向量数不匹配（要 ${list.length} 得 ${vectors.length}）` };
    }
    return { ok: true, vectors };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

/** 向量缓存：{ dims, ids:[], hashes:[], mat: Float32Array } */
let _vecCache = null;

function loadVectors(force = false) {
  if (_vecCache && !force) return _vecCache;
  const meta = readJsonSafe(VECTORS_META);
  if (!meta || !Array.isArray(meta.ids) || !meta.ids.length) { _vecCache = null; return null; }
  try {
    const buf = fs.readFileSync(VECTORS_BIN);
    const dims = Number(meta.dims) || 1024;
    const n = meta.ids.length;
    if (buf.length < n * dims * 4) return null;
    const mat = new Float32Array(buf.buffer, buf.byteOffset, n * dims);
    _vecCache = { dims, ids: meta.ids, hashes: meta.hashes || [], model: meta.model || "", mat };
    return _vecCache;
  } catch { return null; }
}

/** 归一化（写盘前做一次，搜索时就只是点积）。 */
function normalizeVec(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  const n = Math.sqrt(s) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

/** 余弦 top-K。入库前归一化过，所以点积就是余弦。 */
function vectorTopK(queryVec, k) {
  const cache = loadVectors();
  if (!cache) return [];
  const { dims, ids, mat } = cache;
  if (queryVec.length !== dims) return [];
  const q = normalizeVec(queryVec);
  const scored = [];
  for (let r = 0; r < ids.length; r++) {
    const off = r * dims;
    let dot = 0;
    for (let i = 0; i < dims; i++) dot += mat[off + i] * q[i];
    scored.push({ id: ids[r], score: dot });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.min(200, Math.max(1, k)));
}

/** 一张图要拿去算向量的文本：文件名 + 模型写的描述 + 标签。 */
function imageEmbedText(row) {
  const base = String(row.filename || "").replace(/\.[^.]+$/, "").replace(/[_.-]+/g, " ");
  return [base, String(row.description || ""), String(row.tagtext || "")].filter(Boolean).join("\n").slice(0, 2000);
}

/** 文本指纹：描述/标签改了才知道该重建哪几条。 */
function textHash(s) {
  return crypto.createHash("sha256").update(String(s)).digest("hex").slice(0, 16);
}

/** 后台建索引任务（服务内跑，UI 轮询 /embed/build/status 看进度）。 */
let _embedJob = null;

async function runEmbedBuild(cfg) {
  const rows = q(`SELECT i.id, i.filename, i.description,
                         (SELECT GROUP_CONCAT(t.name, ' ') FROM image_tags it
                            JOIN tags t ON t.id = it.tag_id WHERE it.image_id = i.id) AS tagtext
                    FROM images i WHERE i.hidden = 0 AND i.path NOT LIKE 'ext:%'`);
  const total = rows.length;
  const job = _embedJob = {
    running: true, total, done: 0, failed: 0, skipped: 0,
    startedAt: Date.now(), finishedAt: null, error: "", cancel: false,
  };

  const prev = loadVectors(true);
  const prevIndex = new Map();
  if (prev) prev.ids.forEach((id, i) => prevIndex.set(id, i));
  const meta = prev ? { dims: prev.dims, ids: prev.ids.slice(), hashes: prev.hashes.slice(), model: prev.model } : { dims: 0, ids: [], hashes: [], model: "" };
  const keep = [];   // 保留下来的旧向量（Float32Array）

  const BATCH = 24;
  let dims = meta.dims;

  // 先处理「无需重建」的：文本指纹没变的旧向量直接留用。
  const todo = [];
  for (const r of rows) {
    const text = imageEmbedText(r);
    const h = textHash(text);
    const pi = prevIndex.get(r.id);
    if (prev && pi != null && prev.hashes[pi] === h) {
      keep.push({ id: r.id, hash: h, vec: prev.mat.subarray(pi * prev.dims, (pi + 1) * prev.dims) });
      job.skipped++;
      job.done++;
    } else {
      todo.push({ id: r.id, hash: h, text });
    }
  }

  const fresh = [];
  for (let i = 0; i < todo.length; i += BATCH) {
    if (job.cancel) { job.error = "已中止"; break; }
    const chunk = todo.slice(i, i + BATCH);
    const r = await embedTexts(chunk.map((c) => c.text), cfg);
    if (!r.ok) { job.error = r.error; job.failed += chunk.length; break; }
    for (let j = 0; j < chunk.length; j++) {
      const v = r.vectors[j];
      if (!dims) dims = v.length;
      if (v.length !== dims) { job.failed++; continue; }
      fresh.push({ id: chunk[j].id, hash: chunk[j].hash, vec: normalizeVec(v) });
    }
    job.done += chunk.length;
    job.updatedAt = Date.now();
  }

  // 写盘：保留的 + 新的（旧的没进 keep 也没进 fresh 的等价于被丢弃）
  const all = keep.concat(fresh).filter((x) => x.vec && x.vec.length === dims);
  try {
    const buf = Buffer.alloc(all.length * dims * 4);
    all.forEach((x, r) => { for (let c = 0; c < dims; c++) buf.writeFloatLE(x.vec[c], (r * dims + c) * 4); });
    fs.writeFileSync(VECTORS_BIN, buf);
    fs.writeFileSync(VECTORS_META, JSON.stringify({
      model: resolveEmbedApi(cfg).model, dims,
      builtAt: new Date().toISOString(),
      ids: all.map((x) => x.id), hashes: all.map((x) => x.hash),
    }));
    _vecCache = null;
  } catch (e) {
    job.error = `写向量文件失败: ${String(e?.message || e)}`;
  }

  job.running = false;
  job.finishedAt = Date.now();
  job.indexed = all.length;
  job.dims = dims;
  return job;
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

/**
 * 增量扫描的全局节流。
 *
 * 面板每次打开都会在 800ms 后自动来一次「增量刷新」，落在 /scan 的默认目录上。
 * 早先的节流写在前端 sessionStorage 里 —— 而**每个新窗口的 sessionStorage 都是空的**，
 * 于是「每次打开都跑一遍」。6000 张的库一次 0.7s；几万张就是几秒到几十秒，
 * 而且扫描是同步 IO，跑起来整段压住服务，面板首屏的缩略图就全排在后面。
 * 放到服务端才是对的：它知道“刚扫过”，而且是全局的。
 */
const SCAN_THROTTLE_MS = 60000;
let lastScanAt = 0;

/** 扫描循环里每处理多少个文件就让出一次事件循环（见 /scan）。 */
const SCAN_YIELD_EVERY = 200;

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
      : (() => {
          // 默认扫「配置里所有该看的目录」：scanPaths ∪ galleryRoot。
          // 旧实现是 scanPaths 非空就忽略 galleryRoot —— 于是「图库根目录」其实从没被扫过，
          // 往根目录里新放的图永远不会自己出现（要等下一次扫描）。
          const set = [];
          for (const p of [...(cfg.scanPaths || []), cfg.galleryRoot]) {
            const t = String(p || "").trim();
            if (t && !set.includes(t) && fs.existsSync(t)) set.push(t);
          }
          return set.length ? set : [cfg.galleryRoot];
        })();
    const started = Date.now();
    let imported = 0, skipped = 0, failed = 0, scanned = 0, updated = 0;
    const walkStats = { videosSkipped: 0 };
    const errors = [];

    // 全局节流：不带显式路径的扫描就是「面板自己来刷新的那种」，刚扫过就直接跳过。
    // 显式路径（工具调用 / 用户手输目录）不节流 —— 那是真有人要看结果；force 同理。
    if (!explicit.length && body.force !== true && Date.now() - lastScanAt < SCAN_THROTTLE_MS) {
      return {
        ok: true, status: "ok", skipped: true,
        reason: "刚扫过",
        sinceLastScanMs: Date.now() - lastScanAt,
        summary: { scanned: 0, imported: 0, updated: 0, skipped: 0, failed: 0, videosSkipped: 0, duration_ms: Date.now() - started, targets },
        errors: [],
      };
    }
    // 先占位：两个请求同时进来时不会双双开扫。
    lastScanAt = Date.now();

    // 增量：先把「路径 → 已知记录」整表读进内存，用于零成本跳过未变文件。
    // 旧实现对每个文件都 hashFile —— 6004 张的库每次扫描要把整个库读一遍，
    // 所以「面板一打开就自动刷新」在旧实现下根本不可行。
    const known = new Map();
    for (const r of q("SELECT id, path, size_bytes, mtime_ms FROM images")) {
      if (r.path && !String(r.path).startsWith("ext:")) known.set(String(r.path), r);
    }

    for (const target of targets) {
      if (!fs.existsSync(target)) { errors.push({ path: target, error: "目录不存在" }); continue; }
      const files = walkImages(target, 200000, body.showVideo === true, walkStats);
      scanned += files.length;
      let sinceYield = 0;
      for (const file of files) {
        // 每 200 个文件把事件循环让出去一次。
        //
        // 这一段是同步 IO（statSync / readFileSync），而它正好跑在「面板首屏刚渲染完、
        // 缩略图正一张张进来」的时间窗里 —— 不让出的话所有 HTTP 请求整段排在它后面，
        // 用户看到的就是「打开图库要转圈好久」。让出去以后扫描总时长几乎不变，
        // 但中间的空档足够把缩略图和搜索伺候完。
        if (++sinceYield >= SCAN_YIELD_EVERY) {
          sinceYield = 0;
          await new Promise((r) => setImmediate(r));
        }
        try {
          const st = fs.statSync(file);
          const prev = known.get(file);
          // ① 已知且未变 → 跳过。
          //
          //    这里**绝不写盘**。曾经为了给旧库补 mtime_ms，对每个未变文件也 UPDATE 一次，
          //    实测 5748 行 = **79.8 秒**（每条 UPDATE 各自一次事务提交/fsync）；
          //    而同一批文件在“零写入”下只要 **0.43 秒**。差的是写入，不是读盘。
          //
          //    没有 mtime_ms 的旧行（升级前入库的）只比 size 就算「未变」，也不回填 ——
          //    代价是「同 size 的内容替换」在它们身上会漏判；等它们真变了（size 变）
          //    会被 UPDATE 一次，从那以后就有 mtime 了。
          if (prev) {
            const unchanged = prev.mtime_ms != null
              ? (`${prev.size_bytes}:${prev.mtime_ms}` === `${st.size}:${Math.round(st.mtimeMs)}`)
              : (Number(prev.size_bytes) === st.size);
            if (unchanged) { skipped++; continue; }
          }

          const hash = hashFile(file);   // 只有新增或变化的文件走到这里
          // ② 路径已知但内容变了 → 原地更新，**保留 id 与已打的标签**
          if (prev) {
            const dup = q1("SELECT id FROM images WHERE file_hash = ? AND id <> ?", [hash, prev.id]);
            if (dup) { run("DELETE FROM images WHERE id = ?", [prev.id]); skipped++; continue; }
            const ex = await readExif(file);
            run(`UPDATE images SET file_hash = ?, size_bytes = ?, mtime_ms = ?, width = ?, height = ?,
                 date_taken = ?, date_modified = ?, camera_make = ?, camera_model = ? WHERE id = ?`, [
              hash, st.size, Math.round(st.mtimeMs),
              ex.width ?? null, ex.height ?? null,
              ex.date_taken || st.mtime.toISOString(), st.mtime.toISOString(),
              ex.camera_make ?? null, ex.camera_model ?? null, prev.id,
            ]);
            updated++;
            continue;
          }
          // ③ 内容已存在（同一张图换个位置）→ 去重跳过
          if (q1("SELECT id FROM images WHERE file_hash = ?", [hash])) { skipped++; continue; }

          const ex = await readExif(file);
          const now = new Date().toISOString();
          run(`INSERT INTO images (id, file_hash, path, filename, ext, size_bytes, width, height,
               date_taken, date_imported, date_modified, camera_make, camera_model, thumbnail_path, hidden, source_path, mtime_ms)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)`, [
            crypto.randomUUID(), hash, file, path.basename(file),
            path.extname(file).toLowerCase().replace(".", ""), st.size,
            ex.width ?? null, ex.height ?? null,
            ex.date_taken || st.mtime.toISOString(), now, st.mtime.toISOString(),
            ex.camera_make ?? null, ex.camera_model ?? null,
            null,   // thumbnail_path：首次入库尚未生成
            target, // source_path（存归一化路径，与 v1 一致，便于移除目录时清理）
            Math.round(st.mtimeMs),
          ]);
          imported++;
        } catch (e) {
          failed++;
          if (errors.length < 10) errors.push({ file, error: String(e?.message || e).slice(0, 150) });
        }
      }
    }
    return { ok: true, summary: { scanned, imported, updated, skipped, failed, videosSkipped: walkStats.videosSkipped, duration_ms: Date.now() - started, targets }, errors };
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

    // 只看视频（🎬 按钮的真语义 —— 不是「包含视频」，因为图片太多了）。
    if (body.videoOnly === true) {
      const vids = [...VIDEO_EXTS].map((e) => e.slice(1));
      conds.push(`ext IN (${vids.map(() => "?").join(",")})`);
      params.push(...vids);
    }

    // 按目录过滤（文件夹维度）。用前缀匹配但要防住「<root>\a 命中 <root>\ab」，
    // 所以同时接受「正好等于」与「后面跟一个分隔符」两种。
    if (body.folder) {
      const f = String(body.folder).replace(/[\\/]+$/, "");
      conds.push("(path = ? OR path LIKE ? OR path LIKE ?)");
      params.push(f, f + "\\%", f + "/%");
    }

    // 未分类：一条标签都没打过。注意「☆ 收藏」也是一条标签，收藏过的就不算未分类了 ——
    // 对“把没归过类的东西倒出来处理”这个用途来说，这个口径是对的。
    if (body.uncategorized === true) {
      conds.push("id NOT IN (SELECT image_id FROM image_tags)");
    }

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
      if (body.videoOnly === true) all = all.filter((x) => x.media_type === "video");
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
    const rows = q(`SELECT id, filename, ext, path, size_bytes, width, height, date_taken, date_imported, thumbnail_path, description, ai_name
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
    if (body.showGenerated !== false && !body.tag && !body.ratio && !body.folder && offset === 0) {
      const pick = { includeVideo: body.showVideo === true, keyword: body.keyword || "" };
      const gen = listGenerated({ ...pick, sources: body.generatedSources || null });
      const builtin = listBuiltin({ ...pick, sources: body.builtinSources || null });
      const medlib = listMediaLib(pick);
      const seen = new Set(rows.map((r) => r.path));
      let extra = gen.concat(builtin, medlib).filter((g) => !seen.has(g.path));
      // 只看视频时，这三个来源也得过同一道筛。
      if (body.videoOnly === true) extra = extra.filter((g) => g.media_type === "video");
      extra.sort(SORT_CMP[String(body.sort || "date_desc")] || SORT_CMP.date_desc);
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
    // 用户拖出来的手动顺序（标签栏用它排前面）。不在表里的排后面，按名字。
    order: readConfig().tagOrder || [],
    // 「未分类」入口的计数：一条标签都没打过的入库图片。与直接请求
    // /search?uncategorized=true 同口径，省一次往返。
    uncategorized: q1(`SELECT COUNT(*) AS c FROM images WHERE hidden = 0
                       AND id NOT IN (SELECT image_id FROM image_tags)`)?.c ?? 0,
  }),

  /**
   * 标签增删。入参三种形式（可叠加）：
   *   · 单张  { id, tags: [...] }
   *   · 批量  { ids: [...], tags: [...] }
   *   · 整目录 { folder, tags: [...] }   ← 「一整个文件夹分类」落在服务端
   *
   * 为什么整目录要在服务端展开：前端手里只有当前页的 id，让它自己凑 ids 会在
   * 分页/筛选下漏掉大部分图片 —— 这种“看起来干了其实没干完”最难受。
   */
  "/tags": async (_req, body) => {
    let ids = Array.isArray(body.ids)
      ? body.ids.map(String)
      : (body.id || body.imageId ? [String(body.id || body.imageId)] : []);
    const folder = String(body.folder || "").trim();
    if (!ids.length && folder) {
      const f = folder.replace(/[\\/]+$/, "");
      ids = q("SELECT id FROM images WHERE hidden = 0 AND (path = ? OR path LIKE ? OR path LIKE ?)",
        [f, f + "\\%", f + "/%"]).map((r) => r.id);
    }
    if (!ids.length) return { ok: false, status: "error", error: "missing id / ids / folder" };

    const names = (Array.isArray(body.tags) ? body.tags : [body.tags])
      .map((s) => String(s || "").trim()).filter(Boolean);
    if (!names.length) return { ok: false, status: "error", error: "missing tags" };
    const remove = body.action === "remove";

    // 标签名先各查一次，避免在图片循环里反复 INSERT OR IGNORE。
    const tagIds = [];
    for (const name of names) {
      if (remove) {
        const t = q1("SELECT id FROM tags WHERE name = ?", [name]);
        if (t) tagIds.push(t.id);
        continue;
      }
      run("INSERT OR IGNORE INTO tags (name) VALUES (?)", [name]);
      const t = q1("SELECT id FROM tags WHERE name = ?", [name]);
      if (t) tagIds.push(t.id);
    }

    let changed = 0;
    for (const id of ids) {
      for (const tid of tagIds) {
        if (remove) run("DELETE FROM image_tags WHERE image_id = ? AND tag_id = ?", [id, tid]);
        else run("INSERT OR IGNORE INTO image_tags (image_id, tag_id) VALUES (?, ?)", [id, tid]);
      }
      changed++;
    }
    return { ok: true, status: "ok", images: changed, tags: tagIds.length };
  },

  /**
   * 清掉没有任何图片引用的空标签。
   *
   * 删图、或把某个标签从最后一张图上移除之后，`tags` 里会留下计数为 0 的空壳，
   * 标签列表里看着很脏。这是纯维护动作，不碰图片。
   */
  "/tags/prune": async () => {
    const before = q1("SELECT COUNT(*) AS c FROM tags")?.c ?? 0;
    run("DELETE FROM tags WHERE id NOT IN (SELECT DISTINCT tag_id FROM image_tags)");
    const after = q1("SELECT COUNT(*) AS c FROM tags")?.c ?? 0;
    return { ok: true, status: "ok", removed: before - after, left: after };
  },

  /**
   * 失效记录检测：库里记着、磁盘上已经没有的文件。
   *
   * 文件被移走/改名后，旧记录不会自己消失（增量扫描只走现有文件），
   * 越积越多，点开是空的。这里只报告、不删 —— 先让用户看到数字再决定。
   * 每条都 existsSync 一遍：六千多张在本地盘上是毫秒级，不值得为它缓存什么。
   */
  "/missing": async (_req, body) => {
    const limit = Math.min(200, Math.max(1, Number(body.limit) || 50));
    const rows = q("SELECT id, path, filename FROM images WHERE hidden = 0 AND path NOT LIKE 'ext:%'");
    const missing = [];
    for (const r of rows) {
      const p = String(r.path || "");
      if (!p || fs.existsSync(p)) continue;
      missing.push({ id: r.id, path: p, filename: r.filename });
    }
    return {
      ok: true,
      status: "ok",
      checked: rows.length,
      missing: missing.length,
      samples: missing.slice(0, limit),
      truncated: missing.length > limit,
    };
  },

  /**
   * 清理失效记录。**只删索引记录与它的缩略图缓存，绝不动磁盘**（源文件已经不在了）。
   * 文件只是被移走的话，重新扫描会以新路径重新入库 —— 所以这一步是可逆的。
   */
  "/missing/purge": async () => {
    const rows = q("SELECT id, path, thumbnail_path FROM images WHERE hidden = 0 AND path NOT LIKE 'ext:%'");
    let removed = 0;
    let thumbs = 0;
    for (const r of rows) {
      const p = String(r.path || "");
      if (!p || fs.existsSync(p)) continue;
      if (r.thumbnail_path) { try { fs.unlinkSync(r.thumbnail_path); thumbs++; } catch { /* 已不在 */ } }
      run("DELETE FROM image_tags WHERE image_id = ?", [r.id]);
      run("DELETE FROM images WHERE id = ?", [r.id]);
      removed++;
    }
    return { ok: true, status: "ok", removed, thumbs };
  },

  /**
   * 识图用的「小图」：把原图缩到 ≤1024px 的 webp，回 base64。
   *
   * 为什么不回原图：宿主模型的视觉输入**只收 base64 字节**（不收路径、不收 URL），
   * 一张 11MB 的 PNG base64 之后是 15MB 字符串 —— 走 HTTP 转一遍纯属自虐。
   * 1024px webp 大约 100-200KB，识图足够。
   * 视频一律拒：sharp 读不了，识图也只做图片。
   */
  "/ai/preview": async (_req, body) => {
    const id = String(body.id || "");
    const img = q1("SELECT path, ext FROM images WHERE id = ?", [id]);
    const fp = img?.path ? String(img.path) : resolvePathById(id);
    if (!fp) return { ok: false, status: "error", error: "图片不存在" };
    if (String(fp).startsWith("ext:")) return { ok: false, status: "error", error: "外链不能识图（模型只收字节）" };
    if (!fs.existsSync(fp)) return { ok: false, status: "error", error: "源文件不存在" };
    const ext = String(img?.ext || path.extname(fp)).replace(/^\./, "").toLowerCase();
    if (VIDEO_EXTS.has(ext)) return { ok: false, status: "error", error: "视频不支持识图" };
    if (!sharpLib) return { ok: false, status: "error", error: "sharp 不可用，无法生成预览图" };
    const max = Math.min(1536, Math.max(256, Number(body.maxSize) || 1024));
    try {
      const buf = await sharpLib(fp, { animated: false })
        .rotate()
        .resize({ width: max, height: max, fit: "inside", withoutEnlargement: true })
        .webp({ quality: 82 })
        .toBuffer();
      return { ok: true, status: "ok", base64: buf.toString("base64"), mime: "image/webp", bytes: buf.length };
    } catch (e) {
      return { ok: false, status: "error", error: `生成预览失败：${String(e?.message || e).slice(0, 160)}` };
    }
  },

  /**
   * 写入识图结果：描述 + 标签。
   *
   * 描述进 images.description —— FTS 靠触发器自动跟着走（见 openDb 里的迁移）。
   * 标签走与 /tags 同一套 upsert，**只新增、不删用户自己打的标签**；
   * 重复识图会覆写 description（这就是“重跑一次”该有的行为）。
   */
  "/describe": async (_req, body) => {
    const id = String(body.id || "");
    if (!id) return { ok: false, status: "error", error: "missing id" };
    if (!q1("SELECT id FROM images WHERE id = ?", [id])) {
      return { ok: false, status: "error", error: "图片不存在" };
    }
    const desc = String(body.description || "").trim().slice(0, 4000);
    const aiName = String(body.name || "").trim().slice(0, 60);
    const clear = body.clear === true;   // clear=true：清掉识图结果（描述置 NULL，标签不动）
    if (!desc && !clear) return { ok: false, status: "error", error: "missing description" };
    const names = (Array.isArray(body.tags) ? body.tags : [body.tags])
      .map((s) => String(s || "").trim()).filter(Boolean).slice(0, 24);

    if (clear) {
      run("UPDATE images SET description = NULL, ai_name = NULL WHERE id = ?", [id]);
    } else {
      run("UPDATE images SET description = ? WHERE id = ?", [desc, id]);
      // name 只在模型真的给了的时候才写 —— 否则会把上一次的好名字冲成空。
      if (aiName) run("UPDATE images SET ai_name = ? WHERE id = ?", [aiName, id]);
    }
    let tagged = 0;
    for (const name of names) {
      run("INSERT OR IGNORE INTO tags (name) VALUES (?)", [name]);
      const t = q1("SELECT id FROM tags WHERE name = ?", [name]);
      if (t) { run("INSERT OR IGNORE INTO image_tags (image_id, tag_id) VALUES (?, ?)", [id, t.id]); tagged++; }
    }
    return { ok: true, status: "ok", id, description: clear ? "" : desc, name: clear ? "" : aiName, tags: names, tagged, cleared: clear };
  },

  /* ── 语义向量 ── */

  /** 候选 + 当前配置 + 已有索引概况（不回传 key，只说有没有）。 */
  "/embed/sources": async () => {
    const cfg = readConfig().embed || {};
    const api = resolveEmbedApi(cfg);
    const idx = loadVectors(true);
    return {
      ok: true,
      status: "ok",
      candidates: discoverEmbedCandidates(),
      config: cfg,
      resolved: {
        providerId: String(cfg.providerId || ""),
        model: api.model || "",
        baseUrl: api.baseUrl || "",
        hasKey: !!api.apiKey,
        // 自定义 key 只在内存里（不落盘），重启后就没了 —— UI 要能把这件事说出来。
        keyInMemory: !!(cfg.source === "custom" && _embedKeyOverride),
      },
      index: idx ? { count: idx.ids.length, dims: idx.dims, model: idx.model } : null,
    };
  },

  /** 连一下 /embeddings 确认真能出向量 —— 别等跑完六千张才发现 key 是错的。 */
  "/embed/test": async (_req, body) => {
    // body 里带了 key 就顺手记进内存（一次不跑两遍），但**仍然不落盘**。
    if (body?.apiKey) _embedKeyOverride = String(body.apiKey).trim();
    const cfg = (body?.providerId || body?.baseUrl || body?.model)
      ? { ...(readConfig().embed || {}), ...body }
      : (readConfig().embed || {});
    const api = resolveEmbedApi(cfg);
    if (!api.apiKey) return { ok: false, status: "error", error: "拿不到 API key（provider 未配 key，或 source=custom 却没填）" };
    const t0 = Date.now();
    const r = await embedTexts(["连接测试"], cfg);
    if (!r.ok) return { ok: false, status: "error", error: r.error };
    return { ok: true, status: "ok", dims: r.vectors[0].length, model: api.model, baseUrl: api.baseUrl, ms: Date.now() - t0 };
  },

  /** 建语义索引（后台跑，UI 轮询 status 看进度）。文本没变的旧向量直接留用。 */
  "/embed/build/start": async (_req, body) => {
    if (_embedJob?.running) return { ok: false, status: "error", error: "已经在建索引了" };
    const cfg = (body?.providerId || body?.model)
      ? { ...(readConfig().embed || {}), ...body }
      : (readConfig().embed || {});
    const api = resolveEmbedApi(cfg);
    if (!api.apiKey || !api.model) return { ok: false, status: "error", error: "embedding 配置不完整（缺 key 或 model）" };
    if (typeof fetch !== "function") return { ok: false, status: "error", error: "当前运行时没有 fetch" };
    runEmbedBuild(cfg).catch((e) => {
      if (_embedJob) { _embedJob.running = false; _embedJob.error = String(e?.message || e); }
    });
    return { ok: true, status: "ok", started: true };
  },

  "/embed/build/status": async () => {
    const idx = loadVectors();
    return {
      ok: true,
      status: "ok",
      job: _embedJob ? { ..._embedJob, cancel: undefined } : null,
      index: idx ? { count: idx.ids.length, dims: idx.dims, model: idx.model } : null,
    };
  },

  "/embed/build/cancel": async () => {
    if (!_embedJob?.running) return { ok: false, status: "error", error: "没有在跑的建索引任务" };
    _embedJob.cancel = true;
    return { ok: true, status: "ok", message: "已请求中止（当前这批跑完就停，已完成的会写盘）" };
  },

  /** 语义搜索：查词 → 向量 → 余弦 topK → 回图片行（带 tags/media_type，跟 /search 同形状）。 */
  "/embed/search": async (_req, body) => {
    const query = String(body.query || "").trim();
    if (!query) return { ok: false, status: "error", error: "missing query" };
    const cache = loadVectors();
    if (!cache?.ids.length) return { ok: false, status: "error", error: "还没有语义索引（先在设置里建一次）" };
    const t0 = Date.now();
    const r = await embedTexts([query], readConfig().embed || {});
    if (!r.ok) return { ok: false, status: "error", error: r.error };
    const minScore = Number.isFinite(Number(body.minScore)) ? Number(body.minScore) : 0.25;
    const hits = vectorTopK(r.vectors[0], Number(body.topK) || 60).filter((h) => h.score >= minScore);
    if (!hits.length) return { ok: true, status: "ok", results: [], total: 0, ms: Date.now() - t0, query };
    const rows = q(`SELECT id, filename, ext, path, size_bytes, width, height, date_taken, date_imported, thumbnail_path, description, ai_name
                    FROM images WHERE id IN (${hits.map(() => "?").join(",")})`, hits.map((h) => h.id));
    const byId = new Map(rows.map((row) => [row.id, row]));
    const results = [];
    for (const h of hits) {
      const row = byId.get(h.id);
      if (!row) continue;
      row.tags = q("SELECT t.name FROM tags t JOIN image_tags it ON t.id = it.tag_id WHERE it.image_id = ? ORDER BY t.name", [row.id]).map((x) => x.name);
      row.media_type = VIDEO_EXTS.has("." + String(row.ext).toLowerCase()) ? "video" : "image";
      row.source = String(row.path).startsWith("ext:") ? "external" : "import";
      row.favorited = row.tags.includes(FAVORITE_TAG) ? 1 : 0;
      row.score = Math.round(h.score * 1000) / 1000;
      results.push(row);
    }
    return { ok: true, status: "ok", results, total: results.length, ms: Date.now() - t0, query };
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
   *
   * 返回值里 filesRequested / filesDeleted 要能对得上：调用方（面板）必须
   * 能区分「都删了」和「库里删了、磁盘没删掉」，否则用户看到的是假成功。
   */
  "/delete": async (_req, body) => {
    const ids = Array.isArray(body.ids) ? body.ids : [body.id].filter(Boolean);
    if (!ids.length) return { ok: false, status: "error", error: "missing id" };
    let removed = 0, filesDeleted = 0, filesRequested = 0;
    const errors = [];
    for (const id of ids) {
      const img = q1("SELECT id, path, thumbnail_path FROM images WHERE id = ?", [id]);
      if (!img) continue;
      if (body.deleteFile === true && img.path && !String(img.path).startsWith("ext:")) {
        filesRequested++;
        const r = await unlinkWithRetry(img.path);
        if (r.ok) filesDeleted++;
        else errors.push({ id, filename: img.filename || "", path: img.path, error: r.error });
      }
      if (img.thumbnail_path) { try { fs.unlinkSync(img.thumbnail_path); } catch { /* 已不存在 */ } }
      run("DELETE FROM image_tags WHERE image_id = ?", [id]);
      run("DELETE FROM images WHERE id = ?", [id]);
      removed++;
    }
    return { ok: true, status: "ok", removed, filesRequested, filesDeleted, errors };
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

  /**
   * 生成（并缓存）缩略图，**直接回传缩略图字节**。
   *
   * 为什么回字节而不是回路径：只有受管服务能读 app-data 之外的文件，HTTP 层拿到
   * 路径也没法自己读；而「把缩略图路径当成图片 id 再转一次 /image」是查不到记录的
   * —— 那正是 v0.6.0 里 /thumb 必然 404 的原因（修在 http/ui.js 与这里两处）。
   *
   * 缓存 key = 源文件 (size:mtimeMs) 的 sha256 前 20 位，不再依赖 DB uuid。
   * 这样不入库的三类来源（生成图 / 内置素材 / 媒体库）也能有缩略图 —— 它们没有
   * uuid，旧实现等于把它们永久排除在缩略图之外。
   */
  "/thumb": async (_req, body) => {
    const id = String(body.id || "");
    const img = q1("SELECT id, path, thumbnail_path, ext FROM images WHERE id = ?", [id]);
    // 不入库的三类来源：id 里带前缀，解析回真实文件路径。
    const srcPath = img ? String(img.path || "") : resolvePathById(id);
    const ext = img
      ? String(img.ext || "").toLowerCase()
      : path.extname(srcPath || "").replace(".", "").toLowerCase();

    if (!srcPath) return { ok: false, error: "图片不存在", fallbackOriginal: true };
    if (srcPath.startsWith("ext:")) return { ok: false, error: "外链无缩略图", fallbackOriginal: true };
    // 视频：用 ffmpeg 抽一帧；抽不到就 noFallback —— 回退原图没有意义，
    // <img> 读不了 mp4，只会白传几十 MB。
    if (VIDEO_EXTS.has("." + ext)) {
      if (!ffmpegPath) return { ok: false, error: "未找到 ffmpeg，无法为视频生成缩略图", noFallback: true };
      const vkey = computeThumbKey(srcPath);
      const vcache = vkey ? path.join(THUMB_DIR, `${vkey}.webp`) : null;
      if (vcache && fs.existsSync(vcache)) return readThumbResponse(vcache, { cached: true });
      const frame = await videoFrame(srcPath, readConfig().thumbnailSize || 300);
      if (!frame) return { ok: false, error: "视频抽帧失败", noFallback: true, originalPath: srcPath };
      return readThumbResponse(frame.path, { cached: false, mime: frame.mime });
    }
    if (!fs.existsSync(srcPath)) return { ok: false, error: "源文件不存在", fallbackOriginal: true, originalPath: srcPath };
    if (!sharpLib) return { ok: false, error: "sharp 不可用", fallbackOriginal: true, originalPath: srcPath };

    // ① 新 key 缓存。先查它而不是先查 legacy：旧 uuid 缓存不随源文件变化，
    //    「源文件被替换」正是这轮换 key 要修的问题，不能让它继续命中旧图。
    const key = computeThumbKey(srcPath);
    const cachePath = key ? path.join(THUMB_DIR, `${key}.webp`) : null;
    if (cachePath && fs.existsSync(cachePath)) return readThumbResponse(cachePath, { cached: true });
    // ② legacy 兼容：换 key 之前按 uuid 生成的缩略图仍然可用，别白扔。
    if (img?.thumbnail_path && fs.existsSync(img.thumbnail_path)) {
      return readThumbResponse(img.thumbnail_path, { cached: true, legacyKey: true });
    }

    const size = readConfig().thumbnailSize || 300;
    fs.mkdirSync(THUMB_DIR, { recursive: true });
    const outPath = cachePath || path.join(THUMB_DIR, `${crypto.randomUUID()}.webp`);
    try {
      await sharpLib(srcPath).rotate().resize(size, size, { fit: "inside", withoutEnlargement: true })
        .webp({ quality: 82 }).toFile(outPath);
    } catch (e) {
      return { ok: false, error: `缩略图生成失败：${String(e?.message || e).slice(0, 120)}`, fallbackOriginal: true, originalPath: srcPath };
    }
    // 只有入库条目才有 thumbnail_path 可写；三类外部来源走 key 缓存命中。
    if (img) run("UPDATE images SET thumbnail_path = ? WHERE id = ?", [outPath, img.id]);
    return readThumbResponse(outPath, { cached: false });
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
      const extOf = path.extname(fp).toLowerCase().replace(".", "");
      if (st.size > MAX_IMAGE_BYTES) return oversizedImageResponse(fp, st, VIDEO_EXTS.has("." + extOf));
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
      return oversizedImageResponse(img.path, st, VIDEO_EXTS.has("." + String(img.ext).toLowerCase()));
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

  /**
   * 用系统默认程序打开（视频 → 默认播放器，图片 → 默认看图器）。
   *
   * 为什么不在 App 内播放：受管服务只能把文件字节 base64 回传，受 MAX_IMAGE_BYTES
   * 限制（卡在宿主 4MB 响应上限内）—— 拿它做视频流是错的。几十 MB 的片子交给
   * 系统播放器，既不占内存也不卡界面。
   *
   * 安全：只收 id，路径完全由服务端解析。客户端传路径进来的口子一个不能开。
   */
  "/open": async (_req, body) => {
    const id = String(body.id || "");
    const img = q1("SELECT path FROM images WHERE id = ?", [id]);
    const fp = img ? String(img.path || "") : resolvePathById(id);
    if (!fp) return { ok: false, error: "图片不存在" };
    if (fp.startsWith("ext:")) return { ok: false, error: "外链请直接打开链接", external: true, url: fp.slice(4) };
    if (!fs.existsSync(fp)) return { ok: false, error: "源文件不存在" };
    const r = openWithSystemDefault(fp);
    return r.ok
      ? { ok: true, status: "ok", opened: path.basename(fp), via: r.via, code: r.code }
      : { ok: false, error: r.error };
  },

  /**
   * 在系统文件管理器中定位文件（打开所在文件夹并选中）。同样只收 id。
   * 这是 QQ 留言里「图库还需要能直接打开图片和视频所在的文件夹」那条。
   */
  "/reveal": async (_req, body) => {
    const id = String(body.id || "");
    const img = q1("SELECT path FROM images WHERE id = ?", [id]);
    const fp = img ? String(img.path || "") : resolvePathById(id);
    if (!fp) return { ok: false, error: "图片不存在" };
    if (fp.startsWith("ext:")) return { ok: false, error: "外链没有本地文件夹" };
    if (!fs.existsSync(fp)) return { ok: false, error: "源文件不存在" };
    const r = revealInExplorer(fp);
    // mode/focused 要传回前端：前端靠 focused 决定说「已置前」还是「得 Alt+Tab」。
    return r.ok
      ? { ok: true, status: "ok", via: r.via, mode: r.mode || "", focused: !!r.focused, detail: r.detail || "" }
      : { ok: false, error: r.error };
  },

  /**
   * 目录列表（文件夹维度）。
   * 不入库的三类来源不算 —— 它们不属于用户的图片目录结构。
   */
  "/folders": async () => {
    const rows = q("SELECT path FROM images WHERE hidden = 0 AND path NOT LIKE 'ext:%'");
    const map = new Map();
    for (const r of rows) {
      const d = path.dirname(String(r.path));
      map.set(d, (map.get(d) || 0) + 1);
    }
    const folders = [...map.entries()]
      .map(([dir, count]) => ({ dir, count }))
      .sort((a, b) => b.count - a.count || a.dir.localeCompare(b.dir));
    return { ok: true, status: "ok", folders, total: folders.length };
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
