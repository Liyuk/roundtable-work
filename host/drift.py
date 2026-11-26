"""Host script drift (#653): deployed rt-sched.py, rt-work.sh and bin/* vs host/ at origin/main. Nothing is redeployed.

check() returns the drifted files. Drift that stays continuous for ALERT_AFTER seconds (a clean check resets it) appends
one line to logs/drift-ledger.jsonl and runs the optional $RT_DRIFT_ALERT_CMD once (RT_DRIFT_FILES is set for it).
"""
import glob
import json
import os
import subprocess

ALERT_AFTER = 24 * 3600   # s of continuous drift before the ledger line


def _ref_bytes(repo, ref, rel):
    r = subprocess.run(["git", "-C", repo, "show", "%s:host/%s" % (ref, rel)], capture_output=True)
    return r.stdout if r.returncode == 0 else None


def _deployed_bytes(home, rel):
    p = os.path.join(home, rel)
    return open(p, "rb").read() if os.path.exists(p) else None


def drifted(home, repo, ref="origin/main"):
    out = subprocess.run(["git", "-C", repo, "ls-tree", "-r", "--name-only", ref, "--", "host/rt-sched.py", "host/rt-work.sh",
                          "host/bin"], capture_output=True, text=True).stdout.split()
    names = {p[len("host/"):] for p in out} | {"rt-sched.py", "rt-work.sh"}
    names |= {"bin/" + os.path.basename(p) for p in glob.glob(os.path.join(home, "bin", "*"))}
    return sorted(n for n in names if _deployed_bytes(home, n) != _ref_bytes(repo, ref, n))


def check(home, repo, state, logs, now, alert_cmd=None):
    files = drifted(home, repo)
    path = os.path.join(state, "drift.json")
    if not files:
        if os.path.exists(path):
            os.remove(path)
        return files
    st = json.load(open(path)) if os.path.exists(path) else {"since": now, "ledgered": False}
    if not st["ledgered"] and now - st["since"] >= ALERT_AFTER:
        with open(os.path.join(logs, "drift-ledger.jsonl"), "a") as f:
            f.write(json.dumps({"epoch": now, "since": st["since"], "files": files}) + "\n")
        st["ledgered"] = True
        if alert_cmd:
            subprocess.run(alert_cmd, shell=True, env=dict(os.environ, RT_DRIFT_FILES=",".join(files)))
    json.dump(st, open(path, "w"))
    return files
