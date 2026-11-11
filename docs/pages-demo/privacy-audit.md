# Pages demo: privacy and claims audit

Scope: the three content files in this folder (`content-outline.md`, `scenario.json` and this file). Slice 1 of 4. The audit was run from the repository root on the final versions of these files, including this one. Only commands that were actually run are recorded, with their real results.

The automated counterpart is `test/pages-demo-content.test.mjs`. It holds the forbidden-pattern expressions, so the literal strings never appear in these documents. The commands below build the sensitive patterns from fragments for the same reason.

## Checklist

Setup used by the commands below (a shell variable assignment, no real data):

```
A=ho; B=me; U=Us; V=ers
```

For `grep`, exit code 1 with no output means "no match", which is the passing result. Exit code 0 means there was at least one match.

| Category | How it was checked | Result |
| --- | --- | --- |
| Host paths (home directories, system directories, drive letters, tilde paths) | Command P1 | Exit code 1, no output: pass |
| The actual workspace path, home directory, user name and host name of the machine used | Command P2 | Exit code 1, no output: pass |
| Credentials and tokens (token prefixes, key headers, long random-looking strings) | Commands P3 and P4 | Both exit code 1, no output: pass |
| Real user names, emails and the repository owner's handle | Command P5 | Exit code 1, no output: pass |
| Real URLs, links to this repository's issues or pull requests, and issue or PR numbers | Command P6 | Exit code 1, no output: pass |
| Private execution-host state (deployment directory, backup locations, host internals, temporary work areas, process output, extra working copies) | Command P7 | Exit code 1, no output: pass |
| Logs (timestamps, log levels, stack frames) | Command P8 | Exit code 1, no output: pass |
| Diffs (diff headers and hunk markers at the start of a line) | Command P9 | Exit code 1, no output: pass |
| Real issue or comment text | Command P10 compares every 6-word sequence in these files with the cached text of the source discussion | Exit code 0, no shared sequences: pass |
| Pattern sanity (the patterns can match) | Command P11, a positive control on invented strings | Output 3, exit code 0: patterns work |
| Files changed outside the allowed four | Command P12 | Only the four new files listed: pass |

### Commands and real results

P1: host paths.

```
grep -rnE -e "/${A}${B}/" -e "/${U}${V}/" -e '[A-Za-z]:\\' -e '/(tmp|var|etc|root|opt|mnt|srv)/' -e '(^|[ "`(])~/' docs/pages-demo
```

Exit code: 1 (no output).

P2: the real machine's own values.

```
grep -rnF -e "$PWD" -e "$HOME" -e "$(whoami)" -e "$(hostname)" docs/pages-demo
```

Exit code: 1 (no output).

P3: credential prefixes and key headers.

```
grep -rnE -e "gh""p_" -e "github_pa""t_" -e "\bs""k-[A-Za-z0-9_-]{16,}" -e "-----BE""GIN" docs/pages-demo
```

Exit code: 1 (no output).

P4: long random-looking strings, after setting aside repository-relative paths (the only long tokens, used as evidence pointers).

```
grep -rnE '[A-Za-z0-9+/=_-]{40,}' docs/pages-demo | grep -vE '\.agents/skills/roundtable-work/'
```

Exit code of the pipeline: 1 (no output after the filter). Before the filter, the only matches were nine distinct fragments of the evidence paths under the skill directory (listed with `grep -rnoE` and `sort -u`).

P5: emails and the owner's handle.

```
grep -rnE -e '[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}' -e "Li""yuk" docs/pages-demo
```

Exit code: 1 (no output).

P6: URLs, repository links and numbers.

```
grep -rnE -e 'https?:' -e 'www\.' -e 'github\.com' -e '#[0-9]+' -e "Clo""ses #" docs/pages-demo
```

Exit code: 1 (no output).

P7: private execution-host state.

```
grep -rniE -e "rt-lo""op" -e "back""ups" -e "run""ner" -e "\.round""table" -e "scrat""ch" -e "std""err" -e "std""out" -e "work""tree" docs/pages-demo
```

Exit code: 1 (no output).

P8: log-like content.

```
grep -rnE -e '[0-9]{4}-[0-9]{2}-[0-9]{2}' -e '[0-9]{2}:[0-9]{2}:[0-9]{2}' -e '\[(INFO|WARN|ERROR|DEBUG)\]' -e "Trace""back" -e '\(.*:[0-9]+:[0-9]+\)' docs/pages-demo
```

Exit code: 1 (no output).

P9: diff-like content.

```
grep -rnE -e '^(diff --git|index [0-9a-f]{7}|@@ |\+\+\+ |--- [ab]/)' docs/pages-demo
```

Exit code: 1 (no output).

P10: overlap with the real source text. `CTX` points at a private local cache of the source discussion, which is deliberately not named here.

```
node -e '
const fs=require("fs");
const words=(t)=>t.toLowerCase().replace(/[^a-z0-9]+/g," ").trim().split(" ").filter(Boolean);
const src=words(fs.readFileSync(process.argv[1],"utf8"));
const grams=new Set(); for(let i=0;i+6<=src.length;i++) grams.add(src.slice(i,i+6).join(" "));
let hits=0;
for(const f of fs.readdirSync("docs/pages-demo")){
  const w=words(fs.readFileSync("docs/pages-demo/"+f,"utf8"));
  for(let i=0;i+6<=w.length;i++){const g=w.slice(i,i+6).join(" "); if(grams.has(g)){hits++;console.log(f+": "+g);}}
}
console.log("shared 6-word sequences: "+hits);
process.exitCode=hits?1:0;
' "$CTX"
```

Exit code: 0. Output: `shared 6-word sequences: 0`. An earlier run on an earlier draft found 5 shared sequences (the slice title and the list of forbidden data kinds); those two sentences were rewritten and the check was re-run on the final files.

P11: positive control. The patterns are fed invented strings that should match.

```
printf '%s\n' "/${A}${B}/x" "gh""p_abc" "a""@b.example" | grep -cE -e "/${A}${B}/" -e "gh""p_" -e '[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}'
```

Output: 3. Exit code: 0.

P12: repository state.

```
git status --short
```

Output: the four new paths only (`docs/pages-demo/` with its three files, and `test/pages-demo-content.test.mjs`). Exit code: 0.

## Claims audit

Rules applied to every statement in the outline and the scenario:

- Present tense is used only for things written in the repository, and each such claim has a repository path as evidence.
- Anything that needs a runtime, a host feature or a measured run is marked planned, or described as dependent on the host and unverified.
- Failure branches describe what the Chief does, not what will be achieved.
- No statement says the system runs continuously, and none says that a failure will be repaired.

| Claim | Status | Why it is neither an always-available promise nor a recovery promise |
| --- | --- | --- |
| c01 Five roles have separate instructions | implemented | States that instructions exist; says nothing about availability |
| c02 Structured handoff templates | implemented | States that templates exist |
| c03 Five continuation decisions | implemented | Describes a vocabulary; `wait` is defined as waiting for a named event, with no wake-up promised |
| c04 Chief reads evidence, checks scope and runs the final check | implemented | Describes a required practice for an agent; the limits say it is not automatically enforced by a runtime |
| c05 Reviewer verdict line; independence is not proof of correctness | implemented | A format rule plus a caution; the limits repeat that review is not proof of correctness |
| c06 Review is by a different session than the author, otherwise a self-check | implemented | A labelling rule from the Chief instructions |
| c07 Executors do not commit by default | implemented | A default restriction |
| c08 Default budgets and stop conditions | implemented | Budgets make work stop; they say nothing about success |
| c09 Merge, publish and deploy need approval | implemented | A restriction; the demo itself performs no merge |
| c10 Installer and doctor scripts; wake-up reported as unverified | implemented | The claim is about scripts, and it repeats that wake-up is unverified |
| c11 CI runs install and test commands | implemented | Describes the repository's own check on pushes and pull requests |
| c12 Pull request convention | implemented | Describes a contribution convention |
| c13 Background wake-up | planned | Stated as host-dependent and unverified |
| c14 Event-to-issue loop | planned | Candidate design only |
| c15 Restart recovery design | planned | Design only; no recovery is claimed to work |
| c16 The demo site | planned | Future work from later slices |
| Failure branches f01 to f08 | n/a | Each outcome says work may halt, stay pending or need a person; none says the work will be restored |
| Pause controls p01 to p06 | n/a | `wait` is not promised to wake; p01 depends on the host; p06 is a visual control only |
| Walkthrough steps s01 to s17 | n/a | Labelled synthetic; the last step is a human decision outside the demo, and no step has the Chief or the demo merging |
| Limits section and disclaimer | n/a | Contain the negated statements about continuous operation and about recovery |
| Test and scope gates are not runtime-enforced (the outline's "Not implemented; not claimed" row and a `limits` entry) | n/a | Not a claim in `claims`; states that the gates are Chief verification steps described in instructions and performed by an agent, not automatically enforced by a runtime |

The test applies a simple rule for phrases of that kind: in the scenario, only the disclaimer and the limits may mention them, and only inside a negated sentence; elsewhere in the scenario they are forbidden outright. In the Markdown files a line that contains one must also contain a negation word.

## Quoted phrases

These are the phrases the test rejects when they are used as claims. They are listed here because the test exempts this section only.

- the phrase for round-the-clock availability, written as the digits 24, a slash, and 7 (also the "24x7" spelling)
- "around the clock"
- "always on" and "always-on"
- the word "guarantee" and its forms, as in a guaranteed recovery
- "never fails"
- "automatic merge", "auto-merge" and "merges automatically"
- "self-heal" and "self-healing"

## Limits of this audit

- The checks are pattern based. They cannot find sensitive information that was paraphrased, encoded or split into fragments.
- P10 compares only against the cached text of the source discussion. The text of the issue itself was compared by reading, not by a command. Neither comparison can show that real content from some other source is absent.
- Passing the host-value check (P2) only shows that the values of the machine used are absent. It says nothing about other machines.
- The scan covers only this folder. It does not cover the test file (which holds the patterns on purpose), the git history, or any later site code.
- The evidence paths were checked to exist. That shows the file is there, not that the file's content proves the claim; the claims were judged by reading the files.
- The claims audit and the phrase rule are judgments and a heuristic. A negation word on the same line does not prove the sentence is honest.
- The phrase rule matches fixed phrases only. A rewording such as a plain assertion that recovery is assured would not be caught by the test. Whether each claim and its evidence path are correct is checked by human review only; the test checks that an implemented claim's path exists, not that the file supports the sentence.
- This is not an accessibility, link or mobile review; those belong to later slices.
- It was prepared by the author of the content. The independent reviewer's verdict is separate and is not recorded here.
