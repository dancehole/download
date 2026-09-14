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
    me: null,          // 当前登录账号 {photographer_id, username, role, is_super}
    users: [],         // 账号列表（仅超级管理员加载）
    editUser: null,    // 正在编辑授权相册的账号
    albumSettingsOpen: false, // 相册设置面板是否展开（默认收起，保持相册页纯净）
    albumSeg: "basic",        // 相册设置内当前分段：basic | admins | cleanup
  };

  // 相册设置面板的分段映射（顺序即标签顺序）
  const SEG_TABS = { basic: "segTabBasic", admins: "segTabAdmins", cleanup: "segTabCleanup" };
  const SEG_PANES = { basic: "segPaneBasic", admins: "segPaneAdmins", cleanup: "segPaneCleanup" };

  function isSuper() {
    return !!(state.me && (state.me.is_super || state.me.role === "super"));
  }

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
      state.me = await API.me();
      showApp();
    } catch (e) {
      API.clearToken();
      state.me = null;
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
    applyRoleUI();
    showView("viewEvents");
    loadEvents();
  }

  // 按角色控制入口显隐（后端仍然强制校验，前端只负责不显示没用的入口）
  function applyRoleUI() {
    const superUser = isSuper();
    $("navUsers").hidden = !superUser;
    $("navFiles").hidden = !superUser;
    $("settingsBtn").hidden = !superUser;
    $("createBtn").hidden = !superUser;        // 相册管理员不能新建相册
    $("segTabAdmins").hidden = !superUser;     // 「相册管理员」分段仅超管可管
    syncAlbumSeg();                            // 角色变化后校正当前分段（非超管不能停在 admins）
    const lbl = document.getElementById("currentUserLabel");
    if (lbl) {
      lbl.textContent = (state.me ? state.me.username : "") +
        (state.me ? "（" + I18N.t(superUser ? "role_super" : "my_role_album") + "）" : "");
    }
  }

  function showView(id) {
    // 仅超级管理员可进的视图：即使入口被隐藏，也要挡住直接调用
    if ((id === "viewUsers" || id === "viewFiles" || id === "viewSettings") && !isSuper()) {
      id = "viewEvents";
      loadEvents();
    }
    $("viewEvents").hidden = id !== "viewEvents";
    $("viewDetail").hidden = id !== "viewDetail";
    $("viewSettings").hidden = id !== "viewSettings";
    $("viewFiles").hidden = id !== "viewFiles";
    if ($("viewUsers")) $("viewUsers").hidden = id !== "viewUsers";
    $("navEvents").classList.toggle("active", id === "viewEvents" || id === "viewDetail");
    $("navFiles").classList.toggle("active", id === "viewFiles");
    if ($("navUsers")) $("navUsers").classList.toggle("active", id === "viewUsers");
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
      state.me = { photographer_id: data.photographer_id, username: data.username,
                   role: data.role, is_super: data.is_super };
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
          ${isSuper() && ev.owner ? `<span class="chip chip-soft">${I18N.t("album_owner")}: ${escapeHtml(ev.owner)}</span>` : ""}
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
      // 每次进相册都回到「纯净」视图：面板收起 + 落在基本设置分段
      setAlbumSettingsOpen(false);
      setAlbumSeg("basic");
      // 相册管理员区块需要账号列表（仅超管有权限，放在详情打开后加载）
      if (isSuper() && state.users.length === 0) await loadUsers();
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

    // 「相册设置」折叠头右侧摘要（收起时也能一眼看到过期时间 / 空间占用）
    updateAlbumSettingsSummary(ev);

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
    renderAlbumAdmins();
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
    if (!isSuper()) { toast(I18N.t("only_super_entry"), "err"); return; }
    showView("viewSettings");
    loadOssSettings();
  }

  // ===== 账号与权限（仅超级管理员） =====
  async function loadUsers() {
    if (!isSuper() || !$("userTableBody")) return;
    try {
      state.users = await API.listUsers();
      renderUsers();
      if (state.currentEvent) renderAlbumAdmins();
    } catch (e) {
      if (e && e.status === 401) { API.clearToken(); showLogin(); return; }
      toast((e && e.msg) || I18N.t("load_failed"), "err");
    }
  }

  function renderUsers() {
    const tbody = $("userTableBody");
    if (!tbody) return;
    $("userCountChip").textContent = state.users.length;
    $("userEmpty").hidden = state.users.length > 0;
    tbody.innerHTML = state.users.map((u) => {
      const albums = u.role === "super"
        ? `<span class="chip chip-soft">${I18N.t("all_albums")}</span>`
        : ((u.albums || []).length
            ? u.albums.map((a) => `<span class="chip chip-soft" title="${escapeHtml(a.event_name)}">${escapeHtml(a.event_name)}</span>`).join("")
            : `<span class="muted">${I18N.t("no_albums_granted")}</span>`);
      const isMe = state.me && state.me.photographer_id === u.id;
      const roleChip = u.role === "super"
        ? `<span class="chip chip-role-super">${I18N.t("role_super")}</span>`
        : `<span class="chip chip-role-album">${I18N.t("role_album")}</span>`;
      const statusHtml = u.is_active
        ? `<span class="status-valid">${I18N.t("status_active")}</span>`
        : `<span class="status-expired">${I18N.t("status_disabled")}</span>`;
      return `
        <tr data-id="${u.id}">
          <td class="fname">${escapeHtml(u.username)}${isMe ? " ★" : ""}</td>
          <td>${roleChip}</td>
          <td>${statusHtml}</td>
          <td class="user-albums">${albums}</td>
          <td class="fmeta">${escapeHtml(u.created_at || "")}</td>
          <td class="fops">
            <button class="action-btn" data-act="pw" data-name="${escapeHtml(u.username)}">${I18N.t("reset_password")}</button>
            ${u.role === "album" ? `<button class="action-btn edit-btn" data-act="albums" data-name="${escapeHtml(u.username)}">${I18N.t("edit_albums")}</button>` : ""}
            <button class="action-btn ${u.is_active ? "del-btn" : "copy-btn"}" data-act="active" data-name="${escapeHtml(u.username)}">${u.is_active ? I18N.t("disable_user") : I18N.t("enable_user")}</button>
            <button class="action-btn del-btn" data-act="delete" data-name="${escapeHtml(u.username)}">${I18N.t("delete_user")}</button>
          </td>
        </tr>`;
    }).join("");
    tbody.querySelectorAll("[data-act]").forEach((b) => {
      b.addEventListener("click", () => {
        const u = state.users.find((x) => x.username === b.dataset.name);
        if (!u) return;
        if (b.dataset.act === "pw") resetUserPassword(u);
        else if (b.dataset.act === "albums") openUserAlbums(u);
        else if (b.dataset.act === "active") toggleUserActive(u);
        else if (b.dataset.act === "delete") deleteUserAccount(u);
      });
    });
  }

  // 相册勾选框（新建账号 / 编辑授权共用）
  function renderAlbumPicker(container, selectedIds) {
    if (!container) return;
    selectedIds = selectedIds || [];
    if (state.events.length === 0) {
      container.innerHTML = `<span class="muted">${I18N.t("no_events")}</span>`;
      return;
    }
    container.innerHTML = state.events.map((ev) => `
      <label class="album-option">
        <input type="checkbox" value="${escapeHtml(ev.event_id)}" ${selectedIds.indexOf(ev.event_id) !== -1 ? "checked" : ""}>
        <span class="album-option-name">${escapeHtml(ev.event_name)}</span>
        <em class="mono">${escapeHtml(ev.event_id)}</em>
      </label>`).join("");
  }
  function pickedAlbums(container) {
    if (!container) return [];
    return Array.from(container.querySelectorAll("input[type=checkbox]:checked")).map((i) => i.value);
  }

  function showPasswordModal(username, password) {
    $("pwUser").value = username || "";
    $("pwValue").value = password || "";
    $("pwModal").hidden = false;
  }

  function openUserCreate() {
    $("userNameInput").value = "";
    $("userPassInput").value = "";
    $("userRoleSelect").value = "album";
    renderAlbumPicker($("userAlbumsPicker"), []);
    updateRoleHint();
    $("userCreateModal").hidden = false;
    setTimeout(() => $("userNameInput").focus(), 50);
  }

  function updateRoleHint() {
    const role = $("userRoleSelect").value;
    $("userRoleHint").textContent = I18N.t(role === "super" ? "role_super_desc" : "role_album_desc");
    $("userAlbumsField").style.display = role === "super" ? "none" : "";
  }

  async function confirmUserCreate() {
    const username = $("userNameInput").value.trim();
    const password = $("userPassInput").value;
    const role = $("userRoleSelect").value;
    if (!username) { toast(I18N.t("new_user_name_ph"), "err"); return; }
    const btn = $("userCreateConfirm");
    const orig = btn.textContent;
    btn.disabled = true;
    btn.textContent = I18N.t("saving");
    try {
      const ids = role === "super" ? [] : pickedAlbums($("userAlbumsPicker"));
      const payload = { username: username, role: role, event_ids: ids };
      if (password) payload.password = password;      // 留空则后端自动生成
      const data = await API.createUser(payload);
      $("userCreateModal").hidden = true;
      toast(I18N.t("user_created"), "ok");
      if (data && data.password) showPasswordModal(data.username, data.password);
      await loadUsers();
      if (state.currentEvent) await refreshCurrentEvent();
    } catch (e) {
      toast((e && e.msg) || I18N.t("save_failed"), "err");
    } finally {
      btn.disabled = false;
      btn.textContent = orig;
    }
  }

  function openUserAlbums(u) {
    state.editUser = u;
    $("userAlbumsTitle").textContent = I18N.t("grant_albums_title", { name: u.username });
    renderAlbumPicker($("userAlbumsPicker"), (u.albums || []).map((a) => a.event_id));
    $("userAlbumsModal").hidden = false;
  }

  async function saveUserAlbums() {
    if (!state.editUser) return;
    const btn = $("userAlbumsSave");
    btn.disabled = true;
    try {
      await API.setUserAlbums(state.editUser.id, pickedAlbums($("userAlbumsPicker")));
      $("userAlbumsModal").hidden = true;
      toast(I18N.t("albums_saved"), "ok");
      await loadUsers();
      if (state.currentEvent) await refreshCurrentEvent();
    } catch (e) {
      toast((e && e.msg) || I18N.t("save_failed"), "err");
    } finally {
      btn.disabled = false;
    }
  }

  async function resetUserPassword(u) {
    if (!confirm(I18N.t("reset_password_confirm", { name: u.username }))) return;
    try {
      const data = await API.resetUserPassword(u.id);
      toast(I18N.t("password_reset_done"), "ok");
      showPasswordModal(data.username, data.password);
      await loadUsers();
    } catch (e) {
      toast((e && e.msg) || I18N.t("save_failed"), "err");
    }
  }

  async function toggleUserActive(u) {
    const on = !u.is_active;
    if (!confirm(I18N.t(on ? "enable_user_confirm" : "disable_user_confirm", { name: u.username }))) return;
    try {
      await API.setUserActive(u.id, on);
      toast(I18N.t(on ? "user_enabled" : "user_disabled"), "ok");
      await loadUsers();
    } catch (e) {
      toast((e && e.msg) || I18N.t("save_failed"), "err");
    }
  }

  async function deleteUserAccount(u) {
    if (!confirm(I18N.t("delete_user_confirm", { name: u.username }))) return;
    try {
      await API.deleteUser(u.id);
      toast(I18N.t("user_deleted"), "ok");
      await loadUsers();
    } catch (e) {
      toast((e && e.msg) || I18N.t("save_failed"), "err");
    }
  }

  // ===== 相册详情：相册设置折叠面板（基本设置 / 相册管理员 / 空间与清理） =====
  // 设计目标：相册页默认只保留「详情头 + 分享链接 + 上传 + 照片」，配置类内容全部收进这里
  function setAlbumSettingsOpen(open) {
    state.albumSettingsOpen = !!open;
    $("albumSettingsBody").hidden = !state.albumSettingsOpen;
    $("albumSettingsToggle").setAttribute("aria-expanded", state.albumSettingsOpen ? "true" : "false");
  }

  // 按 state.albumSeg 同步标签高亮 / 分段显隐（并校正非法分段：非超管不能停在 admins）
  function syncAlbumSeg() {
    if (!SEG_TABS[state.albumSeg]) state.albumSeg = "basic";
    if (state.albumSeg === "admins" && !isSuper()) state.albumSeg = "basic";
    Object.keys(SEG_TABS).forEach((seg) => {
      const tab = $(SEG_TABS[seg]);
      const pane = $(SEG_PANES[seg]);
      if (!tab || !pane) return;
      const on = seg === state.albumSeg;
      tab.classList.toggle("active", on);
      tab.setAttribute("aria-selected", on ? "true" : "false");
      pane.hidden = !on;
    });
  }

  function setAlbumSeg(seg) {
    state.albumSeg = SEG_TABS[seg] ? seg : "basic";
    syncAlbumSeg();
  }

  // 收起状态下也能看到关键信息：过期时间 + 空间占用
  function updateAlbumSettingsSummary(ev) {
    const el = $("albumSettingsSummary");
    if (!el || !ev) return;
    const parts = [ev.expires_at_text ? I18N.t("expire") + " " + ev.expires_at_text : I18N.t("expire_never")];
    if (ev.local_cleared) parts.push(I18N.t("storage_local_cleared"));
    else if (ev.oss_cleared) parts.push(I18N.t("storage_oss_cleared", { size: ev.storage_size_text || I18N.t("storage_none") }));
    else if (ev.storage_size) parts.push(I18N.t("storage_occupied", { size: ev.storage_size_text }));
    else parts.push(I18N.t("storage_none"));
    el.textContent = parts.join(" · ");
  }

  // ===== 相册详情：相册管理员区块（仅超级管理员） =====
  function renderAlbumAdmins() {
    const ev = state.currentEvent;
    if (!ev) return;
    $("segTabAdmins").hidden = !isSuper();
    syncAlbumSeg();
    if (!isSuper()) return;

    const admins = ev.admins || [];
    const list = $("albumAdminsList");
    list.innerHTML = admins.length
      ? admins.map((a) => `
          <span class="admin-chip${a.is_active ? "" : " is-off"}">
            <span class="admin-name">${escapeHtml(a.username)}</span>
            ${a.is_active ? "" : `<em>${I18N.t("status_disabled")}</em>`}
            <button type="button" class="admin-remove" data-id="${a.id}" data-name="${escapeHtml(a.username)}" title="${I18N.t("remove")}" aria-label="${I18N.t("remove")}">✕</button>
          </span>`).join("")
      : `<span class="muted">${I18N.t("no_album_admins")}</span>`;
    list.querySelectorAll(".admin-remove").forEach((b) => {
      b.addEventListener("click", () => revokeAlbumAdmin(parseInt(b.dataset.id, 10), b.dataset.name));
    });

    // 「授权已有账号」下拉：album 角色且尚未授权本相册
    const sel = $("grantUserSelect");
    const grantedIds = admins.map((a) => a.id);
    const options = state.users.filter((u) => u.role !== "super" && grantedIds.indexOf(u.id) === -1);
    sel.innerHTML = options.length
      ? options.map((u) => `<option value="${u.id}">${escapeHtml(u.username)}</option>`).join("")
      : `<option value="">${I18N.t("select_user_ph")}</option>`;
    $("grantExistingBtn").disabled = options.length === 0;

    $("albumOwnerInfo").textContent = I18N.t("album_owner") + ": " + (ev.owner || "-");
  }

  async function refreshCurrentEvent() {
    if (!state.currentEvent) return;
    try {
      state.currentEvent = await API.getEvent(state.currentEvent.event_id);
      renderDetail();
    } catch (e) { /* 权限被收回时忽略 */ }
  }

  async function createAdminForAlbum() {
    if (!state.currentEvent) return;
    const name = $("newAdminName").value.trim();
    if (!name) { toast(I18N.t("new_user_name_ph"), "err"); return; }
    const btn = $("createAdminBtn");
    const orig = btn.textContent;
    btn.disabled = true;
    btn.textContent = I18N.t("saving");
    try {
      const data = await API.createUser({
        username: name, role: "album", event_ids: [state.currentEvent.event_id],
      });
      $("newAdminName").value = "";
      toast(I18N.t("admin_created_for_album"), "ok");
      if (data && data.password) showPasswordModal(data.username, data.password);
      await refreshCurrentEvent();
      await loadUsers();
    } catch (e) {
      toast((e && e.msg) || I18N.t("save_failed"), "err");
    } finally {
      btn.disabled = false;
      btn.textContent = orig;
    }
  }

  async function grantExistingUser() {
    if (!state.currentEvent) return;
    const pid = parseInt($("grantUserSelect").value, 10);
    if (!pid) return;
    try {
      await API.grantAlbum(pid, state.currentEvent.event_id);
      toast(I18N.t("admin_granted"), "ok");
      await refreshCurrentEvent();
      await loadUsers();
    } catch (e) {
      toast((e && e.msg) || I18N.t("save_failed"), "err");
    }
  }

  async function revokeAlbumAdmin(pid, name) {
    if (!state.currentEvent) return;
    if (!confirm(I18N.t("revoke_admin_confirm", { name: name }))) return;
    try {
      await API.revokeAlbum(pid, state.currentEvent.event_id);
      toast(I18N.t("admin_revoked"), "ok");
      await refreshCurrentEvent();
      await loadUsers();
    } catch (e) {
      toast((e && e.msg) || I18N.t("save_failed"), "err");
    }
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
    $("navUsers").addEventListener("click", () => { showView("viewUsers"); loadUsers(); });
    $("newUserBtn").addEventListener("click", openUserCreate);
    $("userCreateClose").addEventListener("click", () => { $("userCreateModal").hidden = true; });
    $("userCreateModal").addEventListener("click", (e) => { if (e.target === $("userCreateModal")) $("userCreateModal").hidden = true; });
    $("userCreateConfirm").addEventListener("click", confirmUserCreate);
    $("userRoleSelect").addEventListener("change", updateRoleHint);
    $("userAlbumsClose").addEventListener("click", () => { $("userAlbumsModal").hidden = true; });
    $("userAlbumsModal").addEventListener("click", (e) => { if (e.target === $("userAlbumsModal")) $("userAlbumsModal").hidden = true; });
    $("userAlbumsSave").addEventListener("click", saveUserAlbums);
    $("pwModalClose").addEventListener("click", () => { $("pwModal").hidden = true; });
    $("pwDoneBtn").addEventListener("click", () => { $("pwModal").hidden = true; });
    $("pwCopyBtn").addEventListener("click", () => {
      $("pwValue").select();
      copyText($("pwValue").value);
      toast(I18N.t("copied"), "ok");
    });
    $("createAdminBtn").addEventListener("click", createAdminForAlbum);
    $("grantExistingBtn").addEventListener("click", grantExistingUser);
    $("newAdminName").addEventListener("keydown", (e) => { if (e.key === "Enter") createAdminForAlbum(); });
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

    // 相册设置折叠面板：展开/收起 + 分段切换
    $("albumSettingsToggle").addEventListener("click", () => setAlbumSettingsOpen(!state.albumSettingsOpen));
    Object.keys(SEG_TABS).forEach((seg) => {
      $(SEG_TABS[seg]).addEventListener("click", () => setAlbumSeg(seg));
    });

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
    applyRoleUI();
    if (state.currentEvent) renderDetail();
    if (!$("viewEvents").hidden) renderEvents();
    if (!$("viewFiles").hidden) renderFiles();
    if ($("viewUsers") && !$("viewUsers").hidden) renderUsers();
  }

  // ===== 初始化 =====
  applyI18n();
  bindEvents();
  checkAuth();
})();
