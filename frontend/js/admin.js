(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const state = {
    events: [],
    currentEvent: null,
    files: [],
    jpgFiles: [],
    rafFiles: [],
    pickedFile: null,
  };

  function toast(msg, type) {
    const el = $("toast");
    el.textContent = msg;
    el.className = "toast" + (type ? " " + type : "");
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.hidden = true; }, 2500);
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
    // 下拉框内的 option 文案
    document.querySelectorAll("select option[data-i18n]").forEach((o) => {
      o.textContent = I18N.t(o.getAttribute("data-i18n"));
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
    $("viewSettings").hidden = id !== "viewSettings";
    $("viewFiles").hidden = id !== "viewFiles";
    $("navEvents").classList.toggle("active", id === "viewEvents" || id === "viewDetail");
    $("navFiles").classList.toggle("active", id === "viewFiles");
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

  // ===== 新建弹窗 =====
  function openCreateModal() {
    $("createModal").hidden = false;
  }
  function closeCreateModal() {
    $("createModal").hidden = true;
  }
  function openAlbumNameModal() {
    closeCreateModal();
    $("albumNameModal").hidden = false;
    setTimeout(() => $("albumNameInput").focus(), 50);
  }
  function closeAlbumNameModal() {
    $("albumNameModal").hidden = true;
  }

  async function confirmCreateAlbum() {
    const name = $("albumNameInput").value.trim();
    if (!name) { toast(I18N.t("event_name_required"), "err"); return; }
    const btn = $("albumNameConfirm");
    btn.disabled = true;
    const orig = btn.textContent;
    btn.textContent = I18N.t("saving");
    try {
      await API.createEvent(name);
      $("albumNameInput").value = "";
      closeAlbumNameModal();
      toast(I18N.t("create_event") + " ✓", "ok");
      showView("viewEvents");
      await loadEvents();
    } catch (e) {
      toast((e && e.msg) || I18N.t("load_failed"), "err");
    } finally {
      btn.disabled = false;
      btn.textContent = orig;
    }
  }

  function chooseCreateFile() {
    closeCreateModal();
    showView("viewFiles");
    loadFiles();
    setTimeout(() => $("fileInput").click(), 150);
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
          <button class="btn btn-danger sm" data-act="delete" data-id="${escapeHtml(ev.event_id)}" data-name="${escapeHtml(ev.event_name)}">${I18N.t("delete_album")}</button>
        </div>
      </div>
    `).join("");
    grid.querySelectorAll("[data-act]").forEach((b) => {
      b.addEventListener("click", () => {
        const act = b.dataset.act;
        if (act === "enter") openEvent(b.dataset.id);
        else if (act === "copy") copyShare(b.dataset.token);
        else if (act === "open") window.open(API.getAutoPrefix() + "/share/" + b.dataset.token, "_blank");
        else if (act === "delete") deleteEvent(b.dataset.id, b.dataset.name);
      });
    });
  }

  async function enterById() {
    const id = $("enterId").value.trim();
    if (!id) return;
    openEvent(id);
  }

  // ===== 共享文件 =====
  async function loadFiles() {
    try {
      state.files = await API.listFiles();
      renderFiles();
    } catch (e) {
      if (e && (e.status === 401)) { API.clearToken(); showLogin(); return; }
      toast((e && e.msg) || I18N.t("load_failed"), "err");
    }
  }

  function renderFiles() {
    const tbody = $("fileTableBody");
    const empty = $("fileEmpty");
    $("fileCountChip").textContent = state.files.length;
    const rows = state.files.map((f) => {
      const expired = !!f.expired;
      const expHtml = expired
        ? `<span class="status-expired">${I18N.t("expired")}</span>`
        : (f.expires_at_text ? `<span class="status-valid">${escapeHtml(f.expires_at_text)}</span>` : `<span class="status-forever">${I18N.t("expire_never")}</span>`);
      return `
        <tr data-id="${escapeHtml(f.file_id)}" class="${expired ? "row-expired" : ""}">
          <td class="fname" title="${escapeHtml(f.filename)}">${escapeHtml(f.filename)}</td>
          <td class="fmeta">${escapeHtml(f.file_size_text)}</td>
          <td class="fmeta">${escapeHtml(f.created_at || "")}</td>
          <td class="fmeta">${expHtml}</td>
          <td class="fmeta">${f.download_count}</td>
          <td class="fops">
            <button class="action-btn copy-btn" data-act="copy" data-token="${escapeHtml(f.share_token)}">${I18N.t("copy_link")}</button>
            <button class="action-btn open-btn" data-act="open" data-token="${escapeHtml(f.share_token)}">${I18N.t("open_share")}</button>
            <button class="action-btn regen-btn" data-act="regen" data-id="${escapeHtml(f.file_id)}">${I18N.t("regen_share")}</button>
            <button class="action-btn del-btn" data-act="delete" data-id="${escapeHtml(f.file_id)}">${I18N.t("delete")}</button>
          </td>
        </tr>
      `;
    }).join("");
    tbody.innerHTML = rows;
    empty.hidden = state.files.length > 0;
    tbody.querySelectorAll("[data-act]").forEach((b) => {
      b.addEventListener("click", () => {
        const act = b.dataset.act;
        if (act === "copy") copyFileLink(b.dataset.token);
        else if (act === "open") window.open(API.getAutoPrefix() + "/share/files/" + b.dataset.token, "_blank");
        else if (act === "regen") regenFileLink(b.dataset.id);
        else if (act === "delete") deleteSharedFile(b.dataset.id);
      });
    });
  }

  function copyFileLink(token) {
    const link = location.origin + API.getAutoPrefix() + "/share/files/" + token;
    copyText(link);
  }

  function copyText(text) {
    const done = () => toast(I18N.t("copied"), "ok");
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
    } else {
      fallbackCopy(text, done);
    }
  }
  function fallbackCopy(text, done) {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); done(); } catch (e) { toast(I18N.t("copy_failed"), "err"); }
    document.body.removeChild(ta);
  }

  async function regenFileLink(fileId) {
    if (!confirm(I18N.t("regen_share_confirm"))) return;
    try {
      const data = await API.regenFileShare(fileId);
      copyText(location.origin + API.getAutoPrefix() + "/share/files/" + data.share_token);
      await loadFiles();
    } catch (e) {
      toast((e && e.msg) || I18N.t("load_failed"), "err");
    }
  }

  async function deleteSharedFile(fileId) {
    if (!confirm(I18N.t("delete_file_confirm"))) return;
    try {
      await API.deleteFile(fileId);
      toast(I18N.t("delete_file_success"), "ok");
      await loadFiles();
    } catch (e) {
      toast((e && e.msg) || I18N.t("delete_file_failed"), "err");
    }
  }

  function pickFile(file) {
    state.pickedFile = file;
    const el = $("filePicked");
    if (!file) { el.innerHTML = ""; $("fileUploadBtn").disabled = true; return; }
    el.innerHTML = `<div class="fitem">📄 ${escapeHtml(file.name)} <span style="color:#bbb">(${(file.size / 1024 / 1024).toFixed(1)}MB)</span></div>`;
    $("fileUploadBtn").disabled = false;
  }

  async function uploadSharedFile() {
    if (!state.pickedFile) return;
    const btn = $("fileUploadBtn");
    const expire = parseInt($("fileExpireSelect").value, 10) || 0;
    btn.disabled = true;
    const orig = btn.textContent;
    btn.textContent = I18N.t("uploading");
    try {
      const data = await API.uploadFile(state.pickedFile, expire);
      const link = location.origin + API.getAutoPrefix() + data.share_url;
      copyText(link);
      toast(I18N.t("upload_file_success") + " ✓", "ok");
      state.pickedFile = null;
      $("fileInput").value = "";
      $("filePicked").innerHTML = "";
      btn.disabled = true;
      await loadFiles();
    } catch (e) {
      toast((e && e.msg) || I18N.t("upload_file_failed"), "err");
    } finally {
      btn.disabled = state.pickedFile !== null;
      btn.textContent = orig;
    }
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
    $("shareLink").value = location.origin + API.getAutoPrefix() + "/share/" + ev.share_token;
    $("previewSizeSelect").value = ev.preview_size || 640;
    $("eventUseOss").checked = ev.use_oss !== false;
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
    const link = location.origin + API.getAutoPrefix() + "/share/" + token;
    copyText(link);
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

  async function deleteEvent(eventId, eventName) {
    // 二次确认：敏感操作
    const name = eventName || (state.currentEvent && state.currentEvent.event_name) || eventId;
    if (!confirm(I18N.t("delete_album_confirm1", { name: name }))) return;
    if (!confirm(I18N.t("delete_album_confirm2"))) return;
    try {
      await API.deleteEvent(eventId);
      toast(I18N.t("delete_album_success"), "ok");
      state.currentEvent = null;
      showView("viewEvents");
      await loadEvents();
    } catch (e) {
      toast((e && e.msg) || I18N.t("delete_album_failed"), "err");
    }
  }

  async function saveEventSettings() {
    if (!state.currentEvent) return;
    const btn = $("saveEventSettingsBtn");
    btn.disabled = true;
    const orig = btn.textContent;
    btn.textContent = I18N.t("saving");
    try {
      const settings = {
        preview_size: parseInt($("previewSizeSelect").value),
        use_oss: $("eventUseOss").checked,
      };
      const data = await API.updateEventSettings(state.currentEvent.event_id, settings);
      state.currentEvent = data;
      renderDetail();
      toast(I18N.t("save_success"), "ok");
    } catch (e) {
      toast((e && e.msg) || I18N.t("save_failed"), "err");
    } finally {
      btn.disabled = false;
      btn.textContent = orig;
    }
  }

  // ===== 上传照片 =====
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
      state.jpgFiles = arr.filter((f) => /\\.jpe?g$/i.test(f.name));
      renderFileList(listEl, state.jpgFiles);
      $("uploadBtn").disabled = state.jpgFiles.length === 0;
    } else {
      state.rafFiles = arr.filter((f) => /\\.raf$/i.test(f.name));
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

  // ===== 设置 =====
  async function loadOssSettings() {
    try {
      const cfg = await API.getOssSettings();
      $("ossEnabled").checked = cfg.enabled;
      $("ossAccessKeyId").value = cfg.access_key_id || "";
      $("ossAccessKeySecret").value = cfg.access_key_secret_masked || "";
      $("ossEndpoint").value = cfg.endpoint || "";
      $("ossBucket").value = cfg.bucket || "";
      $("ossCustomDomain").value = cfg.custom_domain || "";
      $("ossSignTtl").value = cfg.sign_url_ttl || 3600;
    } catch (e) {
      toast((e && e.msg) || I18N.t("load_failed"), "err");
    }
  }

  async function saveOssSettings() {
    const btn = $("saveSettingsBtn");
    btn.disabled = true;
    const orig = btn.textContent;
    btn.textContent = I18N.t("saving");
    try {
      const cfg = {
        enabled: $("ossEnabled").checked,
        access_key_id: $("ossAccessKeyId").value.trim(),
        access_key_secret: $("ossAccessKeySecret").value,
        endpoint: $("ossEndpoint").value.trim(),
        bucket: $("ossBucket").value.trim(),
        custom_domain: $("ossCustomDomain").value.trim(),
        sign_url_ttl: parseInt($("ossSignTtl").value, 10) || 3600,
      };
      const result = await API.updateOssSettings(cfg);
      $("ossAccessKeySecret").value = result.access_key_secret_masked || "";
      toast(I18N.t("save_success"), "ok");
    } catch (e) {
      toast((e && e.msg) || I18N.t("save_failed"), "err");
    } finally {
      btn.disabled = false;
      btn.textContent = orig;
    }
  }

  async function testOssConnection() {
    const btn = $("testOssBtn");
    btn.disabled = true;
    const orig = btn.textContent;
    btn.textContent = I18N.t("testing");
    try {
      await API.testOss();
      toast(I18N.t("oss_test_success"), "ok");
    } catch (e) {
      toast((e && e.msg) || I18N.t("oss_test_failed"), "err");
    } finally {
      btn.disabled = false;
      btn.textContent = orig;
    }
  }

  function openSettings() {
    showView("viewSettings");
    loadOssSettings();
  }

  // ===== 事件绑定 =====
  function bindEvents() {
    $("loginSubmit").addEventListener("click", doLogin);
    $("loginPass").addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });
    $("logoutBtn").addEventListener("click", () => { API.clearToken(); showLogin(); });

    $("createBtn").addEventListener("click", openCreateModal);
    $("createModalClose").addEventListener("click", closeCreateModal);
    $("createModal").addEventListener("click", (e) => { if (e.target === $("createModal")) closeCreateModal(); });
    $("createAlbumOption").addEventListener("click", openAlbumNameModal);
    $("createFileOption").addEventListener("click", chooseCreateFile);
    $("albumNameClose").addEventListener("click", closeAlbumNameModal);
    $("albumNameModal").addEventListener("click", (e) => { if (e.target === $("albumNameModal")) closeAlbumNameModal(); });
    $("albumNameConfirm").addEventListener("click", confirmCreateAlbum);
    $("albumNameInput").addEventListener("keydown", (e) => { if (e.key === "Enter") confirmCreateAlbum(); });

    $("enterBtn").addEventListener("click", enterById);
    $("enterId").addEventListener("keydown", (e) => { if (e.key === "Enter") enterById(); });

    $("navEvents").addEventListener("click", () => { showView("viewEvents"); loadEvents(); });
    $("navFiles").addEventListener("click", () => { showView("viewFiles"); loadFiles(); });
    $("backBtn").addEventListener("click", () => { showView("viewEvents"); loadEvents(); });
    $("settingsBtn").addEventListener("click", openSettings);
    $("backFromSettings").addEventListener("click", () => { showView("viewEvents"); loadEvents(); });
    $("saveSettingsBtn").addEventListener("click", saveOssSettings);
    $("testOssBtn").addEventListener("click", testOssConnection);

    $("copyShare").addEventListener("click", () => copyShare(state.currentEvent.share_token));
    $("openShare").addEventListener("click", () => window.open(API.getAutoPrefix() + "/share/" + state.currentEvent.share_token, "_blank"));
    $("regenBtn").addEventListener("click", regenShare);
    $("deleteAlbumBtn").addEventListener("click", () => {
      if (!state.currentEvent) return;
      deleteEvent(state.currentEvent.event_id, state.currentEvent.event_name);
    });
    $("saveEventSettingsBtn").addEventListener("click", saveEventSettings);

    setupDropzone("dropzoneJpg", "jpgInput", "jpgFiles", "jpg");
    setupDropzone("dropzoneRaf", "rafInput", "rafFiles", "raf");
    $("uploadBtn").addEventListener("click", uploadPhotos);
    $("uploadRafBtn").addEventListener("click", uploadRaf);

    // 共享文件
    $("fileInput").addEventListener("change", () => pickFile($("fileInput").files[0] || null));
    $("fileUploadBtn").addEventListener("click", uploadSharedFile);
    $("fileUploadBtn").disabled = true;

    $("langToggle").addEventListener("click", toggleLang);
    $("langToggle2").addEventListener("click", toggleLang);
  }
  function toggleLang() {
    I18N.setLang(I18N.getLang() === "zh" ? "en" : "zh");
    applyI18n();
    if (state.currentEvent) renderDetail();
    if (!$("viewEvents").hidden) renderEvents();
    if (!$("viewFiles").hidden) renderFiles();
  }

  // ===== 初始化 =====
  applyI18n();
  bindEvents();
  checkAuth();
})();
