#!/usr/bin/env python3
"""Fake `gh` for the sandbox benchmark. State lives in $BENCH_GH_STATE (JSON); the git remote is the local bare
repository $BENCH_REMOTE. Implements only the subset the loop uses. CI is simulated by running `npm test` on the
commit, with optional fault injection from $BENCH_FAULTS (JSON). Every call is appended to $BENCH_GH_LOG."""
import fcntl, json, os, re, shutil, subprocess, sys, tempfile, time
from datetime import datetime, timezone

STATE = os.environ["BENCH_GH_STATE"]
REMOTE = os.environ["BENCH_REMOTE"]
FAULTS = os.environ.get("BENCH_FAULTS", "")
LOG = os.environ.get("BENCH_GH_LOG", "")
SLUG = os.environ.get("BENCH_SLUG", "bench/sandbox")
OWNER = os.environ.get("BENCH_OWNER", "bench-owner")
ACTOR = os.environ.get("BENCH_ACTOR", OWNER)

def now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

def die(msg, rc=1):
    sys.stderr.write(msg.rstrip() + "\n"); sys.exit(rc)

def git(*a, cwd=None, check=True):
    r = subprocess.run(["git"] + list(a), cwd=cwd, capture_output=True, text=True)
    if check and r.returncode:
        raise RuntimeError("git %s: %s" % (" ".join(a), r.stderr.strip()))
    return r.stdout.strip()

def rev(ref):
    r = subprocess.run(["git", "--git-dir", REMOTE, "rev-parse", "-q", "--verify", ref + "^{commit}"], capture_output=True, text=True)
    return r.stdout.strip() if r.returncode == 0 else ""

class Store:
    def __enter__(self):
        self.lf = open(STATE + ".lock", "a+"); fcntl.flock(self.lf, fcntl.LOCK_EX)
        self.d = json.load(open(STATE))
        return self.d
    def __exit__(self, et, ev, tb):
        if et is None:
            tmp = STATE + ".tmp"; json.dump(self.d, open(tmp, "w"), indent=1); os.replace(tmp, STATE)
        fcntl.flock(self.lf, fcntl.LOCK_UN); self.lf.close()

def faults():
    try:
        return json.load(open(FAULTS)) if FAULTS else {}
    except OSError:
        return {}

def parse(argv, flags_with_value):
    pos, opt = [], {}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a.startswith("--") and "=" in a:
            k, v = a.split("=", 1); opt.setdefault(k, []).append(v)
        elif a in flags_with_value:
            v = argv[i + 1] if i + 1 < len(argv) else ""
            opt.setdefault(a, []).append(v); i += 1
        elif a.startswith("-"):
            opt.setdefault(a, []).append(True)
        else:
            pos.append(a)
        i += 1
    return pos, opt

VAL = {"-R", "--repo", "--json", "--jq", "-q", "--state", "--author", "-L", "--limit", "--search", "--label", "-l",
       "--add-label", "--remove-label", "--title", "-t", "--body", "-b", "--body-file", "-F", "--base", "-B", "--head", "-H",
       "--branch", "-b", "--workflow", "-w", "--commit", "-c", "--interval", "--match-head-commit", "--color",
       "--description", "-f", "--method", "-X", "--reason", "-r", "--comment", "-c"}

def one(opt, *keys, default=None):
    for k in keys:
        if k in opt: return opt[k][-1]
    return default

def body_of(opt):
    b = one(opt, "--body", "-b")
    f = one(opt, "--body-file", "-F")
    if f is not None:
        b = sys.stdin.read() if f == "-" else open(f).read()
    return b

def emit(obj, opt):
    jq = one(opt, "--jq", "-q")
    s = json.dumps(obj)
    if jq:
        r = subprocess.run(["jq", "-r", jq], input=s, capture_output=True, text=True)
        sys.stdout.write(r.stdout); sys.stderr.write(r.stderr); sys.exit(r.returncode)
    print(s)

def pick(o, fields):
    return {f: o.get(f) for f in fields.split(",") if f}

def url(kind, n):
    return "https://github.com/%s/%s/%d" % (SLUG, kind, n)

def labels_obj(names):
    return [{"name": x} for x in names]

def issue_view_obj(d, it):
    o = dict(it); o["labels"] = labels_obj(it["labels"]); o["author"] = {"login": it["author"]}
    o["url"] = url("issues", it["number"]); o["comments"] = [dict(c, author={"login": c["author"]}) for c in it["comments"]]
    o["closedByPullRequestsReferences"] = []
    return o

def pr_obj(d, p):
    o = dict(p); o["labels"] = labels_obj(p["labels"]); o["author"] = {"login": p["author"]}
    o["url"] = url("pull", p["number"]); o["comments"] = [dict(c, author={"login": c["author"]}) for c in p["comments"]]
    o["headRefOid"] = rev("refs/heads/" + p["headRefName"]) if p["state"] == "OPEN" else p.get("headRefOid", "")
    o["mergeable"] = "MERGEABLE"; o["mergeStateStatus"] = "CLEAN"
    base = rev("refs/heads/" + p["baseRefName"])
    files = []
    if o["headRefOid"] and base:
        mb = subprocess.run(["git", "--git-dir", REMOTE, "merge-base", base, o["headRefOid"]], capture_output=True, text=True).stdout.strip()
        if mb:
            files = [{"path": x} for x in subprocess.run(["git", "--git-dir", REMOTE, "diff", "--name-only", mb, o["headRefOid"]],
                                                          capture_output=True, text=True).stdout.split()]
            mt = subprocess.run(["git", "--git-dir", REMOTE, "merge-tree", "--write-tree", base, o["headRefOid"]], capture_output=True, text=True)
            if mt.returncode == 1: o["mergeable"] = "CONFLICTING"; o["mergeStateStatus"] = "DIRTY"
    o["files"] = files
    o["mergeCommit"] = {"oid": p.get("mergeSha")} if p.get("mergeSha") else None
    return o

def find_pr(d, ref):
    if ref and ref.isdigit():
        return d["prs"].get(ref)
    if ref and "/pull/" in ref:
        return d["prs"].get(ref.rsplit("/", 1)[1])
    br = ref or subprocess.run(["git", "rev-parse", "--abbrev-ref", "HEAD"], capture_output=True, text=True).stdout.strip()
    for p in sorted(d["prs"].values(), key=lambda p: -p["number"]):
        if p["headRefName"] == br:
            return p
    return None

# ------------------------------------------------------------------ CI ----
def run_ci(d, sha, branch, event):
    """Create (or return) the Check run for sha. Conclusion = npm test result, unless a fault says otherwise."""
    for r in d["runs"]:
        if r["headSha"] == sha and r["workflowName"] == "Check" and r.get("attempt_of") is None and r["headBranch"] == branch:
            return r
    concl = ci_conclusion(sha, d, branch)
    d["seq"] += 1
    r = {"databaseId": d["seq"] + 100000, "headSha": sha, "headBranch": branch, "workflowName": "Check", "name": "Check",
         "status": "completed", "conclusion": concl, "event": event, "createdAt": now(), "attempts": 1,
         "jobs": [{"name": "test", "conclusion": concl, "status": "completed"}]}
    d["runs"].append(r)
    d.setdefault("events", []).append({"at": now(), "kind": "ci", "branch": branch, "sha": sha, "conclusion": concl})
    return r

def ci_conclusion(sha, d, branch):
    f = faults()
    for fl in f.get("ci_flake", []):   # first run on a matching branch fails, rerun passes
        if re.search(fl["branch"], branch):
            key = "flake:" + branch
            if key not in d.setdefault("fired", []):
                d["fired"].append(key); return "failure"
    for mr in f.get("main_red_after_merge", []):   # first main run after the matching PR merge fails
        if branch == "main":
            last = d.get("last_merge") or {}
            key = "mainred:" + str(last.get("pr"))
            if last.get("sha") == sha and re.search(mr["head"], last.get("head", "")) and key not in d.setdefault("fired", []):
                d["fired"].append(key); return "failure"
    tmp = tempfile.mkdtemp(prefix="bench-ci-")
    try:
        subprocess.run("git --git-dir '%s' archive %s | tar -x -C '%s'" % (REMOTE, sha, tmp), shell=True, check=True)
        r = subprocess.run(["npm", "test", "--silent"], cwd=tmp, capture_output=True, text=True, timeout=300)
        return "success" if r.returncode == 0 else "failure"
    except Exception:
        return "failure"
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

# ------------------------------------------------------------- commands ----
def cmd_issue(sub, argv):
    pos, opt = parse(argv, VAL)
    with Store() as d:
        if sub == "list":
            st = (one(opt, "--state", default="open")).upper()
            out = []
            for it in sorted(d["issues"].values(), key=lambda i: -i["number"]):
                if st != "ALL" and it["state"] != st: continue
                if one(opt, "--author") and it["author"] != one(opt, "--author"): continue
                labs = opt.get("--label", []) + opt.get("-l", [])
                if any(l not in it["labels"] for l in labs): continue
                s = one(opt, "--search")
                if s:
                    t = re.sub(r"\bin:title\b", "", s).strip().strip('"')
                    if t.lower() not in it["title"].lower(): continue
                out.append(issue_view_obj(d, it))
            out = out[: int(one(opt, "-L", "--limit", default="30"))]
            fields = one(opt, "--json")
            if fields: emit([pick(o, fields) for o in out], opt)
            else:
                for o in out: print("%d\t%s\t%s\t%s" % (o["number"], o["state"], o["title"], ",".join(l["name"] for l in o["labels"])))
            return
        if sub == "create":
            d["seq"] += 1; n = d["seq"]
            labs = opt.get("--label", []) + opt.get("-l", [])
            labs = [x for l in labs for x in l.split(",")]
            d["issues"][str(n)] = {"number": n, "title": one(opt, "--title", "-t", default=""), "body": body_of(opt) or "",
                                   "labels": labs, "state": "OPEN", "author": ACTOR, "createdAt": now(), "updatedAt": now(),
                                   "closedAt": None, "comments": [], "stateReason": None}
            d.setdefault("events", []).append({"at": now(), "kind": "issue-create", "n": n, "labels": labs, "title": d["issues"][str(n)]["title"]})
            print(url("issues", n)); return
        n = pos[0].rsplit("/", 1)[-1] if pos else die("issue number required")
        it = d["issues"].get(n) or die("GraphQL: Could not resolve to an issue with the number of %s." % n)
        if sub == "view":
            fields = one(opt, "--json")
            o = issue_view_obj(d, it)
            if fields: emit(pick(o, fields), opt)
            else: print("title:\t%s\nstate:\t%s\nlabels:\t%s\nnumber:\t%s\n--\n%s" % (it["title"], it["state"], ", ".join(it["labels"]), n, it["body"]))
            return
        if sub == "edit":
            for l in opt.get("--add-label", []):
                for x in l.split(","):
                    if x not in it["labels"]: it["labels"].append(x); d["events"].append({"at": now(), "kind": "label-add", "n": int(n), "label": x})
            for l in opt.get("--remove-label", []):
                for x in l.split(","):
                    if x in it["labels"]: it["labels"].remove(x); d["events"].append({"at": now(), "kind": "label-remove", "n": int(n), "label": x})
            if one(opt, "--title", "-t"): it["title"] = one(opt, "--title", "-t")
            b = body_of(opt)
            if b is not None: it["body"] = b
            it["updatedAt"] = now(); print(url("issues", int(n))); return
        if sub == "comment":
            it["comments"].append({"author": ACTOR, "body": body_of(opt) or "", "createdAt": now()}); it["updatedAt"] = now()
            d["events"].append({"at": now(), "kind": "comment", "n": int(n)})
            print(url("issues", int(n)) + "#issuecomment-%d" % len(it["comments"])); return
        if sub in ("close", "reopen"):
            it["state"] = "CLOSED" if sub == "close" else "OPEN"; it["closedAt"] = now() if sub == "close" else None
            reason = (one(opt, "--reason", "-r") or "completed").replace(" ", "_").upper()
            it["stateReason"] = reason if sub == "close" else None
            c = one(opt, "--comment", "-c")
            if c: it["comments"].append({"author": ACTOR, "body": c, "createdAt": now()})
            d["events"].append({"at": now(), "kind": "issue-" + sub, "n": int(n), "by": "loop"}); return
    die("fakegh: unsupported issue %s" % sub)

def cmd_pr(sub, argv):
    pos, opt = parse(argv, VAL)
    with Store() as d:
        if sub == "list":
            st = one(opt, "--state", default="open").upper()
            out = []
            for p in sorted(d["prs"].values(), key=lambda p: -p["number"]):
                if st != "ALL" and p["state"] != st: continue
                if one(opt, "--head", "-H") and p["headRefName"] != one(opt, "--head", "-H"): continue
                if one(opt, "--base", "-B") and p["baseRefName"] != one(opt, "--base", "-B"): continue
                out.append(pr_obj(d, p))
            out = out[: int(one(opt, "-L", "--limit", default="30"))]
            fields = one(opt, "--json")
            if fields: emit([pick(o, fields) for o in out], opt)
            else:
                for o in out: print("%d\t%s\t%s\t%s" % (o["number"], o["title"], o["headRefName"], o["state"]))
            return
        if sub == "create":
            head = one(opt, "--head", "-H") or subprocess.run(["git", "rev-parse", "--abbrev-ref", "HEAD"], capture_output=True, text=True).stdout.strip()
            if not rev("refs/heads/" + head): die("pull request create failed: head branch %s not pushed" % head)
            for p in d["prs"].values():
                if p["headRefName"] == head and p["state"] == "OPEN":
                    die("a pull request for branch \"%s\" already exists:\n%s" % (head, url("pull", p["number"])))
            d["seq"] += 1; n = d["seq"]
            d["prs"][str(n)] = {"number": n, "title": one(opt, "--title", "-t", default=head), "body": body_of(opt) or "",
                                "headRefName": head, "baseRefName": one(opt, "--base", "-B", default="main"), "state": "OPEN",
                                "isDraft": "--draft" in opt or "-d" in opt, "labels": [], "comments": [], "author": ACTOR,
                                "createdAt": now(), "mergedAt": None}
            d.setdefault("events", []).append({"at": now(), "kind": "pr-create", "n": n, "head": head})
            print(url("pull", n)); return
        p = find_pr(d, pos[0] if pos else None) or die("no pull requests found for %s" % (pos[0] if pos else "current branch"))
        n = p["number"]
        if sub == "view":
            o = pr_obj(d, p); fields = one(opt, "--json")
            if fields: emit(pick(o, fields), opt)
            else: print("title:\t%s\nstate:\t%s\nnumber:\t%d\nurl:\t%s\n--\n%s" % (p["title"], p["state"], n, o["url"], p["body"]))
            return
        if sub == "diff":
            sys.stdout.write(subprocess.run(["git", "--git-dir", REMOTE, "diff", "refs/heads/%s...refs/heads/%s" % (p["baseRefName"], p["headRefName"])],
                                            capture_output=True, text=True).stdout); return
        if sub == "edit":
            b = body_of(opt)
            if b is not None: p["body"] = b
            if one(opt, "--title", "-t"): p["title"] = one(opt, "--title", "-t")
            if one(opt, "--base", "-B"): p["baseRefName"] = one(opt, "--base", "-B")
            for l in opt.get("--add-label", []): p["labels"] += [x for x in l.split(",") if x not in p["labels"]]
            for l in opt.get("--remove-label", []): p["labels"] = [x for x in p["labels"] if x not in l.split(",")]
            print(url("pull", n)); return
        if sub == "ready":
            p["isDraft"] = "--undo" in opt; return
        if sub == "comment":
            p["comments"].append({"author": ACTOR, "body": body_of(opt) or "", "createdAt": now()}); print(url("pull", n)); return
        if sub == "checks":
            sha = rev("refs/heads/" + p["headRefName"])
            runs = [r for r in d["runs"] if r["headSha"] == sha and r["headBranch"] == p["headRefName"]]
            r = runs[-1] if runs else run_ci(d, sha, p["headRefName"], "pull_request")
            st = "pass" if r["conclusion"] == "success" else "fail"
            print("Check\t%s\t1m0s\t%s/actions/runs/%d" % (st, "https://github.com/" + SLUG, r["databaseId"]))
            ok = r["conclusion"] == "success"
        else:
            ok = None
        if sub == "checks":
            pass
        elif sub == "merge":
            if p["state"] != "OPEN": die("pull request #%d is not open" % n)
            sha = rev("refs/heads/" + p["headRefName"]); m = one(opt, "--match-head-commit")
            if m and m != sha: die("head branch was modified. Review and try again.")
            tmp = tempfile.mkdtemp(prefix="bench-merge-")
            try:
                git("clone", "-q", REMOTE, tmp); git("checkout", "-q", p["baseRefName"], cwd=tmp)
                r = subprocess.run(["git", "merge", "--squash", "origin/" + p["headRefName"]], cwd=tmp, capture_output=True, text=True)
                if r.returncode: die("Pull request is not mergeable: merge conflict")
                msg = "%s (#%d)\n\n%s" % (p["title"], n, one(opt, "--body", "-b", default=""))
                git("-c", "user.name=bench", "-c", "user.email=bench@example.invalid", "commit", "-q", "--allow-empty", "-m", msg, cwd=tmp)
                git("push", "-q", "origin", p["baseRefName"], cwd=tmp)
                msha = git("rev-parse", "HEAD", cwd=tmp)
            finally:
                shutil.rmtree(tmp, ignore_errors=True)
            p.update(state="MERGED", mergedAt=now(), mergeSha=msha, headRefOid=sha)
            d["last_merge"] = {"pr": n, "sha": msha, "head": p["headRefName"]}
            d["events"].append({"at": now(), "kind": "pr-merge", "n": n, "head": p["headRefName"], "sha": msha})
            text = (p["body"] or "") + "\n" + (one(opt, "--body", "-b", default="") or "")
            for k in set(re.findall(r"\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)", text, re.I)):
                it = d["issues"].get(k)
                if it and it["state"] == "OPEN":
                    it.update(state="CLOSED", closedAt=now(), stateReason="COMPLETED")
                    d["events"].append({"at": now(), "kind": "issue-close", "n": int(k), "by": "pr#%d" % n})
            if p["baseRefName"] == "main": run_ci(d, msha, "main", "push")
            if "--delete-branch" in opt or "-d" in opt:
                subprocess.run(["git", "--git-dir", REMOTE, "update-ref", "-d", "refs/heads/" + p["headRefName"]])
            print("Merged pull request #%d" % n); return
        elif sub == "close":
            p["state"] = "CLOSED"; return
        else:
            die("fakegh: unsupported pr %s" % sub)
    if sub == "checks":
        sys.exit(0 if ok else 1)

def cmd_run(sub, argv):
    pos, opt = parse(argv, VAL)
    with Store() as d:
        if sub == "list":
            br = one(opt, "--branch", "-b"); wf = one(opt, "--workflow", "-w"); c = one(opt, "--commit", "-c")
            if br == "main":
                head = rev("refs/heads/main")
                if head: run_ci(d, head, "main", "push")
            out = [r for r in reversed(d["runs"]) if (not br or r["headBranch"] == br) and (not wf or r["workflowName"] == wf)
                   and (not c or r["headSha"] == c)]
            out = out[: int(one(opt, "-L", "--limit", default="20"))]
            fields = one(opt, "--json") or "databaseId,status,conclusion,headSha"
            emit([pick(r, fields) for r in out], opt); return
        rid = int(pos[0])
        r = next((r for r in d["runs"] if r["databaseId"] == rid), None) or die("run %d not found" % rid)
        if sub == "view":
            fields = one(opt, "--json")
            if fields: emit(pick(r, fields), opt)
            else: print("%s %s" % (r["workflowName"], r["conclusion"]))
            return
        if sub == "rerun":
            concl = ci_conclusion(r["headSha"], d, r["headBranch"])
            r.update(conclusion=concl, attempts=r.get("attempts", 1) + 1, jobs=[{"name": "test", "conclusion": concl, "status": "completed"}])
            d["events"].append({"at": now(), "kind": "ci-rerun", "branch": r["headBranch"], "conclusion": concl}); return
    die("fakegh: unsupported run %s" % sub)

def cmd_label(sub, argv):
    pos, opt = parse(argv, VAL)
    with Store() as d:
        if sub == "list":
            fields = one(opt, "--json")
            objs = [{"name": x, "color": "ededed", "description": ""} for x in d["labels"]]
            if fields: emit([pick(o, fields) for o in objs], opt)
            else: print("\n".join(d["labels"]))
            return
        if sub == "create":
            if pos and pos[0] not in d["labels"]: d["labels"].append(pos[0])
            return
    die("fakegh: unsupported label %s" % sub)

def main(argv):
    if LOG:
        with open(LOG, "a") as f: f.write(json.dumps({"at": now(), "cwd": os.getcwd(), "argv": argv}) + "\n")
    if not argv: die("fakegh: no command")
    top, sub, rest = argv[0], (argv[1] if len(argv) > 1 else ""), argv[2:]
    for i, a in enumerate(argv):   # refuse any other repository: a call aimed at a real repo must fail, not be answered
        r = argv[i + 1] if a in ("-R", "--repo") and i + 1 < len(argv) else (a.split("=", 1)[1] if a.startswith("--repo=") else None)
        if r is not None and r != SLUG:
            die("fakegh: repository %s is not the sandbox (%s)" % (r, SLUG), 4)
    if top == "auth": print("Logged in to github.com as %s (bench)" % ACTOR); return
    if top == "repo" and sub == "view":
        _, opt = parse(rest, VAL); emit({"nameWithOwner": SLUG, "defaultBranchRef": {"name": "main"}, "url": "https://github.com/" + SLUG}, opt); return
    if top == "api":
        print("[]" if "--paginate" in argv else "{}"); return
    fn = {"issue": cmd_issue, "pr": cmd_pr, "run": cmd_run, "label": cmd_label}.get(top)
    if not fn: die("fakegh: unsupported command %s" % top)
    fn(sub, rest)

if __name__ == "__main__":
    main(sys.argv[1:])
