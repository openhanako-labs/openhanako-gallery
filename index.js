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
import { startService, stopService, runtimeSourceStamp } from "./lib/runtime-host.mjs";
import { bindModels } from "./lib/model-host.mjs";

export const name = APP_ID;

export async function apply(ctx) {
  // 数据目录必须最先钉死：lib/env.mjs 与受管服务都按它解析路径。
  if (ctx.dataDir) process.env.HANAKO_PLUGIN_DATA = ctx.dataDir;
  const log = ctx.logger;
  const dataDir = runtimeDataDir();

  try { fs.mkdirSync(dataDir, { recursive: true }); } catch { /* ignore */ }
  log.info(`${APP_ID} loaded`, { dataDir });

  const disposers = [];

  // 宿主模型（识图自动标签用）只能从 ctx 拿；绑到 module-level，
  // 好让 http/ui.js 与 tools/*.js 这些拿不到 ctx 的地方直接用。
  bindModels(ctx);

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
  // 先处理一个坑：**宿主 reload 不会重启受管服务进程**（它只是重新 apply 插件）。
  // 于是改完 runtime/*.mjs 再 reload，跑的还是旧进程 —— 这个坑今晚坑了两次
  // （明明改了、reload 了，行为却是旧的，害我怀疑自己写错）。
  // 拿源码指纹比对：变了就先停掉旧服务，再让 startService 拉起新的。
  const stamp = runtimeSourceStamp();
  const stampFile = path.join(dataDir, "_runtime-stamp.txt");
  let prevStamp = "";
  try { prevStamp = fs.readFileSync(stampFile, "utf-8").trim(); } catch { /* 首次 */ }
  if (prevStamp && prevStamp !== stamp) {
    log.info("runtime 源码有变更，先停掉旧服务再重启", { prev: prevStamp, now: stamp });
    await stopService();
  }

  // 首次装载存在「权限记账尚未落盘」的窗口，启动可能被拒；runtime-host 会在
  // 第一次真调用时自愈重试，所以这里失败不当作终态。
  //
  // **不 await**：窗口不该为了等一个受管子进程就白转圈。apply 立刻返回，
  // 卡片外壳马上出来，面板自己的「加载中…」接管；服务起来之前第一个真请求
  // 会走 callService 的自愈路径（那条路本来就在），该等的地方等，而不是整页等。
  startService(ctx, { dataDir, log })
    .then((ready) => {
      if (ready) {
        try { fs.writeFileSync(stampFile, stamp); } catch { /* ignore */ }
        log.info(`${APP_ID} ready`);
      } else {
        log.warn(`${APP_ID} 已加载，图库服务暂不可用 —— 首次调用时会自动重试`, {
          hint: "需要 app/runtime.execute + app/runtime.local-machine 授权（设置 → 安全 → 应用能力）。",
        });
      }
    })
    .catch((e) => log.error("图库服务启动异常", { error: e?.message || String(e) }));

  return () => {
    for (const off of disposers) {
      try { off(); } catch { /* teardown */ }
    }
    stopService().catch(() => {});
  };
}

export default { name, apply };
