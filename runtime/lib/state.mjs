import fsPromises from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createConfinement, assertSafeId } from './paths.mjs';
import { isTerminal } from './queue.mjs';

/** Work phases in order. A checkpoint records the last phase that completed. */
export const PHASES = Object.freeze(['developing', 'testing', 'reviewing', 'finalizing']);
/** Phases with external side effects: a crash inside them is never silently re-run. */
export const NON_RESUMABLE_PHASES = Object.freeze(['finalizing']);

/** Per-state-file tail of the update queue (see `update`). Shared by all stores in the process. */
const CHAINS = new Map();

const ARTIFACT_KEYS = ['worktree', 'diff', 'output'];

/** The state file cannot be trusted (unparsable, empty, wrong shape). The file is left untouched. */
export class CorruptStateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CorruptStateError';
    this.code = 'RT_CORRUPT_STATE';
  }
}

/** A write from a lock epoch lower than the one stamped in the state (a successor owns it now): refused. */
export class StaleEpochError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StaleEpochError';
    this.code = 'RT_STALE_EPOCH';
  }
}

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isCount = (v) => Number.isSafeInteger(v) && v >= 0;

/**
 * Validate and normalise a parsed state file. Missing fields take their defaults; present fields of the wrong
 * type are rejected (`CorruptStateError`) rather than coerced, so a budget counter can never turn into NaN and
 * silently bypass a limit. The id always comes from the file name, never from the file content.
 */
function normalizeState(id, raw) {
  if (!isPlainObject(raw)) throw new CorruptStateError(`State for ${id} is not an object`);
  const fresh = freshState(id);
  const state = { ...fresh, ...raw, id };
  if (typeof state.status !== 'string') throw new CorruptStateError(`State for ${id} has a non-string status`);
  if (!isPlainObject(state.attempts)) throw new CorruptStateError(`State for ${id} has malformed attempts`);
  state.attempts = { ...fresh.attempts, ...state.attempts };
  for (const [key, value] of Object.entries(state.attempts)) {
    if (!isCount(value)) throw new CorruptStateError(`State for ${id} has an invalid attempts.${key}`);
  }
  if (!isPlainObject(state.artifacts)) throw new CorruptStateError(`State for ${id} has malformed artifacts`);
  if (!Array.isArray(state.artifactHistory)) throw new CorruptStateError(`State for ${id} has a malformed artifact history`);
  if (state.checkpoint !== null && !(isPlainObject(state.checkpoint) && PHASES.includes(state.checkpoint.phase))) throw new CorruptStateError(`State for ${id} has a malformed checkpoint`);
  if (state.lease !== null && !(isPlainObject(state.lease) && typeof state.lease.owner === 'string' && Number.isFinite(state.lease.expiresAt))) throw new CorruptStateError(`State for ${id} has a malformed lease`);
  if (state.heartbeatAt !== null && !Number.isFinite(state.heartbeatAt)) throw new CorruptStateError(`State for ${id} has an invalid heartbeatAt`);
  if (!isCount(state.lockEpoch)) throw new CorruptStateError(`State for ${id} has an invalid lockEpoch`);
  return state;
}

export const freshState = (id) => ({
  id,
  version: 1,
  status: 'queued',
  phase: null,
  checkpoint: null,
  heartbeatAt: null,
  lease: null,
  attempts: { developer: 0, reviewerUnavailable: 0, wakes: 0 },
  lastEvent: null,
  changedFiles: 0,
  artifacts: {},
  artifactHistory: [],
  lockEpoch: 0,
  recovery: null,
});

/**
 * Durable per-issue state under `<workRoot>/state/`. Epoch owners publish to separate files;
 * readers select the highest epoch, falling back to the legacy file. A delayed older owner can
 * never replace a newer owner's checkpoint or artifact history. Files are synced before publication.
 * Artifact paths are recorded in state and retained in `artifactHistory`.
 *
 * `fs` (tests only) overrides `open`, `rename`, `unlink`, `mkdir`, `readFile`; `randomId` the temp-file suffix.
 */
export async function createStateStore({
  workRoot, now = Date.now, leaseTtlMs = 60_000, heartbeatTimeoutMs = 120_000,
  fs = fsPromises, randomId = randomUUID,
}) {
  const confinement = await createConfinement(workRoot);
  const fileFor = (id) => confinement.resolve('state', `${assertSafeId(id)}.json`);
  let epoch;

  async function load(id) {
    const safeId = assertSafeId(id);
    let text;
    const base = await fileFor(safeId);
    let names;
    try { names = await (fs.readdir ?? fsPromises.readdir)(dirname(base)); } catch (err) { if (err.code !== 'ENOENT') throw err; names = []; }
    const prefix = `~${Buffer.from(safeId).toString('hex')}.epoch-`;
    const epochs = names.filter((name) => name.startsWith(prefix) && /^\d+\.json$/.test(name.slice(prefix.length))).map((name) => Number(name.slice(prefix.length, -5))).filter(Number.isSafeInteger);
    const file = epochs.length ? await confinement.resolve('state', `${prefix}${Math.max(...epochs)}.json`) : base;
    try { text = await fs.readFile(file, 'utf8'); } catch (err) {
      if (err.code === 'ENOENT') return freshState(safeId);
      throw err;
    }
    let raw;
    try { raw = JSON.parse(text); } catch (err) { throw new CorruptStateError(`State for ${safeId} is not valid JSON: ${err.message}`); }
    return normalizeState(safeId, raw);
  }

  async function syncDir(dir) {
    let dh;
    try { dh = await fs.open(dir, 'r'); await dh.sync(); } catch (err) {
      if (!['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR'].includes(err.code)) throw err; // some filesystems cannot fsync a directory
    } finally { await dh?.close().catch(() => {}); }
  }

  async function save(state) {
    const base = await fileFor(assertSafeId(state.id));
    if (epoch !== undefined) state.lockEpoch = epoch;
    const file = epoch === undefined ? base : await confinement.resolve('state', `~${Buffer.from(state.id).toString('hex')}.epoch-${epoch}.json`);
    const dir = dirname(file);
    await fs.mkdir(dir, { recursive: true });
    const body = `${JSON.stringify(state, null, 2)}\n`;
    let tmp;
    let fh;
    for (let attempt = 0; ; attempt++) {
      tmp = `${file}.${process.pid}.${randomId()}.tmp`;
      try { fh = await fs.open(tmp, 'wx', 0o600); break; } catch (err) {
        if (err.code === 'EEXIST' && attempt < 4) continue; // never reuse or follow a pre-existing name
        throw err;
      }
    }
    try {
      try { await fh.writeFile(body); await fh.sync(); } finally { await fh.close(); }
      await fs.rename(tmp, file);
    } catch (err) {
      await fs.unlink(tmp).catch(() => {});
      throw err;
    }
    await syncDir(dir);
    return state;
  }

  /**
   * Read-modify-write one issue's state. Calls for the same state file run strictly one after another
   * (a per-file promise chain shared by every store in this process), so two overlapping updates, e.g.
   * a heartbeat and a recordArtifacts, can never load the same snapshot and overwrite each other. A
   * failing call (the callback throws) does not block the calls queued behind it. `fn` must not call
   * `update` for the same id itself (it would wait for its own turn forever). Nothing is written when
   * `fn` leaves the state unchanged, so a no-op (e.g. releasing a lease we do not own) never rewrites
   * state that another process may have changed in the meantime. With an epoch set (`setEpoch`) the update
   * is refused with `StaleEpochError` when the state carries a higher `lockEpoch`.
   */
  async function update(id, fn) {
    const key = await fileFor(id);
    const previous = CHAINS.get(key) ?? Promise.resolve();
    const run = previous.then(async () => {
      const state = await load(id);
      if (epoch !== undefined && state.lockEpoch > epoch) throw new StaleEpochError(`State for ${id} belongs to lock epoch ${state.lockEpoch}, this writer holds ${epoch}`);
      const before = JSON.stringify(state);
      const next = (await fn(state)) ?? state;
      if (JSON.stringify(next) === before) return next;
      if (epoch !== undefined) next.lockEpoch = epoch;
      return save(next);
    });
    const tail = run.then(() => {}, () => {});
    CHAINS.set(key, tail);
    tail.then(() => { if (CHAINS.get(key) === tail) CHAINS.delete(key); });
    return run;
  }

  const event = (state, type, detail) => { state.lastEvent = { type, at: now(), ...(detail === undefined ? {} : { detail }) }; };

  return {
    confinement,
    /** Set the lock epoch used to fence writes (see the store docs). */
    setEpoch(n) {
      if (!isCount(n)) throw new TypeError('epoch must be a non-negative integer');
      epoch = n;
    },
    load,
    save,
    update,

    /** Mark a phase as started. */
    beginPhase: (id, phase) => update(id, (s) => {
      if (!PHASES.includes(phase)) throw new TypeError(`Unknown phase: ${phase}`);
      Object.assign(s, { phase, status: 'working', heartbeatAt: now() });
      event(s, 'phase_started', phase);
    }),

    /** Record that `phase` completed; resume points are derived from this. */
    checkpoint: (id, phase, extra = {}) => update(id, (s) => {
      if (!PHASES.includes(phase)) throw new TypeError(`Unknown phase: ${phase}`);
      s.checkpoint = { phase, at: now() };
      s.heartbeatAt = now();
      if (Number.isInteger(extra.changedFiles)) s.changedFiles = extra.changedFiles;
      event(s, 'checkpoint', phase);
    }),

    /** Liveness signal from the lease owner. Does nothing when there is no lease or another owner holds it. */
    heartbeat: (id, owner) => update(id, (s) => {
      if (!s.lease || s.lease.owner !== owner) return; // no lease, or somebody else's: a stray heartbeat writes nothing
      s.heartbeatAt = now();
      s.lease.expiresAt = now() + leaseTtlMs;
    }),

    setEvent: (id, type, detail) => update(id, (s) => event(s, type, detail)),

    bump: (id, key) => update(id, (s) => {
      if (!(key in s.attempts)) throw new TypeError(`Unknown counter: ${key}`);
      s.attempts[key] += 1;
    }),

    /**
     * Spend one developer retry and reset the checkpoint in a single atomic write, so a crash can
     * never leave a bumped counter with the old checkpoint (or the reverse). Returns the saved state.
     * With `suspendPhase` (a phase that timed out while its handler may still run) the same write also leaves
     * the issue `queued` with a recovery record that resumes from the first phase, so the next wake retries.
     */
    retryDeveloper: (id, type, detail, { suspendPhase } = {}) => update(id, (s) => {
      const lastCheckpoint = s.checkpoint?.phase ?? null;
      s.attempts.developer += 1;
      s.checkpoint = null;
      if (suspendPhase !== undefined) {
        if (!PHASES.includes(suspendPhase)) throw new TypeError(`Unknown phase: ${suspendPhase}`);
        s.status = 'queued';
        s.recovery = { at: now(), interruptedPhase: suspendPhase, lastCheckpoint, resumePhase: PHASES[0], artifacts: { ...s.artifacts } };
      }
      event(s, type, detail);
    }),

    /**
     * End a wake in `interrupted` for a non-resumable phase that failed, using the same recovery
     * record shape as crash recovery. Artifacts are only recorded, never touched.
     */
    markInterrupted: (id, phase, type) => update(id, (s) => {
      if (!NON_RESUMABLE_PHASES.includes(phase)) throw new TypeError(`Phase is resumable: ${phase}`);
      s.status = 'interrupted';
      s.recovery = {
        at: now(), interruptedPhase: phase, lastCheckpoint: s.checkpoint?.phase ?? null,
        resumePhase: phase, artifacts: { ...s.artifacts },
      };
      event(s, type, phase);
    }),

    /** Take the per-issue lease unless another owner holds an unexpired one. */
    async acquireLease(id, owner) {
      let acquired = false;
      const state = await update(id, (s) => {
        if (s.lease && s.lease.owner !== owner && s.lease.expiresAt > now()) return;
        s.lease = { owner, expiresAt: now() + leaseTtlMs };
        s.heartbeatAt = now();
        acquired = true;
      });
      return { acquired, state };
    },

    /** Release the lease only if it is ours; otherwise nothing is written. */
    releaseLease: (id, owner) => update(id, (s) => { if (s.lease?.owner === owner) s.lease = null; }),

    /**
     * Record artifact locations (worktree / diff / output). Paths must stay inside the work root and are
     * stored as the confined absolute path. Unknown keys are rejected (`TypeError`), never dropped. Each
     * new path is appended to `artifactHistory` (never overwritten), so an earlier attempt's record survives.
     */
    recordArtifacts: (id, artifacts) => update(id, async (s) => {
      if (artifacts === undefined || artifacts === null) return;
      if (!isPlainObject(artifacts)) throw new TypeError('artifacts must be an object');
      const unknown = Object.keys(artifacts).filter((k) => !ARTIFACT_KEYS.includes(k));
      if (unknown.length) throw new TypeError(`Unknown artifact keys: ${unknown.join(', ')}`);
      const resolved = {};
      for (const key of ARTIFACT_KEYS) {
        if (artifacts[key] === undefined) continue;
        resolved[key] = await confinement.resolve(artifacts[key]);
      }
      for (const [key, path] of Object.entries(resolved)) {
        const latest = [...s.artifactHistory].reverse().find((h) => h.key === key);
        if (s.artifacts[key] !== path || latest?.path !== path) {
          s.artifactHistory.push({ key, path, at: now(), attempt: s.attempts.developer });
        }
        s.artifacts[key] = path;
      }
    }),

    /** Stale-lease / stale-heartbeat detection against the injected clock. */
    staleness(state) {
      const t = now();
      const leaseExpired = !state.lease || state.lease.expiresAt <= t;
      const heartbeatStale = state.heartbeatAt === null || t - state.heartbeatAt > heartbeatTimeoutMs;
      return { leaseExpired, heartbeatStale, stale: leaseExpired || heartbeatStale };
    },

    /**
     * Crash recovery for one issue. Never touches artifacts; only state is rewritten.
     * Returns `{ action: 'none' | 'held' | 'resume' | 'interrupted', ... }`.
     */
    async recover(id) {
      // Everything is decided inside the serialised update, so a heartbeat that lands before it is seen.
      let outcome = null;
      const state = await update(id, (s) => {
        if (isTerminal(s.status) || s.status !== 'working') { outcome = { action: 'none' }; return; }
        const stale = this.staleness(s);
        if (!stale.stale) { outcome = { action: 'held', owner: s.lease.owner }; return; }
        const interruptedPhase = s.phase;
        const lastDone = s.checkpoint?.phase ?? null;
        const resumePhase = PHASES[PHASES.indexOf(lastDone) + 1] ?? PHASES[0];
        s.lease = null;
        s.recovery = { at: now(), interruptedPhase, lastCheckpoint: lastDone, ...stale, artifacts: { ...s.artifacts } };
        if (NON_RESUMABLE_PHASES.includes(interruptedPhase)) {
          s.status = 'interrupted';
          s.recovery.resumePhase = interruptedPhase;
          event(s, 'interrupted', interruptedPhase);
          outcome = { action: 'interrupted' };
        } else {
          s.status = 'queued';
          s.recovery.resumePhase = resumePhase;
          event(s, 'recovered', resumePhase);
          outcome = { action: 'resume' };
        }
      });
      return outcome.action === 'resume' || outcome.action === 'interrupted'
        ? { ...outcome, resumePhase: state.recovery.resumePhase, state }
        : { ...outcome, state };
    },
  };
}
