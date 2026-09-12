/**
 * lib/env.mjs — 应用身份与路径的单一来源。
 *
 * v2 的两处硬差异在这里收敛：
 *   1) 安装目录只读 → 一切运行时写入落到 ctx.dataDir。
 *   2) ctx.dataDir 已经是本应用专属目录，不需要再 join(pluginId)。
 *
 * 注意 AppHost 的环境变量是宿主白名单（只有 PATH/HOME/TMPDIR/LANG 之类），
 * 所以目录一律从 ctx.dataDir 推导，不依赖 USERPROFILE 之类可能不存在的变量。
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

/** 应用 id：必须与 manifest.json 的 id 一致。 */
export const APP_ID = "hanako-gallery";

/** 应用包根目录（= 安装目录，只读）。'lib/env.mjs' -> '..' */
export const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 受管服务监听端口。改值前确认没有别的应用占用。 */
export const SERVICE_PORT = Number(process.env.HANA_GALLERY_SERVICE_PORT) || 43180;

/** 服务就绪标记（打在 stdout，宿主据此判定 ready）。 */
export const READY_MARKER = "HANA_GALLERY_SERVICE_READY";

/** 运行时数据目录（可写）。由 index.js 在启动任何东西之前写入 HANAKO_PLUGIN_DATA。 */
export function runtimeDataDir() {
  return process.env.HANAKO_PLUGIN_DATA
    || path.join(hanakoHome(), "app-data", APP_ID);
}

/** HANA_HOME：本应用数据目录的上两级。 */
export function hanakoHome() {
  const dataDir = process.env.HANAKO_PLUGIN_DATA;
  if (dataDir) {
    const home = path.dirname(path.dirname(dataDir));
    if (home && home !== dataDir) return home;
  }
  return process.env.HANA_HOME || path.join(process.env.USERPROFILE || "", ".hanako");
}

/**
 * v1 时代的数据目录（迁移来源）。
 *
 * 老插件的图库根目录由配置项 gallery.galleryRoot 决定（默认 D:/Pictures/gallery），
 * 而索引库就在那个目录下的 _index.db。v2 把索引库搬进 app-data，
 * 图片本体仍留在原处 —— 见 runtime/service.mjs 的说明。
 */
export function legacyDataDir() {
  return path.join(hanakoHome(), "plugin-data", APP_ID);
}

/** v1 插件的安装目录（用于读取旧配置、旧缩略图）。 */
export function legacyPluginDir() {
  return path.join(hanakoHome(), "plugins", APP_ID);
}
