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
    renameTag: null,   // 当前正在重命名的标签 {tag, tag_en, count}
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
      await API.createEvent(name, {
        expires_in_hours: parseInt($("albumExpireSelect").value, 10) || 0,
      });
      $("albumNameInput").value = "";
      $("albumExpireSelect").value = "0";
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

  // ===== 空间清理（手动）=====
  async function clearOss() {
    if (!state.currentEvent) return;
    if (!confirm(I18N.t("clear_oss_confirm"))) return;
    try {
      await API.clearOss(state.currentEvent.event_id);
      toast(I18N.t("clear_oss_success"), "ok");
      state.currentEvent = await API.getEvent(state.currentEvent.event_id);
      renderDetail();
      await loadThumbs();   // OSS key 已清空，刷新缩略图走本地回退
    } catch (e) {
      toast((e && e.msg) || I18N.t("load_failed"), "err");
    }
  }

  async function clearLocal() {
    if (!state.currentEvent) return;
    if (!confirm(I18N.t("clear_local_confirm"))) return;
    try {
      const r = await API.clearLocal(state.currentEvent.event_id);
      toast(I18N.t("clear_local_success", { size: (r && r.freed_text) || "" }), "ok");
      state.currentEvent = await API.getEvent(state.currentEvent.event_id);
      renderDetail();
      await loadThumbs();   // 照片行已清空，列表显示「暂无照片」
    } catch (e) {
      toast((e && e.msg) || I18N.t("load_failed"), "err");
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

  // 相册卡片上的有效期状态：已清理 > 已过期 > 具体时间 > 永不过期
  function expireChipHtml(ev) {
    if (ev.purged) {
      return `<span class="chip chip-danger">${I18N.t("album_purged")}</span>`;
    }
    if (ev.expired) {
      return `<span class="chip chip-warn">${I18N.t("expired")}</span>`;
    }
    if (ev.expires_at_text) {
      return `<span class="chip chip-soft">${I18N.t("expire")} ${escapeHtml(ev.expires_at_text)}</span>`;
    }
    return `<span class="chip chip-soft">${I18N.t("expire_never")}</span>`;
  }

  function renderEvents() {
    const grid = $("eventsGrid");
    if (state.events.length === 0) {
      grid.innerHTML = `<div class="empty">${I18N.t("no_events")}</div>`;
      return;
    }
    grid.innerHTML = state.events.map((ev) => `
      <div class="event-card ${ev.purged ? "is-purged" : ""}" data-id="${escapeHtml(ev.event_id)}">
        <h3>${escapeHtml(ev.event_name)}</h3>
        <div class="meta">
          <span class="chip mono">ID: ${escapeHtml(ev.event_id)}</span>
          <span class="chip">${I18N.t("photos_count", { n: ev.photo_count })}</span>
          ${expireChipHtml(ev)}
        </div>
        <div class="meta">
          <span class="chip chip-stat">${I18N.t("stat_combined", { v: ev.view_count || 0, d: ev.download_count || 0 })}</span>
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
          <td class="fmeta">${f.view_count || 0}</td>
          <td class="fmeta">${f.download_count || 0}</td>
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
    $("uploadTag").value = "";
    $("uploadTagEn").value = "";
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
    $("detailStats").textContent = I18N.t("stat_combined", {
      v: ev.view_count || 0, d: ev.download_count || 0,
    });
    $("detailExpire").textContent = ev.expires_at_text
      ? I18N.t("expire") + " " + ev.expires_at_text
      : I18N.t("expire_never");
    $("detailExpire").className = "chip" + (ev.purged ? " chip-danger" : (ev.expired ? " chip-warn" : " chip-soft"));

    // 空间占用提示（提醒“文件占用 xx 空间”）
    const storageEl = $("storageInfo");
    if (ev.local_cleared) {
      storageEl.textContent = I18N.t("storage_local_cleared");
    } else if (ev.oss_cleared) {
      storageEl.textContent = I18N.t("storage_oss_cleared", { size: ev.storage_size_text || I18N.t("storage_none") });
    } else if (ev.storage_size) {
      storageEl.textContent = I18N.t("storage_occupied", { size: ev.storage_size_text });
    } else {
      storageEl.textContent = I18N.t("storage_none");
    }

    // 已清理提示（本地照片已删 / OSS 已清空）
    const notice = $("purgedNotice");
    if (ev.local_cleared) {
      $("purgedNoticeTitle").textContent = I18N.t("cleaned_local_title");
      $("purgedNoticeDesc").textContent = I18N.t("cleaned_local_desc");
      notice.hidden = false;
    } else if (ev.oss_cleared) {
      $("purgedNoticeTitle").textContent = I18N.t("cleaned_oss_title");
      $("purgedNoticeDesc").textContent = I18N.t("cleaned_oss_desc");
      notice.hidden = false;
    } else {
      notice.hidden = true;
    }

    // 已清理的部分禁用对应按钮，避免重复操作
    $("clearOssBtn").disabled = !!ev.oss_cleared;
    $("clearLocalBtn").disabled = !!ev.local_cleared;

    // 本地照片已删 → 相册为空壳，隐藏上传区（提示见 purgedNotice，需删相册重建）
    $("uploadZone").style.display = ev.local_cleared ? "none" : "";

    $("shareLink").value = location.origin + API.getAutoPrefix() + "/share/" + ev.share_token;
    $("previewSizeSelect").value = ev.preview_size || 640;
    $("eventUseOss").checked = ev.use_oss !== false;
    // 默认「保持当前设置」，避免保存其他设置时误改过期时间
    $("eventExpireSelect").value = "keep";
    $("eventExpireSelect").disabled = !!ev.purged;
    populateTagSuggestions(ev);
  }

  // ===== 已有标签快捷选择（中英文配对，避免重复输入）=====
  function populateTagSuggestions(ev) {
    const tags = (ev && ev.tags) || [];
    const dlZh = $("tagDatalist");
    const dlEn = $("tagEnDatalist");
    const chips = $("tagChips");
    dlZh.innerHTML = tags.map((t) => `<option value="${escapeHtml(t.tag)}"></option>`).join("");
    dlEn.innerHTML = tags.map((t) => `<option value="${escapeHtml(t.tag_en || t.tag)}"></option>`).join("");
    if (tags.length === 0) {
      $("tagSuggest").hidden = true;
      chips.innerHTML = "";
      return;
    }
    chips.innerHTML = tags.map((t) => {
      const en = t.tag_en || t.tag;
      return `<span class="tag-chip-item">
        <button type="button" class="tag-chip" data-zh="${escapeHtml(t.tag)}" data-en="${escapeHtml(en)}" title="${escapeHtml(t.tag)} / ${escapeHtml(en)}">
          <span class="tag-chip-zh">${escapeHtml(t.tag)}</span>
          <span class="tag-chip-en">${escapeHtml(en)}</span>
          <em>${t.count}</em>
        </button>
        <button type="button" class="tag-chip-edit" data-zh="${escapeHtml(t.tag)}" data-en="${escapeHtml(en)}" data-count="${t.count}" title="${I18N.t("rename_tag")}" aria-label="${I18N.t("rename_tag")}">✎</button>
      </span>`;
    }).join("");
    $("tagSuggest").hidden = false;
    chips.querySelectorAll(".tag-chip").forEach((b) => {
      b.addEventListener("click", () => {
        $("uploadTag").value = b.dataset.zh;
        $("uploadTagEn").value = b.dataset.en;
      });
    });
    chips.querySelectorAll(".tag-chip-edit").forEach((b) => {
      b.addEventListener("click", () => {
        openRenameTag(b.dataset.zh, b.dataset.en, parseInt(b.dataset.count, 10) || 0);
      });
    });
  }

  // ===== 标签重命名 =====
  function openRenameTag(zh, en, count) {
    state.renameTag = { tag: zh, tag_en: en, count: count };
    $("tagRenameHint").textContent = I18N.t("rename_tag_hint", { tag: zh, n: count });
    $("tagRenameZh").value = zh;
    $("tagRenameEn").value = en || zh;
    $("tagRenameModal").hidden = false;
    setTimeout(() => { $("tagRenameZh").focus(); $("tagRenameZh").select(); }, 50);
  }
  function closeRenameTag() {
    $("tagRenameModal").hidden = true;
    state.renameTag = null;
  }

  async function confirmRenameTag() {
    const cur = state.renameTag;
    if (!cur || !state.currentEvent) return;
    const newZh = $("tagRenameZh").value.trim();
    const newEn = $("tagRenameEn").value.trim();
    if (!newZh) { toast(I18N.t("rename_tag_empty"), "err"); return; }
    if (newZh === cur.tag && (newEn || cur.tag) === (cur.tag_en || cur.tag)) {
      toast(I18N.t("rename_tag_same"), "err");
      return;
    }

    // 目标名称已存在 → 合并，需二次确认
    const known = (state.currentEvent.tags || []).find((t) => t.tag === newZh && t.tag !== cur.tag);
    if (known && !confirm(I18N.t("rename_tag_merge_confirm", { tag: newZh, n: known.count }))) return;

    const btn = $("tagRenameConfirm");
    btn.disabled = true;
    const orig = btn.textContent;
    btn.textContent = I18N.t("saving");
    try {
      const data = await API.renameTag(state.currentEvent.event_id, {
        old_tag: cur.tag,
        old_tag_en: cur.tag_en || "",
        new_tag: newZh,
        new_tag_en: newEn,
      });
      closeRenameTag();
      toast(I18N.t("rename_tag_success", { n: data.affected }), "ok");
      // 用服务端返回的标签列表刷新，保证计数准确
      state.currentEvent = await API.getEvent(state.currentEvent.event_id);
      renderDetail();
      await loadThumbs();
    } catch (e) {
      toast((e && e.msg) || I18N.t("rename_tag_failed"), "err");
    } finally {
      btn.disabled = false;
      btn.textContent = orig;
    }
  }

  // 输入时中英文配对自动补全：中文命中已有标签且英文框为空 → 自动补英文；反之亦然
  function bindTagAutoPair() {
    const zh = $("uploadTag");
    const en = $("uploadTagEn");
    const knownTags = () => (state.currentEvent && state.currentEvent.tags) || [];
    zh.addEventListener("input", () => {
      const hit = knownTags().find((t) => t.tag === zh.value.trim());
      if (hit && !en.value.trim()) {
        en.value = hit.tag_en || hit.tag;
      }
    });
    en.addEventListener("input", () => {
      const v = en.value.trim();
      const hit = knownTags().find((t) => (t.tag_en || t.tag) === v);
      if (hit && !zh.value.trim()) {
        zh.value = hit.tag;
      }
    });
  }

  async function loadThumbs() {
    const grid = $("thumbGrid");
    grid.innerHTML = `<div class="loading-inline">${I18N.t("loading")}</div>`;
    // 已清空（本地照片已删）的相册没有照片，公共接口会返回 410，直接显示空态
    if (state.currentEvent && state.currentEvent.photo_count === 0) {
      grid.innerHTML = `<div class="empty">${I18N.t("no_photos")}</div>`;
      return;
    }
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
      const expiry = $("eventExpireSelect").value;
      if (expiry !== "keep") settings.expires_in_hours = parseInt(expiry, 10) || 0;
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

  // ===== 上传照片（分批 + 进度 + 可中断 + 结果报告） =====
  const UPLOAD_BATCH_SIZE = 10;   // 每批张数：控制单请求体量，避免 nginx 413 / 长连接中断
  const UPLOAD_RETRY = 1;         // 失败文件自动重试轮数
  let uploadAbort = null;         // AbortController
  let uploadWakeLock = null;

  function chunk(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }

  function uploadStats(results) {
    const s = { ok: 0, failed: 0, skipped: 0, cancelled: 0 };
    for (const r of results) if (s[r.status] !== undefined) s[r.status]++;
    return s;
  }

  function setUploadProgress(done, total, stats, batchCur, batchTotal) {
    const pct = total ? Math.round((done / total) * 100) : 0;
    const bar = $("uploadProgressBar");
    const text = $("uploadProgressText");
    const sub = $("uploadProgressSub");
    if (bar) bar.style.width = pct + "%";
    if (text) text.textContent = I18N.t("upload_progress", { done, total, ok: stats.ok });
    if (sub) sub.textContent = I18N.t("upload_batch", { cur: batchCur, total: batchTotal });
  }

  function showUploadProgress() {
    $("uploadProgress").hidden = false;
    $("uploadProgressBar").style.width = "0%";
  }
  function hideUploadProgress() {
    $("uploadProgress").hidden = true;
  }

  async function requestWakeLock() {
    try {
      if (navigator.wakeLock && navigator.wakeLock.request) {
        uploadWakeLock = await navigator.wakeLock.request("screen");
      }
    } catch (e) { /* 浏览器不支持或拒绝时忽略，不影响上传 */ }
  }
  function releaseWakeLock() {
    if (uploadWakeLock) {
      try { uploadWakeLock.release(); } catch (e) { /* ignore */ }
      uploadWakeLock = null;
    }
  }

  function showUploadResult(results) {
    const stats = uploadStats(results);
    $("uploadResultSummary").textContent = I18N.t("upload_result_summary", {
      ok: stats.ok, fail: stats.failed, skip: stats.skipped, cancel: stats.cancelled,
    });
    $("uploadCancelHint").hidden = stats.cancelled === 0;
    $("uploadSkipHint").hidden = stats.skipped === 0;
    $("uploadRetryBtn").hidden = stats.failed === 0;
    $("uploadResultList").innerHTML = results.map((r) => {
      const icon = r.status === "ok" ? "✓" : r.status === "failed" ? "✗" : r.status === "skipped" ? "⏭" : "✖";
      return `<div class="ures-row ${r.status}"><span class="ures-icon">${icon}</span>` +
        `<span class="ures-name">${escapeHtml(r.filename)}</span>` +
        `<span class="ures-err">${escapeHtml(r.error || "")}</span></div>`;
    }).join("");
    $("uploadResultModal").hidden = false;
  }

  async function uploadPhotos() {
    if (state.jpgFiles.length === 0 || uploadAbort) return;
    const btn = $("uploadBtn");
    const tag = $("uploadTag").value.trim() || null;
    const tagEn = $("uploadTagEn").value.trim() || null;
    const evId = state.currentEvent.event_id;
    const total = state.jpgFiles.length;
    const results = [];
    let done = 0;

    btn.disabled = true;
    btn.textContent = I18N.t("uploading");
    uploadAbort = new AbortController();
    showUploadProgress();
    await requestWakeLock();

    const abortRemaining = (fromBatch, batches) => {
      for (let i = fromBatch; i < batches.length; i++) {
        for (const f of batches[i]) {
          results.push({ filename: f.name, status: "cancelled", error: I18N.t("cancelled") });
        }
      }
    };

    try {
      let batches = chunk(state.jpgFiles, UPLOAD_BATCH_SIZE);
      for (let b = 0; b < batches.length; b++) {
        if (uploadAbort.signal.aborted) { abortRemaining(b, batches); break; }
        const batch = batches[b];
        try {
          const data = await API.uploadPhotos(evId, batch, tag, tagEn, uploadAbort.signal);
          results.push(...((data && data.results) || batch.map((f) => ({ filename: f.name, status: "ok" }))));
        } catch (e) {
          if (uploadAbort.signal.aborted) {
            results.push(...batch.map((f) => ({ filename: f.name, status: "cancelled", error: I18N.t("cancelled") })));
            abortRemaining(b + 1, batches);
            break;
          }
          // 整批网络失败 → 先标失败，稍后统一自动重试
          results.push(...batch.map((f) => ({ filename: f.name, status: "failed", error: (e && e.msg) || I18N.t("network_error") })));
        }
        done += batch.length;
        setUploadProgress(done, total, uploadStats(results), b + 1, batches.length);
        await new Promise((r) => setTimeout(r, 60)); // 让 UI 呼吸
      }

      // 自动重试失败文件
      for (let round = 0; round < UPLOAD_RETRY; round++) {
        if (uploadAbort.signal.aborted) break;
        const failedNames = results.filter((r) => r.status === "failed").map((r) => r.filename);
        if (!failedNames.length) break;
        const byName = new Map(state.jpgFiles.map((f) => [f.name, f]));
        const retryFiles = failedNames.map((n) => byName.get(n)).filter(Boolean);
        if (!retryFiles.length) break;
        $("uploadProgressText").textContent = I18N.t("upload_retrying", { n: retryFiles.length });
        for (const b of chunk(retryFiles, UPLOAD_BATCH_SIZE)) {
          if (uploadAbort.signal.aborted) break;
          try {
            const data = await API.uploadPhotos(evId, b, tag, tagEn, uploadAbort.signal);
            const okNames = new Set((data.results || []).filter((r) => r.status === "ok").map((r) => r.filename));
            for (const r of results) {
              if (r.status === "failed" && okNames.has(r.filename)) r.status = "ok";
            }
          } catch (e) { /* 仍失败则保留 failed 状态 */ }
          await new Promise((r) => setTimeout(r, 60));
        }
      }
    } finally {
      releaseWakeLock();
      hideUploadProgress();
      uploadAbort = null;
      btn.textContent = I18N.t("upload_btn");
      btn.disabled = state.jpgFiles.length === 0;
    }

    // 清理已成功/已跳过的文件，保留失败与取消的以便重传
    const keepNames = new Set(results.filter((r) => r.status === "failed" || r.status === "cancelled").map((r) => r.filename));
    state.jpgFiles = state.jpgFiles.filter((f) => keepNames.has(f.name));
    renderFileList($("jpgFiles"), state.jpgFiles);
    $("jpgInput").value = "";
    if (!state.jpgFiles.length) {
      $("uploadTag").value = "";
      $("uploadTagEn").value = "";
    }
    btn.disabled = state.jpgFiles.length === 0;

    showUploadResult(results);

    // 刷新活动信息与缩略图
    try {
      state.currentEvent = await API.getEvent(evId);
      renderDetail();
      await loadThumbs();
    } catch (e) { /* 刷新失败不阻塞结果展示 */ }
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

    // 标签重命名弹窗
    $("tagRenameClose").addEventListener("click", closeRenameTag);
    $("tagRenameModal").addEventListener("click", (e) => { if (e.target === $("tagRenameModal")) closeRenameTag(); });
    $("tagRenameConfirm").addEventListener("click", confirmRenameTag);
    $("tagRenameZh").addEventListener("keydown", (e) => { if (e.key === "Enter") confirmRenameTag(); });
    $("tagRenameEn").addEventListener("keydown", (e) => { if (e.key === "Enter") confirmRenameTag(); });

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
    $("clearOssBtn").addEventListener("click", clearOss);
    $("clearLocalBtn").addEventListener("click", clearLocal);

    setupDropzone("dropzoneJpg", "jpgInput", "jpgFiles", "jpg");
    setupDropzone("dropzoneRaf", "rafInput", "rafFiles", "raf");
    $("uploadBtn").addEventListener("click", uploadPhotos);
    $("uploadRafBtn").addEventListener("click", uploadRaf);
    $("uploadAbortBtn").addEventListener("click", () => { if (uploadAbort) uploadAbort.abort(); });
    $("uploadResultClose").addEventListener("click", () => { $("uploadResultModal").hidden = true; });
    $("uploadResultClose2").addEventListener("click", () => { $("uploadResultModal").hidden = true; });
    $("uploadRetryBtn").addEventListener("click", () => {
      $("uploadResultModal").hidden = true;
      uploadPhotos();
    });
    $("uploadResultModal").addEventListener("click", (e) => {
      if (e.target === $("uploadResultModal")) $("uploadResultModal").hidden = true;
    });
    bindTagAutoPair();

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
