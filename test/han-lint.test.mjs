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
]);

// Escaped so that this file contains no Han itself: 审查结论, 通过, 打回, 阻塞.
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
