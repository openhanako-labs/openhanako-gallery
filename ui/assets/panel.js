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
  var showVideo = false, timelineMode = false, masonryMode = false, listMode = false;
  // currentRatio：比例筛选。v0.6.0 从 <select> 改成 pill，用状态变量而不是读 DOM。
  var currentRatio = "";
  // 无任何筛选时的总数，用来给「全部」标签显示计数。
  var _allCount = 0;
  var _page = 1, _pages = 1, _total = 0;
  var _zoom = 1, _favState = {}, _importUrl = null;
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
      // 视频开关：后端默认只返图片，要显式传才会把 .mp4/.webm 带出来。
      // 不传的话 🎬 按钮点了只会刷新同一个结果。
      if (showVideo) q += "&showVideo=true";

      // 比例筛选只对入库图片有意义（靠 width/height 判断）。
      // 三个外部来源的 width/height 都是 0，切了也是白切，整组禁用。
      var rg = document.getElementById("ratioGroup");
      if (rg) rg.classList.toggle("is-disabled", !!currentSource);

      var r = await apiFetch("/search?" + q);
      var d = await r.json();
      allImages = d.results || [];
      _total = d.total || 0;
      _pages = d.pages || 1;
      _page = d.page || 1;
      // 没有任何筛选时，total 就是全库张数 —— 给「全部」标签当计数。
      if (!currentKeyword && !currentTag && !currentSource) _allCount = _total;

      var tr = await apiFetch("/tags");
      var td = await tr.json();
      allTags = td.tags || [];
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
    var v = showVideo ? "?includeVideo=true" : "";
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

  function renderTags() {
    var bar = document.getElementById("tagbar");
    var allOn = (currentTag === "" && currentSource === "" && !currentRatio) ? " active" : "";
    bar.innerHTML = '<span class="tag tag-all' + allOn + '" onclick="filterAll()">全部' +
      (_allCount ? ' <b>' + _allCount + '</b>' : '') + '</span>';
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
    allTags.forEach(function (t) {
      var el = document.createElement("span");
      el.className = "tag" + (currentTag === t.name && currentSource === "" ? " active" : "");
      el.innerHTML = esc(t.name) + (t.image_count ? ' <b>' + t.image_count + '</b>' : '');
      el.onclick = function () { filterTag(t.name); };
      bar.appendChild(el);
    });
  }

  function filterTag(tag) { currentSource = ""; currentTag = tag; _page = 1; _modalIdx = -1; load(); }
  function filterSource(src) { currentTag = ""; currentSource = src; _page = 1; _modalIdx = -1; load(); }
  // 「全部」就是全部：标签、来源、比例一起清掉。
  function filterAll() {
    currentTag = ""; currentSource = ""; currentRatio = "";
    syncRatioPills();
    _page = 1; _modalIdx = -1; load();
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
    var url = apiUrl("/image/" + encodeURIComponent(i.id));
    var isVid = i.media_type === "video";
    var src = SOURCE_BADGE[i.source] || SOURCE_BADGE["import"];
    var ext = String(i.ext || "").toUpperCase();

    var media = isVid
      ? '<video src="' + url + '" muted preload="metadata"></video>'
      : '<img src="' + url + '" alt="' + esc(i.filename) + '" loading="lazy">';

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

    return '<div class="card" onclick="showDetail(\'' + i.id + '\')"' +
      (opts.h ? ' style="--thumb-h:' + opts.h + 'px"' : '') + '>' +
      '<div class="thumb">' + media + badges + '</div>' +
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
    } else {
      elVid.hidden = true;
      elVid.removeAttribute("src");
      elImg.hidden = false;
      elImg.src = url;
    }

    document.getElementById("modalName").textContent = img.filename;
    document.getElementById("modalPath").textContent = img.path || ("ID: " + id);
    document.getElementById("modalSize").textContent = img.size_bytes ? (img.size_bytes / 1024).toFixed(1) + " KB" : "";
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
    document.getElementById("modal").classList.remove("show");
    var v = document.getElementById("modalVideo");
    if (v) { try { v.pause(); } catch (e) {} v.removeAttribute("src"); }
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

  /* ── 缩放 ─────────────────────────────────────────────── */

  function zoomImg(d) { _zoom = Math.max(0.25, Math.min(5, _zoom + d)); applyZoom(); }
  function resetZoom() { _zoom = 1; applyZoom(); }
  function applyZoom() {
    var img = document.getElementById("modalImg");
    img.style.transform = "scale(" + _zoom + ")";
    img.classList.toggle("zoomed", _zoom > 1);
    document.getElementById("zoomLevel").textContent = Math.round(_zoom * 100) + "%";
  }

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

  function aiSuggestName() {
    if (!window._currentId) return;
    var img = allImages.find(function (i) { return i.id === window._currentId; });
    if (!img) { showMsg("无法获取图片信息", "error"); return; }
    var name = "";
    if (img.date_taken) name += img.date_taken.split("T")[0] + "_";
    name += (img.filename || "image").replace(/\.[^.]+$/, "");
    document.getElementById("renameInput").value = name;
    showMsg("✨ 建议名称已填入", "success");
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
    apiFetch("/delete", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: window._currentId, deleteFile: alsoFile }),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.status === "ok" || d.ok) {
          closeModal();
          showMsg(alsoFile ? "已删除（含磁盘文件）" : "已从图库移除", "success");
          load();
        } else showMsg("失败: " + (d.error || ""), "error");
      })
      .catch(function (e) { showMsg("失败: " + e.message, "error"); });
  }

  function showGroupPanel() {
    if (!window._currentId) return;
    var el = document.getElementById("groupInput");
    el.hidden = !el.hidden;
    if (!el.hidden) document.getElementById("groupInputField").focus();
  }

  function addGroupTag() {
    var input = document.getElementById("groupInputField");
    var t = input.value.trim();
    if (!t || !window._currentId) return;
    input.value = "";
    apiFetch("/tag", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: window._currentId, tags: t.split(",").map(function (s) { return s.trim(); }).filter(Boolean) }),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.status === "ok" || d.ok) { showMsg("📁 已添加标签", "success"); load(); }
        else showMsg("失败: " + (d.error || ""), "error");
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
      renderScanPaths();
    } catch (e) {}
    refreshGenSources();
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

  function showMsg(text, type) {
    var el = document.getElementById("statusMsg");
    el.className = "status-msg " + (type || "info");
    el.textContent = text;
    el.style.display = "block";
    setTimeout(function () { el.style.display = "none"; }, 4000);
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

  async function triggerRebuild() {
    showMsg("正在重建索引…", "info");
    try {
      var r = await apiFetch("/rebuild", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true, showVideo: showVideo }),
      });
      var d = await r.json();
      if (d.status === "ok" || d.ok) {
        var s = d.summary || d;
        showMsg("重建完成：扫描 " + (s.scanned || 0) + "，新增 " + (s.imported || 0), "success");
        load();
      } else showMsg("失败: " + (d.error || ""), "error");
    } catch (e) { showMsg("失败: " + e.message, "error"); }
  }

  async function triggerImport() {
    var cleanPaths = scanPaths.filter(function (p) { return p && typeof p === "string" && p.trim(); });
    showMsg("正在导入…", "info");
    try {
      var r = await apiFetch("/import", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paths: cleanPaths, showVideo: showVideo }),
      });
      var d = await r.json();
      var s = d.summary || d;
      if (d.status === "ok" || d.ok) {
        showMsg("导入完成：新增 " + (s.imported || 0) + "，跳过 " + (s.skipped || 0), "success");
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
    showVideo = !showVideo;
    document.getElementById("vidToggle").style.opacity = showVideo ? "1" : ".5";
    _page = 1;
    load();
  }

  function prePage() { if (_page > 1) { _page--; load(); } }
  function nextPage() { if (_page < _pages) { _page++; load(); } }

  /* ── 键盘 ─────────────────────────────────────────────── */

  document.addEventListener("keydown", function (e) {
    var modalOpen = document.getElementById("modal").classList.contains("show");
    if (e.key === "Escape") {
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
    filterAll: filterAll, filterSource: filterSource, refreshSourceCounts: refreshSourceCounts,
    setRatio: setRatio, toggleSearchHelp: toggleSearchHelp,
  });

  /* ── 启动 ─────────────────────────────────────────────── */

  changeGridSize();
  load();
})();
