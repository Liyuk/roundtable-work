// rt-bench source readers (docs/autonomy-benchmark.md sections 2 and 9). Pure: the caller passes the ledger text;
// no fs, no clock, no network.
//
// Row layouts (one row per line, tab-separated, blank lines ignored). The docs name the files but not their
// columns, so these are the layouts this module defines:
//   interventions.tsv: <timestamp>\t<category>\t<ref>[\t<reason>]   timestamp is US Pacific (America/Los_Angeles)
//   merges.log:        <timestamp> CST\t<ref>[\t<detail>]           marker CST or UTC+8 means UTC+8
// timestamp is "YYYY-MM-DD", or "YYYY-MM-DD HH:MM" / "YYYY-MM-DDTHH:MM", optionally with ":SS".
// A date-only timestamp is anchored at 23:59:59 in its zone (rt-metrics convention).
// Rows that do not match their layout, or name no such calendar instant, are counted in `malformed`; never converted.
//
// Every event is { at (UTC ISO), kind, ref, raw }. `lastSeen` is the latest `at` of the parsed rows (null if none).

const WALL = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/;
const MERGE_STAMP = /^(.+) (?:CST|UTC\+8)$/;
const UTC8_OFFSET_MS = 8 * 60 * 60 * 1000;
const pacific = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles', hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
});

// Offset of America/Los_Angeles at the whole-second instant `ms`, in ms east of UTC.
function pacificOffset(ms) {
  const p = Object.fromEntries(pacific.formatToParts(ms).map((part) => [part.type, Number(part.value)]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - ms;
}

// Wall-clock text in a zone with the given offset function -> UTC ISO string, or null if malformed.
export function instant(text, offsetAt) {
  const m = WALL.exec(text);
  if (!m) return null;
  const [y, mo, d] = m.slice(1, 4).map(Number);
  const [h, mi, s] = m[4] === undefined ? [23, 59, 59] : [m[4], m[5], m[6] ?? '0'].map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  const check = new Date(wall);
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d || check.getUTCHours() !== h || check.getUTCMinutes() !== mi || check.getUTCSeconds() !== s) return null;
  return new Date(wall - offsetAt(wall - offsetAt(wall))).toISOString();
}

export function readRows(text, parse) {
  const events = [];
  let malformed = 0;
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue;
    const event = parse(raw);
    if (event) events.push({ ...event, raw });
    else malformed += 1;
  }
  return { events, malformed, lastSeen: events.map((e) => e.at).sort().at(-1) ?? null };
}

export function readInterventions(text) {
  return readRows(text, (raw) => {
    const [stamp, kind, ref] = raw.split('\t');
    const at = instant(stamp, pacificOffset);
    return at && kind && ref ? { at, kind, ref } : null;
  });
}

export function readMerges(text) {
  return readRows(text, (raw) => {
    const [stamp, ref] = raw.split('\t');
    const m = MERGE_STAMP.exec(stamp);
    const at = m && instant(m[1], () => UTC8_OFFSET_MS);
    return at && ref ? { at, kind: 'merge', ref } : null;
  });
}
