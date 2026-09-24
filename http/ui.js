/**
 * http/ui.js — 卡片要调的后端路由。
 *
 * 全部转发给受管服务（只有它有文件访问权）。
 * 公开 URL 前缀：/api/apps/hanako-gallery/routes
 *
 * 路由名尽量与 v1 前端保持一致（/search /tags /config /scan /rename /delete …），
 * 这样 v1 的 gallery.html 搬过来时只需改前缀与鉴权，不必改调用点。
 *
 * 放在 http/ 而不是 routes/：v2 把顶级 routes/ 目录当成另一种路由来源，
 * 与 ctx.routes.register() 互斥 —— 两边同时存在会让整个应用装载失败。
 */

import { callService, isServiceReady } from "../lib/runtime-host.mjs";
import { listModels, sendableModels, modelsAvailable, bindModels, inferText, acceptsImage } from "../lib/model-host.mjs";

/* ── 识图（视觉模型看图 → 描述 + 标签）── */

/**
 * 提示词。要求很硬：只要一个 JSON 对象。
 *
 * 写这段的取舍：模型很乐意在 JSON 外面加一句“好的，这张图是…”或者包上
 * ```json 代码块 —— 所以解析器得宽容（见 parseDescribe），但提示词不能松，
 * 否则两条防线一起漏。
 */
const DESCRIBE_SYSTEM = [
  "你是图库的图片标注助手。看图后用简体中文给出标签、一句描述，以及一个文件名。",
  "只输出一个 JSON 对象，不要任何解释文字，不要 markdown 代码块。格式：",
  '{"tags":["标签1","标签2"],"description":"一到两句话","name":"棕色发髻少女"}',
  "name（文件名，最重要）：",
  "- 就是这张图叫什么：4-12 个字，主体优先，一眼能认出画面是什么",
  "- 不带日期、不带扩展名、不带序号；不要标点、空格、斜杠、表情符号",
  "- 不要泛词：图片、照片、二次元、头像、插画、卡通、背景 这种单独当名字等于没名字",
  "- 好例子：棕色发髻少女 / 图书馆集体合影 / 赛博朋克街景 / 白猫趴在键盘上",
  "- 看不到的（人名、地名、具体作品名）不要编",
  "标签规则：",
  "- tags 取 4-10 个，每个 2-6 个字，不要 # 号，不要重复，开头不要加「一张」「一个」这种量词",
  "- **优先复用下面给你的「已有标签」**：意思对得上就照抄一模一样的写法，别另造近义词（图书室/图书馆 这种就算重复）",
  "- 已有标签都不合适时才新建，且新建**最多 2 个**",
  "- 不要写只在画面里出现一次的具体物件（某张桌子、某个牌子的东西），除非它确实是主体",
  "description 一到两句话，客观描述画面内容与氛围。",
].join("\n");

/**
 * 从模型回包里掏出 {tags, description}。
 *
 * 宽容到什么程度：去代码围栏 → 直接 JSON.parse → 失败则正则抓第一个 {...} 再 parse。
 * 全失败就交回空结果，由调用方决定报错 —— 不在这一层报假成功。
 */
function parseDescribe(text) {
  const raw = String(text || "").trim();
  if (!raw) return { tags: [], description: "" };
  const cleaned = raw.replace(/^```[a-zA-Z]*\s*/, "").replace(/```\s*$/, "").trim();
  const tryParse = (s) => { try { return JSON.parse(s); } catch { return null; } };
  let obj = tryParse(cleaned);
  if (!obj) {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) obj = tryParse(m[0]);
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { tags: [], description: "" };
  const tags = (Array.isArray(obj.tags) ? obj.tags : [])
    .map((t) => String(t || "").trim().replace(/^#/, ""))
    .filter(Boolean)
    .slice(0, 20);
  const description = String(obj.description || obj.desc || "").trim().slice(0, 500);
  // 文件名短名：去掉不能进文件名的字符（服务端 /rename 还会再 sanitize 一道）。
  const name = String(obj.name || obj.title || "").trim().replace(/[\\/:*?"<>|\s]+/g, "").slice(0, 40);
  return { tags: [...new Set(tags)], description, name };
}

/** 把服务的 base64 图片转成 HTTP 响应。 */
function imageResponse(out) {
  if (!out?.ok) {
    const code = out?.tooLarge ? 413 : 404;
    return new Response(JSON.stringify({ ok: false, error: out?.error || "读取失败", tooLarge: !!out?.tooLarge, size: out?.size }),
      { status: code, headers: { "content-type": "application/json; charset=utf-8" } });
  }
  const buf = Buffer.from(out.base64, "base64");
  return new Response(buf, {
    status: 200,
    headers: {
      "Content-Type": out.mime || "application/octet-stream",
      "Content-Length": String(buf.length),
      "Cache-Control": "private, max-age=3600",
    },
  });
}

/** 取图统一入口：外部链接直接 302，缩略图失败则回退原图。 */
async function serveImage(id, { preferThumb = false } = {}) {
  if (preferThumb) {
    // /thumb 直接回传缩略图字节。不要改成「拿返回的路径再查 /image」——
    // 那条路必然 404：/image 是按 id 查库的，路径不是 id。
    const t = await callService("/thumb", { id });
    if (t?.ok) return imageResponse(t);
    // noFallback：服务端明确说了「别回退原图」（视频）—— 回退只会把几十 MB 的
    // mp4 当图片塞给 <img>，白传一遍还看不了。
    if (t?.noFallback) return imageResponse({ ok: false, error: t.error });
    // 其余情况（外链 / sharp 缺失 / 生成失败）→ 落到原图，由前端降级
  }
  const out = await callService("/image", { id });
  if (out?.external && out.url) {
    return new Response(null, { status: 302, headers: { Location: out.url } });
  }
  return imageResponse(out);
}

export default function (app, ctx) {
  // ctx 是可选的（v1 形状只传 app）。模型句柄已经在 index.js 里 bind 过了，
  // 这里再补一次是个保险：万一将来有人单独挂这个 app。
  if (ctx) { try { bindModels(ctx); } catch { /* 忽略 */ } }

  /** 服务健康状态（前端首屏用）。 */
  app.get("/service-status", async (c) => {
    const r = await callService("/status");
    return c.json({ ok: !!r?.ok, ready: isServiceReady(), detail: r });
  });

  app.get("/status", async (c) => {
    return c.json(await callService("/status"));
  });

  /* ── 检索 ── */
  app.get("/search", async (c) => {
    const q = c.req.query();
    const r = await callService("/search", {
      keyword: q.keyword || "",
      tag: q.tag || "",
      sort: q.sort || "date_desc",
      ratio: q.ratio || "",
      date_from: q.date_from || "",
      date_to: q.date_to || "",
      ext: q.ext || "",
      page: Number(q.page) || 1,
      pageSize: Number(q.pageSize) || Number(q.limit) || 60,
      offset: q.offset != null ? Number(q.offset) : undefined,
      limit: q.limit != null ? Number(q.limit) : undefined,
      // 下面三个必须转发：服务层用的是严格 === true / !== false 判断，
      // 丢字段等于「前端切了开关，后端永远拿到 undefined」——
      // 表现就是排序/视频开关/来源分组在 UI 里全部失灵。
      source: q.source || "",
      showVideo: q.showVideo === "true" || q.showVideo === true,
      showGenerated: q.showGenerated !== "false" && q.showGenerated !== false,
      // 只看视频 / 按目录过滤。这两个必须显式转发 —— 服务层用 === true 严格判断，
      // 丢字段就是「前端切了开关，后端永远拿到 undefined」。
      videoOnly: q.videoOnly === "true" || q.videoOnly === true,
      folder: q.folder || "",
      uncategorized: q.uncategorized === "true" || q.uncategorized === true,
    });
    return c.json(r);
  });

  /* ── 标签 ── */
  app.get("/tags", async (c) => c.json(await callService("/tags/list")));

  /** 清空标签壳（计数为 0 的标签）。 */
  app.post("/tags/prune", async (c) => c.json(await callService("/tags/prune")));

  /* ── 索引维护：失效记录 ── */
  app.post("/missing", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    return c.json(await callService("/missing", body));
  });
  app.post("/missing/purge", async (c) => c.json(await callService("/missing/purge")));

  /* ── 语义向量 ── */
  app.get("/embed/sources", async (c) => c.json(await callService("/embed/sources")));
  app.post("/embed/test", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    return c.json(await callService("/embed/test", body));
  });
  app.post("/embed/build/start", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    return c.json(await callService("/embed/build/start", body));
  });
  app.get("/embed/build/status", async (c) => c.json(await callService("/embed/build/status")));
  app.post("/embed/build/cancel", async (c) => c.json(await callService("/embed/build/cancel")));
  app.get("/embed/search", async (c) => {
    const q = c.req.query();
    return c.json(await callService("/embed/search", {
      query: q.query || q.q || "",
      topK: Number(q.topK) || 60,
      minScore: q.minScore != null ? Number(q.minScore) : undefined,
    }));
  });

  /** v1 前端格式：{ id, tags: [...], action: 'add' | 'remove' } */
  app.post("/tag", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    return c.json(await callService("/tags", body));
  });

  app.post("/tags/add", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    return c.json(await callService("/tags/add", body));
  });

  app.post("/tags/remove", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    return c.json(await callService("/tags/remove", body));
  });

  /* ── 配置 ── */
  app.get("/config", async (c) => c.json(await callService("/config/get")));

  /** 三个来源接口的 includeVideo 必须转发：服务层靠它决定 total 算不算视频，
      否则标签上的数字会和点进去看到的数量对不上。 */
  app.get("/generated/sources", async (c) => {
    const q = c.req.query();
    return c.json(await callService("/generated/sources", { includeVideo: q.includeVideo === "true" }));
  });

  /** 随宿主发布的内置素材目录（封面图库、角色卡、纹理等，只读）。 */
  app.get("/builtin/sources", async (c) => {
    const q = c.req.query();
    return c.json(await callService("/builtin/sources", { includeVideo: q.includeVideo === "true" }));
  });

  /** 集中媒体库位置（AI 生成产物落地处，从 Hana 偏好动态读取）。 */
  app.get("/media-library/sources", async (c) => {
    const q = c.req.query();
    return c.json(await callService("/media-library/sources", { includeVideo: q.includeVideo === "true" }));
  });

  app.post("/config", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    return c.json(await callService("/config/set", { patch: body || {} }));
  });

  /* ── 扫描 / 导入 ── */
  app.post("/scan", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    return c.json(await callService("/scan", body));
  });

  /** v1 兼容：前端传 { paths: [...] } 或 { path: '...' }。 */
  app.post("/import", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const paths = Array.isArray(body.paths) ? body.paths : (body.path ? [body.path] : []);
    // force 要透传：服务端用它区分「用户主动导入」与「面板开屏自动刷新」——
    // 后者会被 60s 全局节流拦住，前者不会。漏传的话手动导入会莫名没反应。
    return c.json(await callService("/scan", { paths, showVideo: body.showVideo === true, force: body.force === true }));
  });

  app.post("/rebuild", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const scan = await callService("/scan", { rebuild: true, showVideo: body.showVideo === true });
    const fts = await callService("/db/rebuild");
    return c.json({ ok: true, status: "ok", ...scan, fts: fts?.fts ?? 0 });
  });

  app.post("/import-url", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    return c.json(await callService("/import-url", body));
  });

  app.post("/add-external", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    return c.json(await callService("/add-external", body));
  });

  /* ── 编辑 ── */
  app.post("/rename", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    return c.json(await callService("/rename", body));
  });

  app.post("/delete", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    return c.json(await callService("/delete", body));
  });

  app.post("/forget", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    return c.json(await callService("/forget", body));
  });

  /** 用系统默认程序打开当前文件（视频交给默认播放器）。 */
  app.post("/open", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    return c.json(await callService("/open", body));
  });

  /** 打开所在文件夹并选中文件。 */
  app.post("/reveal", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    return c.json(await callService("/reveal", body));
  });

  /** 目录列表（文件夹维度）。 */
  app.get("/folders", async (c) => c.json(await callService("/folders")));

  /* ── 取图 ── */
  /**
   * 识图打标：小图 → 视觉模型 → 解析 JSON → 写回库（描述 + 标签）。
   *
   * 分工：取图（缩到 1024px webp）与写库都在受管服务里（它有文件权），
   * 模型调用只能在 AppHost 这一层（ctx.models 在这里）。
   */
  app.post("/ai/describe", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const id = String(body.id || "");
    if (!id) return c.json({ ok: false, error: "missing id" });
    const provider = String(body.provider || "");
    const model = String(body.model || "");
    const t0 = Date.now();

    const pv = await callService("/ai/preview", { id, maxSize: Number(body.maxSize) || 1024 });
    if (!pv?.ok) return c.json({ ok: false, error: pv?.error || "取预览图失败" });

    const hint = String(body.hint || "").trim().slice(0, 300);
    // 已有标签当词表塞进提示词 —— 这是控制「一次性标签」爆炸的关键：
    // 模型很乐意每张图造几个新词，而标签栏经不起那个（实测 3 张图就能造出 36 个）。
    // 取使用最多的前 60 个：排在前面的本来也是用户真在用的那些。
    const tl = await callService("/tags/list");
    const vocab = (Array.isArray(tl?.tags) ? tl.tags.slice() : [])
      .sort((a, b) => (b.image_count || 0) - (a.image_count || 0))
      .map((t) => t.name)
      .filter((n) => n && !n.startsWith("☆") && !n.startsWith("__"))
      .slice(0, 60);
    const ask = [
      vocab.length ? `已有标签（优先复用）：${vocab.join("、")}` : "",
      hint ? `补充要求：${hint}` : "",
      "请标注这张图。",
    ].filter(Boolean).join("\n");
    const r = await inferText({
      provider,
      model,
      systemPrompt: DESCRIBE_SYSTEM,
      maxTokens: Number(body.maxTokens) || 900,
      temperature: 0.2,
      timeoutMs: Number(body.timeoutMs) || 120_000,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: ask },
          { type: "image", data: pv.base64, mimeType: pv.mime || "image/webp" },
        ],
      }],
    });
    const ms = Date.now() - t0;
    if (!r.ok) return c.json({ ok: false, error: r.error, timedOut: !!r.timedOut, ms });

    const parsed = parseDescribe(r.text);
    if (!parsed.description && !parsed.tags.length) {
      return c.json({ ok: false, error: "模型没有回出可用的 JSON", raw: String(r.text || "").slice(0, 300), ms });
    }
    const wr = await callService("/describe", {
      id,
      description: parsed.description || "（模型只给了标签，未给描述）",
      tags: parsed.tags,
      name: parsed.name || "",     // 文件名短名：面板的「命名 / 批量命名」直接用它
    });
    if (!wr?.ok) return c.json({ ok: false, error: wr?.error || "写入失败", ms });
    return c.json({
      ok: true,
      id,
      tags: parsed.tags,
      description: parsed.description,
      name: parsed.name || "",
      ms,
      usage: r.usage || null,
      previewBytes: pv.bytes,
    });
  });

  app.get("/thumb/:id", async (c) => serveImage(c.req.param("id"), { preferThumb: true }));
  app.get("/image/:id", async (c) => serveImage(c.req.param("id")));

  /* ── 宿主模型（识图自动标签的底座） ── */

  /**
   * 模型目录。前端拿它填「用哪个模型识图」的下拉框。
   *
   * 只回送得进 stream 的条目（宿主对 provider/model 有 ASCII 标识符要求），
   * 并标出哪些收图 —— 否则用户选了 "新疆幻城" 或 "BAAI/bge-m3" 这种条目，
   * 点下去必然报错，而且他无从判断为什么。
   */
  app.get("/ai/models", async (c) => {
    const r = await listModels();
    if (!r.ok) return c.json({ ok: false, error: r.error, bound: modelsAvailable() });
    const sendable = sendableModels(r.models);
    return c.json({
      ok: true,
      total: r.models.length,
      sendableCount: sendable.length,
      vision: sendable.filter((m) => m.acceptsImage),
      all: sendable,
      // 原始形状也带几条回来：目录字段是宿主私有的 Record<string, unknown>，
      // 万一 input 的形态和预期不同，靠这个能当场看清。
      sample: r.models.slice(0, 2),
    });
  });
}
