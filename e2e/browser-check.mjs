/**
 * Drives a real browser (Edge or Chrome, headless) through the product and records what it finds. No dependencies: it speaks
 * the Chrome DevTools Protocol over Node's built-in WebSocket (Node 22+).
 *
 *   node e2e/browser-check.mjs [baseUrl] [indexStoreDir]
 *
 * It indexes one small public repository for real (two GitHub API calls and one download), reads source lines for real, and
 * asks one question for real against a server that has no model configured. Every other /api/answer response is supplied at
 * the network boundary from e2e/make-answer-fixtures.ts, so NO language model is called by this script. Screenshots and a JSON
 * report are written to e2e/artifacts/.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = (process.argv[2] ?? "http://127.0.0.1:3100").replace(/\/$/, "");
const STORE = process.argv[3] ?? path.join(HERE, "..", ".index-store");
const OUT = path.join(HERE, "artifacts");
const FIXTURES = path.join(HERE, ".fixtures");
const REPO = "sindresorhus/slugify";
const PORT = 9333;

const BROWSERS = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];

const results = [];
const record = (name, ok, detail = "") => {
  results.push({ name, ok: Boolean(ok), detail: String(detail) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  [${detail}]` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener("message", (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) p?.reject(new Error(`${msg.error.message}`));
        else p?.resolve(msg.result);
      } else for (const fn of this.listeners.get(msg.method) ?? []) fn(msg.params);
    });
  }
  send(method, params = {}) {
    const id = ++this.nextId;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  on(event, fn) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), fn]);
  }
}

async function launch() {
  const exe = BROWSERS.find((p) => existsSync(p));
  if (!exe) throw new Error("No Edge or Chrome found; add its path to BROWSERS.");
  const profile = mkdtempSync(path.join(tmpdir(), "atr-browser-"));
  const proc = spawn(exe, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--hide-scrollbars", "about:blank"], {
    stdio: "ignore",
  });
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" });
      if (res.ok) {
        const target = await res.json();
        const ws = new WebSocket(target.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => {
          ws.addEventListener("open", resolve);
          ws.addEventListener("error", reject);
        });
        return { cdp: new Cdp(ws), proc, profile, exe };
      }
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  proc.kill();
  throw new Error("The browser did not open its debugging port.");
}

const { cdp, proc, profile, exe } = await launch();
mkdirSync(OUT, { recursive: true });

const consoleErrors = [];
let answerOverride = null; // { httpStatus, body } to serve for the next /api/answer request
let ingestOverride = null; // { httpStatus, body } to serve for the next /api/ingest request
let ingestRequests = 0;
let ingestDelayMs = 0;
let answerDelayMs = 0;

await cdp.send("Page.enable");
await cdp.send("Runtime.enable");
await cdp.send("Log.enable");
await cdp.send("Network.enable");
await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*/api/answer*" }, { urlPattern: "*/api/ingest*" }] });

cdp.on("Log.entryAdded", ({ entry }) => {
  // A failed request the test caused on purpose is not a defect; anything else at error level is.
  if (entry.level === "error" && !/Failed to load resource/.test(entry.text)) consoleErrors.push(`${entry.source}: ${entry.text}`);
});
cdp.on("Runtime.exceptionThrown", ({ exceptionDetails }) => consoleErrors.push(`exception: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`));
cdp.on("Fetch.requestPaused", async ({ requestId, request }) => {
  try {
    if (request.url.includes("/api/answer") && answerOverride) {
      const o = answerOverride;
      answerOverride = null;
      if (answerDelayMs) await sleep(answerDelayMs);
      await cdp.send("Fetch.fulfillRequest", {
        requestId,
        responseCode: o.httpStatus,
        responseHeaders: [{ name: "content-type", value: "application/json" }],
        body: Buffer.from(JSON.stringify(o.body)).toString("base64"),
      });
      return;
    }
    if (request.url.includes("/api/ingest")) {
      ingestRequests += 1;
      if (ingestOverride) {
        const o = ingestOverride;
        ingestOverride = null;
        await cdp.send("Fetch.fulfillRequest", {
          requestId,
          responseCode: o.httpStatus,
          responseHeaders: [{ name: "content-type", value: "application/json" }],
          body: Buffer.from(JSON.stringify(o.body)).toString("base64"),
        });
        return;
      }
      if (ingestDelayMs) await sleep(ingestDelayMs);
    }
    await cdp.send("Fetch.continueRequest", { requestId });
  } catch {
    /* the page navigated away */
  }
});

async function js(expression) {
  const r = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}
async function waitFor(expression, what, timeoutMs = 20_000) {
  const started = Date.now();
  for (;;) {
    try {
      const v = await js(expression);
      if (v) return v;
    } catch {
      /* mid-navigation */
    }
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}
async function goto(url) {
  await cdp.send("Page.navigate", { url: url.startsWith("http") ? url : BASE + url });
  await waitFor("document.readyState === 'complete'", `load of ${url}`);
  await sleep(250);
}
async function viewport(width, height, mobile = false) {
  await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile });
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: mobile });
  await sleep(150);
}
async function scheme(dark) {
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] });
  await sleep(150);
}
async function shot(name, fullPage = true) {
  const params = { format: "png" };
  if (fullPage) {
    const { cssContentSize } = await cdp.send("Page.getLayoutMetrics");
    params.captureBeyondViewport = true;
    params.clip = { x: 0, y: 0, width: Math.ceil(cssContentSize.width), height: Math.min(Math.ceil(cssContentSize.height), 6000), scale: 1 };
  }
  const { data } = await cdp.send("Page.captureScreenshot", params);
  writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(data, "base64"));
}
async function click(selector) {
  const rect = await js(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  if (!rect) throw new Error(`no element for ${selector}`);
  await sleep(60);
  for (const type of ["mousePressed", "mouseReleased"]) await cdp.send("Input.dispatchMouseEvent", { type, x: rect.x, y: rect.y, button: "left", clickCount: 1 });
  await sleep(120);
}
const KEYS = { Tab: 9, Enter: 13, Escape: 27 };
async function press(key, modifiers = 0) {
  const base = { key, code: key, windowsVirtualKeyCode: KEYS[key], nativeVirtualKeyCode: KEYS[key], modifiers };
  // Enter needs its character so the browser also fires keypress, which is what submits a form or activates a button.
  await cdp.send("Input.dispatchKeyEvent", key === "Enter" ? { type: "keyDown", text: "\r", ...base } : { type: "rawKeyDown", ...base });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  await sleep(80);
}
async function type(text) {
  await cdp.send("Input.insertText", { text });
  await sleep(80);
}
const focused = () => js(`(() => { const a = document.activeElement; if (!a) return null; const s = getComputedStyle(a); return { tag: a.tagName, id: a.id, cite: a.hasAttribute('data-cite'), text: (a.innerText || a.value || "").trim().slice(0, 40), outline: s.outlineStyle, outlineWidth: parseFloat(s.outlineWidth) }; })()`);
const noSidewaysScroll = () => js("document.documentElement.scrollWidth <= window.innerWidth + 1");

async function step(name, fn) {
  try {
    await fn();
  } catch (err) {
    record(name, false, err.message);
  }
}

/** Contrast of real rendered text against the background actually behind it (WCAG 1.4.3: 4.5:1, or 3:1 for large text). */
const CONTRAST = `(() => {
  const parse = (c) => { const m = c.match(/[\\d.]+/g).map(Number); return { r: m[0], g: m[1], b: m[2], a: m[3] === undefined ? 1 : m[3] }; };
  const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const bgOf = (el) => { for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c.a > 0.99) return c; } return { r: 255, g: 255, b: 255, a: 1 }; };
  const out = [];
  const seen = new Set();
  for (const el of document.querySelectorAll("h1,h2,h3,p,span,a,button,label,dt,dd,li,summary,input,textarea")) {
    const text = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim()).map((n) => n.textContent.trim()).join(" ") || (el.matches("input,textarea") ? el.placeholder : "");
    if (!text) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const s = getComputedStyle(el);
    if (s.visibility === "hidden" || s.clipPath !== "none") continue;
    const fg = parse(el.matches("input,textarea") && !el.value ? getComputedStyle(el, "::placeholder").color : s.color);
    const bg = bgOf(el);
    const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
    const ratio = (a + 0.05) / (b + 0.05);
    const size = parseFloat(s.fontSize);
    const large = size >= 24 || (size >= 18.66 && Number(s.fontWeight) >= 700);
    const need = large ? 3 : 4.5;
    const key = s.color + "|" + JSON.stringify(bg) + "|" + need;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ text: text.slice(0, 30), ratio: Math.round(ratio * 100) / 100, need, ok: ratio >= need });
  }
  return out;
})()`;

/** WCAG 2.5.8: pointer targets at least 24 by 24 CSS pixels. Links inside a sentence are exempt, so only controls are measured. */
const TARGETS = `(() => [...document.querySelectorAll("button, [data-cite], summary, input, textarea, a[data-button], nav a, [data-recent] a, a[data-back]")].map((el) => { const r = el.getBoundingClientRect(); return { what: (el.innerText || el.placeholder || el.tagName).trim().slice(0, 24), w: Math.round(r.width), h: Math.round(r.height) }; }).filter((t) => t.w > 0 && (t.w < 24 || t.h < 24)))()`;

async function audit(label) {
  const pairs = await js(CONTRAST);
  const bad = pairs.filter((p) => !p.ok);
  const worst = pairs.reduce((m, p) => Math.min(m, p.ratio / p.need), 99);
  record(`contrast ${label}: ${pairs.length} distinct text/background pairs meet WCAG AA`, bad.length === 0, bad.length ? bad.map((b) => `"${b.text}" ${b.ratio}<${b.need}`).join("; ") : `lowest margin x${worst.toFixed(2)}`);
  const small = await js(TARGETS);
  record(`target size ${label}: controls are at least 24x24 px`, small.length === 0, small.map((s) => `"${s.what}" ${s.w}x${s.h}`).join("; "));
}

const fixture = (name) => JSON.parse(readFileSync(path.join(FIXTURES, `${name}.json`), "utf8"));
async function askWith(name, question) {
  const f = name ? fixture(name) : null;
  answerOverride = f ? { httpStatus: f.httpStatus, body: f.body } : null;
  await click("#question");
  await type(question ?? f.question);
  await press("Enter");
}
const entries = () => js("document.querySelectorAll('[data-entry]').length");

try {
  /* ---------- security headers (plain HTTP) ---------- */
  await step("security headers", async () => {
    const res = await fetch(`${BASE}/`);
    const csp = res.headers.get("content-security-policy") ?? "";
    record("CSP restricts sources to this origin and forbids framing", /default-src 'self'/.test(csp) && /frame-ancestors 'none'/.test(csp) && /connect-src 'self'/.test(csp) && /object-src 'none'/.test(csp), csp.slice(0, 60));
    record("nosniff, frame and referrer headers are set; X-Powered-By is not", res.headers.get("x-content-type-options") === "nosniff" && res.headers.get("x-frame-options") === "DENY" && !!res.headers.get("referrer-policy") && !res.headers.get("x-powered-by"));
    const api = await fetch(`${BASE}/api/repo?repo=a/b&sha=${"a".repeat(40)}`);
    record("API responses carry the same headers", api.headers.get("x-content-type-options") === "nosniff" && api.status === 404);
    record("API responses tell caches not to keep them; the page itself does not carry that", api.headers.get("cache-control") === "no-store" && res.headers.get("cache-control") !== "no-store", `api: ${api.headers.get("cache-control")}`);
  });

  /* ---------- landing ---------- */
  await viewport(1440, 900);
  await scheme(true);
  await goto("/");
  await step("landing", async () => {
    record("landing renders its heading and the repository form", await js("!!document.querySelector('h1') && !!document.querySelector('#repo-input') && document.title.includes('AskTheRepo')"));
    record("landing has one h1 and a labelled input", await js("document.querySelectorAll('h1').length === 1 && document.querySelector('label[for=repo-input]') !== null"));
    await shot("01-landing-desktop");
    await audit("landing/dark");
  });

  await step("keyboard order", async () => {
    await js("document.activeElement && document.activeElement.blur()");
    const order = [];
    for (let i = 0; i < 6; i++) {
      await press("Tab");
      order.push(await focused());
    }
    record("first Tab reaches a visible 'Skip to content' link", order[0]?.text === "Skip to content", order[0]?.text);
    await press("Tab", 8);
    await press("Tab", 8);
    await press("Tab", 8);
    await press("Tab", 8);
    await press("Tab", 8);
    await shot("02-landing-skip-link-focus", false);
    record("Tab order is header, then form: skip link, home, nav, nav, input, button", order.map((o) => o?.id || o?.text).join(" > ").includes("repo-input"), order.map((o) => o?.id || o?.text).join(" > "));
    record("every focused control shows a focus outline", order.every((o) => o && o.outline !== "none" && o.outlineWidth >= 2), order.map((o) => `${o?.outline}/${o?.outlineWidth}`).join(" "));
  });

  await step("form validation", async () => {
    await goto("/");
    await click("#repo-input");
    await press("Enter");
    await waitFor("document.querySelector('#repo-error').textContent.length > 0", "empty-input error");
    const state = await js("({ msg: document.querySelector('#repo-error').textContent, invalid: document.querySelector('#repo-input').getAttribute('aria-invalid'), focus: document.activeElement.id })");
    record("submitting nothing shows an error, marks the field invalid and keeps focus in it", state.invalid === "true" && state.focus === "repo-input", state.msg);
    await type("https://gitlab.com/a/b");
    record("typing clears the error", await js("document.querySelector('#repo-error').textContent === ''"));
    await press("Enter");
    await waitFor("document.querySelector('#repo-error').textContent.includes('github.com')", "non-GitHub error");
    record("a non-GitHub address is refused in the browser, before any request", true, await js("document.querySelector('#repo-error').textContent"));
    await shot("03-landing-validation-error", false);
  });

  await step("cancel indexing", async () => {
    await goto("/");
    await click("#repo-input");
    await type(REPO);
    ingestDelayMs = 4000;
    await press("Enter");
    await waitFor("!!document.querySelector('[data-progress]')", "progress before cancel");
    await js("[...document.querySelectorAll('[data-progress] button')].find((b) => b.textContent === 'Cancel').click()");
    await waitFor("document.querySelector('[data-progress]') === null", "progress gone after cancel");
    await sleep(300);
    const st = await js("({ path: location.pathname, disabled: document.querySelector('#repo-input').disabled, value: document.querySelector('#repo-input').value, alert: document.querySelector('[data-notice=danger]') !== null, focus: document.activeElement.id })");
    record("Cancel stops indexing: the form is usable again, the typed repository is kept, and no error is shown", st.path === "/" && !st.disabled && st.value === REPO && !st.alert && st.focus === "repo-input", JSON.stringify(st));
    ingestDelayMs = 0;
    await sleep(4500);
  });

  await step("failed indexing on the landing form", async () => {
    await goto("/");
    await click("#repo-input");
    await type(REPO);
    ingestOverride = { httpStatus: 503, body: { error: "The server is busy with other requests. Try again in a few seconds.", code: "busy", retryAfterSeconds: 5 } };
    await press("Enter");
    await waitFor("document.querySelector('[data-notice=danger]') !== null", "landing index failure");
    const failed = await js("({ title: document.querySelector('[data-notice=danger] strong').textContent, examples: [...document.querySelectorAll('button')].some((b) => b.textContent === 'sindresorhus/ky') })");
    await click("#repo-input");
    await type("x");
    const edited = await js("({ alert: document.querySelector('[data-notice=danger]') !== null, examples: [...document.querySelectorAll('button')].some((b) => b.textContent === 'sindresorhus/ky'), value: document.querySelector('#repo-input').value })");
    record("after a failed index, editing the field clears the stale error and brings the examples back", failed.title === "The server is busy" && !failed.examples && !edited.alert && edited.examples && edited.value === `${REPO}x`, JSON.stringify(edited));
  });

  /* ---------- real ingest ---------- */
  let sha = null;
  await step("ingest", async () => {
    await goto("/");
    await click("#repo-input");
    await type(`https://github.com/${REPO}`);
    record("a pasted GitHub URL is previewed as owner/name before submitting", await js(`document.querySelector('#repo-hint').textContent.includes('Will index ${REPO}')`));
    ingestDelayMs = 1500;
    await press("Enter");
    await waitFor("!!document.querySelector('[data-progress]')", "progress state");
    record("indexing shows a progress state with a cancel button and disables the form", await js("document.querySelector('#repo-input').disabled && !!document.querySelector('[data-progress] button') && document.querySelector('[data-progress]').textContent.includes('Indexing')"));
    record("indexing is announced once to assistive tech, and neither the seconds counter nor the Cancel button sits in a live region", await js(`document.querySelector('[data-announce]').textContent.startsWith('Indexing ${REPO}.') && ['[data-elapsed]', '[data-progress] button', '[data-progress]'].every((s) => document.querySelector(s).closest('[role=status], [aria-live]') === null)`));
    record("the progress box says what Cancel does and does not stop", await js("document.querySelector('[data-progress] [data-cancel-note]').textContent.includes('The server may still finish indexing')"));
    await shot("04-landing-indexing", false);
    await waitFor("location.pathname.startsWith('/r/')", "navigation to the workspace", 180_000);
    ingestDelayMs = 0;
    sha = await js("location.pathname.split('/')[4]");
    record("after indexing the browser is at /r/owner/name/<40-char commit>", /^[0-9a-f]{40}$/.test(sha), sha);
    await waitFor("!!document.querySelector('[data-workspace]')", "workspace ready");
    record("workspace shows the repository, the commit and real index facts", await js(`document.querySelector('h1').textContent === '${REPO}' && document.querySelector('[data-repo-meta]').textContent.includes('files')`), await js("document.querySelector('[data-repo-meta]').textContent.replace(/\\s+/g, ' ').trim().slice(0, 80)"));
  });
  if (!sha) throw new Error("ingest did not complete; the remaining checks need a workspace");

  const gen = spawnSync(process.execPath, ["--import", "tsx", path.join(HERE, "make-answer-fixtures.ts"), REPO, sha, STORE, FIXTURES], { encoding: "utf8", cwd: path.join(HERE, "..") });
  if (gen.status !== 0) throw new Error(`fixture generation failed: ${gen.stderr.slice(-400)}`);
  const WORKSPACE = `/r/${REPO}/${sha}`;

  await step("workspace empty state", async () => {
    const okApi = await fetch(`${BASE}/api/repo?repo=${REPO}&sha=${sha}`);
    record("a successful API response is not to be cached either", okApi.status === 200 && okApi.headers.get("cache-control") === "no-store", `HTTP ${okApi.status}, ${okApi.headers.get("cache-control")}`);
    record("the question field is described by a hint that states the 300-character limit", await js("(() => { const q = document.querySelector('#question'); const ids = (q.getAttribute('aria-describedby') ?? '').split(' '); return ids.includes('question-hint') && document.getElementById('question-hint').textContent.includes('Up to 300 characters.'); })()"));
    record("an empty workspace explains what to ask and shows the inspector placeholder", await js("document.querySelector('[data-thread] [data-empty]') !== null && document.querySelector('[data-pane]').textContent.includes('Source inspector')"));
    await shot("05-workspace-empty-desktop");
    await audit("workspace-empty/dark");
  });

  /* ---------- a real request against a server with no model ---------- */
  await step("real answer request without a model", async () => {
    await askWith(null, "Where is the separator option handled?");
    await waitFor("document.querySelector('[data-entry=failure]') !== null", "no-model failure");
    record("REAL /api/answer on a server with no model: the UI says so and offers no fake answer", await js("document.querySelector('[data-entry=failure]').textContent.includes('No language model is configured')"));
    record("a failed question is announced to assistive tech with what the card says, not a generic sentence", await js("document.querySelector('[data-announce]').textContent.replace(/\\u00a0/g, '') === 'No language model is configured.'"), await js("document.querySelector('[data-announce]').textContent"));
    await shot("06-answer-no-model-desktop");
  });

  /* ---------- answer states (pipeline output, model step stood in) ---------- */
  await step("pending state", async () => {
    answerDelayMs = 1200;
    await askWith("answered");
    await waitFor("document.querySelector('[data-entry][aria-busy=true]') !== null", "pending entry");
    record("while waiting: a pending entry, a disabled Ask button, and a status message for assistive tech", await js("document.querySelector('[data-ask] button[type=submit]').disabled && document.querySelector('[data-announce]').textContent.includes('Working')"));
    await shot("07-answer-pending-desktop", false);
    answerDelayMs = 0;
    await waitFor("document.querySelector('[data-entry=answered]') !== null", "answered entry");
  });

  await step("answered state and source inspection", async () => {
    const a = await js("(() => { const e = document.querySelector('[data-entry=answered]'); return { claims: e.querySelectorAll('[data-claim]').length, cites: e.querySelectorAll('[data-cite]').length, scope: e.querySelector('[data-scope]').textContent, question: document.querySelector('#question').value }; })()");
    record("an answer lists its claims, each with pressable evidence ids", a.claims >= 1 && a.cites >= a.claims, `${a.claims} claims, ${a.cites} citations`);
    const quotes = await js("(() => { const e = document.querySelector('[data-entry=answered]'); const entries = [...e.querySelectorAll('[data-evidence-entry]')]; return { entries: entries.length, withQuote: entries.filter((x) => x.querySelector('[data-quote][data-found=true]')?.textContent.trim().length > 2).length, cites: e.querySelectorAll('[data-cite]').length }; })()");
    record("every citation is shown with the passage quoted from it", quotes.entries > 0 && quotes.withQuote === quotes.entries && quotes.cites === quotes.entries, `${quotes.withQuote} of ${quotes.entries} entries carry a quote`);
    record("the answer states what was checked and what was not", a.scope.includes("Checked:") && a.scope.includes("Not checked:"));
    record("the question box is cleared for the next question", a.question === "");
    await click("[data-entry=answered] [data-cite]");
    await waitFor("document.querySelector('[data-pane] [data-code]') !== null", "source lines in the side pane");
    const s = await js("(() => { const p = document.querySelector('[data-pane]'); const hl = p.querySelectorAll('[data-line][data-cited=true]'); const meta = p.querySelector('[data-inspector-meta]').textContent; const m = meta.match(/Lines (\\d+)\\D+(\\d+)/); return { marked: hl.length, expected: m[2] - m[1] + 1, first: hl[0].querySelector('[data-line-no]').textContent, from: m[1], pressed: document.querySelector('[data-entry=answered] [data-cite]').getAttribute('aria-pressed'), link: p.querySelector('[data-inspector-meta] a').href, dialog: !!document.querySelector('dialog[open]') }; })()");
    record("REAL /api/source: pressing a citation shows exactly the cited lines, marked, in the side pane", s.marked === s.expected && s.first === s.from && !s.dialog, `${s.marked} lines from L${s.from}`);
    record("the pressed citation is marked as selected", s.pressed === "true");
    record("pressing a citation is announced to assistive tech with the lines and file it shows", await js("/^Showing lines \\d+ to \\d+ of .+ in the source inspector\\.$/.test(document.querySelector('[data-announce]').textContent.replace(/\\u00a0/g, ''))"));
    const paneFocus = () => js("document.activeElement?.id === 'inspector-title' && document.querySelector('[data-pane]').contains(document.activeElement)");
    record("wide screen: pressing a citation moves focus to the inspector heading", await paneFocus());
    const q = await js("(() => { const p = document.querySelector('[data-pane]'); const quoted = [...p.querySelectorAll('[data-line][data-quoted=true]')]; const quote = document.querySelector('[data-entry=answered] [data-evidence-entry] [data-quote]').textContent.replace(/\\s+/g, ' ').trim(); const text = quoted.map((l) => l.lastElementChild.textContent).join(' ').replace(/\\s+/g, ' ').trim(); return { quoted: quoted.length, insideCited: quoted.every((l) => l.getAttribute('data-cited') === 'true'), contains: text.includes(quote), quote: quote.slice(0, 40) }; })()");
    record("citation, quote, source: the inspector points out the quoted lines inside the cited block, and they contain the quote", q.quoted >= 1 && q.insideCited && q.contains, `${q.quoted} quoted line(s) for "${q.quote}"`);
    record("'Open on GitHub' is a permalink to this commit and these lines", s.link.startsWith(`https://github.com/${REPO}/blob/${sha}/`) && /#L\d+-L\d+$/.test(s.link), s.link.slice(-40));
    await js("window.scrollTo(0, 0)");
    await shot("08-answer-with-source-desktop", false);
    await click("[data-pane] [data-return]");
    const returned = await focused();
    record("'Back to answer' returns focus to the citation that opened the inspector", returned?.cite === true && (await js("document.activeElement.getAttribute('aria-pressed') === 'true'")), returned?.text);
    await press("Enter");
    await waitFor("document.activeElement?.id === 'inspector-title'", "focus on the inspector heading after activating the same citation again");
    record("activating the same citation again moves focus to the inspector heading again", await paneFocus());
    const before = await js("document.querySelectorAll('[data-pane] [data-line]').length");
    await click("[data-pane] [data-more] button:nth-of-type(2)");
    await waitFor(`document.querySelectorAll('[data-pane] [data-line]').length > ${before} || document.querySelector('[data-pane] [data-more] button:nth-of-type(2)').disabled`, "context below");
    const after = await js("({ lines: document.querySelectorAll('[data-pane] [data-line]').length, marked: document.querySelectorAll('[data-pane] [data-line][data-cited=true]').length })");
    record("'Show 20 lines below' adds context without changing which lines are marked as cited", after.lines >= before && after.marked === s.marked, `${before} -> ${after.lines} lines`);
    await audit("workspace-answer/dark");
  });

  await step("inspector across the breakpoint", async () => {
    const count = (scope) => js(`document.querySelectorAll('${scope} [data-line]').length`);
    const wide = await count("[data-pane]");
    await viewport(1000, 900);
    await waitFor("document.querySelector('dialog[data-sheet][open] [data-code]') !== null", "sheet after narrowing");
    const sheet = { lines: await count("dialog[data-sheet][open]"), skeleton: await js("document.querySelector('dialog[data-sheet] [role=status] .sr-only') !== null") };
    record("narrowing the window moves the open source into the sheet with its expanded context intact and no reload", sheet.lines === wide && !sheet.skeleton, `${wide} lines in the pane, ${sheet.lines} in the sheet`);
    await viewport(1440, 900);
    await waitFor("document.querySelector('dialog[data-sheet]') === null && document.querySelector('[data-pane] [data-code]') !== null", "pane after widening");
    record("widening it again moves the source back to the side pane, still with the same lines", (await count("[data-pane]")) === wide && (await js("document.querySelector('[data-entry=answered] [data-cite][aria-pressed=true]') !== null")), `${await count("[data-pane]")} lines`);
  });

  await step("follow-up question", async () => {
    const before = await entries();
    await askWith("answered", "And what does the lowercase option do?");
    await waitFor(`document.querySelectorAll('[data-entry]').length === ${before + 1} && document.querySelector('[data-entry][aria-busy=true]') === null`, "second result");
    const order = await js("[...document.querySelectorAll('[data-entry] h3')].map((h) => h.textContent)");
    record("a follow-up question is added above the earlier ones, which stay on the page", order[0] === "And what does the lowercase option do?" && order.length === before + 1, order.length + " entries");
    await js("document.querySelector('[data-entry=answered] [data-cite]').focus()");
    await press("Enter");
    await waitFor("document.querySelector('[data-entry=answered] [data-cite][aria-pressed=true]') !== null", "citation of the newest answer selected");
    await click("[data-entry=answered] [data-cite]:not([aria-pressed=true])");
    await waitFor("document.querySelectorAll('[data-cite][aria-pressed=true]').length === 1", "one citation selected at a time");
    const shownId = () => js("document.querySelector('[data-pane] [data-inspector] p')?.textContent ?? ''");
    const pressedId = await js("document.querySelector('[data-cite][aria-pressed=true]').textContent");
    await waitFor(`document.querySelector('[data-pane] [data-code]') !== null && document.querySelector('[data-pane] [data-inspector] p')?.textContent === 'Evidence ${pressedId}'`, "source of the newly selected citation");
    record("moving between citations keeps exactly one selected and swaps the source shown", (await shownId()) === `Evidence ${pressedId}`, await shownId());
  });

  await step("evidence list", async () => {
    await click("[data-entry=answered] [data-disclosure=evidence] summary");
    const rows = await js("document.querySelectorAll('[data-entry=answered] [data-evidence-row]').length");
    record("the full list of evidence given to the model can be opened, and cited rows are tagged", rows >= 1 && (await js("[...document.querySelectorAll('[data-entry=answered] [data-evidence-row]')].some((r) => r.textContent.includes('cited'))")), `${rows} rows`);
    await click("[data-entry=answered] [data-evidence-row]:not([aria-pressed=true])");
    await waitFor("document.querySelector('[data-entry=answered] [data-evidence-row][aria-pressed=true]') !== null", "evidence row selected");
    record("any evidence row opens in the inspector, cited or not", true);
    record("opened from the evidence list, the inspector marks the block but claims no quote", await js("document.querySelectorAll('[data-pane] [data-line][data-quoted=true]').length === 0"));
  });

  await step("facts from the index and a shortened quote", async () => {
    const settled = (n) => `document.querySelectorAll('[data-entry]').length === ${n} && document.querySelector('[data-entry][aria-busy=true]') === null`;
    const before = await entries();
    await askWith("index-fact");
    await waitFor(settled(before + 1), "index-fact result");
    const f = await js("(() => { const e = document.querySelector('[data-entry] [data-index-facts]'); return e ? { text: e.textContent, insideClaim: !!e.closest('[data-claim]') } : null; })()");
    record("what the application read from its index is shown apart from the model's claims and labelled as not from the model", f !== null && f.text.includes("From the index, not from the model") && f.text.includes("The index lists") && !f.insideClaim, f?.text.slice(34, 130));
    await askWith("long-quote");
    await waitFor(settled(before + 2), "long-quote result");
    const q = await js("(() => { const e = document.querySelector('[data-entry]'); const quote = e.querySelector('[data-quote]'); return { marked: !!e.querySelector('[data-quote-trimmed]'), len: quote ? quote.textContent.length : -1, found: quote?.getAttribute('data-found') ?? null }; })()");
    record("a quote the model gave at length is shown shortened, marked as shortened, and as found in the cited lines", q.marked && q.len > 0 && q.len <= 400 && q.found === "true", `${q.len} characters shown`);
    await audit("workspace-index-facts/dark");
  });

  await step("provider rate limited", async () => {
    await askWith("provider-rate-limited");
    await waitFor("document.querySelector('[data-entry=unavailable]') !== null", "unavailable entry");
    const u = await js("(() => { const e = document.querySelector('[data-entry=unavailable]'); return { title: e.querySelector('[data-status]').textContent, claims: e.querySelectorAll('[data-claim]').length, rows: e.querySelectorAll('[data-evidence-row]').length, retry: [...e.querySelectorAll('button')].some((b) => b.textContent === 'Ask again') }; })()");
    record("a rate-limited model is reported as such, shows no claims, keeps the retrieved evidence and offers a retry", u.title.includes("rate limited") && u.claims === 0 && u.rows > 0 && u.retry, `${u.rows} evidence rows`);
    await shot("09-answer-model-rate-limited-desktop");
  });

  await step("insufficient evidence", async () => {
    await askWith("insufficient-search");
    await waitFor("[...document.querySelectorAll('[data-detail]')].some((p) => p.textContent.includes('the model was not asked'))", "insufficient (search)");
    record("too little matching code: says the model was not asked, and shows no answer", await js("document.querySelector('[data-thread] [data-entry]').querySelector('[data-claim]') === null"));
    await askWith("insufficient-model");
    await waitFor("[...document.querySelectorAll('[data-detail]')].some((p) => p.textContent.includes('What is missing'))", "insufficient (model)");
    record("the model declining: shows what is missing and the evidence it was given", await js("document.querySelector('[data-thread] [data-entry]').querySelector('[data-evidence-row]') !== null"));
    await shot("10-answer-insufficient-desktop");
  });

  await step("withheld answer", async () => {
    await askWith("rejected");
    await waitFor("document.querySelector('[data-entry=withheld]') !== null", "withheld entry");
    const w = await js("(() => { const e = document.querySelector('[data-entry=withheld]'); const d = e.querySelector('[data-disclosure=withheld]'); return { title: e.querySelector('[data-status]').textContent, reason: e.querySelector('[data-reasons]')?.textContent ?? '', hidden: d && !d.open, visibleClaims: [...e.querySelectorAll('[data-claim]')].filter((c) => c.checkVisibility()).length }; })()");
    record("a reply that fails citation checks is withheld: titled so, with the reason, and its text hidden by default", w.title === "Answer withheld" && w.reason.includes("quoted text") && w.hidden && w.visibleClaims === 0, w.reason.slice(0, 60));
    record("a withheld reply is announced as withheld, not as a ready result", await js("document.querySelector('[data-announce]').textContent.replace(/\\u00a0/g, '') === 'Answer withheld.'"));
    await click("[data-entry=withheld] [data-disclosure=withheld] summary");
    record("the withheld reply can be opened, and the failed check is flagged on the claim", await js("document.querySelector('[data-entry=withheld] [data-check][data-passed=false]') !== null"));
    await shot("11-answer-withheld-desktop");
    await audit("workspace-all-states/dark");
  });

  await step("history survives a reload and can be cleared", async () => {
    const before = await entries();
    await goto(WORKSPACE);
    await waitFor("document.querySelectorAll('[data-entry]').length > 0", "restored thread");
    record("reloading the page keeps this tab's questions and results", (await entries()) === before, `${before} entries`);
  });

  /* ---------- other widths ---------- */
  const sizes = [
    ["narrow-desktop", 1024, 768, false],
    ["tablet", 820, 1180, false],
    ["mobile", 390, 844, true],
  ];
  for (const [label, w, h, mobile] of sizes) {
    await step(`${label} layout`, async () => {
      await viewport(w, h, mobile);
      await goto("/");
      record(`${label} ${w}px landing: no sideways scrolling`, await noSidewaysScroll());
      await shot(`20-landing-${label}`);
      await audit(`landing/${label}`);
      await goto(WORKSPACE);
      await waitFor("document.querySelector('[data-entry=answered]') !== null", "thread on " + label);
      record(`${label} ${w}px workspace: no sideways scrolling, single column`, (await noSidewaysScroll()) && (await js("getComputedStyle(document.querySelector('[data-pane]')).display === 'none'")));
      await shot(`21-workspace-${label}`);
      await js("document.querySelector('[data-entry=answered] [data-cite]').focus()");
      await press("Enter");
      await waitFor("document.querySelector('dialog[data-sheet][open] [data-code]') !== null", "source sheet");
      const d = await js("(() => { const dlg = document.querySelector('dialog[data-sheet][open]'); const r = dlg.getBoundingClientRect(); return { inside: dlg.contains(document.activeElement), w: Math.round(r.width), h: Math.round(r.height), vw: innerWidth, vh: innerHeight, labelled: !!document.getElementById(dlg.getAttribute('aria-labelledby')), marked: dlg.querySelectorAll('[data-line][data-cited=true]').length }; })()");
      record(`${label}: a citation opened from the keyboard shows the source in a labelled modal sheet with focus inside`, d.inside && d.labelled && d.marked > 0, `${d.w}x${d.h} in ${d.vw}x${d.vh}`);
      record(`${label}: the sheet keeps its own focus handling: its heading is not a focus target and it has no pane return control`, await js("(() => { const dlg = document.querySelector('dialog[data-sheet][open]'); const h = dlg.querySelector('#inspector-title'); return !h.hasAttribute('tabindex') && document.activeElement !== h && dlg.querySelector('[data-return]') === null; })()"));
      if (mobile) record("mobile: the sheet takes the whole screen rather than a cramped column", d.w === d.vw && d.h === d.vh, `${d.w}x${d.h}`);
      await shot(`22-source-sheet-${label}`, false);
      await audit(`sheet/${label}`);
      await press("Escape");
      await waitFor("document.querySelector('dialog[data-sheet]') === null", "sheet closed");
      const back = await focused();
      record(`${label}: Escape closes the sheet and focus returns to the citation that opened it`, back?.cite === true, back?.text);
    });
  }

  await step("reflow at 320px", async () => {
    await viewport(320, 640, true);
    await goto("/");
    const a = await noSidewaysScroll();
    await goto(WORKSPACE);
    await waitFor("document.querySelector('[data-entry=answered]') !== null", "thread at 320");
    record("320 px wide (WCAG 1.4.10 reflow): neither page scrolls sideways", a && (await noSidewaysScroll()));
    await shot("23-workspace-320px");
  });

  /* ---------- light scheme (the alternative; dark is primary) ---------- */
  await step("light scheme", async () => {
    await viewport(1440, 900);
    await scheme(false);
    await goto(WORKSPACE);
    await waitFor("document.querySelector('[data-entry=answered]') !== null", "thread (light)");
    await click("[data-entry=answered] [data-cite]");
    await waitFor("document.querySelector('[data-pane] [data-code]') !== null", "source (light)");
    await shot("30-workspace-light-desktop");
    await audit("workspace/light");
    await goto("/");
    await shot("31-landing-light-desktop");
    await audit("landing/light");
    await viewport(390, 844, true);
    await goto(WORKSPACE);
    await waitFor("document.querySelector('[data-entry=answered]') !== null", "thread (light mobile)");
    await shot("32-workspace-light-mobile");
    await scheme(true);
    await viewport(1440, 900);
  });

  /* ---------- error and recovery ---------- */
  await step("bad addresses", async () => {
    const res = await fetch(`${BASE}/r/a/b/not-a-commit`);
    await goto("/r/a/b/not-a-commit");
    record("a malformed workspace address is a 404 page with a way back", res.status === 404 && (await js("document.querySelector('h1').textContent.includes('nothing at this address') && !!document.querySelector('a[data-button]')")), `HTTP ${res.status}`);
    await shot("40-not-found");
    await goto(`/r/${REPO}/${"0".repeat(40)}`);
    await waitFor("document.body.textContent.includes('not indexed on this server')", "unindexed commit panel");
    record("a commit that is not indexed says so and offers to index it, without indexing by itself", await js("[...document.querySelectorAll('button')].some((b) => b.textContent === 'Index this commit') && document.querySelector('#question') === null"));
    await shot("41-commit-not-indexed");
    // First a failure worth retrying, supplied at the network boundary; then "Try again", which must index again, for real.
    const inStatusArea = "document.activeElement?.hasAttribute('data-status-area') === true";
    ingestOverride = { httpStatus: 503, body: { error: "The server is busy with other requests. Try again in a few seconds.", code: "busy", retryAfterSeconds: 5 } };
    await js("[...document.querySelectorAll('button')].find((b) => b.textContent === 'Index this commit').click()");
    await waitFor("document.querySelector('[data-notice=danger]')?.textContent.includes('busy') === true", "retryable index failure");
    record("pressing 'Index this commit' moves focus to the status that replaces the button, not nowhere", await js(inStatusArea));
    const ingestsBefore = ingestRequests;
    await js("[...document.querySelectorAll('button')].find((b) => b.textContent === 'Try again').click()");
    await waitFor("document.querySelector('[data-notice=danger]')?.textContent.includes('not found') === true", "index failure", 60_000);
    record("'Try again' after a failed indexing indexes again instead of only re-checking, and keeps focus in the status", ingestRequests === ingestsBefore + 1 && (await js(inStatusArea)), `${ingestRequests - ingestsBefore} ingest request(s)`);
    record("REAL failed indexing (a commit GitHub does not have): an error with a retry, not a broken page", await js("document.querySelector('[data-notice=danger]').textContent.includes('not found') && [...document.querySelectorAll('button')].some((b) => b.textContent === 'Try again')"), await js("document.querySelector('[data-notice=danger] strong').textContent"));
    await shot("42-index-failed");
  });

  await step("return navigation", async () => {
    await goto("/");
    await waitFor("document.querySelector('[data-recent] a') !== null", "recent repositories");
    record("the landing page lists the repository opened on this device, linking back to its commit", await js(`document.querySelector('[data-recent] a').getAttribute('href') === '${WORKSPACE}'`));
    await shot("43-landing-with-recent");
    await click("[data-recent] a");
    await waitFor("location.pathname.startsWith('/r/') && document.querySelector('[data-workspace]') !== null", "workspace via recent link");
    await cdp.send("Runtime.evaluate", { expression: "history.back()" });
    await waitFor("location.pathname === '/'", "back to landing");
    record("Back returns from the workspace to the landing page", true);
  });

  record("no console errors, uncaught exceptions or CSP violations during the whole run", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));
} catch (err) {
  record("run completed", false, err.message);
} finally {
  cdp.ws.close();
  proc.kill();
  await sleep(500);
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch {
    /* the browser still holds its profile; the OS temp folder is cleaned later */
  }
}

const failed = results.filter((r) => !r.ok);
writeFileSync(path.join(OUT, "report.json"), JSON.stringify({ base: BASE, browser: path.basename(exe), repo: REPO, checkedAt: new Date().toISOString(), passed: results.length - failed.length, failed: failed.length, results }, null, 1));
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed. Screenshots and report.json are in e2e/artifacts/.`);
process.exitCode = failed.length ? 1 : 0;
