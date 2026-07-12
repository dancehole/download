(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const state = {
    events: [],
    currentEvent: null,
    jpgFiles: [],
    rafFiles: [],
  };

  function toast(msg, type) {
    const el = $("toast");
    el.textContent = msg;
    el.className = "toast" + (type ? " " + type : "");
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.hidden = true; }, 2000);
  }

  function applyI18n() {
    document.documentElement.lang = I18N.getLang() === "en" ? "en" : "zh";
    document.querySelectorAll("[data-i18n]").forEach((el) => {
      el.textContent = I18N.t(el.getAttribute("data-i18n"));
    });
    document.querySelectorAll("[data-i18n-ph]").forEach((el) => {
      el.setAttribute("placeholder", I18N.t(el.getAttribute("data-i18n-ph")));
    });
    document.querySelectorAll(".lang-opt").forEach((o) => {
      o.classList.toggle("active", o.dataset.lang === I18N.getLang());
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ===== 登录态 =====
  async function checkAuth() {
    if (!API.getToken()) { showLogin(); return; }
    try {
      await API.me();
      showApp();
    } catch (e) {
      API.clearToken();
      showLogin();
    }
  }

  function showLogin() {
    $("authScreen").hidden = false;
    $("app").hidden = true;
  }
  function showApp() {
    $("authScreen").hidden = true;
    $("app").hidden = false;
    showView("viewEvents");
    loadEvents();
  }
  function showView(id) {
    $("viewEvents").hidden = id !== "viewEvents";
    $("viewDetail").hidden = id !== "viewDetail";
  }

  async function doLogin() {
    const u = $("loginUser").value.trim();
    const p = $("loginPass").value;
    const err = $("loginError");
    if (!u) { err.textContent = I18N.t("empty_username"); err.hidden = false; return; }
    if (!p) { err.textContent = I18N.t("empty_password"); err.hidden = false; return; }
    err.hidden = true;
    $("loginSubmit").disabled = true;
    try {
      const data = await API.login(u, p);
      API.setToken(data.token);
      showApp();
    } catch (e) {
      err.textContent = (e && e.msg) || I18N.t("login_failed");
      err.hidden = false;
    } finally {
      $("loginSubmit").disabled = false;
    }
  }

  // ===== 活动列表 =====
  async function loadEvents() {
    const grid = $("eventsGrid");
    grid.innerHTML = `<div class="empty">${I18N.t("loading")}</div>`;
    try {
      state.events = await API.listEvents();
      renderEvents();
    } catch (e) {
      if (e && (e.status === 401)) { API.clearToken(); showLogin(); return; }
      grid.innerHTML = `<div class="empty">${I18N.t("load_failed")}</div>`;
    }
  }

  function renderEvents() {
    const grid = $("eventsGrid");
    if (state.events.length === 0) {
      grid.innerHTML = `<div class="empty">${I18N.t("no_events")}</div>`;
      return;
    }
    grid.innerHTML = state.events.map((ev) => `
      <div class="event-card" data-id="${escapeHtml(ev.event_id)}">
        <h3>${escapeHtml(ev.event_name)}</h3>
        <div class="meta">
          <span class="chip mono">ID: ${escapeHtml(ev.event_id)}</span>
          <span class="chip">${I18N.t("photos_count", { n: ev.photo_count })}</span>
        </div>
        <div class="actions">
          <button class="btn btn-primary sm" data-act="enter" data-id="${escapeHtml(ev.event_id)}">${I18N.t("enter_event")}</button>
          <button class="btn btn-ghost sm" data-act="copy" data-token="${escapeHtml(ev.share_token)}">${I18N.t("copy")}</button>
          <button class="btn btn-ghost sm" data-act="open" data-token="${escapeHtml(ev.share_token)}">${I18N.t("open_share")}</button>
        </div>
      </div>
    `).join("");
    grid.querySelectorAll("[data-act]").forEach((b) => {
      b.addEventListener("click", () => {
        const act = b.dataset.act;
        if (act === "enter") openEvent(b.dataset.id);
        else if (act === "copy") copyShare(b.dataset.token);
        else if (act === "open") window.open("/share/" + b.dataset.token, "_blank");
      });
    });
  }

  async function createEvent() {
    const name = $("createName").value.trim();
    if (!name) { toast(I18N.t("event_name"), "err"); return; }
    $("createBtn").disabled = true;
    try {
      await API.createEvent(name);
      $("createName").value = "";
      toast(I18N.t("create_event") + " ✓", "ok");
      await loadEvents();
    } catch (e) {
      toast((e && e.msg) || I18N.t("load_failed"), "err");
    } finally {
      $("createBtn").disabled = false;
    }
  }

  async function enterById() {
    const id = $("enterId").value.trim();
    if (!id) return;
    openEvent(id);
  }

  // ===== 活动详情 =====
  async function openEvent(eventId) {
    showView("viewDetail");
    $("enterId").value = "";
    try {
      const ev = await API.getEvent(eventId);
      state.currentEvent = ev;
      renderDetail();
      await loadThumbs();
    } catch (e) {
      toast(I18N.t("not_found_event"), "err");
      showView("viewEvents");
    }
  }

  function renderDetail() {
    const ev = state.currentEvent;
    $("detailName").textContent = ev.event_name;
    $("detailId").textContent = "ID: " + ev.event_id;
    $("detailCount").textContent = I18N.t("photos_count", { n: ev.photo_count });
    $("detailCreated").textContent = I18N.t("created_at") + ": " + (ev.created_at || "");
    $("shareLink").value = location.origin + "/share/" + ev.share_token;
  }

  async function loadThumbs() {
    const grid = $("thumbGrid");
    grid.innerHTML = `<div class="loading-inline">${I18N.t("loading")}</div>`;
    try {
      const data = await API.sharePhotos(state.currentEvent.share_token, { size: 100 });
      const photos = data.photos || [];
      if (photos.length === 0) { grid.innerHTML = `<div class="empty">${I18N.t("no_photos")}</div>`; return; }
      grid.innerHTML = photos.map((p) => `
        <div class="thumb">
          <img loading="lazy" src="${API.url(p.preview_url)}" alt="">
          ${p.tag ? `<span class="ttag">${escapeHtml(I18N.getLang() === "en" ? (p.tag_en || p.tag) : p.tag)}</span>` : ""}
          ${p.has_raf ? `<span class="traf"></span>` : ""}
        </div>
      `).join("");
    } catch (e) {
      grid.innerHTML = `<div class="empty">${I18N.t("load_failed")}</div>`;
    }
  }

  async function copyShare(token) {
    const link = location.origin + "/share/" + token;
    try {
      await navigator.clipboard.writeText(link);
      toast(I18N.t("copied"), "ok");
    } catch (e) {
      $("shareLink").value = link;
      $("shareLink").select();
      document.execCommand("copy");
      toast(I18N.t("copied"), "ok");
    }
  }

  async function regenShare() {
    if (!state.currentEvent) return;
    if (!confirm(I18N.t("regen_share_confirm"))) return;
    try {
      const data = await API.regenShare(state.currentEvent.event_id);
      state.currentEvent.share_token = data.share_token;
      renderDetail();
      toast(I18N.t("regen_share") + " ✓", "ok");
    } catch (e) {
      toast((e && e.msg) || I18N.t("load_failed"), "err");
    }
  }

  // ===== 上传 =====
  function setupDropzone(zoneId, inputId, listId, kind) {
    const zone = $(zoneId);
    const input = $(inputId);
    const list = $(listId);
    zone.addEventListener("click", () => input.click());
    zone.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") input.click(); });
    input.addEventListener("change", () => setFiles(input.files, kind, list));
    ["dragenter", "dragover"].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add("drag"); }));
    ["dragleave", "drop"].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove("drag"); }));
    zone.addEventListener("drop", (e) => {
      const files = e.dataTransfer.files;
      if (files && files.length) setFiles(files, kind, list);
    });
  }

  function setFiles(fileList, kind, listEl) {
    const arr = Array.from(fileList);
    if (kind === "jpg") {
      state.jpgFiles = arr.filter((f) => /\.jpe?g$/i.test(f.name));
      renderFileList(listEl, state.jpgFiles);
      $("uploadBtn").disabled = state.jpgFiles.length === 0;
    } else {
      state.rafFiles = arr.filter((f) => /\.raf$/i.test(f.name));
      renderFileList(listEl, state.rafFiles);
      $("uploadRafBtn").disabled = state.rafFiles.length === 0;
    }
  }
  function renderFileList(el, files) {
    if (files.length === 0) { el.innerHTML = ""; return; }
    el.innerHTML = files.map((f) => `<div class="fitem">${escapeHtml(f.name)} <span style="color:#bbb">(${(f.size / 1024 / 1024).toFixed(1)}MB)</span></div>`).join("");
  }

  async function uploadPhotos() {
    if (state.jpgFiles.length === 0) return;
    const btn = $("uploadBtn");
    const tag = $("uploadTag").value.trim() || null;
    const tagEn = $("uploadTagEn").value.trim() || null;
    btn.disabled = true;
    const orig = btn.textContent;
    btn.textContent = I18N.t("uploading");
    try {
      const data = await API.uploadPhotos(state.currentEvent.event_id, state.jpgFiles, tag, tagEn);
      toast(I18N.t("upload_success", { n: data.uploaded }), "ok");
      state.jpgFiles = [];
      $("jpgFiles").innerHTML = "";
      $("jpgInput").value = "";
      $("uploadTag").value = "";
      $("uploadTagEn").value = "";
      $("uploadBtn").disabled = true;
      // 刷新活动信息与缩略图
      state.currentEvent = await API.getEvent(state.currentEvent.event_id);
      renderDetail();
      await loadThumbs();
    } catch (e) {
      toast((e && e.msg) || I18N.t("load_failed"), "err");
    } finally {
      btn.disabled = state.jpgFiles.length > 0;
      btn.textContent = orig;
    }
  }

  async function uploadRaf() {
    if (state.rafFiles.length === 0) return;
    const btn = $("uploadRafBtn");
    btn.disabled = true;
    const orig = btn.textContent;
    btn.textContent = I18N.t("uploading");
    try {
      const data = await API.uploadRaf(state.currentEvent.event_id, state.rafFiles);
      toast(I18N.t("upload_raf_success", { saved: data.saved_raf, matched: data.matched }), "ok");
      state.rafFiles = [];
      $("rafFiles").innerHTML = "";
      $("rafInput").value = "";
      $("uploadRafBtn").disabled = true;
      await loadThumbs();
    } catch (e) {
      toast((e && e.msg) || I18N.t("load_failed"), "err");
    } finally {
      btn.disabled = state.rafFiles.length > 0;
      btn.textContent = orig;
    }
  }

  // ===== 事件绑定 =====
  function bindEvents() {
    $("loginSubmit").addEventListener("click", doLogin);
    $("loginPass").addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });
    $("logoutBtn").addEventListener("click", () => { API.clearToken(); showLogin(); });

    $("createBtn").addEventListener("click", createEvent);
    $("createName").addEventListener("keydown", (e) => { if (e.key === "Enter") createEvent(); });
    $("enterBtn").addEventListener("click", enterById);
    $("enterId").addEventListener("keydown", (e) => { if (e.key === "Enter") enterById(); });

    $("navEvents").addEventListener("click", () => { showView("viewEvents"); loadEvents(); });
    $("backBtn").addEventListener("click", () => { showView("viewEvents"); loadEvents(); });

    $("copyShare").addEventListener("click", () => copyShare(state.currentEvent.share_token));
    $("openShare").addEventListener("click", () => window.open("/share/" + state.currentEvent.share_token, "_blank"));
    $("regenBtn").addEventListener("click", regenShare);

    setupDropzone("dropzoneJpg", "jpgInput", "jpgFiles", "jpg");
    setupDropzone("dropzoneRaf", "rafInput", "rafFiles", "raf");
    $("uploadBtn").addEventListener("click", uploadPhotos);
    $("uploadRafBtn").addEventListener("click", uploadRaf);

    $("langToggle").addEventListener("click", toggleLang);
    $("langToggle2").addEventListener("click", toggleLang);
  }
  function toggleLang() {
    I18N.setLang(I18N.getLang() === "zh" ? "en" : "zh");
    applyI18n();
    if (state.currentEvent) renderDetail();
    if (!$("viewEvents").hidden) renderEvents();
  }

  // ===== 初始化 =====
  applyI18n();
  bindEvents();
  checkAuth();
})();
