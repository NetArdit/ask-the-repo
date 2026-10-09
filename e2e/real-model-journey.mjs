/**
 * One real journey through the running application, with the real language model: index a small repository, ask ONE question,
 * open every citation of the answer, and write down the claims next to the exact lines they cite so a person can judge whether
 * the lines support them. It asks one question because every question spends model quota.
 *
 *   node e2e/real-model-journey.mjs [baseUrl] ["question"]
 *
 * Output: a screenshot in e2e/artifacts/ and a record under reports/private/journeys/ (git-ignored, because it copies the
 * cited source lines). Nothing here decides whether a claim is supported; that judgement is left to whoever reads the record.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = (process.argv[2] ?? "http://localhost:3000").replace(/\/$/, "");
const QUESTION = process.argv[3] ?? "What does the separator option do and what is its default value?";
const REPO = "sindresorhus/slugify";
const OUT = path.join(HERE, "artifacts");
// The record copies the cited source lines, which are third-party text, so it goes to the folder git ignores.
const PRIVATE = path.join(HERE, "..", "reports", "private", "journeys");
const PORT = 9334;
const BROWSERS = ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/google-chrome", "/usr/bin/chromium"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const exe = BROWSERS.find((p) => existsSync(p));
if (!exe) throw new Error("No Edge or Chrome found.");
const profile = mkdtempSync(path.join(tmpdir(), "atr-real-"));
const proc = spawn(exe, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--headless=new", "--no-first-run", "--disable-gpu", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });

let ws;
for (let i = 0; i < 80 && !ws; i++) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" });
    if (res.ok) {
      const socket = new WebSocket((await res.json()).webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        socket.addEventListener("open", resolve);
        socket.addEventListener("error", reject);
      });
      ws = socket;
    }
  } catch {
    await sleep(250);
  }
}
if (!ws) throw new Error("The browser did not open its debugging port.");

let nextId = 0;
const pending = new Map();
ws.addEventListener("message", (m) => {
  const msg = JSON.parse(m.data);
  const p = msg.id && pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  if (msg.error) p.reject(new Error(msg.error.message));
  else p.resolve(msg.result);
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++nextId;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
const js = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};
const waitFor = async (expression, what, timeoutMs) => {
  const started = Date.now();
  for (;;) {
    try {
      const v = await js(expression);
      if (v) return v;
    } catch {
      /* mid-navigation */
    }
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(150);
  }
};
const enter = async () => {
  const base = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
  await send("Input.dispatchKeyEvent", { type: "keyDown", text: "\r", ...base });
  await send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
};
const typeInto = async (selector, text) => {
  await js(`document.querySelector(${JSON.stringify(selector)}).focus()`);
  await send("Input.insertText", { text });
  await sleep(100);
};

const record = { base: BASE, repo: REPO, question: QUESTION, startedAt: new Date().toISOString() };
try {
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: `${BASE}/` });
  await waitFor("document.readyState === 'complete' && !!document.querySelector('#repo-input')", "landing page", 60_000);

  await typeInto("#repo-input", REPO);
  await enter();
  await waitFor("location.pathname.startsWith('/r/') && !!document.querySelector('[data-workspace]')", "workspace", 180_000);
  record.commit = await js("location.pathname.split('/')[4]");

  await typeInto("#question", QUESTION);
  const asked = Date.now();
  await enter();
  await waitFor("document.querySelector('[data-entry]') !== null && document.querySelector('[data-entry][aria-busy=true]') === null", "the answer", 120_000);
  record.secondsToResult = Math.round((Date.now() - asked) / 100) / 10;

  record.result = await js(`(() => {
    const e = document.querySelector('[data-entry]');
    return {
      state: e.getAttribute('data-entry'),
      title: e.querySelector('[data-status]')?.textContent ?? e.querySelector('[data-notice] strong')?.textContent ?? null,
      detail: [...e.querySelectorAll('[data-detail], [data-notice] span')].map((p) => p.textContent),
      reasons: [...e.querySelectorAll('[data-reasons] li')].map((li) => li.textContent),
      claims: [...e.querySelectorAll('[data-claim]')].map((c) => ({ text: c.querySelector('p').textContent, citations: [...c.querySelectorAll('[data-cite]')].map((b) => b.textContent), evidence: [...c.querySelectorAll('[data-evidence-entry]')].map((x) => ({ id: (x.querySelector('[data-cite], [data-cite-broken]') || {}).textContent, quote: (x.querySelector('[data-quote]') || {}).textContent, quoteFound: (x.querySelector('[data-quote]') || { getAttribute: () => null }).getAttribute('data-found') })), check: c.querySelector('[data-check]').textContent })),
      evidence: [...e.querySelectorAll('[data-evidence-row]')].map((r) => r.getAttribute('aria-label')),
    };
  })()`);

  // Open each distinct citation and copy out the lines the application marks as cited.
  const ids = [...new Set(record.result.claims.flatMap((c) => c.citations))];
  record.cited = [];
  for (const id of ids) {
    await js(`[...document.querySelectorAll('[data-entry] [data-cite]')].find((b) => b.textContent === ${JSON.stringify(id)}).click()`);
    await waitFor(`document.querySelector('[data-pane] [data-inspector] p')?.textContent === 'Evidence ${id}' && document.querySelector('[data-pane] [data-code]') !== null && document.querySelector('[data-pane] [role=status]')?.textContent !== 'Loading more lines…'`, `source for ${id}`, 60_000);
    await sleep(400);
    record.cited.push(await js(`(() => {
      const p = document.querySelector('[data-pane]');
      const lines = [...p.querySelectorAll('[data-line][data-cited=true]')];
      return {
        id: ${JSON.stringify(id)},
        path: p.querySelector('h2').textContent,
        range: p.querySelector('[data-inspector-meta] span').textContent,
        permalink: p.querySelector('[data-inspector-meta] a')?.href ?? null,
        firstLine: lines[0]?.querySelector('[data-line-no]').textContent,
        lineCount: lines.length,
        quotedLines: [...p.querySelectorAll('[data-line][data-quoted=true]')].map((l) => l.querySelector('[data-line-no]').textContent + '| ' + l.lastElementChild.textContent.replace(/\\n$/, '')),
        text: lines.map((l) => l.querySelector('[data-line-no]').textContent + '| ' + l.lastElementChild.textContent.replace(/\\n$/, '')).join('\\n'),
      };
    })()`));
  }
  await js("window.scrollTo(0, 0)");
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  mkdirSync(OUT, { recursive: true });
  writeFileSync(path.join(OUT, "real-model-journey.png"), Buffer.from(data, "base64"));
  record.ok = true;
} catch (err) {
  record.ok = false;
  record.error = err.message;
} finally {
  ws.close();
  proc.kill();
  await sleep(400);
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch {
    /* the browser still holds its profile */
  }
}

mkdirSync(PRIVATE, { recursive: true });
writeFileSync(path.join(PRIVATE, `real-model-journey-${record.startedAt.replace(/[:.]/g, "-")}.json`), JSON.stringify(record, null, 1));
console.log(JSON.stringify({ ok: record.ok, error: record.error, commit: record.commit, secondsToResult: record.secondsToResult, state: record.result?.state, title: record.result?.title, claims: record.result?.claims?.length, cited: record.cited?.map((c) => `${c.id} ${c.path} ${c.range}`) }, null, 1));
process.exitCode = record.ok ? 0 : 1;
