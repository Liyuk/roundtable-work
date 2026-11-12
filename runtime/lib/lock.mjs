import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readlinkSync } from 'node:fs';
import * as realFs from 'node:fs/promises';
import { constants } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';

/**
 * Single-flight "epoch lock".
 *
 * Assumptions: one work root per queue; the directory lives on a local POSIX filesystem that supports
 * `link()` and atomic `rename()` (a filesystem without `link()` makes `acquireLock` reject, it is never
 * degraded to a non-exclusive create); clock skew is much smaller than the lease TTL; every expiry
 * decision uses the injected `now()`, never `Date.now`.
 *
 * Layout: `lockPath` is a directory holding files `epoch-<n>`. The holder is the owner of the highest
 * epoch, as long as that file is not released and not stale. Nobody ever unlinks or replaces a name
 * somebody else may be using:
 *  - acquire creates `epoch-(max+1)` with `link()` of a private temp file (`EEXIST` = somebody else won),
 *    then re-lists and fails when a higher epoch exists;
 *  - refresh and release rewrite only the owner's own epoch file (random `wx` temp file + `rename`);
 *  - released and superseded epochs are never judged "stale then removed"; old ones are garbage collected
 *    only below `max - EPOCH_KEEP` after a successful acquire.
 * The epoch is a monotonic fencing token (`handle.epoch`).
 *
 * Staleness: a holder is stale when it released, when its lease expired (`expiresAt <= now()`), or when it
 * runs on this host and its pid is gone. A holder on another host identity (hostname, boot id, pid
 * namespace; stored only as a hash) with an unexpired lease is never taken over.
 */

export const EPOCH_NAME = /^epoch-(\d{1,15})$/;
export const MAX_LOCK_FILE_BYTES = 4096;
export const EPOCH_KEEP = 8;
const MAX_EPOCH = 999_999_999_999_999;
const TMP_PREFIX = '.tmp-';

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

let cachedHostId;
/** Opaque identity of this host / boot / pid namespace (a hash; never log it). */
export function hostId() {
  if (cachedHostId) return cachedHostId;
  const part = (fn) => { try { return String(fn()).trim(); } catch { return ''; } };
  const material = [
    part(() => hostname()),
    part(() => readFileSync('/proc/sys/kernel/random/boot_id', 'utf8')),
    part(() => readlinkSync('/proc/self/ns/pid')),
  ].join('\n');
  cachedHostId = createHash('sha256').update(material).digest('hex').slice(0, 32);
  return cachedHostId;
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

export async function acquireLock({
  lockPath, owner, now = Date.now, ttlMs = 5 * 60_000, isAlive = pidAlive,
  hostId: myHostId = hostId(), fs: fsOverride = {}, __hooks = {},
}) {
  const fs = { ...realFs, ...fsOverride };
  const hook = async (name, info) => { if (__hooks[name]) await __hooks[name](info); };
  const token = randomUUID();
  const fileOf = (epoch) => join(lockPath, `epoch-${epoch}`);
  const record = (epoch, extra = {}, acquiredAt) => JSON.stringify({
    owner, pid: process.pid, hostId: myHostId, token, epoch,
    acquiredAt, expiresAt: now() + ttlMs, ...extra,
  });

  /** Write `content` to a fresh random temp file (`wx`, 0600); the temp file never survives a failure. */
  async function writeTemp(content) {
    const tmp = join(lockPath, `${TMP_PREFIX}${randomUUID()}`);
    try {
      await fs.writeFile(tmp, content, { flag: 'wx', mode: 0o600 });
    } catch (err) {
      await fs.unlink(tmp).catch(() => {});
      throw err;
    }
    return tmp;
  }

  /** Highest epoch in the directory (0 when none). */
  async function highestEpoch() {
    const list = epochsOf(await fs.readdir(lockPath));
    return list.length ? list[list.length - 1] : 0;
  }

  /**
   * Read an epoch file without following symlinks and without reading more than 4 KiB.
   * Returns { ok:true, holder } (holder null when the content is not a JSON object) or { ok:false, reason }.
   */
  async function readEpoch(epoch) {
    const path = fileOf(epoch);
    let st;
    try { st = await fs.lstat(path); } catch (err) { if (err.code === 'ENOENT') return { ok: true, missing: true, holder: null }; throw err; }
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
      return { ok: true, holder };
    } finally { await fh.close().catch(() => {}); }
  }

  const isStale = (h) => {
    if (!h || h.released === true) return true;
    if (!(h.expiresAt > now())) return true;
    return h.hostId === myHostId && !isAlive(h.pid);
  };

  // The lock directory itself must be a real directory (never a symlink, FIFO, file).
  try { await fs.mkdir(lockPath, { recursive: true, mode: 0o700 }); } catch (err) { if (err.code !== 'EEXIST') throw err; }
  let dirStat;
  try { dirStat = await fs.lstat(lockPath); } catch (err) { if (err.code === 'ENOENT') return fail('invalid_lock_dir'); throw err; }
  if (!dirStat.isDirectory()) return fail('invalid_lock_dir');

  let ownEpoch = 0;
  let acquiredAt = 0;
  let lost = false;
  let released = false;

  const handle = {
    acquired: true,
    token,
    get epoch() { return ownEpoch; },
    /** Extend the lease. false when the lease already expired, a higher epoch exists, or the file is not ours. */
    async refresh() {
      if (lost || released) return false;
      const lose = () => { lost = true; return false; };
      if ((await highestEpoch()) > ownEpoch) return lose();
      const cur = await readEpoch(ownEpoch);
      if (!cur.ok || !cur.holder || cur.holder.token !== token || cur.holder.released === true) return lose();
      const previousExpiresAt = cur.holder.expiresAt;
      if (!(previousExpiresAt > now())) return lose();
      await hook('beforeRefreshWrite', { epoch: ownEpoch });
      const tmp = await writeTemp(record(ownEpoch, {}, acquiredAt));
      try { await fs.rename(tmp, fileOf(ownEpoch)); } catch (err) { await fs.unlink(tmp).catch(() => {}); throw err; }
      await hook('afterRefreshWrite', { epoch: ownEpoch });
      if ((await highestEpoch()) > ownEpoch) return lose();
      if (!(previousExpiresAt > now())) {
        // The previous lease ran out while we were writing: a taker may already have judged the old file
        // stale and be about to link the next epoch, so this refresh cannot count. Do not revive the lease;
        // best effort, mark our file released (same temp + rename path) so it never claims a live lease.
        try {
          const tmp2 = await writeTemp(record(ownEpoch, { released: true }, acquiredAt));
          try { await fs.rename(tmp2, fileOf(ownEpoch)); } catch (err) { await fs.unlink(tmp2).catch(() => {}); throw err; }
        } catch { /* the handle is lost either way */ }
        return lose();
      }
      return true;
    },
    /** Mark our epoch file released (never unlinked). Resolves true, or false with `handle.releaseReason`. */
    async release() {
      handle.releaseReason = null;
      if (released) return true;
      const cur = await readEpoch(ownEpoch);
      if (!cur.ok || !cur.holder || cur.holder.token !== token) { handle.releaseReason = 'not_owner'; return false; }
      const tmp = await writeTemp(record(ownEpoch, { released: true }, acquiredAt));
      try { await fs.rename(tmp, fileOf(ownEpoch)); } catch (err) { await fs.unlink(tmp).catch(() => {}); throw err; }
      released = true;
      return true;
    },
    releaseReason: null,
  };

  for (let attempt = 0; attempt < 8; attempt++) {
    const max = await highestEpoch();
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
    const tmp = await writeTemp(record(next, {}, acquiredAt));
    await hook('beforeLink', { epoch: next });
    try {
      await fs.link(tmp, fileOf(next));
    } catch (err) {
      if (err.code === 'EEXIST') continue; // somebody else created this epoch first: re-read it
      throw err; // ENOTSUP / EPERM: fail closed, no non-exclusive fallback
    } finally {
      await fs.unlink(tmp).catch(() => {});
    }
    ownEpoch = next;
    await hook('afterLink', { epoch: next });
    if ((await highestEpoch()) > next) { lost = true; return fail('superseded', holder); }
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
      for (const n of epochsOf(await fs.readdir(lockPath))) {
        if (n >= newest - EPOCH_KEEP) break;
        const path = fileOf(n);
        const st = await fs.lstat(path).catch(() => null);
        if (st?.isFile()) await fs.unlink(path).catch(() => {});
      }
    } catch { /* garbage collection is best effort */ }
  }
}
