// Host-side GitHub write proxy. Children reach it over a unix socket and never hold a token.
// Only the injected `execute` runs commands; denied requests never reach it.
import { execFile } from 'node:child_process';
import { createConnection, createServer } from 'node:net';
import { createInterface } from 'node:readline';
import { rm } from 'node:fs/promises';
import { promisify } from 'node:util';

const GH_ALLOWED = new Set(['issue comment', 'issue create', 'pr create', 'pr comment']);
const GH_DENIED = { 'pr merge': 'merge', 'issue close': 'close', 'pr close': 'close' };
const GIT_FLAGS_ALLOWED = new Set(['-u', '--set-upstream']);
const PROTECTED_BRANCHES = new Set(['main', 'master']);

const deny = (kind, reason) => ({ allowed: false, kind, reason: `${kind}: ${reason}` });

function repoMatches(args, repo) {
  const i = args.findIndex((a) => a === '--repo' || a === '-R');
  const eq = args.find((a) => a.startsWith('--repo='));
  if (i < 0 && !eq) return true;
  return (i >= 0 ? args[i + 1] : eq.slice('--repo='.length)) === repo;
}

function classifyGh(args, repo) {
  const sub = `${args[0]} ${args[1]}`;
  if (GH_DENIED[sub]) return deny(GH_DENIED[sub], `gh ${sub} is not allowed`);
  if (!GH_ALLOWED.has(sub) || !repoMatches(args, repo)) return deny('not-allow-listed', `gh ${sub} is not allowed`);
  return { allowed: true };
}

function classifyGit(args) {
  if (args[0] !== 'push') return deny('not-allow-listed', `git ${args[0]} is not allowed`);
  const flags = args.slice(1).filter((a) => a.startsWith('-'));
  const positional = args.slice(1).filter((a) => !a.startsWith('-'));
  if (args.some((a) => a.startsWith('--force') || /^-[a-zA-Z]*f/.test(a)) || positional.some((a) => a.startsWith('+'))) {
    return deny('force-push', 'force pushes are not allowed');
  }
  if (flags.includes('--delete') || flags.includes('-d') || positional.some((a) => a.startsWith(':'))) {
    return deny('not-allow-listed', 'delete pushes are not allowed');
  }
  if (positional.length !== 2 || flags.some((f) => !GIT_FLAGS_ALLOWED.has(f))) {
    return deny('not-allow-listed', 'only git push <remote> <refspec> is allowed');
  }
  const destination = positional[1].split(':').at(-1).replace(/^refs\/heads\//, '');
  if (['', 'HEAD', '@'].includes(destination)) return deny('not-allow-listed', 'explicit destination branch required');
  if (PROTECTED_BRANCHES.has(destination)) return deny('push-main', `direct push to ${destination} is not allowed`);
  return { allowed: true };
}

/** Returns `{ allowed: true }` or `{ allowed: false, kind, reason }`. */
export function classifyWrite(request, { repo } = {}) {
  const wellFormed = request && ['gh', 'git'].includes(request.tool) && Array.isArray(request.args) &&
    request.args.length > 0 && request.args.every((a) => typeof a === 'string');
  if (!wellFormed) return deny('malformed', 'request must be { tool: gh|git, args: string[] }');
  return request.tool === 'gh' ? classifyGh(request.args, repo) : classifyGit(request.args);
}

export function createWriteProxy({ repo, execute, audit }) {
  return {
    async handle(request) {
      const verdict = classifyWrite(request, { repo });
      if (!verdict.allowed) {
        audit?.({ request, status: 'denied', kind: verdict.kind, reason: verdict.reason });
        return { status: 'denied', kind: verdict.kind, reason: verdict.reason };
      }
      try {
        const stdout = await execute({ tool: request.tool, args: request.args });
        audit?.({ request, status: 'done' });
        return { status: 'done', stdout };
      } catch (error) {
        audit?.({ request, status: 'failed', reason: error.message });
        return { status: 'failed', reason: error.message };
      }
    },
  };
}

const parseLine = (line) => {
  try { return JSON.parse(line); } catch { return null; }
};

/** Serves one JSON request line per connection; each gets one JSON response line. */
export async function startWriteProxy({ socketPath, proxy }) {
  await rm(socketPath, { force: true });
  const server = createServer((socket) => {
    createInterface({ input: socket }).once('line', async (line) => {
      socket.end(`${JSON.stringify(await proxy.handle(parseLine(line)))}\n`);
    });
  });
  await new Promise((resolve, reject) => server.once('error', reject).listen(socketPath, resolve));
  return { close: () => new Promise((resolve) => server.close(resolve)) };
}

export function requestWrite({ socketPath, request }) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath, () => socket.end(`${JSON.stringify(request)}\n`));
    socket.on('error', reject);
    createInterface({ input: socket }).once('line', (line) => {
      resolve(JSON.parse(line));
      socket.destroy();
    });
  });
}

const execFileAsync = promisify(execFile);

/** Default executor: runs gh or git on the host without a shell. Not used by tests. */
export async function runHostCommand({ tool, args, cwd }) {
  const { stdout } = await execFileAsync(tool, args, { cwd });
  return stdout;
}
