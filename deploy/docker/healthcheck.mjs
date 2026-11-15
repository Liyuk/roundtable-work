// Container healthcheck: exits 0 only when the daemon heartbeat exists, parses and is under 120 s old.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const { writtenAt } = JSON.parse(readFileSync(join(process.cwd(), '.roundtable/state/heartbeat.json'), 'utf8'));
process.exitCode = Date.now() - writtenAt <= 120000 ? 0 : 1;
