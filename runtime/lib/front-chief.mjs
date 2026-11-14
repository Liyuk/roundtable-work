// Front Chief session: one resumable Chief session per workspace, single-flight through lock.mjs.
// The session reads only the task ledger, its own session record and the role prompt; nothing else.
import { randomUUID } from 'node:crypto';
import { mkdir, readFile as fsReadFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { acquireLock } from './lock.mjs';

export const PROMPT_CAP_TOKENS = 4000;
export const STATES = Object.freeze(['queued', 'assigned', 'working', 'review', 'ready', 'done', 'waiting_external', 'waiting_person', 'blocked', 'failed', 'cancelled', 'unknown']);
const CLOSED = new Set(['done', 'cancelled']);
const TTL_MS = 5 * 60_000;
const OMITTED = (n) => `... ${n} more open tasks omitted; run the status command for the full list`;

const pathsOf = (workspace) => ({
  ledger: join(workspace, '.roundtable', 'state', 'task-ledger.jsonl'),
  session: join(workspace, '.roundtable', 'state', 'front-chief-session.json'),
  lock: join(workspace, '.roundtable', 'state', 'front-chief.lock.d'),
});

const isText = (v) => v === undefined || v === null || typeof v === 'string';

// The ledger is untrusted text: one record per line, each validated on its own.
function parseRecord(line) {
  let rec;
  try { rec = JSON.parse(line); } catch { return null; }
  const ok = Number.isInteger(rec?.issue) && rec.issue > 0 && STATES.includes(rec.state)
    && isText(rec.line) && isText(rec.decision) && isText(rec.why);
  return ok ? rec : null;
}

/** Status from the ledger text: the last record per issue wins; open means neither done nor cancelled. */
export function buildStatus(text) {
  const latest = new Map();
  let invalidLines = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const rec = parseRecord(line);
    if (rec) latest.set(rec.issue, rec);
    else invalidLines++;
  }
  const openTasks = [...latest.values()]
    .filter((r) => !CLOSED.has(r.state))
    .sort((a, b) => a.issue - b.issue)
    .map(({ issue, state, line, decision, why, pr }) => ({ issue, state, line: line ?? null, decision: decision ?? null, why: why ?? null, pr: pr ?? null }));
  return { openTasks, closedCount: latest.size - openTasks.length, invalidLines };
}

const estimate = (text) => Math.ceil(text.length / 4);
const taskLine = (t) => `- #${t.issue} [${t.state}] ${t.decision ?? ''}: ${t.why ?? ''}\n`;

/** Prompt = role prompt + the open tasks that fit under the token cap (lowest issues kept). */
export function renderPrompt({ rolePrompt, status, capTokens = PROMPT_CAP_TOKENS }) {
  const head = `${rolePrompt}\n\n## Open tasks (${status.openTasks.length})\n`;
  if (estimate(head) > capTokens) throw new RangeError('role prompt alone exceeds the token cap');
  const render = (n) => {
    const omitted = status.openTasks.length - n;
    return head + status.openTasks.slice(0, n).map(taskLine).join('') + (omitted ? OMITTED(omitted) : '');
  };
  let lo = 0;
  let hi = status.openTasks.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimate(render(mid)) <= capTokens) lo = mid;
    else hi = mid - 1;
  }
  return render(lo);
}

const readOptional = (readFile, path) => readFile(path, 'utf8').catch((err) => {
  if (err.code === 'ENOENT') return '';
  throw err;
});

/** Status of a workspace; reads only the ledger. */
export async function statusOf(workspace, readFile = fsReadFile) {
  return buildStatus(await readOptional(readFile, pathsOf(workspace).ledger));
}

/**
 * Start (or resume) the front Chief session. Returns `{ started: false, reason: 'already_running' }` when another
 * holder has the lock; otherwise runs `launch({ workspace, sessionId, resume, prompt })` and returns its exit code.
 */
export async function startFrontChief({
  workspace, launch, rolePrompt, anchorRoot, now = Date.now, newId = randomUUID, ttlMs = TTL_MS, readFile = fsReadFile,
}) {
  const paths = pathsOf(workspace);
  const lock = await acquireLock({ lockPath: paths.lock, repoRoot: workspace, anchorRoot, owner: 'front-chief', now, ttlMs });
  if (!lock.acquired) return { started: false, reason: 'already_running' };
  let timer;
  try {
    const prompt = renderPrompt({ rolePrompt, status: await statusOf(workspace, readFile) });
    const raw = await readOptional(readFile, paths.session);
    const resume = raw !== '';
    const sessionId = resume ? JSON.parse(raw).sessionId : newId();
    await mkdir(dirname(paths.session), { recursive: true });
    const tmp = `${paths.session}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify({ sessionId, lastStartedAt: now() }));
    await rename(tmp, paths.session);
    timer = setInterval(() => { lock.refresh().catch(() => false); }, ttlMs / 3);
    timer.unref();
    const exitCode = (await launch({ workspace, sessionId, resume, prompt })) ?? 0;
    return { started: true, sessionId, resume, exitCode };
  } finally {
    clearInterval(timer);
    await lock.release();
  }
}
