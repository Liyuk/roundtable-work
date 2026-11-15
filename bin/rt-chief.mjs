#!/usr/bin/env node
// CLI for the front Chief session. `status` reads the ledger only; `start` launches the chief role's configured harness.
// RT_AGENT_BIN, when set, is an explicit override: it is run with `chief --front --session <id> --new|--resume` and the prompt on stdin.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile as fsReadFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startFrontChief, statusOf } from '../runtime/lib/front-chief.mjs';
import { childEnv, createAdapterLauncher } from '../runtime/lib/agent-adapter.mjs';
import { loadHarnessConfig, selectHarness } from '../runtime/lib/harness.mjs';
import { createWriteProxy, runHostCommand, startWriteProxy } from '../runtime/lib/gh-write-proxy.mjs';
import { loadRouting, routingFacts } from '../runtime/lib/routing.mjs';
import { recordUsageRow } from '../runtime/lib/usage-ledger.mjs';

const DEFAULT_ROLE_PROMPT = fileURLToPath(new URL('../.agents/skills/roundtable-work/prompts/roles/chief.md', import.meta.url));
const USAGE = 'usage: front-chief.mjs status|start --workspace <dir> [--role-prompt <file>] [--routing <file>]\n';

const flag = (argv, name) => { const i = argv.indexOf(name); return i === -1 ? undefined : argv[i + 1]; };

function defaultLaunch(command, env) {
  return ({ workspace, sessionId, resume, prompt }) => new Promise((resolve, reject) => {
    const child = spawn(command, ['chief', '--front', '--session', sessionId, resume ? '--resume' : '--new'], { cwd: workspace, env, stdio: ['pipe', 'inherit', 'inherit'] });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
    child.stdin.on('error', () => {}); // the launcher may exit without reading the prompt
    child.stdin.end(prompt);
  });
}

export async function main(argv, deps = {}) {
  const { env = process.env, stdout = process.stdout, stderr = process.stderr, readFile = fsReadFile } = deps;
  const [command, ...rest] = argv;
  const workspace = flag(rest, '--workspace');
  if (!workspace) { stderr.write(`missing --workspace\n${USAGE}`); return 1; }
  try {
    if (command === 'status') {
      stdout.write(`${JSON.stringify(await statusOf(workspace, readFile), null, 2)}\n`);
      return 0;
    }
    if (command !== 'start') { stderr.write(USAGE); return 1; }
    const config = await loadHarnessConfig(deps.harnessConfig, readFile); // fails closed on an unknown harness, before any spawn
    const chief = selectHarness(config.roles.chief);
    const socketDir = await mkdtemp(join(tmpdir(), 'rt-gh-'));
    const socketPath = join(socketDir, 'gh.sock');
    const proxy = await startWriteProxy({ socketPath, proxy: createWriteProxy({ repo: env.RT_GH_REPO, execute: (cmd) => (deps.execute ?? runHostCommand)({ ...cmd, cwd: workspace }) }) });
    try {
      // Usage goes to the workspace state root under the issue named by RT_ISSUE; the model comes from --routing when given.
      const root = join(workspace, '.roundtable');
      const recordUsage = (row) => recordUsageRow(root, row);
      const launch = deps.launch ?? (env.RT_AGENT_BIN
        ? defaultLaunch(env.RT_AGENT_BIN, { ...childEnv(env), RT_GH_PROXY_SOCKET: socketPath })
        : createAdapterLauncher({ adapter: chief, command: chief.name, env, spawnFn: spawn, proxySocket: socketPath, recordUsage }));
      const routing = flag(rest, '--routing');
      const model = routing ? routingFacts(await loadRouting(routing), Date.now()).roles.chief.model : undefined;
      const rolePrompt = await readFile(flag(rest, '--role-prompt') ?? DEFAULT_ROLE_PROMPT, 'utf8');
      const result = await startFrontChief({ workspace, launch, rolePrompt, readFile, issue: env.RT_ISSUE, model });
      if (!result.started) { stderr.write('already running: another front Chief session holds the lock\n'); return 3; }
      stdout.write(`${JSON.stringify(result)}\n`);
      return 0;
    } finally {
      await proxy.close();
      await rm(socketDir, { recursive: true, force: true });
    }
  } catch (err) {
    stderr.write(`${err.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
