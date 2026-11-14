#!/usr/bin/env node
// CLI for the front Chief session. `status` reads the ledger only; `start` launches RT_AGENT_BIN with the contract
// args `chief --front --session <id> --new|--resume` in the workspace, and writes the prompt to its stdin.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile as fsReadFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startFrontChief, statusOf } from '../runtime/lib/front-chief.mjs';
import { childEnv } from '../runtime/lib/agent-adapter.mjs';
import { createWriteProxy, runHostCommand, startWriteProxy } from '../runtime/lib/gh-write-proxy.mjs';

const DEFAULT_ROLE_PROMPT = fileURLToPath(new URL('../.agents/skills/roundtable-work/prompts/roles/chief.md', import.meta.url));
const USAGE = 'usage: front-chief.mjs status|start --workspace <dir> [--role-prompt <file>]\n';

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
    if (!deps.launch && !env.RT_AGENT_BIN) { stderr.write('no launcher configured: set RT_AGENT_BIN\n'); return 2; }
    const socketDir = await mkdtemp(join(tmpdir(), 'rt-gh-'));
    const socketPath = join(socketDir, 'gh.sock');
    const proxy = await startWriteProxy({ socketPath, proxy: createWriteProxy({ repo: env.RT_GH_REPO, execute: (cmd) => (deps.execute ?? runHostCommand)({ ...cmd, cwd: workspace }) }) });
    try {
      const launch = deps.launch ?? defaultLaunch(env.RT_AGENT_BIN, { ...childEnv(env), RT_GH_PROXY_SOCKET: socketPath });
      const rolePrompt = await readFile(flag(rest, '--role-prompt') ?? DEFAULT_ROLE_PROMPT, 'utf8');
      const result = await startFrontChief({ workspace, launch, rolePrompt, readFile });
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
