/**
 * lib/register-routes.mjs — 把后端路由挂到 v2 的路由 app 上。
 *
 * http/ui.js 的默认导出形状与 v1 一致（app 单参），可直接复用。
 * 公开 URL：/api/apps/hanako-gallery/routes/<子路径>
 */

import registerUi from "../http/ui.js";

export async function registerRoutes(ctx) {
  const dispose = await ctx.routes.register((app) => {
    registerUi(app);
  });
  ctx.logger.info("图库后端路由已挂载", { prefix: "/api/apps/hanako-gallery/routes" });
  return dispose;
}
