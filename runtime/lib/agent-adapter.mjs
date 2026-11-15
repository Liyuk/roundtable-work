import { parseUsage } from './usage-parse.mjs';

// One Chief turn per call. Flags were checked against `pi --help`, `codex exec --help` and `codex exec resume --help`.
// pi: `--session-id <id>` names an exact session and creates it if missing; `-p` runs one non-interactive turn.
//     Verified: the flags exist. NOT verified: that a second call with the same id continues the same conversation.
// codex: a new turn is `codex exec <prompt>`; a resumed turn is `codex exec resume <id> <prompt>`.
//     Verified: the subcommand and flags exist. NOT verified: `exec` assigns its own thread id, so the sessionId
//     generated here is not known to be codex's thread id, and resuming with it is unverified.
export const ADAPTERS = Object.freeze({
  pi: Object.freeze({ name: 'pi', buildArgs: ({ sessionId, prompt }) => ['--session-id', sessionId, '-p', prompt] }),
  codex: Object.freeze({
    name: 'codex',
    buildArgs: ({ sessionId, resume, prompt }) => (resume ? ['exec', 'resume', sessionId, prompt] : ['exec', prompt]),
  }),
});

export function selectAdapter(name) {
  if (!Object.hasOwn(ADAPTERS, name)) throw new Error(`unknown agent adapter: ${name}`);
  return ADAPTERS[name];
}

// Role sessions never receive a GitHub write token.
export const childEnv = (env = process.env) => Object.fromEntries(Object.entries(env).filter(([k]) => !/^(GH|GITHUB)_/.test(k)));

/**
 * Returns `launch({ workspace, sessionId, resume, prompt, issue, role, model })` for startFrontChief; resolves to the exit code.
 * Optional `recordUsage(row)`: when given, stdout is captured (and still echoed), and one usage row is recorded per call.
 * Without it, stdio is unchanged.
 */
export function createAdapterLauncher({ adapter, command, env = process.env, spawnFn, proxySocket, recordUsage }) {
  if (!spawnFn) throw new Error('createAdapterLauncher requires spawnFn');
  if (adapter.capabilities?.invocation === 'in-process') throw new Error(`${adapter.name} is in-process and cannot be launched as a process`);
  return ({ workspace, sessionId, resume, prompt, issue, role, model }) => new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawnFn(command, adapter.buildArgs({ sessionId, resume, prompt }), {
      cwd: workspace,
      env: proxySocket ? { ...childEnv(env), RT_GH_PROXY_SOCKET: proxySocket } : childEnv(env),
      stdio: ['ignore', recordUsage ? 'pipe' : 'inherit', 'inherit'],
    });
    let stdout = '';
    if (recordUsage) child.stdout.on('data', (chunk) => { stdout += chunk; process.stdout.write(chunk); });
    child.on('error', reject);
    // 'close' (not 'exit') when capturing: it fires after stdout has been fully read.
    child.on(recordUsage ? 'close' : 'exit', (code) => {
      const finish = () => resolve(code ?? 1);
      if (!recordUsage) return finish();
      const usage = parseUsage(adapter.name, stdout);
      const counts = usage ?? { inputTokens: null, cachedInputTokens: null, outputTokens: null };
      return recordUsage({ issue, role, harness: adapter.name, model, wallMs: Date.now() - started, at: Date.now(), usageKnown: usage !== null, ...counts })
        .then(finish, reject);
    });
  });
}
