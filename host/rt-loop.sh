#!/usr/bin/env bash
# rt-loop: minimal outer wake-up loop for the roundtable-work Chief on pi.
# One active issue at a time; each issue gets its own worktree + branch rt/<n>-pi.
set -uo pipefail
export RT_HOME="$HOME/rt-loop"
REPO="$HOME/roundtable-work"
set -a; . "$HOME/rt-loop/config.env"; set +a   # RT_MODEL lives here
export RT_MODEL
MAXWAKE="${RT_MAXWAKE:-4}"
CHIEF_TMO="${RT_CHIEF_TIMEOUT:-3600}"
WAIT_SLEEP="${RT_WAIT_SLEEP:-300}"
export PATH="$RT_HOME/bin:$PATH"   # gh guard + rt-delegate
LOG="$RT_HOME/logs/loop.log"; STATUS="$RT_HOME/status.tsv"
mkdir -p "$RT_HOME/logs/chief" "$RT_HOME/wt" "$RT_HOME/sessions"
exec 9>"$RT_HOME/lock"; flock -n 9 || { echo "rt-loop already running" >&2; exit 1; }
log(){ echo "$(date '+%F %T %Z') $*" | tee -a "$LOG"; }
setstatus(){ # n state wake detail
  local tmp; tmp=$(mktemp); grep -v "^$1	" "$STATUS" 2>/dev/null >"$tmp"; printf '%s\t%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$(date '+%F %T %Z')" "$4" >>"$tmp"; mv "$tmp" "$STATUS"; }
fp(){ (cd "$1" && git rev-parse HEAD; git status --porcelain; cat .roundtable/state/checkpoint.md 2>/dev/null) | sha1sum | cut -c1-12; }
stopped(){ [ -e "$RT_HOME/STOP" ]; }

log "rt-loop start pid=$$ model=$RT_MODEL"
git -C "$REPO" fetch -q origin
for n in $(grep -E '^[0-9]+' "$RT_HOME/queue.txt"); do
  stopped && { log "STOP file present, exiting"; break; }
  if grep -qE "^$n	(done|ask|stop|error)	" "$STATUS" 2>/dev/null; then log "#$n already finished, skip"; continue; fi
  br="rt/$n-pi"; wt="$RT_HOME/wt/$n"
  if [ ! -d "$wt" ]; then
    if git -C "$REPO" rev-parse -q --verify "refs/remotes/origin/$br" >/dev/null; then
      git -C "$REPO" worktree add -q "$wt" -B "$br" "origin/$br"
    else
      git -C "$REPO" worktree add -q "$wt" -b "$br" origin/main
    fi || { log "#$n worktree add failed"; setstatus "$n" error 0 "worktree add failed"; continue; }
    (cd "$wt" && node scripts/install.mjs --target . --harness codex >/dev/null && sed "s|__MODEL__|$RT_MODEL|g" "$RT_HOME/policy.md" > .roundtable/policy.md && mkdir -p .roundtable/state .roundtable/tickets .roundtable/scratch) \
      || { log "#$n install failed"; setstatus "$n" error 0 "install failed"; continue; }
  fi
  sed "s|__MODEL__|$RT_MODEL|g" "$RT_HOME/policy.md" > "$wt/.roundtable/policy.md"   # refresh policy each run
  noprog=0; final=""
  for wake in $(seq 1 "$MAXWAKE"); do
    stopped && break
    before=$(fp "$wt"); rm -f "$wt/.roundtable/state/DECISION"
    setstatus "$n" running "$wake" "chief wake $wake/$MAXWAKE"
    clog="$RT_HOME/logs/chief/$n-wake$wake-$(date +%Y%m%d-%H%M%S).log"
    prompt=$(sed -e "s|__N__|$n|g" -e "s|__WAKE__|$wake|g" -e "s|__MAXWAKE__|$MAXWAKE|g" -e "s|__TS__|$(date '+%F %T %Z')|g" -e "s|__BRANCH__|$br|g" -e "s|__WT__|$wt|g" -e "s|__MODEL__|$RT_MODEL|g" "$RT_HOME/chief-prompt.md")
    log "#$n wake $wake start log=$clog"
    (cd "$wt" && timeout --kill-after=60 "$CHIEF_TMO" pi -p --model "$RT_MODEL" --session-dir "$RT_HOME/sessions/$n" $( [ "$wake" -gt 1 ] && echo --continue ) "$prompt" </dev/null >"$clog" 2>&1)
    rc=$?
    dec=$(head -1 "$wt/.roundtable/state/DECISION" 2>/dev/null | tr -dc 'a-z')
    why=$(sed -n 2p "$wt/.roundtable/state/DECISION" 2>/dev/null | cut -c1-200)
    after=$(fp "$wt")
    log "#$n wake $wake end rc=$rc decision=${dec:-none} why=${why}"
    [ "$before" = "$after" ] && noprog=$((noprog+1)) || noprog=0
    case "$dec" in
      done|ask|stop) final="$dec"; setstatus "$n" "$dec" "$wake" "$why"; break;;
      wait) sleep "$WAIT_SLEEP";;
      continue) ;;
      *) log "#$n no valid DECISION (rc=$rc)";;
    esac
    if [ "$noprog" -ge 2 ]; then final=stop; setstatus "$n" stop "$wake" "no progress in 2 consecutive wakes (rc=$rc)"; break; fi
  done
  if [ -z "$final" ] && ! stopped; then setstatus "$n" stop "$MAXWAKE" "wake budget exhausted (last decision=${dec:-none})"; fi
  log "#$n finished: $(grep "^$n	" "$STATUS" | cut -f2,5)"
done
log "rt-loop exit"
