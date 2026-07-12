(function () {
  "use strict";

  // ===== 从 URL 提取分享 token =====
  const m = location.pathname.match(/\/share\/([^/?#]+)/);
  const TOKEN = m ? decodeURIComponent(m[1]) : null;

  const $ = (id) => document.getElementById(id);
  const stream = $("stream");
  const streamFooter = $("streamFooter");
  const tagbarInner = $("tagbarInner");

  const state = {
    event: null,
    activeTag: null,
    photos: [],
    page: 1,
    size: 30,
    total: 0,
    loading: false,
    hasMore: true,
    lbIndex: -1,
    zoomed: false,
    panX: 0, panY: 0,
  };

  function toast(msg) {
    const el = $("toast");
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.hidden = true; }, 1800);
  }

  function applyI18n() {
    document.documentElement.lang = I18N.getLang() === "en" ? "en" : "zh";
    document.querySelectorAll("[data-i18n]").forEach((el) => {
      const k = el.getAttribute("data-i18n");
      el.textContent = I18N.t(k);
    });
    // 语言切换按钮高亮
    document.querySelectorAll(".lang-opt").forEach((o) => {
      o.classList.toggle("active", o.dataset.lang === I18N.getLang());
    });
    $("brandTitle").textContent = state.event ? state.event.event_name : I18N.t("app_name");
    if (state.event) renderTags(state.event.tags || []);
    renderFooter();
    renderLightboxBar();
  }

  // ===== 标签渲染 =====
  function renderTags(tags) {
    const all = [{ tag: null, count: state.event ? state.event.photo_count : 0 }];
    const list = all.concat(tags.map((t) => ({ tag: t.tag, count: t.count })));
    tagbarInner.innerHTML = "";
    list.forEach((t) => {
      const b = document.createElement("button");
      b.className = "tag-pill" + (t.tag === state.activeTag ? " active" : "");
      b.type = "button";
      const label = t.tag === null ? I18N.t("filter_all") : t.tag;
      b.innerHTML = `<span>${escapeHtml(label)}</span><span class="cnt">${t.count}</span>`;
      b.addEventListener("click", () => {
        if (state.activeTag === t.tag) return;
        state.activeTag = t.tag;
        applyI18n();
        loadPhotos(true);
      });
      tagbarInner.appendChild(b);
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ===== 照片加载 =====
  async function loadPhotos(reset) {
    if (state.loading) return;
    if (reset) {
      state.page = 1;
      state.hasMore = true;
      state.photos = [];
      stream.innerHTML = "";
    }
    if (!state.hasMore) return;
    state.loading = true;
    renderFooter();
    try {
      const data = await API.sharePhotos(TOKEN, { tag: state.activeTag, page: state.page, size: state.size });
      state.total = data.total;
      state.photos = state.photos.concat(data.photos);
      state.hasMore = state.photos.length < data.total;
      state.page += 1;
      renderPhotos(data.photos);
      renderFooter();
      if (data.photos.length === 0 && state.photos.length === 0) {
        showEmpty();
      }
    } catch (e) {
      renderFooter(true);
      if (state.photos.length === 0) {
        stream.innerHTML = `<div class="empty-state"><div class="icon">⚠</div>${I18N.t("load_failed")}</div>`;
      } else {
        toast(I18N.t("load_failed"));
      }
    } finally {
      state.loading = false;
    }
  }

  function showEmpty() {
    stream.innerHTML = `<div class="empty-state"><div class="icon">📷</div>${I18N.t("no_photos")}</div>`;
  }

  function renderFooter(isError) {
    streamFooter.className = isError ? "stream-footer error" : "stream-footer";
    if (state.photos.length === 0 && !state.loading) { streamFooter.innerHTML = ""; return; }
    if (state.loading) {
      streamFooter.innerHTML = I18N.t("loading_more");
      return;
    }
    if (isError) {
      streamFooter.innerHTML = `${I18N.t("load_failed")} <button class="load-more" onclick="window._galleryRetry()">${I18N.t("retry")}</button>`;
      return;
    }
    if (state.hasMore) {
      streamFooter.innerHTML = `<button class="load-more" onclick="window._galleryMore()">${I18N.t("load_more")}</button>`;
    } else {
      streamFooter.innerHTML = I18N.t("no_more");
    }
  }
  window._galleryMore = () => loadPhotos(false);
  window._galleryRetry = () => loadPhotos(false);

  function renderPhotos(photos) {
    photos.forEach((p, i) => {
      const card = document.createElement("div");
      card.className = "photo-card";
      const idx = state.photos.length - photos.length + i;
      card.dataset.idx = idx;
      const skeleton = document.createElement("div");
      skeleton.className = "skeleton";
      card.appendChild(skeleton);
      const img = document.createElement("img");
      img.loading = "lazy";
      img.alt = p.filename || "";
      img.dataset.src = API.url(p.preview_url);
      card.appendChild(img);
      if (p.tag) {
        const badge = document.createElement("div");
        badge.className = "tag-badge";
        badge.textContent = p.tag;
        card.appendChild(badge);
      }
      if (p.has_raf) {
        const dot = document.createElement("div");
        dot.className = "raf-dot";
        card.appendChild(dot);
      }
      card.addEventListener("click", () => openLightbox(parseInt(card.dataset.idx, 10)));
      stream.appendChild(card);
      lazyLoad(card, img, skeleton);
    });
  }

  // 懒加载 + 渐入
  function lazyLoad(card, img, skeleton) {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((en) => {
        if (en.isIntersecting) {
          const src = img.dataset.src;
          if (!src) return;
          img.onload = () => {
            if (skeleton && skeleton.parentNode) skeleton.parentNode.removeChild(skeleton);
            card.classList.add("in");
          };
          img.onerror = () => { if (skeleton) skeleton.style.opacity = 0.5; };
          img.src = src;
          io.disconnect();
        }
      });
    }, { rootMargin: "300px" });
    io.observe(card);
  }

  // ===== 灯箱 =====
  function openLightbox(index) {
    state.lbIndex = index;
    state.zoomed = false;
    state.panX = 0; state.panY = 0;
    $("lightbox").hidden = false;
    document.body.style.overflow = "hidden";
    loadLightboxImage();
    renderLightboxBar();
  }
  function closeLightbox() {
    $("lightbox").hidden = true;
    document.body.style.overflow = "";
    $("lbImg").src = "";
    $("lbImg").classList.remove("loaded");
  }
  function navLightbox(dir) {
    const n = state.photos.length;
    if (n === 0) return;
    state.lbIndex = (state.lbIndex + dir + n) % n;
    state.zoomed = false;
    state.panX = 0; state.panY = 0;
    loadLightboxImage();
    renderLightboxBar();
  }
  function loadLightboxImage() {
    const p = state.photos[state.lbIndex];
    if (!p) return;
    const img = $("lbImg");
    const spinner = $("lbSpinner");
    img.classList.remove("loaded");
    img.style.transform = "";
    spinner.hidden = false;
    const tmp = new Image();
    tmp.onload = () => {
      img.src = tmp.src;
      img.classList.add("loaded");
      spinner.hidden = true;
    };
    tmp.onerror = () => { spinner.hidden = true; };
    tmp.src = API.url(p.original_url);
  }
  function renderLightboxBar() {
    const bar = $("lbBar");
    if (state.lbIndex < 0) { bar.innerHTML = ""; return; }
    const p = state.photos[state.lbIndex];
    if (!p) { bar.innerHTML = ""; return; }
    const rafDisabled = p.has_raf ? "" : " disabled";
    bar.innerHTML = `
      <button class="lb-action primary" id="actViewOrig">${I18N.t("view_original")}</button>
      <button class="lb-action" id="actDlOrig">${I18N.t("download_original")}</button>
      <button class="lb-action${rafDisabled}" id="actViewRaf">${I18N.t("view_raf")}</button>
      <button class="lb-action${rafDisabled}" id="actDlRaf">${I18N.t("download_raf")}</button>
    `;
    const bind = (id, fn) => { const el = $(id); if (el) el.addEventListener("click", fn); };
    bind("actViewOrig", () => openPhotoUrl(p.original_url, false));
    bind("actDlOrig", () => openPhotoUrl(p.original_url, true));
    bind("actViewRaf", () => p.has_raf && openPhotoUrl(p.raf_url, false));
    bind("actDlRaf", () => p.has_raf && openPhotoUrl(p.raf_url, true));
  }
  function openPhotoUrl(path, download) {
    let u = API.url(path);
    if (download) u += (u.indexOf("?") === -1 ? "?" : "&") + "download=1";
    window.open(u, "_blank");
  }

  // 双击/双击缩放 + 拖拽
  let lastTap = 0;
  function toggleZoom(cx, cy) {
    const img = $("lbImg");
    state.zoomed = !state.zoomed;
    if (state.zoomed) {
      state.panX = 0; state.panY = 0;
      img.style.transform = "scale(2)";
    } else {
      img.style.transform = "";
    }
  }

  // ===== 面板 =====
  function openSheet(id) { $(id).hidden = false; }
  function closeSheet(id) { $(id).hidden = true; }

  function fillInfo() {
    if (!state.event) return;
    $("infoAlbumId").textContent = state.event.event_id;
    $("infoPhotoCount").textContent = state.event.photo_count + " " + I18N.t("photos_unit");
    $("infoShareLink").value = location.origin + "/share/" + state.event.share_token;
  }

  // ===== 事件绑定 =====
  function bindEvents() {
    // 语言切换
    $("langToggle").addEventListener("click", () => {
      I18N.setLang(I18N.getLang() === "zh" ? "en" : "zh");
      applyI18n();
    });
    // 设置
    $("settingsBtn").addEventListener("click", () => {
      $("apiInput").value = localStorage.getItem("api_base") || "/api";
      openSheet("settingsSheet");
    });
    $("apiSave").addEventListener("click", () => {
      API.setBase($("apiInput").value);
      closeSheet("settingsSheet");
      toast(I18N.t("save"));
      // 重新加载
      loadEvent();
    });
    // 信息
    $("infoBtn").addEventListener("click", () => { fillInfo(); openSheet("infoSheet"); });
    $("copyLinkBtn").addEventListener("click", () => {
      const inp = $("infoShareLink");
      inp.select();
      navigator.clipboard.writeText(inp.value).then(
        () => toast(I18N.t("copied")),
        () => { document.execCommand("copy"); toast(I18N.t("copied")); }
      );
    });
    // 抽屉关闭
    document.querySelectorAll("[data-close]").forEach((el) => {
      el.addEventListener("click", () => closeSheet(el.dataset.close));
    });

    // 灯箱
    $("lbClose").addEventListener("click", closeLightbox);
    $("lbBackdrop").addEventListener("click", closeLightbox);
    $("lbPrev").addEventListener("click", () => navLightbox(-1));
    $("lbNext").addEventListener("click", () => navLightbox(1));
    document.addEventListener("keydown", (e) => {
      if ($("lightbox").hidden) return;
      if (e.key === "Escape") closeLightbox();
      else if (e.key === "ArrowLeft") navLightbox(-1);
      else if (e.key === "ArrowRight") navLightbox(1);
    });

    // 灯箱图片双击缩放
    const stage = $("lbStage");
    const img = $("lbImg");
    img.addEventListener("dblclick", () => toggleZoom());
    stage.addEventListener("touchend", (e) => {
      if (state.zoomed) return;
      const now = Date.now();
      if (now - lastTap < 300) { toggleZoom(); e.preventDefault(); }
      lastTap = now;
    });

    // 灯箱拖拽（缩放时平移）
    let dragStart = null;
    img.addEventListener("mousedown", (e) => {
      if (!state.zoomed) return;
      dragStart = { x: e.clientX - state.panX, y: e.clientY - state.panY };
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!dragStart) return;
      state.panX = e.clientX - dragStart.x;
      state.panY = e.clientY - dragStart.y;
      img.style.transform = `scale(2) translate(${state.panX / 2}px, ${state.panY / 2}px)`;
    });
    window.addEventListener("mouseup", () => { dragStart = null; });

    // 灯箱触摸滑动切换
    let touchStartX = 0;
    stage.addEventListener("touchstart", (e) => { touchStartX = e.changedTouches[0].clientX; }, { passive: true });
    stage.addEventListener("touchend", (e) => {
      if (state.zoomed) return;
      const dx = e.changedTouches[0].clientX - touchStartX;
      if (Math.abs(dx) > 60) navLightbox(dx < 0 ? 1 : -1);
    }, { passive: true });

    // 无限滚动
    const io = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && state.hasMore && !state.loading && state.photos.length > 0) {
        loadPhotos(false);
      }
    }, { rootMargin: "600px" });
    io.observe(streamFooter);
  }

  // ===== 初始化 =====
  async function loadEvent() {
    if (!TOKEN) {
      stream.innerHTML = `<div class="empty-state">${I18N.t("link_invalid")}</div>`;
      return;
    }
    stream.innerHTML = `<div class="global-loading"><div class="lb-spinner"></div>${I18N.t("loading")}</div>`;
    try {
      const ev = await API.shareInfo(TOKEN);
      state.event = ev;
      applyI18n();
      await loadPhotos(true);
    } catch (e) {
      stream.innerHTML = `<div class="empty-state"><div class="icon">⚠</div>${I18N.t("link_invalid")}</div>`;
    }
  }

  applyI18n();
  bindEvents();
  loadEvent();
})();
