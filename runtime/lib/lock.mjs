import { randomUUID } from 'node:crypto';
import { link, readFile, rename, unlink, writeFile } from 'node:fs/promises';

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MUTEX_TTL_MS = 10_000;
const MUTEX_WAIT_MS = 2_000;

async function readRaw(path) {
  try { return await readFile(path, 'utf8'); } catch (err) { if (err.code === 'ENOENT') return null; throw err; }
}

function parse(raw) {
  try { return JSON.parse(raw); } catch { return null; }
}

/** Create `path` with `content` atomically (temp file + hard link): readers never see a partial file. */
async function createExclusive(path, content, tmp) {
  await writeFile(tmp, content, { flag: 'wx' });
  try {
    await link(tmp, path);
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

/**
 * Remove the file `path` that was judged stale because its content was `staleRaw`, without ever
 * deleting a different file that replaced it in the meantime. A plain "re-read, then unlink" is a
 * check-then-act race. So the file is first renamed to the unique name `aside` (atomic: whatever sits
 * at `path` at that instant is the file we hold), then its content is read. Only if it equals
 * `staleRaw` is it deleted; otherwise it was somebody's live file, and it is put back with `link()`
 * (never overwriting: EEXIST is ignored).
 *
 * Known limitation: while a live file is held aside, `path` is absent for the duration of one read and
 * one link (microseconds). A third process creating `path` in that gap would overlap the live
 * holder, and the put-back is then lost (EEXIST). Or the live file's holder may already have finished;
 * the put-back then restores a guard whose pid is still alive and unexpired, which is not judged stale, so
 * it can block further breaking for up to `MUTEX_TTL_MS` (about 10 s). Meanwhile `withMutex` gives up
 * after about 2 s and returns `ok:false`. That is a liveness effect, not an exclusion violation: the lock
 * acquisition fails and the issue is retried on the next wake. It needs a crashed holder plus several
 * simultaneous contenders at the same instant. It is only used for the `.break` guard below, which is
 * itself held for microseconds, so a stale one needs a crash inside that window; no atomic primitive
 * available here closes the gap completely.
 */
export async function removeStaleFile(path, staleRaw, aside) {
  try {
    await rename(path, aside);
  } catch (err) {
    if (err.code === 'ENOENT') return; // someone else already removed it
    throw err;
  }
  try {
    if ((await readRaw(aside)) !== staleRaw) {
      await link(aside, path).catch((err) => { if (err.code !== 'EEXIST') throw err; });
    }
  } finally {
    await unlink(aside).catch(() => {});
  }
}

const isStaleMutexBody = (raw) => {
  const other = raw === null ? null : parse(raw);
  return raw !== null && (!other || !pidAlive(other.pid) || !(other.expiresAt > Date.now()));
};

/**
 * Remove the mutex `mutexPath` whose content `raw` was judged stale (crashed holder). Several
 * contenders may judge it stale at once, and "check content, then unlink" would let a slow one delete
 * the live mutex a faster one created in between. So removal is serialised by a second guard file
 * `<mutex>.break`, created exclusively like the mutex; only its holder re-checks the content and
 * unlinks, so while the guard is held nobody else removes the mutex and a replaced mutex (content
 * differs) is left alone. A guard left behind by a crashed breaker is itself removed with
 * `removeStaleFile` (see its known limitation). Returns false when another breaker holds the guard.
 */
async function breakStaleMutex(mutexPath, raw, id) {
  const breakPath = `${mutexPath}.break`;
  const mine = JSON.stringify({ pid: process.pid, id, expiresAt: Date.now() + MUTEX_TTL_MS });
  if (await createExclusive(breakPath, mine, `${breakPath}.${process.pid}.${id}.tmp`)) {
    try {
      if ((await readRaw(mutexPath)) === raw) await unlink(mutexPath).catch(() => {});
    } finally {
      if ((await readRaw(breakPath)) === mine) await unlink(breakPath).catch(() => {});
    }
    return true;
  }
  const guard = await readRaw(breakPath);
  if (isStaleMutexBody(guard)) await removeStaleFile(breakPath, guard, `${breakPath}.${process.pid}.${id}.stale`);
  return false;
}

/**
 * Run `fn` while holding the short-lived mutex `<lockPath>.mutex`. Every mutation of an existing lock
 * (stale takeover, refresh, release) happens inside it, so none of them can interleave. The mutex is
 * created atomically with its pid and a short expiry; one whose pid is dead or whose expiry has
 * passed is removed (its critical section lasts milliseconds, so this only happens after a crash).
 * Returns `{ ok:false }` when the mutex could not be obtained within `waitMs`.
 */
async function withMutex(lockPath, fn, waitMs = MUTEX_WAIT_MS) {
  const mutexPath = `${lockPath}.mutex`;
  const id = randomUUID();
  const mine = JSON.stringify({ pid: process.pid, id, expiresAt: Date.now() + MUTEX_TTL_MS });
  const deadline = Date.now() + waitMs;
  for (;;) {
    if (await createExclusive(mutexPath, mine, `${mutexPath}.${process.pid}.${id}.tmp`)) break;
    const raw = await readRaw(mutexPath);
    if (isStaleMutexBody(raw) && (await breakStaleMutex(mutexPath, raw, id))) continue;
    if (Date.now() >= deadline) return { ok: false };
    await sleep(5 + Math.floor(Math.random() * 10));
  }
  try {
    return { ok: true, value: await fn() };
  } finally {
    if ((await readRaw(mutexPath)) === mine) await unlink(mutexPath).catch(() => {});
  }
}

/**
 * Single-flight lock: an exclusively created lock file holding pid, token and lease expiry.
 * The file is created atomically with its content (temp file + hard link), so readers never see
 * a half-written lock. A lock is stale when its pid is gone or its lease has expired.
 *
 * Taking over a stale lock is mutually exclusive: the contender takes the takeover mutex, re-reads
 * the lock, checks it is still the same stale holder (identical file content), removes it and
 * creates its own lock with an exclusive link, then re-reads the file to confirm the token is its
 * own. A possibly live lock is never moved aside. refresh() and release() use the same mutex and
 * re-verify the token inside it, so a superseded holder can neither overwrite nor delete the
 * lock of its successor.
 */
export async function acquireLock({ lockPath, owner, now = Date.now, ttlMs = 5 * 60_000, isAlive = pidAlive }) {
  const token = randomUUID();
  const body = () => JSON.stringify({ owner, pid: process.pid, token, acquiredAt: now(), expiresAt: now() + ttlMs });
  const tmp = () => `${lockPath}.${process.pid}.${token}.${randomUUID().slice(0, 8)}.tmp`;
  const ownsNow = async () => parse(await readRaw(lockPath) ?? '')?.token === token;

  const handle = {
    acquired: true,
    token,
    async refresh() {
      const res = await withMutex(lockPath, async () => {
        if (!(await ownsNow())) return false;
        const next = `${lockPath}.${process.pid}.${token}.refresh`;
        await writeFile(next, body());
        await rename(next, lockPath);
        return true;
      });
      return res.ok && res.value;
    },
    async release() {
      await withMutex(lockPath, async () => { if (await ownsNow()) await unlink(lockPath).catch(() => {}); });
    },
  };

  for (let attempt = 0; attempt < 5; attempt++) {
    if (await createExclusive(lockPath, body(), tmp())) {
      if (await ownsNow()) return handle;
      return { acquired: false, holder: parse(await readRaw(lockPath) ?? '') };
    }
    const raw = await readRaw(lockPath);
    if (raw === null) continue; // released between our link attempt and the read: try again
    const holder = parse(raw);
    const stale = !holder || !isAlive(holder.pid) || !(holder.expiresAt > now());
    if (!stale) return { acquired: false, holder };

    const res = await withMutex(lockPath, async () => {
      const current = await readRaw(lockPath);
      if (current === null) return 'retry';
      if (current !== raw) return 'changed'; // someone replaced or refreshed it: not the holder we judged stale
      await unlink(lockPath);
      return 'removed';
    });
    if (!res.ok) return { acquired: false, holder: parse(await readRaw(lockPath) ?? '') };
    if (res.value === 'changed') return { acquired: false, holder: parse(await readRaw(lockPath) ?? '') };
    // 'removed' / 'retry': loop and create the lock with an exclusive link (losing that race is fine).
  }
  return { acquired: false, holder: parse(await readRaw(lockPath) ?? '') };
}
