/**
 * hanako-gallery — v2 应用入口。
 *
 * 架构：
 *
 *   ┌─ AppHost（宿主进程，Node 权限模型内）───────────────────────┐
 *   │  · ctx.tools.register()   图库工具                          │
 *   │  · ctx.routes.register()  卡片要调的后端路由                 │
 *   │  · 把要干活的请求转发给下面的服务                            │
 *   │  ✗ 读不到 app-data 之外的文件   ✗ 无出站网络                 │
 *   └────────────────────┬───────────────────────────────────────┘
 *                        │ ctx.runtime.fetch(runtimeId, ...)
 *   ┌────────────────────▼───────────────────────────────────────┐
 *   │  受管 native 服务（runtime/service.mjs，独立进程）           │
 *   │  · 扫描用户图片目录、读 EXIF、生成缩略图、读取图片字节        │
 *   │  · node:sqlite 索引库 + FTS5 全文检索（存 app-data）         │
 *   └────────────────────────────────────────────────────────────┘
 *
 * 为什么必须拆两个进程：图库的意义就是读用户的图片目录，而 AppHost
 * 读不到 app-data 之外的文件。native profile 才能读当前用户可读的文件。
 */

import fs from "node:fs";
import path from "node:path";

import { APP_ID, runtimeDataDir } from "./lib/env.mjs";
import { registerTools } from "./lib/register-tools.mjs";
import { registerRoutes } from "./lib/register-routes.mjs";
import { startService, stopService } from "./lib/runtime-host.mjs";

export const name = APP_ID;

export async function apply(ctx) {
  // 数据目录必须最先钉死：lib/env.mjs 与受管服务都按它解析路径。
  if (ctx.dataDir) process.env.HANAKO_PLUGIN_DATA = ctx.dataDir;
  const log = ctx.logger;
  const dataDir = runtimeDataDir();

  try { fs.mkdirSync(dataDir, { recursive: true }); } catch { /* ignore */ }
  log.info(`${APP_ID} loaded`, { dataDir });

  const disposers = [];

  // ── 1. 工具与路由先上线 ──
  // 它们不依赖服务；服务慢一点起来也不该让整个应用 failed。
  try {
    const off = await registerTools(ctx);
    if (typeof off === "function") disposers.push(off);
  } catch (e) {
    log.error("工具注册失败", { error: e?.message || String(e) });
  }

  try {
    const off = await registerRoutes(ctx);
    if (typeof off === "function") disposers.push(off);
  } catch (e) {
    log.error("路由注册失败", { error: e?.message || String(e) });
  }

  // ── 2. 起受管服务 ──
  // 首次装载存在「权限记账尚未落盘」的窗口，启动可能被拒；runtime-host 会在
  // 第一次真调用时自愈重试，所以这里失败不当作终态。
  const ready = await startService(ctx, { dataDir, log });
  if (ready) {
    log.info(`${APP_ID} ready`);
  } else {
    log.warn(`${APP_ID} 已加载，图库服务暂不可用 —— 首次调用时会自动重试`, {
      hint: "需要 app/runtime.execute + app/runtime.local-machine 授权（设置 → 安全 → 应用能力）。",
    });
  }

  return () => {
    for (const off of disposers) {
      try { off(); } catch { /* teardown */ }
    }
    stopService().catch(() => {});
  };
}

export default { name, apply };
