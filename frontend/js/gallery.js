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
    lbShowingOriginal: false,
    view: { scale: 1, tx: 0, ty: 0 },   // 灯箱缩放/平移状态
  };
  // 分类栏横向滚动更新回调（ScrollX 在 bindEvents 中挂载）
  let tagbarUpdate = function () {};

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
    const isEn = I18N.getLang() === "en";
    const all = [{ tag: null, count: state.event ? state.event.photo_count : 0 }];
    const list = all.concat(tags.map((t) => ({ tag: t.tag, tag_en: t.tag_en, count: t.count })));
    tagbarInner.innerHTML = "";
    list.forEach((t) => {
      const b = document.createElement("button");
      b.className = "tag-pill" + (t.tag === state.activeTag ? " active" : "");
      b.type = "button";
      const label = t.tag === null ? I18N.t("filter_all") : (isEn ? (t.tag_en || t.tag) : t.tag);
      b.innerHTML = `<span>${escapeHtml(label)}</span><span class="cnt">${t.count}</span>`;
      b.addEventListener("click", () => {
        if (state.activeTag === t.tag) return;
        state.activeTag = t.tag;
        applyI18n();
        loadPhotos(true);
      });
      tagbarInner.appendChild(b);
    });
    requestAnimationFrame(() => tagbarUpdate());
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
      img.dataset.fallback = API.url(p.fallback_preview_url);
      card.appendChild(img);
      if (p.tag) {
        const badge = document.createElement("div");
        badge.className = "tag-badge";
        badge.textContent = I18N.getLang() === "en" ? (p.tag_en || p.tag) : p.tag;
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

  // 懒加载 + 渐入 + OSS失败降级
  function lazyLoad(card, img, skeleton) {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((en) => {
        if (en.isIntersecting) {
          const src = img.dataset.src;
          const fallback = img.dataset.fallback;
          if (!src) return;
          const load = (url) => {
            img.onload = () => {
              if (skeleton && skeleton.parentNode) skeleton.parentNode.removeChild(skeleton);
              card.classList.add("in");
            };
            img.onerror = () => {
              if (fallback && img.src !== fallback) {
                load(fallback);
              } else {
                if (skeleton) skeleton.style.opacity = 0.5;
              }
            };
            img.src = url;
          };
          load(src);
          io.disconnect();
        }
      });
    }, { rootMargin: "300px" });
    io.observe(card);
  }

  // ===== 灯箱 =====
  function openLightbox(index) {
    state.lbIndex = index;
    state.lbShowingOriginal = false;
    resetZoom();
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
    resetZoom();
  }
  function navLightbox(dir) {
    const n = state.photos.length;
    if (n === 0) return;
    state.lbIndex = (state.lbIndex + dir + n) % n;
    state.lbShowingOriginal = false;
    resetZoom();
    loadLightboxImage();
    renderLightboxBar();
  }
  function loadLightboxImage() {
    const p = state.photos[state.lbIndex];
    if (!p) return;
    const img = $("lbImg");
    const spinner = $("lbSpinner");
    img.classList.remove("loaded");
    resetZoom();
    spinner.hidden = false;

    const url = state.lbShowingOriginal ? p.original_url : p.preview_url;
    const fallbackUrl = state.lbShowingOriginal ? p.fallback_original_url : p.fallback_preview_url;

    const load = (src) => {
      const tmp = new Image();
      tmp.onload = () => {
        img.src = tmp.src;
        img.classList.add("loaded");
        spinner.hidden = true;
      };
      tmp.onerror = () => {
        if (fallbackUrl && src !== API.url(fallbackUrl)) {
          load(API.url(fallbackUrl));
        } else {
          spinner.hidden = true;
        }
      };
      tmp.src = src;
    };

    load(API.url(url));
  }
  function toggleLightboxOriginal() {
    state.lbShowingOriginal = !state.lbShowingOriginal;
    loadLightboxImage();
    renderLightboxBar();
  }
  function renderLightboxBar() {
    const bar = $("lbBar");
    if (state.lbIndex < 0) { bar.innerHTML = ""; return; }
    const p = state.photos[state.lbIndex];
    if (!p) { bar.innerHTML = ""; return; }
    const rafDisabled = p.has_raf ? "" : " disabled";
    const viewBtnText = state.lbShowingOriginal ? I18N.t("view_preview") : I18N.t("view_original");
    bar.innerHTML = `
      <button class="lb-action primary" id="actViewOrig">${viewBtnText}</button>
      <button class="lb-action" id="actDlOrig">${I18N.t("download_original")}</button>
      <button class="lb-action${rafDisabled}" id="actViewRaf">${I18N.t("view_raf")}</button>
      <button class="lb-action${rafDisabled}" id="actDlRaf">${I18N.t("download_raf")}</button>
    `;
    const bind = (id, fn) => { const el = $(id); if (el) el.addEventListener("click", fn); };
    bind("actViewOrig", toggleLightboxOriginal);
    bind("actDlOrig", () => openPhotoUrl(p.original_url, true));
    bind("actViewRaf", () => p.has_raf && openPhotoUrl(p.raf_url, false));
    bind("actDlRaf", () => p.has_raf && openPhotoUrl(p.raf_url, true));
  }
  function openPhotoUrl(path, download) {
    let u = API.url(path);
    if (download) u += (u.indexOf("?") === -1 ? "?" : "&") + "download=1";
    window.open(u, "_blank");
  }

  // ===== 灯箱缩放/平移引擎 =====
  // 变换模型：transform: translate3d(tx,ty,0) scale(s)，origin 为图片中心
  // 屏幕上一点 = 视口中心 + t + s * (图片上的偏移)，据此可把任意一点作为缩放锚点。
  const MAX_SCALE = 6;        // 最大放大倍率
  const DBL_SCALE = 2.5;      // 双击放大目标倍率
  const view = state.view;
  let lastTap = 0;

  function viewport() {
    return { cx: window.innerWidth / 2, cy: window.innerHeight / 2, w: window.innerWidth, h: window.innerHeight };
  }

  // 边界限制：放大后可以拖到任意一条边，但拖不出黑边；未放大时复位居中
  function clampView() {
    if (view.scale <= 1.02) {
      view.scale = 1; view.tx = 0; view.ty = 0;
      return;
    }
    const img = $("lbImg");
    const vp = viewport();
    // offsetWidth/Height 是布局尺寸，不受 transform 影响
    const w = img.offsetWidth || 0;
    const h = img.offsetHeight || 0;
    const mx = Math.max(0, (w * view.scale - vp.w) / 2);
    const my = Math.max(0, (h * view.scale - vp.h) / 2);
    view.tx = Math.min(mx, Math.max(-mx, view.tx));
    view.ty = Math.min(my, Math.max(-my, view.ty));
  }

  function paintView(animate) {
    const img = $("lbImg");
    if (img) {
      img.classList.toggle("smooth", !!animate);
      img.style.transform = view.scale <= 1.001
        ? ""
        : `translate3d(${view.tx.toFixed(2)}px, ${view.ty.toFixed(2)}px, 0) scale(${view.scale.toFixed(4)})`;
    }
    const label = $("lbZoomReset");
    if (label) label.textContent = Math.round(view.scale * 100) + "%";
    const stageEl = $("lbStage");
    if (stageEl) stageEl.classList.toggle("is-zoomed", view.scale > 1.02);
  }

  function resetZoom() {
    view.scale = 1; view.tx = 0; view.ty = 0;
    paintView(true);
  }

  // 以屏幕上 (clientX, clientY) 为锚点缩放到 nextScale（该点屏幕位置保持不动）
  function zoomAt(clientX, clientY, nextScale, animate) {
    const s0 = view.scale || 1;
    const s1 = Math.min(MAX_SCALE, Math.max(1, nextScale));
    const vp = viewport();
    const qx = clientX - vp.cx, qy = clientY - vp.cy;
    const k = s1 / s0;
    view.tx = qx - k * (qx - view.tx);
    view.ty = qy - k * (qy - view.ty);
    view.scale = s1;
    clampView();
    paintView(animate);
  }

  function zoomBy(factor, animate) {
    const vp = viewport();
    zoomAt(vp.cx, vp.cy, view.scale * factor, animate);
  }

  // 双击/双击 tap：在点击处放大，已放大则复位
  function toggleZoomAt(clientX, clientY) {
    if (view.scale > 1.02) resetZoom();
    else zoomAt(clientX, clientY, DBL_SCALE, true);
  }

  // ===== 面板 =====
  function openSheet(id) { $(id).hidden = false; }
  function closeSheet(id) { $(id).hidden = true; }

  function fillInfo() {
    if (!state.event) return;
    $("infoAlbumId").textContent = state.event.event_id;
    $("infoPhotoCount").textContent = state.event.photo_count + " " + I18N.t("photos_unit");
    $("infoShareLink").value = location.origin + API.getAutoPrefix() + "/share/" + state.event.share_token;
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

    // 分类栏横向滚动增强：PC 鼠标拖拽 + 滚轮横向 + 左右箭头
    if (window.ScrollX) {
      tagbarUpdate = ScrollX.enable(tagbarInner, {
        wrap: $("tagbar"),
        prev: $("tagbarPrev"),
        next: $("tagbarNext"),
        step: 0.7,
      });
    }

    // 灯箱
    $("lbClose").addEventListener("click", closeLightbox);
    $("lbBackdrop").addEventListener("click", closeLightbox);
    $("lbPrev").addEventListener("click", () => navLightbox(-1));
    $("lbNext").addEventListener("click", () => navLightbox(1));

    // 缩放控件
    $("lbZoomIn").addEventListener("click", () => zoomBy(1.5, true));
    $("lbZoomOut").addEventListener("click", () => zoomBy(1 / 1.5, true));
    $("lbZoomReset").addEventListener("click", () => resetZoom());

    document.addEventListener("keydown", (e) => {
      if ($("lightbox").hidden) return;
      if (e.key === "Escape") { closeLightbox(); return; }
      if (e.key === "+" || e.key === "=") { zoomBy(1.5, true); return; }
      if (e.key === "-" || e.key === "_") { zoomBy(1 / 1.5, true); return; }
      if (e.key === "0") { resetZoom(); return; }
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        const dir = e.key === "ArrowLeft" ? -1 : 1;
        if (view.scale > 1.02) {
          view.tx += (dir === -1 ? 90 : -90);   // 放大后方向键用于平移看边角细节
          clampView(); paintView(false);
        } else {
          navLightbox(dir);
        }
      }
    });

    // ===== 灯箱手势：双击锚点缩放 / 双指缩放 / 拖动平移 / 滚轮缩放 =====
    const stage = $("lbStage");
    const img = $("lbImg");
    img.draggable = false;
    let lastTouchAt = 0;

    // PC：双击在鼠标位置放大，再双击复位
    stage.addEventListener("dblclick", (e) => {
      if (state.lbIndex < 0) return;
      if (Date.now() - lastTouchAt < 800) return;   // 触摸端的合成 dblclick，交给 tap 逻辑
      e.preventDefault();
      toggleZoomAt(e.clientX, e.clientY);
    });

    // PC：滚轮以光标为锚点缩放（触控板捏合/ctrl+滚轮同样是 wheel 事件）
    stage.addEventListener("wheel", (e) => {
      if (state.lbIndex < 0) return;
      if (e.cancelable) e.preventDefault();
      const factor = Math.exp(-e.deltaY * 0.0018);
      zoomAt(e.clientX, e.clientY, view.scale * factor, false);
    }, { passive: false });

    const pointers = new Map();
    let gesture = null;
    const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    const pinchPts = () => Array.from(pointers.values()).slice(0, 2);

    stage.addEventListener("pointerdown", (e) => {
      if (state.lbIndex < 0) return;
      if (e.pointerType === "mouse" && e.button !== 0) return;
      if (e.pointerType === "touch") {
        lastTouchAt = Date.now();
        if (e.cancelable) e.preventDefault();   // 抑制合成鼠标事件（避免与 dblclick 重复触发）
      }
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      try { stage.setPointerCapture(e.pointerId); } catch (_) {}

      if (pointers.size === 1) {
        gesture = {
          mode: "pan", pointerType: e.pointerType,
          sx: e.clientX, sy: e.clientY, t0x: view.tx, t0y: view.ty,
          moved: false, t: Date.now(),
        };
      } else if (pointers.size === 2) {
        const pts = pinchPts();
        const vp = viewport();
        const m = mid(pts[0], pts[1]);
        gesture = {
          mode: "pinch",
          d0: dist(pts[0], pts[1]) || 1, mid0: m, s0: view.scale,
          t0x: view.tx, t0y: view.ty,
          mqx: m.x - vp.cx, mqy: m.y - vp.cy,
          moved: true, t: Date.now(),
        };
        img.classList.remove("smooth");
      }
    });

    stage.addEventListener("pointermove", (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (!gesture) return;
      if (e.cancelable) e.preventDefault();

      if (gesture.mode === "pinch" && pointers.size >= 2) {
        const pts = pinchPts();
        const vp = viewport();
        const m = mid(pts[0], pts[1]);
        const s1 = Math.min(MAX_SCALE, Math.max(1, gesture.s0 * (dist(pts[0], pts[1]) / gesture.d0)));
        const k = s1 / gesture.s0;
        // 以双指中点为锚点缩放，同时跟随双指中点移动做平移
        view.tx = (gesture.mqx - k * (gesture.mqx - gesture.t0x)) + (m.x - gesture.mid0.x);
        view.ty = (gesture.mqy - k * (gesture.mqy - gesture.t0y)) + (m.y - gesture.mid0.y);
        view.scale = s1;
        clampView();
        paintView(false);
        return;
      }

      if (gesture.mode === "pan") {
        const dx = e.clientX - gesture.sx;
        const dy = e.clientY - gesture.sy;
        if (!gesture.moved && Math.hypot(dx, dy) < 8) return;
        gesture.moved = true;
        if (view.scale <= 1.02) return;   // 未放大：位移交给「左右滑动切换上下张」
        img.classList.remove("smooth");
        view.tx = gesture.t0x + dx;
        view.ty = gesture.t0y + dy;
        clampView();
        paintView(false);
      }
    });

    function endPointer(e) {
      if (!pointers.has(e.pointerId)) return;
      const g = gesture;
      pointers.delete(e.pointerId);

      if (pointers.size === 0) {
        gesture = null;
        if (!g || g.mode !== "pan") return;
        const dx = e.clientX - g.sx, dy = e.clientY - g.sy;
        const dur = Date.now() - g.t;
        if (!g.moved && dur < 400 && Math.hypot(dx, dy) < 10) {
          // 单击（tap）：触摸端 320ms 内两次即双击 → 在触点处放大/复位
          if (g.pointerType === "touch") {
            const now = Date.now();
            if (now - lastTap < 320) { lastTap = 0; toggleZoomAt(e.clientX, e.clientY); }
            else lastTap = now;
          }
        } else if (view.scale <= 1.02 && g.pointerType === "touch" && dur < 900
                   && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.2) {
          navLightbox(dx < 0 ? 1 : -1);   // 未放大：左右滑动切换上下张
        }
        return;
      }

      // 双指抬起一根：剩下那根重新作为平移起点，避免画面跳变
      if (pointers.size === 1) {
        const rest = Array.from(pointers.values())[0];
        gesture = {
          mode: "pan", pointerType: "touch",
          sx: rest.x, sy: rest.y, t0x: view.tx, t0y: view.ty,
          moved: true, t: Date.now(),
        };
      }
    }
    stage.addEventListener("pointerup", endPointer);
    stage.addEventListener("pointercancel", endPointer);
    stage.addEventListener("lostpointercapture", endPointer);

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
      // 仅当本地照片已被手动清理（local_cleared）才拦截分享页；
      // 仅过期的相册仍可正常浏览，文件不会自动删除。
      await loadPhotos(true);
    } catch (e) {
      const msg = (e && e.msg) ? e.msg : I18N.t("link_invalid");
      stream.innerHTML = `<div class="empty-state"><div class="icon">⚠</div>${escapeHtml(msg)}</div>`;
    }
  }

  applyI18n();
  bindEvents();
  loadEvent();
})();
