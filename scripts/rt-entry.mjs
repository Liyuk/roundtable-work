import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile as fsReadFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { createAdapterLauncher } from '../runtime/lib/agent-adapter.mjs';
import { HARNESS_CONFIG, loadHarnessConfig, selectHarness } from '../runtime/lib/harness.mjs';
import { loadRouting, renderRolePrompt, routingFacts } from '../runtime/lib/routing.mjs';
import { buildReviewerPrompt } from '../runtime/lib/reviewer-session.mjs';

const execFileAsync = promisify(execFile);
const USAGE = 'usage: rt-fix.mjs|rt-review.mjs --workspace <dir> [--config <file>] [--task <text> | --gate0 <file>]\n';
const FIX_PREFIX = 'Bug fix without an issue number. Make the smallest change that fixes the bug and report evidence.';
const NO_GATE0 = 'No Gate 0 summary was recorded; do not assume tests passed.';

const flag = (argv, name) => { const i = argv.indexOf(name); return i === -1 ? undefined : argv[i + 1]; };
const gitHead = async (workspace) => (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: workspace })).stdout.trim();

// Shared path: read config before any spawn, pick the role's harness, launch once as a new session with no resume.
async function launchRole(argv, deps, role, promptOf) {
  const { env = process.env, stdout = process.stdout, stderr = process.stderr, spawnFn = spawn, harnessConfig = HARNESS_CONFIG, readFile = fsReadFile, randomId = randomUUID, git = gitHead } = deps;
  const workspace = flag(argv, '--workspace');
  if (!workspace) { stderr.write(`missing --workspace\n${USAGE}`); return 1; }
  try {
    const config = await loadHarnessConfig(flag(argv, '--config') ?? harnessConfig, readFile);
    const harness = selectHarness(config.roles[role(config)]);
    const prompt = await promptOf({ argv, workspace, readFile, git });
    const launch = createAdapterLauncher({ adapter: harness, command: harness.name, env, spawnFn });
    return await launch({ workspace, sessionId: randomId(), resume: false, prompt });
  } catch (err) {
    stderr.write(`${err.message}\n`);
    return 1;
  }
}

/** Bug fix without an issue: runs the implementer role's harness with the task text. */
export function fixMain(argv, deps = {}) {
  const stderr = deps.stderr ?? process.stderr;
  if (!flag(argv, '--task')) { stderr.write(`missing --task\n${USAGE}`); return Promise.resolve(1); }
  if (!flag(argv, '--routing')) { stderr.write(`missing --routing\n${USAGE}`); return Promise.resolve(1); }
  const { now = Date.now() } = deps;
  return launchRole(argv, deps, (config) => config.implementerRole, async ({ argv: a }) => {
    const facts = routingFacts(await loadRouting(flag(a, '--routing')), now);
    return renderRolePrompt(`${FIX_PREFIX}\n\n${flag(a, '--task')}`, facts);
  });
}

/** Independent review: runs the reviewer role's harness as a new process and session. */
export function reviewMain(argv, deps = {}) {
  return launchRole(argv, deps, () => 'reviewer', async ({ argv: a, workspace, readFile, git }) => {
    const gate0 = flag(a, '--gate0');
    const gate0Summary = gate0 ? await readFile(gate0, 'utf8') : NO_GATE0;
    return buildReviewerPrompt({ head: await git(workspace), gate0Summary });
  });
}
