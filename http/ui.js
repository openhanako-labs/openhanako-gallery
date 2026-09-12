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
    const t = await callService("/thumb", { id });
    if (t?.ok) return imageResponse(await callService("/image", { id: t.path }));
    // 缩略图不可用（sharp 缺失 / 外部链接 / 视频）→ 落到原图
  }
  const out = await callService("/image", { id });
  if (out?.external && out.url) {
    return new Response(null, { status: 302, headers: { Location: out.url } });
  }
  return imageResponse(out);
}

export default function (app) {
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
    });
    return c.json(r);
  });

  /* ── 标签 ── */
  app.get("/tags", async (c) => c.json(await callService("/tags/list")));

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
    return c.json(await callService("/scan", { paths, showVideo: body.showVideo === true }));
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

  /* ── 取图 ── */
  app.get("/thumb/:id", async (c) => serveImage(c.req.param("id"), { preferThumb: true }));
  app.get("/image/:id", async (c) => serveImage(c.req.param("id")));
}
