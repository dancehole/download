#!/usr/bin/env node
/**
 * e2e-expired-page.js — 浏览器层验证「过期 = 只屏蔽链接」的访问者体验。
 *
 * 用 Headless Chrome + CDP 打开真实部署的页面：
 *   1) 真实已过期的共享文件页 → 必须显示「已过期」错误卡片（不是碎图 / JSON 文件）
 *   2) 未过期的真实相册分享页 → 必须正常渲染出照片（确认没有误伤）
 *
 * 用法：node tests/e2e-expired-page.js
 *   TOKEN_FILE / SF_TOKEN：默认读取环境变量，或用 --sf=xxx --album=yyy 传入
 */
const fs = require("fs");
const { spawn } = require("child_process");

const PORT = 9224;
const CHROME_DIR = "/root/.agent-browser/browsers";
const BASE = process.env.APP_BASE || "https://dancehole.cn/download";

const args = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--"))
    .map((a) => a.replace(/^--/, "").split("=")),
);
const SF_TOKEN = args.sf || process.env.SF_TOKEN;
const ALBUM_TOKEN = args.album || process.env.ALBUM_TOKEN;

function findChrome() {
  const dirs = fs.readdirSync(CHROME_DIR).filter((d) => d.startsWith("chrome-"));
  dirs.sort();
  return `${CHROME_DIR}/${dirs[dirs.length - 1]}/chrome`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      }
    };
  }
  async open() {
    if (this.ws.readyState === WebSocket.OPEN) return;
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expr) {
    const r = await this.send("Runtime.evaluate", {
      expression: expr, awaitPromise: true, returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error("eval: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
    return r.result ? r.result.value : undefined;
  }
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  | " + detail : ""}`);
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

async function waitFor(cdp, expr, timeoutMs = 15000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeoutMs) {
    last = await cdp.eval(expr);
    if (last) return last;
    await sleep(300);
  }
  return last;
}

async function run(cdp) {
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");

  // ── 1. 已过期的共享文件页 ──────────────────────────────────
  await cdp.send("Page.navigate", { url: `${BASE}/share/files/${SF_TOKEN}` });
  await sleep(2500);
  await waitFor(cdp, `!document.getElementById("cardError").hidden`, 15000);
  const errVisible = await cdp.eval(`!document.getElementById("cardError").hidden`);
  const errText = await cdp.eval(`document.getElementById("errorDesc").textContent`);
  const fileVisible = await cdp.eval(`!document.getElementById("cardFile").hidden`);
  check("过期共享文件页：显示错误卡片", errVisible === true);
  check("过期共享文件页：错误文案含「过期」", /过期/.test(errText || ""), String(errText));
  check("过期共享文件页：不显示文件卡片（无下载入口）", fileVisible === false);

  // ── 2. 未过期相册分享页（防误伤）────────────────────────────
  await cdp.send("Page.navigate", { url: `${BASE}/share/${ALBUM_TOKEN}` });
  await sleep(3000);
  const photos = await waitFor(cdp, `document.querySelectorAll(".photo-item, .thumb, img").length`, 20000);
  const bodyLen = await cdp.eval(`document.body.innerText.length`);
  check("未过期相册分享页：正常渲染（有图片元素）", Number(photos) > 0, `元素数=${photos}`);
  check("未过期相册分享页：页面非空白", Number(bodyLen) > 50, `文本长度=${bodyLen}`);
}

(async () => {
  if (!SF_TOKEN || !ALBUM_TOKEN) {
    console.error("需要 --sf=<过期共享文件token> --album=<相册分享token>");
    process.exit(2);
  }
  const chrome = spawn(findChrome(), [
    "--headless=new", `--remote-debugging-port=${PORT}`, "--no-sandbox",
    "--disable-gpu", "--disable-dev-shm-usage",
    "--user-data-dir=/tmp/chrome-e2e-" + process.pid, "about:blank",
  ], { stdio: "ignore" });
  let cdp;
  try {
    cdp = new CDP(await getTargetWs());
    await cdp.open();
    await run(cdp);
    const fails = results.filter((r) => !r.ok).length;
    console.log(`\n==== ${results.length - fails}/${results.length} passed ====`);
    process.exitCode = fails ? 1 : 0;
  } catch (e) {
    console.error("TEST ERROR:", e.message);
    process.exitCode = 1;
  } finally {
    try { if (cdp) cdp.ws.close(); } catch (e) {}
    chrome.kill("SIGKILL");
    try { fs.rmSync("/tmp/chrome-e2e-" + chrome.pid, { recursive: true, force: true }); } catch (e) {}
  }
})();
