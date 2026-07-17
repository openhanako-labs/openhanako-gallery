# Hanako Gallery

Hanako 插件，管理博客写作所需的图片。**收进来、管得住、用得上**。

让 Agent 帮你找图、选图、生成 Markdown 引用——博客写作者的图片库管家。

## 功能

- 📥 **入库** — 扫描本地目录，读 EXIF，SHA-256 去重，按日期自动分类
- 🔍 **搜索** — 按文件名/日期/标签筛选，返回缩略图路径让 Agent 把图亮出来
- 🏷️ **标签** — 多对多标签系统，支持批量打标、重命名、合并
- 📝 **Markdown 引用** — 一键生成博客可用的图片引用代码，自动处理 Web 路径
- 🖼️ **HTML 画廊** — 按日期分组的响应式画廊页，可按标签筛选
- 📦 **备份导出** — 索引导出为 JSON 或 SQLite 文件

## 使用场景

> "帮我在图库里找一张京都的夜景照片"
> → Agent 搜出结果，把缩略图亮给你看
> → "这张不错，生成 Markdown 引用"
> → 直接粘贴到博客文章里

## 前置条件

- Node.js >= 18
- 磁盘空间预留图库大小 + 缩略图（默认 300px 宽）
- 缩略图生成依赖 sharp，首次安装需联网下载预编译二进制

## 安装

### 通过 OH-Plugins marketplace
在 Hanako 设置 → 插件市场搜索 "hanako-gallery" 一键安装。

### 手动安装
```bash
git clone https://github.com/openhanako-labs/hanako-gallery.git
# 放入 Hanako 插件目录后重启
```

## 工具清单（Agent 可调用）

### 核心

| 工具 | 用途 |
|------|------|
| `gallery_ping` | 心跳 + DB 状态 + 配置 |
| `gallery_rebuild` | 扫描目录，重建索引 |
| `gallery_import` | 从指定目录导入新图片 |
| `gallery_search` | 按文件名/标签/日期搜索，返回缩略图 |
| `gallery_tag` | 标签增删改查 |
| `gallery_config` | 查看/修改配置 |

### 输出

| 工具 | 用途 |
|------|------|
| `gallery_markdown` | 生成 Markdown 引用代码 |
| `gallery_generate` | 生成 HTML 画廊页 |
| `gallery_export` | 索引导出（JSON / SQLite） |
| `gallery_sync` | 拷贝图库到博客目录 |

## 配置

在 Hanako 设置 → hanako-gallery 可调整：

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `gallery.galleryRoot` | 空 | 图片本体存储根路径 |
| `gallery.scanPaths` | 空数组 | 哪些目录扫描入库 |
| `gallery.thumbnailSize` | 300 | 缩略图宽度（像素） |
| `gallery.autoClassify` | true | 按 EXIF 日期自动分目录 |
| `gallery.defaultView` | date | 搜索结果默认排序 |
| `gallery.blogImagesPath` | public/images/gallery | 博客图片目录相对路径 |

## 数据架构

- **图片本体**：`YYYY/MM/DD/` 自动分类，EXIF 无日期的进 `_uncategorized/`
- **缩略图**：`_thumbnails/` 平行目录，按需生成
- **索引**：`_index.db`（sql.js WASM SQLite），含 images / tags / image_tags 三张表

## 路径对齐

`blogImagesPath` 是博客项目中图片目录的**文件系统相对路径**。

Markdown 引用生成时自动处理：

- 文件系统：`public/images/gallery/2025/03/15/IMG_2847.jpg`
- Web URL：`/images/gallery/2025/03/15/IMG_2847.jpg`（自动去掉 `public/` 前缀）

博客项目可按需替换前缀（如换为 CDN 域名），图库只保证相对路径唯一且正确。

## 风险与限制

- sql.js 全量序列化写回，大库（>5000 张）批量操作会变慢，日常搜索浏览不受影响
- EXIF 日期可靠性低，分级 fallback：EXIF → 文件修改时间 → 入库时间
- 修改 `lib/` 模块后需重启 hana-server（Node.js ESM 缓存跨 reload 不清）

## 配套博客

图库与 XHBlogs（Next.js）配套使用。`gallery_sync` 工具一键把图库同步到博客目录。

## 许可

本项目采用**双重许可**：

- **开源许可**：[GNU AGPL v3](https://www.gnu.org/licenses/agpl-3.0.html) — 开源免费，但修改必须开源
- **商业许可**：闭源使用需购买商业授权，详见 [COMMERCIAL-LICENSE.md](./COMMERCIAL-LICENSE.md)