#!/usr/bin/env python3
"""Scheduler retry budget (#647): worker crashes back off 15/60/240 min across a restart; the 4th crash alerts and blocks.
Run by host/test/sched-retry.test.mjs (exit 0 = pass). Fake Popen; no GitHub, no real worker."""
import atexit
import importlib.util
import json
import os
import shutil
import sys
import tempfile
import time
import unittest
from unittest import mock

ROOT = tempfile.mkdtemp(prefix="rt-sched-retry-")
atexit.register(shutil.rmtree, ROOT, True)
os.environ["RT_HOME"] = ROOT
os.environ["RT_GH_REAL"] = "/bin/false"
HOST = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
spec = importlib.util.spec_from_file_location("rt_sched", os.path.join(HOST, "rt-sched.py"))
rs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rs)


class Popen:  # a worker that was killed: poll() reports rc=1
    def poll(self):
        return 1


def sched():
    s = rs.Sched(False, True)
    s.gh_outbox = lambda args, what, stdin=None: calls.append((args, stdin)) or True
    return s


def state(n=7):
    with open(os.path.join(ROOT, "state", "issues", "%d.json" % n)) as f:
        return json.load(f)


calls = []


class CrashBackoff(unittest.TestCase):
    def setUp(self):
        calls.clear()

    def crash(self, at):
        """A fresh scheduler process (restart) sees one worker exit rc=1 at wall time `at`."""
        s = sched()
        s.procs[7] = {"proc": Popen(), "slot": 1, "started": 0, "series": ""}
        with mock.patch.object(rs.time, "time", return_value=at):
            s.reap()
        return s

    def test_crashes_back_off_15_60_240_min_across_restarts_then_block(self):
        t = 1_000_000.0
        self.crash(t)
        self.assertEqual(state()["fail_count"], 1)
        self.assertEqual(state()["next_retry"], t + 15 * 60)
        s = sched()  # restart: only state/issues/7.json survives
        with mock.patch.object(rs.time, "time", return_value=t + 15 * 60 - 1):
            self.assertEqual(s.crash_gate(7), "wait")
        with mock.patch.object(rs.time, "time", return_value=t + 15 * 60):
            self.assertEqual(s.crash_gate(7), "resume")

        self.crash(t + 15 * 60)
        self.assertEqual(state()["fail_count"], 2)
        self.assertEqual(state()["next_retry"], t + 15 * 60 + 60 * 60)

        self.crash(t + 75 * 60)
        self.assertEqual(state()["fail_count"], 3)
        self.assertEqual(state()["next_retry"], t + 75 * 60 + 240 * 60)

        self.crash(t + 315 * 60)  # 4th failure: no further backoff, the orphan path must give up
        self.assertEqual(state()["fail_count"], 4)
        s = sched()
        with mock.patch.object(rs.time, "time", return_value=t + 999 * 60):
            self.assertEqual(s.crash_gate(7), "block")
        s.give_up(7)
        bodies = [b for a, b in calls if a[:2] == ["comment", "7"] and b]
        self.assertTrue(any("<!-- rt:blocked -->" in b and "internal:crash" in b for b in bodies), calls)
        self.assertIn(["label", "7", "add", "rt:blocked"], [a for a, _ in calls])

    def test_success_clears_the_crash_count(self):
        self.crash(1_000_000.0)
        s = sched()
        s.procs[7] = {"proc": type("P", (), {"poll": lambda self: 0})(), "slot": 1, "started": 0, "series": ""}
        s.reap()
        self.assertEqual(state()["fail_count"], 0)


class RetriedHold(unittest.TestCase):
    def setUp(self):
        calls.clear()

    def test_transient_merge_hold_is_retried_by_the_sweep_not_blocked(self):
        head = "a" * 40
        s = sched()
        s.issue_set(7, merge_hold="transient:rt-merge-9")
        gd = os.path.join(ROOT, "wt", "7", ".roundtable", "state")
        os.makedirs(gd, exist_ok=True)
        with open(os.path.join(gd, "gates.json"), "w") as f:
            json.dump({"head": head, "gate0": "pass", "gate1": "pass", "gate2": "skipped"}, f)
        prs = [{"number": 5, "headRefName": "rt/7-pi", "headRefOid": head, "labels": [{"name": "rt:ready-to-merge"}],
                "comments": [{"body": "<!-- rt:gates -->\nResult: pass\nHead: %s" % head[:7]}]}]
        byn = {7: {"number": 7, "title": "t", "body": "", "names": {"rt:ready-to-merge"}}}
        spawned = []
        s.spawn = lambda n, slot, base, title, extra=(): spawned.append((n, list(extra)))
        s.sweep(prs, byn, {}, {}, set(), {}, lambda n: {"series": None, "deps": set()}, lambda: 1)
        self.assertEqual(spawned, [(7, ["--gate-only"])])
        self.assertFalse(any("rt:blocked" in a for a, _ in calls), calls)


if __name__ == "__main__":
    sys.exit(0 if unittest.main(exit=False).result.wasSuccessful() else 1)
