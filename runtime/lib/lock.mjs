import { createHash, randomUUID } from 'node:crypto';
import { constants, realpathSync } from 'node:fs';
import * as realFs from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

/**
 * Anchored single-flight "epoch lock".
 *
 * Authority never lives in the configured work root: every lock record is stored under a private anchor
 * directory, so replacing or symlinking a directory inside the work root cannot redirect a lock write and
 * cannot reset the fencing token.
 *
 * Anchor root: `$RTW_STATE_DIR` when set (it *is* the anchor root), else `<XDG_STATE_HOME>/roundtable`, else
 * `~/.local/state/roundtable`. The anchor is created with mode 0700 and every open validates it: a real
 * directory (lstat; a symlink is refused), owned by the current uid, not group/world accessible
 * (`mode & 0o077 === 0`). `locks/` and the per-repo directory are validated the same way, and the per-repo
 * directory inode is recorded once in `locks/.repo-<repo-id>.json`; a later open that sees a different inode
 * refuses to use the directory (fail closed), so a replaced anchor directory can never issue a lower epoch.
 *
 * Layout: `<anchor>/locks/<repo-id>/<lock name>/epoch-<n>`, where `repo-id = sha256(realpath(repoRoot))`.
 * `<lock name>` is the last path component of the caller's `lockPath`; the caller's directory is irrelevant
 * (the in-repo `.roundtable/state/*.lock.d` path is at most a hint, never consulted).
 *
 * The holder is the owner of the highest epoch, as long as that record is not released and not stale:
 *  - acquire creates `epoch-(max+1)` with `link()` of a private temp file (`EEXIST` = somebody else won),
 *    then re-lists and fails when a higher epoch exists;
 *  - refresh and release rewrite only the owner's own epoch file (random `wx` temp file + `rename`), and check
 *    the record's `dev`+`ino` before and after the rewrite: a replaced record means the lock is lost;
 *  - released and superseded epochs are never judged "stale then removed"; old ones are garbage collected
 *    only below `max - EPOCH_KEEP` after a successful acquire.
 * The epoch is a monotonic fencing token (`handle.epoch`); `handle.anchorHighWater()` reads the highest epoch
 * present under the anchor (fail closed with `LockFenceError` when the anchor or the own record is gone).
 *
 * Atomicity boundary (what these checks do and do not close): the epoch create is atomic via `link()` and the
 * rewrite is atomic via `rename()`, both inside the anchor directory; the identity checks are pre/post
 * `lstat`/`fstat` comparisons, not a compare-and-swap. A same-uid process with write access to the private
 * anchor can still rename directories between two syscalls; the dev+ino binding makes such a swap invalidate
 * the handle (`refresh()`/`release()` report lost, `anchorHighWater()` throws) instead of silently succeeding,
 * and the token can never be reset below the inode-bound high-water mark, but no pure-Node filesystem call can
 * make "check then use" a single atomic step. Authority against another *user* is the anchor's ownership and
 * mode; authority against a stale *same-user* writer is the fencing token.
 *
 * Staleness: a holder is stale when it released, when its lease expired (`expiresAt <= now()`), or when it
 * runs on this host and its pid is gone. A holder on another host identity (a hash of the host name; never
 * the host name itself) with an unexpired lease is never taken over. Portable Node built-ins only: no
 * platform-specific descriptor paths, no native addons.
 */

export const EPOCH_NAME = /^epoch-(\d{1,15})$/;
export const MAX_LOCK_FILE_BYTES = 4096;
export const EPOCH_KEEP = 8;
const MAX_EPOCH = 999_999_999_999_999;
const TMP_PREFIX = '.tmp-';
const IDENTITY_PREFIX = '.repo-';
const MAX_IDENTITY_BYTES = 512;

/** The lock fence cannot be read any more (anchor replaced, record gone): state writes must fail closed. */
export class LockFenceError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = 'LockFenceError';
    this.code = 'RT_LOCK_LOST';
    Object.assign(this, extra);
  }
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

let cachedHostId;
/** Opaque identity of this host (a hash; never log it). Portable: no platform-specific descriptor paths. */
export function hostId() {
  if (cachedHostId) return cachedHostId;
  let name = '';
  try { name = String(hostname()); } catch { /* no host name available: the hash below is still opaque */ }
  cachedHostId = createHash('sha256').update(`rtw-host:${name}`).digest('hex').slice(0, 32);
  return cachedHostId;
}

/** The private anchor root (see the module docs). Pure function of the environment. */
export function anchorRootOf({ env = process.env, home = homedir() } = {}) {
  if (env?.RTW_STATE_DIR) return resolve(env.RTW_STATE_DIR);
  if (env?.XDG_STATE_HOME) return join(resolve(env.XDG_STATE_HOME), 'roundtable');
  return resolve(home, '.local', 'state', 'roundtable');
}

/** `sha256(realpath(repoRoot))`: the per-repo directory name under `<anchor>/locks/`. */
export function repoIdOf(repoRoot) {
  let real;
  try { real = realpathSync(repoRoot); } catch { real = resolve(repoRoot); }
  return createHash('sha256').update(real).digest('hex');
}

/**
 * The anchored lock directory for `lockPath` in `repoRoot` (default: the directory of `lockPath`), computed
 * with the same repo hashing `acquireLock` uses. Tests and callers can use it to inspect the lock records.
 */
export function lockDirectoryFor({ lockPath, repoRoot, anchorRoot, env = process.env } = {}) {
  const anchor = anchorRoot === undefined ? anchorRootOf({ env }) : resolve(anchorRoot);
  return join(anchor, 'locks', repoIdOf(repoRoot ?? dirname(lockPath)), basename(lockPath));
}

const fail = (reason, holder = null, extra = {}) => ({ acquired: false, holder, reason, ...extra });

/** Epoch numbers present in `names`, ascending: strict name regex, canonical decimal form only. */
function epochsOf(names) {
  const out = [];
  for (const name of names) {
    const m = EPOCH_NAME.exec(name);
    if (!m) continue;
    const n = Number(m[1]);
    if (String(n) === m[1]) out.push(n);
  }
  return out.sort((a, b) => a - b);
}

/** `mkdir -p` with mode 0700. Missing ancestors are created too; the result is validated by `privateDir`. */
async function mkdirPrivate(fs, path, label) {
  try {
    await fs.mkdir(path, { recursive: true, mode: 0o700 });
  } catch (err) {
    if (!['EEXIST', 'ENOTDIR'].includes(err.code)) return { ok: false, detail: `${label}:${err.code ?? 'mkdir_failed'}` };
  }
  return { ok: true };
}

/** Validate a directory the anchor depends on: real directory, our uid, no group/world access. */
async function privateDir(fs, path, uid, label) {
  let st;
  try { st = await fs.lstat(path); } catch (err) { return { ok: false, detail: `${label}:${err.code ?? 'lstat_failed'}` }; }
  if (st.isSymbolicLink() || !st.isDirectory()) return { ok: false, detail: `${label}:not_a_directory` };
  if (uid !== null && st.uid !== uid) return { ok: false, detail: `${label}:wrong_owner` };
  if ((st.mode & 0o077) !== 0) return { ok: false, detail: `${label}:insecure_mode` };
  return { ok: true, dev: st.dev, ino: st.ino };
}

/** Read the per-repo identity record (the dir inode an earlier open validated) without following symlinks. */
async function readIdentityFile(fs, file) {
  let fh;
  try {
    fh = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: true, missing: true };
    return { ok: false, detail: `identity:${err.code ?? 'open_failed'}` };
  }
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.size > MAX_IDENTITY_BYTES) return { ok: false, detail: 'identity:invalid' };
    const buf = Buffer.alloc(MAX_IDENTITY_BYTES + 1);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    if (bytesRead > MAX_IDENTITY_BYTES) return { ok: false, detail: 'identity:invalid' };
    let value;
    try { value = JSON.parse(buf.toString('utf8', 0, bytesRead)); } catch { return { ok: false, detail: 'identity:invalid' }; }
    if (!value || !Number.isFinite(value.dev) || !Number.isFinite(value.ino)) return { ok: false, detail: 'identity:invalid' };
    return { ok: true, value };
  } finally { await fh.close().catch(() => {}); }
}

/**
 * Create and validate the anchor chain: anchor -> locks/ -> <repo-id>/, and bind the per-repo directory inode
 * to `locks/.repo-<repo-id>.json` (created once). Returns the captured identities or a fail-closed reason.
 */
async function prepareAnchor(fs, { anchor, repoId, uid }) {
  const madeAnchor = await mkdirPrivate(fs, anchor, 'anchor');
  if (!madeAnchor.ok) return madeAnchor;
  const anchorStat = await privateDir(fs, anchor, uid, 'anchor');
  if (!anchorStat.ok) return anchorStat;
  const locks = join(anchor, 'locks');
  const madeLocks = await mkdirPrivate(fs, locks, 'locks');
  if (!madeLocks.ok) return madeLocks;
  const locksStat = await privateDir(fs, locks, uid, 'locks');
  if (!locksStat.ok) return locksStat;
  const repoDir = join(locks, repoId);
  const madeRepo = await mkdirPrivate(fs, repoDir, 'repo');
  if (!madeRepo.ok) return madeRepo;
  const repoStat = await privateDir(fs, repoDir, uid, 'repo');
  if (!repoStat.ok) return repoStat;
  const identityFile = join(locks, `${IDENTITY_PREFIX}${repoId}.json`);
  let identity = await readIdentityFile(fs, identityFile);
  if (!identity.ok) return identity;
  if (identity.missing) {
    // `wx` create: exactly one process records the first validated inode; a concurrent creator re-reads it.
    let fh;
    try {
      fh = await fs.open(identityFile, 'wx', 0o600);
      try { await fh.writeFile(JSON.stringify({ dev: repoStat.dev, ino: repoStat.ino })); await fh.sync(); } finally { await fh.close(); }
    } catch (err) {
      await fh?.close().catch(() => {});
      if (err.code !== 'EEXIST') return { ok: false, detail: `identity:${err.code ?? 'write_failed'}` };
    }
    identity = await readIdentityFile(fs, identityFile);
    if (!identity.ok) return identity;
    if (identity.missing) return { ok: false, detail: 'identity:missing' };
  }
  if (identity.value.dev !== repoStat.dev || identity.value.ino !== repoStat.ino) return { ok: false, detail: 'repo:id_changed' };
  return {
    ok: true, anchor, locks, repoDir, identityFile,
    anchorId: { dev: anchorStat.dev, ino: anchorStat.ino },
    locksId: { dev: locksStat.dev, ino: locksStat.ino },
    repoIdStat: { dev: repoStat.dev, ino: repoStat.ino },
  };
}

/** Re-validate every directory the handle depends on (called before each open and before each publish). */
async function validateAnchor(fs, ctx, uid) {
  const anchorStat = await privateDir(fs, ctx.anchor, uid, 'anchor');
  if (!anchorStat.ok) return anchorStat;
  if (anchorStat.dev !== ctx.anchorId.dev || anchorStat.ino !== ctx.anchorId.ino) return { ok: false, detail: 'anchor:replaced' };
  const locksStat = await privateDir(fs, ctx.locks, uid, 'locks');
  if (!locksStat.ok) return locksStat;
  if (locksStat.dev !== ctx.locksId.dev || locksStat.ino !== ctx.locksId.ino) return { ok: false, detail: 'locks:replaced' };
  const repoStat = await privateDir(fs, ctx.repoDir, uid, 'repo');
  if (!repoStat.ok) return repoStat;
  if (repoStat.dev !== ctx.repoIdStat.dev || repoStat.ino !== ctx.repoIdStat.ino) return { ok: false, detail: 'repo:replaced' };
  const identity = await readIdentityFile(fs, ctx.identityFile);
  if (!identity.ok) return identity;
  if (identity.missing) return { ok: false, detail: 'identity:missing' };
  if (identity.value.dev !== repoStat.dev || identity.value.ino !== repoStat.ino) return { ok: false, detail: 'repo:id_changed' };
  return { ok: true };
}

export async function acquireLock({
  lockPath, owner, repoRoot, anchorRoot, env = process.env, uid,
  now = Date.now, ttlMs = 5 * 60_000, isAlive = pidAlive,
  hostId: myHostId = hostId(), fs: fsOverride = {}, __hooks = {},
}) {
  const fs = { ...realFs, ...fsOverride };
  const hook = async (name, info) => { if (__hooks[name]) await __hooks[name](info); };
  const token = randomUUID();
  const currentUid = uid === undefined ? (typeof process.getuid === 'function' ? process.getuid() : null) : uid;
  const lockName = typeof lockPath === 'string' ? basename(lockPath) : '';
  if (!lockName || lockName === '.' || lockName === '..') return fail('invalid_lock_path');
  const anchor = anchorRoot === undefined ? anchorRootOf({ env }) : resolve(anchorRoot);
  const ctx = await prepareAnchor(fs, { anchor, repoId: repoIdOf(repoRoot ?? dirname(lockPath)), uid: currentUid });
  if (!ctx.ok) return fail('invalid_anchor', null, { detail: ctx.detail });
  const lockDir = join(ctx.repoDir, lockName);
  const madeLockDir = await mkdirPrivate(fs, lockDir, 'lock_dir');
  if (!madeLockDir.ok) return fail('invalid_anchor', null, { detail: madeLockDir.detail });
  const lockDirStat = await privateDir(fs, lockDir, currentUid, 'lock_dir');
  if (!lockDirStat.ok) return fail('invalid_lock_dir', null, { detail: lockDirStat.detail });
  ctx.lockDir = lockDir;
  ctx.lockDirId = { dev: lockDirStat.dev, ino: lockDirStat.ino };
  const fileOf = (epoch) => join(lockDir, `epoch-${epoch}`);
  const record = (epoch, extra = {}, acquiredAt) => JSON.stringify({
    owner, pid: process.pid, hostId: myHostId, token, epoch,
    acquiredAt, expiresAt: now() + ttlMs, ...extra,
  });

  let ownRef = null;
  let ownEpoch = 0;
  let acquiredAt = 0;
  let lost = false;
  let released = false;
  // Refresh, release and the fence read all inspect and rewrite the same record: run them one at a time, so a
  // renewal timer and a wake never rewrite each other's temp file (the loser would see a foreign dev+ino).
  let rewriteChain = Promise.resolve();
  const serialise = (fn) => {
    const run = rewriteChain.then(fn, fn);
    rewriteChain = run.then(() => {}, () => {});
    return run;
  };

  /** Write `content` to a fresh random temp file (`wx`, 0600); the temp file never survives a failure. */
  async function writeTemp(content) {
    const path = join(lockDir, `${TMP_PREFIX}${randomUUID()}`);
    try {
      await fs.writeFile(path, content, { flag: 'wx', mode: 0o600 });
      const st = await fs.lstat(path);
      return { path, dev: st.dev, ino: st.ino };
    } catch (err) {
      await fs.unlink(path).catch(() => {});
      throw err;
    }
  }

  /** Highest epoch in the anchored lock directory (0 when none, null when the directory is not there any more). */
  async function highestEpoch() {
    let names;
    try { names = await fs.readdir(lockDir); } catch (err) {
      if (['ENOENT', 'ENOTDIR'].includes(err.code)) return null;
      throw err;
    }
    const list = epochsOf(names);
    return list.length ? list[list.length - 1] : 0;
  }

  /**
   * Read an epoch file without following symlinks and without reading more than 4 KiB. Returns
   * `{ ok:true, missing?, holder, dev?, ino? }` (holder null when the content is not a JSON object) or
   * `{ ok:false, reason }`.
   */
  async function readEpoch(epoch) {
    const path = fileOf(epoch);
    let st;
    try { st = await fs.lstat(path); } catch (err) { if (['ENOENT', 'ENOTDIR'].includes(err.code)) return { ok: true, missing: true, holder: null }; throw err; }
    if (!st.isFile() || st.size > MAX_LOCK_FILE_BYTES) return { ok: false, reason: 'invalid_epoch_file' };
    let fh;
    try {
      fh = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (err) {
      if (err.code === 'ENOENT') return { ok: true, missing: true, holder: null };
      if (err.code === 'ELOOP') return { ok: false, reason: 'invalid_epoch_file' };
      throw err;
    }
    try {
      const fst = await fh.stat();
      if (!fst.isFile() || fst.size > MAX_LOCK_FILE_BYTES) return { ok: false, reason: 'invalid_epoch_file' };
      const buf = Buffer.alloc(MAX_LOCK_FILE_BYTES + 1);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      if (bytesRead > MAX_LOCK_FILE_BYTES) return { ok: false, reason: 'invalid_epoch_file' };
      let holder = null;
      try { const v = JSON.parse(buf.toString('utf8', 0, bytesRead)); if (v && typeof v === 'object' && !Array.isArray(v)) holder = v; } catch { /* unparsable: no holder */ }
      return { ok: true, holder, dev: fst.dev, ino: fst.ino };
    } finally { await fh.close().catch(() => {}); }
  }

  /** Our own record, only when it is still the exact file (`dev`+`ino`) this handle created or last published. */
  async function ownRecord() {
    if (!ownRef) return null;
    const cur = await readEpoch(ownEpoch);
    if (!cur.ok || cur.missing || !cur.holder) return null;
    if (cur.dev !== ownRef.dev || cur.ino !== ownRef.ino) return null;
    return cur;
  }

  const isStale = (h) => {
    if (!h || h.released === true) return true;
    if (!(h.expiresAt > now())) return true;
    return h.hostId === myHostId && !isAlive(h.pid);
  };

  /** Every directory the anchor depends on is still the validated one: anything else is a lost lock. */
  async function validateLive() {
    const check = await validateAnchor(fs, ctx, currentUid);
    if (!check.ok) return false;
    const lockDirNow = await privateDir(fs, lockDir, currentUid, 'lock_dir');
    if (!lockDirNow.ok) return false;
    return lockDirNow.dev === ctx.lockDirId.dev && lockDirNow.ino === ctx.lockDirId.ino;
  }

  /** Swap/timeout errors from a write: the record we were about to publish is gone; report lost, never throw. */
  const isSwapError = (err) => ['ENOENT', 'ENOTDIR', 'EISDIR', 'ELOOP'].includes(err?.code);

  const handle = {
    acquired: true,
    token,
    lockDirectory: lockDir,
    anchorRoot: anchor,
    get epoch() { return ownEpoch; },
    /**
     * Highest epoch present under the anchor (the fencing high-water mark), read fresh on every call. Throws
     * `LockFenceError` when the anchor, the own record's identity or the lock directory is no longer valid,
     * so a state write can never be fenced by a token the anchor does not back (fail closed).
     */
    anchorHighWater() {
      return serialise(async () => {
        if (!(await validateLive())) throw new LockFenceError('lock anchor is no longer valid');
        const cur = await ownRecord();
        if (!cur || cur.holder.token !== token || cur.holder.released === true) throw new LockFenceError('lock record is no longer ours');
        const high = await highestEpoch();
        if (high === null) throw new LockFenceError('lock directory is no longer valid');
        return high;
      });
    },
    /** Extend the lease. false when the lease already expired, a higher epoch exists, or the record is not ours. */
    refresh() {
      return serialise(async () => {
        if (lost || released) return false;
        const lose = () => { lost = true; return false; };
        if (!(await validateLive())) return lose();
        const high = await highestEpoch();
        if (high === null) return lose();
        if (high > ownEpoch) return lose();
        const cur = await ownRecord();
        if (!cur || cur.holder.token !== token || cur.holder.released === true) return lose();
        const previousExpiresAt = cur.holder.expiresAt;
        if (!(previousExpiresAt > now())) return lose();
        await hook('beforeRefreshWrite', { epoch: ownEpoch });
        let tmp;
        try { tmp = await writeTemp(record(ownEpoch, {}, acquiredAt)); } catch (err) { if (isSwapError(err)) return lose(); throw err; }
        // Identity check again immediately before publishing: a record swapped while the temp file was being
        // written must never be overwritten (the write would resurrect a lost lock).
        const current = await ownRecord();
        if (!current || current.holder.token !== token) {
          await fs.unlink(tmp.path).catch(() => {});
          return lose();
        }
        try { await fs.rename(tmp.path, fileOf(ownEpoch)); } catch (err) {
          await fs.unlink(tmp.path).catch(() => {});
          if (isSwapError(err)) return lose();
          throw err;
        }
        await hook('afterRefreshWrite', { epoch: ownEpoch });
        // Post-publish identity: the name must still point at the file we wrote (its dev+ino) and carry our
        // token. A swap after our check shows up here instead of being treated as a valid rewrite.
        const after = await readEpoch(ownEpoch);
        if (!after.ok || after.missing || after.dev !== tmp.dev || after.ino !== tmp.ino || after.holder?.token !== token) return lose();
        ownRef = { dev: after.dev, ino: after.ino };
        const afterHigh = await highestEpoch();
        if (afterHigh === null || afterHigh > ownEpoch) return lose();
        if (!(previousExpiresAt > now())) {
          // The previous lease ran out while we were writing: a taker may already have judged the old file
          // stale and be about to link the next epoch, so this refresh cannot count. Do not revive the lease;
          // best effort, mark our file released (same temp + rename path) so it never claims a live lease.
          try {
            const tmp2 = await writeTemp(record(ownEpoch, { released: true }, acquiredAt));
            try { await fs.rename(tmp2.path, fileOf(ownEpoch)); ownRef = { dev: tmp2.dev, ino: tmp2.ino }; } catch (err) { await fs.unlink(tmp2.path).catch(() => {}); if (!isSwapError(err)) throw err; }
          } catch { /* the handle is lost either way */ }
          return lose();
        }
        return true;
      });
    },
    /** Mark our epoch file released (never unlinked). Resolves true, or false with `handle.releaseReason`. */
    release() {
      return serialise(async () => {
        handle.releaseReason = null;
        if (released) return true;
        if (!(await validateLive())) { handle.releaseReason = 'lock_lost'; return false; }
        const cur = await ownRecord();
        if (!cur || cur.holder.token !== token) { handle.releaseReason = 'not_owner'; return false; }
        let tmp;
        try { tmp = await writeTemp(record(ownEpoch, { released: true }, acquiredAt)); } catch (err) {
          if (isSwapError(err)) { handle.releaseReason = 'lock_lost'; return false; }
          throw err;
        }
        const current = await ownRecord();
        if (!current || current.holder.token !== token) {
          await fs.unlink(tmp.path).catch(() => {});
          handle.releaseReason = 'not_owner';
          return false;
        }
        try { await fs.rename(tmp.path, fileOf(ownEpoch)); } catch (err) {
          await fs.unlink(tmp.path).catch(() => {});
          if (isSwapError(err)) { handle.releaseReason = 'lock_lost'; return false; }
          throw err;
        }
        const after = await readEpoch(ownEpoch);
        if (!after.ok || after.missing || after.dev !== tmp.dev || after.ino !== tmp.ino || after.holder?.token !== token) {
          handle.releaseReason = 'not_owner';
          return false;
        }
        ownRef = { dev: after.dev, ino: after.ino };
        released = true;
        return true;
      });
    },
    releaseReason: null,
  };

  for (let attempt = 0; attempt < 8; attempt++) {
    // Directories can be replaced while we wait; re-validate before every attempt to link.
    if (!(await validateLive())) return fail('invalid_anchor', null, { detail: 'anchor:replaced' });
    const max = await highestEpoch();
    if (max === null) return fail('invalid_lock_dir');
    await hook('afterList', { max });
    let holder = null;
    if (max > 0) {
      const cur = await readEpoch(max);
      if (!cur.ok) return fail(cur.reason);
      if (cur.missing) continue; // vanished (garbage collected) between list and read: list again
      holder = cur.holder;
      if (!isStale(holder)) return fail('held', holder);
    }
    if (max + 1 > MAX_EPOCH) return fail('epoch_overflow', holder);
    const next = max + 1;
    acquiredAt = now();
    let tmp;
    try { tmp = await writeTemp(record(next, {}, acquiredAt)); } catch (err) { if (isSwapError(err)) return fail('invalid_lock_dir'); throw err; }
    await hook('beforeLink', { epoch: next });
    try {
      await fs.link(tmp.path, fileOf(next));
    } catch (err) {
      if (err.code === 'EEXIST') continue; // somebody else created this epoch first: re-read it
      if (isSwapError(err)) return fail('invalid_lock_dir');
      throw err; // ENOTSUP / EPERM: fail closed, no non-exclusive fallback
    } finally {
      await fs.unlink(tmp.path).catch(() => {});
    }
    ownEpoch = next;
    await hook('afterLink', { epoch: next });
    // The name we just created must be the file we wrote (link keeps the inode). Snapshot dev+ino so every
    // later rewrite can prove it is still operating on our own record.
    const own = await readEpoch(next);
    if (!own.ok || own.missing || own.dev !== tmp.dev || own.ino !== tmp.ino || own.holder?.token !== token) {
      lost = true;
      return fail('invalid_epoch_file', holder);
    }
    ownRef = { dev: own.dev, ino: own.ino };
    const afterHigh = await highestEpoch();
    if (afterHigh === null) { lost = true; return fail('invalid_lock_dir'); }
    if (afterHigh > next) { lost = true; return fail('superseded', holder); }
    if (max > 0) {
      // We judged `max` stale from a snapshot that may be older than now: its holder may have refreshed
      // (rename) after we read it. Look again after the link. Either its rename came first and we see a live
      // lease here and step down, or it comes later and its own post-rename check sees our epoch and loses.
      const prev = await readEpoch(max);
      if (prev.ok && !prev.missing && !isStale(prev.holder)) {
        lost = true;
        await handle.release().catch(() => {});
        return fail('superseded', prev.holder);
      }
    }
    await gc(next);
    return handle;
  }
  return fail('contended');

  async function gc(newest) {
    try {
      // Never unlink through a directory that is no longer the validated one (best effort, and only names
      // far below the newest epoch are ever candidates).
      if (!(await validateLive())) return;
      for (const n of epochsOf(await fs.readdir(lockDir))) {
        if (n >= newest - EPOCH_KEEP) break;
        const path = fileOf(n);
        const st = await fs.lstat(path).catch(() => null);
        if (st?.isFile()) await fs.unlink(path).catch(() => {});
      }
    } catch { /* garbage collection is best effort */ }
  }
}
