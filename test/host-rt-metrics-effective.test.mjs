// rt-metrics effective-time fields (#661): a synthetic sched.log, GitHub payloads and fake gh; no network, no host paths.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIELDS = ['effective_hours', 'merges_per_effective_hour', 'idle_backlog_effective_minutes_max',
  'idle_backlog_effective_minutes_total', 'claimable_n_min', 'claimable_n_mean', 'blocked_internal_effective_minutes',
  'blocked_owner_effective_minutes', 'no_pr_wait_oldest_effective_hours', 'gh_skipped_cycles', 'unparsed_decisions'];

// Load rt-metrics, run compute() on the fixture (fake gh), upsert daily.jsonl the way main() does.
const PY = `
import importlib.machinery, importlib.util, sys
loader = importlib.machinery.SourceFileLoader("rt_metrics", sys.argv[1])
spec = importlib.util.spec_from_loader("rt_metrics", loader)
mod = importlib.util.module_from_spec(spec)
loader.exec_module(mod)
mod.upsert_daily(mod.compute(now=mod.parse_iso("2026-11-23T12:00:00Z")))
`;

// sched.log stamps are CST (UTC+8); the fixture is written in UTC and converted here.
const cst = (utc) => new Date(Date.parse(utc) + 8 * 3600e3).toISOString().slice(0, 19).replace('T', ' ');
const sched = (utc, msg) => `${cst(utc)} CST ${msg}`;
const LOG = [
  sched('2026-11-19T00:00:00Z', 'rt-sched start pid=1 dry=False once=False workers=2 poll=30s'),
  sched('2026-11-21T10:00:00Z', 'GitHub read failed: no new claims this cycle (2 candidate(s) wait)'),
  sched('2026-11-21T11:00:00Z', 'main CI is red: no new claims (3 candidate(s) wait)'),
  sched('2026-11-21T09:05:00Z', 'worker #598 exited rc=0 state=stop blocked: internal: gate pipeline re-entered too many times'),
  // host freeze: the scheduler's cycle gap spans 14:00Z-15:00Z (1h of wall clock with no cycles)
  sched('2026-11-21T15:00:00Z', 'WARN scheduler cycle gap 3600s (> 3x poll; box freeze or stalled wait)'),
].join('\n') + '\n';

const GH = {
  issues: [{ number: 598, title: 'fixture: internal block', created_at: '2026-11-19T00:00:00Z', state: 'open', labels: [], body: '', html_url: 'https://example.invalid/issues/598' }],
  pulls: [
    { number: 701, title: 'fixture merge 11-20', created_at: '2026-11-20T10:00:00Z', merged_at: '2026-11-20T12:00:00Z', state: 'closed', head: { ref: 'rt/601-pi' }, body: '', html_url: 'https://example.invalid/pull/701' },
    { number: 702, title: 'fixture merge 11-22', created_at: '2026-11-22T09:00:00Z', merged_at: '2026-11-22T10:00:00Z', state: 'closed', head: { ref: 'rt/603-pi' }, body: '', html_url: 'https://example.invalid/pull/702' },
  ],
  comments: [],
  events: [
    { event: 'labeled', created_at: '2026-11-21T09:00:00Z', issue: { number: 598 }, label: { name: 'rt:blocked' } },
    { event: 'unlabeled', created_at: '2026-11-21T21:00:00Z', issue: { number: 598 }, label: { name: 'rt:blocked' } },
  ],
};

// Fake gh: serves the fixture for `gh api --paginate repos/...`; graphql returns an empty object.
const FAKE_GH = `#!/usr/bin/env python3
import json, sys
from pathlib import Path
args = sys.argv[1:]
if "graphql" in args:
    print("{}")
    sys.exit(0)
path = next(a for a in args if a.startswith("repos/")).split("?")[0]
key = next(k for k in ("issues", "pulls", "comments", "events") if path.endswith("/" + k))
print(json.dumps(json.loads(Path(__file__).with_name("gh.json").read_text())[key]))
`;

test('daily rows carry the effective-time fields; 11-21 has 0 merges and #598 internal block is ~11 effective hours', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rt-metrics-eff-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fake = join(dir, 'gh');
  writeFileSync(fake, FAKE_GH);
  chmodSync(fake, 0o755);
  writeFileSync(join(dir, 'gh.json'), JSON.stringify(GH));
  const logDir = join(dir, 'logs');
  mkdirSync(logDir);
  writeFileSync(join(logDir, 'sched.log'), LOG);
  const r = spawnSync('python3', ['-c', PY, join(repo, 'host', 'bin', 'rt-metrics')], {
    env: { PATH: process.env.PATH, HOME: dir, RT_HOME: dir, RT_GH_REAL: fake, RT_REPO: 'example/fixture', PYTHONDONTWRITEBYTECODE: '1' },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  const rows = readFileSync(join(dir, 'state', 'metrics', 'daily.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  for (const row of rows) for (const f of FIELDS) assert.ok(f in row, `${row.date} lacks ${f}`);

  const day = rows.find((row) => row.date === '2026-11-21');
  assert.equal(day.prs_merged, 0, '0 merges on 11-21');
  assert.equal(day.merges_per_effective_hour, 0);
  assert.equal(day.effective_hours, 23, '24h day minus the 1h host freeze');
  assert.equal(day.gh_skipped_cycles, 1);
  assert.equal(day.claimable_n_min, 2);
  assert.equal(day.claimable_n_mean, 2.5);
  assert.equal(day.unparsed_decisions, 0);
  const internal = rows.reduce((sum, row) => sum + (row.blocked_internal_effective_minutes ?? 0), 0) / 60;
  assert.ok(Math.abs(internal - 11) <= 0.5, `#598 internal block ${internal} effective h`);
  const owner = rows.reduce((sum, row) => sum + (row.blocked_owner_effective_minutes ?? 0), 0);
  assert.equal(owner, 0, 'the internal block is not counted as owner time');
});
