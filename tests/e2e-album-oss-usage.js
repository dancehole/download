#!/usr/bin/env node
/**
 * OSS 占用（涉及计费）前端 E2E — Headless Chrome + CDP，真实登录 + 真实鼠标点击。
 *
 * 断言：
 *   1. 相册「空间与清理」显示 OSS 占用，数字与后端 API 完全一致（不是前端自己算的）
 *   2. 明细行包含桶总用量（计费口径）、统计时间与延迟说明、计费构成说明
 *   3. 已清空 OSS 的相册显示「OSS 占用 0 B（该相册无对象）」
 *   4. 折叠头摘要带上 OSS 占用
 *   5. 「刷新 OSS 用量」按钮走 refresh=1 并给出 toast
 *   6. 后端 60s 缓存生效（第二次请求 cached=true）
 *   7. 375px 宽度无横向溢出
 *
 * 用法：ADMIN_USER=xxx ADMIN_PW=yyy node tests/e2e-album-oss-usage.js
 *   （建议用 tests/tmp_super_admin.py 建临时超管，别用真实 admin 账号）
 */
const fs = require("fs");
const { spawn } = require("child_process");

const PORT = 9229;
const CHROME_DIR = "/root/.agent-browser/browsers";
const ROOT = "http://127.0.0.1:8001/download";
const API = ROOT + "/api";
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PW = process.env.ADMIN_PW;
const TEMP_ALBUM = "e2eOSS用量测试相册";
const SHOT_DIR = "/tmp/e2e-oss-usage";

if (!ADMIN_PW) { console.error("用法: ADMIN_USER=xxx ADMIN_PW=yyy node tests/e2e-album-oss-usage.js"); process.exit(2); }

function findChrome() {
  const dirs = fs.readdirSync(CHROME_DIR).filter((d) => d.startsWith("chrome-")).sort();
  return `${CHROME_DIR}/${dirs[dirs.length - 1]}/chrome`;
}
function startChrome() {
  // stderr 落盘：chrome 起不来时（如端口冲突/参数错误）能直接看到原因
  const log = fs.openSync(`/tmp/chrome-oss-${process.pid}.log`, "a");
  return spawn(findChrome(), [
    "--headless=new", `--remote-debugging-port=${PORT}`, "--no-sandbox",
    "--disable-gpu", "--disable-dev-shm-usage", "--window-size=1440,900",
    "--user-data-dir=/tmp/chrome-oss-" + process.pid, "about:blank",
  ], { stdio: ["ignore", log, log] });
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
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
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
    if (r.exceptionDetails) throw new Error("eval: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result ? r.result.value : undefined;
  }
  async shot(name) {
    try {
      const r = await this.send("Page.captureScreenshot", { format: "png" });
      fs.mkdirSync(SHOT_DIR, { recursive: true });
      fs.writeFileSync(`${SHOT_DIR}/${name}.png`, Buffer.from(r.data, "base64"));
    } catch (e) {}
  }
}
async function waitFor(cdp, expr, timeoutMs = 15000, label = "") {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < timeoutMs) {
    try { last = await cdp.eval(expr); if (last) return last; } catch (e) { last = "err:" + e.message; }
    await sleep(250);
  }
  throw new Error("waitFor 超时: " + (label || expr) + " last=" + JSON.stringify(last));
}
async function click(cdp, sel) {
  const box = JSON.parse(await cdp.eval(`(() => { const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return "null"; el.scrollIntoView({block:"center"});
    const r = el.getBoundingClientRect(); return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2}); })()`));
  if (!box) throw new Error("click target not found: " + sel);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y, button: "none", buttons: 0 });
  await sleep(40);
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", buttons: 1, clickCount: 1 });
  await sleep(40);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", buttons: 0, clickCount: 1 });
  await sleep(150);
}
async function type(cdp, sel, text) {
  await cdp.eval(`(() => { const el = document.querySelector(${JSON.stringify(sel)});
    el.focus(); el.value = ${JSON.stringify(text)};
    el.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
}
async function uiLogin(cdp, user, pw) {
  await waitFor(cdp, `!document.getElementById("authScreen").hidden`, 15000, "登录页");
  await type(cdp, "#loginUser", user);
  await type(cdp, "#loginPass", pw);
  await click(cdp, "#loginSubmit");
  await waitFor(cdp, `!document.getElementById("app").hidden`, 15000, "进入后台");
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

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  | " + detail : ""}`);
}

async function openAlbum(cdp, eid) {
  // 重新加载后台再进相册：
  //   1) localStorage 里有 token，会自动登录；
  //   2) 相册列表必须重新拉取——临时相册是通过 API 建的，不刷新前端看不到它。
  await cdp.send("Page.navigate", { url: ROOT + "/admin" });
  await waitFor(cdp, `!document.getElementById("app").hidden`, 15000, "后台已登录");
  await waitFor(cdp, `document.querySelectorAll("#eventsGrid .event-card").length > 0`, 15000, "相册列表");
  await click(cdp, `[data-id="${eid}"] [data-act="enter"]`);
  await waitFor(cdp, `!document.getElementById("viewDetail").hidden && document.getElementById("detailId").textContent.includes("${eid}")`, 15000, "详情页 " + eid);
  await sleep(300);
}

(async () => {
  const chrome = startChrome(); let cdp; let tempEid = null;
  try {
    let r = await api("POST", "/auth/login", null, { username: ADMIN_USER, password: ADMIN_PW });
    const superToken = r.data && r.data.token;
    if (!superToken) throw new Error("超管登录失败: " + JSON.stringify(r));

    // 清掉本测试的历史残留
    for (const ev of ((await api("GET", "/events", superToken)).data || [])) {
      if (ev.event_name.startsWith("e2eOSS用量测试")) await api("DELETE", "/events/" + ev.event_id, superToken);
    }
    r = await api("POST", "/events", superToken, { event_name: TEMP_ALBUM });
    tempEid = r.data.event_id;
    const albums = (await api("GET", "/events", superToken)).data;
    console.log("临时空相册:", tempEid, "| 现有相册:", albums.map((a) => a.event_id).join(","));

    cdp = new CDP(await getTargetWs()); await cdp.open();
    await cdp.send("Runtime.enable"); await cdp.send("Page.enable");
    await cdp.send("Page.navigate", { url: ROOT + "/admin" });
    await uiLogin(cdp, ADMIN_USER, ADMIN_PW);

    // ── 1. 有 OSS 对象的相册：页面数字必须等于后端数字 ──
    let target = null;
    for (const a of albums) {
      if (a.event_id === tempEid) continue;
      const u = await api("GET", `/events/${a.event_id}/oss-usage`, superToken);
      if (u.data && u.data.objects > 0) { target = { album: a, usage: u.data, cachedFirst: u.data.cached }; break; }
    }
    if (!target) throw new Error("找不到有 OSS 对象的相册，无法验证非零场景");
    console.log(`目标相册 ${target.album.event_id}: ${target.usage.bytes_text} / ${target.usage.objects} 个对象`);

    await openAlbum(cdp, target.album.event_id);
    await click(cdp, "#albumSettingsToggle");
    await click(cdp, "#segTabCleanup");
    await waitFor(cdp, `document.getElementById("segPaneCleanup") && !document.getElementById("segPaneCleanup").hidden`, 10000, "清理分段");
    await waitFor(cdp, `document.getElementById("ossUsageInfo").textContent.includes("OSS")`, 20000, "OSS 占用文案");

    const info = await cdp.eval(`document.getElementById("ossUsageInfo").textContent`);
    const detail = await cdp.eval(`document.getElementById("ossUsageDetail").textContent`);
    const detailHidden = await cdp.eval(`document.getElementById("ossUsageDetail").hidden`);
    console.log("    页面: " + info);
    console.log("    明细: " + detail);
    check("清理分段显示 OSS 占用（含字节数）", info.includes(target.usage.bytes_text), info);
    check("清理分段显示对象个数", info.includes(String(target.usage.objects)), info);
    check("明细行含桶总用量（计费口径）", /桶总用量|Bucket total/.test(detail) && detailHidden === false, detail.slice(0, 80));
    if (target.usage.bucket) {
      check("桶数字与 API 一致", detail.includes(target.usage.bucket.bytes_text), target.usage.bucket.bytes_text);
    }
    check("明细行说明计费构成（存储×单价+流量+请求）", /计费 = 存储量/.test(detail), "ok");
    check("摘要（折叠头）包含 OSS 占用", /OSS/.test(await cdp.eval(`document.getElementById("albumSettingsSummary").textContent`)),
      await cdp.eval(`document.getElementById("albumSettingsSummary").textContent`));
    await cdp.shot("01-OSS占用-有对象");

    // ── 2. 后端 60s 缓存生效 ──
    const again = await api("GET", `/events/${target.album.event_id}/oss-usage`, superToken);
    check("第二次请求命中进程内缓存（cached=true）", again.data && again.data.cached === true, "cached=" + (again.data && again.data.cached));
    const forced = await api("GET", `/events/${target.album.event_id}/oss-usage?refresh=1`, superToken);
    check("refresh=1 跳过缓存（cached=false）", forced.data && forced.data.cached === false, "cached=" + (forced.data && forced.data.cached));

    // ── 3. 刷新按钮：真实点击 + toast ──
    await click(cdp, "#ossRefreshBtn");
    await waitFor(cdp, `!document.getElementById("toast").hidden`, 10000, "刷新 toast");
    const toast = await cdp.eval(`document.getElementById("toast").textContent`);
    check("点「刷新 OSS 用量」出现提示", /刷新|refresh/i.test(toast), toast);
    const infoAfter = await cdp.eval(`document.getElementById("ossUsageInfo").textContent`);
    check("刷新后数字仍与后端一致", infoAfter.includes(target.usage.bytes_text) && infoAfter.includes(String(target.usage.objects)), infoAfter);
    await sleep(3000);

    // ── 4. 空相册：0 对象分支 ──
    const tempUsage = await api("GET", `/events/${tempEid}/oss-usage`, superToken);
    check("新建空相册后端返回 0 对象", tempUsage.data.objects === 0, JSON.stringify(tempUsage.data.bytes_text));
    await openAlbum(cdp, tempEid);
    await click(cdp, "#albumSettingsToggle");
    await click(cdp, "#segTabCleanup");
    await waitFor(cdp, `document.getElementById("ossUsageInfo").textContent.includes("OSS")`, 20000, "空相册 OSS 文案");
    const info0 = await cdp.eval(`document.getElementById("ossUsageInfo").textContent`);
    check("空相册显示「OSS 占用 0 B（该相册无对象）」", /0 B/.test(info0), info0);
    check("空相册与上一个相册的数字未串台（已作废旧值）", !info0.includes(String(target.usage.objects)), info0);
    await cdp.shot("02-OSS占用-空相册");

    // ── 5. 375px 无横向溢出 ──
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 375, height: 812, deviceScaleFactor: 1, mobile: false });
    await sleep(900);
    // 先确认模拟真的生效（innerWidth≈375），否则「无溢出」会是假绿
    const m = JSON.parse(await cdp.eval(`JSON.stringify({sw: document.documentElement.scrollWidth, iw: window.innerWidth})`));
    check("375px 设备模拟生效", Math.abs(m.iw - 375) <= 2, `innerWidth=${m.iw}`);
    check("375px 清理分段无横向溢出", m.sw <= m.iw + 1, JSON.stringify(m));
    const ossRowVisible = await cdp.eval(`(() => { const el = document.getElementById("ossUsageInfo");
      const r = el.getBoundingClientRect(); return r.width > 0 && r.right <= window.innerWidth + 1; })()`);
    check("375px 下 OSS 占用行完整可见（未溢出屏幕）", ossRowVisible === true);
    await cdp.shot("03-375宽");
    await cdp.send("Emulation.clearDeviceMetricsOverride");
  } catch (e) {
    console.error("TEST ERROR:", e.message);
    results.push({ name: "测试异常", ok: false });
  } finally {
    try { if (cdp) cdp.ws.close(); } catch (e) {}
    chrome.kill("SIGKILL");
    try { fs.rmSync("/tmp/chrome-oss-" + chrome.pid, { recursive: true, force: true }); } catch (e) {}
    // 清理临时相册
    try {
      const r = await api("POST", "/auth/login", null, { username: ADMIN_USER, password: ADMIN_PW });
      const tk = r.data && r.data.token;
      if (tk && tempEid) await api("DELETE", "/events/" + tempEid, tk);
    } catch (e) {}
    const fails = results.filter((x) => !x.ok).length;
    console.log(`\n==== ${results.length - fails}/${results.length} passed ====`);
    if (fails) for (const f of results.filter((x) => !x.ok)) console.log("  FAIL:", f.name);
    process.exitCode = fails ? 1 : 0;
  }
})();
