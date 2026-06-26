# Hanako Gallery — 助手使用引导

> 插件 ID: `hanako-gallery`
> 版本: `0.3.0`

## 概述

图库插件管理博客写作所需的图片——收进来、管得住、用得上。

## 可用工具

| 工具 | 功能 | 阶段 |
|------|------|------|
| `gallery_ping` | 心跳检测 + 数据库状态 | Phase 0 |
| `gallery_rebuild` | 重建数据库索引 | Phase 1 |
| `gallery_import` | 扫描目录导入新图片 | Phase 1 |
| `gallery_search` | 搜索图片 + 查看详情 | Phase 1 |
| `gallery_tag` | 标签管理（增/删/改/查） | Phase 1 |
| `gallery_config` | 查看/修改配置 | Phase 1 |
| `gallery_markdown` | 生成 Markdown 图片引用 | Phase 2 |
| `gallery_generate` | 生成 HTML 画廊页 | Phase 2 |
| `gallery_export` | 导出示引（JSON/SQLite） | Phase 3 |
| `gallery_sync` | 同步图片到博客目录 | Phase 4 |

## 基本用法

### 检查插件状态

```
gallery_ping
```

返回插件版本、数据库连接状态、当前配置。

### 导入图片

```
gallery_import path="/path/to/your/photos"
```

扫描指定目录中的图片文件（jpg/png/webp/gif/avif），读取 EXIF 日期自动分目录存储，SHA-256 去重。

选项：
- `rebuild: true` — 重新扫描图库目录重建索引
- `concurrency: 10` — 并发处理数

### 搜索图片

```
gallery_search keyword="京都"
```

搜索选项：
- `keyword` — 文件名关键词
- `tag` / `tags` — 按标签筛选
- `date_from` / `date_to` — 按日期范围
- `ext` — 文件格式筛选
- `limit` — 返回条数
- `id` — 按 ID 查看单张图片详情
- `include_thumbnails` — 是否返回缩略图路径

### 标签管理

```
gallery_tag action="list"
gallery_tag action="add" image_ids=["uuid1","uuid2"] tags=["京都","夜景"]
gallery_tag action="rename" tag="旧标签" new_name="新标签"
```

### 生成 Markdown 引用

```
gallery_markdown id="uuid-xxx"
gallery_markdown id="uuid-xxx" alt_text="京都夜景" size="thumb"
gallery_markdown id="uuid-xxx" format="url"
```

返回可直接粘贴到博客文章中的 Markdown 图片代码（`![alt](/images/gallery/xxx.jpg)`）。

格式选项：
- `markdown` — 完整 Markdown 语法（默认）
- `url` — 仅图片 URL
- `path` — 仅文件路径

### Web 界面

插件注册了一个 `/gallery` 页面（在 Hanako 面板中可访问），提供图形化的图库浏览：
- 搜索图片名称
- 按标签筛选
- 点击查看大图和详情

> ⚠️ 画廊页面的图片缩略图依赖 Hanako 运行时的文件服务端点。
> 如果重启后图片无法加载，需确认运行时是否提供 `/api/plugins/hanako-gallery/file/*` 的自动静态文件服务。

### 生成 HTML 画廊页

```
gallery_generate
gallery_generate tag="京都" date_from="2025-01-01"
gallery_generate output="D:/Blog/public/gallery.html"
```

生成独立的 HTML 画廊页面，按日期分组显示图片，支持点击查看大图。

选项：
- `tag` — 按标签筛选
- `date_from` / `date_to` — 按日期范围
- `limit` — 图片数量上限
- `output` — 输出路径（默认 gallery 根目录）

### 同步到博客

```
gallery_sync
gallery_sync dry_run=true
gallery_sync dest="D:/Projects/Blog/public/images/gallery"
```

将图库图片同步到博客目录，确保 Markdown 引用路径可访问。

### 导出索引备份

```
gallery_export format="json"
gallery_export format="sqlite" output="D:/backup/gallery.db"
```

将图库索引导出为 JSON 结构化文件或 SQLite 数据库拷贝。

### 查看/修改配置

```
gallery_config
gallery_config action="get" key="galleryRoot"
gallery_config action="set" key="thumbnailSize" value="400"
```

注意：修改配置需在 Hanako 设置中进行。

## 配置

| 配置键 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `gallery.galleryRoot` | string | `""` | 图库根目录 |
| `gallery.scanPaths` | string[] | `[]` | 扫描路径 |
| `gallery.thumbnailSize` | number | `300` | 缩略图宽度 |
| `gallery.autoClassify` | boolean | `true` | 自动按日期分类 |
| `gallery.defaultView` | string | `date` | 默认排序 |
| `gallery.blogImagesPath` | string | `public/images/gallery` | 博客图片路径 |