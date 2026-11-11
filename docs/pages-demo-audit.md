# Pages demo: independent audit report

Slice 4 of 4 of the Pages demo (issue #20). This is an audit of the final Pages implementation and deployment configuration. It reports; it changes nothing in `site/`, `scripts/`, `.github/`, `test/` or `package.json`.

- Audited commit: `eb928b8` on branch `rt/20-pi` (stack of #17, #18, #19).
- Audit date: 2026-11-11 (UTC). Auditor: an auditor session that did not write the audited code.
- Method: read every audited file in full, then ran the commands listed in [Command log](#command-log). This report lives at `docs/pages-demo-audit.md`, outside `docs/pages-demo/`, so it does not break the tests that pin that directory's file list and scan it for forbidden data patterns. I did not rely on `docs/pages-demo/privacy-audit.md`; every privacy check below was re-run from scratch.
- Evidence levels: **executed** (command run, exit code recorded), **read** (file opened, line cited), **computed** (calculated from file values by a one-liner), **not verified** (could not be done here).
- Privacy note: this report is public. Host identity values are not reproduced; the report says "the host" or "the OS user" where a value was involved.

Verdict words: **OK** (no problem found), **Finding** (a problem, not blocking), **Blocker** (must be fixed before public deployment), **Not verifiable** (cannot be decided with the tools available).

## Summary

| # | Item | Verdict | One line |
| --- | --- | --- | --- |
| 1 | Synthetic-only data | OK | Scenario is flagged synthetic; every ID is `DEMO-*`; no real issue, diff, log, date or hash. The fictional product name could not be checked against real products. |
| 2 | No leaked real runtime details | Finding (history only) | The published artifact is clean. Two earlier commits carry the OS user name in the author e-mail. |
| 3 | Accurate capability claims | OK | No 24/7, guarantee or auto-merge wording; each "Implemented" row was checked against the repo. |
| 4 | Accessibility | Finding (low) | Structure, names, focus and contrast pass by static analysis. Two dots differ by colour only; small usability gaps. Not tried with a browser or screen reader. |
| 5 | Reduced motion | OK | CSS and JS both honour the preference; nothing starts without a click. Static analysis and stubbed-DOM tests only. |
| 6 | Mobile and responsive | Finding (low) | Viewport, breakpoints and stacking are sound. Some targets are 40 px; diagram nodes can overlap with large text-only zoom (computed). |
| 7 | Links | OK | 19 `href`/`src` values, all relative or in-page; every target exists; no duplicate ids. |
| 8 | Workflow permissions | Finding (low) | Least privilege, no `pull_request_target`, no secrets, deploy guarded. Actions are pinned to major tags, not commit SHAs. |
| 9 | Rollback behavior | OK (static) / Not verifiable (runtime) | Docs match the workflow. Never exercised on GitHub. Rollback depends on CI passing. |

**Blockers: none found.** All findings are low severity and non-blocking for the artifact; finding F1 needs a human decision (see below).

## 1. Synthetic-only data

**Verdict: OK**

Evidence:

- `docs/pages-demo/scenario.json:3` has `"synthetic": true`. `scripts/build-site.mjs` `validate()` (`build-site.mjs:66`) throws if it is not `true`. Read.
- Actors are `Sample Requester`, `Chief (demo)`, `Researcher (demo)`, `Developer (demo)`, `Independent Reviewer (demo)`, `Fixer (demo)` (`scenario.json:7-12`). Read.
- Executed: a node one-liner listed every identifier-like token in `scenario.json`. Result: `DEMO-001`, `DEMO-001-res`, `DEMO-001-dev`, `DEMO-001-rev`, `commit-0001`, `PR-1` only. The commit and PR are written as `demo-commit-0001` and `DEMO-PR-1 (fictional, no real link)` (`site/index.html:408`, `:420`).
- Executed: `grep -nE '\b[0-9a-f]{7,40}\b'` (minus `DEMO`) and a date/time grep on `scenario.json` returned no output. No hashes, dates or clock times.
- Executed: grep for `liyuk|issues?/[0-9]+|pull/[0-9]+|rt-loop|rt/[0-9]|runner|vps|github.com` over `site/` and `scenario.json` returned no output. No real issue or PR numbers or repository links.
- The banner at `site/index.html:21` and `:112` states that the data is invented. The footer at `:555` repeats it.
- The default budgets shown (2 attempts, 2 rejections, 2 no-progress turns) are the public template defaults in `.agents/skills/roundtable-work/templates/policy.md:14-16`, not state of any real deployment. Read.

Residual: the app name "Notekeep" is described as fictional. I had no network access and did not check whether a real product has that name (**Not verified**). Suggestion S1.

## 2. No leaked real runtime details

**Verdict: Finding** (git history only; the published files are clean)

Evidence (all executed on tracked files unless noted):

- IPv4: `grep -rnE '\b([0-9]{1,3}\.){3}[0-9]{1,3}\b' site docs/pages-demo .github scripts`. Only `127.0.0.1` in `docs/pages-demo/deployment.md:58`, `scripts/preview-site.mjs:3` and `:12`. Loopback, not a host address. `site/` has none.
- Absolute paths: a `grep -rnE` over `site`, `docs/pages-demo` and `.github` for absolute-path patterns (home-directory paths on Linux and macOS, root, system directories such as etc, var and tmp, and Windows drive paths) returned nothing.
- Credentials: grep for credential patterns (GitHub token prefixes, classic and fine-grained; cloud access-key prefixes; private-key headers; the words password, secret, API key and bearer) over `site/`, `scenario.json`, `.github/`. Only CSS/JS identifiers named `token` (a decorative element, `site/styles.css:218-224`, `site/app.js:19`) and the words "host/secret patterns" in a workflow comment (`.github/workflows/pages.yml:45`). No secret values.
- E-mail addresses: `grep -rnE '[A-Za-z0-9._-]+@[A-Za-z0-9.-]+\.[a-z]{2,}' site docs/pages-demo .github` returned nothing.
- Host name, OS user name and home directory: searched all tracked files (`git ls-files | xargs grep -F`) for the three values of the machine running this audit. Home directory: 0 files. Host name: 0 files. OS user name: only the standard runner label `ubuntu-latest` in `.github/workflows/*.yml` and the pattern `^ubuntu-` in `test/pages-workflow.test.mjs:59`. Those are public labels, not host data.
- Real issue content, diffs, logs, runner state: `site/index.html` and `scenario.json` contain only the invented Notekeep story. `docs/pages-demo/*.md` have no `#NN` issue references and no URLs (a `grep -nE` for `#NN` references, repository host names and URL schemes over the three existing files in `docs/pages-demo/` returned no output). The private deployment directory is in `.gitignore` and is not tracked.
- Artifact boundary: `site/` holds exactly `app.js`, `index.html`, `styles.css` (executed `ls`). `pages.yml:50` uploads `site` only.

**F1 (Finding, needs human decision).** Executed: `git log -4` with a format of abbreviated hash, author name and author e-mail. Commits `a51d4d0` (#18) and `416f191` (#17) were authored and committed with a default machine identity (an author name plus an e-mail whose local part is the OS user name and whose domain is a machine-local one). A comparison command confirmed that the e-mail local part equals the OS user name of the machine that made the commits (the value is not reproduced here). Both commits are contained in the remote branches `origin/rt/18-pi` and `origin/rt/19-pi` (`git branch -a --contains a51d4d0`). The policy for this project forbids publishing the OS user name. Commit `eb928b8` (#19) already uses the neutral identity `Roundtable Chief <…@users.noreply.github.com>`, and the earlier #8 commit has an ordinary GitHub identity.

- Why it is not a Blocker: Pages publishes only `site/`, so the artifact does not contain this value. It is metadata of the branch history.
- Proposed handling (human decision): history cannot be cleaned without a force-push, which the agent policy forbids. Options: accept it if the local part is a generic default; or have the maintainer rewrite the two commits before the branches are public; and in any case merge with a squash (the squash commit takes the merger's identity). Keep the neutral identity for all new commits.
- Not verified: whether the repository is public, and whether PR refs (`refs/pull/N/head`) would keep the commits reachable after a rewrite.

Other observation (S2): `scripts/validate-site.mjs` cannot detect host names, e-mail addresses or IPv6 (see item 8, F6). The check is a safety net; the independent scans above are what covers these.

## 3. Accurate capability claims

**Verdict: OK**

Wording scan, executed: `grep -n -i -E '24/7|24x7|always.on|continuous|guarantee|automatic(ally)? (merge|deploy)|auto-?merge|will recover|self-heal|production|live system|real-time' site/index.html site/app.js`. Three hits, all negations: `site/index.html:21` (does not promise 24/7 or recovery), `:41` and `:541` (no background runtime, no 24/7 claim). `deployment.md:103` uses "guaranteed" only to deny it ("no recovery time is guaranteed").

Claims against the repository (read, with the file that backs each):

| Claim on the page | Checked against | Result |
| --- | --- | --- |
| Five roles with separate instructions (`index.html:517`) | `.agents/skills/roundtable-work/SKILL.md:14-15` and `prompts/roles/{chief,developer,fixer,researcher,reviewer}.md` exist | Matches |
| Ticket, delegation card, delivery card, checkpoint (`:518`) | `SKILL.md:26-33`; `templates/{ticket,assignment,delivery,checkpoint}.md` exist | Matches |
| Five continuation decisions (`:519`) | `SKILL.md:26` | Matches |
| Chief reads evidence, checks out-of-scope writes, runs the final full check (`:520`) | `prompts/roles/chief.md:16`, `:32`, `:36` | Matches |
| Reviewer's first line is the verdict; independent session is not proof (`:521`) | `prompts/roles/reviewer.md:9`, `:12` | Matches |
| Different session reviews; same session is a self-check (`:522`) | `chief.md:16` | Matches |
| Executors do not commit by default; Chief commits after a pass (`:523`) | `SKILL.md:33`, `chief.md:32` | Matches |
| Default budgets 2/2/2 (`:524`) | `templates/policy.md:14-16` | Matches |
| Merge, publish, deploy need approval (`:525`) | `templates/policy.md:9` | Matches |
| Installer and read-only doctor; doctor reports wake-up as unverified (`:526`) | `scripts/doctor.mjs:62-63`, `:83`; no file-write API is imported or called in `doctor.mjs` (it reads files and runs host probes) | Matches |
| Repository CI runs install and tests (`:527`) | `.github/workflows/check.yml` | Matches |
| PRs link an issue and report checks run and not run (`:528`) | `CONTRIBUTING.md:5`, `:9`; `.github/PULL_REQUEST_TEMPLATE.md:10-11` | Matches |
| Four "Planned, not claimed" rows (`:529-532`) | These items have no path; the page says so | Conservative |

Other claims:

- "No forms, no cookies, no stored data, no network requests" (`:555`). Executed: `grep` of `site/app.js` for `fetch|XMLHttpRequest|WebSocket|sendBeacon|localStorage|sessionStorage|document.cookie|indexedDB|eval(|new Function|innerHTML|insertAdjacent|import(|location|window.open|navigator.` returned no match (rc 1). `index.html` has no `<form>`, `<input>`, `<img>`, `<iframe>`, inline handler or inline style (grep returned only the `data:,` icon and the stylesheet link). The meta Content-Security-Policy (`index.html:7`) sets `default-src 'none'`, `script-src 'self'`, `style-src 'self'`, `img-src data:` and no `connect-src`, so the browser should also block network requests (not tested in a browser).
- "The demo has no merge control": `index.html` has 25 `<button>` elements: Previous, Next, Play, Restart, 4 jump buttons, 17 step dots (computed count; test `site.test.mjs:270` also asserts no merge/deploy action). None submits, navigates or calls a network API.
- Gates are described as agent instructions, not enforcement (`index.html:67`, `:545`). This matches the repository (no runtime enforces them).
- Deployment status: the "static, accessible demo site" row says Planned (`:532`) and `deployment.md:5` says nothing is published until Pages is enabled. Consistent with the facts (Pages is not enabled, see Not verified).

Suggestion S3: the planned row for the demo site says "No path: planned only" although `site/` and the workflow now exist in this branch. It is understated, not overstated, and `deployment.md:91` already tells maintainers to update it in a separate reviewed change after the first real deployment. No action needed now.

## 4. Accessibility

**Verdict: Finding (low).** Static analysis of the HTML, CSS and JS plus computed contrast. No browser, screen reader or assistive technology was available (**Not verified**, see end).

### Structure and names (read; computed counts from `site/index.html`)

- `lang="en"` on `<html>` (`:2`); the Chinese verdict line is wrapped in `lang="zh-Hans"` spans (`:67`, `:98`, ...).
- Landmarks: 1 `<header>`, 1 `<nav aria-label="Page sections">` (`:22`), 1 `<main id="main" tabindex="-1">` (`:36`), 1 `<footer>`, 8 `<section aria-labelledby>`. Skip link first in the body (`:15`), target `#main` exists.
- Headings: exactly one `h1`, 41 headings, no skipped level (computed; also asserted by `site.test.mjs:113`).
- Tables: two, each with `<caption>`, 31 `<th scope=…>`; ARIA roles are repeated on the table elements so semantics survive the `display:block` mobile layout (`styles.css:285-295`).
- Every `<button>` has `type="button"` and a name: the four controls have text; step dots have `aria-label="Go to step N: …"` with the visible number inside the name (label-in-name satisfied); the decorative glyphs are `aria-hidden`.
- Live region: one polite `role="status"` region (`:207`), visually hidden, updated by `app.js` `announce()` (`:60-66`). The step detail panel is a separate non-live group (`:176`), so content is not announced twice.
- The diagram is `aria-hidden="true"` (`:138`) and contains no focusable element; everything in it is also present as text in the step detail and live region.
- All `aria-labelledby` / `aria-describedby` ids resolve (executed check, no "MISSING" output). No positive `tabindex` (only two `tabindex="-1"`: `main` and the detail panel). No `autofocus`, `autoplay`, `<marquee>`, meta refresh.
- No JS: the stepper and its heading are `hidden` until `app.js` runs (`:123`); `<noscript>` explains this (`:121`); all 17 steps are in an open `<details>` (`:211`) in reading order.

### Keyboard and focus (read; stubbed-DOM tests executed)

- Every control is a native `<button>`, `<a>` or `<summary>`, so Tab, Enter and Space work natively (`app.js:121` comment, handlers on `click`). Arrow Left/Right inside the stepper are an optional extra (`app.js:146-151`); they ignore modifier keys and are not required.
- Previous/Next use `aria-disabled` instead of `disabled` so focus is not lost at the ends (`app.js:42-45`).
- Visible focus: `:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px }` (`styles.css:77`); the current dot has its own outline and a focus override (`:238-239`); the skip link becomes visible on focus (`styles.css:85`, `:89`). `main:focus` has no outline by design (`styles.css:78`), which is acceptable because `main` is only a programmatic target.
- Key-moment links open the step in the stepper and move focus to the detail panel (`app.js:133-144`) with a no-JS fallback to the `#step-sNN` anchors.
- The tests execute `app.js` in a stub DOM (`test/site.test.mjs:386-440`), not in a browser, so the real DOM behaviour (focus, `scrollIntoView`, `cloneNode`) is **not verified**. The stub also returns an empty list for the `a[data-step]` links, so that handler is not exercised by the tests.

### Contrast (computed)

Command: a node one-liner using the WCAG relative-luminance formula over the CSS custom properties in `site/styles.css:5-40`, for both the light theme and the `prefers-color-scheme: dark` theme. No file was left behind. Exit 0.

- Text pairs (threshold 4.5:1), 22 pairs per theme. All pass. Tightest light-theme pairs: `--teal` on `--teal-tint` (badge) 5.39, `--teal` on `--surface-2` 5.31, `--amber` on `--amber-tint` (badge) 5.59, `--teal` on `--bg` (links) 5.85, `--red` on `--red-tint` 5.97. Tightest dark-theme pair: `--teal` on `--teal-tint` 6.98. Body text: 14.40 (light), 14.97 (dark). Muted text on any surface: at least 6.70 (light), 7.58 (dark). Button label `--on-teal` on `--teal`: 6.31 (light), 9.30 (dark).
- Non-text pairs (threshold 3:1): control and card borders `--line` on `--bg`/`--surface`: 3.35 / 3.55 (light), 4.81 / 4.34 (dark). Focus ring `--focus` on `--bg`/`--surface`: 5.97 / 6.33 (light), 10.01 / 9.03 (dark). State borders amber/red/teal on surface: at least 6.20 (light), 8.08 (dark). All pass.
- One computed pair is not applicable: `--focus` against `--teal` is 1.02 (light) / 1.11 (dark), but the ring is drawn with a 2 px offset, so it sits on the surrounding background, not on the teal fill. I list it so nobody is surprised by the raw number.
- `forced-colors` mode has a rule (`styles.css:312-314`). Not tested.

### Colour-only meaning

- Badges carry a glyph plus a text label (`index.html:115-119`); step kinds appear as a badge in text. Pass.
- **F2 (Finding, low).** The step dots for "review sent back" and "review passed" differ only by border colour (`styles.css:236` red 3 px; `:237` teal 3 px; same width and style). The legend says "colour is never the only signal" (`index.html:120`). The dot's accessible name does carry the meaning (e.g. "Independent review: sent back") and the selected step shows a text badge, so no information is lost, but the legend sentence is slightly too strong for the dots. Proposed fix: add a glyph (✕ / ✓) next to the number for those two dots, or change the legend sentence to refer to the badges.

### Other usability observations (non-blocking)

- **F3 (Finding, low).** Tab order has about 33 stops before the first section content is reached via the stepper: 8 nav links, 4 controls, 4 jump buttons, 17 dots (`index.html:22-33`, `:127-132`, `:178-206`). The skip link and the `<details>` fold help, but a keyboard user must tab through all 17 dots. Proposed fix: make the dots a single tab stop with arrow-key movement (roving tabindex), or hide the dots from the tab order because Previous/Next and the jump buttons already cover navigation.
- **F4 (Finding, low).** When reduced motion is on, the Play button is `disabled` (`app.js:50`) and an explanation appears (`index.html:134`), but the button's `aria-describedby` points only at the "Demo playback only" note (`:130`, `:133`). Proposed fix: add `motion-note` to `aria-describedby` while it is shown.
- A screen-reader user gets the step content twice (stepper detail and the full list). The list is folded when JS runs (`app.js:160`), which reduces it. Acceptable.

## 5. Reduced motion

**Verdict: OK** (static analysis and stubbed-DOM tests; no browser)

CSS (read):

- Smooth scrolling only inside `@media (prefers-reduced-motion: no-preference)` (`styles.css:47-49`).
- A reduce block sets `animation: none`, `transition: none`, `scroll-behavior: auto` on every element and removes the active-node scale (`styles.css:303-310`).
- The only motion in the stylesheet is the node colour/scale transition (`:200`) and the token move (`:221`); both are covered by the reduce block. There is no `@keyframes` (executed: `grep -c '@keyframes' site/styles.css` returned 0; the single `animation` hit is the `none` override).

JS (read, `site/app.js`):

- Reads `matchMedia('(prefers-reduced-motion: reduce)')` at load (`:35-36`) and on change (`:154-155`); a change to "reduce" stops playback (`:115-119`).
- Play is disabled and refuses to start while reduced (`:50`, `:105`). `scrollIntoView` uses `behavior: 'auto'` when reduced (`:141`).
- Nothing autoplays: `play()` is called only from the Play button's click handler (`:124`). Playback is stopped by Pause, Previous, Next, Restart, jump buttons, link jumps, arrow keys, the end of the list and a hidden tab (`:122-153`, `:108-110`). Step interval 3.5 s (`:34`).
- Executed: tests `site.test.mjs:181` (reduced motion in CSS and JS), `:444`, `:481` and `:518` (no autoplay, Play only after click, stops on Pause and on reduced motion, disabled at load). These passed inside `npm test` (exit 0). They use a stub DOM.

Design note, not a defect: while the system asks for reduced motion the user cannot start playback even deliberately. Previous/Next give the same content. This is the conservative choice.

## 6. Mobile and responsive usability

**Verdict: Finding (low)** (static and computed; no device or browser)

Evidence:

- `<meta name="viewport" content="width=device-width, initial-scale=1">` (`index.html:5`). No `user-scalable` or `maximum-scale` (computed regex check), so pinch zoom is allowed.
- `text-size-adjust: 100%` (`styles.css:45`); sizes are in `rem`/`clamp()`/`%`; there are no fixed pixel widths other than the 1 px visually-hidden helpers (executed `grep` over `styles.css`). Test `site.test.mjs:309` asserts "no fixed widths over 320px, relative units".
- Breakpoints: `min-width: 60rem` (side-by-side diagram, `styles.css:275`), `max-width: 42rem` (tables become stacked cards with `data-label`, `:285-295`), `max-width: 24rem` (smaller nodes, `:296-300`).
- Overflow: `body { overflow-wrap: break-word }`, `code { overflow-wrap: anywhere }`, flex rows use `flex-wrap` (`.controls`, `.nav-list`, `.jumps`, `.dots`), grids use `minmax(min(100%, 17rem), 1fr)`. Computed for a 320 px viewport: the diagram stage is about 262 px wide and 314 px tall; the nearest node centres are 92 px apart horizontally and at least 94 px vertically, and nodes are 64 px wide, so no overlap at the default text size. Test `site.test.mjs:319` asserts the same geometry from 320 px up, and that the "Outside the demo" box stays in normal flow below the stage.
- Touch targets (computed from `rem` at 16 px): nav links, `.btn`, `<summary>` at least 44 px (`styles.css:101-104`, `:146-147`, `:243`); `.btn-small` and `.dot` 40 px (`:152`, `:231`); the footer link 24 px (`:272`); inline text links use the inline exemption. All meet WCAG 2.2 AA minimum size (24 px). The dots and small buttons are below the common 44 px guideline.
- **F5 (Finding, low).** Targets of 40 px for 17 adjacent dots (gap 5.6 px, `styles.css:230`) are fine for AA but small for thumbs. Proposed fix: raise `.dot` and `.btn-small` to `min-height/width: 2.75rem`.
- **F7 (Finding, low, computed not observed).** With text-only enlargement (for example a 200 % system font size on a 390 px phone), `.node` is `4.6rem`/`4rem` wide (`styles.css:194`, `:298`) inside a stage whose width is a share of the viewport. Computation for rem = 32 px and a 390 px viewport: stage about 276 px wide, node 128 px wide, neighbouring node centres about 97 px apart, so the labels overlap and the left and right nodes spill past the stage border. The diagram is `aria-hidden` and the same information is in text, so no content is lost, but the picture becomes messy. Proposed fix: size nodes in `%` of the stage (or `clamp()` against the stage width) and shrink the label font with `min()`, or hide the diagram when `max-width` in `rem` is small. Needs a real-browser check.
- Orientation is not locked; there is no fixed or sticky element; no hover-only function (hover rules only add emphasis, `styles.css:105`).

## 7. Links

**Verdict: OK**

Executed (node one-liner over `site/index.html`, exit 0):

- 19 `href`/`src` attributes, 18 distinct. Non-anchor values are exactly `data:,` (empty icon, `index.html:10`), `styles.css` (`:11`) and `app.js` (`:12`); both files exist. No external, protocol-relative or root-absolute URLs (also `grep -c 'https\?:'` returned 0 for all three site files, and `npm run validate:site` passed).
- All in-page `href="#…"` targets exist (0 missing). 48 ids, 0 duplicates. All `aria-labelledby`, `aria-describedby` and `data-goto` targets resolve (17 steps, 21 `data-goto` buttons = 4 jumps + 17 dots).
- JS ids and selectors used in `site/app.js` exist in the HTML (no "JS id missing" or "JS selector missing" output).
- Four ids are not referenced by anything (`stepper`, `stepper-h`, `all-steps-h`, `moments-h`). Harmless; they are not dead links.
- Local Markdown links under `docs/pages-demo/`: `deployment.md` has 5 links, 0 broken, anchors included (executed one-liner); the other two files have none. `npm run check` (exit 0) checked 51 Markdown files in the final run (50 before this report was added).
- The evidence paths printed in the claims table (`index.html:517-527`) are plain text, not links. Executed: every path listed exists (7 of 7).

## 8. Workflow permissions

**Verdict: Finding (low)**

Executed: `python3` YAML parse of `.github/workflows/pages.yml` (exit 0), and grep for risky constructs. Read: `pages.yml` in full.

| Check | Evidence | Result |
| --- | --- | --- |
| Triggers | `pages.yml:12-16`: `push` to `main`, `pull_request`, `workflow_dispatch` (parse output: `['push', 'pull_request', 'workflow_dispatch']`) | OK |
| `pull_request_target`, `workflow_run`, self-hosted, `write-all`, `secrets.` | `grep -n -E 'pull_request_target\|secrets\.\|workflow_run\|self-hosted\|write-all\|enablement\|GITHUB_TOKEN'` over `.github/workflows/*.yml`: no match for any (the only hit of the whole pattern set is a `github.event_name` expression in a concurrency setting, `pages.yml:31`) | OK |
| Top-level permissions | `pages.yml:19` `permissions: {}` (parsed: `{}`) | OK |
| Build job | `pages.yml:26-27` `contents: read` only | OK |
| Deploy job | `pages.yml:59-61` `pages: write`, `id-token: write` only; no checkout, no repo code runs in this job | OK |
| Deploy guard | `pages.yml:56` `github.event_name != 'pull_request' && github.ref == 'refs/heads/main'`; `needs: build` (`:54`) | OK |
| Fork PRs | `pull_request` runs with a read-only token and no secrets; deploy job is skipped; build job has `persist-credentials: false` (`:35`) | OK |
| Environment | `pages.yml:62-64` `github-pages`; protection rules are a repository setting, not set by the workflow | OK, setting not verified |
| Expression injection | No `${{ }}` inside any `run:` step; the only expressions are in `concurrency` and `environment.url` | OK |
| Pages not auto-enabled | `configure-pages` has no `enablement` input (`:72`) | OK |
| Concurrency | Build: per-ref group, cancel only for PRs (`:29-31`). Deploy: group `pages`, `cancel-in-progress: false` (`:66-68`) | OK |
| Timeouts | 10 minutes per job (`:25`, `:58`) | OK |
| Artifact content | `upload-pages-artifact` `path: site` (`:48-50`) after `validate:site` passes (`:46`) | OK |
| Action pinning | `pages.yml:33,36,48,72,74`: `actions/checkout@v4`, `actions/setup-node@v4`, `actions/upload-pages-artifact@v4`, `actions/configure-pages@v5`, `actions/deploy-pages@v4`; all official `actions/*`, major-version tags, not commit SHAs. `dependabot.yml` has a weekly `github-actions` update entry (read). | Finding F6a |

**F6a (Finding, low).** Action tags are movable. The deploy job holds `id-token: write`, so a compromised tag in an action used there would run with the ability to request an OIDC token. The risk is limited because only first-party actions are used and the job runs no repository code. The workflow documents this policy (`pages.yml:8-9`, `deployment.md:40`). Proposed fix: pin the two actions in the deploy job (and ideally all five) to full commit SHAs with a version comment; Dependabot can keep SHA pins current. This is a policy choice for the maintainer.

**F6b (Finding, low).** `scripts/validate-site.mjs` is described in `pages.yml:45` and its own header (`validate-site.mjs:5-6`) as checking for "host or secret patterns". Executed: I copied `site/` to a scratch directory, injected one problem at a time, and ran `node scripts/validate-site.mjs <dir>`:

- Detected (exit 1, 11 of 18 mutations): plain-HTTP URLs, upper-case HTTPS URLs, protocol-relative `//cdn…` references, `src="/a.png"`, `url(/x.png)`, a home-directory path, IPv4, a GitHub-token-prefix string, extra file, subdirectory, symlink. Messages give file, line and rule, not the matched text.
- Not detected (exit 0, 7 of 18 mutations): IPv6 addresses, a host name such as `build-host-01.internal.example`, an e-mail address, `ws://`/`wss://`, `ftp://`, `javascript:` and an `@import` with an escaped scheme.

`deployment.md:72-78` lists the real scope accurately (IPv4 only, home paths, token patterns), so the docs are honest; only the code comment and workflow comment say "host patterns" in a broader sense. The meta CSP would block `ws:`, `ftp:` and `javascript:` at runtime (`default-src 'none'`, `script-src 'self'`; not tested in a browser). Proposed fix: add rules for IPv6 literals, `ws:`/`wss:`/`ftp:`/`javascript:`/`data:text/html` and e-mail addresses, and reword the comments to say "IPv4 and path patterns".

**F6c (note, out of scope).** The older `.github/workflows/check.yml` runs `actions/checkout@v4` without `persist-credentials: false` (`check.yml:11`); its permission is `contents: read` and it is not part of the Pages stack. Both workflows run `npm test` on pull requests, so a PR runs the tests twice. Neither is a security problem.

Not checkable here: whether the five action versions exist and behave as the workflow assumes, whether `deploy-pages` needs `contents: read` in a private repository, and the repository's Actions and environment settings (no `gh` access was used).

## 9. Rollback behavior

**Verdict: OK for docs versus workflow (static); Not verifiable for runtime behaviour**

What `docs/pages-demo/deployment.md:93-105` claims, against what `pages.yml` does:

| Claim | What the workflow does | Result |
| --- | --- | --- |
| Reverting a commit on `main` through a reviewed PR redeploys the reverted content (`:97`) | `push` to `main` triggers build then deploy (`pages.yml:13-14`, `:52-56`) | Consistent |
| A manual run on `main` redeploys (`:98`) | `workflow_dispatch` plus the `refs/heads/main` guard (`:16`, `:56`) | Consistent |
| Manual runs on other branches never deploy (`:98`, `:31`) | Guard on `github.ref` (`:56`) | Consistent |
| Re-running an older run redeploys that run's commit; old artifacts may expire (`:98`) | A re-run keeps the original commit and `github.ref`, so it passes the guard; the build job produces a fresh artifact | Consistent; GitHub behaviour not tested |
| Unpublishing the site is a human action in Settings (`:99`) | The workflow has no unpublish step | Consistent |
| No recovery time is guaranteed; caches and copies cannot be recalled; treat leaked data as exposed (`:103-104`) | Nothing in the workflow promises otherwise | Honest |
| The deploy job fails safely until Pages is set to GitHub Actions (`:84`) | `configure-pages` runs without `enablement`, so it cannot enable Pages (`:72`) | Consistent; not run |

Observations:

- **F8 (Finding, low).** A rollback by revert goes through the full build job (`npm test`, drift check, validation) and, if the environment has required reviewers, an approval wait. If CI is broken at that moment (for example a flaky test), the revert cannot deploy; the only escape in the documents is to unpublish. `deployment.md:97-99` does not say this. Proposed fix: add one sentence to the Rollback section saying that a revert deploys only if the build job passes, and that unpublishing is the fast path when it does not.
- GitHub keeps one pending deployment per concurrency group and replaces older pending ones when a newer run is queued; the docs only claim that a deployment in flight is not cancelled (`:39`), which matches `cancel-in-progress: false`. The replacement behaviour was not tested.
- No rollback was executed. There is no way to run the workflow locally (`deployment.md:120` says so as well).

## Non-blocking suggestions (collected)

- S1: before launch, search for a real product called "Notekeep"; rename the sample app if one exists.
- S2: see F6b; widen the validator rules and reword the "host patterns" comments.
- S3: update the "planned" demo-site row in a separate reviewed change after the first real deployment, as `deployment.md:91` already says.
- F2: dot glyphs or legend wording. F3: single tab stop for the 17 dots. F4: describe the disabled Play button. F5: 44 px targets. F7: robust node sizing for large text. F6a: SHA pins. F8: add the "revert needs a passing build" sentence.
- After enabling Pages, set required reviewers and a `main`-only deployment branch rule on the `github-pages` environment, as `deployment.md:85-87` recommends. This audit could not confirm either.

## Command log

All commands ran in the repository root on commit `eb928b8`. Exit codes are those of the command itself.

| # | Command | Exit | Key output |
| --- | --- | --- | --- |
| 1 | `npm test` (`node --test && npm run check`), final run with this report in its final location `docs/pages-demo-audit.md` | 0 | 70 tests, 70 pass, 0 fail; "Checked 51 Markdown files: local links resolve and the skill is self-contained." The report was moved out of `docs/pages-demo/` after a first placement inside it made two pinning tests fail (a file-list test and a forbidden-pattern scan); no test was edited. |
| 2 | `npm run check` (final run) | 0 | same Markdown link check message (51 files, now including this report) |
| 3 | `npm run build:site -- --check` (final run) | 0 | no output; committed `site/` equals a fresh build |
| 4 | `npm run validate:site` (final run) | 0 | "Site validation passed: index.html, styles.css, app.js only; no external references or host/secret patterns." |
| 5 | `grep`/`rg`-style scans for IPv4, absolute paths, credentials, e-mail, issue and runner references (item 2) | 0 or 1 as noted per scan | hits only as listed in item 2 |
| 6 | `git ls-files \| xargs grep -F` for the host name, home directory and OS user name | 0 | host name 0 files, home directory 0 files, OS user name only inside `ubuntu-latest` and `^ubuntu-` |
| 7 | `git log -4 --format=…` and `git branch -a --contains a51d4d0` (item 2, F1) | 0 | two commits with a local-part e-mail equal to the OS user name, present on `origin/rt/18-pi` and `origin/rt/19-pi` |
| 8 | node one-liner: ids, links, aria targets, `data-goto`, JS selectors in `site/index.html` and `site/app.js` | 0 | 48 ids, 0 duplicates, 0 missing targets |
| 9 | node one-liner: headings, landmarks, viewport, button types, tabindex, tables | 0 | 1 `h1`, 41 headings, no skips; 25 buttons all typed |
| 10 | node one-liner: WCAG contrast over the CSS variables, light and dark | 0 | all text and UI pairs pass; one non-applicable pair reported as 1.02 / 1.11 (see item 4) |
| 11 | `PORT=<high port> node scripts/preview-site.mjs` on the loopback address, then `curl` | server stopped afterwards | `/`, `/index.html`, `/styles.css`, `/app.js` 200 with the right types and bodies byte-identical to `site/` (`cmp`); `/nope`, `/../package.json`, `/%2e%2e/package.json`, `/.git/config`, `/app.js%00` 404; `POST` 405; `HEAD` 200; listener bound to loopback only; after `kill`, connection refused |
| 12 | `python3 -c 'import yaml…'` on `.github/workflows/pages.yml` | 0 | parses; triggers, per-job permissions and deploy `if` as in item 8 |
| 13 | `grep -n -E 'pull_request_target\|secrets\.\|…'` over `.github/workflows/*.yml` | 0 | only the `github.event_name` expression at `pages.yml:31` |
| 14 | `node scripts/validate-site.mjs <scratch copy>` with 18 injected mutations (item 8, F6b) | 1 for 11 of 18, 0 for 7 | detected and missed cases listed in F6b; scratch copies deleted |
| 15 | node one-liner: Markdown links and anchors in `docs/pages-demo/*.md` | 0 | 5 links in `deployment.md`, 0 broken |
| 16 | `git status --short` before delivery | 0 | only `docs/pages-demo-audit.md` is new |

## Not verified

- **No real browser, screen reader, keyboard-only session, device or zoom test.** No browser is installed on the audit host. Keyboard operation, focus order, focus rings, the live region, 400 % zoom reflow and the overlap in F7 were established from the source and computed geometry only. The runtime tests use a stub DOM, not a browser DOM.
- **The workflow has never been executed on GitHub.** Its YAML parses and its structure was read, but action availability and versions, the `deploy` and `configure-pages` behaviour, permission sufficiency of `pages: write` plus `id-token: write` for `deploy-pages`, and artifact upload on pull requests are not confirmed.
- **GitHub Pages is not enabled** (and I did not and could not enable it). Repository settings were not read: Pages source, `github-pages` environment protection, deployment branch rules, Actions default permissions, branch protection, fork-PR approval policy, repository visibility.
- **No rollback was exercised**, including revert, manual re-run, and unpublishing. Cache and CDN behaviour after a rollback is not tested.
- The meta Content-Security-Policy was read but not exercised in a browser. GitHub Pages cannot add HTTP headers, so `frame-ancestors` and similar header-only protections are not available; the page has no actions that clickjacking could abuse.
- Whether "Notekeep" collides with a real product name.
- Whether the commits listed in F1 are reachable through public pull-request refs, and whether the repository is public.
- Third-party material, search results and other agents' reports were not used; no `gh` command was run.
