# Hanako Gallery（v2）

图库管理应用：**目录导入 → EXIF 索引 → 标签 → 缩略图 → 全文检索 → Markdown 引用**。
图片本体留在原目录，索引库与缩略图存应用数据目录。

> 本目录由 v1 插件 `hanako-gallery` 迁移而来。旧插件是冻结的兼容层、照常工作；
> 装上本应用后建议**卸载 v1 插件** —— 两者工具同名（`gallery_*`），
> v2 要求工具名全局唯一，同时启用会有一方注册失败并显式报错。

## 架构

```
AppHost（宿主进程 · Node 权限模型内）
  · 注册 11 个 gallery_* 工具
  · 挂载 /api/apps/hanako-gallery/routes/* 路由
  · 转发请求给下面的服务
  ✗ 读不到 app-data 之外的文件   ✗ 无出站网络
        │
        │ ctx.runtime.fetch(runtimeId, ...)
        ▼
受管 native 服务（runtime/service.mjs · 独立进程）
  · 扫描用户图片目录、读 EXIF、生成缩略图、读取图片字节
  · node:sqlite 索引库 + FTS5 全文检索（存 app-data）
```

**为什么必须拆两个进程**：图库的全部意义是读用户的图片目录（默认 `<用户主目录>/Pictures/gallery`），
而 AppHost 及其一切子进程都在 Node 权限模型里，读不到 `app-data` 之外的文件。
只有 native profile 允许读当前用户可读的文件。

## 安装

1. 复制本目录到 `<HANA_HOME>/apps/hanako-gallery/`
2. 重启 Hana
3. 到扩展页的 App 分类里**批准安装**
4. 到 **设置 → 安全 → 应用能力**，开启两项授权：
   - `app/runtime.execute`
   - `app/runtime.native`

   缺任一项，服务起不来，卡片会提示"图库服务未就绪"。

## 数据位置

| 内容 | 位置 |
|---|---|
| 索引库（SQLite + FTS5） | `<HANA_HOME>/app-data/hanako-gallery/_index.db` |
| 缩略图 | `<HANA_HOME>/app-data/hanako-gallery/_thumbnails/` |
| 配置 | `<HANA_HOME>/app-data/hanako-gallery/config.json` |
| **图片本体** | **留在原目录，不移动、不复制** |

## 图片来源

| 来源 | 说明 | 入库 | 可编辑 |
|---|---|---|---|
| 导入的图片 | 扫描目录后导入 | 是 | 改名、删除、加标签 |
| 生成图 | 自动发现各种 `generated/` 目录 | 否，只读引用 | 否 |
| 内置素材 | 随宿主发布的封面图库、角色卡、纹理 | 否，只读引用 | 否 |
| 媒体库 | `OH-媒体库`，AI 生成产物落地处，位置从 Hana 偏好动态读取 | 否，只读引用 | 否 |

后三类不进库、不建缩略图、不参与扫描去重 —— 图库只把它们读出来。
卡片里它们是标签栏上的虚线标签（与用户的真实标签区分），点一下按来源过滤。
内置素材与媒体库在详情弹窗里是只读的，改名/删除/加标签按钮会灰掉。

## 工具

| 工具 | 作用 |
|---|---|
| `gallery_ping` | 心跳检测：服务、数据库、图片目录、能力降级情况。排查问题先跑这个 |
| `gallery_config` | 查看/修改配置（图库根目录、扫描路径、缩略图尺寸、博客图片目录、自动分类） |
| `gallery_import` | 扫描目录并导入索引（EXIF + 哈希去重） |
| `gallery_search` | 搜索：关键词（中文走全文检索）、标签、日期、扩展名、比例，可分页 |
| `gallery_tag` | 标签：列出、添加、移除 |
| `gallery_markdown` | 生成图片的 Markdown 引用代码。四种形式：`markdown` 得 `![alt](url)`，`url` 得相对地址，`path` 得本地绝对路径，`thumb` 得缩略图路径 |
| `gallery_generate` | 导出静态 HTML 画廊页（按日期分组，浏览器直接打开） |
| `gallery_export` | 导出图库索引：`json` 得结构化数据，`sqlite` 用 `VACUUM INTO` 出一致快照 |
| `gallery_sync` | 把库里的图片复制到目标目录（默认博客图片目录）。只复制不移动，同名跳过，支持 `dry_run` 预演 |
| `gallery_rebuild` | 重建全文检索索引 |
| `gallery_forget` | 从索引移除记录（**不删磁盘文件**） |

v2 新增（v1 没有）：`gallery_forget`、三个只读来源分组（生成图 / 内置素材 / 媒体库）、
FTS5 中文分段全文检索、卡片详情弹窗内的上一张 / 下一张翻页。

## 已知降级

服务启动时探测两项能力，结果在 `gallery_ping` 与卡片状态栏如实显示：

- **sharp 不可用** → 缩略图功能关闭，卡片回退显示原图（可能超 2.5MB 上限而显示占位）
- **exifr 不可用** → 拍摄时间回退为文件修改时间，相机型号为空

## 限制

- 单张图片经 IPC 回传上限 **2.5 MB**（base64 后约 3.3 MB，卡在宿主 4 MB 响应上限内）。
  超出时 `/image` 返回 413，卡片显示占位。
- 扫描是同步串行的。图片量大时首次导入会慢；后续增量扫描只做哈希比对，快得多。

## 开发

受管服务可以脱离 Hana 独立跑，方便验证：

```bash
node runtime/service.mjs <数据目录> <端口> <HANA_HOME>
```

启动后 stdout 会打一行就绪标记，包含端口、数据目录、sharp/exifr 能力探测结果。
服务监听 `127.0.0.1`，只在本机可访问。
