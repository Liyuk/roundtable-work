import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostname, userInfo } from 'node:os';
import { main } from '../bin/rtd';

const HOME_PATH = /\/home\/|\/Users\/|\/root\//;
const IPV4 = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/;
const HEARTBEAT_NOW = 1_000_000;

const PASSING = {
  ghAuth: async () => true,
  harnesses: async () => ['pi', 'codex'],
  harness: async () => true,
  repoAccess: async () => true,
  stateWritable: async () => true,
  freeBytes: async () => 10 * 1024 * 1024 * 1024,
  service: async () => true,
  heartbeat: async () => JSON.stringify({ writtenAt: HEARTBEAT_NOW - 1000 }),
};

// Each failing probe maps to the one check it must fail and the code it must yield.
const FAILING = {
  ghAuth: ['gh-auth', 'DOCTOR_GH_AUTH'],
  harness: ['harness:pi', 'DOCTOR_HARNESS_MISSING'],
  repoAccess: ['repo-access', 'DOCTOR_REPO_ACCESS'],
  stateWritable: ['state-dir', 'DOCTOR_STATE_NOT_WRITABLE'],
  freeBytes: ['disk', 'DOCTOR_DISK_LOW'],
  service: ['service', 'DOCTOR_SERVICE_DOWN'],
  heartbeat: ['heartbeat', 'DOCTOR_HEARTBEAT_STALE'],
};

async function doctor(args, probes = {}, { platform = 'linux' } = {}) {
  const out = [];
  const err = [];
  const status = await main(['doctor', ...args], {
    platform,
    env: {},
    cwd: '/work/space',
    now: HEARTBEAT_NOW,
    probes: { ...PASSING, ...probes },
    stdout: { write: (s) => out.push(s) },
    stderr: { write: (s) => err.push(s) },
  });
  return { status, stdout: out.join(''), stderr: err.join('') };
}

const jsonOf = (r) => JSON.parse(r.stdout);

test('all probes passing exits 0 and reports every check PASS', async () => {
  const r = await doctor([]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^PASS gh-auth$/m);
  assert.match(r.stdout, /^PASS harness:pi$/m);
  assert.match(r.stdout, /^PASS harness:codex$/m);
  assert.match(r.stdout, /^PASS heartbeat$/m);
  assert.doesNotMatch(r.stdout, /^FAIL/m);
});

test('--json with all probes passing exits 0 and returns ok with null code and hint', async () => {
  const r = await doctor(['--json']);
  assert.equal(r.status, 0, r.stderr);
  const body = jsonOf(r);
  assert.equal(body.ok, true);
  assert.ok(body.checks.length > 0);
  for (const c of body.checks) assert.deepEqual([c.ok, c.code, c.hint], [true, null, null], c.name);
});

for (const [probe, [name, code]] of Object.entries(FAILING)) {
  test(`failing ${probe} yields FAIL ${name} with ${code} and a fix hint, exit 1`, async () => {
    const r = await doctor([], { [probe]: async () => false });
    assert.equal(r.status, 1);
    assert.match(r.stdout, new RegExp(`^FAIL ${name} \\[${code}\\] fix: .+$`, 'm'));
  });
}

test('each failure code has its own distinct one-line fix hint', async () => {
  const hints = new Map();
  for (const probe of Object.keys(FAILING)) {
    const body = jsonOf(await doctor(['--json'], { [probe]: async () => false }));
    const failed = body.checks.filter((c) => !c.ok);
    assert.equal(failed.length, probe === 'harness' ? 2 : 1, probe);
    for (const c of failed) {
      assert.equal(c.code, FAILING[probe][1]);
      assert.ok(c.hint && !c.hint.includes('\n'), c.name);
      hints.set(c.code, c.hint);
    }
  }
  assert.equal(new Set(hints.values()).size, hints.size);
});

test('a probe that throws counts as a failed check and its error text is not printed', async () => {
  const r = await doctor([], { ghAuth: async () => { throw new Error('secret-token-xyz'); } });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^FAIL gh-auth \[DOCTOR_GH_AUTH\]/m);
  assert.doesNotMatch(r.stdout + r.stderr, /secret-token-xyz/);
});

test('every harness name gets its own check; a missing one fails with DOCTOR_HARNESS_MISSING', async () => {
  const r = await doctor(['--json'], { harness: async (name) => name !== 'codex' });
  const body = jsonOf(r);
  assert.equal(r.status, 1);
  const codex = body.checks.find((c) => c.name === 'harness:codex');
  assert.deepEqual([codex.ok, codex.code], [false, 'DOCTOR_HARNESS_MISSING']);
  assert.equal(body.checks.find((c) => c.name === 'harness:pi').ok, true);
});

test('a harnesses probe that throws fails the harness check', async () => {
  const body = jsonOf(await doctor(['--json'], { harnesses: async () => { throw new Error('bad config'); } }));
  const check = body.checks.find((c) => c.name === 'harnesses');
  assert.deepEqual([check.ok, check.code], [false, 'DOCTOR_HARNESS_MISSING']);
});

test('disk check honours --min-free-mb', async () => {
  const probes = { freeBytes: async () => 500 * 1024 * 1024 };
  assert.equal((await doctor([], probes)).status, 1);
  assert.equal((await doctor(['--min-free-mb', '100'], probes)).status, 0);
});

test('heartbeat: fresh passes; stale, missing, and malformed fail', async () => {
  const beat = (text) => doctor(['--json'], { heartbeat: async () => text });
  const check = (r) => jsonOf(r).checks.find((c) => c.name === 'heartbeat').ok;
  assert.equal(check(await beat(JSON.stringify({ writtenAt: HEARTBEAT_NOW - 120000 }))), true);
  assert.equal(check(await beat(JSON.stringify({ writtenAt: HEARTBEAT_NOW - 120001 }))), false);
  assert.equal(check(await beat(undefined)), false);
  assert.equal(check(await beat('{not json')), false);
  assert.equal(check(await beat(JSON.stringify({ writtenAt: 'soon' }))), false);
});

test('--max-heartbeat-age-ms is honoured', async () => {
  const probes = { heartbeat: async () => JSON.stringify({ writtenAt: HEARTBEAT_NOW - 5000 }) };
  assert.equal((await doctor(['--max-heartbeat-age-ms', '1000'], probes)).status, 1);
  assert.equal((await doctor(['--max-heartbeat-age-ms', '6000'], probes)).status, 0);
});

test('invalid number or unknown option prints usage on stderr and exits 2', async () => {
  for (const args of [['--min-free-mb', 'lots'], ['--max-heartbeat-age-ms', '-1'], ['--bogus']]) {
    const r = await doctor(args);
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, /usage: rtd/);
    assert.equal(r.stdout, '');
  }
});

test('doctor runs on an unsupported platform instead of being rejected', async () => {
  const r = await doctor([], {}, { platform: 'win32' });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /not supported/);
});

test('--repo is passed to the repo-access probe; absent means undefined', async () => {
  const seen = [];
  await doctor([], { repoAccess: async (repo) => { seen.push(repo); return true; } });
  await doctor(['--repo', 'Liyuk/roundtable-work'], { repoAccess: async (repo) => { seen.push(repo); return true; } });
  assert.deepEqual(seen, [undefined, 'Liyuk/roundtable-work']);
});

test('--workspace (default cwd) is used for the state dir, disk and heartbeat probes', async () => {
  const seen = {};
  const spy = (k) => async (arg) => { seen[k] = arg; return k === 'heartbeat' ? JSON.stringify({ writtenAt: HEARTBEAT_NOW }) : true; };
  await doctor([], { stateWritable: spy('stateWritable'), freeBytes: spy('freeBytes'), heartbeat: spy('heartbeat') });
  assert.equal(seen.stateWritable, '/work/space/.roundtable/state');
  assert.equal(seen.freeBytes, '/work/space');
  assert.equal(seen.heartbeat, '/work/space');
  await doctor(['--workspace', '/elsewhere'], { heartbeat: spy('heartbeat') });
  assert.equal(seen.heartbeat, '/elsewhere');
});

test('text and json output contain no host names, IP addresses, usernames, or home paths', async () => {
  const failing = { ghAuth: async () => false, service: async () => false, heartbeat: async () => undefined };
  const outputs = [await doctor([], failing), await doctor(['--json'], failing)];
  for (const r of outputs) {
    assert.doesNotMatch(r.stdout, HOME_PATH);
    assert.doesNotMatch(r.stdout, IPV4);
    assert.ok(!r.stdout.includes(hostname()), 'hostname leaked');
    assert.ok(!r.stdout.includes(userInfo().username), 'username leaked');
  }
});
