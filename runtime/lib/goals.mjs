import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const GOALS_PATH = fileURLToPath(new URL('../goals.json', import.meta.url));
const LEVELS = ['external', 'partial', 'self'];
const CAPABILITY_KEYS = ['L', 'H', 'R', 'D', 'M', 'B', 'S', 'O'];

// Leaves: { type: 'int' | 'num', min, max, gt } or { type: 'enum', values }. Objects: { fields }.
const num = (min, extra = {}) => ({ type: 'num', min, ...extra });
const int = (min, extra = {}) => ({ type: 'int', min, ...extra });
const obj = (fields) => ({ fields });

const SCHEMA = obj({
  version: int(1, { max: 1 }),
  northStar: obj({ metric: { type: 'enum', values: ['mtbiHours'] }, target: num(0, { gt: 0 }) }),
  capabilities: obj(Object.fromEntries(CAPABILITY_KEYS.map((key) => [key, { type: 'enum', values: LEVELS }]))),
  metrics: obj({ windowDays: int(0), mtbiHoursMin: num(0, { gt: 0 }), firstPassRateMin: num(0, { max: 1 }), ownerPullInsPerWeekMax: num(0) }),
  selfReview: obj({
    cadenceHours: num(0), maxPerDay: int(0), maxOpen: int(0), hostPatchMaxAgeDays: int(0),
    failureRepeat: obj({ count: int(0), days: int(0) }),
  }),
  reporting: obj({ digestIssue: int(0), digestHourUtc: int(0, { max: 23 }) }),
  exit: obj({ windowHours: int(0), minMergedPrs: int(0), minSelfSourcedCompleted: int(0) }),
});

// Error messages name only the dotted key path, never the file content.
function check(value, spec, path) {
  const bad = () => { throw new Error(`Goal file key is invalid: ${path}`); };
  if (spec.fields) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) bad();
    for (const [key, child] of Object.entries(spec.fields)) check(value[key], child, path ? `${path}.${key}` : key);
    for (const key of Object.keys(value)) if (!(key in spec.fields)) throw new Error(`Goal file key is invalid: ${path ? `${path}.${key}` : key}`);
  } else if (spec.type === 'enum') {
    if (!spec.values.includes(value)) bad();
  } else {
    if (!Number.isFinite(value) || (spec.type === 'int' && !Number.isInteger(value))) bad();
    if (value < spec.min || (spec.max !== undefined && value > spec.max) || (spec.gt !== undefined && value <= spec.gt)) bad();
  }
}

/** Reads and validates the goal file. Unknown keys and out-of-range values are rejected at every level. */
export async function loadGoals(path = GOALS_PATH) {
  const goals = JSON.parse(await readFile(path, 'utf8'));
  check(goals, SCHEMA, '');
  return goals;
}
