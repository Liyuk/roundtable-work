#!/usr/bin/env bash
# Compact health check for rt-loop v2 (scheduler + parallel workers)
H="${RT_HOME:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
. "$H/config.env" 2>/dev/null
REPO="${RT_REPO:-Liyuk/roundtable-work}"
short(){ sed "s|$HOME|~|g"; }
now=$(date +%s)

# heartbeat (real one wins; a dry-run heartbeat is shown with the DRY flag)
hb="$H/state/heartbeat"; dry=no
if [ ! -f "$hb" ] || { [ -f "$H/state/heartbeat.dry" ] && [ "$H/state/heartbeat.dry" -nt "$hb" ]; }; then [ -f "$H/state/heartbeat.dry" ] && { hb="$H/state/heartbeat.dry"; dry=yes; }; fi
hbval(){ sed -n "s/^$1=//p" "$hb" 2>/dev/null | head -1; }
if [ -f "$hb" ]; then
  ep=$(hbval epoch); age=$(( now - ${ep:-0} )); [ "$(hbval dry)" = 1 ] && dry=yes
  hbtxt="${age}s ago (poll=${RT_POLL:-300}s)"; [ "$age" -gt $(( ${RT_POLL:-300} * 2 + 60 )) ] && hbtxt="$hbtxt STALE"
else hbtxt="none"; fi
spid=-; if [ -e "$H/state/sched.lock" ] && ! flock -n "$H/state/sched.lock" true 2>/dev/null; then spid=$(cat "$H/state/sched.lock" 2>/dev/null); fi   # lock held => scheduler alive
tm=$(for s in rt-sched rt-loop; do tmux has-session -t "$s" 2>/dev/null && echo "$s"; done | head -1)
printf 'now: %s | heartbeat: %s | sched-pid: %s | tmux: %s | STOP: %s | DRY: %s\n' "$(date '+%F %T %Z')" "$hbtxt" "$spid" "${tm:-down}" "$([ -e "$H/STOP" ] && echo yes || echo no)" "$dry"

[ -e "$H/state/main_red" ] && echo "!!! main CI is RED (new claims and merges paused): $(cut -d' ' -f1 "$H/state/main_red" | cut -c1-7)"
echo "--- workers running (n slot wake pid)"
found=0
for lk in "$H"/locks/*.lock; do
  [ -e "$lk" ] || continue; n=$(basename "$lk" .lock)
  if ! flock -n "$lk" true 2>/dev/null; then
    read -r pid slot < "$H/locks/$n.info" 2>/dev/null
    wake=$(awk -F'\t' -v n="$n" '$1==n{print $3}' "$H/status.tsv" 2>/dev/null)
    printf '#%s slot=%s wake=%s pid=%s\n' "$n" "${slot:-?}" "${wake:-?}" "${pid:-?}"; found=1
  fi
done
[ "$found" = 0 ] && echo "(none)"

echo "--- last merges (ts pr issue merge-sha)"; tail -n 3 "$H/state/merges.log" 2>/dev/null | cut -f1-4 | short; echo "--- last sched.log"; tail -n 6 "$H/logs/sched.log" 2>/dev/null | short
echo "--- status.tsv (n state wake updated detail)"; column -t -s $'\t' "$H/status.tsv" 2>/dev/null | cut -c1-170 | short
if [ "$(grep -m1 '^RT_HARNESS=' "$H/config.env" | cut -d= -f2 | awk '{print $1}')" = codex ]; then
  S=$(ls -t "$H"/logs/chief/*.log 2>/dev/null | head -1)
  [ -n "$S" ] && { echo "--- latest chief answer (codex, $(basename "$S"))"; tail -n 5 "$S" | short; }
else
S=$(ls -t "$H"/sessions/*/*.jsonl 2>/dev/null | head -1)
[ -n "$S" ] && [ -f "$H/trace.py" ] && { echo "--- latest chief trace (#$(basename "$(dirname "$S")"), times UTC)"; python3 "$H/trace.py" "$S" 3 | short; }
fi

echo "--- open issues by rt:* label"
"${RT_GH_REAL:-gh}" issue list -R "$REPO" --state open -L 200 --json number,labels --jq '
  [.[] | . as $i | .labels[] | select(.name|startswith("rt:")) | {l:.name, n:$i.number}]
  | group_by(.l)[] | "\(.[0].l): " + (map("#\(.n)") | join(" "))' 2>/dev/null || echo "(gh unavailable)"

echo "--- open rt/* PRs (number branch labels)"
"${RT_GH_REAL:-gh}" pr list -R "$REPO" --state open --json number,headRefName,isDraft,labels --jq '
  .[] | select(.headRefName|startswith("rt/")) | "#\(.number) \(.headRefName)\(if .isDraft then " [draft]" else "" end) [\(.labels|map(.name)|join(","))]"' 2>/dev/null || echo "(gh unavailable)"
