# Hanako Gallery — 助手使用引导

> 插件 ID: `hanako-gallery`
> 版本: `0.5.0`（v2 App，`manifestVersion: 2`）

## 概述

图库应用管理博客写作所需的图片——收进来、管得住、用得上。图片本体留在原目录，
索引与缩略图存应用数据目录。

## 架构

```
AppHost（宿主进程）
  ctx.tools.register() × 11 个 gallery_* 工具
  ctx.routes.register() → http/ui.js
  ✗ 无出站网络   ✗ 读不到 app-data 之外文件
        │ ctx.runtime.fetch(runtimeId, ...)
        ▼
runtime/service.mjs（受管 native 服务，独立进程）
  扫描目录 / 读 EXIF / 生成缩略图 / 读图片字节
  node:sqlite 索引 + FTS5 全文检索（中文 hana_seg 分段）
```

排查任何问题先跑 `gallery_ping`——它会如实报告服务是否在线、数据库与图片目录
是否可读、sharp/exifr 是否降级。

## 数据来源

| 来源 | 入库 | 可编辑 |
|---|---|---|
| 导入的图片 | 是 | 改名 / 删除 / 加标签 |
| 生成图 | 否 | 否 |
| 内置素材 | 否 | 否 |
| 媒体库 | 否 | 否 |

后三类是**只读引用**：不入库、不建缩略图、不参与扫描去重。
`gallery_search` 默认只返回导入的图片；`keyword` 等参数对只读来源同样有效。

## 工具

| 工具 | 作用 |
|---|---|
| `gallery_ping` | 心跳检测：服务、数据库、图片目录、能力降级情况 |
| `gallery_config` | 查看/修改配置 |
| `gallery_import` | 扫描目录并导入索引（EXIF + 哈希去重） |
| `gallery_search` | 搜索：关键词（中文走全文检索）、标签、日期、扩展名，可分页 |
| `gallery_tag` | 标签：列出、添加、移除 |
| `gallery_markdown` | 生成 Markdown 引用代码 |
| `gallery_generate` | 导出静态 HTML 画廊页 |
| `gallery_export` | 导出索引（JSON 或 SQLite 快照） |
| `gallery_sync` | 同步图片到博客目录 |
| `gallery_rebuild` | 重建全文检索索引 |
| `gallery_forget` | 从索引移除记录（**不删磁盘文件**） |

## 用法

### 检查状态

```
gallery_ping
```

### 导入图片

```
gallery_import
gallery_import path="D:/Pictures/travel"
gallery_import paths=["D:/Pictures/travel", "D:/Pictures/family"]
```

不传 `path` / `paths` 时用配置里的扫描路径，再退回图库根目录。
返回扫描总数、导入数、去重跳过数、失败数与耗时。

v2 没有 `rebuild` / `concurrency` 参数——重建索引用 `gallery_rebuild`。

### 搜索

```
gallery_search keyword="京都"
gallery_search tag="夜景" limit=20 offset=0
gallery_search date_from="2025-01-01" date_to="2025-12-31"
gallery_search id="uuid-xxx"
```

参数：`keyword`、`tag`（单数）、`date_from`、`date_to`、`ext`、`limit`（默认 50）、
`offset`、`id`（传 id 时返回单张详情）。

没有 `tags` 复数形式，也没有 `include_thumbnails`——缩略图由卡片自己走 `/thumb`。

### 标签

```
gallery_tag action="list"
gallery_tag action="add" imageIds=["uuid1","uuid2"] tags=["京都","夜景"]
gallery_tag action="add" id="uuid1" tags=["京都"]
gallery_tag action="remove" imageIds=["uuid1"] tags=["京都"]
```

action 只有 `list` / `add` / `remove`。**没有 rename**——重命名标签请手动改数据库
后用 `gallery_rebuild` 重建索引。

### Markdown 引用

```
gallery_markdown id="uuid-xxx"
gallery_markdown id="uuid-xxx" alt_text="京都夜景"
gallery_markdown id="uuid-xxx" format="url"
gallery_markdown id="uuid-xxx" format="path"
gallery_markdown id="uuid-xxx" format="thumb"
gallery_markdown id="uuid-xxx" base="/img"
```

`format` 四种：`markdown` 得 `![alt](url)`、`url` 得相对地址、`path` 得本地绝对路径、
`thumb` 得缩略图路径。`base` 是 URL 前缀，不传时用配置的博客图片目录。

v2 没有 `size` 参数——缩略图用 `format="thumb"`。

### 生成 HTML 画廊页

```
gallery_generate
gallery_generate tag="京都" date_from="2025-01-01"
gallery_generate output="D:/Blog/public/gallery.html" title="京都画廊" limit=200
```

按日期分组，浏览器直接打开。不传 `output` 时落到应用数据目录的 `exports/` 下
（不写外部路径，避免权限问题）。

### 同步到博客

```
gallery_sync dry_run=true
gallery_sync
gallery_sync dest="D:/Blog/public/images/gallery"
```

只复制不移动，同名文件跳过。`dest` 不传时用配置的 `blogImagesPath`。
返回复制数、跳过数、失败数，失败会列出具体文件与错误。

**建议先 `dry_run=true` 预演**，确认路径正确再实际执行。

### 导出索引

```
gallery_export format="json"
gallery_export format="sqlite" output="D:/backup/gallery.db"
```

`sqlite` 用 `VACUUM INTO` 生成一致快照（不是直接复制运行中的数据库文件，
避免 journal 竞态）。不传 `output` 时落到 `exports/`。

### 重建索引

```
gallery_rebuild
```

索引与实际数据不一致时（手工改过数据库、外部工具写入过）用它。

### 从索引移除

```
gallery_forget id="uuid-xxx"
gallery_forget imageIds=["uuid1","uuid2"]
```

**只从索引移除记录，不删除磁盘上的图片文件。** 这是 v2 新增的工具。

## 配置

| 键 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `galleryRoot` | string | `<用户主目录>/Pictures/gallery` | 图库根目录 |
| `scanPaths` | string[] | `[]` | 扫描路径列表 |
| `thumbnailSize` | number | `300` | 缩略图宽度（px） |
| `blogImagesPath` | string | `public/images/gallery` | 博客图片目录 |
| `autoClassify` | boolean | `true` | 自动按日期分类 |

```
gallery_config
gallery_config action="set" patch={"thumbnailSize": 400}
```

配置存在应用数据目录的 `config.json`，改完立即生效，不需要重启。
v2 没有 `gallery.defaultView`——排序由卡片界面的下拉即时切换，不存默认值。

## 能力降级

服务启动时探测两项能力，`gallery_ping` 与卡片状态栏如实显示：

- **sharp 不可用** → 缩略图关闭，卡片回退显示原图
- **exifr 不可用** → 拍摄时间回退为文件修改时间，相机型号为空

## 限制

- 单张图片经 IPC 回传上限 **2.5 MB**（base64 后约 3.3 MB，卡在宿主 4 MB 响应上限内）。
  超出时 `/image` 返回 413，卡片显示占位。
- 扫描是同步串行的。图片量大时首次导入会慢；后续增量扫描只做哈希比对。

## 卡片

v2 是 App，注册一张 `gallery` card（不是 v1 的 `/gallery` 页面）。
工具名沿用 v1 的 `gallery_*`，使用习惯不变。

装上本应用后应卸载 v1 的同名插件——两者工具名冲突，v2 要求工具名全局唯一，
同时启用会有一方注册失败并显式报错。
