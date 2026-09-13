#!/usr/bin/env node
/**
 * 权限体系前端 E2E（Headless Chrome + CDP，真实鼠标点击 + 真实输入）
 * 覆盖：超管可见入口 / 用户管理新建账号（一次性密码）/ 相册管理员区块（一键创建·授权已有·移除）
 *       停用账号后无法登录 / 相册管理员登录只看到被授权相册且看不到超管入口
 * 用法：ADMIN_PW=xxx node tests/e2e-permission-ui.js
 */
const fs = require("fs");
const { spawn } = require("child_process");

const PORT = 9227;
const CHROME_DIR = "/root/.agent-browser/browsers";
const ROOT = "http://127.0.0.1:8001/download";
const API = ROOT + "/api";
const ADMIN_PW = process.env.ADMIN_PW;
const TEST_USER = "e2e_ui_admin";
const TEMP_ALBUM = "e2e前端权限测试相册";

if (!ADMIN_PW) { console.error("用法: ADMIN_PW=<admin密码> node tests/e2e-permission-ui.js"); process.exit(2); }

function findChrome() {
  const dirs = fs.readdirSync(CHROME_DIR).filter((d) => d.startsWith("chrome-")).sort();
  return `${CHROME_DIR}/${dirs[dirs.length - 1]}/chrome`;
}
function startChrome() {
  return spawn(findChrome(), [
    "--headless=new", `--remote-debugging-port=${PORT}`, "--no-sandbox",
    "--disable-gpu", "--disable-dev-shm-usage", "--window-size=1440,900",
    "--user-data-dir=/tmp/chrome-perm-" + process.pid, "about:blank",
  ], { stdio: "ignore" });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
}
async function waitFor(cdp, expr, timeoutMs = 15000, label = "") {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < timeoutMs) {
    try {
      last = await cdp.eval(expr);
      if (last) return last;
    } catch (e) {
      // 页面还没加载完时 getElementById 会返回 null → 表达式抛错，属于正常竞态，继续等
      last = "(pending)";
    }
    await sleep(200);
  }
  throw new Error("waitFor timeout" + (label ? " [" + label + "]" : "") + ": " + expr + " last=" + JSON.stringify(last));
}
const results = [];
function check(name, ok, detail) {
  results.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? "  | " + detail : ""}`);
}
async function click(cdp, selOrExpr, useJs = false) {
  const box = useJs ? null : await cdp.eval(`(() => { const el = document.querySelector(${JSON.stringify(selOrExpr)});
     if (!el) return null; el.scrollIntoView({block:"center"});
     const r = el.getBoundingClientRect(); return {x: r.x + r.width/2, y: r.y + r.height/2}; })()`);
  if (useJs) return cdp.eval(`(() => { const el = document.querySelector(${JSON.stringify(selOrExpr)}); if (!el) return false; el.click(); return true; })()`);
  if (!box) throw new Error("click target not found: " + selOrExpr);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y, button: "none", buttons: 0 });
  await sleep(40);
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", buttons: 1, clickCount: 1 });
  await sleep(40);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", buttons: 0, clickCount: 1 });
}
async function type(cdp, sel, text) {
  await cdp.eval(`(() => { const el = document.querySelector(${JSON.stringify(sel)});
    el.focus(); el.value = ${JSON.stringify(text)};
    el.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
}
// ── 后端辅助（用 API 搭/清测试数据，UI 才是被测对象） ──
async function api(method, path, token, body) {
  const res = await fetch(API + path, {
    method,
    headers: Object.assign({ "Content-Type": "application/json" }, token ? { Authorization: "Bearer " + token } : {}),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null; try { data = await res.json(); } catch (e) {}
  return { status: res.status, body: data, data: data && data.data };
}

(async () => {
  const chrome = startChrome(); let cdp;
  try {
    // ───── 准备：超管 token + 临时相册，清理上次残留 ─────
    let r = await api("POST", "/auth/login", null, { username: "admin", password: ADMIN_PW });
    const superToken = r.data && r.data.token;
    if (!superToken) throw new Error("admin 登录失败: " + JSON.stringify(r));
    r = await api("GET", "/events", superToken);
    for (const ev of (r.data || [])) {
      if (ev.event_name.startsWith("e2e前端权限测试")) await api("DELETE", "/events/" + ev.event_id, superToken);
    }
    r = await api("GET", "/users", superToken);
    for (const u of (r.data || [])) {
      if (u.username === TEST_USER) await api("DELETE", "/users/" + u.id, superToken);
    }
    r = await api("POST", "/events", superToken, { event_name: TEMP_ALBUM });
    const EID = r.data.event_id;
    console.log("临时相册:", EID);

    cdp = new CDP(await getTargetWs()); await cdp.open();
    await cdp.send("Runtime.enable"); await cdp.send("Page.enable");
    await cdp.send("Page.navigate", { url: ROOT + "/admin" });
    await waitFor(cdp, `!document.getElementById("authScreen").hidden`, 15000, "登录页");

    // ───── 1. 超管走 UI 登录 ─────
    await type(cdp, "#loginUser", "admin");
    await type(cdp, "#loginPass", ADMIN_PW);
    await click(cdp, "#loginSubmit");
    await waitFor(cdp, `!document.getElementById("app").hidden`, 15000, "进入后台");
    check("超管 UI 登录成功", true);
    check("超管看到「用户管理」入口", !(await cdp.eval(`document.getElementById("navUsers").hidden`)));
    check("超管看到「共享文件」入口", !(await cdp.eval(`document.getElementById("navFiles").hidden`)));
    check("超管看到「设置」入口", !(await cdp.eval(`document.getElementById("settingsBtn").hidden`)));
    check("超管看到「新建」按钮", !(await cdp.eval(`document.getElementById("createBtn").hidden`)));
    check("顶栏显示当前账号+角色", /admin.*超级管理员/.test(await cdp.eval(`document.getElementById("currentUserLabel").textContent`)),
          await cdp.eval(`document.getElementById("currentUserLabel").textContent`));
    check("超管相册列表能看到临时相册", (await cdp.eval(`document.querySelectorAll('.event-card[data-id="${EID}"]').length`)) === 1);

    // ───── 2. 用户管理：UI 新建相册管理员（勾选临时相册） ─────
    await click(cdp, "#navUsers");
    await waitFor(cdp, `!document.getElementById("viewUsers").hidden`);
    await waitFor(cdp, `document.querySelectorAll("#userTableBody tr").length > 0`, 10000, "账号列表");
    const rowCount = await cdp.eval(`document.querySelectorAll("#userTableBody tr").length`);
    check("用户管理列表加载", rowCount >= 1, rowCount + " 行");
    check("admin 行显示「超级管理员」", /超级管理员/.test(await cdp.eval(`document.querySelector("#userTableBody tr .chip-role-super") ? document.querySelector("#userTableBody tr").textContent : ""`)));

    await click(cdp, "#newUserBtn");
    await waitFor(cdp, `!document.getElementById("userCreateModal").hidden`);
    await type(cdp, "#userNameInput", TEST_USER);
    await cdp.eval(`(() => { const boxes=[...document.querySelectorAll("#userAlbumsPicker input[type=checkbox]")];
      const b = boxes.find(x => x.closest(".album-option").textContent.includes(${JSON.stringify(TEMP_ALBUM)}));
      if (b) b.checked = true; return !!b; })()`);
    await click(cdp, "#userCreateConfirm");
    await waitFor(cdp, `!document.getElementById("pwModal").hidden`, 10000, "一次性密码弹窗");
    const newUser = await cdp.eval(`document.getElementById("pwUser").value`);
    const newPw = await cdp.eval(`document.getElementById("pwValue").value`);
    check("新建账号 → 弹出一性次密码（仅一次展示）", newUser === TEST_USER && newPw.length >= 8, newUser + " / len=" + newPw.length);
    await click(cdp, "#pwDoneBtn");
    await waitFor(cdp, `document.querySelectorAll("#userTableBody tr").length >= 2`);
    check("账号列表出现新账号", /e2e_ui_admin/.test(await cdp.eval(`document.getElementById("userTableBody").textContent`)));
    check("新账号显示「相册管理员」角色", /相册管理员/.test(await cdp.eval(`document.getElementById("userTableBody").textContent`)));
    check("新账号显示被授权的相册名", new RegExp(TEMP_ALBUM).test(await cdp.eval(`document.getElementById("userTableBody").textContent`)));

    // 编辑授权弹窗能打开且勾选状态正确
    await cdp.eval(`(() => { const tr=[...document.querySelectorAll("#userTableBody tr")].find(t=>t.textContent.includes(${JSON.stringify(TEST_USER)}));
      tr.querySelector('[data-act="albums"]').click(); return true; })()`);
    await waitFor(cdp, `!document.getElementById("userAlbumsModal").hidden`);
    check("「授权相册」弹窗勾选状态与后端一致",
      (await cdp.eval(`document.querySelectorAll("#userAlbumsPicker input:checked").length`)) === 1,
      await cdp.eval(`document.querySelectorAll("#userAlbumsPicker input:checked").length`));
    await click(cdp, "#userAlbumsClose");

    // ───── 3. 相册详情：相册管理员区块 ─────
    await click(cdp, "#navEvents");
    await waitFor(cdp, `!document.getElementById("viewEvents").hidden`);
    await waitFor(cdp, `document.querySelectorAll('.event-card[data-id="${EID}"]').length === 1`, 10000);
    await click(cdp, `[data-id="${EID}"] [data-act="enter"]`);
    await waitFor(cdp, `!document.getElementById("viewDetail").hidden && document.getElementById("detailId").textContent.includes("${EID}")`, 15000, "详情页");
    check("相册详情显示「相册管理员」区块", !(await cdp.eval(`document.getElementById("albumAdminsCard").hidden`)));
    check("区块里列出刚创建的管理员", /e2e_ui_admin/.test(await cdp.eval(`document.getElementById("albumAdminsList").textContent`)),
          await cdp.eval(`document.getElementById("albumAdminsList").textContent`));
    check("显示归属账号", /admin/.test(await cdp.eval(`document.getElementById("albumOwnerInfo").textContent`)),
          await cdp.eval(`document.getElementById("albumOwnerInfo").textContent`));

    // 移除授权（confirm 自动确认）→ 区块变空且下拉出现该账号
    await cdp.eval(`document.querySelector("#albumAdminsList .admin-remove").click()`);
    await sleep(1500);
    check("移除授权后区块不再列出该账号", !/e2e_ui_admin/.test(await cdp.eval(`document.getElementById("albumAdminsList").textContent`)),
          await cdp.eval(`document.getElementById("albumAdminsList").textContent`));
    check("移除后「授权已有账号」下拉里出现该账号", /e2e_ui_admin/.test(await cdp.eval(`document.getElementById("grantUserSelect").textContent`)));
    check("移除授权不影响账号本身（用户列表还有它）", (await api("GET", "/users", superToken)).data.some((u) => u.username === TEST_USER));

    // 用「授权已有账号」重新授权
    await cdp.eval(`(() => { const s=document.getElementById("grantUserSelect");
      const o=[...s.options].find(x=>x.textContent===${JSON.stringify(TEST_USER)}); if(o) s.value=o.value; return true; })()`);
    await click(cdp, "#grantExistingBtn");
    await waitFor(cdp, `/e2e_ui_admin/.test(document.getElementById("albumAdminsList").textContent)`, 10000, "重新授权");
    check("「授权已有账号」恢复权限", true);

    // ───── 4. 停用账号后不能登录 ─────
    await click(cdp, "#navUsers");
    await waitFor(cdp, `document.querySelectorAll("#userTableBody tr").length >= 2`);
    check("已登录超管看到「停用」按钮", /停用/.test(await cdp.eval(`document.getElementById("userTableBody").textContent`)));
    await cdp.eval(`(() => { const tr=[...document.querySelectorAll("#userTableBody tr")].find(t=>t.textContent.includes(${JSON.stringify(TEST_USER)}));
      tr.querySelector('[data-act="active"]').click(); return true; })()`);
    await waitFor(cdp, `/已停用/.test(document.getElementById("userTableBody").textContent)`, 10000, "停用生效");
    check("停用后状态显示「已停用」", true);
    check("停用后按钮变成「启用」", /启用/.test(await cdp.eval(`document.getElementById("userTableBody").textContent`)));
    check("停用后后端登录被拒(403)",
      ((await api("POST", "/auth/login", null, { username: TEST_USER, password: newPw })).body || {}).code === 403);

    // 重新启用
    await cdp.eval(`(() => { const tr=[...document.querySelectorAll("#userTableBody tr")].find(t=>t.textContent.includes(${JSON.stringify(TEST_USER)}));
      tr.querySelector('[data-act="active"]').click(); return true; })()`);
    await waitFor(cdp, `/已启用/.test(document.getElementById("userTableBody").textContent)`, 10000, "启用生效");
    check("重新启用成功", true);

    // ───── 5. 相册管理员登录：入口消失 + 只看到被授权相册 ─────
    await click(cdp, "#logoutBtn");
    await waitFor(cdp, `!document.getElementById("authScreen").hidden`);
    await type(cdp, "#loginUser", TEST_USER);
    await type(cdp, "#loginPass", newPw);
    await click(cdp, "#loginSubmit");
    await waitFor(cdp, `!document.getElementById("app").hidden`, 15000, "相册管理员进入后台");
    check("相册管理员 UI 登录成功", true);
    check("相册管理员看不到「用户管理」入口", await cdp.eval(`document.getElementById("navUsers").hidden`));
    check("相册管理员看不到「共享文件」入口", await cdp.eval(`document.getElementById("navFiles").hidden`));
    check("相册管理员看不到「设置」入口", await cdp.eval(`document.getElementById("settingsBtn").hidden`));
    check("相册管理员看不到「新建」按钮（不能建相册）", await cdp.eval(`document.getElementById("createBtn").hidden`));
    check("顶栏显示角色为相册管理员", /相册管理员/.test(await cdp.eval(`document.getElementById("currentUserLabel").textContent`)),
          await cdp.eval(`document.getElementById("currentUserLabel").textContent`));
    await waitFor(cdp, `document.querySelectorAll("#eventsGrid .event-card").length > 0`, 10000, "相册列表");
    const cards = await cdp.eval(`JSON.stringify([...document.querySelectorAll("#eventsGrid .event-card")].map(c => c.dataset.id))`);
    check("相册管理员的相册列表只有被授权的那一个", cards === JSON.stringify([EID]), cards);

    // 强行点「用户管理」（即使隐藏也能被脚本触发）→ 应被挡回相册列表
    await cdp.eval(`document.getElementById("navUsers").click()`);
    await sleep(600);
    check("绕过入口点用户管理 → 被挡回相册列表", !(await cdp.eval(`document.getElementById("viewEvents").hidden`)));
    await cdp.eval(`document.getElementById("navFiles").click()`);
    await sleep(600);
    check("绕过入口点共享文件 → 被挡回相册列表", !(await cdp.eval(`document.getElementById("viewEvents").hidden`)));

    // 进入自己被授权的相册：能管理，但看不到「相册管理员」区块
    await click(cdp, `[data-id="${EID}"] [data-act="enter"]`);
    await waitFor(cdp, `document.getElementById("detailId").textContent.includes("${EID}")`, 15000, "相册详情");
    check("相册管理员能打开被授权相册", true);
    check("相册管理员看不到「相册管理员」区块", await cdp.eval(`document.getElementById("albumAdminsCard").hidden`));
    check("相册管理员能上传（上传区可见）", (await cdp.eval(`document.getElementById("uploadZone").style.display`)) !== "none");

    // 未授权相册 ID → 打不开
    await click(cdp, "#backBtn");
    await sleep(800);
    check("「返回」按钮回到相册列表", !(await cdp.eval(`document.getElementById("viewEvents").hidden`)),
          await cdp.eval(`JSON.stringify({e:!document.getElementById("viewEvents").hidden,d:!document.getElementById("viewDetail").hidden})`));
    const otherEid = (await api("GET", "/events", superToken)).data.find((e) => e.event_id !== EID).event_id;
    await type(cdp, "#enterId", otherEid);
    await click(cdp, "#enterBtn");
    await sleep(1800);
    const vis = await cdp.eval(`JSON.stringify({events: !document.getElementById("viewEvents").hidden, detail: !document.getElementById("viewDetail").hidden})`);
    check("输入未授权相册 ID → 打不开（留在列表页）", !(await cdp.eval(`document.getElementById("viewEvents").hidden`)), "other=" + otherEid + " vis=" + vis);

    check("全程无 JS 异常", cdp.errors.length === 0, JSON.stringify(cdp.errors.slice(0, 2)));

    // ───── 清理 ─────
    await api("DELETE", "/events/" + EID, superToken);
    const u = (await api("GET", "/users", superToken)).data.find((x) => x.username === TEST_USER);
    if (u) await api("DELETE", "/users/" + u.id, superToken);
    const left = (await api("GET", "/users", superToken)).data.map((x) => x.username);
    const albums = (await api("GET", "/events", superToken)).data.map((x) => x.event_name);
    check("清理完成（账号与临时相册已删除）",
      left.indexOf(TEST_USER) === -1 && !albums.some((n) => n.startsWith("e2e前端权限测试")), left.join(",") + " | " + albums.join(","));

    const fails = results.filter((r) => !r).length;
    console.log(`\n==== ${results.length - fails}/${results.length} passed ====`);
    process.exitCode = fails ? 1 : 0;
  } catch (e) {
    console.error("TEST ERROR:", e.message); process.exitCode = 1;
  } finally {
    try { if (cdp) cdp.ws.close(); } catch (e) {}
    chrome.kill("SIGKILL");
    try { fs.rmSync("/tmp/chrome-perm-" + chrome.pid, { recursive: true, force: true }); } catch (e) {}
  }
})();
