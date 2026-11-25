#!/usr/bin/env python3
"""rt-sched.py [--dry-run] [--once]

Long-running scheduler of rt-loop v2 (replaces queue.txt). Pulls issues authored by the owner from GitHub,
claims up to RT_WORKERS of them, and runs one detached rt-work.sh per issue.

  --dry-run  read-only: no labels, no comments, no spawning, no local state writes except logs
             (logs `DRY would claim ...` / `DRY skip #n: reason`)
  --once     run a single cycle and exit

Python 3 stdlib only. Uses the REAL gh (/usr/bin/gh, or $RT_GH_REAL); the pi side only sees the guarded bin/gh.
"""
import argparse
import datetime
import fcntl
import glob
import json
import os
import random
import re
import signal
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
RT_HOME = os.path.abspath(os.path.expanduser(os.environ.get("RT_HOME") or HERE))
GH = os.environ.get("RT_GH_REAL", "/usr/bin/gh")
GH_READ_TIMEOUT = 60   # s per gh read call (#652)
GH_JITTER = 2.0        # s, upper bound of the pause before the one retry of a failed read
BRIDGE = os.path.join(HERE, "outbox-bridge.mjs")
TIMER_CLI = os.path.join(HERE, "bin", "rt-timers.mjs")

TERMINAL = {"done", "stop", "error", "out-of-scope"}
EXCLUDE_LABELS = ["rt:owner", "rt:running", "rt:ask", "rt:ready-to-merge", "rt:blocked", "rt:hold", "rt:merged", "rt:deferred"]
MARKER_ANY = "<!-- rt:"
MARKER_ASK = "<!-- rt:ask -->"
READ_ONLY_GH = {("issue", "list"), ("issue", "view"), ("pr", "list"), ("pr", "view"), ("label", "list"), ("run", "list")}


# ----------------------------------------------------------------- config ----
def load_config(path):
    """Parse KEY=VALUE lines (trailing ` # comment` allowed), as sourced by bash."""
    cfg = {}
    try:
        for line in open(path, encoding="utf-8", errors="replace"):
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            v = re.split(r"\s+#", v, maxsplit=1)[0].strip().strip("'\"")
            cfg[k.strip()] = v
    except OSError:
        pass
    return cfg



def read_lines(path):
    try:
        return [x for x in open(path, encoding="utf-8", errors="replace").read().split("\n") if x]
    except OSError:
        return []


# -------------------------------------------- resource admission ----
# Hard hold on *new claims only*. Running workers are never killed.
# Thresholds are read from config.env each cycle (see claim_hold_reason).
THROTTLE_LOG_INTERVAL = 600  # same reason logged at most once per 10 minutes
RESUME_HOLD_SEC = 300        # after a long cycle gap, delay new claims this long


def nproc():
    try:
        n = len(os.sched_getaffinity(0))
        if n:
            return n
    except (OSError, AttributeError):
        pass
    return os.cpu_count() or 1


def _cfg_float(cfg, key, default):
    try:
        v = (cfg or {}).get(key, "")
        if v is None or str(v).strip() == "":
            return float(default)
        return float(v)
    except (TypeError, ValueError):
        return float(default)


def mem_available_mb(path="/proc/meminfo"):
    """MemAvailable in MiB, or None if unreadable."""
    try:
        for line in open(path, encoding="utf-8", errors="replace"):
            if line.startswith("MemAvailable:"):
                return int(line.split()[1]) / 1024.0
    except (OSError, ValueError, IndexError):
        return None
    return None


def mem_psi_some_avg60(path="/proc/pressure/memory"):
    """some avg60 from a pressure file, or None if unreadable."""
    try:
        for line in open(path, encoding="utf-8", errors="replace"):
            if line.startswith("some "):
                m = re.search(r"\bavg60=([0-9.]+)", line)
                if m:
                    return float(m.group(1))
    except (OSError, ValueError):
        return None
    return None


def resource_pressure(cfg=None, load1=None, avail_mb=None, psi=None):
    """Return (reason_keys, detail_parts). Empty keys means no resource hold.

    Thresholds: RT_MAX_LOAD (default nproc*1.0), RT_MIN_MEM_MB (default 2500),
    RT_MAX_MEM_PSI (default 10). Unreadable metrics are skipped (fail open).
    Optional load1/avail_mb/psi override the live samples (tests).
    """
    cfg = cfg or {}
    keys, parts = [], []
    max_load = _cfg_float(cfg, "RT_MAX_LOAD", nproc() * 1.0)
    min_mem = _cfg_float(cfg, "RT_MIN_MEM_MB", 2500)
    max_psi = _cfg_float(cfg, "RT_MAX_MEM_PSI", 10)
    if load1 is None:
        try:
            load1 = os.getloadavg()[0]
        except OSError:
            load1 = None
    if avail_mb is None:
        avail_mb = mem_available_mb()
    if psi is None:
        psi = mem_psi_some_avg60()
    if load1 is not None and load1 > max_load:
        keys.append("load")
        parts.append("load=%.2f > %.2f" % (load1, max_load))
    if avail_mb is not None and avail_mb < min_mem:
        keys.append("mem")
        parts.append("mem_available=%dMB < %dMB" % (int(avail_mb), int(min_mem)))
    if psi is not None and psi > max_psi:
        keys.append("psi")
        parts.append("mem_psi_some_avg60=%.2f > %.2f" % (psi, max_psi))
    return keys, parts


# ---------------------------------------------------------- pure helpers ----
_DEP_LINE = re.compile(r"^\s*(?:[-*>]\s*)?(?:\*\*|__)?\s*(?:depends on|blocked by)\b(.*)$", re.I)


def parse_deps(body):
    """Issue numbers from lines starting with `Depends on` / `Blocked by`. The clause ends at the first
    sentence end after a number ('#26. Related: ...') or at 'Related'/'Parent'; other lines are ignored."""
    deps = []
    for line in (body or "").splitlines():
        m = _DEP_LINE.match(line)
        if not m:
            continue
        rest = re.split(r"(?<=\d)\.(?:\s|$)|\bRelated\b|\bParent\b", m.group(1), maxsplit=1)[0]
        for x in re.findall(r"#(\d+)", rest):
            if int(x) not in deps:
                deps.append(int(x))
    return deps


def series_key(title):
    """First [...] bracket, tag up to space/slash, trailing letter dropped: [Pages 4/4]->Pages, [RT-3b]->RT-3, [I18N-4]->I18N-4."""
    m = re.search(r"\[([^\]]*)\]", title or "")
    if not m:
        return None
    # 2026-11-14 supervisor: the old key cut at the first dash, so every [RT-*] title became series 'RT'
    # and all RT issues ran one at a time (1/8 slots). Keep the full tag, only dropping a trailing letter
    # suffix: [RT-3b]->RT-3 (sub-steps still serialize), [RT-F-1c]->RT-F-1, [RT-7]->RT-7, [Pages 4/4]->Pages.
    tok = re.split(r"[\s/:]+", m.group(1).strip(), maxsplit=1)[0]
    tok = re.sub(r"(\d)[a-z]$", r"\1", tok)
    return tok or None


def is_epic(issue):
    names = {l["name"] for l in issue.get("labels", [])}
    return "epic" in names or re.search(r"\bepic\b", issue.get("title", ""), re.I) is not None


def parse_status_ts(s):
    try:
        return time.mktime(time.strptime(s[:19], "%Y-%m-%d %H:%M:%S"))
    except Exception:
        return 0.0


def parse_iso(s):
    return datetime.datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()


def prio_rank(names):
    for i, p in enumerate(("priority:p0", "priority:p1", "priority:p2")):
        if p in names:
            return i
    return 3


def prio_str(names):
    t = "bug" if "type:bug" in names else ("feature" if "type:feature" in names else "untyped")
    p = next((x.split(":")[1] for x in ("priority:p0", "priority:p1", "priority:p2") if x in names), "none")
    return "%s/%s%s" % (t, p, "/self" if "rt:self" in names else "")


def is_followup(issue):
    names = {l["name"] for l in issue["labels"]}
    return "rt:followup" in names or issue.get("title", "").startswith("Gate 2 follow-up")


def sort_key(issue):
    names = {l["name"] for l in issue["labels"]}
    return (1 if is_followup(issue) else 0, 0 if "type:bug" in names else 1, prio_rank(names), 0 if "rt:self" in names else 1,
            issue.get("createdAt", ""), issue["number"])


def closable_verified(issue, status, kids, allst, prs, main_runs):
    """#646: a verified-complete issue closes itself once every recorded child is closed, no PR is open, nothing blocks it and the
    newest main Check run is green (a pending or red newest run is not green yet). Pure: no I/O."""
    if ("rt:ready-to-merge" not in issue["names"] or prs or "verified complete" not in str(status.get("detail", ""))
            or issue["names"] & {"rt:hold", "rt:blocked", "rt:ask", "rt:running"}):
        return False
    if not all(allst.get(k) == "CLOSED" for k in kids):
        return False
    r = main_runs[0] if main_runs else {}
    return r.get("status") == "completed" and r.get("conclusion") == "success"


# -------------------------------------------------------------- scheduler ----
class Sched:
    def __init__(self, dry, once):
        self.dry, self.once = dry, once
        self.cfg = load_config(os.path.join(RT_HOME, "config.env"))
        c = self.cfg
        self.repo = c.get("RT_REPO", "Liyuk/roundtable-work")
        self.owner = c.get("RT_OWNER", "Liyuk")
        raw = c.get("RT_AUTHOR_ALLOWLIST", "").strip() or self.owner   # issue authors the scheduler claims
        self.authors = {a.strip() for a in raw.split(",") if a.strip()}
        self.workers_max = int(c.get("RT_WORKERS", "2"))
        self.poll = int(c.get("RT_POLL", "300"))
        self.handsoff = {int(x) for x in re.split(r"[\s,]+", c.get("RT_HANDS_OFF_PRS", "")) if x.isdigit()}
        self.sweep_retry = int(c.get("RT_SWEEP_RETRY", "900"))
        self.main_red = False
        self.cycle_no = 0
        self.backlog = self.claimable = self.idle_cycles = 0   # heartbeat counters, set by cycle()
        self.gh_good = {}     # key -> (cycle no, last good read), see gh_read_cached
        self.last_sweep = {}   # n -> (head sha, time)
        self.aux = {}          # revert helpers: sha7 -> Popen
        self.state = os.path.join(RT_HOME, "state")
        self.logs = os.path.join(RT_HOME, "logs")
        self.status_path = os.path.join(RT_HOME, "status.tsv")
        self.procs = {}        # n -> {proc, slot, started, series}
        self.prev_active = {}  # n -> info, for detecting adopted workers that finished
        self.fail_count = {}   # n -> consecutive crashed worker runs
        self.stop_flag = False
        self._last_cycle_wall = None
        self._resume_hold_until = 0.0
        self._gap_warned_from = None
        self._throttle_logged = {}  # reason_key -> last log epoch
        self._unresolved_logged = {}  # (issue, dep) -> last log epoch (#540)
        dirs = [self.logs, os.path.join(self.logs, "work")]   # logs are allowed in dry-run
        if not dry:
            dirs += [self.state, os.path.join(RT_HOME, "locks"), os.path.join(self.state, "issues"),
                     os.path.join(self.state, "children"), os.path.join(self.state, "supervisor"), os.path.join(RT_HOME, "wt")]
        for d in dirs:
            os.makedirs(d, exist_ok=True)

    # ---- logging
    def log(self, msg):
        line = "%s %s" % (time.strftime("%F %T %Z"), msg)
        print(line, flush=True)
        try:
            with open(os.path.join(self.logs, "sched.log"), "a", encoding="utf-8") as f:
                f.write(line + "\n")
        except OSError:
            pass

    # ---- gh
    def gh_read(self, args):
        assert tuple(args[:2]) in READ_ONLY_GH, "refusing non-read-only gh call: %s" % args[:2]
        for attempt in range(2):   # one retry after a jittered pause (#652)
            if attempt:
                time.sleep(random.uniform(0, GH_JITTER))
            try:
                r = subprocess.run([GH] + args, capture_output=True, text=True, timeout=GH_READ_TIMEOUT)
                if r.returncode == 0:
                    return json.loads(r.stdout or "null")
                err = r.stderr.strip()[:200]
            except subprocess.TimeoutExpired:
                err = "timed out after %ds" % GH_READ_TIMEOUT
        msg = "gh %s failed: %s" % (" ".join(args[:2]), err)
        self.log("gh_read_fail " + msg)   # counted by grep; one line per failed read
        raise RuntimeError(msg)

    def gh_try(self, args):
        """gh_read, or None when the read failed (gh_read has counted it)."""
        try:
            return self.gh_read(args)
        except RuntimeError:
            return None

    def gh_read_cached(self, key, args):
        """(value, fresh): a live read; when it fails, the last good answer for `key` if it is at most 2 cycles old, else None."""
        v = self.gh_try(args)
        if v is not None:
            self.gh_good[key] = (self.cycle_no, v)
            return v, True
        at, last = self.gh_good.get(key, (0, None))
        return (last if self.cycle_no - at <= 2 else None), False

    def gh_write(self, args, what, stdin=None):
        """Every GitHub write goes through here; in dry-run nothing is executed."""
        if self.dry:
            self.log("DRY would %s" % what)
            return True
        r = subprocess.run([GH] + args, capture_output=True, text=True, input=stdin, timeout=120)
        if r.returncode != 0:
            self.log("WARN gh write failed (%s): %s" % (what, r.stderr.strip()[:200]))
            return False
        return True

    def gh_outbox(self, args, what, stdin=None):
        """Labels and comments go through the durable outbox (host/outbox-bridge.mjs); in dry-run nothing is executed."""
        if self.dry:
            self.log("DRY would %s" % what)
            return True
        r = subprocess.run(["node", BRIDGE, RT_HOME, self.repo] + args, capture_output=True, text=True, input=stdin, timeout=120,
                           env=dict(os.environ, RT_GH_REAL=GH))
        if r.returncode != 0:
            self.log("WARN gh write failed (%s): %s" % (what, r.stderr.strip()[:200]))
            return False
        return True

    def add_label(self, n, label):
        return self.gh_outbox(["label", str(n), "add", label], "add label %s to #%d" % (label, n))

    def rm_label(self, n, label):
        return self.gh_outbox(["label", str(n), "rm", label], "remove label %s from #%d" % (label, n))

    def comment(self, n, body):
        return self.gh_outbox(["comment", str(n), "-"], "comment on #%d" % n, stdin=body)

    def comments(self, n):
        d = self.gh_read(["issue", "view", str(n), "-R", self.repo, "--json", "comments"])
        return (d or {}).get("comments", [])

    # ---- status.tsv (shared flock with rt-work.sh)
    def read_status(self):
        st = {}
        try:
            for line in open(self.status_path, encoding="utf-8", errors="replace"):
                p = line.rstrip("\n").split("\t")
                if len(p) >= 4 and p[0].isdigit():
                    st[int(p[0])] = {"state": p[1], "wake": p[2], "ts": p[3], "detail": p[4] if len(p) > 4 else ""}
        except OSError:
            pass
        return st

    def set_status(self, n, state, wake, detail):
        if self.dry:
            self.log("DRY would set status #%d %s (%s)" % (n, state, detail))
            return
        with open(os.path.join(self.state, "status.lock"), "w") as lk:
            fcntl.flock(lk, fcntl.LOCK_EX)
            rows = []
            try:
                rows = [l for l in open(self.status_path, encoding="utf-8", errors="replace").read().splitlines() if not l.startswith("%d\t" % n)]
            except OSError:
                pass
            detail = re.sub(r"[\t\r\n]+", " ", detail)[:300]
            rows.append("\t".join([str(n), state, str(wake), time.strftime("%F %T %Z"), detail]))
            tmp = self.status_path + ".sched.tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                f.write("\n".join(rows) + "\n")
            os.replace(tmp, self.status_path)

    # ---- per-issue persistent state (same file as bin/rt-state)
    def issue_state(self, n):
        try:
            return json.load(open(os.path.join(self.state, "issues", "%d.json" % n)))
        except (OSError, ValueError):
            return {}

    def reset_counters(self, n):
        """Owner acted on the issue: give it fresh decider / fix / review budgets."""
        if self.dry:
            self.log("DRY would reset counters of #%d" % n)
            return
        p = os.path.join(self.state, "issues", "%d.json" % n)
        with open(p + ".lock", "w") as lk:
            fcntl.flock(lk, fcntl.LOCK_EX)
            d = self.issue_state(n)
            for k in ("decide_n", "fix_n", "review_n", "safety_n", "opus_fix_n", "opus_exploit_n"):
                d[k] = 0
            d["merge_hold"] = ""
            with open(p + ".tmp", "w") as f:
                json.dump(d, f, sort_keys=True)
            os.replace(p + ".tmp", p)

    def count_sweep_requeue(self, n):
        """The resume sweep's own requeue count; reset_counters leaves it alone, so the sweep requeues an issue at most once."""
        if self.dry:
            return
        p = os.path.join(self.state, "issues", "%d.json" % n)
        with open(p + ".lock", "w") as lk:
            fcntl.flock(lk, fcntl.LOCK_EX)
            d = self.issue_state(n)
            d["sweep_requeue_n"] = d.get("sweep_requeue_n", 0) + 1
            with open(p + ".tmp", "w") as f:
                json.dump(d, f, sort_keys=True)
            os.replace(p + ".tmp", p)

    def gates_ok(self, n, head):
        try:
            g = json.load(open(os.path.join(RT_HOME, "wt", str(n), ".roundtable", "state", "gates.json")))
        except (OSError, ValueError):
            return False
        return (g.get("head") == head and g.get("gate0") in ("pass", "overridden") and g.get("gate1") == "pass"
                and g.get("gate2") in ("pass", "skipped", "unavailable"))

    # ---- supervisor note for the worker
    def write_supervisor(self, n, text):
        if self.dry:
            self.log("DRY would write SUPERVISOR.md for #%d (%d chars)" % (n, len(text)))
            return
        wt_state = os.path.join(RT_HOME, "wt", str(n), ".roundtable", "state")
        if os.path.isdir(os.path.dirname(wt_state)):
            os.makedirs(wt_state, exist_ok=True)
            path = os.path.join(wt_state, "SUPERVISOR.md")
        else:   # worktree not created yet / elsewhere: the worker picks this up on start
            path = os.path.join(self.state, "supervisor", "%d.md" % n)
        with open(path, "w", encoding="utf-8") as f:
            f.write(text.rstrip("\n") + "\n")
        self.log("#%d supervisor note written (%s)" % (n, os.path.relpath(path, RT_HOME)))

    # ---- workers
    def locked(self, n):
        """True if rt-work.sh holds locks/<n>.lock."""
        p = os.path.join(RT_HOME, "locks", "%d.lock" % n)
        if not os.path.exists(p):
            return False
        with open(p, "a") as f:
            try:
                fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError:
                return True
            fcntl.flock(f, fcntl.LOCK_UN)
        return False

    def worker_info(self, n):
        try:
            pid, slot = open(os.path.join(RT_HOME, "locks", "%d.info" % n)).read().split()[:2]
            return int(pid), int(slot)
        except Exception:
            return 0, 0

    def active_workers(self):
        """n -> {pid, slot, own} for every live worker (own children + adopted ones found via their lock)."""
        act = {}
        for n, w in self.procs.items():
            if w["proc"].poll() is None:
                act[n] = {"pid": w["proc"].pid, "slot": w["slot"], "own": True}
        for p in glob.glob(os.path.join(RT_HOME, "locks", "*.lock")):
            m = re.match(r"(\d+)\.lock$", os.path.basename(p))
            if m and int(m.group(1)) not in act and self.locked(int(m.group(1))):
                pid, slot = self.worker_info(int(m.group(1)))
                act[int(m.group(1))] = {"pid": pid, "slot": slot, "own": False}
        return act

    def reap(self):
        for n in list(self.procs):
            rc = self.procs[n]["proc"].poll()
            if rc is None:
                continue
            w = self.procs.pop(n)
            st = self.read_status().get(n, {})
            self.log("worker #%d exited rc=%s state=%s %s" % (n, rc, st.get("state", "-"), (st.get("detail", "") or "")[:120]))
            if rc != 0 and rc != 3:
                self.fail_count[n] = self.fail_count.get(n, 0) + 1
                if st.get("state") == "running":
                    self.set_status(n, "error", st.get("wake", 0), "worker exited rc=%s without a final state" % rc)
            elif rc == 0:
                self.fail_count[n] = 0
        act = self.active_workers()
        for n in list(self.prev_active):
            if n not in act and n not in self.procs and not self.prev_active[n].get("own"):
                st = self.read_status().get(n, {})
                self.log("adopted worker #%d finished state=%s %s" % (n, st.get("state", "-"), (st.get("detail", "") or "")[:120]))
        self.prev_active = act
        return act

    def spawn(self, n, slot, base, title, extra=()):
        ts = time.strftime("%Y%m%d-%H%M%S")
        logf = os.path.join(self.logs, "work", "%d-%s.log" % (n, ts))
        env = dict(os.environ)
        env.update(self.cfg)
        env["RT_HOME"] = RT_HOME
        env["RT_SLOT"] = str(slot)
        cmd = [os.path.join(RT_HOME, "rt-work.sh"), str(n)] + ([base] if base and base != "main" else []) + list(extra)
        out = open(logf, "ab")
        proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.STDOUT,
                                start_new_session=True, close_fds=True, env=env, cwd=RT_HOME)
        out.close()
        self.procs[n] = {"proc": proc, "slot": slot, "started": time.time(), "series": series_key(title)}
        self.log("spawned worker #%d slot=%d base=%s%s pid=%d log=%s" % (n, slot, base or "main", " " + " ".join(extra) if extra else "", proc.pid, os.path.relpath(logf, RT_HOME)))

    # ---- one scheduling cycle
    def reload_cfg(self):
        self.cfg = load_config(os.path.join(RT_HOME, "config.env"))
        try:  # owner 2026-11-12: RT_WORKERS / RT_POLL changes take effect without a restart
            w = int(self.cfg.get("RT_WORKERS", str(self.workers_max)))
            if w >= 1 and w != self.workers_max:
                self.log("config reload: workers %d -> %d" % (self.workers_max, w))
                self.workers_max = w
            self.poll = int(self.cfg.get("RT_POLL", str(self.poll)))
            # RT_MAX_LOAD / RT_MIN_MEM_MB / RT_MAX_MEM_PSI are read from self.cfg in claim_hold_reason
        except (ValueError, AttributeError):
            pass

    def note_cycle_gap(self):
        """If wall time since the last cycle exceeds 3x poll, log WARN once and start a 5-min claim hold."""
        now = time.time()
        last = self._last_cycle_wall
        if last and now - last > 3 * self.poll:
            if self._gap_warned_from != last:
                self.log("WARN scheduler cycle gap %ds (> 3x poll; box freeze or stalled wait)" % (now - last))
                self._gap_warned_from = last
                self._resume_hold_until = max(self._resume_hold_until, now + RESUME_HOLD_SEC)
        return now

    def claim_hold_reason(self):
        """Why new claims must pause this cycle, or None. Running workers are left alone.

        Logs 'INFO throttle: ...' at most once per 10 minutes for the same reason key.
        """
        now = self.note_cycle_gap()
        keys, parts = resource_pressure(self.cfg)
        if now < self._resume_hold_until:
            left = int(self._resume_hold_until - now)
            keys = ["resume"] + keys
            parts = ["resume hold %ds after cycle gap" % left] + parts
        if not keys:
            return None
        reason_key = "+".join(keys)
        detail = ", ".join(parts)
        last_log = self._throttle_logged.get(reason_key, 0)
        if now - last_log >= THROTTLE_LOG_INTERVAL:
            self.log("INFO throttle: %s; no new claims (running workers untouched)" % detail)
            self._throttle_logged[reason_key] = now
        return detail

    def resolved_harness(self):
        """Harness a newly started role would use right now.

        Honors RT_FORCE_HARNESS, then RT_HARNESS, then the DeepSeek off-peak window.
        Reloads config.env so flipping the force switch takes effect on the next cycle.
        """
        self.reload_cfg()
        try:
            out = subprocess.check_output([os.path.join(RT_HOME, "bin", "rt-window"), "--harness"],
                                          text=True, timeout=8)
            h = out.strip()
            if h in ("pi", "codex"):
                return h
        except (OSError, subprocess.SubprocessError):
            pass
        force = (self.cfg.get("RT_FORCE_HARNESS") or "").strip().lower()
        if force in ("pi", "codex"):
            return force
        pinned = (self.cfg.get("RT_HARNESS") or "auto").strip().lower()
        if pinned in ("pi", "codex"):
            return pinned
        return "codex"

    def limit_active(self):
        """Model usage limit / 429 flagged by bin/rt-limit: a wait, never a stuck or blocked issue.

        Only the harness that would be chosen *now* can block claims. A DeepSeek/pi limit
        does not pause the loop once the peak window starts (codex takes over), and a
        codex limit does not fall back to DeepSeek unless the current window is off-peak.
        """
        wanted = self.resolved_harness()
        try:
            out = subprocess.check_output([os.path.join(RT_HOME, "bin", "rt-limit"), "active", "--harness", wanted],
                                          text=True, timeout=8)
            text = (out or "").strip()
            return text or "later"
        except subprocess.CalledProcessError as e:
            if e.returncode == 1:
                return None
        except (OSError, subprocess.SubprocessError):
            pass
        # Fallback: read the flag file directly (per-harness or legacy single entry).
        try:
            d = json.load(open(os.path.join(self.state, "harness-limit.json")))
            entries = d.get("by_harness") if isinstance(d.get("by_harness"), dict) else None
            if entries:
                e = entries.get(wanted) or {}
            elif d.get("harness", wanted) == wanted or "harness" not in d:
                e = d
            else:
                e = {}
            if int(e.get("until") or 0) > time.time():
                return e.get("until_text") or str(e["until"])
        except (OSError, ValueError, KeyError, TypeError):
            pass
        return None

    def fire_timers(self):
        """Fire due timers into the event inbox (rt-timers.mjs). Skipped on STOP or during a cycle-gap hold."""
        if self.dry or os.path.exists(os.path.join(RT_HOME, "STOP")) or time.time() < self._resume_hold_until:
            return
        try:
            r = subprocess.run(["node", TIMER_CLI, RT_HOME], capture_output=True, text=True, timeout=60)
        except (OSError, subprocess.SubprocessError) as e:
            return self.log("ERROR timers %s" % e)
        if r.returncode != 0:
            return self.log("ERROR timers exit %d: %s" % (r.returncode, r.stderr.strip().split("\n")[-1]))
        n = int(r.stdout)
        if n:
            self.log("timers fired %d event(s) into the inbox" % n)

    def resume_waits(self, status):
        """Timer-wait release (state `waiting`, written by rt-work.sh): an unacked inbox event routed to the issue (its due
        timer, or an awaited event such as CI) makes it queued, so the claim step resumes it. Acked here, so each wakes once."""
        state = os.path.join(RT_HOME, ".roundtable", "state")
        acked = set(read_lines(os.path.join(state, "acked.jsonl")))
        routed = {}
        for line in read_lines(os.path.join(state, "event-inbox.jsonl")):
            e = json.loads(line)
            if "type" not in e and e["issue"] is not None and e["source_event_id"] not in acked:
                routed.setdefault(e["issue"], []).append(e["source_event_id"])
        for n, ids in routed.items():
            if (status.get(n) or {}).get("state") != "waiting":
                continue
            self.log("%s#%d: wait released by inbox event %s; queued to resume" % ("DRY " if self.dry else "", n, ids[0]))
            self.set_status(n, "queued", status[n]["wake"], "resumed by inbox event %s" % ids[0])
            status[n]["state"] = "queued"
            if not self.dry:
                with open(os.path.join(state, "acked.jsonl"), "a", encoding="utf-8") as f:
                    f.write("".join(i + "\n" for i in ids))

    def cycle(self):
        self.cycle_no += 1
        self.reload_cfg()
        self.note_cycle_gap()
        self.fire_timers()
        if not self.dry:
            try:
                subprocess.run([os.path.join(os.path.dirname(os.path.abspath(__file__)), 'bin', 'rt-tmpclean')], timeout=120)
            except Exception:
                pass
        act = self.reap()
        lim = self.limit_active()
        if lim:
            self.log("model usage limit until %s: no sweeps, claims or resumes this cycle (running workers keep going)" % lim)
            # main health and revert-on-red need no model: keep them running during a usage-limit wait
            self.check_main()
            return
        # GitHub reads (#652): a failed read is counted and skipped; claims need the open issue and PR lists and allst/merged
        opened = [self.gh_read_cached("open:" + a, ["issue", "list", "-R", self.repo, "--state", "open", "--author", a, "-L", "200",
                                                    "--json", "number,title,body,labels,createdAt"]) for a in sorted(self.authors)]
        prs_raw = self.gh_try(["pr", "list", "-R", self.repo, "--state", "open", "-L", "200",
                               "--json", "number,headRefName,baseRefName,headRefOid,labels,isDraft,title,comments"])
        allst_raw = self.gh_read_cached("allst", ["issue", "list", "-R", self.repo, "--state", "all", "-L", "500", "--json", "number,state"])[0]
        merged_raw = self.gh_read_cached("merged", ["pr", "list", "-R", self.repo, "--state", "merged", "-L", "500", "--json", "number,headRefName,body"])[0]
        claims_ok = all(fresh for _, fresh in opened) and prs_raw is not None and allst_raw is not None and merged_raw is not None
        issues = [i for v, _ in opened for i in v or []]   # the last good list when a read failed (orphans still respawn)
        self.backlog = sum("rt:running" not in {l["name"] for l in i["labels"]} for i in issues)   # open, unclaimed
        prs = prs_raw or []
        allst = {i["number"]: i["state"] for i in allst_raw or []}
        merged_prs = merged_raw or []
        merged = {p["number"] for p in merged_prs}
        closed_raw = self.gh_try(["pr", "list", "-R", self.repo, "--state", "closed", "-L", "500", "--json", "number,headRefName,body"])
        closed_prs = [p for p in closed_raw or [] if p["number"] not in merged]
        status = self.read_status()
        byn = {i["number"]: i for i in issues}
        for i in issues:
            i["names"] = {l["name"] for l in i["labels"]}

        def prs_of(n):
            return [p for p in prs if re.match(r"^rt/%d-" % n, p["headRefName"])]

        # 2a. decomposed parents: release rt:hold when all children are closed
        for i in issues:
            n = i["number"]
            cf = os.path.join(self.state, "children", str(n))
            if "rt:hold" in i["names"] and os.path.exists(cf):
                kids = [int(x) for x in open(cf).read().split() if x.isdigit()]
                if kids and all(allst.get(k) == "CLOSED" for k in kids):
                    self.log("#%d: all sub-issues closed (%s), releasing rt:hold" % (n, ", ".join("#%d" % k for k in kids)))
                    if self.rm_label(n, "rt:hold"):
                        i["names"].discard("rt:hold")
                        self.write_supervisor(n, "All sub-issues of this issue are closed (%s). Verify the acceptance criteria of THIS issue against "
                                                 "the current main. If everything is satisfied, write DECISION done with line 2 starting `no-pr` "
                                                 "(then a one-line summary); if something is missing, implement the remainder and open a PR."
                                              % ", ".join("#%d" % k for k in kids))
                        self.set_status(n, "queued", 0, "children closed; resumed")
                        status[n] = {"state": "queued", "wake": "0", "ts": time.strftime("%F %T"), "detail": "children closed"}

        # 2a'. verified-complete parents/leaves left waiting for the owner (rt-work fell back because main CI was pending/red at
        # that moment): close them once closable_verified says so (#646)
        cands = [i for i in issues if "rt:ready-to-merge" in i["names"]]
        runs = []
        if cands:
            try:
                runs = self.gh_read(["run", "list", "-R", self.repo, "--branch", "main", "--workflow", "Check", "-L", "5", "--json", "conclusion,status"])
            except Exception as e:
                self.log("WARN main Check unreadable for verified-complete close: %s" % e)
        for i in cands:
            n = i["number"]
            cf = os.path.join(self.state, "children", str(n))
            kids = [int(x) for x in open(cf).read().split() if x.isdigit()] if os.path.exists(cf) else []
            if not closable_verified(i, status.get(n) or {}, kids, allst, prs_of(n), runs):
                continue
            self.log("#%d: verified complete, all sub-issues closed, main green: closing" % n)
            self.comment(n, "<!-- rt:summary -->\nAll sub-issues are closed and main CI is green again; the earlier verification stands. Closing as complete (reopen to undo).")
            if self.gh_write(["issue", "close", str(n), "-R", self.repo], "close #%d" % n):
                self.rm_label(n, "rt:ready-to-merge")
                i["names"].discard("rt:ready-to-merge")
                self.set_status(n, "done", 0, "no PR needed (verified complete, closed by sweep)")
                allst[n] = "CLOSED"   # same cycle: intake below sees dependents of n as unblocked (#646)
                status[n] = {"state": "done", "wake": "0", "ts": time.strftime("%F %T"), "detail": "no PR needed (verified complete, closed by sweep)"}

        # 2b. ask-resume
        for i in issues:
            n = i["number"]
            if "rt:ask" not in i["names"]:
                continue
            try:
                cm = self.comments(n)
            except Exception as e:
                self.log("WARN comments of #%d unreadable: %s" % (n, e))
                continue
            asks = [parse_iso(c["createdAt"]) for c in cm if MARKER_ASK in (c.get("body") or "")]
            owner = [c for c in cm if (c.get("author") or {}).get("login") == self.owner and MARKER_ANY not in (c.get("body") or "")]
            if not asks or not owner:
                continue
            newest = max(owner, key=lambda c: parse_iso(c["createdAt"]))
            if parse_iso(newest["createdAt"]) > max(asks):
                self.log("#%d: owner replied to rt:ask, resuming" % n)
                self.write_supervisor(n, newest["body"])
                self.reset_counters(n)
                if self.rm_label(n, "rt:ask"):
                    i["names"].discard("rt:ask")
                self.set_status(n, "queued", 0, "resumed after owner reply")
                status[n] = {"state": "queued", "wake": "0", "ts": time.strftime("%F %T"), "detail": "ask-resume"}

        # 2c. terminal status + newer owner comment => re-open as resume
        for i in issues:
            n = i["number"]
            st = status.get(n)
            if not st or st["state"] not in TERMINAL:
                continue
            if i["names"] & {"rt:owner", "rt:running", "rt:ask", "rt:deferred"}:
                continue
            try:
                cm = self.comments(n)
            except Exception as e:
                self.log("WARN comments of #%d unreadable: %s" % (n, e))
                continue
            owner = [c for c in cm if (c.get("author") or {}).get("login") == self.owner and MARKER_ANY not in (c.get("body") or "")]
            if not owner:
                continue
            newest = max(owner, key=lambda c: parse_iso(c["createdAt"]))
            if parse_iso(newest["createdAt"]) > parse_status_ts(st["ts"]):
                self.log("#%d: owner comment newer than terminal status '%s', re-opening" % (n, st["state"]))
                self.write_supervisor(n, newest["body"])
                self.reset_counters(n)
                for l in ("rt:blocked", "rt:ready-to-merge", "rt:hold"):   # intake's EXCLUDE_LABELS would otherwise block the re-queue
                    if l in i["names"] and self.rm_label(n, l):
                        i["names"].discard(l)
                self.set_status(n, "queued", 0, "re-opened by owner comment")
                status[n] = {"state": "queued", "wake": "0", "ts": time.strftime("%F %T"), "detail": "reopen"}

        # 2e. open issues left terminal or failed with no marker label and no open PR: a ready-to-merge issue whose PR is gone is
        # closed (merged without Closes) or requeued (PR closed unmerged); an internal cause (killed by a signal) is requeued once, else parked
        for i in ([] if prs_raw is None else issues):   # the open-PR list was not read this cycle: skip, no PR can be told absent
            n, names = i["number"], i["names"]
            if prs_of(n):
                continue
            if "rt:ready-to-merge" in names:
                mine = [p for p in merged_prs if re.match(r"^rt/%d-" % n, p["headRefName"])]
                if mine:
                    p = max(mine, key=lambda x: x["number"])
                    if not re.search(r"Closes #%d\b" % n, p.get("body") or ""):
                        self.log("#%d: PR #%d merged without Closes, closing" % (n, p["number"]))
                        if self.gh_write(["issue", "close", str(n), "-R", self.repo], "close #%d" % n):
                            self.rm_label(n, "rt:ready-to-merge")
                            self.set_status(n, "done", 0, "merged without Closes; closed by sweep")
                    continue
                closed = [p for p in closed_prs if re.match(r"^rt/%d-" % n, p["headRefName"])]
                if closed and self.rm_label(n, "rt:ready-to-merge"):
                    self.log("#%d: PR #%d closed unmerged, requeueing" % (n, closed[0]["number"]))
                    self.set_status(n, "queued", 0, "PR closed unmerged; requeued by sweep")
                    status[n] = {"state": "queued", "wake": "0", "ts": time.strftime("%F %T"), "detail": "PR closed unmerged"}
                continue
            st = status.get(n) or {}
            if st.get("state") not in ("error", "stop", "done") or names & {"rt:blocked", "rt:ask", "rt:hold", "rt:deferred", "rt:running", "rt:merged"}:
                continue
            detail = "%s: %s" % (st["state"], st.get("detail", ""))
            if "rc=-" in detail and not self.issue_state(n).get("sweep_requeue_n"):
                self.log("#%d: last run ended with %s, requeueing once" % (n, detail))
                self.count_sweep_requeue(n)
                self.set_status(n, "queued", 0, "requeued by the sweep after %s" % detail)
                status[n] = {"state": "queued", "wake": "0", "ts": time.strftime("%F %T"), "detail": "requeued by the sweep"}
            else:
                self.log("#%d: parking with rt:blocked, last run ended with %s" % (n, detail))
                self.comment(n, "<!-- rt:blocked -->\nParked: the last run ended with `%s`. Reply in this issue to resume." % detail)
                self.add_label(n, "rt:blocked")

        # 3. intake
        self.resume_waits(status)
        cands, skips = [], []
        for i in issues:
            n, names, title = i["number"], i["names"], i["title"]
            why = []
            if n in act:
                why.append("active in worker slot %s" % act[n]["slot"])
            for l in EXCLUDE_LABELS:
                if l in names and not (l == "rt:running" and n in act):
                    why.append("labeled %s" % l)
            if title.startswith("[Owner]"):
                why.append("title starts with [Owner]")
            if is_epic(i):
                why.append("epic")
            if (is_followup(i) or "rt:self" in names) and "rt:go" not in names:   # owner 2026-11-12: loop-created issues need explicit rt:go
                why.append("rt:followup/rt:self without rt:go")
            if "rt:proposed" in names and "rt:approved" not in names:
                why.append("rt:proposed without rt:approved")
            st = status.get(n)
            queued = bool(st and st["state"] == "queued")
            if st and st["state"] == "waiting":
                why.append("waiting for its timer or awaited event")
            op = prs_of(n)
            if op and not queued:
                why.append("open PR %s (delivered, waiting for owner)" % ", ".join("#%d %s" % (p["number"], p["headRefName"]) for p in op))
            if st and st["state"] in TERMINAL:
                why.append("status %s (terminal; owner comment re-opens)" % st["state"])
            # dependencies / stacking
            deps = parse_deps(i["body"])
            deps = [d for d in deps if d != n]
            i["deps"] = deps
            unmet, ready = [], []
            deferred = {x["number"] for x in issues if "rt:deferred" in x["names"]}
            for d in deps:
                s = allst.get(d)
                vc = status.get(d) or {}
                if s == "CLOSED" or d in merged or d in deferred or (vc.get("state") == "done" and "verified complete" in vc.get("detail", "")):   # merged PR = met (#540); deferred deps (owner-trimmed scope) do not block; verified complete = met (#646)
                    continue
                dp = prs_of(d)
                rd = [p for p in dp if any(l["name"] == "rt:ready-to-merge" for l in p["labels"])]
                held_owner = str(self.issue_state(d).get("merge_hold", "")).startswith("owner")
                if s is not None and len(dp) == 1 and len(rd) == 1 and not held_owner:
                    ready.append((d, rd[0]))   # fallback: dep PR is ready-to-merge and only waiting for CI / merge
                elif s is None and any(p["number"] == d for p in prs):
                    unmet.append("#%d (open PR)" % d)
                elif s is None:
                    unmet.append("#%d (unknown)" % d)
                    if time.time() - self._unresolved_logged.get((n, d), 0) >= 3600:   # #540: live log, once per issue/dep per hour
                        self.log("#%d: dependency #%d is neither a known issue nor a merged PR; not claimed" % (n, d))
                        self._unresolved_logged[(n, d)] = time.time()
                else:
                    unmet.append("#%d (open%s)" % (d, ", PR not ready-to-merge" if dp else ", no PR"))
            base = "main"
            if unmet:
                why.append("dependency not satisfied: %s" % ", ".join(unmet))
            elif len(ready) > 1:
                why.append("several dependencies are only ready-to-merge (%s); waiting" % ", ".join("#%d" % d for d, _ in ready))
            elif ready:
                base = ready[0][1]["headRefName"]
            i["base"], i["resume"] = base, queued
            (skips if why else cands).append((i, why))
        cands = [i for i, _ in cands]
        cands.sort(key=sort_key)
        if any(not is_followup(i) for i in cands):   # owner 2026-11-12: follow-ups only when nothing else is claimable
            cands = [i for i in cands if not is_followup(i)]
        if self.dry:
            for i, why in sorted(skips, key=lambda x: x[0]["number"]):
                self.log("DRY skip #%d: %s" % (i["number"], "; ".join(why)))
            self.log("DRY candidates in priority order: %s" % (" ".join("#%d" % i["number"] for i in cands) or "(none)"))

        # active set (series / dependency exclusion)
        def info_of(n):
            it = byn.get(n)
            return {"series": series_key(it["title"]) if it else (self.procs.get(n) or {}).get("series"),
                    "deps": set(parse_deps(it["body"])) if it else set()}
        active = {n: info_of(n) for n in act}
        slots_used = {a["slot"] for a in act.values()}

        def free_slot():
            for k in range(1, self.workers_max + 1):
                if k not in slots_used:
                    return k
            return None

        # 2d. main CI health, then the PR sweep (before intake)
        self.check_main()
        self.sweep(prs, byn, act, status, slots_used, active, info_of, free_slot)

        # 5. orphans first: rt:running label but no live worker (e.g. after a restart)
        for i in sorted(issues, key=lambda x: x["number"]):
            n = i["number"]
            if "rt:running" not in i["names"] or n in act:
                continue
            if self.fail_count.get(n, 0) >= 3:
                self.log("#%d: worker crashed %d times in a row, giving up: rt:blocked" % (n, self.fail_count[n]))
                self.comment(n, "<!-- rt:blocked -->\nBlocked: the worker for this issue crashed repeatedly. See the worker logs on the host. "
                                "Reply in this issue to resume.")
                self.add_label(n, "rt:blocked")
                self.rm_label(n, "rt:running")
                self.set_status(n, "stop", 0, "worker crashed repeatedly")
                self.fail_count[n] = 0
                continue
            k = free_slot()
            if k is None:
                self.log("%s#%d: orphan (rt:running, no worker) waits for a free slot" % ("DRY " if self.dry else "", n))
                continue
            base = ""
            try:
                base = open(os.path.join(self.state, "base", str(n))).read().strip()
            except OSError:
                pass
            if self.dry:
                self.log("DRY would resume orphan #%d slot=%d base=%s" % (n, k, base or "main"))
            else:
                self.spawn(n, k, base, i["title"])
            slots_used.add(k)
            active[n] = info_of(n)

        # 4. claim (resource-aware admission: never kill running workers)
        hold = self.claim_hold_reason() if cands else None
        if hold:
            cands = []
        if not claims_ok and cands:
            self.log("GitHub read failed: no new claims this cycle (%d candidate(s) wait)" % len(cands))
            cands = []
        if self.main_red and cands:
            self.log("%smain CI is red: no new claims (%d candidate(s) wait)" % ("DRY " if self.dry else "", len(cands)))
            cands = []
        self.claimable = len(cands)
        for i in cands:
            n = i["number"]
            k = free_slot()
            if k is None:
                if self.dry:
                    self.log("DRY skip #%d: no free worker slot (%d/%d busy)" % (n, len(slots_used), self.workers_max))
                continue
            me = info_of(n)
            clash = None
            for a, ai in active.items():
                if me["series"] and ai["series"] and me["series"].lower() == ai["series"].lower():
                    clash = "series '%s' already running (#%d)" % (me["series"], a)
                elif a in me["deps"] or n in ai["deps"]:
                    clash = "dependency relation with running #%d" % a
                if clash:
                    break
            if clash:
                if self.dry:
                    self.log("DRY skip #%d: %s" % (n, clash))
                continue
            base = i["base"]
            if self.dry:
                self.log("DRY would claim #%d base=%s prio=%s slot=%d%s" % (n, base, prio_str(i["names"]), k, " (resume)" if i["resume"] else ""))
            else:
                if not self.add_label(n, "rt:running"):
                    continue
                if i["resume"]:
                    body = ("<!-- rt:claim -->\nResumed by the roundtable loop (worker slot %d). Branch: rt/%d-pi. "
                            "I will continue from the existing work and report back here." % (k, n))
                else:
                    body = ("<!-- rt:claim -->\nClaimed by the roundtable loop (worker slot %d). Branch: rt/%d-pi. "
                            "I will triage it, then implement or decompose it, and report back here." % (k, n))
                self.comment(n, body)
                self.spawn(n, k, base, i["title"])
            slots_used.add(k)
            active[n] = me

        hb = act if self.dry else self.active_workers()
        self.idle_cycles = self.idle_cycles + 1 if not hb and not self.claimable else 0
        self.heartbeat(hb)
        if not self.dry:   # #668: claimable = candidates that passed the claim gates; awake = claims were not held or unreadable
            self.stall_cycle(issues, allst, prs_of, status, len(cands), claims_ok and not hold)

    # ---- self-judgment (#668): loop-stall.observeCycle through host/outbox-bridge.mjs, from data this cycle already read
    def stall_cycle(self, issues, allst, prs_of, status, claimable, awake):
        """`since` is the issue's status.tsv timestamp: a proxy for when its current label was set (createdAt when it has no status row)."""
        byn = {n: {"number": n, "state": s, "labels": [], "deps": [], "hasOpenPr": False, "since": 0} for n, s in allst.items()}
        for i in issues:
            n, st = i["number"], status.get(i["number"]) or {}
            since = parse_status_ts(st["ts"]) if st.get("ts") else parse_iso(i["createdAt"])
            byn[n] = {"number": n, "state": "OPEN", "labels": sorted(i["names"]), "deps": i["deps"], "hasOpenPr": bool(prs_of(n)), "since": since * 1000}
        freezes = []
        ledger = os.path.join(RT_HOME, ".roundtable", "state", "freeze-ledger.jsonl")
        if os.path.exists(ledger):
            freezes = [{"start": e["start"], "end": e["end"]} for e in map(json.loads, open(ledger))]
        snapshot = {"at": int(time.time() * 1000), "awake": awake, "claimable": claimable, "activeWorkers": len(self.active_workers()),
                    "issues": list(byn.values()), "mainRed": self.main_red, "freezes": freezes,
                    "verifiedComplete": [n for n, st in status.items() if "verified complete" in st.get("detail", "")]}
        r = subprocess.run(["node", BRIDGE, RT_HOME, self.repo, "stall-cycle"], input=json.dumps(snapshot), capture_output=True, text=True,
                           timeout=120, env=dict(os.environ, RT_GH_REAL=GH))
        if r.returncode != 0:
            self.log("WARN stall cycle failed: %s" % r.stderr.strip()[:200])

    # ---- main CI health / auto-revert
    def merged_row(self, sha):
        try:
            for line in open(os.path.join(self.state, "merges.log"), encoding="utf-8", errors="replace"):
                f = line.rstrip("\n").split("\t")
                if len(f) >= 4 and len(f[3]) >= 7 and (f[3].startswith(sha) or sha.startswith(f[3])):
                    return f
        except OSError:
            pass
        return None

    def check_main(self):
        """Latest completed CI run on main. Red => pause new claims/merges (state/main_red); red right after one of
        our auto-merges => spawn bin/rt-revert."""
        for sha7, pr in list(self.aux.items()):
            if pr.poll() is not None:
                self.log("revert helper %s exited rc=%s" % (sha7, pr.returncode))
                del self.aux[sha7]
        try:
            runs = self.gh_read(["run", "list", "-R", self.repo, "--branch", "main", "-L", "5", "--json", "conclusion,headSha,status,databaseId"])
        except Exception as e:
            self.log("WARN main CI status unreadable: %s" % e)
            self.main_red = os.path.exists(os.path.join(self.state, "main_red"))
            return
        done = [r for r in (runs or []) if r.get("status") == "completed"]
        flag = os.path.join(self.state, "main_red")
        if not done:
            self.main_red = os.path.exists(flag)
            return
        latest = done[0]
        if os.path.exists(flag):
            try:
                fsha = open(flag).read().split()[0]
            except Exception:
                fsha = ""
            if fsha and any(r.get("headSha") == fsha and r.get("status") != "completed" for r in (runs or [])):
                self.main_red = True   # flagged sha is being re-run: stay paused until it completes
                return
        self.main_red = latest.get("conclusion") == "failure"
        if self.main_red and not self.dry:
            # one automatic re-run of failed jobs per sha (flaky tests) before treating red as real
            rr = os.path.join(self.state, "ci_rerun")
            os.makedirs(rr, exist_ok=True)
            mark = os.path.join(rr, latest.get("headSha", "")[:7] or "none")
            if not os.path.exists(mark) and latest.get("databaseId"):
                open(mark, "w").write(time.strftime("%F %T %Z") + "\n")
                rid = str(latest["databaseId"])
                try:
                    r = subprocess.run([GH, "run", "rerun", rid, "--failed", "-R", self.repo],
                                       stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=60)
                    if r.returncode == 0:
                        self.log("main CI red at %s: re-ran failed jobs once (run %s) to rule out a flake" % (latest.get("headSha", "")[:7], rid))
                    else:
                        self.log("WARN main CI rerun of run %s failed (rc=%s): %s" % (rid, r.returncode, r.stderr.strip()[:200]))
                except Exception as e:
                    self.log("WARN main CI rerun of run %s failed: %s" % (rid, e))
        if not self.main_red:
            if os.path.exists(flag):
                self.log("main CI is green again (%s); merges and claims resume" % latest.get("headSha", "")[:7])
                if not self.dry:
                    os.remove(flag)
            return
        sha = latest.get("headSha", "")
        if not os.path.exists(flag):
            self.log("main CI is RED at %s: pausing new claims and merges" % sha[:7])
            if not self.dry:
                with open(flag, "w") as f:
                    f.write("%s %s\n" % (sha, time.strftime("%F %T %Z")))
        row = self.merged_row(sha)
        if row and not os.path.exists(os.path.join(self.state, "reverted", sha[:7])) and sha[:7] not in self.aux:
            if self.dry:
                self.log("DRY would revert auto-merge %s (PR #%s, issue #%s): bin/rt-revert" % (sha[:7], row[1], row[2]))
                return
            os.makedirs(os.path.join(self.logs, "work"), exist_ok=True)
            out = open(os.path.join(self.logs, "work", "revert-%s-%s.log" % (sha[:7], time.strftime("%Y%m%d-%H%M%S"))), "ab")
            env = dict(os.environ)
            env.update(self.cfg)
            env["RT_HOME"] = RT_HOME
            self.aux[sha[:7]] = subprocess.Popen([os.path.join(RT_HOME, "bin", "rt-revert"), sha], stdin=subprocess.DEVNULL, stdout=out,
                                                  stderr=subprocess.STDOUT, start_new_session=True, close_fds=True, env=env, cwd=RT_HOME)
            out.close()
            self.log("spawned bin/rt-revert for %s (PR #%s)" % (sha[:7], row[1]))

    # ---- PR sweep (before intake)
    def sweep(self, prs, byn, act, status, slots_used, active, info_of, free_slot):
        for p in sorted(prs, key=lambda x: x["number"]):
            m = re.match(r"^rt/(\d+)-", p["headRefName"])
            if not m:
                continue   # never touch PRs that are not rt/<n>-*
            n = int(m.group(1))
            tag = "DRY skip PR #%d (#%d)" % (p["number"], n)
            why = None
            plabels = {l["name"] for l in p["labels"]}
            issue = byn.get(n)
            if p["number"] in self.handsoff:
                why = "hands-off (RT_HANDS_OFF_PRS)"
            elif p["headRefName"].startswith("rt/revert-"):
                why = "revert PR handled by rt-revert"
            elif plabels & {"rt:merged", "rt:blocked"}:
                why = "PR labeled %s" % ", ".join(sorted(plabels & {"rt:merged", "rt:blocked"}))
            elif issue is None:
                why = "issue not open / not by the owner"
            elif issue["names"] & {"rt:owner", "rt:blocked", "rt:merged", "rt:ask", "rt:hold"}:
                why = "issue labeled %s" % ", ".join(sorted(issue["names"] & {"rt:owner", "rt:blocked", "rt:merged", "rt:ask", "rt:hold"}))
            elif n in act or n in self.procs:
                why = "worker already active"
            elif "rt:running" in issue["names"]:
                why = "issue is rt:running without a worker (orphan path resumes it)"
            if why is None:
                head = p.get("headRefOid", "")
                comment_ok = any("<!-- rt:gates -->" in (c.get("body") or "") and "Result: pass" in (c.get("body") or "")
                                 and ("Head: %s" % head[:7]) in (c.get("body") or "") for c in p.get("comments", []))
                g_ok = self.gates_ok(n, head)
                hold = str(self.issue_state(n).get("merge_hold", ""))
                if not (g_ok and comment_ok):
                    reason = "no gates pass for head %s (%s)" % (head[:7], "gates.json missing/stale" if not g_ok else "no rt:gates pass comment")
                elif hold.startswith("owner"):
                    why = "gates passed, merge left to the owner (%s)" % hold
                elif hold == "transient:main-red" and self.main_red:
                    why = "merge waits for main CI to be green"
                elif "rt:ready-to-merge" in plabels or "rt:ready-to-merge" in issue["names"]:
                    reason = "gates passed but not merged yet (%s)" % (hold or "no hold recorded")
                else:
                    why = "gates passed, nothing to do"
                if why is None:
                    last = self.last_sweep.get(n)
                    if last and last[0] == head and time.time() - last[1] < self.sweep_retry:
                        why = "swept %ds ago for the same head; backing off" % (time.time() - last[1])
            if why is not None:
                if self.dry:
                    self.log("%s: %s" % (tag, why))
                continue
            k = free_slot()
            if k is None:
                if self.dry:
                    self.log("%s: wants a gate-only run (%s) but no free worker slot" % (tag, reason))
                continue
            base = ""
            try:
                base = open(os.path.join(self.state, "base", str(n))).read().strip()
            except OSError:
                pass
            if self.dry:
                self.log("DRY would sweep PR #%d (#%d) --gate-only slot=%d: %s" % (p["number"], n, k, reason))
            else:
                self.log("PR sweep: PR #%d (#%d): %s" % (p["number"], n, reason))
                self.spawn(n, k, base, issue["title"], extra=["--gate-only"])
            self.last_sweep[n] = (p.get("headRefOid", ""), time.time())
            slots_used.add(k)
            active[n] = info_of(n)

    # ---- heartbeat
    def heartbeat(self, act):
        if self.dry:   # dry-run writes no state (status.sh shows no DRY heartbeat)
            return
        ws = ",".join("%d:%d:%d" % (n, a["slot"], a["pid"]) for n, a in sorted(act.items()))
        now = time.time()
        txt = "ts=%s\nepoch=%d\npid=%d\ndry=0\nslots=%d\nrunning=%d\nmain_red=%d\nworkers=%s\n" % (
            time.strftime("%F %T %Z"), now, os.getpid(), self.workers_max, len(act), 1 if self.main_red else 0, ws)
        txt += "backlog=%d\nclaimable=%d\nidle_cycles=%d\n" % (self.backlog, self.claimable, self.idle_cycles)
        path = os.path.join(self.state, "heartbeat")
        tmp = path + ".tmp"
        with open(tmp, "w") as f:
            f.write(txt)
        os.replace(tmp, path)

    # ---- main loop
    def run(self):
        lockf = None
        if not self.dry:
            lockf = open(os.path.join(self.state, "sched.lock"), "w")
            try:
                fcntl.flock(lockf, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError:
                print("rt-sched already running", file=sys.stderr)
                return 1
            lockf.write(str(os.getpid()))
            lockf.flush()
        signal.signal(signal.SIGTERM, lambda *a: setattr(self, "stop_flag", True))
        signal.signal(signal.SIGINT, lambda *a: setattr(self, "stop_flag", True))
        self.log("rt-sched start pid=%d dry=%s once=%s workers=%d poll=%ds repo=%s owner=%s" % (
            os.getpid(), self.dry, self.once, self.workers_max, self.poll, self.repo, self.owner))
        stop_file = os.path.join(RT_HOME, "STOP")
        while True:
            if os.path.exists(stop_file) or self.stop_flag:
                break
            try:
                self.cycle()
            except Exception as e:   # never die on a bad cycle
                self.log("ERROR cycle failed: %r" % e)
            if self.once:
                return 0
            self.note_cycle_gap()  # backup if cycle() returned before the pre-claim check
            self._last_cycle_wall = time.time()
            waited = 0
            w0, m0 = time.time(), time.monotonic()
            while waited < self.poll and not (os.path.exists(stop_file) or self.stop_flag):
                # 2026-11-14 supervisor: the loop sat ~2h without a cycle after a box freeze; also bound the wait by wall
                # and monotonic time, and log overruns so the next stall leaves evidence
                if time.time() - w0 >= self.poll or time.monotonic() - m0 >= self.poll:
                    break
                time.sleep(5)
                waited += 5
                before = len(self.procs)
                self.reap()
                if len(self.procs) < before and len(self.active_workers()) < self.workers_max:
                    break   # a slot freed up: start the next issue right away
        if self.stop_flag:
            self.log("signal received; exiting (workers keep running)")
            return 0
        # STOP file: never kill workers, wait for them to finish
        self.log("STOP file present: no new claims; waiting for %d worker(s) to finish" % len(self.active_workers()))
        while self.active_workers() and not self.stop_flag:
            time.sleep(5)
            self.reap()
            self.heartbeat(self.active_workers())
        self.reap()
        self.log("rt-sched exit")
        return 0


def main():
    ap = argparse.ArgumentParser(description="rt-loop v2 scheduler")
    ap.add_argument("--dry-run", action="store_true", help="read-only: log decisions, change nothing")
    ap.add_argument("--once", action="store_true", help="run one cycle and exit")
    a = ap.parse_args()
    return Sched(a.dry_run, a.once).run()


if __name__ == "__main__":
    sys.exit(main())
