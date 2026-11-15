// Builds site/index.html from two sources:
//   * docs/architecture.md: the machine-readable module-status block (and the three tier nodes of its
//     diagram) drive the architecture diagram, the module table and every status label;
//   * docs/pages-demo/scenario.json: the single source for every step, table row and limit of the
//     synthetic single-ticket walkthrough.
//
//   node scripts/build-site.mjs          write the generated files into site/
//   node scripts/build-site.mjs --check  exit 1 if site/ differs from a fresh build (no writes)
//
// No dependencies. The build fails when a module in the architecture doc has no authored description or
// layout slot (or the other way round), so the page cannot silently drift from the document.
// site/styles.css and site/app.js are hand-written static assets.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntry } from './entry.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const scenarioPath = join(root, 'docs', 'pages-demo', 'scenario.json');
const architecturePath = join(root, 'docs', 'architecture.md');
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

// ---------------------------------------------------------------------------------------------
// Architecture data: read from docs/architecture.md, never copied by hand.
// ---------------------------------------------------------------------------------------------

export const MODULE_STATUSES = ['implemented', 'partial', 'library-only', 'missing'];
// Status labels and meanings follow the legend of docs/architecture.md. Every status also has a glyph and a
// text label, so colour is never the only signal.
const STATUS = {
  implemented: { glyph: '●', label: 'Implemented', meaning: 'Built and on the live path.' },
  partial: { glyph: '◐', label: 'Partial', meaning: 'Some of it is built; the rest is open work.' },
  'library-only': { glyph: '◇', label: 'Library only', meaning: 'A library with tests that the daemon and the host loop do not call yet.' },
  missing: { glyph: '○', label: 'Missing', meaning: 'Not built yet.' },
};
const MERMAID_CLASS = { impl: 'implemented', partial: 'partial', lib: 'library-only', missing: 'missing' };
const statusChip = (status) => `<span class="status st-${status}"><span aria-hidden="true">${STATUS[status].glyph}</span> ${STATUS[status].label}</span>`;

/** Parses the `rt:module-status` JSON block of docs/architecture.md. Throws when it is missing or malformed. */
export function parseModuleStatus(doc) {
  const match = /<!-- rt:module-status -->\n```json\n([\s\S]*?)```/.exec(doc);
  if (!match) throw new Error('docs/architecture.md has no rt:module-status block');
  const modules = JSON.parse(match[1]);
  const seen = new Set();
  for (const m of modules) {
    if (typeof m.id !== 'string' || !m.id || seen.has(m.id)) throw new Error(`module-status: bad or duplicate id ${m.id}`);
    seen.add(m.id);
    if (typeof m.name !== 'string' || !m.name) throw new Error(`module-status: ${m.id} has no name`);
    if (!MODULE_STATUSES.includes(m.status)) throw new Error(`module-status: ${m.id} has status ${m.status}`);
    if (!Array.isArray(m.code) || !m.code.every((c) => typeof c === 'string')) throw new Error(`module-status: ${m.id} code`);
    if (!Array.isArray(m.issues) || !m.issues.every(Number.isInteger)) throw new Error(`module-status: ${m.id} issues`);
  }
  return modules;
}

/** Status of the three completion-tier nodes (T1 to T3) from the Mermaid diagram of the same document. */
export function parseTierStatus(doc) {
  const chart = /```mermaid\n([\s\S]*?)```/.exec(doc)?.[1] ?? '';
  const out = {};
  for (const [n, tier] of [['T1', 'auto-silent'], ['T2', 'auto-notify'], ['T3', 'approve-first']]) {
    const m = new RegExp(`^\\s*${n}\\["[^"]*"\\]:::(\\w+)\\s*$`, 'm').exec(chart);
    if (!m || !MERMAID_CLASS[m[1]]) throw new Error(`docs/architecture.md: cannot read the status of tier node ${n}`);
    out[tier] = MERMAID_CLASS[m[1]];
  }
  return out;
}

// Layout: which lane shows which module. Every module id of the document must appear exactly once.
const LANES = [
  { key: 'intake', title: 'Intake', ids: ['intake-requirements', 'intake-feedback', 'intake-webhook', 'intake-decision-chain', 'intake-intervention'] },
  { key: 'wake', title: 'Inbox and timers', ids: ['inbox', 'timers'] },
  { key: 'pipeline', title: 'One ticket, one pipeline', ordered: true, ids: ['pipeline-design', 'pipeline-plan', 'pipeline-decompose', 'pipeline-execute', 'pipeline-review', 'pipeline-e2e', 'pipeline-accept'] },
  { key: 'decide', title: 'Completion and approval', ids: ['merge-tiers', 'approval-realtime', 'approval-deferred'] },
  { key: 'deliver', title: 'Outbox', ids: ['outbox', 'outbox-im'] },
  { key: 'run', title: 'Concurrent queue, monitoring and dynamic scheduling', wide: true, ids: ['scheduler', 'monitoring', 'memory', 'daemon'] },
];
const LINKS = ['Events', 'Wakes', 'Done', 'Sends']; // arrow labels between lane 1-2, 2-3, 3-4, 4-5

// Authored one-or-two-sentence descriptions, restating docs/architecture.md. Keyed by module id.
const DESCRIPTIONS = {
  'intake-requirements': 'The front Chief turns a conversation into an issue with a goal and acceptance, through the intake backlog.',
  'intake-feedback': 'Plugins that turn feedback from X, Discord and GitHub into inbox events. Open work.',
  'intake-webhook': 'A listener that passes signed webhooks to the verifier and writes inbox events. The HTTP listener itself is new work.',
  'intake-decision-chain': 'Decides how a line continues after each turn and follows up on its own decisions.',
  'intake-intervention': 'Human commands such as /rt and owner comments enter as events. Merging stays refused as a command.',
  inbox: 'A durable, de-duplicated, replayable record of what happened, and the only path that wakes or resumes a line. The daemon does not call it yet.',
  timers: 'Every \u201Cdo this later\u201D is a due timer that writes an inbox event, so no process sleeps for a business reason.',
  'pipeline-design': 'Turns a request into a goal with numbered acceptance. Admission refuses a body that lacks a goal, acceptance, scope limits, dependencies or a size estimate.',
  'pipeline-plan': 'A technical plan written before execution. No plan artifact exists yet.',
  'pipeline-decompose': 'Splits oversized work into sized children with dependencies, on size, acceptance-count and risk triggers.',
  'pipeline-execute': 'Workers run the task in its own git worktree through a harness adapter.',
  'pipeline-review': 'Gates 0, 1 and 2, run only on a clean committed head. Follow-ups are created only for in-scope high or critical findings.',
  'pipeline-e2e': 'An optional end-to-end command run on the final head after review. Today only the acceptance commands run.',
  'pipeline-accept': 'Checks acceptance, closes finished parents and handles aftercare.',
  'merge-tiers': 'Decides per change whether to act silently, act and notify, or ask first. Approval for safety files exists today; the tier function is specified, not built.',
  outbox: 'Every outward side effect is first an outbox item, then delivered by a dispatcher. A tested library; GitHub writes still go through a host shim.',
  'outbox-im': 'Adapters that route notices to chat channels through fixed templates and an allow-list. Not built.',
  'approval-realtime': 'Approve-first: the action is not performed and only that line is suspended. The owner\u2019s reply returns as an event and resumes the same session.',
  'approval-deferred': 'Execute by default: act now with the default plan, record it in an action journal, then let the owner confirm, amend or roll back. The journal does not exist yet.',
  scheduler: 'Runs eligible issues in parallel with per-issue locks, dependency and touch-set checks, and an adaptive worker cap. The series suffix rule is still missing in the runtime.',
  monitoring: 'Supervisor, stall signals, diagnosis and a usage ledger, so \u201Cwhy did it do that\u201D can be answered from files.',
  memory: 'Preloads active rules and a short index into each role prompt and records lessons. A tested library that the daemon does not call yet.',
  daemon: 'One cycle that fires timers, drains the inbox, schedules work, flushes the outbox and waits. Today the daemon runs a single pass and exits.',
};

// Checks that the document, the layout and the descriptions describe exactly the same set of modules.
function validateArchitecture(modules) {
  const ids = modules.map((m) => m.id);
  const laid = LANES.flatMap((l) => l.ids);
  const diff = (a, b) => a.filter((x) => !b.includes(x));
  for (const [label, list] of [['layout', laid], ['description', Object.keys(DESCRIPTIONS)]]) {
    const missing = diff(ids, list);
    const extra = diff(list, ids);
    if (missing.length) throw new Error(`docs/architecture.md modules without a ${label} in build-site.mjs: ${missing.join(', ')}`);
    if (extra.length) throw new Error(`build-site.mjs has a ${label} for modules that are not in docs/architecture.md: ${extra.join(', ')}`);
  }
  if (new Set(laid).size !== laid.length) throw new Error('a module appears twice in the layout');
}

const PREFIX = /^(Intake|Pipeline|Approval|Outbox): /;
function nameHtml(name) {
  const m = PREFIX.exec(name);
  // The lane title already says "Intake" or "Pipeline", so the prefix is hidden visually but stays in the text.
  // The visible part starts with a capital letter through CSS only, so the text equals the name in the document.
  return m ? `<span class="mod-prefix visually-hidden">${esc(m[0])}</span><span class="mod-label">${esc(name.slice(m[0].length))}</span>` : esc(name);
}
const issuesText = (issues) => (issues.length ? issues.map((n) => `#${n}`).join(', ') : 'None recorded');
// A <wbr> after each slash lets a long path wrap at a directory boundary instead of in the middle of a name.
const codeList = (paths) => (paths.length ? `<ul class="paths" role="list">${paths.map((p) => `<li><code>${esc(p).replace(/\//g, '/<wbr>')}</code></li>`).join('')}</ul>` : 'No code yet');

function modButton(m) {
  return `<button type="button" class="mod" data-module="${esc(m.id)}" data-status="${m.status}" aria-expanded="false" aria-controls="module-panel">
<span class="mod-name">${nameHtml(m.name)}</span>
<span class="mod-status ${`st-${m.status}`}"><span aria-hidden="true">${STATUS[m.status].glyph}</span> ${STATUS[m.status].label}</span>
</button>`;
}

function laneHtml(lane, index, byId, tiers) {
  const items = lane.ids.map((id) => {
    const extra = id === 'merge-tiers'
      ? `\n<ul class="chips" role="list" aria-label="The three completion tiers">${Object.entries(tiers).map(([t, st]) => `<li class="st-${st}"><span aria-hidden="true">${STATUS[st].glyph}</span> ${code(t)} <span class="visually-hidden">(${STATUS[st].label})</span></li>`).join('')}</ul>` : '';
    return `<li>${modButton(byId[id])}${extra}</li>`;
  }).join('\n');
  const headingId = `lane-${lane.key}-h`;
  const no = lane.wide ? '' : `<span class="lane-no" aria-hidden="true">${index + 1}</span> `;
  const note = lane.key === 'pipeline' ? '\n<p class="lane-note">Review and e2e can send work back to execution.</p>' : '';
  return `<div class="lane lane-${lane.key}${lane.wide ? ' lane-wide' : ''}" role="group" aria-labelledby="${headingId}">
<h3 class="lane-title" id="${headingId}">${no}${esc(lane.title)}</h3>
<${lane.ordered ? 'ol' : 'ul'} class="mods${lane.ordered ? ' mods-ordered' : ''}" role="list">
${items}
</${lane.ordered ? 'ol' : 'ul'}>${note}
</div>`;
}

function moduleRow(m) {
  return `<tr role="row" data-module="${esc(m.id)}" data-status="${m.status}"><th scope="row" role="rowheader" data-label="Module">${esc(m.name)}</th><td role="cell" data-label="Status">${statusChip(m.status)}</td><td role="cell" data-label="What it does">${esc(DESCRIPTIONS[m.id])}</td><td role="cell" data-label="Code">${codeList(m.code)}</td><td role="cell" data-label="Issues">${esc(issuesText(m.issues))}</td></tr>`;
}

function architectureSection(modules, tiers) {
  const byId = Object.fromEntries(modules.map((m) => [m.id, m]));
  const counts = Object.fromEntries(MODULE_STATUSES.map((st) => [st, modules.filter((m) => m.status === st).length]));
  const legend = MODULE_STATUSES.map((st) => `<li>${statusChip(st)} <span>${counts[st]}</span></li>`).join('\n');
  const key = MODULE_STATUSES.map((st) => `<li class="key-item st-${st}">${statusChip(st)} <span class="key-count">${counts[st]} of ${modules.length}</span> <span class="key-meaning">${esc(STATUS[st].meaning)}</span></li>`).join('\n');
  const main = LANES.filter((l) => !l.wide);
  const lanes = main.map((l, i) => laneHtml(l, i, byId, tiers) + (i < main.length - 1 ? `\n<div class="link" aria-hidden="true"><span class="link-label">${LINKS[i]}</span><span class="link-arrow"></span></div>` : '')).join('\n');
  const wide = laneHtml(LANES.find((l) => l.wide), 0, byId, tiers);
  return `<section id="architecture" aria-labelledby="arch-h">
<div class="arch-head">
<h2 id="arch-h">How the loop is built</h2>
<ul class="legend-row" role="list" aria-label="Number of modules per status">
${legend}
</ul>
</div>
<noscript><p class="banner" role="note">JavaScript is off. The diagram is still shown, but selecting a module needs JavaScript. Every module is described in the table below the diagram.</p></noscript>
<p class="arch-hint">Select a module to see what it does, how far it is built, and where its code lives. Everything that happens becomes an event; an event wakes one line; the line runs a short pipeline; a completion tier decides how it ends.</p>
<div class="arch" data-arch>
<div class="lanes">
${lanes}
<p class="return"><span>Owner replies and approvals come back to the inbox as events.</span></p>
</div>
${wide}
<div class="panel-slot" id="panel-slot">
<div class="panel" id="module-panel" hidden></div>
</div>
<p class="visually-hidden" id="arch-live" role="status" aria-live="polite" aria-atomic="true"></p>
</div>
<details class="module-index" id="module-index" open>
<summary>All ${modules.length} modules as a table</summary>
<ul class="key" role="list" aria-label="Status key">
${key}
</ul>
<table class="grid" role="table" data-modules>
<caption>Module status, read from docs/architecture.md</caption>
<thead role="rowgroup">
<tr role="row">${['Module', 'Status', 'What it does', 'Code', 'Issues'].map((h) => `<th scope="col" role="columnheader">${h}</th>`).join('')}</tr>
</thead>
<tbody role="rowgroup">
${modules.map(moduleRow).join('\n')}
</tbody>
</table>
</details>
</section>`;
}

const CONSTRAINTS = [
  ['Small steps', 'Admission refuses a ticket over 400 lines or 5 files and asks for decomposition. One run advances one pipeline stage.', 'runtime/lib/intake.mjs'],
  ['Structured output only', 'A run ends in a validated object: a continuation decision, a verdict token, an approve or reject token, or a decision card with closed fields. Free text never drives a transition.', 'runtime/lib/machine.mjs'],
  ['Deterministic gates', 'Gates, acceptance, diff checks, risk and tier are plain code over facts. A model can fail them but cannot waive them.', 'runtime/lib/gates.mjs'],
  ['Idempotency everywhere', 'Every effect has a key: an inbox event id, an outbox item id, a merge ledger entry, an action id. A replayed cycle repeats nothing.', 'runtime/lib/outbox.mjs'],
  ['Budgets and timeouts', 'Per-issue budgets, phase timeouts and a lock lease bound each run. Quota and provider failures do not spend them.', 'runtime/lib/budget.mjs'],
  ['No credentials in the agent', 'Children get no GitHub credentials. Writes go through a proxy that refuses merge, close, force push and pushes to main.', 'runtime/lib/gh-write-proxy.mjs'],
];

const TIER_TEXT = {
  'auto-silent': { lead: 'Act now and say nothing.', rows: [['Acts now', 'Yes'], ['Action journal', 'Settled immediately'], ['Outbox', 'Nothing'], ['Approval mode', 'None']], when: 'A low-risk change that only touches silent paths such as docs and tests.' },
  'auto-notify': { lead: 'Act now with the default plan, then tell the owner.', rows: [['Acts now', 'Yes, with the default plan'], ['Action journal', 'Executed, pending confirmation'], ['Outbox', 'Action-pending-confirmation notice'], ['Approval mode', 'Deferred']], when: 'The default for everything in scope that is not silent, for example a medium-risk runtime change.' },
  'approve-first': { lead: 'Do not act. Ask, and wait for the answer.', rows: [['Acts now', 'No'], ['Action journal', 'Awaiting approval'], ['Outbox', 'Approval request'], ['Approval mode', 'Real-time']], when: 'Safety files, closed ask categories, production changes, irreversible actions and high risk.' },
};
const TIER_RULES = [
  'The kind of action is not on the allow-list.',
  'The category is a closed ask category, or the change touches production.',
  'The action cannot be reverted.',
  'The change touches a safety file such as hooks, CI workflows or limits.',
  'The owner override label is set.',
  'The risk is high.',
  'The kind and every path are on the silent lists and the risk is low: act silently.',
  'Anything else: act and notify.',
];

function tiersSection(tiers) {
  const cards = Object.entries(TIER_TEXT).map(([tier, t]) => `<li class="card tier tier-${tier}">
<h3>${code(tier)}</h3>
<p>${statusChip(tiers[tier])}</p>
<p class="tier-lead">${esc(t.lead)}</p>
<dl class="facts-grid">
${t.rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('\n')}
</dl>
<p class="tier-when"><strong>Typical case.</strong> ${esc(t.when)}</p>
</li>`).join('\n');
  return `<section id="tiers" aria-labelledby="tiers-h">
<h2 id="tiers-h">Three completion tiers</h2>
<p class="section-lead">A finished change is not always merged the same way. A pure function over the facts of the change picks one of three tiers. The first matching rule wins, and the function is plain code over facts, not a model\u2019s judgement.</p>
<ul class="cards cards-3" role="list">
${cards}
</ul>
<h3>How the tier is chosen</h3>
<p>The first rule that matches decides. Rules 1 to 6 all lead to <code>approve-first</code>.</p>
<ol class="rules">
${TIER_RULES.map((r) => `<li>${esc(r)}</li>`).join('\n')}
</ol>
<p class="callout"><strong>Fixed by design.</strong> No configuration can move a safety-file change out of <code>approve-first</code>, and a revert PR is never <code>auto-silent</code>. The tier function is specified in the architecture document and is not built yet; only the approval path for safety files exists today.</p>
</section>`;
}

function executeSection(byId) {
  const real = byId['approval-realtime'];
  const def = byId['approval-deferred'];
  return `<section id="execute" aria-labelledby="execute-h">
<h2 id="execute-h">Execute by default, then confirm, amend or roll back</h2>
<p class="section-lead">Waiting for a human on every routine decision stalls a 7x24 loop. Inside the autonomous scope the loop acts first with a recorded default plan and lets the owner correct it later. Outside the scope it asks first.</p>
<div class="compare">
<article class="card" aria-labelledby="mode-real-h">
<h3 id="mode-real-h">Real-time approval</h3>
<p>${statusChip(real.status)} <span class="muted">Tier <code>approve-first</code></span></p>
<p>The action is not performed. Only that line is suspended and other lines keep running. An approval request goes to the outbox. The owner\u2019s reply arrives as an inbox event and resumes the same session.</p>
</article>
<article class="card" aria-labelledby="mode-def-h">
<h3 id="mode-def-h">Deferred approval</h3>
<p>${statusChip(def.status)} <span class="muted">Tier <code>auto-notify</code></span></p>
<p>The action is performed now with the default plan and written to an append-only action journal before it runs. A notice says what was done. The owner can confirm, amend or roll back later.</p>
</article>
</div>
<h3>What the owner can do after the fact</h3>
<ol class="journey">
<li><strong>Act now.</strong> The default plan runs and the journal records it, with what a revert would need.</li>
<li><strong>Pending confirmation.</strong> One notice goes out. Nothing else changes.</li>
<li><strong>Owner decides.</strong> Three replies are possible, each an inbox event.</li>
</ol>
<ul class="cards cards-3" role="list">
<li class="card"><h4>Confirm</h4><p>The action is settled. No GitHub or file change and no further notice.</p></li>
<li class="card"><h4>Amend</h4><p>The line re-enters execution with the owner\u2019s text. A merged change is amended by a follow-up PR, never by rewriting history.</p></li>
<li class="card"><h4>Roll back</h4><p>The recorded revert steps run in order, each one idempotent. If a step fails the line is held and the owner is asked.</p></li>
</ul>
<p class="callout"><strong>Planned, not built.</strong> The action journal and the owner replies (<code>/rt confirm</code>, <code>/rt amend</code>, <code>/rt rollback</code>) are open work. If no revert recipe can be built, the action is irreversible and the tier is <code>approve-first</code>. A pending action that is never answered expires after a time limit and is reported in a digest. It is never reverted on its own.</p>
</section>`;
}

const PHASES = [
  ['Wire the libraries into the repository', 'Cycle loop, inbox, timers, outbox, memory and decision cards, each merged on its own with fake providers. Nothing changes on the host.'],
  ['Shadow next to the host', 'The owner runs the daemon without live mode beside the host loop and compares its decisions with the host\u2019s for at least 48 hours.'],
  ['Live with one worker', 'Owner-only steps: stop the host scheduler, then start the daemon in live mode with a single worker. The two loops are never live together.'],
  ['Ramp', 'Raise the worker cap over days. The cap goes down by itself during clusters of host freezes.'],
];

function productionSection(modules) {
  const counts = Object.fromEntries(MODULE_STATUSES.map((st) => [st, modules.filter((m) => m.status === st).length]));
  return `<section id="production" aria-labelledby="prod-h">
<h2 id="prod-h">Where production runs today</h2>
<p class="callout callout-strong"><strong>The cutover is not done.</strong> Production still runs on the host scripts <code>rt-sched.py</code> and <code>rt-work.sh</code>, which are not part of this repository. They poll GitHub every 300 seconds and run several workers.</p>
<div class="compare">
<article class="card" aria-labelledby="prod-host-h">
<h3 id="prod-host-h">Live path</h3>
<p>The host scripts claim, execute, review and merge issues. The runtime in this repository is exercised by tests. Its daemon runs in shadow mode by default, without the live flag, and its service unit is an uninstalled template.</p>
</article>
<article class="card" aria-labelledby="prod-lib-h">
<h3 id="prod-lib-h">Libraries being wired in</h3>
<p>The inbox, timers, outbox, memory, decision cards and liveness libraries exist with tests. <code>runtime/rtd.mjs</code> imports none of them yet and runs one pass instead of a loop. Wiring them in is the work tracked under #374.</p>
</article>
</div>
<p>Across the ${modules.length} modules: ${MODULE_STATUSES.map((st) => `${counts[st]} ${STATUS[st].label.toLowerCase()}`).join(', ')}.</p>
<h3>Cutover plan</h3>
<p>Four phases. Nothing changes on the host until phase 3, which is an owner-only step.</p>
<ol class="phases">
${PHASES.map(([t, d]) => `<li class="card"><h4>${esc(t)}</h4><p>${esc(d)}</p></li>`).join('\n')}
</ol>
<p>Rollback is to stop the daemon or remove live mode and restart the host scheduler. GitHub labels are the shared state, so issues the daemon left running are requeued first.</p>
</section>`;
}

const NAV = [['architecture', 'Architecture'], ['constraints', 'Why constrained'], ['tiers', 'Tiers'], ['execute', 'Execute by default'],
  ['production', 'Production today'], ['walkthrough', 'Walkthrough (synthetic)']];

function constraintsSection() {
  return `<section id="constraints" aria-labelledby="cons-h">
<h2 id="cons-h">Why the loop is constrained</h2>
<p class="section-lead">A weak model is not trusted to be careful. Each constraint is a mechanism in code or in the loop, not advice in a prompt, so a bad output costs one retry and never a bad merge.</p>
<ul class="cards cards-3" role="list">
${CONSTRAINTS.map(([t, d, p]) => `<li class="card"><h3>${esc(t)}</h3><p>${esc(d)}</p><p class="where">Code: ${code(p)}</p></li>`).join('\n')}
</ul>
</section>`;
}

// ---------------------------------------------------------------------------------------------
// The synthetic single-ticket walkthrough (generated from docs/pages-demo/scenario.json).
// ---------------------------------------------------------------------------------------------

function walkthroughSection(s) {
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
<h4>${esc(a.displayName)}</h4>
<p class="role-tag">Role: ${code(a.role)}</p>
<p>${esc(ROLE_TEXT[a.role] ?? '')}</p>${a.role === 'reviewer' ? `
<p>The first line of its card is the verdict: <span class="contract" lang="zh-Hans">${VERDICT_TRIPLE}</span> (approved | rejected | blocked).</p>` : ''}
</li>`).join('\n');
  const tr = (cells, attrs = '') => `<tr role="row"${attrs}>${cells}</tr>`;

  return `<section id="walkthrough" aria-labelledby="walk-h">
<h2 id="walk-h">A single ticket walkthrough</h2>
<p class="section-lead">The sections above describe the system. This one follows a single invented ticket through the roles of the Roundtable Work skill: a human sets the goal, a Chief coordinates, executors do the work, checks and an independent review follow, and a human decides on the merge.</p>
<p class="banner" role="note"><strong>Synthetic data.</strong> ${esc(s.disclaimer)}</p>

<h3>The flow at a glance</h3>
<p>Text first: nine stages, in order.</p>
<ol class="flow">
${FLOW.map((f) => `<li>${esc(f)}</li>`).join('\n')}
</ol>
<p>Checks before review are called the <em>test gate</em> and the <em>scope gate</em> in this walkthrough. They are instructions that an agent follows, not an automated enforcement engine. Independent review means a separate session judges the delivery. Its verdict line is <span class="contract" lang="zh-Hans">${VERDICT_TRIPLE}</span> (approved | rejected | blocked).</p>

<h3>How every Chief turn ends</h3>
<p>Each turn ends with exactly one continuation decision.</p>
<dl class="defs">
${Object.entries(DECISION_TEXT).map(([k, v]) => `<div><dt>${code(k)}</dt><dd>${esc(v)}</dd></div>`).join('\n')}
</dl>

<h3>Roles</h3>
<p>A role is not a model. A separate session gives a fresh viewpoint, but a different model or name is not proof of quality.</p>
<ul class="roles" role="list">
${roleCards}
</ul>

<h3>The scenario</h3>
<p>${esc(s.title)}. The task, the people and every ID are invented. This section follows ${n} steps, from a human goal to a pull request that a human decides on.</p>
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

<h3 id="fail-h">When things go wrong</h3>
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

<h3 id="ctl-h">Pause controls</h3>
<p>The first five entries are real controls described by the repository instructions. The last one is a visual control on this page only.</p>
<dl class="defs">
${s.pauseControls.map((p) => {
    const real = p.label === p.label.toLowerCase() && !p.label.includes(' ');
    return `<div class="${p.id === 'p06' ? 'is-demo' : ''}"><dt>${real ? code(p.label) : esc(p.label)}${p.id === 'p06' ? ' <span class="badge badge-wait"><span aria-hidden="true">◐</span> Visual control only</span>' : ''}</dt><dd>${esc(pageText(p))}</dd></div>`;
  }).join('\n')}
</dl>

<h3 id="claims-h">Walkthrough claims: implemented vs planned</h3>
<p>Implemented means written down in the repository as instructions, templates, scripts or CI. It does not mean that a background service exists, and it does not mean the behavior was measured in a live run. Planned rows mark the boundary and are not claims. For the status of the system modules, see the architecture table above.</p>
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

<h3 id="limits-h">Limits</h3>
<ul class="limits">
${s.limits.map((l) => `<li>${esc(l)}</li>`).join('\n')}
</ul>
</section>`;
}

// ---------------------------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------------------------

function renderHtml(s, doc) {
  const modules = parseModuleStatus(doc);
  const tiers = parseTierStatus(doc);
  validateArchitecture(modules);
  const byId = Object.fromEntries(modules.map((m) => [m.id, m]));

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self'; script-src 'self'; img-src data:; base-uri 'none'; form-action 'none'">
<title>Roundtable Work: architecture of a constrained agent loop</title>
<meta name="description" content="The architecture of Roundtable Work: events wake a constrained loop that a weak model can run, with completion tiers, execute-by-default approval and the real status of every module.">
<link rel="icon" href="data:,">
<link rel="stylesheet" href="styles.css">
<script src="app.js" defer></script>
</head>
<body>
<a class="skip-link" href="#main">Skip to main content</a>
<header class="site-header">
<div class="wrap">
<div class="topbar">
<p class="brand">Roundtable Work</p>
<nav aria-label="Page sections">
<ul class="nav-list">
${NAV.map(([id, label]) => `<li><a href="#${id}">${label}</a></li>`).join('\n')}
</ul>
</nav>
</div>
<div class="hero">
<h1>A constrained loop for agents that sleep and wake</h1>
<div>
<p class="lead">&ldquo;Always-on&rdquo; is a user experience, not a process that never rests: the agent sleeps and wakes when an event arrives or a timer is due. This repository is the constrained loop behind that experience. Small recorded steps, validated outputs and deterministic gates are designed so that a weak, Haiku-class model can run a stable 7x24 workflow.</p>
<p class="status-note"><strong>Status.</strong> This is the target architecture. Production still runs on host scripts while the libraries are wired into the daemon; the cutover is not done. Every module below shows its real status.</p>
</div>
</div>
</div>
</header>
<main id="main" tabindex="-1">
<div class="wrap">

${architectureSection(modules, tiers)}

${constraintsSection()}

${tiersSection(tiers)}

${executeSection(byId)}

${productionSection(modules)}

${walkthroughSection(s)}

</div>
</main>
<footer class="site-footer">
<div class="wrap">
<p>This page has no forms, no cookies and no stored data, and it makes no network requests. The walkthrough uses synthetic data only. No control on this page performs a merge, a deploy or any other privileged action.</p>
<p><a href="#main">Back to the top of the content</a></p>
</div>
</footer>
</body>
</html>
`;
}

/** Returns { 'relative/path': contents } for every generated file. Sources can be injected for tests. */
export function buildSite(sources = {}) {
  const scenario = sources.scenario ?? JSON.parse(readFileSync(scenarioPath, 'utf8'));
  const doc = sources.architecture ?? readFileSync(architecturePath, 'utf8');
  return { 'index.html': renderHtml(scenario, doc) };
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
