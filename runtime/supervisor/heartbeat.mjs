// Heartbeat schema, writer and parser. Pure: the caller supplies the write function and the file text.
// Timestamps are epoch milliseconds. Path is relative to the workspace root.
export const HEARTBEAT_PATH = '.roundtable/state/heartbeat.json';
export const SCHEMA_VERSION = 1;
export const DAEMON_STATES = Object.freeze(['running', 'stopping', 'stopped']);
export const FRONT_CHIEF_STATES = Object.freeze(['active', 'idle', 'gone']);
export const PROGRESS_KINDS = Object.freeze(['commit', 'verdict', 'pr']);

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const isObject = (value) => typeof value === 'object' && value !== null;

/** Returns the first schema problem as a string, or null when the heartbeat is valid. */
export function schemaProblem(hb) {
  if (!isObject(hb)) return 'not an object';
  if (hb.schemaVersion !== SCHEMA_VERSION) return 'schemaVersion';
  if (!isNumber(hb.writtenAt)) return 'writtenAt';
  if (!isObject(hb.daemon) || !Number.isInteger(hb.daemon.pid) || !isNumber(hb.daemon.lastCycleAt)
    || !DAEMON_STATES.includes(hb.daemon.state)) return 'daemon';
  if (!isObject(hb.frontChief) || typeof hb.frontChief.session !== 'string' || !isNumber(hb.frontChief.lastTurnAt)
    || !FRONT_CHIEF_STATES.includes(hb.frontChief.state)) return 'frontChief';
  const progress = hb.lastMaterialProgress;
  if (progress !== null && (!isObject(progress) || !PROGRESS_KINDS.includes(progress.kind)
    || !isNumber(progress.at) || typeof progress.ref !== 'string')) return 'lastMaterialProgress';
  return null;
}

/** Parses heartbeat file text. Never throws: returns { ok: true, value } or { ok: false, reason, ... }. */
export function parseHeartbeat(text) {
  if (text === undefined || text === null) return { ok: false, reason: 'missing' };
  let value;
  try { value = JSON.parse(text); }
  catch (error) { return { ok: false, reason: 'malformed', error: error.message }; }
  const problem = schemaProblem(value);
  return problem === null ? { ok: true, value } : { ok: false, reason: 'invalid-schema', field: problem };
}

/** Validates then writes the heartbeat through the injected write(file, content) function. */
export function writeHeartbeat(hb, { write }) {
  const problem = schemaProblem(hb);
  if (problem !== null) throw new Error(`invalid heartbeat: ${problem}`);
  write(HEARTBEAT_PATH, `${JSON.stringify(hb, null, 2)}\n`);
}
