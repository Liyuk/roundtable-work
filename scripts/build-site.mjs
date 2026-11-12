// Builds site/index.html from docs/pages-demo/scenario.json.
//
//   node scripts/build-site.mjs          write the generated files into site/
//   node scripts/build-site.mjs --check  exit 1 if site/ differs from a fresh build (no writes)
//
// No dependencies. The scenario file is the single source for every step, table row and
// limit on the page. site/styles.css and site/app.js are hand-written static assets.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntry } from './entry.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const scenarioPath = join(root, 'docs', 'pages-demo', 'scenario.json');
const siteDir = join(root, 'site');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Frozen machine-contract verdict line. Shown verbatim and tagged with its own language.
const VERDICT_RE = /审查结论：(?:通过 \| 打回 \| 阻塞|通过|打回|阻塞)/g;
const VERDICT_TRIPLE = '审查结论：通过 | 打回 | 阻塞';
const rich = (s) => esc(s).replace(VERDICT_RE, (m) => `<span class="contract" lang="zh-Hans">${m}</span>`);
const code = (s) => `<code>${esc(s)}</code>`;
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// Visual kind of a step: never the only signal, each kind also has a glyph and a text label.
const KINDS = {
  flow: { glyph: '●', label: 'Normal flow' },
  wait: { glyph: '◐', label: 'Waiting or asking' },
  reject: { glyph: '✕', label: 'Sent back or stopped' },
  ok: { glyph: '✓', label: 'Review passed' },
};
function kindOf(step) {
  const result = step.gate?.result ?? '';
  if (result.includes('审查结论：打回') || result.includes('审查结论：阻塞') || step.decision === 'stop' || step.state === 'failed') return 'reject';
  if (result.includes('审查结论：通过')) return 'ok';
  if (step.state.startsWith('waiting') || step.decision === 'ask' || step.decision === 'wait') return 'wait';
  return 'flow';
}
const badge = (kind) => `<span class="badge badge-${kind}"><span aria-hidden="true">${KINDS[kind].glyph}</span> ${KINDS[kind].label}</span>`;
const spoken = (result) => result.replace(VERDICT_RE, '').replace(/[()]/g, '').trim() || result;

// Authored English role descriptions (restating the outline, keyed by role).
const ROLE_TEXT = {
  human: 'Sets the goal, the acceptance and the limits. Can correct, pause or stop at any time. Merging is a human decision.',
  chief: 'The main contact. Writes the ticket, splits and delegates the work, reads the results, and ends every turn with one decision.',
  researcher: 'Answers a bounded question with sources and separates what was observed from what was inferred.',
  developer: 'Turns a delegated task into a verifiable artifact and reports in a delivery card. Does not commit by default.',
  reviewer: 'Judges the delivery against the original goal and acceptance, in a session separate from the author\u2019s.',
  fixer: 'Handles a delegated bug: reproduces it with a failing check first, then fixes it.',
};
const DECISION_TEXT = {
  continue: 'Do the next step now, in this turn.',
  wait: 'Wait for a named event and say how the wake-up would happen. Other independent work can go on.',
  ask: 'A human decision is needed for one item. Only that item is suspended.',
  done: 'Every acceptance item has evidence.',
  stop: 'The budget is spent, there is no progress, the risk is too high or authorization is gone.',
};
// The scenario data was written before this page existed ("the future demo page"). The data stays
// as it is; only the rendered text says "this page".
const pageText = (p) => (p.id === 'p06' ? p.effect.replace('the future demo page', 'this page') : p.effect);
const FLOW = ['Human goal', 'Chief', 'Developer', 'Test gate', 'Scope gate', 'Independent reviewer', 'Chief commit', 'Pull request', 'Human merge (outside the demo)'];
const NAV = [['what', 'What it is'], ['flow', 'The flow'], ['roles', 'Roles'], ['walkthrough', 'Walkthrough'], ['failures', 'When things go wrong'],
  ['controls', 'Pause controls'], ['claims', 'Implemented vs planned'], ['limits', 'Limits']];

function validate(s) {
  if (s.synthetic !== true) throw new Error('scenario.json must be marked synthetic');
  if (s.actors.length > 6) throw new Error('the round-table layout has six slots; extend site/styles.css before adding actors');
  if (s.actors[0].role !== 'human') throw new Error('the first actor must be the human (top slot)');
  for (const st of s.steps) if (!s.actors.some((a) => a.id === st.actor)) throw new Error(`step ${st.id}: unknown actor`);
}

function stepItem(s, st, n) {
  const actor = s.actors.find((a) => a.id === st.actor);
  const kind = kindOf(st);
  const attrs = [`id="step-${st.id}"`, `class="step"`, `data-step="${st.id}"`, `data-actor="${st.actor}"`, `data-phase="${esc(st.phase)}"`,
    `data-kind="${kind}"`, `data-title="${esc(st.title)}"`, `data-actor-name="${esc(actor.displayName)}"`, `data-state="${esc(st.state)}"`];
  if (st.decision) attrs.push(`data-decision="${esc(st.decision)}"`);
  if (st.gate) attrs.push(`data-gate="${esc(st.gate.name)}: ${esc(spoken(st.gate.result))}"`);
  const facts = [];
  if (st.gate) facts.push(`<div><dt>Gate result</dt><dd>${esc(st.gate.name)}: ${rich(st.gate.result)}</dd></div>`);
  facts.push(`<div><dt>Ticket state</dt><dd>${code(st.state)}</dd></div>`);
  if (st.decision) facts.push(`<div><dt>Decision</dt><dd>${code(st.decision)}</dd></div>`);
  return `<li ${attrs.join(' ')}>
<h4 class="step-title"><span class="step-no">Step ${n}</span> ${esc(st.title)}</h4>
<p class="step-meta">${badge(kind)} <span class="actor">Actor: ${esc(actor.displayName)}</span> <span class="phase">Phase: ${code(st.phase)}</span></p>
<p class="step-summary">${rich(st.summary)}</p>
<p class="label">Artifacts</p>
<ul class="artifacts">
${st.artifacts.map((a) => `<li>${rich(a)}</li>`).join('\n')}
</ul>
<dl class="facts">
${facts.join('\n')}
</dl>
</li>`;
}

function moments(s) {
  const idx = (id) => s.steps.findIndex((x) => x.id === id) + 1;
  const li = (st) => {
    const gate = st.gate && st.gate.name === 'independent review' ? ` Verdict line: ${rich(st.gate.result)}.` : '';
    return `<li><a href="#step-${st.id}" data-step="${st.id}">Step ${idx(st.id)}</a>: ${esc(st.title)} (state ${code(st.state)}${st.decision ? `, decision ${code(st.decision)}` : ''}).${gate}</li>`;
  };
  const askAt = s.steps.findIndex((x) => x.decision === 'ask');
  const rejAt = s.steps.findIndex((x) => x.gate?.name === 'independent review' && x.gate.result.includes('审查结论：打回'));
  const okAt = s.steps.findIndex((x, i) => i > rejAt && x.gate?.name === 'independent review' && x.gate.result.includes('审查结论：通过'));
  const fixAt = s.steps.findIndex((x, i) => i > rejAt && x.phase === 'rework');
  const last = s.steps.length - 1;
  const card = (id, title, kind, steps, blurb) => `<article class="moment" aria-labelledby="${id}">
<h4 id="${id}">${title}</h4>
<p>${badge(kind)}</p>
<p>${blurb}</p>
<ul>
${steps.map(li).join('\n')}
</ul>
</article>`;
  return [
    card('moment-ask', 'Ask the human', 'wait', [s.steps[askAt], s.steps[askAt + 1]], rich(s.steps[askAt].summary)),
    card('moment-reject', 'Rejection, fix and approval', 'reject', [s.steps[rejAt], s.steps[fixAt], s.steps[okAt]],
      'The reviewer sends the work back, the original author fixes it, and a second review passes. The verdict line is shown exactly as the reviewer writes it.'),
    card('moment-merge', 'Human merge', 'wait', [s.steps[last]], rich(s.steps[last].summary) + ' No button on this page performs a merge or any other privileged action.'),
  ].join('\n');
}

function renderHtml(s) {
  validate(s);
  const n = s.steps.length;
  const first = s.steps[0];
  const jump = [
    ['Step %: ask the human', s.steps.findIndex((x) => x.decision === 'ask')],
    ['Step %: review sent back', s.steps.findIndex((x) => x.gate?.result.includes('审查结论：打回'))],
    ['Step %: review passed', s.steps.findIndex((x) => x.gate?.result.includes('审查结论：通过'))],
    ['Step %: human decision', n - 1],
  ];
  const slots = s.actors.map((a, i) => `<div class="node slot-${i}" data-actor="${a.id}" data-slot="${i}">
<span class="node-shape" aria-hidden="true">${['◯', '◆', '◇', '■', '▲', '▼'][i]}</span>
<span class="node-label">${esc(cap(a.role))}</span>
<span class="now">Now</span>
</div>`).join('\n');
  const dots = s.steps.map((st, i) => `<li><button type="button" class="dot dot-${kindOf(st)}" data-goto="${st.id}" aria-label="Go to step ${i + 1}: ${esc(st.title)}"><span aria-hidden="true">${i + 1}</span></button></li>`).join('\n');
  const roleCards = s.actors.map((a) => `<li class="role">
<h3>${esc(a.displayName)}</h3>
<p class="role-tag">Role: ${code(a.role)}</p>
<p>${esc(ROLE_TEXT[a.role] ?? '')}</p>${a.role === 'reviewer' ? `
<p>The first line of its card is the verdict: <span class="contract" lang="zh-Hans">${VERDICT_TRIPLE}</span> (approved | rejected | blocked).</p>` : ''}
</li>`).join('\n');
  const tr = (cells, attrs = '') => `<tr role="row"${attrs}>${cells}</tr>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self'; script-src 'self'; img-src data:; base-uri 'none'; form-action 'none'">
<title>Roundtable Work: a synthetic walkthrough</title>
<meta name="description" content="A static, synthetic walkthrough of the Roundtable Work workflow: a human goal, a Chief, executor roles, checks, an independent review, a pull request and a human merge.">
<link rel="icon" href="data:,">
<link rel="stylesheet" href="styles.css">
<script src="app.js" defer></script>
</head>
<body>
<a class="skip-link" href="#main">Skip to main content</a>
<header class="site-header">
<div class="wrap">
<p class="eyebrow">Static demo</p>
<h1>Roundtable Work: a synthetic walkthrough</h1>
<p class="lead">A role-based workflow for agents: a human sets the goal, a Chief coordinates, executors do the work, checks and an independent review follow, and a human decides on the merge.</p>
<p class="banner" role="note"><strong>Synthetic data.</strong> ${esc(s.disclaimer)}</p>
<nav aria-label="Page sections">
<ul class="nav-list">
${NAV.map(([id, label]) => `<li><a href="#${id}">${label}</a></li>`).join('\n')}
</ul>
</nav>
</div>
</header>
<main id="main" tabindex="-1">
<div class="wrap">

<section id="what" aria-labelledby="what-h">
<h2 id="what-h">What it is</h2>
<p>Roundtable Work is a skill and configuration for existing agent hosts. One Chief owns the goal, the other roles work in separate sessions, and handoffs use a ticket, a delegation card, a delivery card and a checkpoint record. It has no background runtime of its own, and this page is an explanation, not a live system.</p>
<h3>How every Chief turn ends</h3>
<p>Each turn ends with exactly one continuation decision.</p>
<dl class="defs">
${Object.entries(DECISION_TEXT).map(([k, v]) => `<div><dt>${code(k)}</dt><dd>${esc(v)}</dd></div>`).join('\n')}
</dl>
</section>

<section id="flow" aria-labelledby="flow-h">
<h2 id="flow-h">The flow at a glance</h2>
<p>Text first: nine stages, in order.</p>
<ol class="flow">
${FLOW.map((f) => `<li>${esc(f)}</li>`).join('\n')}
</ol>
<p>Checks before review are called the <em>test gate</em> and the <em>scope gate</em> in this demo. They are instructions that an agent follows, not an automated enforcement engine. Independent review means a separate session judges the delivery. Its verdict line is <span class="contract" lang="zh-Hans">${VERDICT_TRIPLE}</span> (approved | rejected | blocked).</p>
</section>

<section id="roles" aria-labelledby="roles-h">
<h2 id="roles-h">Roles</h2>
<p>A role is not a model. A separate session gives a fresh viewpoint, but a different model or name is not proof of quality.</p>
<ul class="roles" role="list">
${roleCards}
</ul>
</section>

<section id="walkthrough" aria-labelledby="walk-h">
<h2 id="walk-h">Walkthrough</h2>
<h3>The scenario</h3>
<p>${esc(s.title)}. The task, the people and every ID are invented. This page follows ${n} steps, from a human goal to a pull request that a human decides on.</p>
<p class="banner" role="note"><strong>Synthetic data.</strong> This is not a recording of a real run.</p>
<h4 class="legend-h">How to read the markers</h4>
<ul class="legend" role="list">
${Object.keys(KINDS).map((k) => `<li>${badge(k)}</li>`).join('\n')}
</ul>
<p class="legend-note">Every marker has a symbol and a text label; colour is never the only signal.</p>
<noscript><p class="banner" role="note">JavaScript is off. The interactive stepper is not shown. Every step is listed below in full, in order.</p></noscript>

<div class="stepper" id="stepper" data-stepper hidden>
<h3 id="stepper-h">Interactive stepper</h3>
<div class="stepper-bar">
<p class="step-count" id="step-count" data-total="${n}">Step 1 of ${n}</p>
<div class="controls" role="group" aria-label="Walkthrough controls">
<button type="button" class="btn" data-action="prev">Previous</button>
<button type="button" class="btn btn-primary" data-action="next">Next</button>
<button type="button" class="btn" data-action="play" aria-describedby="playback-note"><span aria-hidden="true" data-play-icon>▶</span> <span data-play-label>Play</span></button>
<button type="button" class="btn" data-action="restart">Restart</button>
</div>
<p class="note" id="playback-note"><strong>Demo playback only</strong> — pauses the animation on this page and nothing else.</p>
<p class="note" id="motion-note" hidden>Playback is off because your system asks for reduced motion. Use Previous and Next. The same information is shown as text.</p>
<p class="note">Keyboard: Tab to a button, then Enter or Space. Optional: the Left and Right arrow keys also move between steps while focus is inside this panel.</p>
</div>
<div class="walk">
<div class="diagram" data-kind="${kindOf(first)}" aria-hidden="true">
<div class="stage">
<div class="ring"></div>
<div class="ticket"><span class="ticket-label">Ticket state</span><code data-ticket-state>${esc(first.state)}</code><span class="ticket-decision" data-ticket-decision></span></div>
${slots}
<div class="token slot-0" data-token><span class="token-lines"></span></div>
</div>
<div class="outside" data-outside><span class="outside-title">Outside the demo</span><span>Human merge decision. No control here.</span></div>
</div>
<div class="detail" id="step-detail" tabindex="-1" role="group" aria-label="Current step details"></div>
</div>
<div role="group" aria-label="Jump to a key step">
<ul class="jumps" role="list">
${jump.map(([label, i]) => `<li><button type="button" class="btn btn-small" data-goto="${s.steps[i].id}">${label.replace('%', i + 1)}</button></li>`).join('\n')}
</ul>
</div>
<div role="group" aria-label="All steps">
<ol class="dots">
${dots}
</ol>
</div>
<p class="visually-hidden" id="live" role="status" aria-live="polite" aria-atomic="true"></p>
</div>

<h3 id="all-steps-h">All steps in order</h3>
<details class="all-steps" id="all-steps" open>
<summary>Full text of all ${n} steps</summary>
<ol class="steps" id="step-list" role="list">
${s.steps.map((st, i) => stepItem(s, st, i + 1)).join('\n')}
</ol>
</details>

<h3 id="moments-h">Key moments</h3>
<div class="moments">
${moments(s)}
</div>
</section>

<section id="failures" aria-labelledby="fail-h">
<h2 id="fail-h">When things go wrong</h2>
<p>These branches show what the Chief does. They never say that recovery will succeed.</p>
<table class="grid" role="table">
<caption>Failure branches in the synthetic scenario</caption>
<thead role="rowgroup">
${tr(['ID', 'Trigger', 'What the Chief does', 'Outcome'].map((h) => `<th scope="col" role="columnheader">${h}</th>`).join(''))}
</thead>
<tbody role="rowgroup">
${s.failureRecovery.map((f) => tr(`<th scope="row" role="rowheader" data-label="ID">${esc(f.id)}</th><td role="cell" data-label="Trigger">${esc(f.trigger)}</td><td role="cell" data-label="What the Chief does">${rich(f.handling)}</td><td role="cell" data-label="Outcome">${esc(f.outcome)}</td>`)).join('\n')}
</tbody>
</table>
</section>

<section id="controls" aria-labelledby="ctl-h">
<h2 id="ctl-h">Pause controls</h2>
<p>The first five entries are real controls described by the repository instructions. The last one is a visual control on this page only.</p>
<dl class="defs">
${s.pauseControls.map((p) => {
    const real = p.label === p.label.toLowerCase() && !p.label.includes(' ');
    return `<div class="${p.id === 'p06' ? 'is-demo' : ''}"><dt>${real ? code(p.label) : esc(p.label)}${p.id === 'p06' ? ' <span class="badge badge-wait"><span aria-hidden="true">◐</span> Visual control only</span>' : ''}</dt><dd>${esc(pageText(p))}</dd></div>`;
  }).join('\n')}
</dl>
</section>

<section id="claims" aria-labelledby="claims-h">
<h2 id="claims-h">Implemented today vs planned</h2>
<p>Implemented means written down in the repository as instructions, templates, scripts or CI. It does not mean that a background service exists, and it does not mean the behavior was measured in a live run. Planned rows mark the boundary and are not claims.</p>
<table class="grid" role="table">
<caption>Statements, their status and the repository path that backs them</caption>
<thead role="rowgroup">
${tr(['Statement', 'Status', 'Evidence'].map((h) => `<th scope="col" role="columnheader">${h}</th>`).join(''))}
</thead>
<tbody role="rowgroup">
${s.claims.map((c) => tr(`<th scope="row" role="rowheader" data-label="Statement">${esc(c.text)}</th><td role="cell" data-label="Status">${c.status === 'implemented'
    ? '<span class="badge badge-ok"><span aria-hidden="true">✓</span> Implemented</span>'
    : '<span class="badge badge-wait"><span aria-hidden="true">◌</span> Planned, not claimed</span>'}</td><td role="cell" data-label="Evidence">${c.evidence ? code(c.evidence) : 'No path: planned only'}</td>`, ` class="${c.status}"`)).join('\n')}
</tbody>
</table>
</section>

<section id="limits" aria-labelledby="limits-h">
<h2 id="limits-h">Limits</h2>
<ul class="limits">
${s.limits.map((l) => `<li>${esc(l)}</li>`).join('\n')}
</ul>
</section>

</div>
</main>
<footer class="site-footer">
<div class="wrap">
<p>Synthetic content only. This page has no forms, no cookies and no stored data, and it makes no network requests. Merging and deploying are human decisions outside this page.</p>
<p><a href="#main">Back to the top of the content</a></p>
</div>
</footer>
</body>
</html>
`;
}

/** Returns { 'relative/path': contents } for every generated file. */
export function buildSite() {
  const scenario = JSON.parse(readFileSync(scenarioPath, 'utf8'));
  return { 'index.html': renderHtml(scenario) };
}

function main() {
  const files = buildSite();
  const check = process.argv.includes('--check');
  let stale = 0;
  for (const [name, text] of Object.entries(files)) {
    const path = join(siteDir, name);
    const current = existsSync(path) ? readFileSync(path, 'utf8') : null;
    if (check) {
      if (current !== text) { stale++; console.error(`site/${name} is out of date; run npm run build:site`); }
    } else if (current !== text) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
      console.log(`wrote site/${name}`);
    } else console.log(`site/${name} is up to date`);
  }
  if (stale) process.exitCode = 1;
}

if (isEntry(import.meta.url)) main();
