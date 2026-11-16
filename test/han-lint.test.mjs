import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

const root = join(import.meta.dirname, '..');

// Han text is allowed only in these files, and only on lines with a legacy alias token.
const WHITELIST = new Map([
  ['lib/verdict.mjs', 'Parser accepts the legacy Chinese verdict aliases.'],
  ['runtime/lib/classify.mjs', 'Classifier accepts the legacy Chinese verdict line.'],
  ['runtime/lib/reviewer-session.mjs', 'Reviewer session accepts the legacy Chinese verdict line.'],
  ['scripts/build-site.mjs', 'Site builder matches the legacy Chinese verdict strings in demo content.'],
  ['site/index.html', 'Built site shows the legacy Chinese verdict contract lines.'],
  ['docs/pages-demo/scenario.json', 'Demo scenario carries the Chinese verdict contract values.'],
  ['docs/pages-demo/content-outline.md', 'Demo outline documents the machine-contract verdict words.'],
  ['.agents/skills/roundtable-work/references/harnesses.md', 'Harness doc documents the legacy verdict line.'],
  ['test/fixtures/review-cards/reject-01-evidenced.md', 'Fixture review card uses the legacy verdict line.'],
  ['test/fixtures/review-cards/reject-02-unevidenced.md', 'Fixture review card uses the legacy verdict line.'],
  ['test/fixtures/review-cards/reject-03-mixed.md', 'Fixture review card uses the legacy verdict line.'],
  ['test/harnesses-doc.test.mjs', 'Test asserts the legacy verdict tokens in the harness doc.'],
  ['test/pages-demo-content.test.mjs', 'Test asserts the legacy verdict tokens in demo content.'],
  ['test/reviewer-prompt.test.mjs', 'Test asserts legacy verdict lines are still parsed.'],
  ['test/runtime/classify.test.mjs', 'Test asserts legacy verdict lines are still classified.'],
  ['test/runtime/hardening.test.mjs', 'Test asserts legacy verdict lines are still classified.'],
  ['test/runtime/hygiene.test.mjs', 'Test asserts runtime code does not compare legacy verdict words.'],
  ['test/site.test.mjs', 'Test asserts the legacy verdict tokens in the built site.'],
  ['test/verdict.test.mjs', 'Test asserts legacy verdict aliases still parse.'],
  ['docs/project-contracts.md', 'Legacy Chinese verdict fixture fed to the alias parser; frozen-token check requires the count to stay.'],
  ['practice/2026-11-10-native-harness-demo.md', 'Legacy Chinese verdict fixture fed to the alias parser; frozen-token check requires the count to stay.'],
  ['practice/2026-11-10-session-trial.md', 'Legacy Chinese verdict fixture fed to the alias parser; frozen-token check requires the count to stay.'],
  ['practice/README.md', 'Legacy Chinese verdict fixture fed to the alias parser; frozen-token check requires the count to stay.'],
  ['test/fixtures/review-cards/README.md', 'Legacy Chinese verdict fixture fed to the alias parser; frozen-token check requires the count to stay.'],
  ['test/runtime/completion-gates.test.mjs', 'Legacy Chinese verdict fixture fed to the alias parser; frozen-token check requires the count to stay.'],
  ['test/runtime/cutover-check.test.mjs', 'Legacy Chinese verdict fixture fed to the alias parser; frozen-token check requires the count to stay.'],
  ['test/runtime/cutover.test.mjs', 'Legacy Chinese verdict fixture fed to the alias parser; frozen-token check requires the count to stay.'],
  ['test/runtime/daemon-memory.test.mjs', 'Legacy Chinese verdict fixture fed to the alias parser; frozen-token check requires the count to stay.'],
  ['test/runtime/daemon-workers.test.mjs', 'Legacy Chinese verdict fixture fed to the alias parser; frozen-token check requires the count to stay.'],
  ['test/runtime/decision-reask.test.mjs', 'Legacy Chinese verdict fixture fed to the alias parser; frozen-token check requires the count to stay.'],
  ['test/runtime/decisions.test.mjs', 'Legacy Chinese verdict fixture fed to the alias parser; frozen-token check requires the count to stay.'],
  ['test/runtime/escalation.test.mjs', 'Legacy Chinese verdict fixture fed to the alias parser; frozen-token check requires the count to stay.'],
  ['test/runtime/finalize-holds.test.mjs', 'Legacy Chinese verdict fixture fed to the alias parser; frozen-token check requires the count to stay.'],
  ['test/runtime/harness.test.mjs', 'Legacy Chinese verdict fixture fed to the alias parser; frozen-token check requires the count to stay.'],
  ['test/runtime/intake.test.mjs', 'Legacy Chinese verdict fixture fed to the alias parser; frozen-token check requires the count to stay.'],
  ['test/runtime/live.test.mjs', 'Legacy Chinese verdict fixture fed to the alias parser; frozen-token check requires the count to stay.'],
  ['test/runtime/merge-unknown.test.mjs', 'Legacy Chinese verdict fixture fed to the alias parser; frozen-token check requires the count to stay.'],
  ['test/runtime/observe.test.mjs', 'Legacy Chinese verdict fixture fed to the alias parser; frozen-token check requires the count to stay.'],
  ['test/runtime/predispatch-cli.test.mjs', 'Legacy Chinese verdict fixture fed to the alias parser; frozen-token check requires the count to stay.'],
  ['test/runtime/production-integration.test.mjs', 'Legacy Chinese verdict fixture fed to the alias parser; frozen-token check requires the count to stay.'],
  ['test/runtime/queue.test.mjs', 'Legacy Chinese verdict fixture fed to the alias parser; frozen-token check requires the count to stay.'],
  ['test/runtime/recovery.test.mjs', 'Legacy Chinese verdict fixture fed to the alias parser; frozen-token check requires the count to stay.'],
  ['test/runtime/renewal.test.mjs', 'Legacy Chinese verdict fixture fed to the alias parser; frozen-token check requires the count to stay.'],
  ['test/runtime/reviewer-quota-wait.test.mjs', 'Legacy Chinese verdict fixture fed to the alias parser; frozen-token check requires the count to stay.'],
  ['test/runtime/reviewer-session.test.mjs', 'Legacy Chinese verdict fixture fed to the alias parser; frozen-token check requires the count to stay.'],
  ['test/runtime/rework-assignment.test.mjs', 'Legacy Chinese verdict fixture fed to the alias parser; frozen-token check requires the count to stay.'],
  ['test/runtime/rtd-cleanup.test.mjs', 'Legacy Chinese verdict fixture fed to the alias parser; frozen-token check requires the count to stay.'],
  ['test/runtime/rule-fingerprint.test.mjs', 'Legacy Chinese verdict fixture fed to the alias parser; frozen-token check requires the count to stay.'],
  ['test/runtime/shadow.test.mjs', 'Legacy Chinese verdict fixture fed to the alias parser; frozen-token check requires the count to stay.'],
  ['test/runtime/stacked-loop.test.mjs', 'Legacy Chinese verdict fixture fed to the alias parser; frozen-token check requires the count to stay.'],
  ['test/runtime/watchdog-restart.test.mjs', 'Legacy Chinese verdict fixture fed to the alias parser; frozen-token check requires the count to stay.'],
]);

// Escaped so that this file contains no Han itself (the four legacy verdict words).
const ALIASES = ['\u5ba1\u67e5\u7ed3\u8bba', '\u901a\u8fc7', '\u6253\u56de', '\u963b\u585e'];
const HAN = /\p{Script=Han}/u;

// Returns "file:line" for each Han line that is not an allowed legacy alias line.
function hanErrors(file, text) {
  const allowed = WHITELIST.has(file);
  return text.split('\n').flatMap((line, i) =>
    HAN.test(line) && !(allowed && ALIASES.some((alias) => line.includes(alias))) ? [`${file}:${i + 1}`] : []);
}

const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);

// A directory target counts as tracked when any tracked file lies under it.
const isTracked = (path) => tracked.some((file) => file === path || file.startsWith(path + '/'));

function scan() {
  const errors = [];
  for (const file of tracked) {
    const path = join(root, file);
    if (lstatSync(path).isSymbolicLink()) {
      const target = normalize(join(dirname(file), readlinkSync(path)));
      if (!isTracked(target)) errors.push(`${file}: symlink to untracked ${target}`);
      continue;
    }
    const bytes = readFileSync(path);
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      continue; // Not UTF-8 text (for example binary), so it cannot contain readable Han.
    }
    errors.push(...hanErrors(file, text));
  }
  return errors;
}

test('Han appears only in whitelisted files and only on legacy alias lines', () => {
  assert.deepEqual(scan(), []);
});

test('Han check reports a non-whitelisted file and a non-alias line in a whitelisted file', () => {
  const han = '\u4e2d\u6587';
  assert.deepEqual(hanErrors('docs/new.md', `ok\n${han}`), ['docs/new.md:2']);
  assert.deepEqual(hanErrors('lib/verdict.mjs', han), ['lib/verdict.mjs:1']);
  assert.deepEqual(hanErrors('lib/verdict.mjs', `${ALIASES[1]}`), []);
});
