/**
 * lib/register-tools.mjs — 图库工具注册。
 *
 * 工具名沿用 v1 的 `gallery_*`，好让使用习惯不变。
 * 注意：v2 要求工具名全局唯一，所以装上本应用后应当卸载 v1 的同名插件
 * （两者同名会有一方注册失败并显式报错，不会静默）。
 *
 * 所有真正干活的操作都转发给受管服务（见 lib/runtime-host.mjs 的说明）。
 */

import { callService } from "./runtime-host.mjs";
import { listModels, sendableModels } from "./model-host.mjs";
import { text, fail, fromService } from "./tool-result.mjs";

/** 构造一个「转发给服务」的工具。 */
function serviceTool({ name, description, parameters, route, mapArgs, format }) {
  return {
    name,
    description,
    parameters,
    async execute(input = {}) {
      const payload = mapArgs ? mapArgs(input) : input;
      const r = await callService(route, payload);
      if (format) {
        const custom = format(r, input);
        if (custom) return custom;
      }
      return fromService(r);
    },
  };
}

const TOOLS = [
  /**
   * 临时探针（2026-09-24）：识图自动标签开工前，先看清宿主究竟给了哪些模型。
   * 定了之后可以拆掉 —— 或者留着当排障口（模型下拉框空的时候踢一脚就知道原因）。
   */
  {
    name: "gallery_ai_models",
    description: "列出宿主可用的模型目录，用来确认识图自动标签能用哪些模型（临时探针，排障用）。",
    parameters: { type: "object", properties: {}, required: [] },
    async execute() {
      const r = await listModels();
      if (!r.ok) return fail(r.error);
      const sendable = sendableModels(r.models);
      const vision = sendable.filter((m) => m.acceptsImage);
      const lines = [
        `目录 ${r.models.length} 条；可送 stream 的 ${sendable.length} 条；其中标为收图的 ${vision.length} 条`,
        "",
        vision.length ? "收图模型：" : "（没有识别到收图模型 —— 看下面原始条目的 input 字段）",
        ...vision.slice(0, 30).map((m) => `  ${m.provider} / ${m.id}   input=${JSON.stringify(m.input)}`),
        "",
        "前 3 条原始条目：",
        JSON.stringify(r.models.slice(0, 3), null, 2),
      ];
      return text(lines.join("\n"));
    },
  },

  /**
   * 失效记录：库里记着、磁盘上已经没有的文件。
   * 默认只报告；purge=true 才真清 —— 清理只删索引记录与缩略图缓存，不动磁盘。
   */
  {
    name: "gallery_missing",
    description: "检查图库里的失效记录（源文件已被移走或改名）。默认只报告条数与样例；purge=true 时清理这些索引记录（只删索引与缩略图缓存，磁盘文件不动，重新扫描可恢复）。",
    parameters: {
      type: "object",
      properties: {
        purge: { type: "boolean", description: "true = 真清理；不传或 false = 只报告", default: false },
        limit: { type: "number", description: "报告时最多列出几条样例（默认 10）", default: 10 },
      },
      required: [],
    },
    async execute(input = {}) {
      const check = await callService("/missing", { limit: Number(input.limit) || 10 });
      if (!check?.ok) return fail(check?.error || "检查失败");
      if (!check.missing) return text(`检查了 ${check.checked} 条记录，没有失效的。`);
      const lines = [`检查了 ${check.checked} 条，失效 ${check.missing} 条：`];
      for (const s of check.samples || []) lines.push(`  ${s.filename}`);
      if (input.purge !== true) {
        lines.push("", "（只报告。要清理请传 purge=true —— 只删索引记录与缩略图缓存，不动磁盘文件。）");
        return text(lines.join("\n"));
      }
      const p = await callService("/missing/purge");
      if (!p?.ok) return fail(p?.error || "清理失败");
      lines.push("", `已清理 ${p.removed} 条记录（顺带删了 ${p.thumbs || 0} 张缩略图缓存）；磁盘文件没动。`);
      return text(lines.join("\n"));
    },
  },

  serviceTool({
    name: "gallery_ping",
    description: "图库心跳检测。验证应用已加载、受管服务可连、数据库与图片目录可读。排查问题时先跑这个。",
    parameters: { type: "object", properties: {}, required: [] },
    route: "/status",
    format: (r) => {
      if (r?.ok === false) return fail(r.error);
      if (!r?.ok) return null;
      const db = r.db || {};
      const fsx = r.fsAccess || {};
      const cap = r.capabilities || {};
      const lines = [
        "图库状态",
        `  数据目录    ${r.dataDir}`,
        `  数据库      ${db.ok ? `可读（${db.images} 张 / ${db.tags} 个标签）` : `不可用：${db.error}`}`,
        `  图库根目录  ${fsx.ok ? `可读（${fsx.root}）` : `不可读：${fsx.error || fsx.root}`}`,
        `  缩略图      ${cap.sharp ? `sharp 可用（${cap.sharpSource === "legacy-plugin" ? "复用 v1 插件依赖" : cap.sharpSource === "app-data" ? "已搬到应用数据目录" : "包内自带"}）` : `降级（sharp 不可用：${cap.sharpError || "未安装"}）`}`,
        `  EXIF        ${cap.exifr ? `exifr 可用（${cap.exifrSource === "legacy-plugin" ? "复用 v1 插件依赖" : cap.exifrSource === "app-data" ? "已搬到应用数据目录" : "包内自带"}）` : `降级（用文件时间：${cap.exifrError || "未安装"}）`}`,
        `  扫描路径    ${(r.config?.scanPaths || []).join(", ") || "（未设置，用根目录）"}`,
      ];
      return text(lines.join("\n"));
    },
  }),

  serviceTool({
    name: "gallery_config",
    description: "查看或修改图库配置。action=list 查看当前配置，action=set 修改（传 patch 对象）。",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "set"], description: "操作类型", default: "list" },
        patch: {
          type: "object",
          description: "要修改的配置项：galleryRoot / scanPaths / thumbnailSize / blogImagesPath / ffmpegPath",
        },
      },
      required: [],
    },
    route: "/config/set",
    mapArgs: (input) => ({ patch: input.patch || {} }),
    format: (r, input) => {
      if ((input.action || "list") === "list") {
        return callService("/config/get").then((c) =>
          c?.ok ? text(JSON.stringify(c.config, null, 2)) : fail(c?.error || "读取配置失败"));
      }
      return r?.ok ? text("配置已更新：\n" + JSON.stringify(r.config, null, 2)) : fail(r?.error || "写入失败");
    },
  }),

  serviceTool({
    name: "gallery_import",
    description: "扫描图片目录并导入图库索引。自动读取 EXIF、按哈希去重。不传 path 时用配置里的扫描路径（或图库根目录）。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "要扫描的目录路径（不传则用配置的扫描路径）" },
        paths: { type: "array", items: { type: "string" }, description: "多个扫描目录" },
      },
      required: [],
    },
    route: "/scan",
    // 服务端 /scan 只读 `paths`（数组），所以这里必须把单个 path 归一化成数组。
    // 之前直接传 { path, paths } 会让 path 静默失效，回退到配置的扫描根。
    mapArgs: (input) => ({
      paths: (Array.isArray(input.paths) && input.paths.length)
        ? input.paths
        : (input.path ? [input.path] : []),
    }),
    format: (r) => {
      if (r?.ok === false) return fail(r.error);
      if (!r?.summary) return null;
      const s = r.summary;
      const out = [
        `扫描完成：共 ${s.scanned} 个文件，导入 ${s.imported}，跳过（重复）${s.skipped}，失败 ${s.failed}`,
        `耗时 ${(s.duration_ms / 1000).toFixed(1)}s`,
        `扫描目录：${(s.targets || []).join(", ")}`,
      ];
      if (r.errors?.length) {
        out.push(`\n部分错误（最多 10 条）：`);
        for (const e of r.errors) out.push(`  ${e.file || e.path}: ${e.error}`);
      }
      return text(out.join("\n"));
    },
  }),

  serviceTool({
    name: "gallery_search",
    description: "搜索图库图片。支持关键词（文件名/路径，中文走全文检索）、标签、日期范围、扩展名筛选，可分页。",
    parameters: {
      type: "object",
      properties: {
        keyword: { type: "string", description: "关键词（匹配文件名与路径）" },
        tag: { type: "string", description: "标签名称" },
        date_from: { type: "string", description: "起始日期 YYYY-MM-DD" },
        date_to: { type: "string", description: "结束日期 YYYY-MM-DD" },
        ext: { type: "string", description: "扩展名筛选，如 jpg" },
        limit: { type: "number", description: "返回条数上限", default: 50 },
        offset: { type: "number", description: "偏移量（分页）", default: 0 },
        id: { type: "string", description: "图片 ID：传此参数时返回该图片详情" },
      },
      required: [],
    },
    route: "/search",
    format: (r) => {
      if (r?.ok === false) return fail(r.error);
      if (!r?.results) return null;
      if (r.count === 0) return text(`没有匹配的图片（共 ${r.total} 条）。`);
      const lines = [`匹配 ${r.total} 张，本页 ${r.count} 张（offset ${r.offset}）：`];
      for (const i of r.results) {
        const size = i.size_bytes ? `${(i.size_bytes / 1024).toFixed(0)}KB` : "";
        const dim = i.width && i.height ? `${i.width}x${i.height}` : "";
        const tags = i.tags?.length ? ` [${i.tags.join(", ")}]` : "";
        lines.push(`  ${i.filename}  ${dim} ${size}  ${(i.date_taken || "").slice(0, 10)}${tags}`);
        lines.push(`    id=${i.id}`);
      }
      return text(lines.join("\n"));
    },
  }),

  serviceTool({
    name: "gallery_tag",
    description: "图库标签管理：列出所有标签、给图片添加/移除标签。",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "add", "remove"], description: "操作类型", default: "list" },
        id: { type: "string", description: "单个图片 ID" },
        imageIds: { type: "array", items: { type: "string" }, description: "多个图片 ID" },
        tags: { type: "array", items: { type: "string" }, description: "标签名列表" },
      },
      required: [],
    },
    route: "/tags/list",
    format: (r, input) => {
      const action = input.action || "list";
      if (action === "list") {
        return callService("/tags/list").then((t) => {
          if (!t?.ok) return fail(t?.error || "读取失败");
          if (!t.tags?.length) return text("还没有任何标签。");
          return text("标签列表：\n" + t.tags.map((x) => `  ${x.name}（${x.image_count} 张）`).join("\n"));
        });
      }
      const ids = input.imageIds?.length ? input.imageIds : (input.id ? [input.id] : []);
      if (!ids.length) return fail("需要提供 id 或 imageIds");
      if (!input.tags?.length) return fail("需要提供 tags");
      return callService(action === "add" ? "/tags/add" : "/tags/remove", { imageIds: ids, tags: input.tags })
        .then((x) => (x?.ok ? text(`已${action === "add" ? "添加" : "移除"}标签：${input.tags.join(", ")}（${ids.length} 张）`) : fail(x?.error)));
    },
  }),

  serviceTool({
    name: "gallery_rebuild",
    description: "重建全文检索索引。索引与实际数据不一致时（比如手工改过数据库）用它。",
    parameters: { type: "object", properties: {}, required: [] },
    route: "/db/rebuild",
    format: (r) => (r?.ok ? text(`索引已重建，共 ${r.fts} 条。`) : fail(r?.error)),
  }),

  serviceTool({
    name: "gallery_forget",
    description: "从图库索引中移除记录（不删除磁盘上的图片文件）。",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "单个图片 ID" },
        imageIds: { type: "array", items: { type: "string" }, description: "多个图片 ID" },
      },
      required: [],
    },
    route: "/forget",
    mapArgs: (input) => ({ imageIds: input.imageIds?.length ? input.imageIds : [input.id].filter(Boolean) }),
    format: (r) => (r?.ok ? text(`已从索引移除 ${r.removed} 条记录（磁盘文件未动）。`) : fail(r?.error)),
  }),

  serviceTool({
    name: "gallery_markdown",
    description: "生成图片的 Markdown 引用代码。format=markdown 得 ![alt](url)，url 得相对地址，path 得本地绝对路径，thumb 得缩略图路径。",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "图片 ID" },
        alt_text: { type: "string", description: "图片替代文字（默认用文件名）" },
        base: { type: "string", description: "引用的 URL 前缀（默认用配置的博客图片目录）" },
        format: { type: "string", enum: ["markdown", "url", "path", "thumb"], description: "输出形式", default: "markdown" },
      },
      required: ["id"],
    },
    route: "/markdown",
    format: (r) => (r?.ok ? text(r.text) : fail(r?.error)),
  }),

  serviceTool({
    name: "gallery_generate",
    description: "导出静态 HTML 画廊页（按日期分组，可直接用浏览器打开）。不传 output 时写到应用数据目录的 exports/ 下。",
    parameters: {
      type: "object",
      properties: {
        tag: { type: "string", description: "只包含此标签的图片" },
        date_from: { type: "string", description: "起始日期 YYYY-MM-DD" },
        date_to: { type: "string", description: "结束日期 YYYY-MM-DD" },
        ext: { type: "string", description: "扩展名筛选" },
        limit: { type: "number", description: "最多包含张数", default: 500 },
        title: { type: "string", description: "页面标题", default: "图库" },
        output: { type: "string", description: "输出文件绝对路径（不传则落到 exports/）" },
      },
      required: [],
    },
    route: "/generate",
    format: (r) => (r?.ok
      ? text([
        `已生成画廊页：${r.output}`,
        `包含 ${r.count} 张图片，${(r.bytes / 1024).toFixed(1)} KB`,
        "",
        "用浏览器直接打开即可（图片引用本地文件路径）。",
      ].join("\n"))
      : fail(r?.error)),
  }),

  serviceTool({
    name: "gallery_export",
    description: "导出图库索引。format=json 得结构化数据（含图片/标签/关联），format=sqlite 得数据库快照。",
    parameters: {
      type: "object",
      properties: {
        format: { type: "string", enum: ["json", "sqlite"], description: "导出格式", default: "json" },
        output: { type: "string", description: "输出文件绝对路径（不传则落到 exports/）" },
      },
      required: [],
    },
    route: "/export",
    format: (r) => {
      if (r?.ok === false) return fail(r.error);
      if (!r?.ok) return null;
      const head = `已导出（${r.format}）：${r.output}\n大小 ${(r.bytes / 1024).toFixed(1)} KB`;
      if (r.counts) {
        return text(`${head}\n图片 ${r.counts.images} 条，标签 ${r.counts.tags} 个，关联 ${r.counts.links} 条`);
      }
      return text(head);
    },
  }),

  serviceTool({
    name: "gallery_push",
    description: "把图库里的图片推送到目标目录（默认配置里的博客图片目录）。单向复制，不移动、不回读；同名文件跳过。建议先用 dry_run 预演。",
    parameters: {
      type: "object",
      properties: {
        dest: { type: "string", description: "目标目录绝对路径（默认用配置的 blogImagesPath）" },
        dry_run: { type: "boolean", description: "只报告将要做什么，不实际复制", default: false },
      },
      required: [],
    },
    route: "/push",
    format: (r) => {
      if (r?.ok === false) return fail(r.error);
      if (!r?.ok) return null;
      const out = [
        r.dryRun ? "【预演】未实际复制" : "推送完成",
        `目标目录：${r.dest}`,
        `共 ${r.total} 张：复制 ${r.copied}，跳过（已存在）${r.skipped}，失败 ${r.failed}`,
      ];
      if (r.errors?.length) {
        out.push("", "部分错误：");
        for (const e of r.errors) out.push(`  ${e.file}: ${e.error}`);
      }
      return text(out.join("\n"));
    },
  }),
];

/**
 * @param {object} ctx v2 App ctx
 * @returns {() => void} disposer
 */
export async function registerTools(ctx) {
  const offs = [];
  for (const tool of TOOLS) {
    try {
      const off = await ctx.tools.register(tool);
      if (typeof off === "function") offs.push(off);
    } catch (e) {
      ctx.logger.error(`工具注册失败: ${tool.name}`, { error: e?.message || String(e) });
    }
  }
  ctx.logger.info(`图库工具已注册 ${offs.length}/${TOOLS.length}`);
  return () => {
    for (const off of offs) {
      try { off(); } catch { /* teardown */ }
    }
  };
}
