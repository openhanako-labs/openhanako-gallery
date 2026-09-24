/**
 * lib/model-host.mjs — AppHost 侧的「宿主模型」句柄。
 *
 * 背景：识图自动标签要让视觉模型看图说话。模型只能从这里拿：
 * 宿主契约 `app-contract/models.d.ts`（能力位 `app/models.infer`），
 * 成员 list / stream / utility / cancel。provider 的密钥、endpoint、
 * header 全部留在宿主里，插件侧看不到也不需要知道。
 *
 * 为什么要单独一个文件：http/ui.js 的默认导出只收 `app`（v1 时代留下的形状），
 * 而 tools/*.js 也拿不到 ctx。跟 runtime-host.mjs 一个套路 —— 用 module-level
 * 变量把 ctx 转一手：index.js 装载时 bindModels(ctx)，谁想用谁 import。
 *
 * 两个契约坑（都是实测来的，写在这免得下次再踩）：
 *   1. 目录条目里模型标识在 `id`，**不是** `model`；provider 是 `provider`。
 *      → 形状：{ id, name, provider, input, reasoning, contextWindow, maxTokens }
 *   2. provider/model 都要求 1-128 个 ASCII 标识符字符（^[A-Za-z0-9._:-]{1,128}$）。
 *      目录里合法存在但送进 stream 必被拒的例子：provider "新疆幻城"、
 *      model "BAAI/bge-m3"。所以选模型时必须先过滤，否则用户选了就报错。
 *
 * 还有一条致命脾气：**宿主模型层异常时会静默挂住**（实测两个不同 provider
 * 都超过 60s 无返回）。所以这里的每次调用都自带超时 + cancel，绝不裸等。
 */

import { readAppModelStream } from "../sdk/app-contract/model-stream.js";

let _ctx = null;

/** 由 index.js 在 apply 时调用，把插件 ctx 交给这一层。 */
export function bindModels(ctx) {
  _ctx = ctx;
}

/** 宿主到底给没给模型能力（没给就是 app/models.infer 没授权）。 */
export function modelsAvailable() {
  return !!(_ctx && _ctx.models && typeof _ctx.models.list === "function");
}

/** provider / model 是否满足宿主的标识符要求（不满足的送进 stream 必被拒）。 */
const ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

function pickIds(info) {
  if (!info || typeof info !== "object") return null;
  const provider = info.provider ?? info.providerId ?? info.provider_id;
  const model = info.id ?? info.model ?? info.modelId ?? info.model_id;
  if (typeof provider !== "string" || !provider) return null;
  if (typeof model !== "string" || !model) return null;
  return { provider, model };
}

export function isSendable(info) {
  const ids = pickIds(info);
  return !!ids && ID_RE.test(ids.provider) && ID_RE.test(ids.model);
}

/** 归一化成前端好用的形状（只保留送得进去的条目）。 */
export function sendableModels(models) {
  const out = [];
  for (const m of Array.isArray(models) ? models : []) {
    const ids = pickIds(m);
    if (!ids || !isSendable(m)) continue;
    if (out.some((x) => x.provider === ids.provider && x.id === ids.model)) continue;   // 目录里会重复
    out.push({
      id: ids.model,
      name: String(m.name ?? ids.model),
      provider: ids.provider,
      input: m.input ?? null,
      reasoning: !!m.reasoning,
      contextWindow: m.contextWindow ?? null,
      maxTokens: m.maxTokens ?? null,
      acceptsImage: acceptsImage(m),
    });
  }
  return out;
}

/**
 * 这个模型收不收图。
 *
 * 认不出来时返回 false —— 宁可少列一个，也不要让用户选中一个不支持的模型然后炸在半路。
 * 目录里 `input` 的形态没有强约束，所以把几种可能都看一眼。
 */
export function acceptsImage(info) {
  const input = info?.input ?? info?.inputs ?? info?.modalities;
  const hit = (v) => typeof v === "string" && /image|vision|visual|img|multimodal/i.test(v);
  if (hit(input)) return true;
  if (Array.isArray(input)) return input.some((x) => hit(x) || (x && typeof x === "object" && Object.keys(x).some(hit)));
  if (input && typeof input === "object") return Object.keys(input).some(hit) || Object.values(input).some((v) => hit(v) || v === true);
  return false;
}

/** 宿主模型目录。 */
export async function listModels() {
  if (!modelsAvailable()) {
    return { ok: false, error: "宿主没有提供模型能力（app/models.infer 未授权或宿主版本不支持）" };
  }
  try {
    const r = await _ctx.models.list();
    const models = Array.isArray(r?.models) ? r.models : [];
    return { ok: true, models };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

const newRequestId = () =>
  `gallery-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * 跑一次流式推理，把全文收起来返回。
 *
 * 超时不是「以防万一」，是必需：宿主模型层挂住时不会有任何事件回来，
 * 没有上限就是界面无限转圈。超时后必须 cancel —— 否则宿主那边可能一直挂着那次请求。
 *
 * 返回 { ok, text, usage, error, timedOut, requestId }
 */
export async function inferText({
  provider,
  model,
  messages,
  systemPrompt,
  maxTokens,
  temperature,
  timeoutMs = 90_000,
} = {}) {
  if (!modelsAvailable()) {
    return { ok: false, error: "宿主没有提供模型能力（app/models.infer 未授权）" };
  }
  if (!isSendable({ provider, id: model })) {
    return { ok: false, error: `provider/model 不满足宿主标识符要求：${provider} / ${model}` };
  }

  const requestId = newRequestId();
  let timer = null;
  let text = "";
  let usage = null;
  let streamError = null;

  try {
    const response = await Promise.race([
      _ctx.models.stream({ requestId, provider, model, messages, systemPrompt, maxTokens, temperature }),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`模型 ${Math.round(timeoutMs / 1000)}s 内没有响应`)),
          timeoutMs,
        );
      }),
    ]);

    // readAppModelStream 是宿主给的解码器，管 UTF-8 分片与终止校验，别自己 split("\n")。
    for await (const ev of readAppModelStream(response)) {
      if (ev?.type === "text-delta") text += ev.delta || "";
      else if (ev?.type === "error") streamError = ev;
      else if (ev?.type === "done") usage = ev.usage ?? null;
    }
  } catch (e) {
    const msg = String(e?.message || e);
    const timedOut = /内没有响应/.test(msg);
    try { await _ctx.models.cancel(requestId); } catch { /* 取消失败不掩盖原错误 */ }
    return { ok: false, error: msg, timedOut, requestId };
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (streamError) {
    return {
      ok: false,
      error: `${streamError.code || "stream-error"}: ${streamError.message || ""}`.trim(),
      requestId,
    };
  }
  return { ok: true, text, usage, requestId };
}
