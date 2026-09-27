/**
 * scripts/check-library-availability.mjs
 *
 * 门禁脚本：验证 service.mjs 能正常启动 + 索引库表结构完整。
 *
 * 执行：node scripts/check-library-availability.mjs
 * 退出码：0 = 通过；非 0 = 失败（stderr 说明原因）。
 *
 * 为什么要有这个脚本
 *   service.mjs 的建表 / 迁移都在 schema.mjs 里，一旦写坏，服务起来但表不存在，
 *   面板侧的每个操作都会 500。开发时靠人肉起服务看日志太慢，
 *   于是把它做成一条命令：起临时服务、跑核心查询、清理、报退出码。
 *
 * 门禁检查项
 *   1. service.mjs 能启动到 READY_MARKER（超时 30s 判失败）
 *   2. _index.db 里 images / tags / image_tags / images_fts 都能 COUNT(*)
 *   3. 无论成败都 kill 子进程 + 删临时目录
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const SCRIPT_DIR = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const APP_ROOT = path.dirname(SCRIPT_DIR);
const SERVICE = path.join(APP_ROOT, "runtime", "service.mjs");

const READY_MARKER = "HANA_GALLERY_SERVICE_READY";
const READY_TIMEOUT_MS = 30_000;
// 挑一个不太常用的端口，避免跟宿主或其他服务冲突。
const PORT = 49817;

let tmpDir = null;
let child = null;
let passed = false;

function cleanup() {
  // 无论成败都收尾：kill 子进程 + 删临时目录
  try {
    if (child && !child.killed) {
      child.kill("SIGTERM");
      setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } }, 500).unref?.();
    }
  } catch { /* child already gone */ }
  try {
    if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch { /* ignore */ }
}

function fail(msg) {
  process.stderr.write(`check-library-availability: FAIL — ${msg}\n`);
  cleanup();
  process.exit(1);
}

function pass() {
  process.stdout.write("check-library-availability: OK\n");
  passed = true;
  cleanup();
  process.exit(0);
}

try {
  // 1. 建临时 DATA_DIR（os.tmpdir() 跨平台）
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hanako-gallery-check-"));
  process.stdout.write(`[1/4] temp dir: ${tmpDir}\n`);

  // 2. spawn service.mjs <dataDir> <port> <hanaHome>
  //    hanaHome 给一个存在的目录（临时目录本身即可），service.mjs 用它读偏好与模型配置。
  const args = [SERVICE, tmpDir, String(PORT), tmpDir];
  process.stdout.write(`[2/4] spawn: node ${args.join(" ")}\n`);
  child = spawn(process.execPath, args, {
    stdio: ["ignore", "pipe", "pipe"],
    cwd: APP_ROOT,
  });

  // 3. 等 READY_MARKER（超时 30s）
  await new Promise((resolve, reject) => {
    let stdoutBuf = "";
    let stderrBuf = "";
    const timeout = setTimeout(() => {
      reject(new Error(`service 未在 ${READY_TIMEOUT_MS / 1000}s 内启动；stdout=${stdoutBuf.slice(0, 400)}; stderr=${stderrBuf.slice(0, 400)}`));
    }, READY_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      stdoutBuf += chunk.toString();
      if (stdoutBuf.includes(READY_MARKER)) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.stderr.on("data", (chunk) => { stderrBuf += chunk.toString(); });
    child.on("error", (e) => { clearTimeout(timeout); reject(e); });
    child.on("close", (code) => {
      if (!stdoutBuf.includes(READY_MARKER)) {
        clearTimeout(timeout);
        reject(new Error(`service 提前退出 code=${code}; stdout=${stdoutBuf.slice(0, 400)}; stderr=${stderrBuf.slice(0, 400)}`));
      }
    });
  });
  process.stdout.write(`[3/4] service ready (marker seen)\n`);

  // READY_MARKER 在 server.listen 回调里打印，而 openDb 是懒加载（首次 q()/run() 时才建）。
  // 手动打一发 /tags/list 触发 openDb，确保后面查 db 时文件已经写盘。
  try {
    const base = `http://127.0.0.1:${PORT}`;
    const r = await fetch(`${base}/tags/list`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const txt = await r.text();
    process.stdout.write(`      /tags/list → HTTP ${r.status} (len=${txt.length})\n`);
  } catch (e) {
    throw new Error(`预热请求失败: ${e.message}`);
  }
  // 小幅等待一下 fsync。openDb 内部已 fs.mkdirSync，这里给一点时间让写盘完整。
  await new Promise((r) => setTimeout(r, 200));

  // 4. 打开 _index.db，跑核心查询
  const dbPath = path.join(tmpDir, "_index.db");
  if (!fs.existsSync(dbPath)) throw new Error(`数据库文件不存在: ${dbPath}`);
  const db = new DatabaseSync(dbPath);
  const tables = ["images", "tags", "image_tags", "images_fts"];
  const counts = {};
  for (const t of tables) {
    try {
      counts[t] = db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c;
    } catch (e) {
      throw new Error(`${t} 表查询失败: ${e.message}`);
    }
  }
  process.stdout.write(`[4/4] table counts: ${JSON.stringify(counts)}\n`);

  db.close();
  pass();
} catch (e) {
  fail(String(e?.message || e));
}
