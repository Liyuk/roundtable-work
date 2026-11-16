import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { buildSite, parseModuleStatus, parseTierStatus } from '../scripts/build-site.mjs';

// The architecture diagram on the site must say exactly what docs/architecture.md says. This file parses the
// document itself (independently of the build script), parses the built site/index.html, and compares them:
// module ids, names, statuses, code paths and issue numbers, the status counts and the three tier nodes.

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFileSync(join(root, p), 'utf8');
const doc = read('docs/architecture.md');
const html = read('site/index.html');
const js = read('site/app.js');

const STATUSES = ['implemented', 'partial', 'library-only', 'missing'];
const LABELS = { implemented: 'Implemented', partial: 'Partial', 'library-only': 'Library only', missing: 'Missing' };
const unesc = (s) => s.replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
// Text as read by a screen reader: decorative glyphs (aria-hidden) are dropped.
const textOf = (fragment) => unesc(fragment.replace(/<span aria-hidden="true">[^<]*<\/span>/g, '').replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();

// The doc side: the JSON code block that follows the marker comment, read here with its own pattern.
const fromDoc = JSON.parse(/<!-- rt:module-status -->\s*```json\s*([\s\S]*?)```/.exec(doc)[1]);

// The site side, from the interactive buttons and, separately, from the table that is the no-JS fallback.
const buttons = [...html.matchAll(/<button type="button" class="mod" data-module="([^"]+)" data-status="([^"]+)"[^>]*>([\s\S]*?)<\/button>/g)]
  .map((m) => ({ id: m[1], status: m[2], name: textOf(m[3].match(/<span class="mod-name">([\s\S]*?)<\/span>\s*<span class="mod-status/)[1]), chip: textOf(m[3].match(/<span class="mod-status[^>]*>([\s\S]*?)<\/span>\s*$/)[1]) }));
const rows = [...html.matchAll(/<tr role="row" data-module="([^"]+)" data-status="([^"]+)">([\s\S]*?)<\/tr>/g)].map((m) => {
  const cell = (label) => m[3].match(new RegExp(`data-label="${label}">([\\s\\S]*?)</t[dh]>`))[1];
  return {
    id: m[1], status: m[2], name: textOf(cell('Module')), chip: textOf(cell('Status')),
    code: [...cell('Code').matchAll(/<code>([\s\S]*?)<\/code>/g)].map((c) => textOf(c[1])),
    issues: cell('Issues'),
  };
});

test('the document has the machine-readable block and every status is one of the four known values', () => {
  assert.ok(fromDoc.length >= 20);
  assert.equal(new Set(fromDoc.map((m) => m.id)).size, fromDoc.length, 'duplicate module ids in the document');
  for (const m of fromDoc) assert.ok(STATUSES.includes(m.status), `${m.id}: status ${m.status}`);
  // The build script's parser agrees with this independent reading.
  assert.deepEqual(parseModuleStatus(doc), fromDoc);
});

test('every module of docs/architecture.md is rendered as a button with the same id, name and status', () => {
  assert.deepEqual(buttons.map((b) => b.id).sort(), fromDoc.map((m) => m.id).sort(), 'same set of ids');
  assert.equal(buttons.length, fromDoc.length, 'one button per module, no extra and no missing module');
  for (const m of fromDoc) {
    const b = buttons.find((x) => x.id === m.id);
    assert.ok(b, `module ${m.id} has no button`);
    assert.equal(b.name, m.name, `${m.id}: the button text must be the module name of the document`);
    assert.equal(b.status, m.status, `${m.id}: status on the button`);
    assert.equal(b.chip, LABELS[m.status], `${m.id}: the visible status label`);
  }
});

test('the module table repeats the same name, status, code paths and issues for every module', () => {
  assert.equal(rows.length, fromDoc.length);
  for (const m of fromDoc) {
    const r = rows.find((x) => x.id === m.id);
    assert.ok(r, `module ${m.id} has no table row`);
    assert.equal(r.name, m.name, `${m.id}: name in the table`);
    assert.equal(r.status, m.status, `${m.id}: status in the table`);
    assert.equal(r.chip, LABELS[m.status], `${m.id}: status label in the table`);
    assert.deepEqual(r.code, m.code, `${m.id}: code paths`);
    assert.equal(r.issues, m.issues.length ? m.issues.map((n) => `#${n}`).join(', ') : 'None recorded', `${m.id}: issues`);
  }
});

test('status counts on the page equal the counts in the document', () => {
  const legend = html.match(/<ul class="legend-row"[^>]*>([\s\S]*?)<\/ul>/)[1];
  for (const st of STATUSES) {
    const want = fromDoc.filter((m) => m.status === st).length;
    const got = legend.match(new RegExp(`<li><span class="status st-${st}">[\\s\\S]*?</span> <span>(\\d+)</span></li>`));
    assert.ok(got, `legend entry for ${st}`);
    assert.equal(Number(got[1]), want, `legend count for ${st}`);
    assert.ok(html.includes(`${want} of ${fromDoc.length}</span>`), `key count for ${st}`);
  }
  const summary = STATUSES.map((st) => `${fromDoc.filter((m) => m.status === st).length} ${LABELS[st].toLowerCase()}`).join(', ');
  assert.ok(html.includes(`Across the ${fromDoc.length} modules: ${summary}.`), 'the production section summary');
  assert.ok(html.includes(`All ${fromDoc.length} modules as a table`));
});

test('the three completion tiers carry the status of the tier nodes in the diagram of the document', () => {
  const chart = /```mermaid\n([\s\S]*?)```/.exec(doc)[1];
  const klass = { impl: 'implemented', partial: 'partial', lib: 'library-only', missing: 'missing' };
  const expected = {};
  for (const [node, tier] of [['T1', 'auto-silent'], ['T2', 'auto-notify'], ['T3', 'approve-first']]) {
    expected[tier] = klass[new RegExp(`${node}\\["[^"]*"\\]:::(\\w+)`).exec(chart)[1]];
  }
  assert.deepEqual(parseTierStatus(doc), expected);
  const chips = html.match(/<ul class="chips"[^>]*>([\s\S]*?)<\/ul>/)[1];
  const cards = html.match(/<section id="tiers"[\s\S]*?<\/section>/)[0];
  for (const [tier, st] of Object.entries(expected)) {
    assert.match(chips, new RegExp(`<li class="st-${st}">[\\s\\S]*?<code>${tier}</code>[\\s\\S]*?\\(${LABELS[st]}\\)`), `${tier} chip`);
    assert.match(cards, new RegExp(`<h3><code>${tier}</code></h3>\\s*<p><span class="status st-${st}">`), `${tier} card`);
  }
});

test('the status key has the meaning of every status, and the labels follow the document legend', () => {
  assert.match(doc, /green = implemented/);
  assert.match(doc, /yellow = partial/);
  assert.match(doc, /blue = library with tests/);
  assert.match(doc, /red = missing/);
  for (const st of STATUSES) assert.match(html, new RegExp(`<li class="key-item st-${st}"><span class="status st-${st}">`), `key item ${st}`);
});

test('each module button is a labelled disclosure that controls the details panel', () => {
  assert.ok(html.includes('id="module-panel"'));
  for (const b of html.matchAll(/<button type="button" class="mod"([^>]*)>/g)) {
    assert.match(b[1], /aria-expanded="false"/);
    assert.match(b[1], /aria-controls="module-panel"/);
  }
  // Every module sits in exactly one lane, and every lane is a labelled group.
  const lanes = [...html.matchAll(/<div class="lane [^"]*" role="group" aria-labelledby="([^"]+)">([\s\S]*?)\n<\/(?:ul|ol)>/g)];
  assert.equal(lanes.length, 6);
  for (const [, label] of lanes) assert.ok(html.includes(`id="${label}"`), `lane label ${label}`);
  assert.equal(lanes.flatMap(([, , body]) => [...body.matchAll(/data-module="([^"]+)"/g)].map((m) => m[1])).length, fromDoc.length);
});

// The drift guards: the build must follow the document, and must refuse a document it cannot describe.
const swap = (from, to) => { assert.ok(doc.includes(from), `fixture: ${from}`); return doc.replace(from, to); };

test('changing a status in the document changes the built page (nothing is hand-copied)', () => {
  const before = buildSite()['index.html'];
  const flipped = swap('{ "id": "inbox", "name": "Event inbox and claims", "status": "library-only"', '{ "id": "inbox", "name": "Event inbox and claims", "status": "implemented"');
  const after = buildSite({ architecture: flipped })['index.html'];
  assert.notEqual(after, before);
  assert.match(after, /<button type="button" class="mod" data-module="inbox" data-status="implemented"/);
  assert.match(before, /<button type="button" class="mod" data-module="inbox" data-status="library-only"/);
  const renamed = buildSite({ architecture: swap('"name": "Due timers"', '"name": "Due timers (renamed)"') })['index.html'];
  assert.ok(renamed.includes('Due timers (renamed)'));
});

test('a module that the page has no description or lane for, or a malformed block, fails the build', () => {
  const added = swap('{ "id": "daemon",', '{ "id": "brand-new", "name": "Brand new", "status": "missing", "code": [], "issues": [] },\n  { "id": "daemon",');
  assert.throws(() => buildSite({ architecture: added }), /without a layout in build-site\.mjs: brand-new/);
  assert.throws(() => buildSite({ architecture: swap('"status": "missing", "code": [], "issues": [207', '"status": "done", "code": [], "issues": [207') }), /status done/);
  assert.throws(() => buildSite({ architecture: doc.replace('<!-- rt:module-status -->', '') }), /no rt:module-status block/);
  const removed = doc.replace(/  \{ "id": "memory",[^\n]*\n/, '');
  assert.notEqual(removed, doc);
  assert.throws(() => buildSite({ architecture: removed }), /not in docs\/architecture\.md: memory/);
});

// ---- app.js: selecting a module (a small DOM stub; unknown selectors throw so drift is loud) ----

function runArch({ wideScreen = true } = {}) {
  class El {
    constructor(tag = 'div', dataset = {}) {
      this.tag = tag; this.dataset = dataset; this.children = []; this.listeners = {}; this.attrs = {}; this.hidden = false; this.className = ''; this.textContent = ''; this.parent = null; this.focused = 0;
    }
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
    fire(type, event = {}) { for (const fn of this.listeners[type] ?? []) fn({ key: '', ...event }); }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    append(...kids) { for (const k of kids) { k.parent?.children.splice(k.parent.children.indexOf(k), 1); k.parent = this; this.children.push(k); } }
    replaceChildren(...kids) { this.children = []; this.append(...kids); }
    cloneNode() { const c = new El(this.tag, { ...this.dataset }); c.textContent = this.textContent; return c; }
    closest(sel) { assert.equal(sel, 'li'); return this.item; }
    scrollIntoView(o) { this.scrolled = o; }
    focus() { this.focused++; }
  }
  const make = (tag, text = '') => { const e = new El(tag); e.textContent = text; return e; };
  const modules = fromDoc.slice(0, 3);
  const dock = make('div');
  const panel = make('div');
  panel.hidden = true;
  dock.append(panel);
  const live = make('p');
  const index = make('details');
  index.open = true;
  const arch = make('div');
  const btns = modules.map((m) => { const b = new El('button', { module: m.id, status: m.status }); b.attrs['aria-expanded'] = 'false'; b.item = make('li'); b.item.append(b); return b; });
  const rowsByModule = Object.fromEntries(modules.map((m) => {
    const row = new El('tr');
    const cells = { Status: make('td'), 'What it does': make('td', `About ${m.name}`), Code: make('td'), Issues: make('td', m.issues.map((n) => `#${n}`).join(', ')) };
    cells.Status.children = [make('span', LABELS[m.status])]; cells.Status.firstElementChild = cells.Status.children[0];
    cells.Code.firstChild = make('ul', m.code.join(' '));
    row.querySelector = (sel) => (sel === 'th' ? make('th', m.name) : cells[/data-label="([^"]+)"/.exec(sel)[1]]);
    return [m.id, row];
  }));
  arch.querySelectorAll = (sel) => { assert.equal(sel, 'button.mod'); return btns; };
  const media = (matches) => { const q = new El(); q.matches = matches; return q; };
  const wide = media(wideScreen);
  const motion = media(false);
  const doc2 = {
    querySelector: (sel) => {
      if (sel === '[data-arch]') return arch;
      const row = /^tr\[data-module="([^"]+)"\]$/.exec(sel);
      if (row) return rowsByModule[row[1]] ?? null;
      const key = /^\.key-item\.st-([a-z-]+) \.key-meaning$/.exec(sel);
      if (key) return make('span', `Meaning of ${key[1]}.`);
      throw new Error(`stub: unexpected selector ${sel}`);
    },
    getElementById: (id) => ({ 'module-panel': panel, 'panel-slot': dock, 'arch-live': live, 'module-index': index })[id],
    createElement: (tag) => make(tag),
    createTextNode: (text) => make('#text', text),
  };
  const win = { matchMedia: (q) => (q === '(min-width: 64rem)' ? wide : q === '(prefers-reduced-motion: reduce)' ? motion : assert.fail(`stub: unexpected media query ${q}`)) };
  // The stepper half of app.js finds no [data-stepper] in this stub and must not run.
  const stepperGuard = { ...doc2, querySelector: (sel) => (sel === '[data-stepper]' ? null : doc2.querySelector(sel)) };
  vm.runInNewContext(js, { document: stepperGuard, window: win });
  return { btns, panel, dock, live, wide, motion, arch, index };
}

test('app.js: selecting a module shows its panel with name, status, description, code and issues; selecting it again closes it', () => {
  const app = runArch();
  const [first, second] = app.btns;
  assert.equal(app.index.open, false, 'the module table is folded once the diagram works (it stays in the page)');
  assert.equal(app.panel.hidden, true, 'nothing is open at load');
  first.fire('click');
  assert.equal(app.panel.hidden, false);
  assert.equal(first.attrs['aria-expanded'], 'true');
  const [heading, meaning, body] = app.panel.children;
  assert.equal(heading.textContent, fromDoc[0].name);
  assert.match(meaning.children.map((c) => c.textContent).join(''), new RegExp(`${LABELS[fromDoc[0].status]}[\\s\\S]*Meaning of ${fromDoc[0].status}`));
  assert.equal(body.children[0].textContent, `About ${fromDoc[0].name}`);
  assert.match(app.live.textContent, new RegExp(`^${fromDoc[0].name}: ${LABELS[fromDoc[0].status]}\\. About`), 'screen readers get the same facts through the status region');
  assert.deepEqual(app.panel.parent, app.dock, 'on a wide screen the panel sits under the diagram');
  assert.ok(app.panel.scrolled, 'the panel is scrolled into view when it is out of sight');

  second.fire('click');
  assert.equal(first.attrs['aria-expanded'], 'false', 'only one module is open at a time');
  assert.equal(second.attrs['aria-expanded'], 'true');
  assert.equal(app.panel.children[0].textContent, fromDoc[1].name);
  second.fire('click');
  assert.equal(second.attrs['aria-expanded'], 'false');
  assert.equal(app.panel.hidden, true);
});

test('app.js: on a narrow screen the panel opens under the module, and Escape closes it and returns focus', () => {
  const app = runArch({ wideScreen: false });
  const [first] = app.btns;
  first.fire('click');
  assert.equal(app.panel.parent, first.item, 'the panel moves into the list item of the selected module');
  app.wide.matches = true;
  app.wide.fire('change');
  assert.equal(app.panel.parent, app.dock, 'a resize to a wide screen moves the panel under the diagram');
  app.arch.fire('keydown', { key: 'a' });
  assert.equal(app.panel.hidden, false, 'other keys do nothing');
  app.arch.fire('keydown', { key: 'Escape' });
  assert.equal(app.panel.hidden, true);
  assert.equal(first.attrs['aria-expanded'], 'false');
  assert.equal(first.focused, 1, 'focus goes back to the module button');
});

test('app.js: smooth scrolling is only used when reduced motion is not requested', () => {
  const app = runArch();
  app.btns[0].fire('click');
  assert.equal(app.panel.scrolled.behavior, 'smooth');
  const reduced = runArch();
  reduced.motion.matches = true;
  reduced.btns[0].fire('click');
  assert.equal(reduced.panel.scrolled.behavior, 'auto');
});
