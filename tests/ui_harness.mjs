// Minimal Chrome-DevTools-Protocol driver (no dependencies; Node 22+ has a global WebSocket).
// Used by tests/ui_check.mjs to click through the real UI in headless Edge/Chrome.
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CANDIDATES = [process.env.BROWSER, 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch(port = 9333) {
  const exe = CANDIDATES.find((p) => existsSync(p));
  if (!exe) throw new Error('No Chromium-based browser found (set BROWSER=path)');
  const proc = spawn(exe, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'cdp-'))}`, '--window-size=1500,1100', 'about:blank'], { stdio: 'ignore' });
  let targets;
  for (let i = 0; i < 50; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); if (targets.length) break; } catch { /* retry */ } await sleep(200); }
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let id = 0; const pending = new Map(); const handlers = [];
  ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } else handlers.forEach((h) => h(d)); });
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, (d) => (d.error ? rej(new Error(d.error.message)) : res(d.result))); ws.send(JSON.stringify({ id: i, method, params })); });
  const logs = [];
  handlers.push((d) => {
    if (d.method === 'Runtime.exceptionThrown') logs.push({ type: 'exception', text: d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text });
    if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') logs.push({ type: 'console', text: d.params.args.map((a) => a.value ?? a.description).join(' ') });
    if (d.method === 'Log.entryAdded' && d.params.entry.level === 'error') logs.push({ type: 'log', text: d.params.entry.text + ' ' + (d.params.entry.url || '') });
  });
  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');

  const api = {
    logs, send,
    async goto(url, settle = 1500) { logs.length = 0; await send('Page.navigate', { url: 'about:blank' }); await sleep(100); await send('Page.navigate', { url }); await sleep(settle); },
    async eval(expr) { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; },
    /** wait until predicate (JS expression) is truthy */
    async waitFor(expr, timeout = 15000, label = expr) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { try { if (await api.eval(expr)) return true; } catch { /* page navigating */ } await sleep(150); } throw new Error('timeout waiting for: ' + label); },
    /** click first visible element matching selector whose text contains `text` */
    async click(selector, text, root = 'document') {
      const ok = await api.eval(`(()=>{const els=[...${root}.querySelectorAll(${JSON.stringify(selector)})].filter(e=>e.offsetParent!==null&&(${JSON.stringify(text)}===''||e.textContent.trim().toLowerCase().includes(${JSON.stringify(String(text).toLowerCase())})));if(!els.length)return false;els[0].scrollIntoView({block:'center'});els[0].click();return true;})()`);
      if (!ok) throw new Error(`click: no visible ${selector} containing "${text}"`);
    },
    async setValue(selector, value, index = 0) { return api.eval(`(()=>{const e=[...document.querySelectorAll(${JSON.stringify(selector)})].filter(x=>x.offsetParent!==null)[${index}];if(!e)return false;e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`); },
    async text(selector = 'body') { return api.eval(`(document.querySelector(${JSON.stringify(selector)})||{}).innerText||''`); },
    async toasts() { return api.eval(`[...document.querySelectorAll('.toast')].map(t=>t.innerText.trim())`); },
    async screenshot(path) { const { data } = await send('Page.captureScreenshot', { format: 'png' }); (await import('node:fs')).writeFileSync(path, Buffer.from(data, 'base64')); },
    async close() { try { await send('Browser.close'); } catch { /* ignore */ } ws.close(); proc.kill(); },
  };
  return api;
}
