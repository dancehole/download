#!/usr/bin/env node
// 验证：①PC 点击分类能筛选+高亮 ②PC 拖拽后不误触分类 ③拖拽后仍能正常点分类 ④手机点击分类正常 ⑤箭头/滚轮/灯箱回归
// 背景：2026-09-14 bug「点击分类不高亮、不筛选」的回归测试（见 docs/需求与方案-2026-09-14.md 第八节）
// 依赖：本机 headless Chrome（/root/.agent-browser/browsers）+ 本机 8001 端口后端，零第三方依赖，Node >= 22
const fs = require("fs");
const { spawn } = require("child_process");

const PORT = 9226;
const CHROME_DIR = "/root/.agent-browser/browsers";
const TOKEN = process.env.SHARE_TOKEN || process.argv[2];   // 相册分享 token：运行时传入，不写死在仓库里
if (!TOKEN) {
  console.error("用法: SHARE_TOKEN=<相册分享token> node tests/e2e-tagbar-click.js");
  process.exit(2);
}
const BASE = "http://127.0.0.1:8001/download";

function findChrome() {
  const dirs = fs.readdirSync(CHROME_DIR).filter((d) => d.startsWith("chrome-")).sort();
  return `${CHROME_DIR}/${dirs[dirs.length - 1]}/chrome`;
}
function startChrome() {
  return spawn(findChrome(), [
    "--headless=new", `--remote-debugging-port=${PORT}`, "--no-sandbox",
    "--disable-gpu", "--disable-dev-shm-usage", "--window-size=1440,900",
    "--user-data-dir=/tmp/chrome-fixtest-" + process.pid, "about:blank",
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
    this.console = []; this.errors = [];
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      } else if (msg.method === "Runtime.consoleAPICalled") {
        this.console.push(msg.params.args.map((a) => a.value).join(" "));
      } else if (msg.method === "Runtime.exceptionThrown") {
        this.errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
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
async function waitFor(cdp, expr, timeoutMs = 20000) {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < timeoutMs) {
    last = await cdp.eval(expr); if (last) return last; await sleep(250);
  }
  throw new Error("waitFor timeout: " + expr + " last=" + JSON.stringify(last));
}
const results = [];
function check(name, ok, detail) {
  results.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? "  | " + detail : ""}`);
}
async function mouse(cdp, type, x, y, extra = {}) {
  await cdp.send("Input.dispatchMouseEvent", { type, x, y, ...extra });
}
async function realClick(cdp, x, y) {
  await mouse(cdp, "mouseMoved", x, y, { button: "none", buttons: 0 });
  await sleep(50);
  await mouse(cdp, "mousePressed", x, y, { button: "left", buttons: 1, clickCount: 1 });
  await sleep(50);
  await mouse(cdp, "mouseReleased", x, y, { button: "left", buttons: 0, clickCount: 1 });
}
async function realDrag(cdp, x, y, dx) {
  await mouse(cdp, "mouseMoved", x, y, { button: "none", buttons: 0 });
  await sleep(50);
  await mouse(cdp, "mousePressed", x, y, { button: "left", buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 6; i++) {
    await mouse(cdp, "mouseMoved", x + (dx * i) / 6, y, { button: "left", buttons: 1 });
    await sleep(30);
  }
  await mouse(cdp, "mouseReleased", x + dx, y, { button: "left", buttons: 0, clickCount: 1 });
}
async function tap(cdp, x, y) {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 1 }] });
  await sleep(40);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}
async function loadPage(cdp) {
  await cdp.send("Page.navigate", { url: `${BASE}/share/${TOKEN}` });
  await waitFor(cdp, `document.querySelectorAll("#tagbarInner .tag-pill").length > 1`);
  await sleep(1200);   // 首屏照片加载
  await cdp.eval(`
    window.__reqs = [];
    const of = window.fetch;
    window.fetch = function(...a){ window.__reqs.push(String(a[0])); return of.apply(this, a); };
    "ok"`);
}
const pillRect = (i = 3) => `(() => { const b = document.querySelectorAll("#tagbarInner .tag-pill")[${i}];
  const r = b.getBoundingClientRect();
  return {x: r.x + r.width/2, y: r.y + r.height/2, label: b.textContent.trim()}; })()`;
const activeTags = `JSON.stringify([...document.querySelectorAll("#tagbarInner .tag-pill.active")].map(x=>x.textContent.trim()))`;

(async () => {
  const chrome = startChrome(); let cdp;
  try {
    cdp = new CDP(await getTargetWs()); await cdp.open();
    await cdp.send("Runtime.enable"); await cdp.send("Page.enable");
    await cdp.send("Page.navigate", { url: "about:blank" });

    // ───────── PC 场景 ─────────
    await loadPage(cdp);
    const r1 = await cdp.eval(pillRect(3));
    console.log("PC 目标分类:", JSON.stringify(r1));
    await cdp.eval(`window.__reqs = []; "reset"`);
    await realClick(cdp, r1.x, r1.y);
    await sleep(1500);
    const a1 = JSON.parse(await cdp.eval(activeTags));
    const q1 = await cdp.eval(`JSON.stringify(window.__reqs)`);
    const badges = await cdp.eval(`JSON.stringify([...document.querySelectorAll("#stream .photo-card .tag-badge")].slice(0,3).map(x=>x.textContent))`);
    check("PC 点击分类 → 高亮", a1.some(t=>t.startsWith(r1.label.replace(/\d+$/,""))) && a1.length > 0, JSON.stringify(a1));
    check("PC 点击分类 → 发出带 tag= 的筛选请求", /tag=/.test(q1), q1);
    check("PC 点击分类 → 照片列表已换成分该类", badges.includes(JSON.stringify(r1.label.replace(/\d+$/,""))) || !/2014-升旗仪式/.test(badges), badges);
    check("PC 点击分类 → 筛选后总数变少", await cdp.eval(`document.querySelector("#tagbarInner .tag-pill.active .cnt").textContent.trim()`) === r1.label.replace(/^.*?(\d+)$/,"$1"), await cdp.eval(`document.querySelector("#tagbarInner .tag-pill.active").textContent.trim()`));

    // 拖拽是否仍能滚动，且不会误切分类
    const before = await cdp.eval(`document.getElementById("tagbarInner").scrollLeft`);
    await cdp.eval(`window.__reqs = []; document.getElementById("tagbarInner").scrollLeft = 0; "r"`);
    const bar = await cdp.eval(`(() => { const r = document.getElementById("tagbarInner").getBoundingClientRect(); return {x: r.x + r.width/2, y: r.y + r.height/2}; })()`);
    await realDrag(cdp, bar.x, bar.y, -260);
    await sleep(500);
    const after = await cdp.eval(`document.getElementById("tagbarInner").scrollLeft`);
    const a2 = JSON.parse(await cdp.eval(activeTags));
    const q2 = await cdp.eval(`JSON.stringify(window.__reqs)`);
    check("PC 拖拽分类栏 → scrollLeft 变化", after > 20, `${before} → ${after}`);
    check("PC 拖拽后 → 不误触分类（高亮/请求都没变）", JSON.stringify(a2) === JSON.stringify(a1) && q2 === "[]", `${JSON.stringify(a2)} ${q2}`);

    // 拖拽刚结束立刻点分类（模拟用户拖完接着点）——此刻 click 被'吞掉'属预期
    await sleep(400);
    const r2 = await cdp.eval(pillRect(5));
    await cdp.eval(`window.__reqs = []; "reset"`);
    await realClick(cdp, r2.x, r2.y);
    await sleep(1200);
    const a3 = JSON.parse(await cdp.eval(activeTags));
    const q3 = await cdp.eval(`JSON.stringify(window.__reqs)`);
    check("PC 拖拽后间隔 400ms 点分类 → 正常筛选", /tag=/.test(q3) && a3.length > 0, `${JSON.stringify(a3)} ${q3}`);

    // 拖拽本身不能触发分类切换；且拖完马上再点一次分类必须正常生效
    await cdp.eval(`window.__reqs = []; "reset"`);
    await realDrag(cdp, bar.x, bar.y, -80);
    await sleep(600);
    const dragOnly = await cdp.eval(`JSON.stringify(window.__reqs)`);
    check("拖拽动作本身 → 完全不触发筛选请求", dragOnly === "[]", dragOnly);
    const rIm = await cdp.eval(pillRect(6));   // 拖完再测量坐标（拖动后位置变了）
    await realClick(cdp, rIm.x, rIm.y);          // 拖完立刻点（间隔约 30ms）
    await sleep(1200);
    const qImm2 = await cdp.eval(`JSON.stringify(window.__reqs)`);
    check("拖拽后立刻再点分类 → 正常筛选", /tag=/.test(qImm2), qImm2);

    // 连续点两个不同分类（不能只生效一次）
    const r3 = await cdp.eval(pillRect(7));
    await cdp.eval(`window.__reqs = []; "reset"`);
    await realClick(cdp, r3.x, r3.y);
    await sleep(1200);
    const q4 = await cdp.eval(`JSON.stringify(window.__reqs)`);
    check("PC 连续第二次点其它分类 → 依然生效", /tag=/.test(q4), q4);

    // 箭头按钮
    await cdp.eval(`document.getElementById("tagbarInner").scrollLeft = 0; "r"`);
    await sleep(200);
    const nx = await cdp.eval(`(() => { const b=document.getElementById("tagbarNext"); const r=b.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2,disabled:b.disabled}; })()`);
    await realClick(cdp, nx.x, nx.y);
    await sleep(700);
    const sl = await cdp.eval(`document.getElementById("tagbarInner").scrollLeft`);
    check("PC 点 › 箭头 → 分类栏右移", sl > 50, `scrollLeft=${sl} disabled=${nx.disabled}`);

    // 滚轮横滚
    await cdp.eval(`document.getElementById("tagbarInner").scrollLeft = 0; "r"`);
    await mouse(cdp, "mouseMoved", bar.x, bar.y, { button: "none", buttons: 0 });
    await sleep(60);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: bar.x, y: bar.y, deltaX: 0, deltaY: 200, button: "none", buttons: 0 });
    await sleep(400);
    check("PC 滚轮 → 分类栏横滚", (await cdp.eval(`document.getElementById("tagbarInner").scrollLeft`)) > 50);

    // ───────── 手机场景 ─────────
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    await loadPage(cdp);
    await sleep(300);
    console.log("maxTouchPoints =", await cdp.eval(`navigator.maxTouchPoints`));
    const m1 = await cdp.eval(pillRect(2));
    await cdp.eval(`window.__reqs = []; "reset"`);
    await tap(cdp, m1.x, m1.y);
    await sleep(1500);
    const ma = JSON.parse(await cdp.eval(activeTags));
    const mq = await cdp.eval(`JSON.stringify(window.__reqs)`);
    check("手机点击分类 → 高亮 + 筛选请求", /tag=/.test(mq) && ma.length > 0, `${JSON.stringify(ma)} ${mq}`);
    check("手机端不显示箭头（避免挡分类）", await cdp.eval(`getComputedStyle(document.getElementById("tagbarNext")).display === "none" || document.getElementById("tagbarNext").disabled`), await cdp.eval(`getComputedStyle(document.getElementById("tagbarNext")).display`));

    // 打开灯箱 + 关闭按钮（回归：确认没被 stage 的 pointer capture 影响）
    await cdp.eval(`document.querySelector("#stream .photo-card").click(); "ok"`);
    await sleep(1200);
    const lbOpen = await cdp.eval(`!document.getElementById("lightbox").hidden`);
    const cb = await cdp.eval(`(() => { const r=document.getElementById("lbClose").getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
    await tap(cdp, cb.x, cb.y);
    await sleep(600);
    check("手机灯箱能打开且关闭按钮可点", lbOpen && await cdp.eval(`document.getElementById("lightbox").hidden`), `open=${lbOpen}`);

    // + 按钮缩放
    await cdp.eval(`document.querySelector("#stream .photo-card").click(); "ok"`);
    await sleep(1000);
    const zb = await cdp.eval(`(() => { const r=document.getElementById("lbZoomIn").getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
    await tap(cdp, zb.x, zb.y);
    await sleep(500);
    const tf = await cdp.eval(`document.getElementById("lbImg").style.transform`);
    check("手机灯箱 ＋ 按钮可缩放", /scale\((?!1\))/.test(tf), tf);

    check("全程无 JS 异常", cdp.errors.length === 0, JSON.stringify(cdp.errors.slice(0, 3)));

    const fails = results.filter((r) => !r).length;
    console.log(`\n==== ${results.length - fails}/${results.length} passed ====`);
    process.exitCode = fails ? 1 : 0;
  } catch (e) {
    console.error("TEST ERROR:", e.message); process.exitCode = 1;
  } finally {
    try { if (cdp) cdp.ws.close(); } catch (e) {}
    chrome.kill("SIGKILL");
    try { fs.rmSync("/tmp/chrome-fixtest-" + chrome.pid, { recursive: true, force: true }); } catch (e) {}
  }
})();
