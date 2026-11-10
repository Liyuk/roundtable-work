import { spawnSync } from 'node:child_process';

const commands = [
  ['node', process.execPath, ['--version']],
  ['git', 'git', ['--version']],
  ['dsh', 'dsh', ['--version']],
  ['pi', 'pi', ['--version']],
  ['codex', 'codex', ['--version']],
];
const hosts = commands.map(([name, command, args]) => {
  const run = spawnSync(command, args, { encoding: 'utf8', timeout: 5000, maxBuffer: 65536, windowsHide: true });
  const available = run.status === 0;
  return { name, available, version: available ? (run.stdout || '').trim().split('\n')[0].slice(0, 200) : null };
});
const report = { schemaVersion: 1, hosts, backgroundWakeup: 'unverified', persistentDelegation: 'unverified', modelAuthentication: 'not-checked' };
if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
else {
  console.log('Roundtable Work — read-only environment check');
  for (const host of hosts) console.log(`${host.name}: ${host.available ? host.version || 'available' : 'not available'}`);
  console.log('Background wake-up and persistent delegation: not verified.');
  console.log('Model authentication: not checked. This does not install or start a team.');
}
