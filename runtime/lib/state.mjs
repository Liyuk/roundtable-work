import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
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
  recovery: null,
});

/**
 * Durable per-issue state under `<workRoot>/state/<id>.json`. All paths go through the confinement,
 * writes are atomic (temp file + rename). Artifact paths are only ever recorded, never deleted.
 */
export async function createStateStore({ workRoot, now = Date.now, leaseTtlMs = 60_000, heartbeatTimeoutMs = 120_000 }) {
  const confinement = await createConfinement(workRoot);
  const fileFor = (id) => confinement.resolve('state', `${assertSafeId(id)}.json`);

  async function load(id) {
    try {
      return { ...freshState(assertSafeId(id)), ...JSON.parse(await readFile(await fileFor(id), 'utf8')) };
    } catch (err) {
      if (err.code === 'ENOENT') return freshState(assertSafeId(id));
      throw err;
    }
  }

  async function save(state) {
    const file = await fileFor(state.id);
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`);
      await rename(tmp, file);
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw err;
    }
    return state;
  }

  /**
   * Read-modify-write one issue's state. Calls for the same state file run strictly one after another
   * (a per-file promise chain shared by every store in this process), so two overlapping updates, e.g.
   * a heartbeat and a recordArtifacts, can never load the same snapshot and overwrite each other. A
   * failing call (the callback throws) does not block the calls queued behind it. `fn` must not call
   * `update` for the same id itself (it would wait for its own turn forever). Nothing is written when
   * `fn` leaves the state unchanged, so a no-op (e.g. releasing a lease we do not own) never rewrites
   * state that another process may have changed in the meantime.
   */
  async function update(id, fn) {
    const key = await fileFor(id);
    const previous = CHAINS.get(key) ?? Promise.resolve();
    const run = previous.then(async () => {
      const state = await load(id);
      const before = JSON.stringify(state);
      const next = (await fn(state)) ?? state;
      return JSON.stringify(next) === before ? next : save(next);
    });
    const tail = run.then(() => {}, () => {});
    CHAINS.set(key, tail);
    tail.then(() => { if (CHAINS.get(key) === tail) CHAINS.delete(key); });
    return run;
  }

  const event = (state, type, detail) => { state.lastEvent = { type, at: now(), ...(detail === undefined ? {} : { detail }) }; };

  return {
    confinement,
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

    /** Liveness signal from the lease owner. Does nothing when another owner holds the lease. */
    heartbeat: (id, owner) => update(id, (s) => {
      if (s.lease && s.lease.owner !== owner) return;
      s.heartbeatAt = now();
      if (s.lease) s.lease.expiresAt = now() + leaseTtlMs;
    }),

    setEvent: (id, type, detail) => update(id, (s) => event(s, type, detail)),

    bump: (id, key) => update(id, (s) => {
      if (!(key in s.attempts)) throw new TypeError(`Unknown counter: ${key}`);
      s.attempts[key] += 1;
    }),

    /**
     * Spend one developer retry and reset the checkpoint in a single atomic write, so a crash can
     * never leave a bumped counter with the old checkpoint (or the reverse). Returns the saved state.
     */
    retryDeveloper: (id, type, detail) => update(id, (s) => {
      s.attempts.developer += 1;
      s.checkpoint = null;
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

    /** Record artifact locations (worktree / diff / output). Paths must stay inside the work root. */
    recordArtifacts: (id, artifacts) => update(id, async (s) => {
      for (const key of ARTIFACT_KEYS) {
        if (artifacts?.[key] === undefined) continue;
        await confinement.resolve(artifacts[key]);
        s.artifacts[key] = artifacts[key];
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
      const before = await load(id);
      if (isTerminal(before.status) || before.status !== 'working') return { action: 'none', state: before };
      const stale = this.staleness(before);
      if (!stale.stale) return { action: 'held', owner: before.lease.owner, state: before };

      const interruptedPhase = before.phase;
      const lastDone = before.checkpoint?.phase ?? null;
      const resumePhase = PHASES[PHASES.indexOf(lastDone) + 1] ?? PHASES[0];
      const state = await update(id, (s) => {
        s.lease = null;
        s.recovery = { at: now(), interruptedPhase, lastCheckpoint: lastDone, ...stale, artifacts: { ...s.artifacts } };
        if (NON_RESUMABLE_PHASES.includes(interruptedPhase)) {
          s.status = 'interrupted';
          s.recovery.resumePhase = interruptedPhase;
          event(s, 'interrupted', interruptedPhase);
        } else {
          s.status = 'queued';
          s.recovery.resumePhase = resumePhase;
          event(s, 'recovered', resumePhase);
        }
      });
      return { action: state.status === 'interrupted' ? 'interrupted' : 'resume', resumePhase: state.recovery.resumePhase, state };
    },
  };
}
