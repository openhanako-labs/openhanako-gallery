/**
 * lib/tool-result.mjs — v2 工具返回值的统一构造。
 *
 * v2 的 execute 返回对象 `{ content: [...] }`，不是 v1 的字符串。
 * 失败时用 isError 让模型知道这不是正常结果。
 */

export const text = (t) => ({ content: [{ type: "text", text: String(t) }] });

export const fail = (t) => ({
  content: [{ type: "text", text: `错误：${String(t)}` }],
  isError: true,
});

/** 把服务返回的 JSON 统一成工具结果。 */
export const fromService = (r, { pretty = true } = {}) => {
  if (!r) return fail("服务无响应");
  if (r.ok === false) return fail(r.error || "未知错误");
  return text(pretty ? JSON.stringify(r, null, 2) : JSON.stringify(r));
};
