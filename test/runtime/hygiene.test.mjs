import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadDenylist, scanHygiene, formatFindings, hashText, fakeHash, HygieneError, RULES, isTestFixturePath, normalizeText,
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
// Joins fixture pieces with a call (not a plus sign) so the source holds no spelled-out literal.
const cat = (...parts) => parts.join('');
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
const HOME_PATH = cat('/ho', 'me/', 'someone');
const MAC_PATH = cat('/Us', 'ers/', 'someone');
const WIN_PATH = cat('C:\\Us', 'ers\\', 'someone');
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
const HASH_RE = /^[0-9a-f]{8}$/;
// Findings carry a per-run keyed hash (never the plain digest of the matched text).
const TEST_RUN_ID = 'fixed-test-salt-0123456789';
// Order-insensitive view of findings: [ruleId, path, line] sorted.
const keyOf = (findings) => findings.map((x) => [x.ruleId, x.path, x.line].join('|')).sort();
// A denylist file written by the test: owner-only mode, as a trusted deployment has it.
const writeDeny = (file, content) => { writeFileSync(file, content); chmodSync(file, 0o600); };

test('private and public IPv4 addresses fail', () => {
  for (const addr of [PRIVATE_IP, PRIVATE_IP2, ip('172', '16', '4', '9'), PUBLIC_IP, ip('169', '254', '1', '1')]) {
    const f = scanLines(`connect to ${addr} now`);
    assert.deepEqual(rules(f), ['HYG-IP'], addr);
    assert.equal(f[0].path, 'docs/a.md');
    assert.equal(f[0].line, 1);
    // Low-entropy matches carry no length and a keyed hash (H-83): not the plain digest.
    assert.equal(f[0].length, 0);
    assert.match(f[0].hash, HASH_RE);
    assert.notEqual(f[0].hash, hashText(addr));
  }
});

test('IPv6 non-doc addresses fail, doc range and loopback pass', () => {
  const priv = ['fd00', '0', '0', '0', '0', '0', '0', '1'].join(':');
  const pub = ['2606', '4700', '', '1111'].join(':');
  const linkLocal = cat('fe80', '::1');
  assert.deepEqual(rules(scanLines(`addr ${priv}`)), ['HYG-IP']);
  assert.deepEqual(rules(scanLines(`addr ${pub}`)), ['HYG-IP']);
  assert.deepEqual(rules(scanLines(`addr [${linkLocal}]:22`)), ['HYG-IP']);
  assert.deepEqual(scanLines('addr 2001:db8::1 and ::1 and [2001:db8:85a3::8a2e:370:7334]:80'), []);
  assert.deepEqual(scanLines('std::vector, 12:30:45, aa:bb:cc:dd:ee:ff'), []);
  // Word-like scope paths stay clean in code files only (see the letters-only IPv6 tests below).
  assert.deepEqual(scanCode('std::vector, Add::fee, 12:30:45, aa:bb:cc:dd:ee:ff'), []);
});

test('documentation ranges, loopback and netmasks pass', () => {
  assert.deepEqual(scanLines(
    `use ${ip('192', '0', '2', '10')} or ${ip('198', '51', '100', '7')} or ${ip('203', '0', '113', '250')}`,
    `listen on ${LOOPBACK} and ${UNSPEC}, mask ${NETMASK}`,
  ), []);
});

test('five-part version-like strings pass; H-53: a v prefix or package words never exempt a four-part quad', () => {
  assert.deepEqual(scanLines(`build ${FIVE_PART} is odd`, `see ${FIVE_PART}.6 too`), []);
  assert.deepEqual(rules(scanLines(`release v${SEMVER4} is out`)), []);
  assert.deepEqual(rules(scanLines(`tag V${SEMVER4C}`)), ['HYG-IP']);
  assert.deepEqual(rules(scanLines(`install pkg@${SEMVER4} now`)), ['HYG-IP']);
  assert.deepEqual(rules(scanLines(`root@${PRIVATE_IP} install notes version`)), ['HYG-IP']);
  assert.deepEqual(rules(scanLines(`yarn add left-pad@${SEMVER4B}`)), ['HYG-IP']);
  assert.deepEqual(rules(scanLines(`v${PRIVATE_IP}`)), ['HYG-IP']);
});

// ---- Narrow version exemption (28-F9): exact version key / release heading in the right file kind ----
const ruleSet = (findings) => [...new Set(rules(findings))];
function scanVer(path, ...texts) {
  return scanHygiene({
    addedLines: texts.map((text, i) => ({ path, line: i + 1, text })),
    paths: [], metadata: {}, denylist,
  });
}
const CGNAT_IP = ip('100', '64', '1', '2');
const LINKLOCAL_IP = ip('169', '254', '1', '2');
const PRIVATE_172 = ip('172', '16', '0', '9');
const PADDED_QUAD = ip('010', '0', '0', '5');
const HEX_QUAD = ip('0x0a', '0', '0', '5');
const DATE = ['2026', '01', '02'].join('-');

test('a four-part semver in a manifest "version" key passes (package.json, lockfiles, toml, yaml)', () => {
  assert.deepEqual(scanVer('package.json', `  "version": "${SEMVER4}",`, `"version":"${SEMVER4B}"`), []);
  assert.deepEqual(scanVer('pkg/sub/package-lock.json', `    "version": "${SEMVER4C}"`), []);
  assert.deepEqual(scanVer('composer.lock', `            "version": "${SEMVER4}",`), []);
  assert.deepEqual(scanVer('deps/yarn.lock', `  version "${SEMVER4}"`), []);
  assert.deepEqual(scanVer('Cargo.toml', `version = "${SEMVER4}"`), []);
  assert.deepEqual(scanVer('pubspec.yaml', `version: ${SEMVER4}`), []);
  // The H-53 trade-off: a plausible public address in the exact version key passes.
  assert.deepEqual(scanVer('package.json', `  "version": "${PUBLIC_IP}",`), []);
  // A line after a trailing comma joins with the next line; the version line keeps its exemption.
  assert.deepEqual(scanVer('package.json', `  "version": "${SEMVER4}",`, '  "private": true'), []);
});

test('a release heading in a markdown or text file passes', () => {
  assert.deepEqual(scanVer('CHANGELOG.md', `## ${SEMVER4}`, `## v${SEMVER4B} - ${DATE}`, `## [${SEMVER4C}]`,
    `# [v${SEMVER4}] (${DATE})`, `### ${SEMVER4B} - ${DATE}`), []);
  assert.deepEqual(scanVer('docs/HISTORY.txt', `## ${SEMVER4}`), []);
  assert.deepEqual(scanVer('docs/NEWS.rst', `## v${SEMVER4}`), []);
});

test('H-53: the same version strings fail outside a recognized version context', () => {
  const cases = [
    ['src/a.mjs', `"version": "${SEMVER4}"`],
    ['src/a.mjs', `version = "${SEMVER4}"`],
    ['src/a.mjs', `## ${SEMVER4}`],
    ['docs/a.md', `"version": "${SEMVER4}"`],            // a version key is not a heading
    ['docs/a.md', `## release ${SEMVER4} is out`],        // heading with extra words
    ['docs/a.md', `## ${SEMVER4} and ${PUBLIC_IP}`],
    ['docs/a.md', `    ## ${SEMVER4}`],                  // indented: code block, not a heading
    ['docs/a.md', `- ## ${SEMVER4}`],
    ['config/settings.json', `"version": "${SEMVER4}"`],  // not a named manifest
    ['package.json', `"name": "${SEMVER4}"`],             // key is not exactly version
    ['package.json', `"appversion": "${SEMVER4}"`],
    ['package.json', `  "version": "${SEMVER4}", "host": "${PUBLIC_IP}"`],
    ['package.json', `  "version": "pkg@${SEMVER4}"`],
    ['package.json', `  "scripts": "install pkg@${SEMVER4}"`],
    ['package.json', `  "version": "${SEMVER4}-rc1"`],
    ['package.json', `  "version": "${SEMVER4}" // ${PUBLIC_IP}`],
    ['.github/workflows/ci.yml', `version: ${SEMVER4}`],
    ['scripts/run.sh', `version=${SEMVER4}`],
  ];
  for (const [path, text] of cases) assert.deepEqual(ruleSet(scanVer(path, text)), ['HYG-IP'], `${path}: ${text}`);
});

test('H-53: a version-looking number that is a private, CGNAT or link-local address is never exempt', () => {
  for (const q of [PRIVATE_IP, PRIVATE_IP2, PRIVATE_172, CGNAT_IP, LINKLOCAL_IP]) {
    assert.deepEqual(ruleSet(scanVer('package.json', `  "version": "${q}",`)), ['HYG-IP'], q);
    assert.deepEqual(ruleSet(scanVer('Cargo.toml', `version = "${q}"`)), ['HYG-IP'], q);
    assert.deepEqual(ruleSet(scanVer('CHANGELOG.md', `## ${q}`)), ['HYG-IP'], q);
    assert.deepEqual(ruleSet(scanVer('CHANGELOG.md', `## v${q} - ${DATE}`)), ['HYG-IP'], q);
  }
  // A padded or hex segment is not a plain decimal version and stays scanned.
  assert.deepEqual(ruleSet(scanVer('package.json', `  "version": "${PADDED_QUAD}"`)), ['HYG-IP']);
  assert.deepEqual(ruleSet(scanVer('package.json', `  "version": "${HEX_QUAD}"`)), ['HYG-IP']);
});

test('H-53: the exemption skips one number only; an address elsewhere in the diff is still found', () => {
  assert.deepEqual(ruleSet(scanVer('package.json', `  "version": "${SEMVER4}",`, `  "host": "${PUBLIC_IP}"`)), ['HYG-IP']);
  assert.deepEqual(ruleSet(scanVer('CHANGELOG.md', `## ${SEMVER4}`, `root@${PRIVATE_IP} install`)), ['HYG-IP']);
  // The exempt string is not exempt on a different line of the same file.
  assert.deepEqual(ruleSet(scanVer('CHANGELOG.md', `## ${SEMVER4}`, `see ${SEMVER4} for details`)), ['HYG-IP']);
});

test('H-53: version strings in commit messages, PR text, branch names and paths stay flagged', () => {
  const meta = (m) => scanHygiene({ addedLines: [], paths: [], metadata: m, denylist });
  assert.deepEqual(ruleSet(meta({ commitMessages: [`## ${SEMVER4}`] })), ['HYG-IP']);
  assert.deepEqual(ruleSet(meta({ commitMessages: [`release v${SEMVER4}`] })), []);
  assert.deepEqual(ruleSet(meta({ prBody: `## ${SEMVER4}` })), ['HYG-IP']);
  assert.deepEqual(ruleSet(meta({ prTitle: `bump to v${SEMVER4}` })), []);
  assert.deepEqual(ruleSet(meta({ branch: `release/${SEMVER4}` })), ['HYG-IP']);
  assert.deepEqual(ruleSet(scanHygiene({ addedLines: [], paths: [`docs/CHANGELOG-${SEMVER4}/notes.md`], metadata: {}, denylist })), ['HYG-IP']);
});

test('H-53: a pre-release suffix never makes a four-part quad a version', () => {
  for (const text of [
    `release v${SEMVER4}-rc1 is out`,
    `npm install pkg@${SEMVER4}-rc1`,
    `requires @scope/pkg@${SEMVER4}-beta`,
    `connect to ${SEMVER4}-rc1 now`,
    `deploy@${PUBLIC_IP}-rc1`,
    `git clone git@${SEMVER4}-rc1:o/r.git`,
  ]) assert.deepEqual(rules(scanLines(text)), ['HYG-IP'], text);
});

test('an @ prefix does not hide an address in an ssh command', () => {
  assert.deepEqual(rules(scanLines(`ssh deploy@${PUBLIC_IP}`)), ['HYG-IP']);
});

test('an address behind an @ prefix fails without an ssh word; package-looking forms fail too (H-53)', () => {
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
    `npm install pkg@${SEMVER4}`,
    `requires @scope/pkg@${SEMVER4} or later`,
  ]) {
    assert.deepEqual(rules(scanLines(text)), ['HYG-IP'], text);
  }
  assert.deepEqual(scanLines(`build ${FIVE_PART} is odd`), []);
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
  assert.deepEqual(f.map((x) => x.ruleId), new Array(6).fill('HYG-FQDN'));
  assert.deepEqual(f.map((x) => `${x.path}|${x.line}`).filter((k) => !k.startsWith('<path:')).sort(), [
    '<metadata:author#1>|0', '<metadata:branch>|0', '<metadata:commit#1>|1', '<metadata:prBody>|2', '<metadata:prTitle>|0',
  ]);
  assert.equal(f.filter((x) => /^<path:[0-9a-f]{8}>$/.test(x.path)).length, 1);
  // JS property access in code files still passes.
  for (const path of ['src/a.mjs', 'a.cjs', 'b.js', 'c.ts', 'd.tsx', 'e.jsx', 'f.json', 'lib/G.MJS']) {
    assert.deepEqual(scanAt(path, `const a = ${CFG_LOCAL}; x = ${PROC_HOME}; ${THIS_LOCAL} = 1; ${USER_HOME} = 2;`), [], path);
  }
  // In a code file the ssh / URL / user@ host contexts still fail.
  for (const text of [`ssh ${host}`, `ssh admin@${host}`, `open https://${host}/x`, `scp f ${host}:/tmp`, `contact admin@${host}`]) {
    assert.deepEqual(rules(scanAt('src/a.mjs', text)), ['HYG-FQDN'], text);
  }
  // A real host name in a code file also still fails.
  assert.deepEqual(rules(scanAt('src/a.mjs', cat('const h = "db1.', 'local";'))), ['HYG-FQDN']);
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
  // Changed expectation (H-60): a distinctive name glued to other letters is still a hit, because
  // glued and separator-padded forms are how an author hides it. Unrelated text stays clean.
  assert.deepEqual(rules(scanLines('xfixturehost-examplex')), ['HYG-HOST']);
  assert.deepEqual(scanLines('fixture host and example user, nothing else'), []);
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
  assert.equal(rules(scanLines(cat('ping toolbox.', 'lan'))).includes('HYG-HOST'), true);
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
  for (const p of [HOME_PATH + '/notes', MAC_PATH + '/x', WIN_PATH + '\\x', cat('/ro', 'ot/.ssh'), cat('~', 'someone/bin')]) {
    assert.deepEqual(rules(scanLines(`cd ${p}`)), ['HYG-HOMEPATH'], p);
  }
  assert.deepEqual(rules(scanLines(cat('{"p": "C:\\\\Us', 'ers\\\\someone\\\\x"}'))), ['HYG-HOMEPATH']);
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
  assert.deepEqual(keyOf(f), [
    'HYG-HOMEPATH|<metadata:branch>|0', 'HYG-HOMEPATH|<metadata:commit#1>|3',
    'HYG-HOMEPATH|<metadata:prBody>|2', 'HYG-HOMEPATH|<metadata:prTitle>|0',
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
  assert.deepEqual(f.map((x) => `${x.ruleId}|${x.path}`).sort(), [
    'HYG-HOST|<metadata:prBody>', 'HYG-IP|<metadata:commit#1>', 'HYG-USER|<metadata:author#1>',
  ]);
});

test('added and renamed paths are scanned and reported without echoing the path', () => {
  const bad = 'docs/fixturehost-example/notes.md';
  const f = scanHygiene({ addedLines: [], paths: ['docs/ok.md', bad], metadata: {}, denylist, salt: TEST_RUN_ID });
  assert.deepEqual(rules(f), ['HYG-HOST']);
  assert.match(f[0].path, /^<path:[0-9a-f]{8}>$/);
  assert.notEqual(f[0].path, `<path:${hashText(bad)}>`); // keyed, not the plain digest
  assert.ok(!JSON.stringify(f).includes('fixturehost-example'));
  // Added lines in a dirty file are reported under the same redacted path (same salt).
  const g = scanHygiene({ addedLines: [{ path: bad, line: 4, text: 'x ' + PRIVATE_IP }], paths: [], metadata: {}, denylist, salt: TEST_RUN_ID });
  assert.equal(g[0].path, f[0].path);
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
  // Changed expectation (H-74): a marker glued to a random value no longer exempts it, even in a
  // test path; only a value that is wholly a fake (marker plus harmless filler) is exempt.
  assert.deepEqual(rules(scanAt('test/a.test.mjs', assigns[0])), ['HYG-CRED']);
  assert.deepEqual(rules(scanAt('test/a.test.mjs', piece('api', '_key = "', 'EXAMPLE', LETTERS_ONLY, '"'))), ['HYG-CRED']);
  assert.deepEqual(scanAt('test/a.test.mjs', piece('api', '_key = "', 'EXAMPLE', '1234567890', '"')), []);
});

test('H-69: a camelCase dollar value is not in the closed placeholder set and fails', () => {
  // Changed expectation: only $NAME / ${NAME} / lowercase-letter names are placeholders; a mixed-case
  // value that starts with a dollar sign can be a real secret, so it is reported.
  assert.deepEqual(rules(scanAt('src/a.mjs', piece('pass', 'word = $passwordFromTheEnvironment'))), ['HYG-CRED']);
  assert.deepEqual(rules(scanAt('src/a.mjs', piece('pass', 'word = ${Zk3pQ9vL2xR7tW5yB8nM4}'))), ['HYG-CRED']);
});

test('references, identifiers, low-entropy and ordinary prose values do not trigger the letter-only rule', () => {
  assert.deepEqual(scanAt('src/a.mjs',
    piece('pass', 'word: getPasswordFromEnv()'),
    piece('to', 'ken = process.env.TOKEN_NAME'),
    piece('to', 'ken = process.env.someLongMixedCaseName'),
    piece('to', 'ken = config.getSecretValueStore'),
    piece('pass', 'word = ${PASSWORD_VALUE_FROM_ENV}'),
    piece('pass', 'word = $PASSWORD_FROM_ENV'),
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
  'password = "FAKEFAKEFAKE1234567890"',
  'api_key = EXAMPLEEXAMPLE1234567890',
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
    // Every line is flagged (a line may carry more than one finding).
    assert.deepEqual([...new Set(f.map((x) => x.line))].sort(), FAKE_VALUES.map((_, i) => i + 1), path);
    assert.ok(rules(f).every((r) => r === 'HYG-CRED'), path);
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
  assert.deepEqual(keyOf(f), [
    'HYG-CRED|<metadata:author#1>|0', 'HYG-CRED|<metadata:branch>|0', 'HYG-CRED|<metadata:commit#1>|1',
    'HYG-CRED|<metadata:prBody>|2', 'HYG-CRED|<metadata:prTitle>|0',
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
  const allowlist = { testFakes: [{ path: 'test/fake.test.mjs', hash: fakeHash(secret) }] };
  const mk = (path) => scanHygiene({
    addedLines: [{ path, line: 1, text: 'k = ' + secret }], paths: [], metadata: {}, denylist, allowlist,
  });
  assert.deepEqual(mk('test/fake.test.mjs'), []);
  assert.deepEqual(rules(mk('test/other.test.mjs')), ['HYG-CRED']);
  // Metadata can never be exempted through the allowlist.
  const meta = scanHygiene({
    addedLines: [], paths: [], denylist,
    metadata: { prBody: secret },
    allowlist: { testFakes: [{ path: '<metadata:prBody>', hash: fakeHash(secret) }] },
  });
  assert.deepEqual(rules(meta), ['HYG-CRED']);
  assert.throws(() => scanHygiene({ addedLines: [], denylist, allowlist: { testFakes: 'x' } }), HygieneError);
  // The 32-bit digest form is rejected: entries need the full sha256 (H-75).
  assert.throws(() => scanHygiene({ addedLines: [], denylist, allowlist: { testFakes: [{ path: 'a', hash: hashText(secret) }] } }), HygieneError);
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
    writeDeny(file, '{ "hostnames": not-json fixturehost-example');
    assert.throws(() => loadDenylist({ env: { RT_HOME: dir }, hostRun: true }), (err) => {
      assert.ok(!err.message.includes('fixturehost-example'));
      assert.ok(!err.message.includes(dir));
      return true;
    });
    writeDeny(file, JSON.stringify({ hostnames: { distinctive: ['bad name!'] } }));
    assert.throws(() => loadDenylist({ env: { RT_HOME: dir }, hostRun: true }), (err) => !err.message.includes('bad name'));
    writeDeny(file, JSON.stringify({}));
    assert.throws(() => loadDenylist({ env: { RT_HOME: dir }, hostRun: true }), (err) => err instanceof HygieneError && err.code === 'DENYLIST_EMPTY' && /empty/.test(err.message));
    // A valid file loads and is normalized.
    writeDeny(file, JSON.stringify({ hostnames: { distinctive: ['Fixturehost-Example'] }, usernames: { common: ['builder'] } }));
    const d = loadDenylist({ env: { RT_HOME: dir }, hostRun: true });
    assert.deepEqual(d.hostnames.distinctive, ['fixturehost-example']);
    assert.deepEqual(d.usernames.common, ['builder']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a host run ignores an injected fixture: the production file must exist and be valid', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hyg-'));
  try {
    // Fixture + missing RT_HOME / missing file: throws (fail closed), no matter what was injected.
    for (const env of [{}, { RT_HOME: dir }]) {
      assert.throws(() => loadDenylist({ env, hostRun: true, fixture: FIXTURE }), (err) => {
        assert.ok(err instanceof HygieneError);
        assert.match(err.code, /^DENYLIST_/);
        return true;
      });
    }
    // Fixture + invalid file: throws as well.
    mkdirSync(join(dir, 'gate0'));
    const file = join(dir, 'gate0', 'denylist.json');
    writeDeny(file, '{ not json');
    assert.throws(() => loadDenylist({ env: { RT_HOME: dir }, hostRun: true, fixture: FIXTURE }), HygieneError);
    // Fixture + valid file: the file contents are used, not the fixture.
    writeDeny(file, JSON.stringify({ hostnames: { distinctive: ['filehost-example'] }, usernames: {} }));
    const d = loadDenylist({ env: { RT_HOME: dir }, hostRun: true, fixture: FIXTURE });
    assert.deepEqual(d.hostnames.distinctive, ['filehost-example']);
    assert.deepEqual(d.usernames.common, []);
    const hits = scanHygiene({ addedLines: [{ path: 'docs/a.md', line: 1, text: 'see filehost-example and fixturehost-example' }], paths: [], metadata: {}, denylist: d });
    assert.deepEqual(rules(hits), ['HYG-HOST']);
    assert.match(hits[0].hash, HASH_RE);
    // A non-host run still honors the injected fixture.
    assert.deepEqual(loadDenylist({ env: { RT_HOME: dir }, fixture: FIXTURE }).hostnames.distinctive, ['fixturehost-example']);
    assert.deepEqual(loadDenylist({ fixture: FIXTURE }).usernames.distinctive, ['fixtureuser-example']);
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
  for (const addr of [cat('abcd', '::', 'cafe'), cat('dead:beef', '::', '1'), cat('ABCD', '::', 'CAFE'), cat('fade', '::'), eight]) {
    const f = scanLines(`peer ${addr} up`);
    assert.deepEqual(rules(f), ['HYG-IP'], addr);
    assert.match(f[0].hash, HASH_RE);
  }
  assert.deepEqual(scanLines(
    'addr ::1 and 2001:db8:: and 2001:db8::1 and ::', 'std::vector', 'a:b:c:d:e:f',
  ), []);
  // Word-like scope paths (short or mixed-case) are exempt only as identifiers in code files.
  assert.deepEqual(scanCode(
    'a' + '::' + 'b', 'ab' + '::' + 'c', 'Add' + '::' + 'fee', 'Cafe' + '::' + 'dead', 'std::vector', 'Result::Err',
  ), []);
});

test('letters-only IPv6 is flagged in prose, metadata and paths; code gets only the scope-path exemption', () => {
  const a = 'a' + '::' + 'b';
  const mixed = 'Cafe' + '::' + 'dead';
  const addFee = 'Add' + '::' + 'fee';
  // Non-code file: flagged always, whatever the case or length.
  for (const tok of [a, mixed, addFee, cat('abcd', '::', 'cafe')]) {
    const f = scanLines(`value ${tok} here`);
    assert.deepEqual(rules(f), ['HYG-IP'], tok);
    assert.match(f[0].hash, HASH_RE);
    assert.deepEqual(rules(scanAt('notes.txt', `x ${tok}`)), ['HYG-IP'], tok);
    assert.deepEqual(rules(scanAt('config.yaml', `x: ${tok}`)), ['HYG-IP'], tok);
    assert.deepEqual(rules(scanAt('Makefile', `x ${tok}`)), ['HYG-IP'], tok);
  }
  // Commit message, PR title / body, branch name, author and path.
  const meta = scanHygiene({
    addedLines: [], paths: [`docs/${a}.md`], denylist,
    metadata: { commitMessages: [`Fix ${mixed}`], prTitle: `Use ${a}`, prBody: `line\nsee ${a}`, branch: `rt/${a}`, authors: [`Dev ${mixed}`] },
  });
  assert.deepEqual([...new Set(rules(meta))], ['HYG-IP']);
  assert.deepEqual(
    meta.map((f) => f.path).filter((p) => p.startsWith('<metadata:')).sort(),
    ['<metadata:author#1>', '<metadata:branch>', '<metadata:commit#1>', '<metadata:prBody>', '<metadata:prTitle>'],
  );
  assert.ok(meta.some((f) => f.path.startsWith('<path:')));
  // Code file: scope-resolution paths pass; a single-case address-like token still fails.
  assert.deepEqual(scanCode(
    `let x = ${addFee};`, `let y = ${a};`, `let z = ${mixed};`, 'let v = std::vector::new();', 'let e = Foo::bar();', 'let r = Result::Err(1);',
  ), []);
  assert.deepEqual(scanAt('src/lib.rs', `let x = ${addFee};`, 'let y = Result::Err(1);'), []);
  assert.deepEqual(rules(scanCode(`let peer = ${cat('abcd', '::', 'cafe')};`)), ['HYG-IP']);
  assert.deepEqual(rules(scanAt('src/lib.rs', `let peer = ${cat('abcd', '::', 'cafe')};`)), ['HYG-IP']);
  // Host context in code: the exemption is lost.
  for (const line of [
    `exec("ssh ${a}")`, `scp file ${mixed} /tmp`, `const url = "http://[${a}]:80/";`, `connect("user@${a}")`,
    `const addr = ${a};`, `// host ${mixed}`, `let ip = ${addFee};`,
  ]) {
    assert.deepEqual(rules(scanCode(line)), ['HYG-IP'], line);
  }
  // Loopback and documentation addresses keep passing everywhere.
  assert.deepEqual(scanLines('see ::1 and 2001:db8::5 here'), []);
  assert.deepEqual(scanCode('see ::1 and 2001:db8::5 here'), []);
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
  assert.equal(pair.length, 1);
  assert.deepEqual(rules(pair), ['HYG-IP']);
  assert.deepEqual(pair, scanHygiene({ addedLines: [{ path: 'docs/a.md', line: 1, text: `inet ${PRIVATE_IP} ${m24}` }], paths: [], metadata: {}, denylist, salt: 'x'.repeat(8) }).map((f) => ({ ...f, hash: pair[0].hash })));
  assert.deepEqual(scanHygiene({ addedLines: [{ path: 'docs/a.md', line: 1, text: `inet ${PRIVATE_IP}` }], paths: [], metadata: {}, denylist, salt: TEST_RUN_ID })[0].hash,
    scanHygiene({ addedLines: [{ path: 'docs/a.md', line: 1, text: `inet ${PRIVATE_IP} ${m24}` }], paths: [], metadata: {}, denylist, salt: TEST_RUN_ID })[0].hash);
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
  // Changed expectation (H-74): a marker glued to a random value no longer exempts it.
  assert.deepEqual(rules(scanAt('test/a.test.mjs', piece('pass', 'word = "', 'FAKE', RANDOM_LOWER, '"'))), ['HYG-CRED']);
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

test('uppercase credentials with digits and underscores are rejected', () => {
  const value = piece('K9QW_', 'J7VM_', 'P2TR_', 'N8GF_', 'D4SY');
  for (const path of ['src/config.mjs', 'docs/a.md']) {
    assert.deepEqual(rules(scanAt(path, piece('to', 'ken = ', value))), ['HYG-CRED']);
  }
});

test('an all-uppercase high-entropy credential value fails; reference-like and low-entropy values pass', () => {
  const RANDOM_UPPER = piece('KZQW', 'JXVM', 'PBTR', 'NHGF', 'DLSY', 'CEUA');
  for (const a of [
    piece('pass', 'word = "', RANDOM_UPPER, '"'),
    piece('sec', 'ret: ', RANDOM_UPPER),
    piece('api', '_key=', RANDOM_UPPER),
    piece('to', 'ken = ', RANDOM_UPPER.slice(0, 24)),
  ]) {
    assert.deepEqual(rules(scanAt('src/config.mjs', a)), ['HYG-CRED'], a);
    assert.deepEqual(rules(scanAt('docs/a.md', a)), ['HYG-CRED'], a);
  }
  assert.equal(new Set(RANDOM_UPPER.slice(0, 24)).size >= 16, true);
  // In a test path the fake marker still exempts; an unmarked value fails.
  // Changed expectation (H-74): the marker must be the whole value, so a glued marker no longer exempts.
  assert.deepEqual(rules(scanAt('test/a.test.mjs', piece('pass', 'word = "FAKE', RANDOM_UPPER, '"'))), ['HYG-CRED']);
  assert.deepEqual(scanAt('test/a.test.mjs', piece('pass', 'word = "FAKEFAKE', '123456', '"')), []);
  assert.deepEqual(rules(scanAt('test/a.test.mjs', piece('pass', 'word = "', RANDOM_UPPER, '"'))), ['HYG-CRED']);
  assert.deepEqual(scanAt('src/a.mjs',
    piece('pass', 'word: REQUIRED'),
    piece('to', 'ken = MY_ENV_VAR_NAME'),
    piece('sec', 'ret: CHANGEME'),
    piece('to', 'ken = PROCESS_ENV_X'),
    piece('api', '_key = API_KEY_NAME'),
    piece('pass', 'word = ', 'A'.repeat(24)),
    piece('pass', 'word = ', 'AB'.repeat(12)),
    piece('sec', 'ret = ', 'LONGWORDSHORTNAMES'.slice(0, 8)),
    piece('pass', 'word = ', 'PROCESS', '.env.X'),
    piece('pass', 'word = $', 'SOME_VARIABLE_NAME'),
  ), []);
});

// ---------------------------------------------------------------------------
// Threat-model regressions (28-D2b / 28-D2c). Fixtures are assembled from pieces at runtime.
// ---------------------------------------------------------------------------

const scanWith = (texts, opts = {}) => scanHygiene({
  addedLines: texts.map((text, i) => ({ path: opts.path || 'docs/a.md', line: i + 1, text })),
  paths: [], metadata: {}, denylist, salt: TEST_RUN_ID,
});
const hits = (text, path) => rules(scanWith([text], { path }));
const intOf = (a, b, c, d) => ((a * 256 + b) * 256 + c) * 256 + d;
const hex8 = (a, b, c, d) => [a, b, c, d].map((x) => x.toString(16).padStart(2, '0')).join('');

test('H-52: decimal, hex, octal, padded and three-part spellings of an address fail', () => {
  assert.deepEqual(hits(`ping ${intOf(8, 8, 4, 4)}`), ['HYG-IP']);
  assert.deepEqual(hits(`ping 0x${hex8(8, 8, 4, 4)}`), ['HYG-IP']);
  assert.deepEqual(hits(`host ${ip('010', '0', '0', '5')}`), ['HYG-IP']);
  assert.deepEqual(hits(`host ${ip('0x0a', '0', '0', '5')}`), ['HYG-IP']);
  assert.deepEqual(hits(`ssh ${ip('10', '0', '5')}`), ['HYG-IP']);
  assert.deepEqual(hits(`x ${ip('008', '008', '004', '004')}`), ['HYG-IP']);
  // A plain number with no address context is not an address.
  assert.deepEqual(hits('total 134743044 bytes'), []);
});

test('H-54: leading dot, defanged separators and HTML entities do not hide an address', () => {
  const quad = ip('8', '8', '4', '4');
  assert.deepEqual(hits(`x ${ip('.8', '8', '4', '4')}`), ['HYG-IP']);
  assert.deepEqual(hits(`x ${quad.replace(/\./g, '[.]')}`), ['HYG-IP']);
  assert.deepEqual(hits(`x ${quad.replace(/\./g, ' (dot) ')}`), ['HYG-IP']);
  assert.deepEqual(hits(`x ${quad.replace(/\./g, '&#46;')}`), ['HYG-IP']);
  assert.deepEqual(hits(`x ${quad.replace(/\./g, '%2e')}`), ['HYG-ENC']);
});

test('H-56 / H-57: glued IPv6 prefixes, mapped IPv4 and zone ids fail', () => {
  const v6 = cat('fd00', '::1');
  assert.deepEqual(hits('ip:' + v6), ['HYG-IP']);
  assert.deepEqual(hits('addr_' + v6), ['HYG-IP']);
  assert.deepEqual(hits('::ffff:' + ip('8', '8', '4', '4')), ['HYG-IP']);
  assert.deepEqual(hits(cat('[::ffff:', '0808:', '0404]')), ['HYG-IP']);
  assert.deepEqual(hits(cat('fe80', '::1%eth0')), ['HYG-IP']);
  // Documentation range with a plain low word stays clean.
  assert.deepEqual(hits('2001:db8::1'), []);
});

test('H-58: encoded address blobs (percent, base64, double base64, hex) fail as HYG-ENC', () => {
  const quad = ip('8', '8', '4', '4');
  const b64 = Buffer.from(quad).toString('base64');
  assert.deepEqual(hits(`x ${b64}`), ['HYG-ENC']);
  assert.deepEqual(hits(`x ${Buffer.from(b64).toString('base64')}`), ['HYG-ENC']);
  assert.deepEqual(hits(`x ${Buffer.from(quad).toString('hex')}`), ['HYG-ENC']);
  assert.deepEqual(hits(`x ${quad.replace(/\./g, '%2E')}`), ['HYG-ENC']);
});

test('H-60: zero-width, soft hyphen, full-width, Cyrillic and separator forms of a denylisted name fail', () => {
  const name = 'fixtureuser-example';
  for (const variant of [
    'fixtureu\u200bser-example',
    '\uff46ixtureuser-example',
    'f\u0456xtureuser-example',
    'fixtureuser\u00adexample',
    'FIXTURE USER EXAMPLE',
    'fixtureuser_example',
    name.toUpperCase(),
  ]) assert.deepEqual(hits(`see ${variant}`), ['HYG-USER'], JSON.stringify(variant));
  assert.equal(normalizeText('a\u200bb\uff21'), 'abA');
});

test('H-61: home paths in every OS form fail (WSL mount, case variants, file URL, drive letters, tilde user)', () => {
  const U = cat('Us', 'ers');
  for (const p of [
    `/mnt/c/${U}/bob/x`, cat('/HO', 'ME/bob'), `file:///${U}/bob`, `C:/${U}/bob`, `\\\\?\\C:\\${U}\\bob`,
    cat('/ho', 'me/bob'), cat('~', 'bob/x'), cat('/mnt/c/', U.toLowerCase(), '/bob'), cat('/ro', 'ot/'),
  ]) assert.ok(hits(`cd ${p}`).includes('HYG-HOMEPATH'), p);
  assert.deepEqual(hits('cd /var/lib/app'), []);
});

test('H-67..H-73: credential shapes: underscore tokens, flags, camelCase names, XML, JSON, dollar and brace values', () => {
  const val = 'Zk3pQ9vL2xR7tW5y';
  const cases = [
    piece('sk_li', 've_', val, 'B8nM4cD6'),
    piece('--pass', 'word ', val),
    piece('db', 'Password = "', val, '"'),
    piece('<pass', 'word>', val, '</pass', 'word>'),
    piece('{"pass', 'word":"', val, '"}'),
    piece('pass', 'word = $', val),
    piece('pass', 'word = {', val, '}'),
    piece('Authorization: Bea', 'rer ', val, 'B8nM4cD6'),
    piece('xgh', 'p_', val, 'B8nM4cD6fH1jK0aS'),
  ];
  for (const c of cases) assert.deepEqual(hits(c), ['HYG-CRED'], c);
  // Closed placeholder set still passes.
  assert.deepEqual(hits(piece('pass', 'word = ${PASSWORD_FROM_ENV}')), []);
  assert.deepEqual(hits(piece('pass', 'word = <your-password>')), []);
});

test('H-49: a credential split across consecutive added lines with a continuation is joined', () => {
  assert.deepEqual(rules(scanWith([piece('x = "gh', 'p_" +'), '"Zk3pQ9vL2xR7tW5yB8nM4cD6fH1jK0aS"'])), ['HYG-CRED']);
});

test('H-74: a fake marker exempts only a wholly fake value and only in a test path', () => {
  const glued = piece('pass', 'word = "FAKE', 'Zk3pQ9vL2xR7tW5yB8nM4', '"');
  assert.deepEqual(hits(glued, 'test/a.test.mjs'), ['HYG-CRED']);
  assert.deepEqual(hits(piece('pass', 'word = "FAKEFAKE1234567890"'), 'test/a.test.mjs'), []);
  assert.deepEqual(hits(piece('pass', 'word = "FAKEFAKE1234567890"'), 'docs/a.md'), ['HYG-CRED']);
  assert.equal(isTestFixturePath('test/a.test.mjs'), true);
  assert.equal(isTestFixturePath('docs/a.md'), false);
  assert.equal(isTestFixturePath('test/notes.md'), false);
});

test('H-75: allowlist entries need the full sha256 and match path and value exactly', () => {
  const secret = piece('s', 'k-', 'Zk3pQ9vL2xR7tW5yB8nM4cD6');
  assert.match(fakeHash(secret), /^[0-9a-f]{64}$/);
  const allowlist = { testFakes: [{ path: 'test/x.test.mjs', hash: fakeHash(secret) }] };
  const run = (path, text) => scanHygiene({ addedLines: [{ path, line: 1, text }], paths: [], metadata: {}, denylist, allowlist });
  assert.deepEqual(run('test/x.test.mjs', 'k = ' + secret), []);
  assert.deepEqual(rules(run('test/x.test.mjs', 'k = ' + secret + 'Q')), ['HYG-CRED']);
  assert.deepEqual(rules(run('test/y.test.mjs', 'k = ' + secret)), ['HYG-CRED']);
});

test('H-83: findings carry a per-run keyed hash; low-entropy matches carry no length', () => {
  const text = `connect to ${PRIVATE_IP}`;
  const run = (salt) => scanHygiene({ addedLines: [{ path: 'docs/a.md', line: 1, text }], paths: [], metadata: {}, denylist, salt });
  const a = run('salt-one-0123456789');
  const b = run('salt-one-0123456789');
  const c = run('salt-two-0123456789');
  assert.deepEqual(a, b);
  assert.notEqual(a[0].hash, c[0].hash);
  assert.notEqual(a[0].hash, hashText(PRIVATE_IP));
  assert.equal(a[0].length, 0);
  // Without a salt every run draws a fresh key.
  const d = scanHygiene({ addedLines: [{ path: 'docs/a.md', line: 1, text }], paths: [], metadata: {}, denylist });
  const e = scanHygiene({ addedLines: [{ path: 'docs/a.md', line: 1, text }], paths: [], metadata: {}, denylist });
  assert.notEqual(d[0].hash, e[0].hash);
  // A credential keeps a bucketed length (multiple of 16).
  const cred = scanWith([piece('api', '_key = "', 'Zk3pQ9vL2xR7tW5yB8nM4cD6', '"')]);
  assert.equal(cred[0].length % 16, 0);
  assert.throws(() => scanHygiene({ addedLines: [], denylist, salt: 'x' }), HygieneError);
});

test('H-84: finding output escapes control characters, escapes and newlines in the path', () => {
  const evil = 'docs/a\u001b[31m\nb.md';
  const f = scanHygiene({ addedLines: [{ path: evil, line: 2, text: `ping ${PUBLIC_IP}` }], paths: [], metadata: {}, denylist });
  const out = formatFindings(f);
  assert.ok(!/[\u0000-\u0009\u000b-\u001f\u007f]/.test(out));
  assert.equal(out.split('\n').length, 1);
  // Bidi controls, line separators and backslashes are escaped too.
  const g = formatFindings([{ ruleId: 'HYG-IP', path: 'a\u202eb\u2028c\\d', line: 1, length: 0, hash: 'abcdef01' }]);
  assert.ok(!/[\u202e\u2028\\]{1}[^\\]/.test(g.replace(/\\\\|\\u\{[0-9a-f]+\}/g, '')));
  // A forged rule id or hash is not echoed.
  assert.equal(formatFindings([{ ruleId: 'x\ny', path: 'p', line: 1, length: 0, hash: 'zz\n' }]), 'HYG-UNKNOWN p:1 len=0 hash=?');
  assert.equal(formatFindings('nope'), '');
});

test('H-85: a path with a denylisted name or a control character is reported under a keyed hash', () => {
  const bad = 'docs/fixtureuser-example\u001b/x.md';
  const f = scanHygiene({ addedLines: [{ path: bad, line: 1, text: `ping ${PUBLIC_IP}` }], paths: [], metadata: {}, denylist, salt: TEST_RUN_ID });
  assert.match(f[0].path, /^<path:[0-9a-f]{8}>$/);
  assert.ok(!JSON.stringify(f).includes('fixtureuser'));
});

test('H-86: decoder caps fail closed with a block-type HygieneError, never a silent skip', () => {
  const manyPercent = 'a '.repeat(300) + '%41%42%43 '.repeat(300);
  assert.throws(() => scanLines(manyPercent), (err) => err instanceof HygieneError && err.code === 'LIMIT' && /^gate0: [a-z ]+$/.test(err.message));
  const manyBlobs = Array.from({ length: 300 }, (_, i) => Buffer.from(`plain words number ${i} here`).toString('base64')).join(' ');
  assert.throws(() => scanLines(manyBlobs), (err) => err instanceof HygieneError && err.code === 'LIMIT');
  // Nesting deeper than the cap is not decoded further but stays bounded and fast.
  let blob = `x ${PUBLIC_IP}`;
  for (let i = 0; i < 12; i++) blob = Buffer.from(blob).toString('base64');
  const t0 = Date.now();
  scanLines('y ' + blob);
  assert.ok(Date.now() - t0 < 5000);
});

test('H-87: an expired deadline stops the scan with a HygieneError', () => {
  assert.throws(() => scanWith(['ping 1'], { path: 'docs/a.md' }) && scanHygiene({
    addedLines: [{ path: 'docs/a.md', line: 1, text: 'x' }], paths: [], metadata: {}, denylist, deadline: Date.now() - 1,
  }), (err) => err instanceof HygieneError);
});

test('H-77: a host-run denylist file must be trusted: owner-only, regular, not relative, not a symlink', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hyg-'));
  try {
    mkdirSync(join(dir, 'gate0'));
    const file = join(dir, 'gate0', 'denylist.json');
    writeDeny(file, JSON.stringify({ hostnames: { distinctive: ['somehost-example'] } }));
    assert.deepEqual(loadDenylist({ env: { RT_HOME: dir }, hostRun: true }).hostnames.distinctive, ['somehost-example']);
    chmodSync(file, 0o666);
    assert.throws(() => loadDenylist({ env: { RT_HOME: dir }, hostRun: true }), (err) => err.code === 'DENYLIST_UNTRUSTED' && !err.message.includes(dir));
    chmodSync(file, 0o600);
    assert.throws(() => loadDenylist({ env: { RT_HOME: 'relative/dir' }, hostRun: true }), (err) => err instanceof HygieneError);
    // A denylist inside the reviewed repository is refused.
    assert.throws(() => loadDenylist({ env: { RT_HOME: dir }, hostRun: true, repoRoot: dir }), (err) => err.code === 'DENYLIST_UNTRUSTED');
    // Oversized file.
    writeDeny(file, JSON.stringify({ hostnames: { distinctive: ['x'.repeat(300 * 1024)] } }));
    assert.throws(() => loadDenylist({ env: { RT_HOME: dir }, hostRun: true }), (err) => err instanceof HygieneError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('H-79: regex denial of service: long single lines of many shapes scan fast', () => {
  const shapes = ['1234567890', '.', 'a@', '%41', 'deadbeef', ':', 'password=', '\u200b', '\uff21', 'abcDefGhi_', 'a', '1.2.',
    ' ', '\n', '<a ', 'user ', 'ssh ', 'eyJhbGciOi', '://a@', '&#46;', '[.]', '0x', 'sk_live_', 'ab:cd:'];
  for (const shape of shapes) {
    const line = shape.repeat(Math.ceil(50000 / shape.length)).slice(0, 50000);
    for (const path of ['docs/a.md', 'src/a.mjs']) {
      const t0 = Date.now();
      try { scanHygiene({ addedLines: [{ path, line: 1, text: line }], paths: [], metadata: {}, denylist }); } catch (err) { assert.ok(err instanceof HygieneError); }
      assert.ok(Date.now() - t0 < 3000, `shape ${JSON.stringify(shape)} took ${Date.now() - t0} ms`);
    }
  }
  // Whitespace runs after a keyword (quadratic backtracking before the rewrite).
  for (const pre of ['user', 'password', 'ssh', '<a', 'host']) {
    const t0 = Date.now();
    scanLines(pre + ' '.repeat(50000) + 'x');
    assert.ok(Date.now() - t0 < 3000, pre);
  }
});

test('H-79: a 500 KB line is scanned in bounded time and still finds a late secret', () => {
  const t0 = Date.now();
  const f = scanLines('x'.repeat(500000) + ' ' + piece('gh', 'p_', 'Zk3pQ9vL2xR7tW5yB8nM4cD6fH1jK0aS'));
  assert.deepEqual(rules(f), ['HYG-CRED']);
  assert.ok(Date.now() - t0 < 10000);
});

import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../', import.meta.url));

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(p));
    else out.push(p);
  }
  return out;
}

async function sources() {
  const files = [...await walk(join(repo, 'runtime')), ...await walk(join(repo, 'test', 'runtime'))];
  const doc = join(repo, 'docs', 'runtime-modules.md');
  files.push(doc);
  const result = [];
  for (const f of files) {
    try { result.push({ file: f.slice(repo.length), text: await readFile(f, 'utf8') }); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  return result;
}

// This file names the forbidden patterns, so it is excluded from its own scan.
const scanned = async () => (await sources()).filter((s) => !s.file.endsWith('hygiene.test.mjs'));
const runtimeOnly = async () => (await scanned()).filter((s) => s.file.startsWith('runtime/'));

const subprocessAllowed = (file) => file === 'runtime/lib/accept.mjs';

test('only Gate 0 may run subprocesses', () => {
  assert.equal(subprocessAllowed('runtime/lib/accept.mjs'), true);
  assert.equal(subprocessAllowed('runtime/lib/other.mjs'), false);
  assert.equal(subprocessAllowed('runtime/lib/accept.mjs.extra'), false);
});

test('runtime code restricts subprocesses and never touches the network', async () => {
  const files = await runtimeOnly();
  assert.ok(files.length >= 5);
  for (const { file, text } of files) {
    if (!subprocessAllowed(file)) assert.doesNotMatch(text, /child_process/, file);
    assert.doesNotMatch(text, /\bgh\s+(issue|pr|api|repo|release|label)\b/, file);
    assert.doesNotMatch(text, /node:(https?|net|dgram|tls)\b|\bfetch\(/, file);
  }
});

test('runtime code has no model-name references in code, tests or docs', async () => {
  for (const { file, text } of await scanned()) assert.doesNotMatch(text, new RegExp(['hai', 'ku'].join(''), 'i'), file);
});

test('runtime code has no absolute home directories', async () => {
  for (const { file, text } of await scanned()) assert.doesNotMatch(text, /\/home\/[a-z_][\w-]*|\/Users\/\w+/i, file);
});

test('runtime reuses lib/verdict.mjs instead of forking a verdict parser', async () => {
  const classify = (await runtimeOnly()).find((s) => s.file.endsWith('classify.mjs'));
  assert.match(classify.text, /from '\.\.\/\.\.\/lib\/verdict\.mjs'/);
  for (const { file, text } of await runtimeOnly()) assert.doesNotMatch(text, /===\s*'通过'|===\s*'打回'/, file);
});
