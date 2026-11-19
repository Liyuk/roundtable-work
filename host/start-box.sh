#!/usr/bin/env bash
# Start the rt-loop scheduler on this host in a detached tmux session (RT_SESSION; default rt-loop, or rt-loop-<instance dir> for other instances).
H="$(cd "$(dirname "$0")" && pwd)"
B="$(basename "${RT_HOME:-$H}")"
[ "$B" = rt-loop ] && D=rt-loop || D="rt-loop-${B//[^A-Za-z0-9_-]/_}"
S="${RT_SESSION:-$D}"
tmux has-session -t "$S" 2>/dev/null && { echo "rt-loop already running"; exit 0; }
# every role must have a model in config.env (single routing source); refuse to start otherwise
RT_HOME="$H" "$H/bin/rt-agent" --check || { echo "rt-loop not started: fix the role models in config.env" >&2; exit 2; }
tmux new-session -d -s "$S" "export TZ=Asia/Shanghai RT_HOME=\"$H\" RT_GH_REAL=/usr/local/bin/gh PI_CODING_AGENT_DIR=\"$H/.pi-agent\" PATH=\"$H/bin:\$PATH\"; cd \"$H\"; exec ./rt-sched.py >> logs/sched-console.log 2>&1"
