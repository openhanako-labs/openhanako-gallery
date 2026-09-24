/**
 * lib/register-routes.mjs — 把后端路由挂到 v2 的路由 app 上。
 *
 * http/ui.js 的默认导出形状与 v1 一致（app 单参），可直接复用。
 * 公开 URL：/api/apps/hanako-gallery/routes/<子路径>
 */

import registerUi from "../http/ui.js";

export async function registerRoutes(ctx) {
  const dispose = await ctx.routes.register((app) => {
    // 把 ctx 一并传进去：http/ui.js 里的模型路由（识图自动标签）需要 ctx.models。
    // 它的默认导出原本只收 app（v1 形状），多一个可选参数不影响兼容。
    registerUi(app, ctx);
  });
  ctx.logger.info("图库后端路由已挂载", { prefix: "/api/apps/hanako-gallery/routes" });
  return dispose;
}
