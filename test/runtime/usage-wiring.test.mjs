import test from 'node:test';
import assert from 'node:assert/strict';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADAPTERS, selectAdapter } from '../../runtime/lib/agent-adapter.mjs';
import { parseUsage } from '../../runtime/lib/usage-parse.mjs';
import { loadUsageLedger, recordUsageRow } from '../../runtime/lib/usage-ledger.mjs';
import { watchdog } from '../../runtime/supervisor/watchdog.mjs';
import { fixMain } from '../../scripts/rt-entry.mjs';

const ROUTING = fileURLToPath(new URL('./routing-fixture.json', import.meta.url));
const TASK = 'Fix the off-by-one in the pager';
const NOW = 10_000_000;
const dirs = [];

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), 'rt-wiring-'));
  dirs.push(dir);
  return dir;
}

// Fake `pi` on PATH: prints one pi `message_end` event carrying usage, then exits 0.
async function fakePi(dir) {
  const bin = join(dir, 'bin');
  await mkdir(bin);
  const usage = { input: 100, output: 7, cacheRead: 0 };
  const event = JSON.stringify({ type: 'message_end', message: { role: 'assistant', usage } });
  await writeFile(join(bin, 'pi'), `#!${process.execPath}\nconsole.log(${JSON.stringify(event)});\n`);
  await chmod(join(bin, 'pi'), 0o755);
  return bin;
}

const sinks = () => ({ stdout: { write: () => true }, stderr: { write: () => true } });

test('rt-fix: a production run with RT_ISSUE writes one usage row to the workspace state root', async () => {
  const dir = await tempDir();
  const workspace = join(dir, 'ws');
  await mkdir(join(workspace, '.roundtable'), { recursive: true });
  const bin = await fakePi(dir);
  const env = { PATH: `${bin}:${process.env.PATH}`, RT_ISSUE: '336' };
  assert.equal(await fixMain(['--workspace', workspace, '--task', TASK, '--routing', ROUTING], { env, ...sinks() }), 0);

  const { rows } = await loadUsageLedger(join(workspace, '.roundtable'), '336');
  const fixture = JSON.parse(await readFile(ROUTING, 'utf8'));
  assert.equal(rows.length, 1);
  assert.deepEqual(
    { issue: rows[0].issue, role: rows[0].role, harness: rows[0].harness, model: rows[0].model, usageKnown: rows[0].usageKnown, inputTokens: rows[0].inputTokens, outputTokens: rows[0].outputTokens },
    { issue: '336', role: 'developer', harness: 'pi', model: fixture.windows[0].roles.developer.model, usageKnown: true, inputTokens: 100, outputTokens: 7 },
  );
  await rm(dir, { recursive: true, force: true });
});

test('rt-fix: without RT_ISSUE no usage row is recorded and nothing is written under the state root', async () => {
  const dir = await tempDir();
  const workspace = join(dir, 'ws');
  await mkdir(join(workspace, '.roundtable'), { recursive: true });
  const bin = await fakePi(dir);
  const env = { PATH: `${bin}:${process.env.PATH}` };
  assert.equal(await fixMain(['--workspace', workspace, '--task', TASK, '--routing', ROUTING], { env, ...sinks() }), 0);
  await assert.rejects(access(join(workspace, '.roundtable', 'state')), { code: 'ENOENT' });
  await rm(dir, { recursive: true, force: true });
});

test('watchdog: tokens-no-commit fires from usage rows persisted by a launch, loaded by the caller', async () => {
  const workRoot = await tempDir();
  await mkdir(join(workRoot, 'state'));
  const row = { issue: '336', role: 'developer', model: 'm', harness: 'codex', usageKnown: true, cachedInputTokens: 0, wallMs: 1, at: NOW };
  await recordUsageRow(workRoot, { ...row, inputTokens: 499000, outputTokens: 1000 });
  await recordUsageRow(workRoot, { ...row, inputTokens: 100, outputTokens: 7 });
  const ledger = await loadUsageLedger(workRoot, '336');
  const heartbeat = { ok: true, value: { daemon: { lastCycleAt: NOW }, frontChief: { lastTurnAt: NOW } } };
  const events = [{ type: 'commit', at: NOW - 60000, sha: 'c0' }];
  const findings = watchdog({ snapshot: { heartbeat, sinceLastMaterialProgressMs: 0 }, now: NOW, config: { events, ledger, issue: '336' } });
  const [finding] = findings.filter((f) => f.rule === 'budget-overflow');
  assert.equal(finding.evidence.spent, 499000 + 1000 + 100 + 7);
  await rm(workRoot, { recursive: true, force: true });
});

test('ADAPTERS.pi and ADAPTERS.codex expose parseUsage that matches the module function', () => {
  const output = JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 5, cached_input_tokens: 1, output_tokens: 2 } });
  for (const name of ['pi', 'codex']) {
    assert.equal(typeof selectAdapter(name).parseUsage, 'function');
    assert.deepEqual(ADAPTERS[name].parseUsage(output), parseUsage(name, output));
    assert.deepEqual(ADAPTERS[name].parseUsage('plain'), parseUsage(name, 'plain'));
  }
});
