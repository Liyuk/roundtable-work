#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { openInterventions } from '../runtime/lib/interventions.mjs';

const option = { type: 'string' };
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    workspace: option, category: option, ref: option, reason: option, internalized: option,
    source: option, key: option, tsv: option, json: { type: 'boolean' },
  },
});

try {
  const [command] = positionals;
  const ledger = openInterventions(values.workspace);
  if (command === 'add') {
    const at = new Date().toISOString();
    const { category, ref, reason, internalized, source } = values;
    const { id } = ledger.append({ at, category, ref, reason, internalized, source }, { key: values.key ?? at });
    console.log(JSON.stringify({ id }));
  } else if (command === 'list') {
    console.log(JSON.stringify(ledger.entries().entries));
  } else if (command === 'import') {
    const rows = readFileSync(values.tsv, 'utf8').replace(/\r/g, '').split('\n').slice(1).filter(line => line !== '');
    let added = 0;
    for (const row of rows) {
      const [time, category, ref, reason, internalized] = row.split('\t');
      if (ledger.append({ at: time, category, ref, reason, internalized, source: 'external' }, { key: time }).added) added++;
    }
    console.log(JSON.stringify({ added }));
  } else {
    throw new TypeError('usage: rt-intervention.mjs add|list|import --workspace DIR ...');
  }
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}
