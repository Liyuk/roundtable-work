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
// Member-access fixtures are built at runtime so no dotted private-suffix name appears in this source.
const dot = (...parts) => parts.join('.');
const PROC_HOME = dot('process', 'env', 'HOME');
const ENV_HOME = dot('env', 'HOME');
const THIS_LOCAL = dot('this', 'local');
const USER_HOME = dot('user', 'home');
const CFG_LOCAL = dot('config', 'local');
const CFG_INTERNAL = dot('config', 'internal');
const PRIVATE_IP = ip('10', '0', '0', '5');
const PRIVATE_IP2 = ip('192', '168', '1', '20');
const PUBLIC_IP = ip('8', '8', '4', '4');
const HOME_PATH = '/ho' + 'me/' + 'someone';
const MAC_PATH = '/Us' + 'ers/' + 'someone';
const WIN_PATH = 'C:\\Us' + 'ers\\' + 'someone';
const HOME_ROOT = '/ho' + 'me';
const MAC_ROOT = '/Us' + 'ers';
const WIN_ROOT = 'C:\\Us' + 'ers';
const LOOPBACK = ip('127', '0', '0', '1');
const UNSPEC = ip('0', '0', '0', '0');
const NETMASK = ip('255', '255', '255', '0');
const SEMVER4 = ip('1', '2', '3', '4');
const SEMVER4B = ip('2', '0', '1', '7');
const SEMVER4C = ip('9', '8', '7', '6');
const FIVE_PART = ip('1', '2', '3', '4', '5');

function scanLines(...texts) {
  return scanHygiene({
    addedLines: texts.map((text, i) => ({ path: 'docs/a.md', line: i + 1, text })),
    paths: [], metadata: {}, denylist,
  });
}
// Same as scanLines, but the added lines sit in a JavaScript code file.
function scanCode(...texts) {
  return scanHygiene({
    addedLines: texts.map((text, i) => ({ path: 'src/a.mjs', line: i + 1, text })),
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
    `use ${ip('192', '0', '2', '10')} or ${ip('198', '51', '100', '7')} or ${ip('203', '0', '113', '250')}`,
    `listen on ${LOOPBACK} and ${UNSPEC}, mask ${NETMASK}`,
  ), []);
});

test('four-part semver and version-like strings pass', () => {
  assert.deepEqual(scanLines(
    `release v${SEMVER4} is out`,
    `install pkg@${SEMVER4} now`,
    `build ${FIVE_PART} is odd`,
    `tag V${SEMVER4C}`,
  ), []);
});

test('a pre-release suffix on a v-prefixed or package-context four-part version passes; a bare one does not', () => {
  assert.deepEqual(scanLines(
    `release v${SEMVER4}-rc1 is out`,
    `release v${SEMVER4}-beta.2 is out`,
    `npm install pkg@${SEMVER4}-rc1`,
    `requires @scope/pkg@${SEMVER4}-beta`,
  ), []);
  // Without a version-like context the suffix does not make it a version.
  assert.deepEqual(rules(scanLines(`connect to ${SEMVER4}-rc1 now`)), ['HYG-IP']);
  assert.deepEqual(rules(scanLines(`deploy@${PUBLIC_IP}-rc1`)), ['HYG-IP']);
  assert.deepEqual(rules(scanLines(`git clone git@${SEMVER4}-rc1:o/r.git`)), ['HYG-IP']);
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
    `remote add origin git@${SEMVER4}:o/r.git`,
  ]) {
    assert.deepEqual(rules(scanLines(text)), ['HYG-IP'], text);
  }
  assert.deepEqual(scanLines(
    `npm install pkg@${SEMVER4}`,
    `requires @scope/pkg@${SEMVER4} or later`,
    `yarn add left-pad@${SEMVER4B}`,
    `release v${SEMVER4} is out`,
    `build ${FIVE_PART} is odd`,
  ), []);
});

test('JS member access with a private-looking suffix is not a host; real hosts still fail', () => {
  assert.deepEqual(scanCode(
    `const home = ${PROC_HOME};`,
    `const h = ${ENV_HOME} || os.tmp;`,
    `${THIS_LOCAL} = true; ${USER_HOME} = x; ${CFG_INTERNAL} = 1;`,
  ), []);
  for (const host of [['box', 'local'], ['name', 'internal'], ['nas', 'home']].map((p) => p.join('.'))) {
    assert.deepEqual(rules(scanLines(`ping ${host}`)), ['HYG-FQDN'], host);
    assert.deepEqual(rules(scanLines(`see https://${host}/x`)), ['HYG-FQDN'], host);
    assert.deepEqual(rules(scanLines(`ssh user@${host}`)), ['HYG-FQDN'], host);
  }
  // A member-access word in host position (URL authority / user@host) is still a host.
  assert.deepEqual(rules(scanLines('open https://' + ['env', 'local'].join('.') + '/x')), ['HYG-FQDN']);
});

test('a member-access word with a private suffix is a host in ssh/scp/rsync context, after @ and after ://', () => {
  const hosts = [['config', 'local'], ['user', 'home'], ['env', 'internal'], ['this', 'lan']].map((p) => p.join('.'));
  for (const host of hosts) {
    for (const text of [
      `ssh ${host}`,
      `ssh -p 22 ${host}`,
      `ssh admin@${host}`,
      `scp file.txt ${host}:/tmp`,
      `rsync -av src/ ${host}:backup/`,
      `sftp ${host}`,
      `mosh ${host}`,
      `echo hi; ssh ${host}`,
      `open https://${host}/x`,
      `contact admin@${host}`,
    ]) {
      assert.deepEqual(rules(scanLines(text)), ['HYG-FQDN'], text);
    }
  }
  // Ordinary code is still fine, also when a remote command is a separate statement.
  assert.deepEqual(scanCode(
    `const h = ${PROC_HOME}; const l = ${THIS_LOCAL};`,
    `if (${USER_HOME} && ${CFG_INTERNAL}) { ${ENV_HOME} = os.homedir(); }`,
    `ssh host1; const x = ${CFG_INTERNAL};`,
  ), []);
});

test('the member-access exemption applies only to added lines in code files', () => {
  const host = ['config', 'local'].join('.');
  const prose = `see ${host} for details`;
  // Prose and other non-code files: a private-suffix FQDN, whatever its first label.
  for (const path of ['docs/a.md', 'README.markdown', 'notes.txt', 'doc/x.rst', 'Makefile', 'cfg/app.yaml', 'x.mjs.md', 'src']) {
    assert.deepEqual(rules(scanAt(path, prose)), ['HYG-FQDN'], path);
  }
  // Commit message, PR title/body, author, branch and added paths never get it.
  const f = scanHygiene({
    addedLines: [], paths: [host], denylist,
    metadata: { commitMessages: [prose], authors: [host], prTitle: prose, prBody: 'ok\n' + prose, branch: host },
  });
  assert.deepEqual(f.map((x) => [x.ruleId, x.path, x.line]), [
    ['HYG-FQDN', `<path:${hashText(host)}>`, 0],
    ['HYG-FQDN', '<metadata:commit#1>', 1],
    ['HYG-FQDN', '<metadata:author#1>', 0],
    ['HYG-FQDN', '<metadata:prTitle>', 0],
    ['HYG-FQDN', '<metadata:prBody>', 2],
    ['HYG-FQDN', '<metadata:branch>', 0],
  ]);
  // JS property access in code files still passes.
  for (const path of ['src/a.mjs', 'a.cjs', 'b.js', 'c.ts', 'd.tsx', 'e.jsx', 'f.json', 'lib/G.MJS']) {
    assert.deepEqual(scanAt(path, `const a = ${CFG_LOCAL}; x = ${PROC_HOME}; ${THIS_LOCAL} = 1; ${USER_HOME} = 2;`), [], path);
  }
  // In a code file the ssh / URL / user@ host contexts still fail.
  for (const text of [`ssh ${host}`, `ssh admin@${host}`, `open https://${host}/x`, `scp f ${host}:/tmp`, `contact admin@${host}`]) {
    assert.deepEqual(rules(scanAt('src/a.mjs', text)), ['HYG-FQDN'], text);
  }
  // A real host name in a code file also still fails.
  assert.deepEqual(rules(scanAt('src/a.mjs', 'const h = "db1.' + 'local";')), ['HYG-FQDN']);
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
    `cd ${HOME_ROOT}/<user>/work and ${MAC_ROOT}/<user>/x and ${WIN_ROOT}\\<user>\\x and ~<user>/bin`,
    'store in $RT_HOME/gate0, run on the host, ssh <vps>, runner <host-runner>',
    `path ${HOME_ROOT}/$USER/x and ${HOME_ROOT}/\${USER}/x`,
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
    ['a', 's', 'k-about-something-long-hyphenated-1'].join(''),
  ), []);
});

// Letter-only credential values (no digit), assembled from pieces.
const LETTERS_ONLY = piece('qWzRt', 'YuPlK', 'jHgFd', 'SaMnB', 'vCxZ');

test('a letter-only high-entropy credential value fails, with or without a marker, outside test paths', () => {
  const assigns = [
    piece('api', '_key = "', 'FAKE', LETTERS_ONLY, '"'),
    piece('api', '_key = "', LETTERS_ONLY, '"'),
    piece('pass', 'word: ', LETTERS_ONLY),
    piece('"to', 'ken": "', LETTERS_ONLY, '"'),
  ];
  for (const a of assigns) {
    assert.deepEqual(rules(scanAt('src/config.mjs', a)), ['HYG-CRED'], a);
    assert.deepEqual(rules(scanAt('docs/a.md', a)), ['HYG-CRED'], a);
  }
  // Metadata: no marker exemption either.
  assert.deepEqual(rules(scanHygiene({ addedLines: [], paths: [], denylist, metadata: { prBody: assigns[0] } })), ['HYG-CRED']);
  // In a test path an unmarked value still fails; a FAKE / EXAMPLE marked one passes.
  assert.deepEqual(rules(scanAt('test/a.test.mjs', assigns[1])), ['HYG-CRED']);
  assert.deepEqual(scanAt('test/a.test.mjs', assigns[0]), []);
  assert.deepEqual(scanAt('test/a.test.mjs', piece('api', '_key = "', 'EXAMPLE', LETTERS_ONLY, '"')), []);
});

test('references, identifiers, low-entropy and ordinary prose values do not trigger the letter-only rule', () => {
  assert.deepEqual(scanAt('src/a.mjs',
    piece('pass', 'word: getPasswordFromEnv()'),
    piece('to', 'ken = process.env.TOKEN_NAME'),
    piece('to', 'ken = process.env.someLongMixedCaseName'),
    piece('to', 'ken = config.getSecretValueStore'),
    piece('pass', 'word = ${PASSWORD_VALUE_FROM_ENV}'),
    piece('pass', 'word = $passwordFromTheEnvironment'),
    // camelCase / PascalCase identifiers
    piece('to', 'ken = someLongCamelCaseIdentifierName'),
    piece('to', 'ken: ThisIsAVeryLongDescriptiveTypeName'),
    piece('sec', 'ret = PasswordManagerFactoryImplementation'),
    // a long all-lowercase or all-uppercase word, low-entropy repeated values
    piece('api', '_key = internationalizationconfiguration'),
    piece('api', '_key = INTERNATIONALIZATIONCONFIGURATION'),
    piece('to', 'ken = ', 'AbAb'.repeat(8)),
    piece('pass', 'word = ', 'a'.repeat(30)),
    piece('pass', 'word = ', 'aA'.repeat(16)),
    // ordinary prose after a keyword
    piece('to', 'ken: description of the thing'),
    piece('pass', 'word: Authentication is required for this endpoint'),
    piece('secret = "', 'short', 'Mixed', '"'),
  ), []);
});

// Marker-bearing credential-shaped values, assembled from pieces.
const FAKE_VALUES = [
  piece('gh', 'p_', 'EXAMPLEEXAMPLEEXAMPLE1234567890'),
  piece('AK', 'IA', 'IOSFODNN7EXAMPLE'),
  'password = "FAKE-Zk3pQ9vL2xR7tW5yB8nM4"',
  'api_key = Zk3pQ9vL2xR7tW5yEXAMPLE88',
  'https://deploy:FAKEpassword9@git.example.com/o/r',
];

const scanAt = (path, ...texts) => scanHygiene({
  addedLines: texts.map((text, i) => ({ path, line: i + 1, text })), paths: [], metadata: {}, denylist,
});

test('EXAMPLE / FAKE markers exempt credential-looking values in test-fixture paths', () => {
  for (const path of ['test/fixture.mjs', 'tests/unit/a.py', 'pkg/__tests__/b.js', 'src/a.test.mjs', 'src/b.spec.ts', 'test/runtime/c.test.mjs']) {
    assert.deepEqual(scanAt(path, ...FAKE_VALUES), [], path);
  }
  // The marker exempts credentials only, not host identifiers.
  assert.deepEqual(rules(scanAt('test/a.test.mjs', 'FAKE host ' + PRIVATE_IP)), ['HYG-IP']);
});

test('EXAMPLE / FAKE markers do not exempt credentials outside test-fixture paths', () => {
  for (const path of ['docs/a.md', 'runtime/lib/x.mjs', 'src/contest/a.mjs', 'README.md', 'test/notes.md', 'latest/x.mjs', 'a/../b.mjs', 'testing.mjs', '.test.mjs']) {
    const f = scanAt(path, ...FAKE_VALUES);
    assert.deepEqual(rules(f), new Array(FAKE_VALUES.length).fill('HYG-CRED'), path);
  }
});

test('EXAMPLE / FAKE markers never exempt commit messages, PR text, branch or authors', () => {
  const marked = FAKE_VALUES[2];
  const f = scanHygiene({
    addedLines: [], paths: ['test/fixture.test.mjs'], denylist,
    metadata: {
      commitMessages: [marked], authors: [marked], prTitle: marked, prBody: 'ok\n' + FAKE_VALUES[0], branch: 'rt/' + FAKE_VALUES[3].replace(/\s/g, ''),
    },
  });
  assert.deepEqual(f.map((x) => [x.ruleId, x.path, x.line]), [
    ['HYG-CRED', '<metadata:commit#1>', 1],
    ['HYG-CRED', '<metadata:author#1>', 0],
    ['HYG-CRED', '<metadata:prTitle>', 0],
    ['HYG-CRED', '<metadata:prBody>', 2],
    ['HYG-CRED', '<metadata:branch>', 0],
  ]);
});

test('an encoded marker value follows the same path rule', () => {
  const enc = Buffer.from(FAKE_VALUES[0]).toString('base64');
  assert.deepEqual(scanAt('test/a.test.mjs', 'x ' + enc), []);
  assert.deepEqual(rules(scanAt('docs/a.md', 'x ' + enc)), ['HYG-ENC']);
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

test('the member-access exemption does not apply inside string or template literals', () => {
  const host = ['config', 'local'].join('.');
  const other = ['user', 'home'].join('.');
  for (const text of [
    `const server = "${host}";`,
    `const server = '${host}';`,
    `const server = \`${host}\`;`,
    `const server = \`https-free ${other}/x\`;`,
    `connect("${host}", 22);`,
    `const a = 1, b = '${other}';`,
    `const s = "${host}`,
    `const e = "say \\"hi\\" to ${host}";`,
  ]) {
    assert.deepEqual(rules(scanCode(text)), ['HYG-FQDN'], text);
  }
  // Property access outside strings still passes, also next to complete string literals.
  assert.deepEqual(scanCode(
    `const a = ${CFG_LOCAL};`,
    `const b = ${PROC_HOME}; const c = ${THIS_LOCAL}; const d = ${USER_HOME};`,
    `const e = "x" + ${host} + 'y';`,
    `log("path", ${other}, \`ok\`);`,
  ), []);
});

// ---------------------------------------------------------------------------
// Gate 2 round 4 regressions (letters-only IPv6, bare quads shaped like a netmask, lowercase secrets).
// Every fixture is assembled from pieces so this file holds no address-shaped or secret-shaped literal.
// ---------------------------------------------------------------------------

test('letters-only IPv6 addresses fail; loopback, documentation and code-like tokens pass', () => {
  const eight = ['fade', 'bead', 'cafe', 'dead', 'beef', 'face', 'feed', 'deaf'].join(':');
  for (const addr of ['abcd' + '::' + 'cafe', 'dead:beef' + '::' + '1', 'ABCD' + '::' + 'CAFE', 'fade' + '::', eight]) {
    const f = scanLines(`peer ${addr} up`);
    assert.deepEqual(rules(f), ['HYG-IP'], addr);
    assert.equal(f[0].hash, hashText(addr));
  }
  assert.deepEqual(scanLines(
    'addr ::1 and 2001:db8:: and 2001:db8::1 and ::',
    'a' + '::' + 'b', 'ab' + '::' + 'c', 'Add' + '::' + 'fee', 'Cafe' + '::' + 'dead', 'std::vector', 'a:b:c:d:e:f',
  ), []);
});

test('a bare quad shaped like a netmask is an address; netmask context exempts it', () => {
  const quad = (...p) => ip(...p);
  for (const addr of [quad('128', '0', '0', '0'), quad('192', '0', '0', '0'), quad('224', '0', '0', '0'), quad('255', '255', '255', '255')]) {
    assert.deepEqual(rules(scanLines(`connect to ${addr} now`)), ['HYG-IP'], addr);
    // A CIDR network is an address, even with a prefix length.
    assert.deepEqual(rules(scanLines(`route ${addr}/8 via gateway`)), ['HYG-IP'], addr);
  }
  const m24 = quad('255', '255', '255', '0');
  assert.deepEqual(scanLines(
    `netmask ${m24}`, `Subnet: ${quad('255', '255', '0', '0')}`, `mask=${m24}`, `use /24, that is ${m24}`,
    `the prefix is ${quad('255', '255', '255', '128')}`, `netmask ${quad('128', '0', '0', '0')}`,
  ), []);
  // `addr mask` pair form: only the address is reported.
  const pair = scanLines(`inet ${PRIVATE_IP} ${m24}`);
  assert.deepEqual(pair.map((f) => f.hash), [hashText(PRIVATE_IP)]);
});

test('an all-lowercase high-entropy credential value fails; ordinary lowercase values pass', () => {
  const RANDOM_LOWER = piece('kzqw', 'jxvm', 'pbtr', 'nhgf', 'dlsy');
  for (const a of [
    piece('pass', 'word = "', RANDOM_LOWER, '"'),
    piece('sec', 'ret: ', RANDOM_LOWER),
    piece('api', '_key=', RANDOM_LOWER),
  ]) {
    assert.deepEqual(rules(scanAt('src/config.mjs', a)), ['HYG-CRED'], a);
    assert.deepEqual(rules(scanAt('docs/a.md', a)), ['HYG-CRED'], a);
    // A marker or capital glued to the random run does not hide it outside test paths.
    assert.deepEqual(rules(scanAt('docs/a.md', a.replace(RANDOM_LOWER, 'FAKE' + RANDOM_LOWER))), ['HYG-CRED'], a);
  }
  // In a test path the fake marker exempts; an unmarked value still fails.
  assert.deepEqual(scanAt('test/a.test.mjs', piece('pass', 'word = "', 'FAKE', RANDOM_LOWER, '"')), []);
  assert.deepEqual(rules(scanAt('test/a.test.mjs', piece('pass', 'word = "', RANDOM_LOWER, '"'))), ['HYG-CRED']);
  // Normal words, repeats, short values, and snake_case / kebab-case names stay clean.
  assert.deepEqual(scanAt('src/a.mjs',
    piece('pass', 'word: required'),
    piece('sec', 'ret: changeme'),
    piece('to', 'ken = authenticationtoken'),
    piece('pass', 'word = ', 'a'.repeat(24)),
    piece('pass', 'word = ', 'ab'.repeat(12)),
    piece('sec', 'ret = ', 'shortvalue'),
    piece('api', '_key = internationalizationconfiguration'),
    piece('to', 'ken = some_long_lowercase_identifier_name'),
    piece('sec', 'ret = a-long-kebab-case-reference-name'),
    piece('pass', 'word: the password field is optional for this endpoint'),
    piece('to', 'ken: refreshes automatically when expired'),
  ), []);
});
