import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { buildSite } from '../scripts/build-site.mjs';

// Checks for the static demo site in site/. No browser is needed: the page is generated HTML,
// so structure, links, text and assets are verified by reading the files.

const root = fileURLToPath(new URL('..', import.meta.url));
const siteDir = join(root, 'site');
const read = (p) => readFileSync(p, 'utf8');
const scenario = JSON.parse(read(join(root, 'docs', 'pages-demo', 'scenario.json')));
const html = read(join(siteDir, 'index.html'));
const css = read(join(siteDir, 'styles.css'));
const js = read(join(siteDir, 'app.js'));
const siteFiles = { 'index.html': html, 'styles.css': css, 'app.js': js };
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const tags = (name) => [...html.matchAll(new RegExp(`<${name}\\b([^>]*)>`, 'gi'))].map((m) => m[1]);
const attr = (attrs, name) => attrs.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`))?.[1];
const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
const textOf = (fragment) => fragment.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

// Rules copied from test/pages-demo-content.test.mjs so the site follows the same data and claims rules.
const FORBIDDEN_DATA = [
  ['unix home path', /\/home\//],
  ['macOS home path', /\/Users\//],
  ['windows drive path', /\b[A-Za-z]:\\/],
  ['tilde path', /(^|[\s"'`(])~\//],
  ['system path', /(^|[\s"'`(])\/(?:tmp|var|etc|root|opt|mnt|srv)\//],
  ['GitHub token prefix', /\bghp_/],
  ['GitHub fine-grained token prefix', /github_pat_/],
  ['API key prefix', /\bsk-[A-Za-z0-9_-]{16,}/],
  ['private key header', /-----BEGIN/],
  ['email address', /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/],
  ['real repo issue or PR link', /github\.com\/Liyuk\/roundtable-work\/(issues|pull)\//],
  ['any URL', /https?:\/\//i],
  ['private deployment directory', /\.roundtable/],
];
const PROMISE_PHRASES = [/24\/7/i, /24x7/i, /around the clock/i, /always[- ]on/i, /guarantee/i,
  /never fails/i, /auto(?:matic(?:ally)?)?[- ]merge/i, /merges? automatically/i, /self[- ]heal/i];
const NEGATION = /\b(?:not|no|cannot|can't|without|doesn't|isn't|aren't|won't|nor|neither)\b|n't\b/i;
const VERDICT_RE = /审查结论：(?:通过 \| 打回 \| 阻塞|通过|打回|阻塞)/g;
const CJK = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]/;

test('site/ holds exactly the expected static files', () => {
  assert.deepEqual(readdirSync(siteDir).sort(), ['app.js', 'index.html', 'styles.css']);
});

test('the checked-in site equals a fresh build from scenario.json (text and data cannot drift)', () => {
  const fresh = buildSite();
  for (const [name, text] of Object.entries(fresh)) {
    assert.equal(read(join(siteDir, name)), text, `site/${name} is out of date; run npm run build:site`);
  }
  assert.deepEqual(buildSite(), fresh, 'the build must be deterministic');
  const run = spawnSync(process.execPath, [join(root, 'scripts', 'build-site.mjs'), '--check'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
});

test('package.json has the build:site script and no other script or dependency changes', () => {
  const pkg = JSON.parse(read(join(root, 'package.json')));
  assert.equal(pkg.scripts['build:site'], 'node scripts/build-site.mjs');
  assert.deepEqual(Object.keys(pkg.scripts).sort(), ['build:site', 'check', 'doctor', 'preview:site', 'setup', 'test', 'validate:site']);
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.devDependencies, undefined);
});

test('all local links, assets and anchors resolve; ids are unique', () => {
  assert.equal(new Set(ids).size, ids.length, 'duplicate ids');
  const refs = [];
  for (const m of html.matchAll(/\s(href|src|poster|action|data|srcset)="([^"]*)"/g)) refs.push([m[1], m[2]]);
  assert.ok(refs.length > 10);
  for (const [name, value] of refs) {
    if (value.startsWith('data:')) continue;
    if (value.startsWith('#')) { assert.ok(ids.includes(value.slice(1)), `${name}=${value}: no such id`); continue; }
    assert.ok(!/^(?:[a-z][a-z\d+.-]*:|\/\/|\/)/i.test(value), `${name}=${value} is not a local relative reference`);
    assert.ok(existsSync(join(siteDir, value.split(/[?#]/)[0])), `${name}=${value} does not exist in site/`);
  }
  for (const m of html.matchAll(/\s(aria-labelledby|aria-describedby|aria-controls)="([^"]*)"/g)) {
    for (const id of m[2].split(/\s+/)) assert.ok(ids.includes(id), `${m[1]} points to missing id ${id}`);
  }
  const urls = [...css.matchAll(/url\(([^)]*)\)/g)].map((m) => m[1].replace(/["']/g, ''));
  for (const u of urls) assert.ok(u.startsWith('data:'), `css url(${u}) must be a data URI`);
  assert.doesNotMatch(css, /@import/);
  // The stylesheet and script that the page links must be the files in site/.
  assert.ok(refs.some(([n, v]) => n === 'href' && v === 'styles.css'));
  assert.ok(refs.some(([n, v]) => n === 'src' && v === 'app.js'));
});

test('document language, landmarks, skip link and viewport', () => {
  assert.match(html, /<html lang="en">/);
  assert.equal(tags('main').length, 1);
  assert.equal(tags('header').length, 1);
  assert.equal(tags('footer').length, 1);
  assert.ok(tags('nav').length >= 1 && tags('nav').every((a) => attr(a, 'aria-label')), 'every nav needs a label');
  const firstLink = html.match(/<a\b([^>]*)>/)[1];
  assert.equal(attr(firstLink, 'href'), '#main', 'the skip link must be the first link');
  assert.match(firstLink, /skip-link/);
  assert.ok(ids.includes('main'));
  const viewport = html.match(/<meta name="viewport" content="([^"]*)"/)?.[1];
  assert.ok(viewport?.includes('width=device-width'));
  assert.doesNotMatch(viewport, /user-scalable|maximum-scale/, 'zoom must not be disabled');
  assert.match(css, /@media \(min-width: [^)]+\)/);
  assert.match(css, /@media \(max-width: [^)]+\)/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /prefers-color-scheme: dark/);
});

test('one h1 and headings never skip a level', () => {
  const headings = [...html.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/g)].map((m) => [Number(m[1]), textOf(m[2])]);
  assert.equal(headings.filter(([l]) => l === 1).length, 1, 'exactly one h1');
  assert.equal(headings[0][0], 1, 'the first heading is the h1');
  let prev = 0;
  for (const [level, text] of headings) {
    assert.ok(level <= prev + 1, `heading "${text}" (h${level}) skips a level after h${prev}`);
    assert.ok(text.length > 0, 'empty heading');
    prev = level;
  }
  for (const word of ['What it is', 'The flow at a glance', 'Roles', 'Walkthrough', 'When things go wrong', 'Pause controls', 'Implemented today vs planned', 'Limits']) {
    assert.ok(headings.some(([l, t]) => l === 2 && t === word), `h2 ${word} missing`);
  }
});

test('every scenario step is rendered in full as an ordered list (no-JS presentation)', () => {
  const list = html.match(/<ol class="steps"[^>]*>([\s\S]*?)<\/ol>\s*<\/details>/)?.[1];
  assert.ok(list, 'the ordered list of steps is missing');
  assert.equal(scenario.steps.length, 17);
  scenario.steps.forEach((st, i) => {
    const li = list.match(new RegExp(`<li id="step-${st.id}"[\\s\\S]*?\\n</li>`))?.[0];
    assert.ok(li, `step ${st.id} missing`);
    const actor = scenario.actors.find((a) => a.id === st.actor);
    assert.ok(li.includes(`Step ${i + 1}</span> ${esc(st.title)}`), `${st.id}: title`);
    assert.ok(li.includes(esc(actor.displayName)), `${st.id}: actor`);
    assert.ok(li.includes(`<code>${esc(st.phase)}</code>`), `${st.id}: phase`);
    assert.ok(textOf(li).includes(esc(st.summary)), `${st.id}: summary`);
    for (const a of st.artifacts) assert.ok(textOf(li).includes(esc(a)), `${st.id}: artifact ${a}`);
    assert.ok(li.includes(`<code>${st.state}</code>`), `${st.id}: ticket state`);
    if (st.decision) assert.ok(li.includes(`<code>${st.decision}</code>`), `${st.id}: decision`);
    if (st.gate) assert.ok(textOf(li).includes(`${esc(st.gate.name)}: ${esc(st.gate.result)}`), `${st.id}: gate`);
  });
  assert.match(html, /<details class="all-steps" id="all-steps" open>/, 'the full list is open without JavaScript');
  assert.match(html, /<div class="stepper" id="stepper" data-stepper hidden>/, 'the stepper starts hidden and is shown by JavaScript');
});

test('failure table, pause controls, claims and limits are rendered from the data', () => {
  const tables = [...html.matchAll(/<table\b[\s\S]*?<\/table>/g)].map((m) => m[0]);
  assert.equal(tables.length, 2);
  for (const t of tables) {
    assert.match(t, /<caption>[^<]+<\/caption>/);
    const ths = [...t.matchAll(/<th\b([^>]*)>/g)].map((m) => m[1]);
    assert.ok(ths.length > 3 && ths.every((a) => /scope="(col|row)"/.test(a)), 'every th needs a scope');
  }
  const [fail, claims] = tables;
  assert.equal([...fail.matchAll(/<tr\b/g)].length, scenario.failureRecovery.length + 1);
  for (const f of scenario.failureRecovery) for (const k of ['id', 'trigger', 'handling', 'outcome']) assert.ok(fail.includes(esc(f[k])), `${f.id}.${k}`);
  assert.equal([...claims.matchAll(/<tr\b/g)].length, scenario.claims.length + 1);
  for (const c of scenario.claims) {
    assert.ok(claims.includes(esc(c.text)), `claim ${c.id}`);
    const row = claims.match(new RegExp(`<tr[^>]*>(?:(?!</tr>)[\\s\\S])*${esc(c.text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?</tr>`))[0];
    if (c.status === 'implemented') assert.ok(row.includes('Implemented') && row.includes(`<code>${c.evidence}</code>`), `claim ${c.id}`);
    else assert.ok(row.includes('Planned, not claimed') && !row.includes('Implemented'), `claim ${c.id} must be marked planned`);
  }
  // The data says "the future demo page" for p06; the page exists now, so it says "this page" (data untouched).
  for (const p of scenario.pauseControls) {
    const shown = p.id === 'p06' ? p.effect.replace('the future demo page', 'this page') : p.effect;
    assert.ok(html.includes(esc(shown)), `pause control ${p.id}`);
  }
  assert.doesNotMatch(html, /future demo page/);
  assert.match(html, /A visual control on this page that pauses or steps its animation/);
  for (const l of scenario.limits) assert.ok(html.includes(esc(l)), `limit: ${l}`);
  assert.ok(html.includes(esc(scenario.disclaimer)), 'the synthetic disclaimer banner');
  const banner = html.indexOf('class="banner"');
  assert.ok(banner > 0 && banner < html.indexOf('<main'), 'the synthetic banner sits in the header, above the content');
  assert.match(html, /<strong>Demo playback only<\/strong> — pauses the animation on this page and nothing else\./);
});

test('reduced motion is respected in CSS and JavaScript', () => {
  const block = css.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(block, 'reduce block missing');
  assert.match(block, /animation: none !important/);
  assert.match(block, /transition: none !important/);
  assert.match(block, /scroll-behavior: auto !important/);
  // Smooth scrolling is only ever enabled for people who have not asked for less motion.
  const outside = css.replace(/@media \(prefers-reduced-motion: no-preference\) \{[\s\S]*?\n\}/, '');
  assert.doesNotMatch(outside, /scroll-behavior: smooth/);
  assert.match(css, /@media \(prefers-reduced-motion: no-preference\)/);
  assert.ok(js.includes('prefers-reduced-motion: reduce'));
  assert.match(js, /motionQuery\.addEventListener\('change'/);
  assert.match(js, /playBtn\.disabled = reduced/);
  assert.match(js, /if \(reduced\) stopPlayback\(\)/);
  assert.doesNotMatch(css, /animation(-name)?:\s*(?!none)[a-z]/, 'no keyframe animations');
  assert.doesNotMatch(css, /@keyframes/);
  assert.doesNotMatch(js, /autoplay/i);
  // play() may only be defined and called from the Play button's click handler. A bare `play();` in the
  // init code would start playback on load (the runtime test below also checks that no timer starts).
  const playLines = js.split('\n').filter((l) => /\bplay\(/.test(l)).map((l) => l.trim());
  assert.equal(playLines.length, 2, `unexpected play( call sites: ${playLines.join(' | ')}`);
  assert.ok(playLines.some((l) => l.startsWith('function play(')));
  assert.ok(playLines.some((l) => l.startsWith("playBtn.addEventListener('click'")));
});

test('verdict line, decision words and state words appear verbatim; Chinese appears only in the verdict line', () => {
  const triple = '审查结论：通过 | 打回 | 阻塞';
  assert.ok(html.includes(`<span class="contract" lang="zh-Hans">${triple}</span> (approved | rejected | blocked)`));
  assert.ok(html.includes('审查结论：打回') && html.includes('审查结论：通过'));
  for (const w of ['continue', 'wait', 'ask', 'done', 'stop']) assert.ok(html.includes(`<dt><code>${w}</code></dt>`), `decision ${w}`);
  for (const st of scenario.steps) assert.ok(html.includes(`<code>${st.state}</code>`), `state ${st.state}`);
  for (const [name, text] of Object.entries(siteFiles)) {
    const prefixes = text.match(/审查结论/g) ?? [];
    const exact = text.match(VERDICT_RE) ?? [];
    assert.equal(prefixes.length, exact.length, `${name}: verdict prefix with a changed value`);
    assert.doesNotMatch(text.replace(VERDICT_RE, ''), CJK, `${name}: non-English text outside the verdict line`);
  }
  assert.doesNotMatch(css + js, CJK);
});

test('synthetic data only: no forbidden data patterns and no promises (rules shared with the content test)', () => {
  for (const [name, text] of Object.entries(siteFiles)) {
    const lines = text.split('\n');
    for (const [label, re] of FORBIDDEN_DATA) {
      lines.forEach((line, i) => assert.ok(!re.test(line), `site/${name}:${i + 1} matches forbidden pattern "${label}"`));
    }
    lines.forEach((line, i) => {
      const hit = PROMISE_PHRASES.find((re) => re.test(line));
      if (hit) assert.ok(NEGATION.test(line), `site/${name}:${i + 1} uses a promise phrase (${hit}) without a negation`);
    });
    assert.doesNotMatch(text, /github\.com/i);
  }
  // Promise phrases may only come from the disclaimer or the limits, and always negated.
  const allowed = new Set([scenario.disclaimer, ...scenario.limits].map(esc));
  for (const line of html.split('\n')) {
    if (!PROMISE_PHRASES.some((re) => re.test(line))) continue;
    assert.ok([...allowed].some((a) => line.includes(a)), `promise phrase outside the disclaimer or limits: ${line.slice(0, 80)}`);
  }
  // Planned claims are never presented as implemented: the row says "Planned, not claimed", has no evidence
  // path, no "Implemented" badge and is not marked as implemented in the row class.
  const planned = scenario.claims.filter((c) => c.status === 'planned');
  assert.ok(planned.length >= 1);
  const claimsTable = html.match(/<table\b[\s\S]*?<\/table>/g)[1];
  const rows = claimsTable.match(/<tr\b[\s\S]*?<\/tr>/g);
  for (const c of planned) {
    const row = rows.find((r) => r.includes(esc(c.text)));
    assert.ok(row, `planned claim ${c.id} is missing`);
    assert.match(row, /<tr[^>]* class="planned"/, `${c.id}: row class`);
    assert.ok(row.includes('Planned, not claimed') && row.includes('No path: planned only'), `${c.id}: planned wording`);
    assert.doesNotMatch(row, /Implemented|badge-ok|<code>/, `${c.id}: must not look implemented or cite evidence`);
  }
  assert.equal(rows.filter((r) => /class="planned"/.test(r)).length, planned.length, 'only planned claims use the planned row');
});

test('no external requests, third-party code, forms, tracking or privileged actions', () => {
  assert.doesNotMatch(html, /<script\b(?![^>]*\ssrc="app\.js")[^>]*>/, 'only app.js may be a script');
  assert.equal(tags('script').length, 1);
  assert.doesNotMatch(html, /<(?:form|iframe|object|embed|input|select|textarea|link\b[^>]*rel="(?:preconnect|dns-prefetch|prefetch|preload))\b/i);
  assert.doesNotMatch(html, /\son[a-z]+="/i, 'no inline event handlers');
  assert.doesNotMatch(html, /\sstyle="/i, 'no inline styles (the CSP forbids them)');
  assert.match(html, /http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self'; script-src 'self'; img-src data:; base-uri 'none'; form-action 'none'"/);
  assert.doesNotMatch(js, /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts|Worker|ServiceWorker)\b/);
  assert.doesNotMatch(js, /\bimport\b|\beval\s*\(|new Function|\binnerHTML\b|\binsertAdjacentHTML\b|document\.write/);
  assert.doesNotMatch(js, /localStorage|sessionStorage|indexedDB|document\.cookie|navigator\.(?:sendBeacon|clipboard)|window\.open|location\s*[.=]|new Image/);
  assert.doesNotMatch(css, /@font-face|@import|url\(\s*["']?https?:/);
  const links = [...html.matchAll(/<a\b([^>]*)>/g)].map((m) => attr(m[1], 'href'));
  assert.ok(links.every((h) => h.startsWith('#')), 'every link is an in-page anchor');
});

test('every button is a real button with an accessible name and no merge or deploy action', () => {
  const buttons = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)];
  assert.ok(buttons.length >= 20, 'previous, next, play, restart, jumps and step buttons');
  for (const [, attrs, inner] of buttons) {
    assert.equal(attr(attrs, 'type'), 'button', `button without type=button: ${attrs}`);
    const visible = textOf(inner.replace(/<span aria-hidden="true"[^>]*>[\s\S]*?<\/span>/g, ''));
    const name = attr(attrs, 'aria-label') || visible;
    assert.ok(name && name.length >= 2, `button without an accessible name: ${attrs}`);
    // Step navigation buttons only quote the step title ("Go to step 17: ...") and move the view.
    if (/^Go to step \d+: /.test(name)) assert.ok(/\sdata-goto="s\d+"/.test(attrs) && !/data-action/.test(attrs), `bad step button ${name}`);
    else assert.doesNotMatch(`${name} ${visible}`, /\b(?:merge|deploy|publish|release|approve|submit|send|commit|push)\b/i, `privileged action offered by button "${name}"`);
  }
  const labels = buttons.map(([, , inner]) => textOf(inner));
  for (const required of ['Previous', 'Next', '▶ Play', 'Restart']) assert.ok(labels.includes(required), `${required} button`);
  const actions = buttons.map(([, a]) => attr(a, 'data-action')).filter(Boolean).sort();
  assert.deepEqual(actions, ['next', 'play', 'prev', 'restart'], 'the only actions are step navigation and demo playback');
  assert.doesNotMatch(html, /role="button"/);
  assert.doesNotMatch(js, /createElement\(\s*['"]button/);
});

test('contrast: text, UI and focus colors meet WCAG 2.2 AA in light and dark', () => {
  const vars = (block) => Object.fromEntries([...block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2]]));
  const light = vars(css.match(/:root \{([\s\S]*?)\n\}/)[1]);
  const dark = { ...light, ...vars(css.match(/@media \(prefers-color-scheme: dark\) \{\s*:root \{([\s\S]*?)\n  \}/)[1]) };
  const lum = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const text = [['ink', 'bg'], ['ink', 'surface'], ['ink', 'surface-2'], ['muted', 'bg'], ['muted', 'surface'], ['muted', 'surface-2'],
    ['teal', 'bg'], ['teal', 'surface'], ['teal', 'teal-tint'], ['teal', 'surface-2'], ['on-teal', 'teal'], ['amber', 'amber-tint'], ['amber', 'bg'], ['amber', 'surface'],
    ['red', 'red-tint'], ['red', 'bg'], ['red', 'surface'], ['ink', 'amber-tint'], ['ink', 'teal-tint'], ['ink', 'red-tint']];
  const nonText = [['line', 'bg'], ['line', 'surface'], ['focus', 'bg'], ['focus', 'surface'], ['amber', 'bg'], ['red', 'bg'], ['teal', 'bg']];
  for (const [mode, v] of [['light', light], ['dark', dark]]) {
    for (const [fg, bg] of text) assert.ok(ratio(v[fg], v[bg]) >= 4.5, `${mode}: ${fg} on ${bg} is ${ratio(v[fg], v[bg]).toFixed(2)}`);
    for (const [fg, bg] of nonText) assert.ok(ratio(v[fg], v[bg]) >= 3, `${mode}: ${fg} vs ${bg} is ${ratio(v[fg], v[bg]).toFixed(2)}`);
  }
});

test('layout and sizing safeguards: stacked tables on small screens, no fixed widths over 320px, relative units', () => {
  assert.match(css, /@media \(max-width: 42rem\)[\s\S]*display: block/);
  assert.match(css, /@media \(min-width: 60rem\)[\s\S]*grid-template-columns: minmax\(0, 26rem\)/);
  for (const m of css.matchAll(/(?<![-a-z])(?:width|min-width):\s*(\d+(?:\.\d+)?)px/g)) assert.ok(Number(m[1]) <= 1, `fixed pixel width ${m[0]}`);
  assert.match(css, /overflow-wrap/);
  assert.match(css, /font: 1rem\//);
  assert.match(css, /min-height: 2\.75rem/, 'targets of at least 24px (44px used for buttons)');
  assert.doesNotMatch(css, /font-size:\s*\d+px/);
});

test('the "Outside the demo" box never covers the round-table diagram (320px and up, no browser needed)', () => {
  // Why this guard exists: the box used to be absolutely positioned inside the stage (bottom: 2%) and, on
  // 320-385px screens, it covered the Developer node. There is no headless browser here, so the check is
  // structural plus geometry computed from the CSS numbers:
  //  1. the box is in normal flow and is not a descendant of the stage, so it cannot overlay any node;
  //  2. every node, the ticket and the token fit inside the stage and the nodes do not overlap each other,
  //     at every viewport width from 320px up (the stage width is computed from the page paddings).
  const stageOpen = html.indexOf('<div class="stage">');
  assert.ok(stageOpen > 0);
  let depth = 0;
  let stageEnd = -1;
  for (const m of html.slice(stageOpen).matchAll(/<div\b|<\/div>/g)) {
    depth += m[0] === '</div>' ? -1 : 1;
    if (depth === 0) { stageEnd = stageOpen + m.index; break; }
  }
  const outsideAt = html.indexOf('<div class="outside"');
  assert.ok(stageEnd > 0 && outsideAt > stageEnd, 'the outside box must come after the stage, not inside it');
  assert.ok(html.indexOf('<div class="token') < stageEnd && html.indexOf('<div class="token') > stageOpen, 'the token stays inside the stage');
  for (const [, selector, body] of css.matchAll(/(^|\n)\s*([^{}\n]*\.outside\b[^{}\n]*)\{([^}]*)\}/g).map((m) => [0, m[2], m[3]])) {
    assert.doesNotMatch(body, /position:\s*(?:absolute|fixed|sticky)/, `${selector.trim()} must stay in normal flow`);
    assert.doesNotMatch(body, /(?:^|[;\s])(?:top|bottom|left|right|inset|transform|float):/, `${selector.trim()} must not be offset`);
  }
  assert.match(css, /\.outside \{\s*position: static;/);

  const rem = 16;
  const num = (re) => Number(css.match(re)[1]);
  const ratio = num(/\.stage \{[^}]*aspect-ratio: 1 \/ ([\d.]+)/);
  const slots = [...css.matchAll(/\.slot-(\d) \{ --x: ([\d.]+)%; --y: ([\d.]+)%; \}/g)].map((m) => ({ n: m[1], x: Number(m[2]) / 100, y: Number(m[3]) / 100 }));
  assert.equal(slots.length, 6);
  const shape = num(/\.node-shape \{[^}]*?width: ([\d.]+)rem/) * 1.12 * rem; // active nodes are scaled up
  const nodeW = (narrow) => (narrow ? num(/@media \(max-width: 24rem\) \{[\s\S]*?\.node \{ width: ([\d.]+)rem/) : num(/\.node \{[^}]*?width: ([\d.]+)rem/)) * rem;
  const nodeFont = (narrow) => (narrow ? num(/@media \(max-width: 24rem\) \{[\s\S]*?\.node \{[^}]*font-size: ([\d.]+)rem/) : num(/\.node \{[^}]*?font-size: ([\d.]+)rem/)) * rem;
  // Active node height: scaled shape, a one-line label (role names are single words), the "Now" line and gaps.
  const nodeH = (narrow) => shape + 1.2 * nodeFont(narrow) + 1.2 * 0.72 * rem + 3 * 0.1 * rem;
  const longestState = Math.max(...scenario.steps.map((st) => st.state.length));
  const ticketFont = (narrow) => (narrow ? num(/@media \(max-width: 24rem\) \{[\s\S]*?\.ticket code \{ font-size: ([\d.]+)rem/) : num(/\.ticket code \{ font-size: ([\d.]+)rem/)) * rem;
  const clamp = (lo, v, hi) => Math.min(hi, Math.max(lo, v));
  const boxesCross = (a, b) => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;

  for (const vw of [320, 360, 375, 390, 414, 600, 768, 959, 960, 1280, 1920]) {
    const content = vw - 2 * clamp(16, 0.04 * vw, 32) - 2 * clamp(12, 0.03 * vw, 24) - 2; // page padding, stepper padding, border
    const W = vw >= 960 ? 26 * rem : Math.min(30 * rem, content);
    const H = W * ratio;
    const narrow = vw <= 24 * rem;
    const boxes = slots.map((sl) => ({ n: `slot-${sl.n}`, l: sl.x * W - nodeW(narrow) / 2, r: sl.x * W + nodeW(narrow) / 2, t: sl.y * H - nodeH(narrow) / 2, b: sl.y * H + nodeH(narrow) / 2 }));
    // The ticket: three lines, as wide as the longest state in monospace (about 0.6em per character), centered.
    const ticketW = Math.max(0.3 * W, longestState * 0.6 * ticketFont(narrow));
    const ticketH = 3.2 * rem;
    const ticketY = Number(css.match(/\.ticket \{[^}]*?top: ([\d.]+)%/)[1]) / 100 * H;
    boxes.push({ n: 'ticket', l: W / 2 - ticketW / 2, r: W / 2 + ticketW / 2, t: ticketY - ticketH / 2, b: ticketY + ticketH / 2 });
    for (const b of boxes) {
      assert.ok(b.l >= 0 && b.r <= W && b.t >= 0 && b.b <= H, `${vw}px: ${b.n} leaves the stage (${JSON.stringify(b)}, stage ${W.toFixed(0)}x${H.toFixed(0)})`);
    }
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) assert.ok(!boxesCross(boxes[i], boxes[j]), `${vw}px: ${boxes[i].n} overlaps ${boxes[j].n}`);
    // The token's resting place below the bottom node, still inside the stage.
    const out = css.match(/\.slot-out \{ --x: ([\d.]+)%; --y: ([\d.]+)%; \}/);
    // (the token's bottom edge sits 0.25rem above the stage's bottom edge, see .token.slot-out)
    const tokenB = Number(out[2]) / 100 * H - 0.25 * rem;
    const token = { l: Number(out[1]) / 100 * W - 0.95 * rem, r: Number(out[1]) / 100 * W + 0.95 * rem, t: tokenB - 1.35 * rem, b: tokenB };
    assert.match(css, /\.token\.slot-out \{ transform: translate\(-0\.95rem, calc\(-100% - 0\.25rem\)\); \}/);
    assert.ok(token.t >= 0 && token.b <= H, `${vw}px: the token at the merge step leaves the stage`);
    assert.ok(!boxesCross(token, boxes[3]), `${vw}px: the token covers the bottom node`);
  }
});

// Minimal DOM stub: just enough to run site/app.js unmodified. Unknown selectors throw, so a change in
// app.js that needs a new element fails loudly instead of silently passing.
function runApp({ reducedAtStart = false } = {}) {
  const camel = (k) => k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  class El {
    constructor(dataset = {}) {
      this.dataset = dataset; this.children = []; this.listeners = {}; this.attrs = {}; this.textContent = ''; this.hidden = false;
      this.disabled = false; this.open = true; this.className = ''; this.focused = 0;
      const set = new Set();
      this.classList = { toggle: (n, on) => { if (on === undefined ? !set.has(n) : on) set.add(n); else set.delete(n); }, add: (n) => set.add(n), contains: (n) => set.has(n) };
    }
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
    fire(type, event = {}) { for (const fn of this.listeners[type] ?? []) fn({ preventDefault() {}, key: '', ...event }); }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    removeAttribute(k) { delete this.attrs[k]; }
    replaceChildren(...kids) { this.children = kids; }
    cloneNode() { return new El({ ...this.dataset }); }
    closest() { return this.inDots ? {} : null; }
    scrollIntoView() {}
    focus() { this.focused++; }
  }
  const itemAttrs = [...html.matchAll(/<li id="step-[^"]*" class="step"([^>]*)>/g)].map((m) => Object.fromEntries([...m[1].matchAll(/data-([a-z-]+)="([^"]*)"/g)].map((a) => [camel(a[1]), a[2]])));
  assert.equal(itemAttrs.length, scenario.steps.length);
  const items = itemAttrs.map((d) => { const el = new El(d); el.children = [new El()]; return el; });
  const nodes = [...html.matchAll(/<div class="node slot-\d" data-actor="([^"]*)" data-slot="(\d)">/g)].map((m) => new El({ actor: m[1], slot: m[2] }));
  assert.equal(nodes.length, scenario.actors.length);
  const gotoButtons = items.map((it) => { const b = new El({ goto: it.dataset.step }); b.inDots = true; return b; });
  const el = Object.fromEntries(['root', 'detail', 'count', 'live', 'diagram', 'token', 'outside', 'ticketState', 'ticketDecision', 'prev', 'next', 'play', 'restart', 'playLabel', 'playIcon', 'motionNote', 'allSteps'].map((k) => [k, new El()]));
  el.root.hidden = true;
  el.token.className = 'token slot-0';
  const bySelector = {
    '#step-detail': el.detail, '#step-count': el.count, '#live': el.live, '.diagram': el.diagram, '[data-token]': el.token, '[data-outside]': el.outside,
    '[data-ticket-state]': el.ticketState, '[data-ticket-decision]': el.ticketDecision, '[data-action="prev"]': el.prev, '[data-action="next"]': el.next,
    '[data-action="play"]': el.play, '[data-action="restart"]': el.restart, '[data-play-label]': el.playLabel, '[data-play-icon]': el.playIcon, '#motion-note': el.motionNote,
  };
  el.root.querySelector = (sel) => { if (!(sel in bySelector)) throw new Error(`stub: unexpected selector ${sel}`); return bySelector[sel]; };
  el.root.querySelectorAll = (sel) => { assert.equal(sel, '.node'); return nodes; };
  const list = new El();
  list.querySelectorAll = (sel) => { assert.equal(sel, ':scope > li[data-step]'); return items; };
  el.play.disabled = false;
  const timers = [];
  const media = new El();
  media.matches = reducedAtStart;
  media.addEventListener = media.addEventListener.bind(media);
  const documentStub = new El();
  documentStub.documentElement = new El();
  documentStub.hidden = false;
  documentStub.querySelector = (sel) => { assert.equal(sel, '[data-stepper]'); return el.root; };
  documentStub.getElementById = (id) => ({ 'step-list': list, 'all-steps': el.allSteps })[id];
  documentStub.querySelectorAll = (sel) => (sel === '[data-goto]' ? gotoButtons : sel === 'a[data-step]' ? [] : (() => { throw new Error(`stub: unexpected selector ${sel}`); })());
  const windowStub = {
    matchMedia: (q) => { assert.equal(q, '(prefers-reduced-motion: reduce)'); return media; },
    setInterval: (fn, ms) => { timers.push({ fn, ms, live: true }); return timers.length; },
    clearInterval: (id) => { if (timers[id - 1]) timers[id - 1].live = false; },
  };
  vm.runInNewContext(js, { document: documentStub, window: windowStub });
  const running = () => timers.filter((t) => t.live);
  return { el, items, nodes, timers, running, media, documentStub, gotoButtons };
}

test('app.js at runtime: nothing autoplays; Next, Previous and jump buttons change the step', () => {
  const app = runApp();
  const { el } = app;
  assert.equal(app.timers.length, 0, 'no timer may be started during init (nothing autoplays)');
  assert.equal(el.root.hidden, false, 'the stepper is revealed by JavaScript');
  assert.equal(el.allSteps.open, false);
  assert.equal(el.count.textContent, `Step 1 of ${app.items.length}`);
  assert.equal(el.play.disabled, false);
  assert.equal(el.playLabel.textContent, 'Play');
  assert.equal(el.motionNote.hidden, true);
  assert.equal(el.prev.attrs['aria-disabled'], 'true');
  assert.ok(app.nodes.find((n) => n.dataset.actor === app.items[0].dataset.actor).classList.contains('is-active'));

  el.next.fire('click');
  assert.equal(el.count.textContent, `Step 2 of ${app.items.length}`);
  assert.equal(el.prev.attrs['aria-disabled'], 'false');
  assert.match(el.live.textContent, /^Step 2 of 17: /);
  assert.equal(el.ticketState.textContent, app.items[1].dataset.state);
  el.prev.fire('click');
  assert.equal(el.count.textContent, `Step 1 of ${app.items.length}`);
  el.prev.fire('click');
  assert.equal(el.count.textContent, `Step 1 of ${app.items.length}`, 'Previous stops at the first step');

  app.gotoButtons[app.items.length - 1].fire('click');
  assert.equal(el.count.textContent, `Step ${app.items.length} of ${app.items.length}`);
  assert.equal(el.next.attrs['aria-disabled'], 'true');
  assert.equal(el.outside.classList.contains('is-active'), true, 'the merge step highlights the outside box');
  assert.equal(el.token.className, 'token slot-out');
  el.next.fire('click');
  assert.equal(el.count.textContent, `Step ${app.items.length} of ${app.items.length}`, 'Next stops at the last step');
  el.root.fire('keydown', { key: 'ArrowLeft' });
  assert.equal(el.count.textContent, `Step ${app.items.length - 1} of ${app.items.length}`);
  assert.equal(app.timers.length, 0, 'navigation never starts playback');
  el.restart.fire('click');
  assert.equal(el.count.textContent, `Step 1 of ${app.items.length}`);
});

test('app.js at runtime: Play starts only after a click and stops on Pause, navigation and reduced motion', () => {
  const app = runApp();
  const { el } = app;
  assert.equal(app.running().length, 0);
  el.play.fire('click');
  assert.equal(app.running().length, 1, 'Play starts exactly one timer');
  assert.equal(el.playLabel.textContent, 'Pause');
  app.running()[0].fn();
  assert.equal(el.count.textContent, `Step 2 of ${app.items.length}`, 'a tick advances one step');
  el.play.fire('click');
  assert.equal(app.running().length, 0, 'the same button pauses');
  assert.equal(el.playLabel.textContent, 'Play');
  el.play.fire('click');
  assert.equal(app.running().length, 1);
  el.next.fire('click');
  assert.equal(app.running().length, 0, 'manual navigation stops playback');

  el.play.fire('click');
  assert.equal(app.running().length, 1);
  app.media.matches = true; // the person turns on "reduce motion" while playback runs
  app.media.fire('change');
  assert.equal(app.running().length, 0, 'a reduced-motion change stops playback');
  assert.equal(el.play.disabled, true, 'Play is disabled under reduced motion');
  assert.equal(el.motionNote.hidden, false);
  assert.equal(el.root.dataset.motion, 'reduced');
  el.play.fire('click');
  assert.equal(app.running().length, 0, 'Play does nothing while reduced motion is on');
  el.next.fire('click'); // manual stepping still works
  assert.equal(el.count.textContent, `Step 4 of ${app.items.length}`);

  app.media.matches = false;
  app.media.fire('change');
  assert.equal(el.play.disabled, false);
  assert.equal(el.motionNote.hidden, true);
  assert.equal(app.running().length, 0, 'turning motion back on does not start playback by itself');
});

test('app.js at runtime: with reduced motion at load, Play is disabled and never starts', () => {
  const app = runApp({ reducedAtStart: true });
  assert.equal(app.timers.length, 0);
  assert.equal(app.el.play.disabled, true);
  assert.equal(app.el.motionNote.hidden, false);
  app.el.play.fire('click');
  assert.equal(app.timers.length, 0);
  app.el.next.fire('click');
  assert.equal(app.el.count.textContent, `Step 2 of ${app.items.length}`);
});

test('without JavaScript the "Interactive stepper" heading is hidden together with the stepper (no empty heading)', () => {
  const stepper = html.match(/<div class="stepper" id="stepper" data-stepper hidden>\n<h3 id="stepper-h">Interactive stepper<\/h3>/);
  assert.ok(stepper, 'the heading must be the first child of the hidden stepper');
  assert.doesNotMatch(html.replace(/<div class="stepper"[\s\S]*?<h3 id="all-steps-h">/, ''), /Interactive stepper<\/h3>/);
  assert.match(html, /<noscript><p class="banner" role="note">JavaScript is off\./);
});
