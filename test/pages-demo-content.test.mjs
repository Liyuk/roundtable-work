import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Content checks for the synthetic Pages demo (docs/pages-demo/). No site code is tested here.

const root = fileURLToPath(new URL('..', import.meta.url));
const demoDir = join(root, 'docs', 'pages-demo');
const paths = {
  outline: join(demoDir, 'content-outline.md'),
  scenario: join(demoDir, 'scenario.json'),
  audit: join(demoDir, 'privacy-audit.md'),
};
const read = (p) => readFileSync(p, 'utf8');
const walk = (dir) => readdirSync(dir, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
const rel = (p) => relative(root, p);
const scenario = () => JSON.parse(read(paths.scenario));

const TICKET_STATES = ['queued', 'assigned', 'working', 'review', 'ready', 'done',
  'waiting_external', 'waiting_person', 'blocked', 'failed', 'cancelled', 'unknown'];
const DECISIONS = ['continue', 'wait', 'ask', 'done', 'stop'];
const isString = (v) => typeof v === 'string' && v.trim().length > 0;

// Forbidden data patterns: real-looking paths, credentials, emails, real repo issue/PR links, any URL.
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

// Phrase rule (simple and strict):
//  * These phrases are availability, recovery or auto-merge promises when stated positively.
//  * scenario.json: only `disclaimer` and `limits[]` strings may contain a phrase, and only if
//    the same string also has a negation word. Every other string (title, steps, failureRecovery,
//    pauseControls, claims) must not contain any of them, negated or not.
//  * Markdown (outline, audit): a phrase is allowed only on a line that also has a negation word.
//    The audit's "Quoted phrases" section lists the phrases themselves and is exempt.
const PROMISE_PHRASES = [/24\/7/i, /24x7/i, /around the clock/i, /always[- ]on/i, /guarantee/i,
  /never fails/i, /auto(?:matic(?:ally)?)?[- ]merge/i, /merges? automatically/i, /self[- ]heal/i];
const NEGATION = /\b(?:not|no|cannot|can't|without|doesn't|isn't|aren't|won't|nor|neither)\b|n't\b/i;

// Machine-contract words that must stay unchanged and in Chinese.
const VERDICT_VALUES = ['通过', '打回', '阻塞'];
const VERDICT_TRIPLE = '审查结论：通过 | 打回 | 阻塞';
const VERDICT_RE = /审查结论：(?:通过 \| 打回 \| 阻塞|通过|打回|阻塞)/g;

test('the three docs exist and nothing else lives in docs/pages-demo', () => {
  for (const p of Object.values(paths)) assert.ok(existsSync(p), `${rel(p)} is missing`);
  const files = walk(demoDir).map((p) => relative(demoDir, p)).sort();
  assert.deepEqual(files, ['content-outline.md', 'privacy-audit.md', 'scenario.json']);
});

test('scenario.json matches the schema', () => {
  const s = scenario();
  assert.equal(s.schemaVersion, 1);
  assert.equal(s.synthetic, true);
  assert.ok(isString(s.title));
  assert.ok(isString(s.disclaimer));
  for (const key of ['actors', 'steps', 'failureRecovery', 'pauseControls', 'claims', 'limits']) {
    assert.ok(Array.isArray(s[key]) && s[key].length > 0, `${key} must be a non-empty array`);
  }

  const actorIds = new Set();
  for (const a of s.actors) {
    assert.ok(isString(a.id) && isString(a.role) && isString(a.displayName), `bad actor ${JSON.stringify(a)}`);
    assert.ok(!actorIds.has(a.id), `duplicate actor ${a.id}`);
    actorIds.add(a.id);
  }
  for (const role of ['human', 'chief', 'developer', 'reviewer']) {
    assert.ok(s.actors.some((a) => a.role === role), `missing role ${role}`);
  }

  const stepIds = new Set();
  for (const st of s.steps) {
    for (const f of ['id', 'actor', 'phase', 'title', 'summary', 'state']) assert.ok(isString(st[f]), `step ${st.id}: ${f}`);
    assert.ok(!stepIds.has(st.id), `duplicate step ${st.id}`);
    stepIds.add(st.id);
    assert.ok(actorIds.has(st.actor), `step ${st.id}: unknown actor ${st.actor}`);
    assert.ok(Array.isArray(st.artifacts) && st.artifacts.length > 0 && st.artifacts.every(isString), `step ${st.id}: artifacts`);
    assert.ok(TICKET_STATES.includes(st.state), `step ${st.id}: state ${st.state}`);
    if (st.gate !== undefined) assert.ok(isString(st.gate.name) && isString(st.gate.result), `step ${st.id}: gate`);
    // Optional extra field added by this slice: the continuation decision shown at this step.
    if (st.decision !== undefined) assert.ok(DECISIONS.includes(st.decision), `step ${st.id}: decision ${st.decision}`);
  }

  const ids = new Set();
  for (const b of s.failureRecovery) {
    assert.ok(isString(b.id) && isString(b.trigger) && isString(b.handling) && isString(b.outcome), `bad branch ${b.id}`);
    assert.ok(!ids.has(b.id), `duplicate branch ${b.id}`);
    ids.add(b.id);
  }
  assert.ok(s.failureRecovery.length >= 5);
  for (const p of s.pauseControls) assert.ok(isString(p.id) && isString(p.label) && isString(p.effect), `bad pause control ${p.id}`);
  assert.ok(s.limits.every(isString));
});

test('the walkthrough covers the required flow, a rejection-then-fix loop and an ask-the-human pause', () => {
  const { steps } = scenario();
  const order = ['goal', 'ticket', 'delegation', 'delivery', 'test-gate', 'scope-gate', 'review', 'commit', 'pull-request', 'human-merge'];
  let at = -1;
  for (const phase of order) {
    const i = steps.findIndex((st, idx) => idx > at && st.phase === phase);
    assert.ok(i > at, `phase ${phase} missing or out of order`);
    at = i;
  }
  const last = steps[steps.length - 1];
  assert.equal(last.phase, 'human-merge');
  assert.equal(scenario().actors.find((a) => a.id === last.actor).role, 'human', 'merge must be a human step');
  assert.ok(!steps.some((st) => st.actor !== last.actor && /merge/.test(st.phase)), 'only the human has a merge phase');

  const rejected = steps.findIndex((st) => st.gate?.name === 'independent review' && st.gate.result.includes('审查结论：打回'));
  const approved = steps.findIndex((st) => st.gate?.name === 'independent review' && st.gate.result.includes('审查结论：通过'));
  assert.ok(rejected >= 0 && approved > rejected, 'rejection must be followed later by an approval');
  assert.ok(steps.slice(rejected + 1, approved).some((st) => st.phase === 'rework'), 'a rework step must sit between them');
  assert.ok(steps.some((st) => st.decision === 'ask' && st.state === 'waiting_person'), 'an ask-the-human pause is required');
  for (const st of steps.filter((x) => x.gate && /gate$/.test(x.gate.name))) {
    assert.ok(['pass', 'fail'].includes(st.gate.result), `step ${st.id}: gate result`);
  }
});

test('every claim is implemented or planned, and implemented claims point to real repo paths', () => {
  const { claims } = scenario();
  const ids = new Set();
  for (const c of claims) {
    assert.ok(isString(c.id) && isString(c.text), `bad claim ${c.id}`);
    assert.ok(!ids.has(c.id), `duplicate claim ${c.id}`);
    ids.add(c.id);
    assert.ok(['implemented', 'planned'].includes(c.status), `claim ${c.id}: status ${c.status}`);
    // Optional extra field added by this slice: repo-relative evidence path for implemented claims.
    if (c.status === 'implemented') {
      assert.ok(isString(c.evidence), `claim ${c.id}: implemented claims need evidence`);
      assert.ok(!isAbsolute(c.evidence) && !c.evidence.includes('..'), `claim ${c.id}: evidence must be repo-relative`);
      assert.ok(existsSync(join(root, c.evidence)), `claim ${c.id}: evidence path ${c.evidence} does not exist`);
    }
  }
  assert.ok(claims.some((c) => c.status === 'planned'));
});

test('the outline has the required sections and a table whose evidence paths exist', () => {
  const text = read(paths.outline);
  for (const h of [/^## .*Audience/m, /architecture/i, /^## .*Failure and recovery/m, /^## .*Pause controls/m,
    /^## .*Limits/m, /^## .*Implemented today vs planned/m]) {
    assert.match(text, h);
  }
  for (const w of ['Chief', 'developer', 'test gate', 'scope gate', 'reviewer', 'pull request', 'human']) {
    assert.ok(text.includes(w), `outline should mention ${w}`);
  }
  assert.ok(/prefers-reduced-motion/.test(text), 'outline must state the reduced-motion requirement');

  const section = text.split(/^## /m).find((s) => s.startsWith('9. Implemented today vs planned'));
  assert.ok(section, 'implemented-vs-planned section not found');
  const rows = section.split('\n').filter((l) => l.startsWith('|')).slice(2);
  assert.ok(rows.length >= 10, 'expected the table to have rows');
  let implemented = 0;
  for (const row of rows) {
    const cells = row.split('|').slice(1, -1).map((c) => c.trim());
    assert.equal(cells.length, 3, `row should have 3 cells: ${row}`);
    assert.match(cells[1], /^(Implemented|Planned|Not implemented; not claimed)/, `row status: ${row}`);
    const evidence = [...cells[2].matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    assert.ok(evidence.length > 0, `row without evidence path: ${row}`);
    for (const p of evidence) assert.ok(existsSync(join(root, p)), `evidence path does not exist: ${p}`);
    if (cells[1].startsWith('Implemented')) implemented++;
  }
  assert.ok(implemented >= 5);
  assert.ok(rows.some((r) => /\|\s*Not implemented; not claimed\s*\|/.test(r)), 'a "Not implemented; not claimed" row is required');
});

test('privacy audit has a checklist with commands, exit codes and a claims audit', () => {
  const text = read(paths.audit);
  for (const h of [/^## .*Checklist/m, /^## .*Claims audit/m, /^## .*Quoted phrases/m, /^## .*Limits of this audit/m]) assert.match(text, h);
  assert.match(text, /```/);
  assert.match(text, /Exit code/i);
});

test('no forbidden data patterns appear anywhere under docs/pages-demo', () => {
  const files = walk(demoDir);
  assert.ok(files.length >= 3);
  for (const file of files) {
    const lines = read(file).split('\n');
    for (const [name, re] of FORBIDDEN_DATA) {
      lines.forEach((line, i) => assert.ok(!re.test(line), `${rel(file)}:${i + 1} matches forbidden pattern "${name}"`));
    }
  }
  // Scenario data must not reference real issue or PR numbers either.
  assert.doesNotMatch(read(paths.scenario), /#\d+/);
});

test('scenario ids and references are clearly synthetic', () => {
  const text = read(paths.scenario);
  assert.match(text, /DEMO-001/);
  assert.match(text, /DEMO-PR-1/);
  assert.ok(scenario().synthetic === true);
  assert.doesNotMatch(text, /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, 'no real-looking timestamps');
});

function stringsOf(value, path = '$') {
  if (typeof value === 'string') return [[path, value]];
  if (Array.isArray(value)) return value.flatMap((v, i) => stringsOf(v, `${path}[${i}]`));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => stringsOf(v, `${path}.${k}`));
  return [];
}

test('no availability or recovery promises (see the phrase rule at the top of this file)', () => {
  const s = scenario();
  const relaxed = new Set(['$.disclaimer']);
  for (const [path, str] of stringsOf(s)) {
    const hit = PROMISE_PHRASES.find((re) => re.test(str));
    if (!hit) continue;
    const allowed = (relaxed.has(path) || path.startsWith('$.limits[')) && NEGATION.test(str);
    assert.ok(allowed, `scenario.json ${path} uses a promise phrase (${hit}) outside a negated disclaimer or limit`);
  }
  for (const file of [paths.outline, paths.audit]) {
    let inQuoted = false;
    read(file).split('\n').forEach((line, i) => {
      if (/^## /.test(line)) inQuoted = file === paths.audit && /^## .*Quoted phrases/.test(line);
      if (inQuoted) return;
      const hit = PROMISE_PHRASES.find((re) => re.test(line));
      if (hit) assert.ok(NEGATION.test(line), `${rel(file)}:${i + 1} uses a promise phrase (${hit}) without a negation`);
    });
  }
});

test('machine-contract words are preserved exactly and all other text is English', () => {
  for (const file of walk(demoDir)) {
    const text = read(file);
    // Every use of the verdict prefix must be followed by an exact value (or the exact triple).
    const prefixes = text.match(/审查结论/g) ?? [];
    const exact = text.match(VERDICT_RE) ?? [];
    assert.equal(prefixes.length, exact.length, `${rel(file)}: 审查结论 used with a changed or translated value`);
    for (const m of exact) assert.ok(m === VERDICT_TRIPLE || VERDICT_VALUES.some((v) => m === `审查结论：${v}`));
    // After removing the frozen words there must be no CJK characters left.
    const rest = text.replace(VERDICT_RE, '');
    assert.doesNotMatch(rest, /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]/, `${rel(file)}: non-English text outside the frozen words`);
  }
  const text = read(paths.scenario);
  assert.ok(text.includes('审查结论：打回') && text.includes('审查结论：通过'));
  assert.ok(read(paths.outline).includes(VERDICT_TRIPLE));
});
