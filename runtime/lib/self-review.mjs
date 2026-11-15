import { createHash } from 'node:crypto';

// Self-review proposals (RT-S8a, docs/self-supervision.md "Self-review job"). Pure: every input is data, `now` is the only clock.
const DAY = 86_400_000;
const LOW_RISK = ['T1', 'T2', 'T5'];
const BREACH = {
  mtbiHours: (v, m) => v < m.mtbiHoursMin,
  firstPassRate: (v, m) => v < m.firstPassRateMin,
  ownerPullInsPerWeek: (v, m) => v > m.ownerPullInsPerWeekMax,
};

const fingerprint = (rule, key) => createHash('sha256').update(`${rule}:${key}`).digest('hex').slice(0, 12);
const marker = (fp) => `<!-- rt:fingerprint ${fp} -->`;
const filed = (openIssues, fp) => openIssues.some((issue) => issue.body.includes(marker(fp)));
const at = (entry) => Date.parse(entry.at);
const within = (entry, now, days) => at(entry) > now - days * DAY && at(entry) <= now;
const candidate = (rule, key, title, evidence, acceptanceHint) => ({
  rule, fingerprint: fingerprint(rule, key), title, evidence, acceptanceHint, risk: LOW_RISK.includes(rule) ? 'low' : 'standard',
});
const unique = (list) => [...new Set(list)];

/** Pure: the `not ported:` inventory rows that name no #<n>, as { tag, reason }. */
export function parseInventoryOpenRows(markdown) {
  return markdown.split('\n').filter((line) => line.startsWith('|')).map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()))
    .filter((cells) => /^not ported:/.test(cells.at(-1)) && !/#\d+/.test(cells.at(-1)))
    .map((cells) => ({ tag: cells[0], reason: cells.at(-1) }));
}

/** Pure: the numbered items under the "Improvements" heading that cite no #<n>, as { n, text }. */
export function parseCaseImprovements(markdown) {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => /^#+\s*(\d+\.\s*)?Improvements\b/i.test(line));
  if (start < 0) return [];
  const items = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('#')) break;
    const item = line.match(/^\s*(\d+)\.\s+(.*)$/);
    if (item) items.push({ n: Number(item[1]), text: item[2] });
    else if (items.length && line.trim()) items.at(-1).text += ' ' + line.trim();
  }
  return items.filter((item) => !/#\d+/.test(item.text));
}

// T1: the latest failure class repeats `count` times in `days`, and no open issue carries its fingerprint.
function t1({ goals, failures, openIssues, now }) {
  const { count, days } = goals.selfReview.failureRepeat;
  return unique(failures.map((f) => f.class)).flatMap((cls) => {
    const hits = failures.filter((f) => f.class === cls && within(f, now, days));
    if (hits.length < count || filed(openIssues, fingerprint('T1', cls))) return [];
    return [candidate('T1', cls, `Repeated failure: ${cls}`, hits.map((f) => f.ref), 'a regression test reproducing the failure passes; npm test && npm run check exits 0')];
  });
}

// T2: an un-internalized self-repair older than hostPatchMaxAgeDays, with no open follow-up issue.
function t2({ goals, interventions, openIssues, now }) {
  const maxAge = goals.selfReview.hostPatchMaxAgeDays * DAY;
  return interventions
    .filter((e) => e.category === 'self-repair' && e.internalized === 'no' && now - at(e) > maxAge)
    .filter((e) => !openIssues.some((issue) => e.followUp === `#${issue.number}`))
    .map((e) => candidate('T2', e.ref, `Host patch not internalized: ${e.ref}`, [e.id, e.ref], 'a regression test named in the inventory row fails without the port and passes with it'));
}

// T3: two or more counted interventions in one category within 7 days, with no open source:self issue for it.
function t3({ interventions, openIssues, now }) {
  const counted = interventions.filter((e) => ['owner', 'external'].includes(e.source) && e.category !== 'owner-only' && within(e, now, 7));
  return unique(counted.map((e) => e.category)).flatMap((cat) => {
    const hits = counted.filter((e) => e.category === cat);
    const fp = fingerprint('T3', cat);
    const open = openIssues.some((issue) => issue.labels.includes('source:self') && issue.body.includes(marker(fp)));
    if (hits.length < 2 || open) return [];
    return [candidate('T3', cat, `Repeated interventions: ${cat}`, hits.map((e) => e.id), 'the repeated intervention class has a self-sourced issue that removes the need for it')];
  });
}

// T4: a metric breaches its threshold in the two latest consecutive windows (values oldest first).
function t4({ goals, metrics }) {
  return Object.entries(BREACH).flatMap(([name, breached]) => {
    const values = metrics[name];
    const [prev, last] = values.slice(-2);
    if (values.length < 2 || !breached(prev, goals.metrics) || !breached(last, goals.metrics)) return [];
    return [candidate('T4', name, `Metric breached twice: ${name}`, [`window -2: ${prev}`, `window -1: ${last}`], 'the metric is back within its goals.metrics threshold')];
  });
}

// T5: each not-ported inventory row with no tracking issue.
function t5({ inventory }) {
  return parseInventoryOpenRows(inventory).map((row) => candidate('T5', row.tag, `Inventory row not ported: ${row.tag}`, [row.tag], 'the inventory row names a tracking issue or a regression test'));
}

// T6: each case improvement item with no tracking issue, for cases changed in the last 30 days.
function t6({ cases, now }) {
  return cases.filter((c) => within({ at: c.changedAt }, now, 30)).flatMap((c) => parseCaseImprovements(c.markdown).map((item) =>
    candidate('T6', `${c.file}:${item.n}`, `Case improvement not tracked: ${c.file} item ${item.n}`, [`${c.file} item ${item.n}`], 'the improvement is filed as an issue or removed from the case note')));
}

/** Pure: self-review candidates in rule order T1 to T6. */
export function proposals(input) {
  return [...t1(input), ...t2(input), ...t3(input), ...t4(input), ...t5(input), ...t6(input)];
}
