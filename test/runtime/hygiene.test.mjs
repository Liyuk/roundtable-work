import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadDenylist, scanHygiene, formatFindings, hashText, HygieneError,
} from '../../runtime/lib/hygiene.mjs';

// A common OS image name is listed as a common-word host name; built from pieces on purpose.
const OS_IMAGE = ['ubu', 'ntu'].join('');

// Fixture denylist: obviously fake names only.
const FIXTURE = {
  hostnames: { distinctive: ['fixturehost-example'], common: [OS_IMAGE, 'toolbox'] },
  usernames: { distinctive: ['fixtureuser-example'], common: ['builder'] },
};
const denylist = loadDenylist({ fixture: FIXTURE });

// Sensitive-looking inputs are built at runtime so the literals never appear in source.
const ip = (...parts) => parts.join('.');
const PRIVATE_IP = ip('10', '0', '0', '5');
const PRIVATE_IP2 = ip('192', '168', '1', '20');
const PUBLIC_IP = ip('8', '8', '4', '4');
const HOME_PATH = '/ho' + 'me/' + 'someone';
const MAC_PATH = '/Us' + 'ers/' + 'someone';
const WIN_PATH = 'C:\\Us' + 'ers\\' + 'someone';

function scanLines(...texts) {
  return scanHygiene({
    addedLines: texts.map((text, i) => ({ path: 'docs/a.md', line: i + 1, text })),
    paths: [], metadata: {}, denylist,
  });
}
const rules = (findings) => findings.map((f) => f.ruleId);

test('private and public IPv4 addresses fail', () => {
  for (const addr of [PRIVATE_IP, PRIVATE_IP2, ip('172', '16', '4', '9'), PUBLIC_IP, ip('169', '254', '1', '1')]) {
    const f = scanLines(`connect to ${addr} now`);
    assert.deepEqual(rules(f), ['HYG-IP'], addr);
    assert.equal(f[0].path, 'docs/a.md');
    assert.equal(f[0].line, 1);
    assert.equal(f[0].length, addr.length);
    assert.equal(f[0].hash, hashText(addr));
  }
});

test('IPv6 non-doc addresses fail, doc range and loopback pass', () => {
  const priv = ['fd00', '0', '0', '0', '0', '0', '0', '1'].join(':');
  const pub = ['2606', '4700', '', '1111'].join(':');
  const linkLocal = 'fe80' + '::1';
  assert.deepEqual(rules(scanLines(`addr ${priv}`)), ['HYG-IP']);
  assert.deepEqual(rules(scanLines(`addr ${pub}`)), ['HYG-IP']);
  assert.deepEqual(rules(scanLines(`addr [${linkLocal}]:22`)), ['HYG-IP']);
  assert.deepEqual(scanLines('addr 2001:db8::1 and ::1 and [2001:db8:85a3::8a2e:370:7334]:80'), []);
  assert.deepEqual(scanLines('std::vector, Add::fee, 12:30:45, aa:bb:cc:dd:ee:ff'), []);
});

test('documentation ranges, loopback and netmasks pass', () => {
  assert.deepEqual(scanLines(
    'use 192.0.2.10 or 198.51.100.7 or 203.0.113.250',
    'listen on 127.0.0.1 and 0.0.0.0, mask 255.255.255.0',
  ), []);
});

test('four-part semver and version-like strings pass', () => {
  assert.deepEqual(scanLines(
    'release v1.2.3.4 is out',
    'install pkg@1.2.3.4 now',
    'build 1.2.3.4.5 is odd',
    'tag V9.8.7.6',
  ), []);
});

test('an @ prefix does not hide an address in an ssh command', () => {
  assert.deepEqual(rules(scanLines(`ssh deploy@${PUBLIC_IP}`)), ['HYG-IP']);
});

test('an address behind an @ prefix fails without an ssh word; package versions still pass', () => {
  for (const text of [
    `git clone git@${PUBLIC_IP}:org/repo.git`,
    `git@${PUBLIC_IP}:org/repo.git`,
    `deploy@${PRIVATE_IP}`,
    `login deploy@${PRIVATE_IP} now`,
    `https://user@${PUBLIC_IP}/path`,
    `url = "https://user@${PRIVATE_IP}:8443/x"`,
    `deploy@${PUBLIC_IP}:2222`,
    `install pkg@${PUBLIC_IP}/x`,
    `remote add origin git@${ip('1', '2', '3', '4')}:o/r.git`,
  ]) {
    assert.deepEqual(rules(scanLines(text)), ['HYG-IP'], text);
  }
  assert.deepEqual(scanLines(
    'npm install pkg@1.2.3.4',
    'requires @scope/pkg@1.2.3.4 or later',
    'yarn add left-pad@2.0.1.7',
    'release v1.2.3.4 is out',
    'build 1.2.3.4.5 is odd',
  ), []);
});

test('JS member access with a private-looking suffix is not a host; real hosts still fail', () => {
  assert.deepEqual(scanLines(
    'const home = process.env.HOME;',
    'const h = env.HOME || os.tmp;',
    'this.local = true; user.home = x; config.internal = 1;',
  ), []);
  for (const host of [['box', 'local'], ['name', 'internal'], ['nas', 'home']].map((p) => p.join('.'))) {
    assert.deepEqual(rules(scanLines(`ping ${host}`)), ['HYG-FQDN'], host);
    assert.deepEqual(rules(scanLines(`see https://${host}/x`)), ['HYG-FQDN'], host);
    assert.deepEqual(rules(scanLines(`ssh user@${host}`)), ['HYG-FQDN'], host);
  }
  // A member-access word in host position (URL authority / user@host) is still a host.
  assert.deepEqual(rules(scanLines('open https://' + ['env', 'local'].join('.') + '/x')), ['HYG-FQDN']);
});

test('private-suffix FQDNs fail; example, test, invalid, localhost and public hosts pass', () => {
  for (const host of [['db1', 'local'], ['nas', 'lan'], ['api', 'corp', 'internal'], ['box', 'home']].map((p) => p.join('.'))) {
    assert.deepEqual(rules(scanLines(`see https://${host}/x`)), ['HYG-FQDN'], host);
  }
  assert.deepEqual(scanLines(
    'see https://www.example.com/a, example.org, example.net, svc.test, bad.invalid',
    'http://localhost:8080 https://github.com/o/r https://registry.npmjs.org/x https://nodejs.org raw.githubusercontent.com',
    'files settings.local.json and .env.local and src/config.local',
  ), []);
});

test('distinctive hostnames and usernames fail anywhere, case-insensitively', () => {
  const f = scanLines('plain prose mentions FixtureHost-Example here', 'and fixtureuser-example too');
  assert.deepEqual(rules(f), ['HYG-HOST', 'HYG-USER']);
  assert.deepEqual(f.map((x) => x.line), [1, 2]);
  // Word boundary: embedded in a longer word does not count.
  assert.deepEqual(scanLines('xfixturehost-examplex'), []);
});

test('common-word names fail only in host context', () => {
  // Ordinary prose and the colliding audit-tool name pass.
  assert.deepEqual(scanLines(
    `The toolbox audit tool checks every builder script on ${OS_IMAGE} images.`,
    'Run toolbox --help to list the builder options.',
  ), []);
  // Host contexts fail.
  assert.deepEqual(rules(scanLines('login as someone@toolbox')), ['HYG-HOST']);
  assert.deepEqual(rules(scanLines('ssh -i key toolbox')).includes('HYG-HOST'), true);
  assert.deepEqual(rules(scanLines('scp file.txt toolbox:/tmp')).includes('HYG-HOST'), true);
  assert.deepEqual(rules(scanLines('open https://toolbox/status')).includes('HYG-HOST'), true);
  assert.deepEqual(rules(scanLines('open https://builder@somewhere/status')).includes('HYG-USER'), true);
  assert.equal(rules(scanLines('ping toolbox.' + 'lan')).includes('HYG-HOST'), true);
  assert.equal(rules(scanLines('builder@somewhere')).includes('HYG-USER'), true);
  // An example mail domain is not a host.
  assert.deepEqual(scanLines('mail builder@example.com'), []);
});

test('OS image names in CI config pass even when they collide with a common name', () => {
  assert.deepEqual(scanLines(
    `    runs-on: ${OS_IMAGE}-latest`,
    '    runs-on: macos-14',
    `    runs-on: ${OS_IMAGE}-22.04`,
    '    runs-on: windows-2022',
  ), []);
});

test('absolute home paths fail in diff lines', () => {
  for (const p of [HOME_PATH + '/notes', MAC_PATH + '/x', WIN_PATH + '\\x', '/ro' + 'ot/.ssh', '~' + 'someone/bin']) {
    assert.deepEqual(rules(scanLines(`cd ${p}`)), ['HYG-HOMEPATH'], p);
  }
  assert.deepEqual(rules(scanLines('{"p": "C:\\\\Us' + 'ers\\\\someone\\\\x"}')), ['HYG-HOMEPATH']);
});

test('absolute home paths fail in commit message, PR body, PR title, branch and author', () => {
  const f = scanHygiene({
    addedLines: [], paths: [], denylist,
    metadata: {
      commitMessages: ['subject\n\nbody mentions ' + HOME_PATH + '/repo'],
      authors: ['Dev <dev@example.com>'],
      prTitle: 'Fix ' + MAC_PATH,
      prBody: 'line one\nsee ' + HOME_PATH + '/x',
      branch: 'rt' + HOME_PATH,
    },
  });
  assert.deepEqual(f.map((x) => [x.ruleId, x.path, x.line]), [
    ['HYG-HOMEPATH', '<metadata:commit#1>', 3],
    ['HYG-HOMEPATH', '<metadata:prTitle>', 0],
    ['HYG-HOMEPATH', '<metadata:prBody>', 2],
    ['HYG-HOMEPATH', '<metadata:branch>', 0],
  ]);
});

test('a clean branch name passes; hosts and users in commit, author, PR text fail', () => {
  assert.deepEqual(scanHygiene({
    addedLines: [], paths: [], denylist,
    metadata: { commitMessages: ['Add checks'], authors: ['Dev <dev@example.com>'], prTitle: 'Add', prBody: 'ok', branch: 'rt/28-pi' },
  }), []);
  const f = scanHygiene({
    addedLines: [], paths: [], denylist,
    metadata: {
      commitMessages: ['ran on ' + PRIVATE_IP],
      authors: ['fixtureuser-example <x@example.com>'],
      prBody: 'host fixturehost-example',
    },
  });
  assert.deepEqual(f.map((x) => [x.ruleId, x.path]), [
    ['HYG-IP', '<metadata:commit#1>'],
    ['HYG-USER', '<metadata:author#1>'],
    ['HYG-HOST', '<metadata:prBody>'],
  ]);
});

test('added and renamed paths are scanned and reported without echoing the path', () => {
  const bad = 'docs/fixturehost-example/notes.md';
  const f = scanHygiene({ addedLines: [], paths: ['docs/ok.md', bad], metadata: {}, denylist });
  assert.deepEqual(rules(f), ['HYG-HOST']);
  assert.equal(f[0].path, `<path:${hashText(bad)}>`);
  assert.ok(!JSON.stringify(f).includes('fixturehost-example'));
  // Added lines in a dirty file are reported under the redacted path too.
  const g = scanHygiene({ addedLines: [{ path: bad, line: 4, text: 'x ' + PRIVATE_IP }], paths: [], metadata: {}, denylist });
  assert.equal(g[0].path, `<path:${hashText(bad)}>`);
});

test('placeholders pass', () => {
  assert.deepEqual(scanLines(
    'cd /home/<user>/work and /Users/<user>/x and C:\\Users\\<user>\\x and ~<user>/bin',
    'store in $RT_HOME/gate0, run on the host, ssh <vps>, runner <host-runner>',
    'path /home/$USER/x and /home/${USER}/x',
    'url https://<user>:<password>@example.com/x',
  ), []);
});

test('base64-encoded and URL-encoded blobs of IPs and paths fail', () => {
  const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
  const urlEnc = (s) => [...s].map((c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
  const urlSafe = (s) => b64(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  for (const hidden of [PRIVATE_IP, 'ssh ' + PUBLIC_IP, HOME_PATH + '/repo', 'host=fixturehost-example']) {
    assert.deepEqual(rules(scanLines('data: ' + b64(hidden))), ['HYG-ENC'], 'b64 ' + hidden);
    assert.deepEqual(rules(scanLines('data=' + urlSafe(hidden))), ['HYG-ENC'], 'b64url ' + hidden);
    assert.deepEqual(rules(scanLines('link?q=' + urlEnc(hidden))), ['HYG-ENC'], 'pct ' + hidden);
  }
  // Double encoding is followed within the depth limit.
  assert.deepEqual(rules(scanLines('x ' + b64(urlEnc(PRIVATE_IP)))), ['HYG-ENC']);
  // Harmless encoded data passes.
  assert.deepEqual(scanLines('q=' + b64('hello world, nothing here'), 'a%20b%2Fc', 'id AbCdEfGhIjKlMnOpQr'), []);
});

// Credential-shaped inputs are assembled from pieces so no literal secret exists in source.
const piece = (...p) => p.join('');
const REAL_SHAPED = {
  github: piece('gh', 'p_', 'Zk3pQ9vL2xR7tW5yB8nM4cD6fH1jK0aS'),
  githubPat: piece('github', '_pat_', 'Zk3pQ9vL2xR7tW5yB8nM4cD6fH1jK0'),
  openai: piece('s', 'k-', 'Zk3pQ9vL2xR7tW5yB8nM4cD6'),
  aws: piece('AK', 'IA', 'Q7ZK3PL2XR7TW5YB'),
  slack: piece('xo', 'xb-', '123456789012-AbCdEfGhIjKl'),
  privateKey: piece('-----BEGIN ', 'RSA PRIVATE', ' KEY-----'),
  credUrl: piece('https://deploy:', 'Zk3pQ9vL2xR7tW5y', '@git.example.com/o/r'),
  assign: piece('api', '_key = "', 'Zk3pQ9vL2xR7tW5yB8nM4cD6', '"'),
  assignJson: piece('"pass', 'word": "', 'q8Zk3pQ9vL2xR7tW5yB8nM4', '"'),
  secretEnv: piece('CLIENT_SEC', 'RET=', 'q8Zk3pQ9vL2xR7tW5yB8nM4'),
};

test('credential patterns fail', () => {
  for (const [name, text] of Object.entries(REAL_SHAPED)) {
    const f = scanLines('x ' + text + ' y');
    assert.deepEqual(rules(f), ['HYG-CRED'], name);
  }
});

test('low-entropy or placeholder credential assignments pass', () => {
  assert.deepEqual(scanLines(
    'token = "abc"',
    'password: changeme',
    'const tokens = parseTokensFromInput(input)',
    'secret_name = some_long_identifier_name_here',
    'api_key = <your key>',
    'password=$PASSWORD_FROM_ENV_VARIABLE_1',
    'ask-about-something-long-hyphenated-1',
  ), []);
});

test('EXAMPLE / FAKE markers exempt credential-looking values', () => {
  assert.deepEqual(scanLines(
    'ghp_EXAMPLEEXAMPLEEXAMPLE1234567890',
    'AKIAIOSFODNN7EXAMPLE',
    'password = "FAKE-Zk3pQ9vL2xR7tW5yB8nM4"',
    'api_key = Zk3pQ9vL2xR7tW5yEXAMPLE88',
    'https://deploy:FAKEpassword9@git.example.com/o/r',
  ), []);
  // The marker exempts credentials only, not host identifiers.
  assert.deepEqual(rules(scanLines('FAKE host ' + PRIVATE_IP)), ['HYG-IP']);
});

test('inline suppression comments do not suppress anything', () => {
  const f = scanLines(
    `host ${PRIVATE_IP} // gate0-ignore`,
    `# gate0-ignore-next-line\nip ${PUBLIC_IP}`,
    `/* gate0-disable */ ${HOME_PATH}/x`,
    `<!-- gate0:allow --> ${REAL_SHAPED.github} # nosec noqa`,
  );
  assert.deepEqual(rules(f), ['HYG-IP', 'HYG-IP', 'HYG-HOMEPATH', 'HYG-CRED']);
});

test('base-side allowlist.testFakes (path + hash) exempts only the exact location', () => {
  const secret = REAL_SHAPED.openai;
  const allowlist = { testFakes: [{ path: 'test/fake.test.mjs', hash: hashText(secret) }] };
  const mk = (path) => scanHygiene({
    addedLines: [{ path, line: 1, text: 'k = ' + secret }], paths: [], metadata: {}, denylist, allowlist,
  });
  assert.deepEqual(mk('test/fake.test.mjs'), []);
  assert.deepEqual(rules(mk('test/other.test.mjs')), ['HYG-CRED']);
  // Metadata can never be exempted through the allowlist.
  const meta = scanHygiene({
    addedLines: [], paths: [], denylist,
    metadata: { prBody: secret },
    allowlist: { testFakes: [{ path: '<metadata:prBody>', hash: hashText(secret) }] },
  });
  assert.deepEqual(rules(meta), ['HYG-CRED']);
  assert.throws(() => scanHygiene({ addedLines: [], denylist, allowlist: { testFakes: 'x' } }), HygieneError);
});

test('findings and formatted output never contain matched text', () => {
  const secret = REAL_SHAPED.github;
  const f = scanHygiene({
    addedLines: [
      { path: 'docs/a.md', line: 3, text: `ip ${PRIVATE_IP} user fixtureuser-example ${HOME_PATH}/x ${secret}` },
    ],
    paths: [], denylist,
    metadata: { commitMessages: ['host fixturehost-example'], prBody: PUBLIC_IP },
  });
  assert.ok(f.length >= 5);
  for (const x of f) {
    assert.deepEqual(Object.keys(x).sort(), ['hash', 'length', 'line', 'path', 'ruleId']);
    assert.match(x.hash, /^[0-9a-f]{8}$/);
  }
  const out = JSON.stringify(f) + '\n' + formatFindings(f);
  for (const s of [PRIVATE_IP, PUBLIC_IP, HOME_PATH, 'someone', secret, 'fixtureuser-example', 'fixturehost-example']) {
    assert.ok(!out.includes(s), 'output must not contain matched text');
  }
  assert.match(formatFindings(f), /^HYG-IP docs\/a\.md:3 len=\d+ hash=[0-9a-f]{8}$/m);
  assert.equal(formatFindings([]), '');
});

// --- Denylist loading ---------------------------------------------------

test('hostRun with a missing denylist throws an error without identifiers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hyg-'));
  try {
    for (const env of [{}, { RT_HOME: dir }]) {
      assert.throws(() => loadDenylist({ env, hostRun: true }), (err) => {
        assert.ok(err instanceof HygieneError);
        assert.match(err.code, /^DENYLIST_/);
        assert.ok(!err.message.includes(dir));
        assert.match(err.message, /^gate0: [a-z ]+$/);
        return true;
      });
    }
    // Non-host runs get an empty denylist instead.
    assert.deepEqual(loadDenylist({ env: { RT_HOME: dir } }).hostnames, { distinctive: [], common: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hostRun with an invalid or empty denylist file throws without echoing content', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hyg-'));
  try {
    mkdirSync(join(dir, 'gate0'));
    const file = join(dir, 'gate0', 'denylist.json');
    writeFileSync(file, '{ "hostnames": not-json fixturehost-example');
    assert.throws(() => loadDenylist({ env: { RT_HOME: dir }, hostRun: true }), (err) => {
      assert.ok(!err.message.includes('fixturehost-example'));
      assert.ok(!err.message.includes(dir));
      return true;
    });
    writeFileSync(file, JSON.stringify({ hostnames: { distinctive: ['bad name!'] } }));
    assert.throws(() => loadDenylist({ env: { RT_HOME: dir }, hostRun: true }), (err) => !err.message.includes('bad name'));
    writeFileSync(file, JSON.stringify({}));
    assert.throws(() => loadDenylist({ env: { RT_HOME: dir }, hostRun: true }), /empty/);
    // A valid file loads and is normalized.
    writeFileSync(file, JSON.stringify({ hostnames: { distinctive: ['Fixturehost-Example'] }, usernames: { common: ['builder'] } }));
    const d = loadDenylist({ env: { RT_HOME: dir }, hostRun: true });
    assert.deepEqual(d.hostnames.distinctive, ['fixturehost-example']);
    assert.deepEqual(d.usernames.common, ['builder']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scanHygiene fails closed when no denylist is supplied', () => {
  assert.throws(() => scanHygiene({ addedLines: [], paths: [], metadata: {} }), (err) => {
    assert.ok(err instanceof HygieneError);
    assert.equal(err.code, 'DENYLIST_REQUIRED');
    return true;
  });
  assert.throws(() => scanHygiene({ addedLines: [{ path: 1 }], denylist }), HygieneError);
});

test('an empty line set, no metadata and a clean diff yield no findings', () => {
  assert.deepEqual(scanHygiene({ denylist }), []);
  assert.deepEqual(scanLines('Plain English documentation line.', 'const x = 42;'), []);
});

// ---------------------------------------------------------------------------
// Long lines (rule 7: scanning must be linear, a secret inside is still found)
// ---------------------------------------------------------------------------

const LONG = 50 * 1024;
const SECRET_PIECES = ['gh', 'p_', 'Zk3pQ9vL2xR7tW5yB8nM4cD6fH1jK0aS'].join('');

test('long single lines scan fast with every pattern shape', () => {
  const shapes = [
    'a'.repeat(LONG), 'ab_'.repeat(LONG / 3), 'a.'.repeat(LONG / 2), '1.2.3.'.repeat(LONG / 6),
    'x'.repeat(LONG - 3) + '%41', '%41a'.repeat(LONG / 4), 'QUJD'.repeat(LONG / 4),
    'token_'.repeat(LONG / 6), 'token '.repeat(LONG / 6), 'ab:'.repeat(LONG / 3), 'ab'.repeat(LONG / 2),
    'http://u:'.repeat(LONG / 9), 'a+b.'.repeat(LONG / 4), 'sk-'.repeat(LONG / 3), '-'.repeat(LONG),
    '-----BEGIN '.repeat(LONG / 11), 'ssh '.repeat(LONG / 4), 'joe@'.repeat(LONG / 4), ' '.repeat(LONG),
    'a-b.'.repeat(LONG / 4) + 'x', 'builder@'.repeat(LONG / 8),
  ];
  const started = Date.now();
  for (const text of shapes) scanLines(text);
  assert.ok(Date.now() - started < 5000, `long-line scan took ${Date.now() - started} ms`);
});

test('a secret, an address and a base64 blob inside a long line are still found', () => {
  const pad = 'lorem ipsum '.repeat(LONG / 12);
  const encoded = Buffer.from(`key = ${SECRET_PIECES}`).toString('base64');
  for (const [needle, expected] of [[SECRET_PIECES, 'HYG-CRED'], [PUBLIC_IP, 'HYG-IP'], [`git@${PUBLIC_IP}:o/r`, 'HYG-IP'], [encoded, 'HYG-ENC']]) {
    for (const text of [`${pad} ${needle}`, `${needle} ${pad}`, `${pad} ${needle} ${pad}`]) {
      const started = Date.now();
      const f = scanLines(text);
      assert.ok(Date.now() - started < 5000);
      assert.ok(rules(f).includes(expected), `${expected} not found in a ${text.length}-char line`);
    }
  }
});

test('a deadline in the past aborts the scan with a timeout error instead of a clean result', () => {
  assert.throws(
    () => scanHygiene({ addedLines: [{ path: 'a.md', line: 1, text: 'x'.repeat(100) }], denylist, deadline: Date.now() - 1 }),
    (err) => err instanceof HygieneError && err.code === 'TIMEOUT',
  );
  assert.deepEqual(scanHygiene({ addedLines: [{ path: 'a.md', line: 1, text: 'x' }], denylist, deadline: Date.now() + 60000 }), []);
});
