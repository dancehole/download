#!/usr/bin/env node
/**
 * 相册管理页「相册设置」折叠面板 E2E（Headless Chrome + CDP，真实鼠标点击/输入）
 * 覆盖：默认收起（页面纯净）/ 展开收起往返 / 三分段切换 / 保存设置仍然生效 /
 *       切换相册自动收起 / 中英文切换 / 相册管理员看不到「相册管理员」分段 / 手机端无横向溢出
 * 用法：ADMIN_PW=xxx node tests/e2e-album-settings-collapse.js
 */
const fs = require("fs");
const { spawn } = require("child_process");

const PORT = 9229;
const CHROME_DIR = "/root/.agent-browser/browsers";
const ROOT = "http://127.0.0.1:8001/download";
const API = ROOT + "/api";
const ADMIN_PW = process.env.ADMIN_PW;
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const SHOT_DIR = process.env.SHOT_DIR || "/tmp/album-settings-shots";
const TEMP_ALBUM = "e2e折叠面板测试相册";
const SUB_ADMIN = "e2e_collapse_sub";

if (!ADMIN_PW) { console.error("用法: ADMIN_PW=<超管密码> node tests/e2e-album-settings-collapse.js"); process.exit(2); }
fs.mkdirSync(SHOT_DIR, { recursive: true });

function findChrome() {
  const dirs = fs.readdirSync(CHROME_DIR).filter((d) => d.startsWith("chrome-")).sort();
  return `${CHROME_DIR}/${dirs[dirs.length - 1]}/chrome`;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function startChrome() {
  return spawn(findChrome(), [
    "--headless=new", `--remote-debugging-port=${PORT}`, "--no-sandbox",
    "--disable-gpu", "--disable-dev-shm-usage", "--window-size=1440,900", "--hide-scrollbars",
    "--user-data-dir=/tmp/chrome-collapse-" + process.pid, "about:blank",
  ], { stdio: "ignore" });
}
async function getTargetWs() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" });
      return (await r.json()).webSocketDebuggerUrl;
    } catch (e) { await sleep(250); }
  }
  throw new Error("chrome debug port not up");
}
class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map();
    this.errors = []; this.dialogs = 0;
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
        return;
      }
      if (msg.method === "Runtime.exceptionThrown") {
        this.errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
      }
      if (msg.method === "Page.javascriptDialogOpening") {
        this.dialogs++;
        this.send("Page.handleJavaScriptDialog", { accept: true }).catch(() => {});
      }
    };
  }
  async open() { if (this.ws.readyState === WebSocket.OPEN) return;
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; }); }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.id; this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expr) {
    const r = await this.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error("eval exception: " + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result ? r.result.value : undefined;
  }
  async shot(name) {
    const r = await this.send("Page.captureScreenshot", { format: "png" });
    const p = `${SHOT_DIR}/${name}.png`;
    fs.writeFileSync(p, Buffer.from(r.data, "base64"));
    return p;
  }
}
async function waitFor(cdp, expr, timeoutMs = 15000, label = "") {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < timeoutMs) {
    try { last = await cdp.eval(expr); if (last) return last; } catch (e) { last = "(pending)"; }
    await sleep(200);
  }
  throw new Error("waitFor timeout" + (label ? " [" + label + "]" : "") + ": " + expr + " last=" + JSON.stringify(last));
}
const results = [];
function check(name, ok, detail) {
  results.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? "  | " + detail : ""}`);
}
async function click(cdp, sel) {
  const box = await cdp.eval(`(() => { const el = document.querySelector(${JSON.stringify(sel)});
     if (!el) return null; el.scrollIntoView({block:"center"});
     const r = el.getBoundingClientRect(); return {x: r.x + r.width/2, y: r.y + r.height/2}; })()`);
  if (!box) throw new Error("click target not found: " + sel);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y, button: "none", buttons: 0 });
  await sleep(40);
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", buttons: 1, clickCount: 1 });
  await sleep(40);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", buttons: 0, clickCount: 1 });
  await sleep(120);
}
async function type(cdp, sel, text) {
  await cdp.eval(`(() => { const el = document.querySelector(${JSON.stringify(sel)});
    el.focus(); el.value = ${JSON.stringify(text)};
    el.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
}
async function uiLogin(cdp, user, pw, label) {
  await waitFor(cdp, `!document.getElementById("authScreen").hidden`, 15000, label + " 登录页");
  await type(cdp, "#loginUser", user);
  await type(cdp, "#loginPass", pw);
  await click(cdp, "#loginSubmit");
  await waitFor(cdp, `!document.getElementById("app").hidden`, 15000, label + " 进入后台");
}
async function api(method, path, token, body) {
  const res = await fetch(API + path, {
    method,
    headers: Object.assign({ "Content-Type": "application/json" }, token ? { Authorization: "Bearer " + token } : {}),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null; try { data = await res.json(); } catch (e) {}
  return { status: res.status, body: data, data: data && data.data };
}
// 面板状态快照
const SNAP = `JSON.stringify({
  open: !document.getElementById("albumSettingsBody").hidden,
  aria: document.getElementById("albumSettingsToggle").getAttribute("aria-expanded"),
  basic: !document.getElementById("segPaneBasic").hidden,
  admins: !document.getElementById("segPaneAdmins").hidden,
  cleanup: !document.getElementById("segPaneCleanup").hidden,
  tabAdminsHidden: document.getElementById("segTabAdmins").hidden,
  tabsVisible: [...document.querySelectorAll("#albumSettingsPanel .seg-tab")].filter(t => !t.hidden).length,
  activeTab: (document.querySelector("#albumSettingsPanel .seg-tab.active") || {}).id || "",
  summary: document.getElementById("albumSettingsSummary").textContent,
  headH: Math.round(document.getElementById("albumSettingsToggle").getBoundingClientRect().height),
})`;

(async () => {
  const chrome = startChrome(); let cdp;
  try {
    // ───── 准备：超管 token + 临时相册 + 临时相册管理员，清理上次残留 ─────
    let r = await api("POST", "/auth/login", null, { username: ADMIN_USER, password: ADMIN_PW });
    const superToken = r.data && r.data.token;
    if (!superToken) throw new Error("admin 登录失败: " + JSON.stringify(r));
    for (const ev of ((await api("GET", "/events", superToken)).data || [])) {
      if (ev.event_name.startsWith("e2e折叠面板测试")) await api("DELETE", "/events/" + ev.event_id, superToken);
    }
    for (const u of ((await api("GET", "/users", superToken)).data || [])) {
      if (u.username === SUB_ADMIN) await api("DELETE", "/users/" + u.id, superToken);
    }
    r = await api("POST", "/events", superToken, { event_name: TEMP_ALBUM });
    const EID = r.data.event_id;
    const EID2 = ((await api("GET", "/events", superToken)).data.find((e) => e.event_id !== EID) || {}).event_id;
    r = await api("POST", "/users", superToken, { username: SUB_ADMIN, role: "album", event_ids: [EID] });
    const subPw = r.data && r.data.password;
    if (!subPw) throw new Error("临时相册管理员创建失败: " + JSON.stringify(r));
    console.log("临时相册:", EID, "| 第二个相册:", EID2);

    cdp = new CDP(await getTargetWs()); await cdp.open();
    await cdp.send("Runtime.enable"); await cdp.send("Page.enable");
    await cdp.send("Page.navigate", { url: ROOT + "/admin" });
    await uiLogin(cdp, ADMIN_USER, ADMIN_PW, "超管");

    // ───── 1. 进入相册：默认「纯净」视图 ─────
    await waitFor(cdp, `document.querySelectorAll("#eventsGrid .event-card").length > 0`, 15000, "相册列表");
    await click(cdp, `[data-id="${EID}"] [data-act="enter"]`);
    await waitFor(cdp, `!document.getElementById("viewDetail").hidden && document.getElementById("detailId").textContent.includes("${EID}")`, 15000, "详情页");
    await waitFor(cdp, `document.getElementById("albumSettingsSummary").textContent.length > 0`, 10000, "摘要文案");

    let s = JSON.parse(await cdp.eval(SNAP));
    const paneVisible = await cdp.eval(`["segPaneBasic","segPaneAdmins","segPaneCleanup"].some(id => document.getElementById(id).getBoundingClientRect().height > 0)`);
    check("默认收起：面板内容整体不可见（无渲染高度）", s.open === false && paneVisible === false, JSON.stringify(s) + " paneVisible=" + paneVisible);
    check("默认收起：aria-expanded=false", s.aria === "false", s.aria);
    check("折叠头只占一行（高度 < 60px）", s.headH > 0 && s.headH < 60, s.headH + "px");
    check("折叠头摘要显示过期/空间信息", /过|永不过期|占用/.test(s.summary), s.summary);
    check("配置内容不再铺在上传区之前：上传区可见", (await cdp.eval(`document.getElementById("uploadZone").style.display`)) !== "none");
    const order = await cdp.eval(`(() => {
      const box = document.querySelector("#viewDetail .share-box");
      const panel = document.getElementById("albumSettingsPanel");
      const up = document.getElementById("uploadZone");
      return JSON.stringify({
        shareBeforePanel: !!(box.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING),
        panelBeforeUpload: !!(panel.compareDocumentPosition(up) & Node.DOCUMENT_POSITION_FOLLOWING),
        oldCardGone: !document.getElementById("albumAdminsCard"),
        cardsAtTop: document.querySelectorAll("#viewDetail > .settings-card").length,
      }); })()`);
    check("DOM 顺序：分享链接 → 相册设置（收起）→ 上传区，旧的独立卡片已合并", /"shareBeforePanel":true/.test(order) && /"panelBeforeUpload":true/.test(order) && /"oldCardGone":true/.test(order) && /"cardsAtTop":0/.test(order), order);
    check("折叠时关键操作在上传区（首屏无配置表单）",
      (await cdp.eval(`document.querySelector("#viewDetail .collapse-body").hidden`)) === true);
    await cdp.shot("01-默认收起");

    // ───── 2. 展开 / 收起往返 ─────
    await click(cdp, "#albumSettingsToggle");
    s = JSON.parse(await cdp.eval(SNAP));
    check("展开后：基本设置分段可见，其余分段隐藏", s.open && s.basic && !s.admins && !s.cleanup, JSON.stringify(s));
    check("展开后 aria-expanded=true", s.aria === "true", s.aria);
    check("超管看到 3 个分段标签", s.tabsVisible === 3, s.tabsVisible);
    check("超管能看到「相册管理员」标签", s.tabAdminsHidden === false);
    await cdp.shot("02-展开-基本设置");
    await click(cdp, "#albumSettingsToggle");
    s = JSON.parse(await cdp.eval(SNAP));
    check("再次点击收起", s.open === false && s.aria === "false");

    // ───── 3. 分段切换 ─────
    await click(cdp, "#albumSettingsToggle");
    await click(cdp, "#segTabAdmins");
    s = JSON.parse(await cdp.eval(SNAP));
    check("切到「相册管理员」分段", s.admins && !s.basic && !s.cleanup && s.activeTab === "segTabAdmins", s.activeTab);
    check("相册管理员分段内容渲染（归属账号）", new RegExp(ADMIN_USER).test(await cdp.eval(`document.getElementById("albumOwnerInfo").textContent`)),
      await cdp.eval(`document.getElementById("albumOwnerInfo").textContent`));
    await cdp.shot("03-分段-相册管理员");

    await click(cdp, "#segTabCleanup");
    s = JSON.parse(await cdp.eval(SNAP));
    check("切到「空间与清理」分段", s.cleanup && !s.basic && !s.admins && s.activeTab === "segTabCleanup", s.activeTab);
    check("清理按钮齐备且未误禁用", await cdp.eval(`["clearOssBtn","clearLocalBtn","deleteAlbumBtn"].every(id => { const b = document.getElementById(id); return b && !b.disabled; })`));
    await cdp.shot("04-分段-空间与清理");

    // ───── 4. 基本设置保存仍然生效（搬 DOM 后事件绑定没丢） ─────
    await click(cdp, "#segTabBasic");
    await cdp.eval(`(() => { const el = document.getElementById("previewSizeSelect"); el.value = "800";
      el.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`);
    await click(cdp, "#saveEventSettingsBtn");
    await waitFor(cdp, `/保存成功/.test(document.getElementById("toast").textContent)`, 10000, "保存提示");
    const saved = (await api("GET", "/events/" + EID, superToken)).data.preview_size;
    check("「保存设置」仍生效（后端 preview_size=800）", String(saved) === "800", String(saved));

    // ───── 5. 切换相册 / 重新进入 → 回到纯净视图 ─────
    await click(cdp, "#backBtn");
    await waitFor(cdp, `!document.getElementById("viewEvents").hidden`);
    await click(cdp, `[data-id="${EID}"] [data-act="enter"]`);
    await waitFor(cdp, `!document.getElementById("viewDetail").hidden && document.getElementById("detailId").textContent.includes("${EID}")`);
    s = JSON.parse(await cdp.eval(SNAP));
    check("重新进入相册：面板自动收起、分段回到基本设置", s.open === false && s.activeTab === "segTabBasic", JSON.stringify(s));

    // ───── 6. 中英文切换 ─────
    await click(cdp, "#albumSettingsToggle");
    await click(cdp, "#langToggle2");
    await waitFor(cdp, `document.getElementById("segTabBasic").textContent === "Basic Settings"`, 8000, "英文标签");
    s = JSON.parse(await cdp.eval(SNAP));
    check("英文下分段文案与摘要正常", s.activeTab === "segTabBasic" && s.summary.length > 0, s.summary);
    await cdp.shot("05-英文");
    await click(cdp, "#langToggle2");
    await waitFor(cdp, `document.getElementById("segTabBasic").textContent === "基本设置"`, 8000, "中文标签");
    check("切回中文正常", true);
    await click(cdp, "#albumSettingsToggle");

    // ───── 7. 相册管理员视角：看不到「相册管理员」分段 ─────
    await click(cdp, "#logoutBtn");
    await waitFor(cdp, `!document.getElementById("authScreen").hidden`);
    await uiLogin(cdp, SUB_ADMIN, subPw, "相册管理员");
    await waitFor(cdp, `document.querySelectorAll("#eventsGrid .event-card").length > 0`, 15000);
    await click(cdp, `[data-id="${EID}"] [data-act="enter"]`);
    await waitFor(cdp, `!document.getElementById("viewDetail").hidden && document.getElementById("detailId").textContent.includes("${EID}")`);
    await click(cdp, "#albumSettingsToggle");
    s = JSON.parse(await cdp.eval(SNAP));
    check("相册管理员只能看到 2 个分段（无管理员分段）", s.tabsVisible === 2 && s.tabAdminsHidden === true, JSON.stringify(s));
    // 即使绕过隐藏强点 admins，也应回落到基本设置
    await cdp.eval(`document.getElementById("segTabAdmins").click()`);
    s = JSON.parse(await cdp.eval(SNAP));
    check("强行切「相册管理员」→ 回落基本设置（该分段不可达）", s.basic === true && s.admins === false, JSON.stringify(s));
    check("相册管理员仍可用「空间与清理」分段",
      await cdp.eval(`(() => { document.getElementById("segTabCleanup").click();
        return !document.getElementById("segPaneCleanup").hidden && !!document.getElementById("clearOssBtn"); })()`));
    await cdp.shot("06-相册管理员视角");

    // ───── 8. 手机端（375px）无横向溢出 ─────
    // 注意：必须用 deviceScaleFactor=1 / mobile=false，否则 innerWidth 不是 375
    // （曾用 mobile:true 导致 innerWidth=509，断言变成假绿 —— 2026-09-16 修）
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 375, height: 780, deviceScaleFactor: 1, mobile: false });
    await sleep(800);
    await click(cdp, "#segTabBasic");
    const mob = JSON.parse(await cdp.eval(`JSON.stringify({
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      iw: window.innerWidth,
      panelW: Math.round(document.getElementById("albumSettingsPanel").getBoundingClientRect().width),
      tabsScroll: document.querySelector(".seg-tabs").scrollWidth,
      tabsClient: document.querySelector(".seg-tabs").clientWidth,
    })`));
    check("375px 设备模拟真的生效", Math.abs(mob.iw - 375) <= 2, "innerWidth=" + mob.iw);
    check("手机端无横向溢出", mob.overflow <= 0, JSON.stringify(mob));
    check("手机端面板宽度贴合视口", mob.panelW > 300 && mob.panelW <= 375, mob.panelW + "px");
    await cdp.shot("07-手机-展开");
    await click(cdp, "#albumSettingsToggle");
    await cdp.shot("08-手机-收起");
    await cdp.send("Emulation.clearDeviceMetricsOverride");

    check("全程无 JS 异常", cdp.errors.length === 0, JSON.stringify(cdp.errors.slice(0, 2)));

    // ───── 清理 ─────
    await click(cdp, "#logoutBtn");
    await waitFor(cdp, `!document.getElementById("authScreen").hidden`);
    await uiLogin(cdp, ADMIN_USER, ADMIN_PW, "超管(清理)");
    await api("DELETE", "/events/" + EID, superToken);
    const u = ((await api("GET", "/users", superToken)).data || []).find((x) => x.username === SUB_ADMIN);
    if (u) await api("DELETE", "/users/" + u.id, superToken);
    const left = ((await api("GET", "/users", superToken)).data || []).map((x) => x.username);
    const albums = ((await api("GET", "/events", superToken)).data || []).map((x) => x.event_name);
    check("清理完成（临时相册与临时账号已删除）",
      left.indexOf(SUB_ADMIN) === -1 && !albums.some((n) => n.startsWith("e2e折叠面板测试")), left.join(",") + " | " + albums.join(","));

    const fails = results.filter((r) => !r).length;
    console.log(`\n==== ${results.length - fails}/${results.length} passed ====`);
    console.log("截图目录:", SHOT_DIR);
    process.exitCode = fails ? 1 : 0;
  } catch (e) {
    console.error("TEST ERROR:", e.message); process.exitCode = 1;
  } finally {
    try { if (cdp) cdp.ws.close(); } catch (e) {}
    chrome.kill("SIGKILL");
    try { fs.rmSync("/tmp/chrome-collapse-" + chrome.pid, { recursive: true, force: true }); } catch (e) {}
  }
})();
