/**
 * lib/runtime-host.mjs — 受管图库服务的宿主侧句柄。
 *
 * 为什么必须有这个文件：AppHost（以及它的一切子进程）跑在 Node 权限模型里，
 * **读不到 app-data 之外的任何文件**。而图库的全部意义就是读用户配置的图片目录。
 * 宿主为此提供受管运行时；本应用用 `profile: "local-machine"`：
 *
 *   · 受管进程以**当前 OS 用户权限**运行，能读到任意盘上的图片目录 —— 这正是图库要的。
 *   · 不需要任何管理员初始化，不受 HANA_HOME 路径形态影响。
 *
 * 为什么不用 `profile: "native"`（曾用过，已换掉）：
 *   Windows 上的 native 语义和 macOS/Linux 不同 —— 它给每次运行一个**不复用的专用身份**，
 *   只能读 App 安装目录、App 数据目录、以及**宿主明确授权的 readRoots**。
 *   图库要读的是用户随时改的扫描路径，拿不到这个能力；就算补齐 readRoots +
 *   app/resources.read，Windows 的 native 还需要管理员为「桌面 owner × HANA_HOME」
 *   显式跑一次 `hana-win-sandbox.exe --initialize-native-identity`，且拒绍 reparse 根。
 *   代价对比很明确：local-machine 赢得「能读用户目录」，输掉文件系统隔离。
 *
 * 所以 AppHost 只做三件事——注册工具、挂路由、把要干活的请求转发给那个服务。
 *
 * 持有 module-level 的 ctx，是为了让 tools/*.js、http/ui.js 这些拿不到 ctx
 * 的调用点能直接 callService()。
 */

import { APP_ID, SERVICE_PORT, READY_MARKER, hanakoHome } from "./env.mjs";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

/**
 * 受管服务源码的指纹（runtime/ 与 lib/ 下所有 .mjs/.js 的「路径+大小+mtime」）。
 *
 * 用途：宿主 reload **不会重启受管服务进程**（它只是重新 apply 插件），
 * 于是改完 runtime/*.mjs 再 reload，跑的依然是旧进程。
 * apply 时拿这个指纹和上次落盘的比一下，变了就先停旧服务 —— 见 index.js。
 */
export function runtimeSourceStamp() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const parts = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(mjs|js)$/.test(e.name)) continue;
      try {
        const st = fs.statSync(p);
        parts.push(`${path.relative(root, p).replace(/\\/g, "/")}:${st.size}:${Math.round(st.mtimeMs)}`);
      } catch { /* 读不到就跳过 */ }
    }
  };
  walk(path.join(root, "runtime"));
  walk(path.join(root, "lib"));
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 16);
}

/**
 * 把启动失败详情落盘（AppHost 有 app-data 写权限）。
 * 宿主的日志只打印消息字符串、丢弃 data 对象，所以排障必须自己留证据。
 */
function recordFailure(dataDir, stage, detail) {
  try {
    const file = path.join(dataDir, "_startup-error.json");
    const prev = (() => { try { return JSON.parse(fs.readFileSync(file, "utf-8")); } catch { return null; } })();
    const rec = {
      at: new Date().toISOString(),
      stage,
      detail,
      previous: prev ? { at: prev.at, stage: prev.stage, detail: prev.detail } : null,
    };
    fs.writeFileSync(file, JSON.stringify(rec, null, 2));
  } catch { /* 排障落盘失败不能反过来影响主流程 */ }
}

export const SERVICE_PORT_EXPORT = SERVICE_PORT;

/**
 * ctx.runtime.fetch 的 timeoutMs 上限。
 * 宿主管得很死：必须是 1..30000 的整数，超出直接拒。
 * 而扫描/重建索引对 5000 张图可能要几十秒 —— 所以长任务一律「提交 + 轮询」，
 * 不靠单次 fetch 长等（见 callService 的注释）。
 */
const SERVICE_FETCH_TIMEOUT_MS = 30000;

/** 启动失败后的冷却，避免失败时被轮询反复拉起进程。 */
const RETRY_COOLDOWN_MS = 30000;

/** 就绪等待超时。 */
const READY_TIMEOUT_MS = 15000;

let _ctx = null;
let _runtimeId = null;
let _startArgs = null;
let _starting = null;
let _log = { info: () => {}, warn: () => {}, error: () => {} };
let _state = "idle"; // idle | starting | ready | failed

function logInfo(msg, data) { try { _log.info(msg, data); } catch { /* ignore */ } }
function logWarn(msg, data) { try { _log.warn(msg, data); } catch { /* ignore */ } }
function logError(msg, data) { try { _log.error(msg, data); } catch { /* ignore */ } }

export function serviceState() { return _state; }
export function serviceRuntimeId() { return _runtimeId; }

/** 启动受管服务并等它就绪。 */
export async function startService(ctx, { dataDir, log } = {}) {
  _ctx = ctx;
  if (log) _log = log;
  _startArgs = { dataDir };
  return await doStart();
}

async function doStart() {
  if (!_ctx || !_startArgs) return false;
  if (_state === "ready" && _runtimeId) return true;
  if (_starting) return await _starting;
  if (_lastFailureAt && Date.now() - _lastFailureAt < RETRY_COOLDOWN_MS) return false;

  const { dataDir } = _startArgs;
  _state = "starting";
  _starting = (async () => {
    try {
      const rec = await _ctx.runtime.start({
        runtime: "node",
        entry: "runtime/service.mjs",
        // 参数走 args，不走 env —— 受管运行时的 env 也是宿主白名单。
        // 第三个参数是 HANA_HOME：让服务能定位各插件的 generated/ 目录，
        // 而不必从 dataDir 向上猜（猜法只在固定布局下成立）。
        args: [dataDir, String(SERVICE_PORT), hanakoHome()],
        profile: "local-machine",
        // local-machine 要求 app/runtime.execute + app/runtime.local-machine，
        // 并且跟 native 一样强制要 network: "external"（宿主校验原话：
        // "The cross-platform native and local-machine profiles require explicit
        // network: 'external' and its separate grant"），所以还需要 app/runtime.network。
        // 本服务实际只监听 127.0.0.1 供宿主转发，不发起任何出站请求。
        //
        // 注意：local-machine 明确拒绝 readRoots / writeRoots / callToken / taskId，
        // 所以下面不要添这些字段 —— 传了会被直接拒掉。
        network: "external",
        cwd: dataDir,
        service: { port: SERVICE_PORT, readyMarker: READY_MARKER },
      });
      _runtimeId = rec?.runtimeId ?? null;
      logInfo("图库服务已启动", { runtimeId: _runtimeId, profile: rec?.profile, port: SERVICE_PORT });
    } catch (e) {
      _state = "failed";
      _runtimeId = null;
      _lastFailureAt = Date.now();
      // 把真实错误内联进消息：宿主只打印字符串，data 对象会被丢弃。
      const detail = e?.message || String(e);
      const code = e?.code ? `[${e.code}] ` : "";
      recordFailure(dataDir, "runtime.start", { message: detail, code: e?.code ?? null, name: e?.name ?? null });
      logError(`${code}图库服务启动失败: ${detail}`, {
        error: detail,
        hint: "需要 app/runtime.execute + app/runtime.local-machine + app/runtime.network 三项授权；"
          + "local-machine 必须配 network: 'external'。",
      });
      return false;
    }

    const ok = await waitReady(READY_TIMEOUT_MS);
    _state = ok ? "ready" : "failed";
    if (!ok) {
      _lastFailureAt = Date.now();
      recordFailure(dataDir, "ready-timeout", { runtimeId: _runtimeId, timeoutMs: READY_TIMEOUT_MS });
      logError(`图库服务未在 ${Math.round(READY_TIMEOUT_MS / 1000)} 秒内就绪`, { runtimeId: _runtimeId });
    } else {
      _lastFailureAt = 0;
      try { fs.rmSync(path.join(dataDir, "_startup-error.json"), { force: true }); } catch { /* 已不存在 */ }
    }
    return ok;
  })().finally(() => { _starting = null; });

  return await _starting;
}

let _lastFailureAt = 0;

export function isServiceReady() { return _state === "ready"; }

async function waitReady(timeoutMs) {
  if (!_runtimeId || !_ctx) return false;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let rec = null;
    try { rec = await _ctx.runtime.get(_runtimeId); } catch { /* 继续重试 */ }
    if (rec?.state === "ready") return true;
    if (rec?.state === "failed" || rec?.state === "exited" || rec?.state === "stopped") {
      const out = String(rec.log || "").slice(-1500) || "(宿主未捕获到输出)";
      recordFailure(_startArgs?.dataDir || ".", "service-exited", {
        runtimeId: _runtimeId, state: rec.state, exitCode: rec.exitCode, signal: rec.signal, enforcement: rec.enforcement, output: out,
      });
      logError(`图库服务提前退出 (state=${rec.state}, exitCode=${rec.exitCode}) 输出: ${out.slice(0, 400)}`, {
        runtimeId: _runtimeId, state: rec.state, exitCode: rec.exitCode, signal: rec.signal, output: out,
      });
      return false;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

export async function stopService() {
  if (!_runtimeId || !_ctx) return;
  try {
    await _ctx.runtime.stop(_runtimeId);
    logInfo("图库服务已停止");
  } catch (e) {
    logWarn("停止图库服务失败", { error: e?.message });
  }
  _runtimeId = null;
  _state = "idle";
}

/**
 * 转发失败时，判断是否属于「runtime 已失效」。
 *
 * 宿主会在服务进程退出后报 "Managed runtime ... does not have a ready service"，
 * 而本地 _state 可能还停在 ready —— 这种时候必须重置状态、重新拉起，
 * 否则会一直拿着一个已死的 runtimeId 重试，永远不恢复。
 */
function looksLikeStaleRuntime(r) {
  const s = `${r?.error || ""} ${r?.raw || ""}`.toLowerCase();
  return s.includes("does not have a ready service")
    || s.includes("not have a ready service")
    || s.includes("runtime not found")
    || s.includes("unknown runtime")
    || s.includes("runtime_unavailable");
}

/** 标记 runtime 失效，供下次调用重新拉起。 */
function invalidateRuntime(why) {
  if (_runtimeId) logWarn(`图库服务 runtime 失效，将重新拉起: ${why}`);
  _runtimeId = null;
  _state = "idle";
  _lastFailureAt = 0;   // 立即允许重试，不走冷却
}

/**
 * 调一次服务。
 *
 * 自愈：
 *   · 装载与权限记账有窗口，首次可能被拒 → 首次真调用时补起
 *   · 服务进程可能已退出，而本地状态还停在 ready → 识别后重置并重试一次
 */
export async function callService(route, payload = {}, { timeoutMs } = {}) {
  if (!_ctx) return { ok: false, error: "gallery service unavailable（apply 尚未运行）" };

  if (_state !== "ready" || !_runtimeId) {
    const ok = await doStart();
    if (!ok) return { ok: false, error: "gallery service unavailable（启动未成功）" };
  }

  let body;
  try {
    body = JSON.stringify(payload);
  } catch (e) {
    return { ok: false, error: "payload not serializable: " + e.message };
  }

  const once = async () => {
    try {
      const res = await _ctx.runtime.fetch(_runtimeId, route, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        timeoutMs: timeoutMs || SERVICE_FETCH_TIMEOUT_MS,
      });

      // ctx.runtime.fetch 返回真正的 Response 对象，必须走 text()/json()。
      let text;
      if (typeof res === "string") text = res;
      else if (typeof res?.text === "function") text = await res.text();
      else text = String(res ?? "");

      try {
        return JSON.parse(text);
      } catch {
        return { ok: false, error: "service returned non-json", raw: String(text).slice(0, 300) };
      }
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  };

  let result = await once();

  // 首次失败且疑似 runtime 失效 → 重置后重试一次
  if (result?.ok === false && looksLikeStaleRuntime(result)) {
    invalidateRuntime(result.error || "stale runtime");
    if (await doStart()) result = await once();
  }

  return result;
}
