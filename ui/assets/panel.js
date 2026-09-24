/**
 * hanako-gallery v2 · 卡片前端
 *
 * 移植自 v1 pages/gallery.html 的脚本，保留全部交互，改动只有三处：
 *   1. 接口前缀：/api/plugins/hanako-gallery/api/gallery/* → /api/apps/hanako-gallery/routes/*
 *   2. 鉴权：v2 的 app_route 要 surface session，且 token 在 pathname 的
 *      /ui/_surface/<token>/ 段里，不是 query（query 名是 appSurfaceSession）。
 *      见下方 readSessionToken()。
 *   3. 修掉 v1 两处 bug（见 showDetail / render 的注释）
 *
 * 内联 onclick 需要函数挂在全局作用域：本文件用 <script type="module"> 加载，
 * module 里的函数不会自动成为 window 属性，所以尾部用 Object.assign(window, {...}) 显式挂上。
 */

(function () {
  "use strict";

  /* ── 鉴权 ─────────────────────────────────────────────── */

  var APP_ID = decodeURIComponent(location.pathname.split("/")[3] || "hanako-gallery");
  var API = "/api/apps/" + APP_ID + "/routes";

  /** 从路径或 query 里找出 surface session token。 */
  function readSessionToken() {
    // /api/apps/<id>/ui/_surface/<token>/...
    var m = /\/ui\/_surface\/([^/]+)(?:\/|$)/.exec(location.pathname);
    if (m && m[1]) { try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; } }
    // query 形式（宿主若改用 query 传）
    var q = new URL(location.href).searchParams;
    return q.get("appSurfaceSession") || q.get("token") || null;
  }

  var TOKEN = readSessionToken();

  /** 带凭证的 URL —— <img src> / <video src> 只能用这个。 */
  function apiUrl(path) {
    var url = API + path;
    if (TOKEN) url += (url.indexOf("?") >= 0 ? "&" : "?") + "appSurfaceSession=" + encodeURIComponent(TOKEN);
    return url;
  }

  /** 带凭证的 fetch。 */
  function apiFetch(path, init) {
    var opts = init || {};
    var headers = {};
    var k;
    for (k in (opts.headers || {})) headers[k] = opts.headers[k];
    if (TOKEN) headers["X-Hana-App-Surface-Session"] = TOKEN;
    opts.headers = headers;
    return fetch(apiUrl(path), opts);
  }

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  /* ── 状态 ─────────────────────────────────────────────── */

  var allImages = [], allTags = [], currentTag = "", currentKeyword = "", scanPaths = [];
  // videoOnly：🎬 的语义是「**只看**视频」，不是「把视频掺进来」——
  // 6004 张图片里混进几个视频等于没筛。导入是另一回事（见 triggerImport）。
  var videoOnly = false, timelineMode = false, masonryMode = false, listMode = false;
  // 文件夹维度：只过滤，不移动。目录列表由 /folders 提供。
  var currentFolder = "", allFolders = [];
  // 未分类：一条标签都没打过。_uncatCount 由 /tags/list 一起给（省一次往返）。
  var currentUncategorized = false, _uncatCount = 0;
  // 多选：只在 selMode 下生效；selected 当集合用（id -> true）。
  var selMode = false, selected = {};
  // 标签输入模式："image" = 只给当前这张打；"folder" = 给整目录打。
  // 模块级变量而不是参数，因为提交按钮（addGroupTag）是 HTML 里的固定 onclick。
  var _groupMode = "image";
  // currentRatio：比例筛选。v0.6.0 从 <select> 改成 pill，用状态变量而不是读 DOM。
  var currentRatio = "";
  // 无任何筛选时的总数，用来给「全部」标签显示计数。
  var _allCount = 0;
  var _page = 1, _pages = 1, _total = 0;
  var _zoom = 1, _pan = { x: 0, y: 0 }, _favState = {}, _importUrl = null;
  // 来源分组：内置素材/媒体库/生成图片不入库，靠 source 参数过滤
  var currentSource = "", sourceInfo = {};
  // 当前弹窗在看第几张（上一张/下一张用）
  var _modalIdx = -1;

  var SOURCE_GROUPS = [
    { key: "builtin",   label: "📦 内置素材" },
    { key: "media-lib", label: "🎨 媒体库" },
    { key: "generated", label: "✨ 生成图片" },
  ];

  /* ── 加载 ─────────────────────────────────────────────── */

  function debouncedSearch() {
    clearTimeout(window._st);
    window._st = setTimeout(function () {
      currentKeyword = document.getElementById("searchInput").value.trim().toLowerCase();
      _page = 1;
      load();
    }, 300);
  }

  async function load() {
    try {
      var q = "pageSize=50&page=" + _page;
      if (currentKeyword) q += "&keyword=" + encodeURIComponent(currentKeyword);
      if (currentSource) {
        // 来源分组模式：只看某一类外部来源（服务端不入库，走独立分页）。
        // 此时不再带 tag / ratio —— 它们对这三个来源无意义。
        q += "&source=" + encodeURIComponent(currentSource);
      } else {
        if (currentTag) q += "&tag=" + encodeURIComponent(currentTag);
        if (currentRatio) q += "&ratio=" + encodeURIComponent(currentRatio);
      }
      var sort = document.getElementById("sortSelect").value;
      if (sort) q += "&sort=" + encodeURIComponent(sort);
      // 只看视频：后端默认只返图片，要 showVideo + videoOnly 两个都传。
      if (videoOnly) q += "&showVideo=true&videoOnly=true";
      if (currentFolder) q += "&folder=" + encodeURIComponent(currentFolder);
      if (currentUncategorized) q += "&uncategorized=true";

      // 比例筛选只对入库图片有意义（靠 width/height 判断）。
      // 三个外部来源的 width/height 都是 0，切了也是白切，整组禁用。
      var rg = document.getElementById("ratioGroup");
      if (rg) rg.classList.toggle("is-disabled", !!currentSource);

      var r, d;
      if (semanticMode && currentKeyword) {
        // 语义检索：走向量，不看词面。失败就抛出去给下面的 catch 统一报。
        r = await apiFetch("/embed/search?query=" + encodeURIComponent(currentKeyword) + "&topK=60");
        d = await r.json();
        if (d && d.ok === false) throw new Error(d.error || "语义检索不可用");
        d = { results: d.results || [], total: d.total || 0, pages: 1, page: 1 };
      } else {
        r = await apiFetch("/search?" + q);
        d = await r.json();
      }
      allImages = d.results || [];
      _total = d.total || 0;
      _pages = d.pages || 1;
      _page = d.page || 1;
      // 没有任何筛选时，total 就是全库张数 —— 给「全部」标签当计数。
      if (!currentKeyword && !currentTag && !currentSource && !currentFolder && !currentUncategorized && !videoOnly) _allCount = _total;

      var tr = await apiFetch("/tags");
      var td = await tr.json();
      allTags = td.tags || [];
      _tagOrder = Array.isArray(td.order) ? td.order.slice() : [];
      _uncatCount = td.uncategorized || 0;
      // 必须 await：否则第一次 renderTags 拿到的是空 sourceInfo，
      // 三个来源标签的计数会漏掉（以前只显示「(数量)」，0 不显示，所以一直没暴露）。
      await refreshSourceCounts();
      renderTags();
      render();
    } catch (e) {
      document.getElementById("loading").innerHTML = "加载失败: " + e.message;
      document.getElementById("loading").style.display = "flex";
    }
  }

  /**
   * 三个外部来源各自有多少媒体文件。
   * 带上当前视频开关：标签上的数字必须等于点进去能看到的数量，
   * 否则会出“标签 54、实际 53”这种差一个的观感。
   */
  async function refreshSourceCounts() {
    // 计数总是含视频：数字不该随 🎬 开关跳动（否则标签写 54、点进去 53）。
    var v = "?includeVideo=true";
    var pairs = [
      ["/generated/sources", "generated"],
      ["/builtin/sources", "builtin"],
      ["/media-library/sources", "media-lib"],
    ];
    for (var k = 0; k < pairs.length; k++) {
      try {
        sourceInfo[pairs[k][1]] = await (await apiFetch(pairs[k][0] + v)).json();
      } catch (e) { sourceInfo[pairs[k][1]] = null; }
    }
  }

  var _tagsExpanded = false;
  var TAG_COLLAPSE_AT = 16;      // 折叠时最多显示几个（展开则全显示）
  var _tagOrder = [];            // 用户拖出来的顺序（来自 config.tagOrder）
  var _dragTag = null;

  function renderTags() {
    var bar = document.getElementById("tagbar");
    var allOn = (currentTag === "" && currentSource === "" && !currentRatio && !currentFolder && !currentUncategorized && !videoOnly) ? " active" : "";
    bar.innerHTML = '<span class="tag tag-all' + allOn + '" onclick="filterAll()">全部' +
      (_allCount ? ' <b>' + _allCount + '</b>' : '') + '</span>' +
      // 「未分类」是收件箱：没打过任何标签的图。与「全部」并存 ——
      // 「全部」保留全库含义（他定的），另行一个入口把没归过类的倒出来处理。
      '<span class="tag' + (currentUncategorized ? " active" : "") + '" onclick="filterUncategorized()" title="还没打过任何标签的图片">未分类' +
      (_uncatCount ? ' <b>' + _uncatCount + '</b>' : '') + '</span>';
    // 内置来源分组：与用户标签并排，但用不同样式区分（它们不是标签）
    SOURCE_GROUPS.forEach(function (g) {
      var info = sourceInfo[g.key] || {};
      var n = info.total || 0;
      var vids = (info.totalMedia || 0) - n;
      var el = document.createElement("span");
      el.className = "tag tag-source" + (currentSource === g.key ? " active" : "") + ((n || vids) ? " has-count" : " empty");
      el.innerHTML = g.label + (n ? ' <b>' + n + '</b>' : '');
      el.title = n
        ? g.label + "：图片 " + n + (vids ? "，另有视频 " + vids + " 个（点顶部 🎬 可看）" : " 个")
        : g.label + "：暂未发现媒体文件";
      el.onclick = function () { filterSource(g.key); };
      bar.appendChild(el);
    });

    // ── 用户标签：排序 / 长尾 / 折叠 / 拖动排序 ──
    //
    // 三层规矩，从里到外：
    //   1. 排序 —— 用户拖过的（tagOrder）排前面，其余的按名字
    //   2. 长尾 —— 默认只显示有 ≥2 张图的标签。只有 1 张图的那些就是「一次性标签」，
    //      识图一晚上能造出几十个，铺在筛选栏上就是噪音墙。
    //   3. 折叠 —— 上面两层扑克牌后还是太多，就截前 TAG_COLLAPSE_AT 个
    // 一个开关（「还有 N 个」）同时管 2 和 3，展开就把全部露出来。
    var tags = orderedTags();
    var primary = tags.filter(function (t) { return (t.image_count || 0) >= 2; });
    var base = _tagsExpanded ? tags : (primary.length ? primary : tags);
    var collapsed = !_tagsExpanded && base.length > TAG_COLLAPSE_AT;
    var activeOutside = false;
    if (collapsed && currentTag) {
      var vis = base.slice(0, TAG_COLLAPSE_AT).map(function (t) { return t.name; });
      if (vis.indexOf(currentTag) < 0) { activeOutside = true; collapsed = false; _tagsExpanded = true; }
    }
    var shown = collapsed ? base.slice(0, TAG_COLLAPSE_AT) : base;
    shown.forEach(function (t) {
      var el = document.createElement("span");
      el.className = "tag" + (currentTag === t.name && currentSource === "" ? " active" : "");
      el.innerHTML = esc(t.name) + (t.image_count ? ' <b>' + t.image_count + '</b>' : '');
      el.onclick = function () { filterTag(t.name); };
      attachTagDrag(el, t.name);
      bar.appendChild(el);
    });
    var hiddenCount = tags.length - shown.length;
    if (hiddenCount > 0 || _tagsExpanded) {
      var more = document.createElement("span");
      more.className = "tag tag-more";
      more.textContent = _tagsExpanded ? "收起 ▴" : ("还有 " + hiddenCount + " 个标签 ▾");
      more.title = _tagsExpanded
        ? "只显示常用标签（≥2 张图）"
        : ("展开全部 " + tags.length + " 个（含只有 1 张图的一次性标签）");
      more.onclick = function () { _tagsExpanded = !_tagsExpanded; renderTags(); };
      bar.appendChild(more);
    }
  }

  /**
   * 标签的拖动排序。
   *
   * 为什么用拖而不是给个排序面板：标签栏本身就是“顺序”的现场 ——
   * 要在设置里先列一遍、再上下箭头调，反而比直接拖麻烦。
   * 落盘只写顺序数组（config.tagOrder），不动标签本身。
   */
  function attachTagDrag(el, name) {
    el.draggable = true;
    el.title = "拖动可调顺序";
    el.addEventListener("dragstart", function (ev) {
      _dragTag = name;
      el.classList.add("dragging");
      try { ev.dataTransfer.setData("text/plain", name); ev.dataTransfer.effectAllowed = "move"; } catch (e) { /* 旧内核 */ }
      ev.stopPropagation();
    });
    el.addEventListener("dragend", function () {
      _dragTag = null;
      el.classList.remove("dragging");
      Array.prototype.forEach.call(document.querySelectorAll(".tag.drop-target"), function (x) { x.classList.remove("drop-target"); });
    });
    el.addEventListener("dragover", function (ev) {
      if (!_dragTag || _dragTag === name) return;
      ev.preventDefault();
      el.classList.add("drop-target");
    });
    el.addEventListener("dragleave", function () { el.classList.remove("drop-target"); });
    el.addEventListener("drop", function (ev) {
      if (!_dragTag || _dragTag === name) return;
      ev.preventDefault();
      el.classList.remove("drop-target");
      moveTagBefore(_dragTag, name);
    });
  }

  /** 按用户顺序 + 名字给标签排序（不在顺序表里的排后面）。 */
  function orderedTags() {
    var tags = allTags.slice();
    if (_tagOrder.length) {
      var pos = {};
      _tagOrder.forEach(function (n, i) { pos[n] = i; });
      tags.sort(function (a, b) {
        var pa = pos[a.name] === undefined ? Infinity : pos[a.name];
        var pb = pos[b.name] === undefined ? Infinity : pos[b.name];
        return pa !== pb ? pa - pb : a.name.localeCompare(b.name, "zh");
      });
    }
    return tags;
  }

  /** 把 from 挪到 before 前面；先把当前完整顺序固化成数组再动，免得漏掉没拖过的那些。 */
  function moveTagBefore(from, before) {
    var names = orderedTags().map(function (t) { return t.name; });
    var i = names.indexOf(from);
    if (i < 0) return;
    names.splice(i, 1);
    var j = names.indexOf(before);
    if (j < 0) j = names.length;
    names.splice(j, 0, from);
    _tagOrder = names.slice(0, 500);
    renderTags();
    apiFetch("/config", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tagOrder: _tagOrder }),
    }).catch(function () { showMsg("标签顺序没保存成功，下次打开会复原", "error"); });
  }

  function filterTag(tag) { currentSource = ""; currentUncategorized = false; currentTag = tag; _page = 1; _modalIdx = -1; load(); }
  function filterSource(src) { currentTag = ""; currentUncategorized = false; currentSource = src; _page = 1; _modalIdx = -1; load(); }
  function filterUncategorized() {
    currentUncategorized = !currentUncategorized;
    if (currentUncategorized) { currentTag = ""; currentSource = ""; }
    _page = 1; _modalIdx = -1; load();
  }
  // 「全部」就是全部：标签、来源、比例、目录、未分类一起清掉。
  function filterAll() {
    currentTag = ""; currentSource = ""; currentRatio = ""; currentFolder = ""; currentUncategorized = false;
    var sel = document.getElementById("folderSelect");
    if (sel) sel.value = "";
    syncRatioPills();
    _page = 1; _modalIdx = -1; load();
  }

  /** 按目录过滤（不移动文件，只是筛选）。 */
  function filterFolder(dir) {
    currentFolder = dir || "";
    currentSource = "";   // 目录是入库图片的维度，与三个外部来源互斥
    _page = 1; _modalIdx = -1;
    load();
  }

  /** 目录名只显示最后两段，但保留盘符 —— 否则看着像写死的相对路径。 */
  function shortDir(dir) {
    var s = String(dir);
    var root = (s.match(/^[A-Za-z]:/) || [""])[0];
    var parts = s.split(/[\\/]/).filter(Boolean);
    var tail = parts.slice(-2).join("\\");
    if (root && parts.length > 2) return root + "\\…\\" + tail;
    return tail || s;
  }

  /** 目录列表（文件夹维度）。数量可能不少，用下拉框 + 计数呈现。 */
  async function loadFolders() {
    try {
      var d = await (await apiFetch("/folders")).json();
      allFolders = d.folders || [];
      var sel = document.getElementById("folderSelect");
      if (!sel) return;
      var cur = currentFolder;
      sel.innerHTML = '<option value="">全部文件夹（' + (d.total || 0) + ' 个）</option>' +
        allFolders.map(function (f) {
          return '<option value="' + esc(f.dir) + '" title="' + esc(f.dir) + '">' +
            esc(shortDir(f.dir)) + ' (' + f.count + ')</option>';
        }).join("");
      sel.value = cur;
    } catch (e) { /* 目录列表拿不到不影响主流程 */ }
  }

  /** 只同步 pill 的高亮，不触发加载。 */
  function syncRatioPills() {
    var rg = document.getElementById("ratioGroup");
    if (!rg) return;
    rg.querySelectorAll(".pill").forEach(function (b) {
      b.classList.toggle("is-on", (b.dataset.ratio || "") === currentRatio);
    });
  }

  function render() {
    var grid = document.getElementById("grid");
    var loading = document.getElementById("loading");
    var stats = document.getElementById("stats");
    var f = allImages;

    // 服务端已按 ratio / sort 处理；这里只做标签的本地过滤（v1 行为）。
    if (currentTag) f = f.filter(function (i) { return i.tags && i.tags.indexOf(currentTag) >= 0; });

    loading.style.display = "none";
    stats.textContent = _page + "/" + _pages + "p " + f.length + "/" + _total;

    if (timelineMode) { renderTimeline(f, grid); return; }
    if (f.length === 0) {
      grid.innerHTML = '<div class="empty-hint">没有找到图片</div>';
      return;
    }

    grid.innerHTML = f.map(function (i) {
      return cardHtml(i, masonryMode ? { h: 150 + Math.floor(Math.random() * 80) } : null);
    }).join("");
  }

  /**
   * 来源 → 角标。DB 内的是 import / external，三个只读来源是 generated / builtin / media-lib。
   * ro=true 的来源用 accent 底 —— 它们是引用，不是你的图。
   */
  var SOURCE_BADGE = {
    "import":    { text: "LOCAL",   ro: false },
    "external":  { text: "外链",     ro: false },
    "generated": { text: "生成图",   ro: true },
    "builtin":   { text: "内置素材", ro: true },
    "media-lib": { text: "媒体库",   ro: true }
  };

  /**
   * 单张卡片的 HTML。
   * opts.h 给定缩略图高度（瀑布流每张不同）；不传就跟随网格的 --thumb-h。
   */
  function cardHtml(i, opts) {
    opts = opts || {};
    var isVid = i.media_type === "video";
    // 网格一律加载缩略图：图片走 sharp 生成，视频走 ffmpeg 抽帧（都在服务端）。
    // 网格里不放 <video>：既费资源，又只能看到黑底第一帧。
    var url = apiUrl("/thumb/" + encodeURIComponent(i.id));
    var src = SOURCE_BADGE[i.source] || SOURCE_BADGE["import"];
    var ext = String(i.ext || "").toUpperCase();

    var media = '<img src="' + url + '" data-ext="' + esc(i.ext || "") + '" alt="' + esc(i.filename) + '" loading="lazy">';

    var badges = '<span class="badge tl' + (src.ro ? " ro" : "") + '">' + src.text + '</span>';
    if (isVid) badges += '<span class="badge bl">▶</span>';
    if (ext) badges += '<span class="badge br">' + esc(ext) + '</span>';

    // 规格行：日期 · 尺寸 · 大小。外部来源没有宽高（0），自动跳过。
    var bits = [];
    var d = (i.date_taken || i.date_imported || "").split("T")[0];
    if (d) bits.push(d);
    if (i.width && i.height) bits.push(i.width + "×" + i.height);
    if (i.size_bytes) bits.push((i.size_bytes / 1024 / 1024).toFixed(1) + "M");

    var tags = (i.tags || []).map(function (t) {
      return '<span class="t" title="移除标签" onclick="event.stopPropagation();removeTagFromImage(\'' + i.id + '\',\'' +
        t.replace(/'/g, "\\'") + '\')">' + esc(t) + ' ×</span>';
    }).join("");

    var selCls = (selMode && selected[i.id]) ? " sel" : "";
    var selBox = selMode
      ? '<span class="selbox' + (selected[i.id] ? " on" : "") + '">' + (selected[i.id] ? "✓" : "") + '</span>'
      : "";

    return '<div class="card' + selCls + '" data-id="' + i.id + '" onclick="showDetail(\'' + i.id + '\')"' +
      (opts.h ? ' style="--thumb-h:' + opts.h + 'px"' : '') + '>' +
      '<div class="thumb">' + selBox + media + badges + '</div>' +
      '<div class="meta">' +
        '<div class="name">' + esc(i.filename) + '</div>' +
        (bits.length ? '<div class="date">' + esc(bits.join(" · ")) + '</div>' : '') +
        (tags ? '<div class="tags">' + tags + '</div>' : '') +
      '</div></div>';
  }

  function renderTimeline(items, grid) {
    var groups = {};
    items.forEach(function (i) {
      var d = (i.date_taken || i.date_imported || "").split("T")[0] || "未知日期";
      if (!groups[d]) groups[d] = [];
      groups[d].push(i);
    });
    var dates = Object.keys(groups).sort().reverse();
    var html = "";
    dates.forEach(function (d) {
      html += '<div style="margin-bottom:24px"><div style="font-size:14px;font-weight:600;color:#5a4a3a;margin-bottom:8px;padding-bottom:4px;border-bottom:1px solid #d8d0c4">' + esc(d) +
        ' <span style="font-size:11px;color:#8a7a6a;font-weight:400">(' + groups[d].length + ')</span></div><div class="grid">';
      groups[d].forEach(function (i) { html += cardHtml(i); });
      html += "</div></div>";
    });
    grid.innerHTML = html;
  }

  /* ── 详情 ─────────────────────────────────────────────── */

  function showDetail(id) {
    // 多选模式：点卡片 = 勾选，不弹详情（否则批量时每点一下都被弹窗拦一下）。
    if (selMode) { toggleSelect(id); return; }
    var img = allImages.find(function (i) { return i.id === id; });
    if (!img) return;
    _modalIdx = allImages.indexOf(img);
    var url = apiUrl("/image/" + encodeURIComponent(id));
    var isVid = img.media_type === "video";

    var elImg = document.getElementById("modalImg");
    var elVid = document.getElementById("modalVideo");
    if (isVid) {
      elImg.hidden = true;
      elVid.hidden = false;
      elVid.src = url;
      // 未播放前先显示抽帧缩略图，别让弹窗一开始就是黑帧。
      elVid.poster = apiUrl("/thumb/" + encodeURIComponent(id));
    } else {
      elVid.hidden = true;
      elVid.removeAttribute("src");
      elVid.removeAttribute("poster");
      elImg.hidden = false;
      elImg.src = url;
    }

    document.getElementById("modalName").textContent = img.filename;
    document.getElementById("modalPath").textContent = img.path || ("ID: " + id);
    var szText = img.size_bytes ? (img.size_bytes / 1024).toFixed(1) + " KB" : "";
    if (img.size_bytes > 2.5 * 1024 * 1024) {
      // 超过 2.5MB 回传上限：图片服务端给降采样预览；视频没法在 App 内流式播放，
      // 只能交给系统播放器（↗ 按钮）—— 如实说出来，不让用户对着黑框发呆。
      szText += isVid ? " · 超过预览上限，请用 ↗ 打开" : " · 超过预览上限，已降采样显示";
    }
    document.getElementById("modalSize").textContent = szText;
    document.getElementById("modalDate").textContent = (img.date_taken || "").split("T")[0] || "";
    document.getElementById("modalDim").textContent = (img.width && img.height) ? img.width + "\u00D7" + img.height : "";

    // v1 这里用了尚未赋值的 img（var 提升 → undefined），标签永远不显示。已修。
    var mt = document.getElementById("modalTags");
    mt.innerHTML = "";
    (img.tags || []).forEach(function (t) {
      var el = document.createElement("span");
      el.className = "t";
      el.innerHTML = esc(t) + ' <span style="cursor:pointer;margin-left:6px;opacity:.6" onclick="removeTagFromImage(\'' + id + '\',\'' + t.replace(/'/g, "\\'") + '\')">×</span>';
      mt.appendChild(el);
    });

    // 识图产物：模型写的描述。没有就整块藏起来（不占位置）。
    var md = document.getElementById("modalDesc");
    if (md) {
      var desc = String(img.description || "").trim();
      md.textContent = desc;
      md.hidden = !desc;
    }

    document.getElementById("renameInput").value = img.filename.replace(/\.[^.]+$/, "");
    window._currentId = id;
    _favState[id] = !!(img.tags && img.tags.indexOf("☆收藏") >= 0);
    document.getElementById("favBtn").textContent = _favState[id] ? "★" : "☆";

    // 只有入库的图可以改。内置素材/媒体库/生成图都是只读引用，
    // 改名、删除、加标签对它们都没意义 —— 把它们灰掉，免得白点。
    var editable = !img.source || img.source === "import";
    document.getElementById("modalActions").classList.toggle("readonly", !editable);
    document.getElementById("favBtn").style.opacity = editable ? "1" : ".35";

    // 页码提示：只有当前页超过一张时才有翻页意义
    document.getElementById("navCount").textContent =
      allImages.length > 1 && _modalIdx >= 0 ? (_modalIdx + 1) + "/" + allImages.length : "";

    _zoom = 1;
    _pan.x = 0; _pan.y = 0;
    applyZoom();
    document.getElementById("modal").classList.add("show");
  }

  /** 上一张/下一张。在当前页的列表里循环，越过边界就回到另一端。 */
  function modalStep(delta) {
    if (!allImages.length) return;
    if (_modalIdx < 0 || _modalIdx >= allImages.length) _modalIdx = 0;
    _modalIdx = (_modalIdx + delta + allImages.length * 2) % allImages.length;
    showDetail(allImages[_modalIdx].id);
  }
  function modalPrev() { modalStep(-1); }
  function modalNext() { modalStep(1); }

  function closeModal() {
    var m = document.getElementById("modal");
    m.classList.remove("show");
    // 退出全屏：否则下次打开还是全屏，用户会以为「怎么回不去了」。
    if (m.classList.contains("fullscreen")) setFullscreen(false);
    var v = document.getElementById("modalVideo");
    if (v) { try { v.pause(); } catch (e) {} v.removeAttribute("src"); v.removeAttribute("poster"); }
  }

  function removeTagFromImage(id, tagName) {
    apiFetch("/tag", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: id, tags: [tagName], action: "remove" }),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.status === "ok" || d.ok) { showMsg("已移除标签", "success"); load(); }
        else showMsg("失败: " + (d.error || ""), "error");
      })
      .catch(function (e) { showMsg("失败: " + e.message, "error"); });
  }

  /* ── 缩放 / 平移 / 全屏 ────────────────────────────────── */

  function zoomImg(d) { _zoom = Math.max(0.25, Math.min(5, _zoom + d)); applyZoom(); }
  function resetZoom() { _zoom = 1; _pan.x = 0; _pan.y = 0; applyZoom(); }

  /**
   * 把 _zoom / _pan 写到 DOM。
   * 位移与缩放写在同一个 transform 里（translate 在前）—— 否则拖动会在 scale 后面跑偏。
   * 100% 时强制归零位移：不然「缩小回 100%」会留着一个莫名其妙的偏移。
   */
  function applyZoom() {
    if (_zoom <= 1) { _pan.x = 0; _pan.y = 0; }
    var img = document.getElementById("modalImg");
    if (!img) return;
    img.style.transform = "translate(" + _pan.x + "px," + _pan.y + "px) scale(" + _zoom + ")";
    img.classList.toggle("zoomed", _zoom > 1);
    document.getElementById("zoomLevel").textContent = Math.round(_zoom * 100) + "%";
  }

  function setFullscreen(on) {
    document.getElementById("modal").classList.toggle("fullscreen", !!on);
    var b = document.getElementById("fullBtn");
    if (b) {
      b.textContent = on ? "⤡" : "⛶";
      b.title = on ? "退出全屏（Esc）" : "全屏查看（Esc 退出）";
    }
  }
  function toggleFullscreen() {
    setFullscreen(!document.getElementById("modal").classList.contains("fullscreen"));
  }

  /** 用系统默认程序打开当前文件（视频交给默认播放器）。 */
  function openInSystem() {
    if (!window._currentId) return;
    apiFetch("/open", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: window._currentId }),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        // 把「用哪个启动器成功的」一并说出来 —— 上一版就是这里报了假的成功。
        if (d && (d.ok || d.status === "ok")) showMsg("已用系统默认程序打开（" + (d.via || "?") + "）", "success");
        else showMsg("打开失败: " + ((d && d.error) || "未知原因"), "error");
      })
      .catch(function (e) { showMsg("打开失败: " + e.message, "error"); });
  }

  /** 在资源管理器中打开并选中当前文件。传 id 则开那一张（批量用）。 */
  function revealInFolder(id) {
    var target = id || window._currentId;
    if (!target) return;
    apiFetch("/reveal", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: target }),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && (d.ok || d.status === "ok")) {
          // mode=focused 说明服务端把窗口顶到了前台（Windows 前台锁：默认只能开在 Hana 后面）。
          // 没顶到就如实说，并给出下一步动作，不报假成功。
          if (d.focused) showMsg("已在资源管理器中打开并置前（" + (d.mode || d.via || "?") + "）", "success");
          else showMsg("窗口开了但没能置前（" + ((d.detail || d.via) || "?") + "），按 Alt+Tab 找一下", "info");
        }
        else showMsg("打开失败: " + ((d && d.error) || "未知原因"), "error");
      })
      .catch(function (e) { showMsg("打开失败: " + e.message, "error"); });
  }

  /**
   * 整目录打标：给当前这张图**所在目录的全部图片**打同一个标签。
   * 展开在服务端做（前端手里只有当前页）。
   *
   * 不再用 window.prompt —— Electron 渲染层不支持它（会抛错或直接返回 null），
   * 表现就是“点了像什么都没发生”。改成展开弹窗里已有的那个标签输入框。
   */
  function tagWholeFolder() {
    if (!window._currentId) return;
    var dir = currentDir();
    if (!dir) return showMsg("这张没有本地目录", "error");
    _groupMode = "folder";
    var el = document.getElementById("groupInput");
    el.hidden = false;
    var f = document.getElementById("groupInputField");
    f.value = "";
    f.placeholder = "整目录：" + shortDir(dir);
    f.focus();
    showMsg("输入标签后点「➕ 添加」——会作用到该目录的全部图片", "info");
  }

  /* ── 多选与批量 ─────────────────────────────────────── */

  function selectedIds() { return Object.keys(selected); }

  function updateSelBar() {
    var n = selectedIds().length;
    var bar = document.getElementById("selBar");
    if (bar) bar.hidden = !selMode;
    var c = document.getElementById("selCount");
    if (c) c.textContent = "已选 " + n + " 张";
  }

  function toggleSelMode() {
    selMode = !selMode;
    if (!selMode) selected = {};
    var b = document.getElementById("selToggle");
    if (b) b.style.opacity = selMode ? "1" : ".5";
    updateSelBar();
    render();
  }

  /** 只改这一张卡片的 DOM，不整页重渲染 —— 否则懒加载的图会全部重来。 */
  function toggleSelect(id) {
    if (selected[id]) delete selected[id]; else selected[id] = true;
    var el = document.querySelector('.card[data-id="' + id + '"]');
    if (el) {
      var on = !!selected[id];
      el.classList.toggle("sel", on);
      var box = el.querySelector(".selbox");
      if (box) { box.classList.toggle("on", on); box.textContent = on ? "✓" : ""; }
    }
    updateSelBar();
  }

  function pageIds() { return (allImages || []).map(function (i) { return i.id; }); }
  function selectAllPage() { pageIds().forEach(function (id) { selected[id] = true; }); render(); updateSelBar(); }
  function invertSelPage() {
    pageIds().forEach(function (id) { if (selected[id]) delete selected[id]; else selected[id] = true; });
    render(); updateSelBar();
  }
  function clearSel() { selected = {}; render(); updateSelBar(); }

  function batchTag() {
    var ids = selectedIds();
    if (!ids.length) return showMsg("先勾选一些图片", "info");
    var el = document.getElementById("selTagInput");
    var name = el ? String(el.value || "").trim() : "";
    if (!name) { if (el) el.focus(); return showMsg("先在输入框里填标签名（多个用逗号分隔）", "info"); }
    var names = name.split(/[,，]/).map(function (s) { return s.trim(); }).filter(Boolean);
    if (!names.length) return;
    apiFetch("/tag", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: ids, tags: names }),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && (d.ok || d.status === "ok")) {
          if (el) el.value = "";
          showMsg("已给 " + (d.images || ids.length) + " 张打标", "success");
          clearSel(); loadFolders(); load();
        } else showMsg("失败: " + ((d && d.error) || "未知原因"), "error");
      })
      .catch(function (e) { showMsg("失败: " + e.message, "error"); });
  }

  /**
   * 批量去标签。
   *
   * 与批量打标共用同一个输入框（不想再多占一个格子），区别只在 action=remove ——
   * 这也补上了之前的一个真缺口：加标签有批量，去标签只能一张张点 ×。
   * 标签本身不会被删（只是解除关联）；如果移除后某个标签再没人用，
   * 它会变成计数 0 的空壳，用设置里的「清空标签壳」收尾（或 /tags/prune）。
   */
  function batchUntag() {
    var ids = selectedIds();
    if (!ids.length) return showMsg("先勾选一些图片", "info");
    var el = document.getElementById("selTagInput");
    var name = el ? String(el.value || "").trim() : "";
    if (!name) { if (el) el.focus(); return showMsg("先在输入框里填要去掉的标签名（多个用逗号分隔）", "info"); }
    var names = name.split(/[,，]/).map(function (s) { return s.trim(); }).filter(Boolean);
    if (!names.length) return;
    apiFetch("/tag", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: ids, tags: names, action: "remove" }),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || !(d.ok || d.status === "ok")) return showMsg("失败: " + ((d && d.error) || "未知原因"), "error");
        if (el) el.value = "";
        // tags = 真正解析到的标签数。一个都没对上时不能报「成功」——那是假回执。
        if (!d.tags) {
          showMsg("这些名字在库里没有对应的标签，没动任何图", "info");
        } else {
          showMsg("已从 " + (d.images || ids.length) + " 张图上移除：" + names.join("、"), "success");
        }
        clearSel(); loadFolders(); load();
      })
      .catch(function (e) { showMsg("失败: " + e.message, "error"); });
  }

  /**
   * 批量命名：把选中的图改成识图给出的语义短名（如「图书馆学生合影」）。
   *
   * 两步走（这一步只是**预览与统计**，不动任何文件）：
   *   · 只处理有识图结果的（有标签或描述）
   *   · 名字已经就是建议名的、以及还没识过图的，算「跳过」并一并报出来
   * 真正动盘是 confirmBatchRename()。为什么不一步到位：这是成批改用户的真文件名，
   * 看不到数字和样例就按下去，代价太大。
   */
  function batchRename() {
    var ids = selectedIds();
    if (!ids.length) return showMsg("先勾选一些图片", "info");
    var box = document.getElementById("selRenameBox");
    var txt = document.getElementById("selRenameText");
    var todo = [], skip = 0, samples = [];
    ids.forEach(function (id) {
      var img = allImages.find(function (x) { return x.id === id; });
      if (!img) return;
      var sug = suggestNameFor(img);
      var cur = String(img.filename || "").replace(/\.[^.]+$/, "");
      // 算不出名字（没识过图 / 标签全是泛词）→ 跳过；名字已一致也跳过。
      if (!sug || sug === cur) { skip++; return; }
      todo.push({ id: id, name: sug });
      if (samples.length < 2) samples.push(cur + " → " + sug);
    });
    if (!todo.length) {
      if (box) box.hidden = true;
      _pendingRename = null;
      return showMsg("选中的 " + ids.length + " 张里没有可改的（" + skip + " 张还没识过图，或名字已经就是建议名）", "info");
    }
    _pendingRename = todo;
    if (txt) {
      txt.textContent = "将对 " + todo.length + " 张改名，跳过 " + skip + " 张（未识图 / 算不出名字 / 名字已一致）。例："
        + samples.join("；") + "。只改文件名，不移动位置；撞名自动加 -2。";
    }
    if (box) box.hidden = false;
  }

  /** 上一步点「确认」后才动盘。 */
  async function confirmBatchRename() {
    var todo = _pendingRename || [];
    var box = document.getElementById("selRenameBox");
    _pendingRename = null;
    if (box) box.hidden = true;
    if (!todo.length) return;
    var btn = document.getElementById("selRenameBtn");
    var old = btn ? btn.textContent : "";
    if (btn) btn.disabled = true;
    var ok = 0, fail = 0, firstErr = "";
    for (var i = 0; i < todo.length; i++) {
      if (btn) btn.textContent = "改名中 " + (i + 1) + "/" + todo.length;
      var r = await autoRename(todo[i].id, todo[i].name);
      if (r.ok) ok++;
      else { fail++; if (!firstErr) firstErr = r.error || "失败"; }
      await new Promise(function (res) { setTimeout(res, 60); });
    }
    if (btn) { btn.disabled = false; btn.textContent = old || "✨ 批量命名"; }
    showMsg("批量命名完成：改名 " + ok + " 张" + (fail ? "，失败 " + fail + " 张（首个原因：" + firstErr + "）" : ""),
      fail && !ok ? "error" : "success");
    clearSel();
    await load();
  }

  function cancelBatchRename() {
    _pendingRename = null;
    var box = document.getElementById("selRenameBox");
    if (box) box.hidden = true;
    showMsg("已取消，没有改任何文件", "info");
  }

  /** 批量删除：复用单张那个确认弹窗（它有「同时删除磁盘文件」选项与 doDelete）。 */
  function batchDelete() {
    var ids = selectedIds();
    if (!ids.length) return showMsg("先勾选一些图片", "info");
    var p = document.querySelector("#deleteModal p");
    if (p) p.textContent = "确认删除选中的 " + ids.length + " 张？";
    document.getElementById("deleteFileToo").checked = false;
    document.getElementById("deleteModal").classList.add("show");
  }

  /** 打开选中项里第一张所在的文件夹（批量时通常想看它们在哪儿）。 */
  function batchReveal() {
    var ids = selectedIds();
    if (!ids.length) return showMsg("先勾选一些图片", "info");
    revealInFolder(ids[0]);
  }

  /**
   * 舞台交互：放大后可拖动平移；单击图片切换 1x / 2x。
   * 之前 img 上写着 cursor: zoom-in，但点它什么都不会发生 —— 这次把话说实。
   */
  (function initStage() {
    var stage = document.getElementById("modalStage");
    var img = document.getElementById("modalImg");
    if (!stage || !img) return;
    var dragging = false, moved = false, startX = 0, startY = 0;

    stage.addEventListener("mousedown", function (e) {
      if (e.button !== 0 || _zoom <= 1) return;   // 100% 时不拖，交给单击切换
      dragging = true; moved = false;
      startX = e.clientX - _pan.x; startY = e.clientY - _pan.y;
      img.classList.add("dragging");
      e.preventDefault();
    });
    window.addEventListener("mousemove", function (e) {
      if (!dragging) return;
      var nx = e.clientX - startX, ny = e.clientY - startY;
      if (Math.abs(nx - _pan.x) > 2 || Math.abs(ny - _pan.y) > 2) moved = true;
      _pan.x = nx; _pan.y = ny;
      applyZoom();
    });
    window.addEventListener("mouseup", function () {
      if (!dragging) return;
      dragging = false;
      img.classList.remove("dragging");
    });
    img.addEventListener("click", function () {
      if (moved) { moved = false; return; }   // 刚拖过，不当成点击
      if (_zoom > 1) { _zoom = 1; } else { _zoom = 2; }
      _pan.x = 0; _pan.y = 0;
      applyZoom();
    });
  })();

  /* ── 收藏 / 命名 / 重命名 / 删除 / 分组 ───────────────── */

  function toggleFavorite() {
    if (!window._currentId) return;
    var id = window._currentId;
    apiFetch("/tag", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: id, tags: ["☆收藏"], action: _favState[id] ? "remove" : "add" }),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.status === "ok" || d.ok) {
          _favState[id] = !_favState[id];
          document.getElementById("favBtn").textContent = _favState[id] ? "★" : "☆";
          load();
        }
      })
      .catch(function () {});
  }

  /**
   * 给一张图算一个能当文件名的名字。
   *
   * 优先级：
   *   1. 识图时模型直接给的 `name`（它知道画面是什么，比从标签里挑准得多）
   *   2. 退回标签：取前 2 个「够格」的标签 —— 过滤掉单字（实测挑出过 `C`）、
   *      纯拉丁字母数字、以及泛词（二次元 / 头像 / 插画 这类当名字等于没名字）
   *   3. 都没有 → 返回空串，调用方跳过（**不拿原名或日期凑数**）
   *
   * **不带日期**：用户要的是「语义识别出来的内容」当文件名，不是时间戳。
   */
  var NAME_STOPWORDS = ["图片", "照片", "二次元", "头像", "插画", "卡通", "背景", "动漫", "壁纸", "截图", "摄影", "设计"];
  function suggestNameFor(img, tagsOverride) {
    var ai = String((img && img.ai_name) || "").trim();
    if (ai) return ai.replace(/[\\/:*?"<>|\s]+/g, "").slice(0, 60);
    var tags = (tagsOverride || (img && img.tags) || []);
    var kw = [];
    for (var i = 0; i < tags.length && kw.length < 2; i++) {
      var t = String(tags[i] || "").trim();
      if (t.length < 2) continue;                     // 单字（如 `C`）没信息量
      if (!/[\u4e00-\u9fff]/.test(t)) continue;        // 纯拉丁/数字（版本号之类）
      if (NAME_STOPWORDS.indexOf(t) >= 0) continue;    // 泛词
      kw.push(t.replace(/[\\/:*?"<>|\s]+/g, ""));
    }
    return kw.join("-").slice(0, 60);
  }

  function aiSuggestName() {
    if (!window._currentId) return;
    var img = allImages.find(function (i) { return i.id === window._currentId; });
    if (!img) { showMsg("无法获取图片信息", "error"); return; }
    var n = suggestNameFor(img);
    if (!n) return showMsg("这张还没有合适的内容可当名字 —— 先跑一次识图", "info");
    document.getElementById("renameInput").value = n;
    showMsg("✨ 建议名已填入：" + n, "success");
  }

  function renameImage() {
    var n = document.getElementById("renameInput").value.trim();
    if (!n || !window._currentId) return;
    n = n.replace(/\.[^.]+$/, "");
    apiFetch("/rename", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: window._currentId, name: n }),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.status === "ok" || d.ok) { showMsg("✏️ 已重命名", "success"); load(); }
        else showMsg("失败: " + (d.error || ""), "error");
      })
      .catch(function (e) { showMsg("失败: " + e.message, "error"); });
  }

  function deleteImage() {
    if (!window._currentId) return;
    document.getElementById("deleteFileToo").checked = false;
    document.getElementById("deleteModal").classList.add("show");
  }
  function closeDeleteModal() { document.getElementById("deleteModal").classList.remove("show"); }

  function doDelete() {
    var alsoFile = document.getElementById("deleteFileToo").checked;
    closeDeleteModal();
    // 多选且有勾选 → 批量；否则删当前弹窗那一张。
    var ids = (selMode && selectedIds().length) ? selectedIds() : [window._currentId].filter(Boolean);
    if (!ids.length) return;
    apiFetch("/delete", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: ids, deleteFile: alsoFile }),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.status === "ok" || d.ok) {
          closeModal();
          // 「库删了、磁盘没删掉」必须说出来。以前无论磁盘删没删都报
          // 「已删除（含磁盘文件）」，于是文件还在文件夹里、界面却报成功。
          var failed = (d.errors || []).length;
          var n = d.removed || ids.length;
          if (alsoFile && failed) {
            var why = (d.errors[0] && d.errors[0].error) || "文件被占用";
            showMsg("库记录已删 " + n + " 张，但磁盘文件还有 " + failed + " 个没删掉（" + why
              + "）。文件留着的话点「重新扫描」可以重新入库。", "error", 12000);
          } else if (alsoFile) {
            showMsg("已删除（含磁盘文件）：" + n + " 张", "success");
          } else {
            showMsg("已从图库移除：" + n + " 张（磁盘文件没动）", "success");
          }
          if (selMode) clearSel();
          load();
        } else showMsg("失败: " + (d.error || ""), "error");
      })
      .catch(function (e) { showMsg("失败: " + e.message, "error"); });
  }

  function showGroupPanel() {
    if (!window._currentId) return;
    _groupMode = "image";   // 从「单张」入口进来，先回到单张模式
    var el = document.getElementById("groupInput");
    el.hidden = !el.hidden;
    if (!el.hidden) {
      document.getElementById("groupInputField").placeholder = "输入标签，逗号分隔";
      document.getElementById("groupInputField").focus();
    }
  }

  /** 当前这张图所在目录（外链 / 拿不到返回空串）。 */
  function currentDir() {
    var img = allImages.find(function (i) { return i.id === window._currentId; });
    var p = img && img.path ? String(img.path) : "";
    if (!p || p.indexOf("ext:") === 0) return "";
    return p.replace(/[\\/][^\\/]*$/, "");
  }

  function addGroupTag() {
    var input = document.getElementById("groupInputField");
    var t = input.value.trim();
    if (!t) return;
    var names = t.split(/[,，]/).map(function (s) { return s.trim(); }).filter(Boolean);
    if (!names.length) return;
    var isFolder = _groupMode === "folder";
    var dir = isFolder ? currentDir() : "";
    if (!isFolder && !window._currentId) return;
    if (isFolder && !dir) return showMsg("这张没有本地目录", "error");
    input.value = "";
    _groupMode = "image";
    document.getElementById("groupInput").hidden = true;
    input.placeholder = "输入标签，逗号分隔";
    apiFetch("/tag", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(isFolder ? { folder: dir, tags: names } : { id: window._currentId, tags: names }),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.status === "ok" || d.ok) {
          showMsg(isFolder ? ("🏷 已给该目录 " + (d.images || 0) + " 张打标") : "📁 已添加标签", "success");
          if (isFolder) loadFolders();
          load();
        } else showMsg("失败: " + (d.error || ""), "error");
      })
      .catch(function (e) { showMsg("失败: " + e.message, "error"); });
  }

  /* ── 设置 ─────────────────────────────────────────────── */

  function openSettings() {
    loadSettings();
    document.getElementById("overlay").classList.add("show");
    document.getElementById("settings").classList.add("open");
  }
  function closeSettings() {
    document.getElementById("overlay").classList.remove("show");
    document.getElementById("settings").classList.remove("open");
  }

  /* ═══════ 语义检索：配置 / 建索引 / 开关 ═══════ */

  var semanticMode = false;
  var _embedPoll = null;

  function setEmbedCustomVisible(on) {
    var box = document.getElementById("embedCustom");
    if (box) box.hidden = !on;
  }

  /** 拉 embedding 候选（从 HANA_HOME 里认）+ 当前配置 + 已有索引概况。 */
  async function loadEmbedSources() {
    var sel = document.getElementById("cfgEmbedModel");
    var info = document.getElementById("embedInfo");
    if (!sel) return;
    try {
      var r = await apiFetch("/embed/sources");
      var d = await r.json();
      if (!d.ok) { if (info) info.textContent = d.error || "拿不到"; return; }
      var cfg = d.config || {};
      var opts = (d.candidates || []).map(function (c) {
        return '<option value="' + esc(c.providerId + "|" + c.model) + '">'
          + esc(c.providerId + " / " + c.name + (c.hasKey ? "" : "（无 key）")) + "</option>";
      });
      opts.push('<option value="__custom__">自定义（自己填 baseUrl / key / 模型）</option>');
      sel.innerHTML = opts.join("");
      var want = cfg.source === "custom" ? "__custom__" : (cfg.providerId + "|" + cfg.model);
      var has = Array.prototype.some.call(sel.options, function (o) { return o.value === want; });
      sel.value = has ? want : (sel.options[0] ? sel.options[0].value : "");
      setEmbedCustomVisible(sel.value === "__custom__");
      if (cfg.source === "custom") {
        document.getElementById("cfgEmbedBase").value = cfg.baseUrl || "";
        // key 永不回显（盘上是空的，内存里的也不往外吐）—— 只提示“本次运行内已失效/有效”。
        document.getElementById("cfgEmbedKey").value = "";
        document.getElementById("cfgEmbedName").value = cfg.model || "";
      }
      var bits = [];
      if (d.resolved && d.resolved.keyInMemory) {
        bits.push("key：在本次运行的内存里（不写盘，重启后要重填）");
      } else if (d.resolved && d.resolved.hasKey) {
        bits.push("key：用 Hana 里配好的（" + (d.resolved.baseUrl || "") + "）");
      } else if (d.resolved) {
        bits.push("⚠ 拿不到 key —— 改用自定义并填一个（不写盘），或在 Hana 里配好这个 provider");
      }
      bits.push(d.index ? ("已有索引 " + d.index.count + " 条 / " + d.index.dims + " 维") : "还没有索引，点下面「建语义索引」");
      if (info) info.textContent = bits.join("；");
    } catch (e) {
      if (info) info.textContent = "拉取失败: " + e.message;
    }
  }

  async function saveEmbedModel(v) {
    if (v === "__custom__") { setEmbedCustomVisible(true); return; }
    setEmbedCustomVisible(false);
    var i = String(v || "").indexOf("|");
    if (i <= 0) return;
    try {
      var r = await apiFetch("/config", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ embed: { source: "hana", providerId: v.slice(0, i), model: v.slice(i + 1), dimensions: 1024 } }),
      });
      var d = await r.json();
      showMsg(d.ok === false ? ("保存失败: " + (d.error || "")) : "语义模型已切换，记得测试连接", "info");
      loadEmbedSources();
    } catch (e) { showMsg("保存失败: " + e.message, "error"); }
  }

  async function saveEmbedCustom() {
    var base = document.getElementById("cfgEmbedBase").value.trim();
    var key = document.getElementById("cfgEmbedKey").value.trim();
    var model = document.getElementById("cfgEmbedName").value.trim();
    if (!base || !model) return showMsg("baseUrl 与模型名都得填", "info");
    try {
      var r = await apiFetch("/config", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ embed: { source: "custom", baseUrl: base, apiKey: key, model: model, dimensions: 1024 } }),
      });
      var d = await r.json();
      if (d.ok === false) return showMsg("保存失败: " + (d.error || ""), "error");
      showMsg(key ? "已保存。key 不写盘 —— 只在本次运行内有效，重启后要重填" : "已保存自定义地址（没填 key）", "success");
      loadEmbedSources();
    } catch (e) { showMsg("保存失败: " + e.message, "error"); }
  }

  /** 语义开关。开了之后搜索框里的词按“意思”去找，而不是按字面。 */
  function toggleSemantic() {
    semanticMode = !semanticMode;
    var p = document.getElementById("semPill");
    if (p) p.classList.toggle("is-on", semanticMode);
    if (semanticMode) showMsg("语义检索已开：按意思找，不看词面", "info");
    else showMsg("已回到关键词检索", "info");
    if (currentKeyword || semanticMode) load();
  }

  async function testEmbed() {
    var btn = document.getElementById("embedTestBtn");
    var old = btn ? btn.textContent : "";
    if (btn) { btn.disabled = true; btn.textContent = "测试中…"; }
    try {
      var r = await apiFetch("/embed/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      var d = await r.json();
      if (d.ok) showMsg("连接成功：" + d.model + " 返回 " + d.dims + " 维（" + d.ms + "ms）", "success");
      else showMsg("连接失败: " + (d.error || "未知原因"), "error");
    } catch (e) {
      showMsg("测试出错: " + e.message, "error");
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = old || "🔍 测试连接"; }
    }
  }

  function stopEmbedPoll() { if (_embedPoll) { clearInterval(_embedPoll); _embedPoll = null; } }

  async function pollEmbedOnce() {
    var info = document.getElementById("embedInfo");
    var btn = document.getElementById("embedBuildBtn");
    try {
      var r = await apiFetch("/embed/build/status");
      var d = await r.json();
      var j = d.job;
      if (j && j.running) {
        var pct = j.total ? Math.round((j.done / j.total) * 100) : 0;
        if (info) info.textContent = "建索引中 " + j.done + "/" + j.total + "（" + pct + "%，跳过 " + (j.skipped || 0) + "）—— 再点按钮可中止";
        if (btn) btn.textContent = "⏹ 中止建索引";
        return;
      }
      stopEmbedPoll();
      if (btn) btn.textContent = "🧠 建语义索引";
      if (j && j.error) showMsg("建索引结束：" + j.error + "（已完成 " + (j.indexed || 0) + " 条已写盘）", "error");
      else if (j) showMsg("索引建好了：" + (j.indexed || 0) + " 条 / " + (j.dims || 0) + " 维", "success");
      loadEmbedSources();
    } catch { /* 下一次再试 */ }
  }

  async function startEmbedBuild() {
    var btn = document.getElementById("embedBuildBtn");
    // 正在跑 → 这个按钮变成中止
    if (_embedPoll) {
      try {
        var c = await apiFetch("/embed/build/cancel", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
        var cd = await c.json();
        showMsg(cd.ok ? (cd.message || "已请求中止") : (cd.error || "取消失败"), "info");
      } catch (e) { showMsg("取消失败: " + e.message, "error"); }
      return;
    }
    try {
      var r = await apiFetch("/embed/build/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      var d = await r.json();
      if (d.ok === false) {
        // 「已经在建索引了」不是错误，是别人（或上一个会话）已经点了 —— 直接转成看进度。
        if (/已经在建索引/.test(d.error || "")) {
          if (btn) btn.textContent = "⏹ 中止建索引";
          stopEmbedPoll();
          _embedPoll = setInterval(pollEmbedOnce, 1500);
          pollEmbedOnce();
          return showMsg("已经有一个建索引任务在跑了，这里是它的进度", "info");
        }
        return showMsg("启动失败: " + (d.error || ""), "error");
      }
      if (btn) btn.textContent = "⏹ 中止建索引";
      showMsg("开始建语义索引（文本没变的会跳过，不会白跑）", "info");
      stopEmbedPoll();
      _embedPoll = setInterval(pollEmbedOnce, 1500);
      pollEmbedOnce();
    } catch (e) { showMsg("启动出错: " + e.message, "error"); }
  }

  /* ═══════ 索引维护：失效记录（文件被移走/改名后库里留下的空壳）═══════ */

  async function checkMissing() {
    var btn = document.getElementById("missingBtn");
    var box = document.getElementById("missingBox");
    var txt = document.getElementById("missingText");
    if (btn) { btn.disabled = true; btn.textContent = "检查中…"; }
    try {
      var r = await apiFetch("/missing", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
      });
      var d = await r.json();
      if (!d.ok) { showMsg("检查失败: " + (d.error || "未知原因"), "error"); return; }
      if (!d.missing) {
        if (box) box.hidden = true;
        showMsg("检查了 " + d.checked + " 条记录，没有失效的。", "success");
        return;
      }
      if (box) box.hidden = false;
      if (txt) {
        var eg = (d.samples || []).slice(0, 2).map(function (s) { return s.filename; }).join("、");
        txt.textContent = "检查了 " + d.checked + " 条，有 " + d.missing + " 条的文件已经不在原位"
          + (eg ? "（例如：" + eg + "）" : "")
          + "。清理只删索引记录与缩略图缓存，不动磁盘；文件只是被移走的话，重新扫描会以新路径再入库。";
      }
      showMsg("发现 " + d.missing + " 条失效记录", "info");
    } catch (e) {
      showMsg("检查出错: " + e.message, "error");
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "🔍 检查失效记录"; }
    }
  }

  async function purgeMissing() {
    try {
      var r = await apiFetch("/missing/purge", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
      });
      var d = await r.json();
      if (!d.ok) return showMsg("清理失败: " + (d.error || "未知原因"), "error");
      var box = document.getElementById("missingBox");
      if (box) box.hidden = true;
      showMsg("已清理 " + d.removed + " 条失效记录（顺带删了 " + (d.thumbs || 0) + " 张缩略图缓存）；磁盘文件没动。", "success");
      if (d.removed) await load();
    } catch (e) {
      showMsg("清理出错: " + e.message, "error");
    }
  }

  /* ═══════ 识图：模型选择 + 单张 / 批量打标 ═══════ */

  var _aiModels = [];      // /ai/models 回来且收图的条目
  var _aiBad = {};         // "provider|model" → 上次失败原因（用来在选项上标 ⚠）
  var _aiBusy = false;
  var _aiAbort = false;
  var _autoRename = false; // 识图后是否自动改盘上文件名（设置里开，默认关）
  var _pendingRename = null; // 批量命名的预览结果（点确认后才动盘）

  /**
   * 按建议名改磁盘文件名。撞名就试 -2/-3（最多 5 次），失败如实回。
   * 只改名字，不移动目录 —— 服务端 /rename 只碰同一个目录下的文件名。
   */
  async function autoRename(id, base) {
    for (var i = 0; i < 5; i++) {
      var name = i === 0 ? base : base + "-" + (i + 1);
      try {
        var r = await apiFetch("/rename", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: id, name: name }),
        });
        var d = await r.json();
        if (d && (d.ok || d.status === "ok")) return { ok: true, name: d.filename || name };
        if (!/同名文件已存在/.test((d && d.error) || "")) return { ok: false, error: (d && d.error) || "改名失败" };
      } catch (e) { return { ok: false, error: e.message }; }
    }
    return { ok: false, error: "连续撞名，已放弃" };
  }

  function aiKey(provider, model) { return String(provider || "") + "|" + String(model || ""); }

  /** 当前选中的识图模型。下拉框是唯一的真源（loadAiModels 会把配置里的值选上）。 */
  function currentAiTarget() {
    var sel = document.getElementById("cfgAiModel");
    var v = sel ? String(sel.value || "") : "";
    var i = v.indexOf("|");
    if (i > 0) return { provider: v.slice(0, i), model: v.slice(i + 1) };
    var saved = window._aiSaved;
    if (saved && saved.provider && saved.model) return { provider: saved.provider, model: saved.model };
    return null;
  }

  /**
   * 拉模型目录并填下拉框。
   *
   * 只列收图的 —— 识图这件事对文本模型没意义。
   * 目录里标了 image 也不一定真能收（实测 codebuddy-cn/* 三个一调就拒），
   * 所以选项上会带 ⚠ 标记「上次用过、失败了」，但不拦着选 —— 以实测为准，不以我为准。
   */
  async function loadAiModels(force) {
    var sel = document.getElementById("cfgAiModel");
    var note = document.getElementById("aiModelNote");
    if (!sel) return;
    if (force) sel.innerHTML = '<option value="">刷新中…</option>';
    try {
      var r = await apiFetch("/ai/models");
      var d = await r.json();
      if (!d.ok) {
        sel.innerHTML = '<option value="">（拿不到模型目录）</option>';
        if (note) note.textContent = d.error || "宿主没有提供模型能力";
        return;
      }
      _aiModels = (d.vision || []).slice();
      if (!_aiModels.length) {
        sel.innerHTML = '<option value="">（没有能收图的模型）</option>';
        if (note) note.textContent = "宿主目录里有 " + (d.sendableCount || 0) + " 个可调用模型，但没有一个收图。";
        return;
      }
      var saved = window._aiSaved;
      var savedKey = saved && saved.provider ? aiKey(saved.provider, saved.model) : "";
      var hasSaved = _aiModels.some(function (m) { return aiKey(m.provider, m.id) === savedKey; });
      sel.innerHTML = _aiModels.map(function (m) {
        var k = aiKey(m.provider, m.id);
        return '<option value="' + esc(k) + '">' + esc(m.provider + " / " + m.name + (_aiBad[k] ? " ⚠" : "")) + "</option>";
      }).join("");
      sel.value = hasSaved ? savedKey : aiKey(_aiModels[0].provider, _aiModels[0].id);
      if (note) {
        var bits = ["共 " + _aiModels.length + " 个收图模型"];
        if (savedKey && !hasSaved) bits.push("上次选的 " + savedKey + " 不在目录里，已换成默认");
        if (savedKey && _aiBad[savedKey]) bits.push("上次用这个失败了：" + _aiBad[savedKey]);
        bits.push("⚠ = 上次用过但失败");
        note.textContent = bits.join("；");
      }
    } catch (e) {
      if (note) note.textContent = "拉取失败: " + e.message;
    }
  }

  /** 识图后自动改名的开关（默认关：改名动的是用户的真文件）。 */
  async function saveAiRename(on) {
    _autoRename = on === true;
    try {
      await apiFetch("/config", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ aiRenameOnDescribe: _autoRename }),
      });
      showMsg(_autoRename ? "已开启：识图后会自动改名（用模型给的语义短名）" : "已关闭：识图后只把建议名填进改名框", "info");
    } catch (e) {
      showMsg("保存失败: " + e.message, "error");
    }
  }

  /** 模型选择即时落盘 —— 它不绑「保存设置」按钮（换模型是一件小事，不该要两次点击）。 */
  async function saveAiModel(v) {
    var i = String(v || "").indexOf("|");
    if (i <= 0) return;
    var payload = { aiModel: { provider: String(v).slice(0, i), model: String(v).slice(i + 1) } };
    window._aiSaved = payload.aiModel;
    try {
      await apiFetch("/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      showMsg("识图模型：" + payload.aiModel.provider + " / " + payload.aiModel.model, "success");
    } catch (e) {
      showMsg("保存模型选择失败: " + e.message, "error");
    }
  }

  async function aiDescribeOne(id, target) {
    var r = await apiFetch("/ai/describe", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: id, provider: target.provider, model: target.model }),
    });
    return await r.json();
  }

  /** 识图成功后收尾：刷新网格与标签栏，再把弹窗重渲染一遍（带上新描述与标签）。 */
  async function afterDescribe(id) {
    await load();
    if (window._currentId === id) showDetail(id);
  }

  /** 详情弹窗里的「✨ 识图」。 */
  async function aiDescribeCurrent() {
    var id = window._currentId;
    if (!id || _aiBusy) return;
    var target = currentAiTarget();
    if (!target) return showMsg("先到设置里选一个识图模型", "info");
    var btn = document.getElementById("aiOneBtn");
    var old = btn ? btn.textContent : "";
    _aiBusy = true;
    if (btn) { btn.textContent = "识图中…"; btn.disabled = true; }
    try {
      var d = await aiDescribeOne(id, target);
      if (d.ok) {
        _aiBad[aiKey(target.provider, target.model)] = "";
        await afterDescribe(id);
        var img2 = allImages.find(function (x) { return x.id === id; });
        var sug = d.name || suggestNameFor(img2, d.tags);      // 模型当场给的 name 优先
        var ri = document.getElementById("renameInput");
        if (ri && sug) ri.value = sug;      // 填进改名框，但不自作主张改盘
        var tail = sug ? "；建议名 " + sug + "（已填进改名框）" : "";
        showMsg("识图完成（" + Math.round((d.ms || 0) / 100) / 10 + "s）：" + (d.tags || []).join("、") + tail, "success");
        if (_autoRename && sug) {
          var rr = await autoRename(id, sug);
          if (rr.ok) { showMsg("✏️ 已改名为 " + rr.name, "success"); await afterDescribe(id); }
          else showMsg("识图好了，但改名没成：" + rr.error, "info");
        }
      } else {
        _aiBad[aiKey(target.provider, target.model)] = d.error || "失败";
        showMsg("识图失败（" + target.model + "）：" + (d.error || "未知原因"), "error");
      }
    } catch (e) {
      showMsg("识图出错: " + e.message, "error");
    } finally {
      _aiBusy = false;
      if (btn) { btn.textContent = old || "✨ 识图"; btn.disabled = false; }
    }
  }

  /**
   * 批量识图：逐张跑，边跑边报进度。
   *
   * 为什么串行而不是并发：额度与速率都是按账号算的，一次并发十几张只会撞限流，
   * 而且只有串行才能说清「跑了哪些、哪张失败」。
   * 再点一次按钮 = 中止（已跑完的留住，没跑的不动）。
   */
  async function batchAiDescribe() {
    var btn = document.getElementById("aiBatchBtn");
    if (_aiBusy) { _aiAbort = true; return; }
    var ids = selectedIds();
    if (!ids.length) return showMsg("先勾选一些图片", "info");
    var target = currentAiTarget();
    if (!target) return showMsg("先到设置里选一个识图模型", "info");

    _aiBusy = true; _aiAbort = false;
    var ok = 0, bad = 0, renamed = 0, renameFail = 0, firstErr = "";
    var old = btn ? btn.textContent : "";
    for (var i = 0; i < ids.length; i++) {
      if (_aiAbort) break;
      if (btn) btn.textContent = "识图中 " + (i + 1) + "/" + ids.length + "（再点中止）";
      try {
        var d = await aiDescribeOne(ids[i], target);
        if (d.ok) {
          ok++;
          if (_autoRename) {
            var img = allImages.find(function (x) { return x.id === ids[i]; });
            var nm = d.name || suggestNameFor(img, d.tags);
            if (nm) {
              var rr = await autoRename(ids[i], nm);
              if (rr.ok) renamed++; else renameFail++;
            }
          }
        } else { bad++; if (!firstErr) firstErr = d.error || "失败"; }
      } catch (e) {
        bad++; if (!firstErr) firstErr = e.message;
      }
      // 让出一帧，否则按钮上的进度根本刷不出来（JS 单线程跑同步循环）。
      await new Promise(function (res) { setTimeout(res, 120); });
    }
    _aiBusy = false;
    if (btn) btn.textContent = old || "✨ 识图打标";
    if (bad && !ok) _aiBad[aiKey(target.provider, target.model)] = firstErr;
    showMsg(
      (_aiAbort ? "已中止。" : "批量识图完成。") + "成功 " + ok + " 张"
      + (renamed ? "，改名 " + renamed + " 张" : "")
      + (renameFail ? "，改名失败 " + renameFail + " 张" : "")
      + (bad ? "，识图失败 " + bad + " 张（首个原因：" + firstErr + "）" : ""),
      bad && !ok ? "error" : (bad ? "info" : "success"),
    );
    if (ok) await load();
  }

  async function loadSettings() {
    try {
      var r = await apiFetch("/config");
      var d = await r.json();
      var cfg = d.config || d;
      document.getElementById("cfgGalleryRoot").value = cfg.galleryRoot || "";
      document.getElementById("cfgBlogPath").value = cfg.blogImagesPath || "";
      document.getElementById("cfgThumbSize").value = cfg.thumbnailSize || 300;
      scanPaths = cfg.scanPaths || [];
      window._savedPaths = scanPaths.slice();
      window._aiSaved = cfg.aiModel || null;   // 上次选的识图模型（loadAiModels 会把它选上）
      _autoRename = cfg.aiRenameOnDescribe === true;
      var ar = document.getElementById("cfgAiRename");
      if (ar) ar.checked = _autoRename;
      renderScanPaths();
    } catch (e) {}
    refreshGenSources();
    loadAiModels();
    loadEmbedSources();
  }

  /** 列出服务自动发现的生成图来源（哪些插件/应用产出了图）。 */
  async function refreshGenSources() {
    var el = document.getElementById("genSourcesList");
    if (!el) return;
    try {
      var r = await apiFetch("/generated/sources");
      var d = await r.json();
      var srcs = d.sources || [];
      var hit = srcs.filter(function (s) { return s.mediaCount > 0; });
      if (!hit.length) {
        el.innerHTML = "未发现含图片/视频的生成目录。<br>（各插件的 plugin-data/&lt;名&gt;/generated 与 app-data/&lt;名&gt;/generated）";
        return;
      }
      el.innerHTML = hit.map(function (s) {
        return "<div style=\"margin-bottom:3px\">· " + esc(s.owner) + " <b>" + s.mediaCount + "</b> 个</div>";
      }).join("") + "<div style=\"margin-top:6px;color:#6a5a4a\">共 " + d.total + " 个媒体文件</div>";
    } catch (e) {
      el.textContent = "检测失败: " + e.message;
    }
    refreshBuiltinSources();
  }

  /** 列出随宿主发布的内置素材（封面图库、角色卡、纹理，只读）。 */
  async function refreshBuiltinSources() {
    var el = document.getElementById("builtinSourcesList");
    if (!el) return;
    try {
      var r = await apiFetch("/builtin/sources");
      var d = await r.json();
      if (!d.ok) { el.textContent = "检测失败"; return; }
      var hit = (d.sources || []).filter(function (s) { return s.mediaCount > 0; });
      if (!hit.length) {
        el.innerHTML = "未发现内置素材目录。<br>（宿主发布包 desktop/ 下的 cover-gallery 等）";
        return;
      }
      el.innerHTML = hit.map(function (s) {
        return "<div style=\"margin-bottom:3px\">· " + esc(s.owner) + " <b>" + s.mediaCount + "</b> 个</div>";
      }).join("") +
        "<div style=\"margin-top:6px;color:#6a5a4a\">共 " + d.total + " 个 · 宿主 " + esc(d.serverVersion || "?") +
        " · 只读，不入库</div>";
    } catch (e) {
      el.textContent = "检测失败: " + e.message;
    }
  }

  function renderScanPaths() {
    var el = document.getElementById("scanPathsList");
    el.innerHTML = "";
    scanPaths.forEach(function (p, i) {
      var row = document.createElement("div");
      row.className = "path-row";
      var inp = document.createElement("input");
      inp.type = "text";
      inp.value = p;
      inp.oninput = function () { scanPaths[i] = this.value; };
      var btn = document.createElement("button");
      btn.className = "del-btn";
      btn.textContent = "\u2716";
      btn.onclick = function () { scanPaths.splice(i, 1); renderScanPaths(); };
      row.appendChild(inp);
      row.appendChild(btn);
      el.appendChild(row);
    });
  }

  function addScanPath() { scanPaths.push(""); renderScanPaths(); }

  /**
   * 消息提示。
   *
   * 以前写的是 #statusMsg —— 那个元素在**设置抽屉里**（抽屉关着时它 display:none），
   * 在弹窗里还会被 .modal 的 z-index:100 盖住。
   * 结果是：抽屉不开的时候，任何反馈（包括“打开失败: xxx”）都**看不见** ——
   * 于是每个没弹窗的动作都长得像“点了没反应”。
   *
   * 改成挂在 body 上的悬浮气泡，z-index 高过弹窗与设置抽屉。
   */
  var _toastEl = null, _toastTimer = null;
  function showMsg(text, type, ms) {
    if (!_toastEl) {
      _toastEl = document.createElement("div");
      _toastEl.className = "toast";
      document.body.appendChild(_toastEl);
    }
    _toastEl.className = "toast " + (type || "info") + " show";
    _toastEl.textContent = text;
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(function () { _toastEl.classList.remove("show"); }, ms || 4200);
  }

  async function saveConfig() {
    var cleanPaths = scanPaths.filter(function (p) { return p && typeof p === "string"; }).map(function (p) { return p.trim(); });
    try {
      var r = await apiFetch("/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scanPaths: cleanPaths,
          _oldPaths: window._savedPaths || cleanPaths,
          galleryRoot: document.getElementById("cfgGalleryRoot").value,
          blogImagesPath: document.getElementById("cfgBlogPath").value,
          thumbnailSize: parseInt(document.getElementById("cfgThumbSize").value, 10) || 300,
        }),
      });
      var d = await r.json();
      if (d.status === "ok" || d.ok) {
        window._savedPaths = cleanPaths;
        showMsg("配置已保存", "success");
      } else showMsg("保存失败: " + (d.error || ""), "error");
    } catch (e) { showMsg("保存失败: " + e.message, "error"); }
  }

  /**
   * 视频入库挂在 🎬 开关上（/scan 只在 showVideo 为真时收 mp4）—— 这层关系用户猜不到，
   * 所以在导入/重建的提示里说破。只在真的跳过了视频时才提，没有就不噪音。
   */
  function videoHint(s) {
    return (s && s.videosSkipped) ? "，另有 " + s.videosSkipped + " 个视频未导入（打开 🎬 后重跑）" : "";
  }

  async function triggerRebuild() {
    showMsg("正在重建索引…", "info");
    try {
      var r = await apiFetch("/rebuild", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true, showVideo: true }),
      });
      var d = await r.json();
      if (d.status === "ok" || d.ok) {
        var s = d.summary || d;
        showMsg("重建完成：扫描 " + (s.scanned || 0) + "，新增 " + (s.imported || 0) + videoHint(s), "success");
        load();
      } else showMsg("失败: " + (d.error || ""), "error");
    } catch (e) { showMsg("失败: " + e.message, "error"); }
  }

  async function triggerImport() {
    showMsg("正在导入…", "info");
    try {
      var r = await apiFetch("/import", {
        method: "POST", headers: { "Content-Type": "application/json" },
        // 不传 paths：让服务端用它的默认目录集（scanPaths ∪ galleryRoot），
        // 否则从 UI 进来会将 galleryRoot 排除在外，放进根目录的图永远扫不到。
        // force：这是用户主动点的，不要被服务端的 60s 自动节流拦下来。
        body: JSON.stringify({ showVideo: true, force: true }),
      });
      var d = await r.json();
      var s = d.summary || d;
      if (d.status === "ok" || d.ok) {
        showMsg("导入完成：新增 " + (s.imported || 0) + "，跳过 " + (s.skipped || 0) + videoHint(s), "success");
        load();
      } else showMsg("失败: " + (d.error || ""), "error");
    } catch (e) { showMsg("失败: " + e.message, "error"); }
  }

  /* ── 链接导入 / 外链 ──────────────────────────────────── */

  function previewImportUrl() {
    var url = document.getElementById("importUrlInput").value.trim();
    if (!url) return;
    document.getElementById("importPreview").innerHTML = '<img src="' + esc(url) + '" style="max-width:100%;max-height:120px;object-fit:contain">';
    _importUrl = url;
  }

  function confirmImportUrl() {
    if (!_importUrl) { showMsg("请先预览", "error"); return; }
    apiFetch("/import-url", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: _importUrl }),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.status === "ok" || d.ok) { showMsg("已导入: " + d.filename, "success"); load(); }
        else showMsg("失败: " + (d.error || ""), "error");
      })
      .catch(function (e) { showMsg("失败: " + e.message, "error"); });
  }

  function addExternalUrl() {
    var raw = document.getElementById("extUrlInput").value.trim();
    if (!raw) { showMsg("请输入 URL", "error"); return; }
    var urls = raw.split("\n").map(function (s) { return s.trim(); }).filter(Boolean);
    if (!urls.length) return;
    var tags = document.getElementById("extTagsInput").value.trim();
    var tagArr = ["external"];
    if (tags) tags.split(",").map(function (s) { return s.trim(); }).filter(Boolean).forEach(function (t) { if (tagArr.indexOf(t) < 0) tagArr.push(t); });

    var done = 0, fail = 0;
    showMsg("正在添加 " + urls.length + " 个外链…", "info");
    urls.forEach(function (url) {
      apiFetch("/add-external", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url, tags: tagArr }),
      })
        .then(function (r) { return r.json(); })
        .then(function (d) { (d.status === "ok" || d.ok) ? done++ : fail++; })
        .catch(function () { fail++; })
        .then(function () {
          if (done + fail === urls.length) {
            showMsg("已添加: " + done + "/" + urls.length + "（失败 " + fail + "）", fail ? "info" : "success");
            if (done) load();
            document.getElementById("extUrlInput").value = "";
          }
        });
    });
  }

  /* ── 排序 / 视图 / 分页 ───────────────────────────────── */

  function changeSort() { _page = 1; load(); }

  /** 设比例筛选并同步 pill 高亮。来源分组模式下整组被禁用，点了直接忽略。 */
  function setRatio(v) {
    var rg = document.getElementById("ratioGroup");
    if (rg && rg.classList.contains("is-disabled")) return;
    currentRatio = v || "";
    syncRatioPills();
    _page = 1;
    load();
  }

  /** v1 兼容入口：按当前状态重新加载。 */
  function applyRatioFilter() { _page = 1; load(); }

  /** 搜索语法浮层：hover 自动出，点击可固定 / 收起。 */
  function toggleSearchHelp(e) {
    if (e) e.stopPropagation();
    var w = document.getElementById("searchWrap");
    if (w) w.classList.toggle("help-open");
  }

  /**
   * 网格 / 列表切换。
   * 缩略图高度改由 --thumb-h 驱动（网格统一、瀑布流每卡覆写、列表固定 88px），
   * 所以这里不再直接改 <img> 的 style.height。
   */
  function toggleView() {
    listMode = !listMode;
    document.getElementById("viewBtn").textContent = listMode ? "☰" : "▦";
    var grid = document.getElementById("grid");
    var cards = document.querySelectorAll(".card");
    grid.classList.toggle("list-mode", listMode);
    cards.forEach(function (c) { c.classList.toggle("list", listMode); });
    if (listMode) {
      grid.style.gridTemplateColumns = "";
      cards.forEach(function (c) { c.style.setProperty("--thumb-h", "88px"); });
    } else {
      cards.forEach(function (c) { c.style.removeProperty("--thumb-h"); });
      changeGridSize();
    }
  }

  /** 滑块同时改列宽与缩略图高度 —— 否则放大只是裁得更狠。 */
  function changeGridSize() {
    if (listMode) return;
    var val = Number(document.getElementById("gridZoom").value) || 180;
    var grid = document.getElementById("grid");
    grid.style.gridTemplateColumns = "repeat(auto-fill, minmax(" + val + "px, 1fr))";
    grid.style.setProperty("--thumb-h", Math.round(val * 0.83) + "px");
  }

  function toggleMasonry() {
    masonryMode = !masonryMode;
    document.getElementById("masonryBtn").textContent = masonryMode ? "⊟" : "⊞";
    render();
  }

  function toggleTimeline() {
    timelineMode = !timelineMode;
    var b = document.getElementById("timelineToggle");
    if (b) b.style.opacity = timelineMode ? "1" : ".5";
    render();
  }

  function toggleVid() {
    videoOnly = !videoOnly;
    document.getElementById("vidToggle").style.opacity = videoOnly ? "1" : ".5";
    _page = 1;
    load();
  }

  function prePage() { if (_page > 1) { _page--; load(); } }
  function nextPage() { if (_page < _pages) { _page++; load(); } }

  /* ── 键盘 ─────────────────────────────────────────────── */

  document.addEventListener("keydown", function (e) {
    var modalOpen = document.getElementById("modal").classList.contains("show");
    if (e.key === "Escape") {
      var m = document.getElementById("modal");
      // 先退全屏，再关弹窗 —— 否则全屏状态下按 Esc 会直接把弹窗关掉，
      // 用户以为自己只是退了个全屏。
      if (m.classList.contains("fullscreen")) { setFullscreen(false); return; }
      closeModal(); closeDeleteModal(); closeSettings();
      var sw = document.getElementById("searchWrap");
      if (sw) sw.classList.remove("help-open");
    }
    // 弹窗开着时用左右方向键切图（输入框聚焦时不接管）
    if (modalOpen && document.activeElement && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) return;
    if (modalOpen && e.key === "ArrowLeft") { e.preventDefault(); modalPrev(); }
    if (modalOpen && e.key === "ArrowRight") { e.preventDefault(); modalNext(); }
  });

  // 点搜索框以外的地方收起语法浮层
  document.addEventListener("click", function (e) {
    var w = document.getElementById("searchWrap");
    if (w && !w.contains(e.target)) w.classList.remove("help-open");
  });
  document.getElementById("modalImg").addEventListener("wheel", function (e) {
    e.preventDefault();
    zoomImg(e.deltaY < 0 ? 0.1 : -0.1);
  });

  /* ── 缩略图降级 ─────────────────────────────────────── */

  /**
   * 缩略图加载失败时，在缩略图框里放一个明确的占位。
   * 以前这种情况会让 <img> 直接退化成 alt 文字（就是文件名），看着像"空条目"。
   */
  function thumbFallback(el, ext, isVid) {
    var box = el.parentNode;
    if (!box || box.querySelector(".thumb-fallback")) return;
    el.style.display = "none";
    var d = document.createElement("div");
    d.className = "thumb-fallback";
    d.innerHTML = '<span class="ic">' + (isVid ? "\u25B6" : "\u25C7") + '</span>' +
      '<span class="tx">预览不可用</span>' +
      (ext ? '<span class="ex">' + esc(String(ext).toUpperCase()) + '</span>' : '');
    box.appendChild(d);
  }

  // 用捕获阶段监听 error：error 事件不冒泡，但会被祖先在捕获阶段拿到。
  // 不用内联 onerror —— 模板字符串里的内联 JS 是本机踩过的坑（转义会崩）。
  document.getElementById("grid").addEventListener("error", function (e) {
    var t = e.target;
    if (!t || (t.tagName !== "IMG" && t.tagName !== "VIDEO")) return;
    thumbFallback(t, t.getAttribute("data-ext"), t.tagName === "VIDEO");
  }, true);

  // 详情弹窗的原图失败（超限且降采样也失败 / 源文件已移走）也要有交代。
  document.getElementById("modalImg").addEventListener("error", function () {
    document.getElementById("modalImg").hidden = true;
    showMsg("原图预览不可用（可能超过预览上限，或源文件已移动）", "error");
  });

  /* ── 暴露到全局（内联 onclick 需要） ─────────────────── */

  Object.assign(window, {
    load: load, render: render, renderTags: renderTags, filterTag: filterTag,
    debouncedSearch: debouncedSearch, changeSort: changeSort, applyRatioFilter: applyRatioFilter,
    showDetail: showDetail, closeModal: closeModal, removeTagFromImage: removeTagFromImage,
    zoomImg: zoomImg, resetZoom: resetZoom, toggleFavorite: toggleFavorite,
    aiSuggestName: aiSuggestName, renameImage: renameImage,
    deleteImage: deleteImage, closeDeleteModal: closeDeleteModal, doDelete: doDelete,
    showGroupPanel: showGroupPanel, addGroupTag: addGroupTag,
    openSettings: openSettings, closeSettings: closeSettings,
    addScanPath: addScanPath, saveConfig: saveConfig, refreshGenSources: refreshGenSources,
    triggerRebuild: triggerRebuild, triggerImport: triggerImport,
    previewImportUrl: previewImportUrl, confirmImportUrl: confirmImportUrl,
    addExternalUrl: addExternalUrl,
    toggleView: toggleView, changeGridSize: changeGridSize,
    toggleMasonry: toggleMasonry, toggleTimeline: toggleTimeline, toggleVid: toggleVid,
    prePage: prePage, nextPage: nextPage, showMsg: showMsg,
    modalPrev: modalPrev, modalNext: modalNext,
    toggleFullscreen: toggleFullscreen, openInSystem: openInSystem,
    revealInFolder: revealInFolder, filterFolder: filterFolder, tagWholeFolder: tagWholeFolder,
    aiDescribeCurrent: aiDescribeCurrent, batchAiDescribe: batchAiDescribe, batchUntag: batchUntag,
    batchRename: batchRename, confirmBatchRename: confirmBatchRename, cancelBatchRename: cancelBatchRename,
      loadAiModels: loadAiModels, saveAiModel: saveAiModel, saveAiRename: saveAiRename,
    checkMissing: checkMissing, purgeMissing: purgeMissing,
    toggleSemantic: toggleSemantic, loadEmbedSources: loadEmbedSources, saveEmbedModel: saveEmbedModel,
    saveEmbedCustom: saveEmbedCustom, testEmbed: testEmbed, startEmbedBuild: startEmbedBuild,
    toggleTagsExpanded: function () { _tagsExpanded = !_tagsExpanded; renderTags(); },
    filterUncategorized: filterUncategorized, toggleSelMode: toggleSelMode,
    selectAllPage: selectAllPage, invertSelPage: invertSelPage, clearSel: clearSel,
    batchTag: batchTag, batchDelete: batchDelete, batchReveal: batchReveal,
    filterAll: filterAll, filterSource: filterSource, refreshSourceCounts: refreshSourceCounts,
    setRatio: setRatio, toggleSearchHelp: toggleSearchHelp,
  });

  /* ── 启动 ─────────────────────────────────────────────── */

  /**
   * 面板打开时做一次**增量**刷新：把「后来才放进文件夹」的图带进来。
   *
   * 为什么现在能做成自动：/scan 已改为先按 (size, mtime) 判断文件是否变过，
   * 只有新增/变化的文件才读盘哈希。旧实现对每个文件都哈希，6004 张的库每次
   * 扫描都要把整个库读一遍 —— 那种成本下「自动刷新」是不可行的。
   * 会跳过时（60s 内重开面板）直接不跑，避免切个标签就扫一遍。
   */
  function autoRefresh() {
    var KEY = "_galleryAutoRefreshAt";
    var last = 0;
    try { last = Number(sessionStorage.getItem(KEY) || 0); } catch (e) { /* 隐私模式 */ }
    if (Date.now() - last < 60000) return;
    try { sessionStorage.setItem(KEY, String(Date.now())); } catch (e) { /* 忽略 */ }
    // 不带 force：服务端自己也有一道全局节流（60s）。本地这道是按窗口的，
    // 新窗口永远为空 —— 真正拦住重复扫描的是服务端那道。
    apiFetch("/import", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ showVideo: true }),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var s = (d && d.summary) || {};
        var n = (s.imported || 0) + (s.updated || 0);
        if (n > 0) {
          showMsg("已同步 " + n + " 个变化（新增 " + (s.imported || 0) + " / 更新 " + (s.updated || 0) + "）", "success");
          loadFolders();
          load();
        }
      })
      .catch(function () { /* 自动刷新失败不打扰用户 */ });
  }

  changeGridSize();
  load();
  loadFolders();
  // 延后一点再扫：先把首屏渲染出来，别让第一次扫描拖慢打开速度。
  setTimeout(autoRefresh, 800);
})();
