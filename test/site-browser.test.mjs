import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// A real-browser check of site/index.html, with no npm dependency: Chrome or Chromium is started headless and
// driven over the DevTools protocol using Node's built-in WebSocket. It checks what the file-reading tests
// cannot: that no layout overflows horizontally (down to 320px, which is what 400% zoom of a laptop gives),
// that selecting a module works with the mouse and the keyboard, and that the skip link is the first tab stop.
//
// The test is skipped when no Chrome or Chromium is found (set CHROME_BIN to point at one) or when it cannot
// be started, so it never blocks a machine that has no browser.

const root = fileURLToPath(new URL('..', import.meta.url));
const pageUrl = pathToFileURL(join(root, 'site', 'index.html')).href;

function findChrome() {
  const candidates = [process.env.CHROME_BIN, 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].filter(Boolean);
  for (const name of candidates) {
    if (name.includes('/')) { if (existsSync(name)) return name; continue; }
    const found = spawnSync('which', [name], { encoding: 'utf8' });
    if (found.status === 0 && found.stdout.trim()) return found.stdout.trim();
  }
  return null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function launch(chrome) {
  const dir = mkdtempSync(join(tmpdir(), 'rt-site-chrome-'));
  const child = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${dir}`, '--remote-debugging-port=0', 'about:blank'], { stdio: 'ignore' });
  const stop = () => { child.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); };
  let endpoint = null;
  for (let i = 0; i < 100 && !endpoint; i++) {
    if (child.exitCode !== null) break;
    try {
      const [port, path] = readFileSync(join(dir, 'DevToolsActivePort'), 'utf8').trim().split('\n');
      if (port && path) endpoint = `ws://127.0.0.1:${port}${path}`;
    } catch { /* not written yet */ }
    if (!endpoint) await sleep(100);
  }
  if (!endpoint) { stop(); return null; }
  const ws = new WebSocket(endpoint);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('cannot connect to the browser')); });
  let next = 0;
  const pending = new Map();
  const events = [];
  ws.onmessage = (message) => {
    const data = JSON.parse(message.data);
    if (data.id && pending.has(data.id)) { const { resolve, reject } = pending.get(data.id); pending.delete(data.id); if (data.error) reject(new Error(`${data.error.message}`)); else resolve(data.result); }
    else if (data.method) events.push(data);
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++next;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout: ${method}`)); }, 15000);
    pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const call = (method, params) => send(method, params, sessionId);
  await call('Page.enable');
  const evaluate = async (expression) => {
    const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`page error: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  };
  const open = async (width, height = 900, scheme = 'light') => {
    await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 500 });
    await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }, { name: 'prefers-reduced-motion', value: 'reduce' }] });
    events.length = 0;
    await call('Page.navigate', { url: pageUrl });
    for (let i = 0; i < 100 && !events.some((e) => e.method === 'Page.loadEventFired'); i++) await sleep(50);
    assert.ok(events.some((e) => e.method === 'Page.loadEventFired'), 'the page did not finish loading');
    await sleep(100);
  };
  const key = async (name, code, vk, text) => {
    await call('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code, windowsVirtualKeyCode: vk, ...(text ? { text } : {}) });
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code, windowsVirtualKeyCode: vk });
  };
  return { evaluate, open, key, stop: () => { try { ws.close(); } catch { /* closed */ } stop(); } };
}

// Elements that stick out of the viewport (ignoring the visually hidden ones, which are clipped on purpose).
const OVERFLOW = `(() => {
  const w = document.documentElement.clientWidth;
  const out = [];
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (getComputedStyle(el).position === 'absolute' && r.width <= 1) continue;
    if (r.right > w + 1 || r.left < -1) out.push(el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : '') + ' ' + Math.round(r.left) + '..' + Math.round(r.right));
  }
  return { scrollWidth: document.documentElement.scrollWidth, bodyScrollWidth: document.body.scrollWidth, clientWidth: w, out: out.slice(0, 6) };
})()`;

const chrome = findChrome();

test('in a real browser: no horizontal scrolling at 320, 375, 768 and 1280px, in light and dark, before and after opening a module',
  { skip: chrome ? false : 'no Chrome or Chromium found (set CHROME_BIN)', timeout: 120000 }, async (t) => {
    const browser = await launch(chrome).catch(() => null);
    if (!browser) { t.skip('the browser could not be started'); return; }
    try {
      for (const [width, scheme] of [[320, 'light'], [375, 'light'], [375, 'dark'], [768, 'light'], [1280, 'light'], [1280, 'dark']]) {
        await browser.open(width, 900, scheme);
        const check = async (when) => {
          const m = await browser.evaluate(OVERFLOW);
          assert.ok(m.scrollWidth <= m.clientWidth && m.bodyScrollWidth <= m.clientWidth, `${width}px ${scheme} ${when}: horizontal scrolling (scrollWidth ${m.scrollWidth} > ${m.clientWidth}); ${m.out.join(' | ')}`);
          assert.deepEqual(m.out, [], `${width}px ${scheme} ${when}: elements outside the viewport`);
        };
        await check('at load');
        assert.equal(await browser.evaluate('document.documentElement.lang'), 'en');
        const dark = await browser.evaluate('getComputedStyle(document.body).backgroundColor');
        assert.equal(dark === 'rgb(19, 18, 16)', scheme === 'dark', `${scheme} colours are applied (${dark})`);
        // Open the module with the longest name and the walkthrough stepper's last step, then look again.
        await browser.evaluate(`(() => { const b = [...document.querySelectorAll('button.mod')].sort((a, c) => c.textContent.length - a.textContent.length)[0]; b.click(); })()`);
        await check('with a module open');
        await browser.evaluate(`document.querySelector('[data-goto]:last-of-type, .dot:last-child')?.click()`);
        await check('with the walkthrough on its last step');
      }
    } finally { browser.stop(); }
  });

test('in a real browser: the skip link is the first tab stop, and a module opens with Enter and Space and shows its facts',
  { skip: chrome ? false : 'no Chrome or Chromium found (set CHROME_BIN)', timeout: 120000 }, async (t) => {
    const browser = await launch(chrome).catch(() => null);
    if (!browser) { t.skip('the browser could not be started'); return; }
    try {
      await browser.open(1280);
      await browser.key('Tab', 'Tab', 9);
      const first = await browser.evaluate(`(() => { const a = document.activeElement; const s = getComputedStyle(a); return { tag: a.tagName, href: a.getAttribute('href'), outline: s.outlineStyle, width: parseFloat(s.outlineWidth), top: a.getBoundingClientRect().top }; })()`);
      assert.deepEqual([first.tag, first.href], ['A', '#main'], 'the first tab stop is the skip link');
      assert.ok(first.outline !== 'none' && first.width >= 2 && first.top >= 0, `the skip link shows a focus ring and is on screen (${JSON.stringify(first)})`);

      // Keyboard: focus a module button, Enter opens it, Space on another one switches, Escape closes.
      const state = (id) => browser.evaluate(`(() => { const b = document.querySelector('button.mod[data-module="${id}"]'); const p = document.getElementById('module-panel');
        return { expanded: b.getAttribute('aria-expanded'), hidden: p.hidden, panel: p.textContent.replace(/\\s+/g, ' '), focus: document.activeElement === b }; })()`);
      await browser.evaluate(`document.querySelector('button.mod[data-module="inbox"]').focus()`);
      await browser.key('Enter', 'Enter', 13, '\r');
      let s = await state('inbox');
      assert.deepEqual([s.expanded, s.hidden], ['true', false], 'Enter opens the module');
      assert.match(s.panel, /Event inbox and claims/);
      assert.match(s.panel, /Library only/);
      assert.match(s.panel, /runtime\/lib\/event-inbox\.mjs/);
      assert.match(s.panel, /#266/);
      await browser.evaluate(`document.querySelector('button.mod[data-module="timers"]').focus()`);
      await browser.key(' ', 'Space', 32, ' ');
      s = await state('timers');
      assert.deepEqual([s.expanded, s.hidden], ['true', false], 'Space opens another module');
      assert.match(s.panel, /Due timers/);
      assert.equal((await state('inbox')).expanded, 'false', 'only one module is open');
      await browser.key('Escape', 'Escape', 27);
      s = await state('timers');
      assert.deepEqual([s.expanded, s.hidden, s.focus], ['false', true, true], 'Escape closes the panel and keeps focus on the module');
    } finally { browser.stop(); }
  });
