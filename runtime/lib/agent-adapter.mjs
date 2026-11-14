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

/** Returns `launch({ workspace, sessionId, resume, prompt })` for startFrontChief; resolves to the exit code. */
export function createAdapterLauncher({ adapter, command, env = process.env, spawnFn }) {
  if (!spawnFn) throw new Error('createAdapterLauncher requires spawnFn');
  return ({ workspace, sessionId, resume, prompt }) => new Promise((resolve, reject) => {
    const child = spawnFn(command, adapter.buildArgs({ sessionId, resume, prompt }), {
      cwd: workspace, env: childEnv(env), stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 1));
  });
}
