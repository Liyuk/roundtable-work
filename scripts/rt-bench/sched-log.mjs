// rt-bench scheduler log reader (docs/autonomy-benchmark.md sections 3-4; line formats of host/rt-sched.py). Pure: text in, events out.
// Line: `YYYY-MM-DD HH:MM:SS <ZONE> <message>`, ZONE CST or UTC+8 (UTC+8), PST (fixed UTC-8: the doc's November figures; DST is not applied), or UTC.
// Events (same row handling as sources.mjs; `raw` kept, `lastSeen` = latest event instant):
//   start  { pid, by }     live starts only (dry=False once=False); the first is by 'first', later ones by 'manual'
//   gap    { at, resumedAt, seconds }   at = line time minus N s; resumedAt = line time
//   spawn  { worker, slot }
//   stage  { worker, rc, finalState }   from `worker #N exited rc=X [state=Y]`; finalState null when absent
//   other  {}              any other message with a valid prefix (kept for lastSeen, not counted)
// A line whose prefix does not parse is malformed and is counted, never guessed.
import { instant, readRows } from './sources.mjs';

const HOUR = 60 * 60 * 1000;
const OFFSET = { CST: 8, 'UTC+8': 8, PST: -8, UTC: 0 };
const LINE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) (CST|UTC\+8|PST|UTC) (.*)$/;

function parseLine(raw) {
  const m = LINE.exec(raw);
  const at = m && instant(m[1], () => OFFSET[m[2]] * HOUR);
  if (!at) return null;
  const msg = m[3];
  const start = /^rt-sched start pid=(\d+) dry=(\w+) once=(\w+)/.exec(msg);
  const gap = /^WARN scheduler cycle gap (\d+)s/.exec(msg);
  const spawn = /^spawned worker #(\d+) slot=(\d+)/.exec(msg);
  const exit = /^worker #(\d+) exited rc=(-?\d+)(?: state=(\S+))?/.exec(msg);
  if (start) return start[2] === 'False' && start[3] === 'False' ? { at, kind: 'start', pid: Number(start[1]) } : { at, kind: 'other' };
  if (gap) return { at: new Date(Date.parse(at) - gap[1] * 1000).toISOString(), kind: 'gap', resumedAt: at, seconds: Number(gap[1]) };
  if (spawn) return { at, kind: 'spawn', worker: Number(spawn[1]), slot: Number(spawn[2]) };
  if (exit) return { at, kind: 'stage', worker: Number(exit[1]), rc: Number(exit[2]), finalState: exit[3] ?? null };
  return { at, kind: 'other' };
}

export function readSchedLog(text) {
  const parsed = readRows(text, parseLine);
  parsed.events.filter((e) => e.kind === 'start').forEach((e, i) => {
    e.by = i === 0 ? 'first' : 'manual';
  });
  return parsed;
}
