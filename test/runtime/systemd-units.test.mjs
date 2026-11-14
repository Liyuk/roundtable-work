import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const units = {
  daemon: new URL('../../deploy/systemd/rtd.service', import.meta.url),
  supervisor: new URL('../../deploy/systemd/rt-supervisor.service', import.meta.url),
};

const read = (name) => readFileSync(units[name], 'utf8');

test('both systemd unit templates exist', () => {
  assert.ok(existsSync(units.daemon));
  assert.ok(existsSync(units.supervisor));
});

test('daemon unit is a restartable service template with Unit and Service sections', () => {
  const unit = read('daemon');
  assert.match(unit, /^\[Unit\]$/m);
  assert.match(unit, /^\[Service\]$/m);
  assert.match(unit, /^Restart=on-failure$/m);
  assert.match(unit, /^ExecStart=\/usr\/bin\/env node <workspace>\/runtime\/rtd\.mjs --work-root /m);
  assert.match(unit, /^WorkingDirectory=<workspace>$/m);
  assert.match(unit, /^User=<daemon-user>$/m);
  assert.match(unit, /^EnvironmentFile=-<env-file>$/m);
});

test('unit templates carry no secrets, host paths, addresses or install section', () => {
  for (const name of Object.keys(units)) {
    const unit = read(name);
    const body = unit.replace(/^#.*$/gm, ''); // comments may name secrets; values may not
    assert.doesNotMatch(body, /token|secret|password|=ghp_/i, `${name} has a secret-looking value`);
    assert.doesNotMatch(body, /[A-Za-z0-9+/_-]{32,}/, `${name} has a long random string`);
    assert.doesNotMatch(unit, /\/home\/|\/root\/|\/Users\//, `${name} has a host path`);
    assert.doesNotMatch(unit, /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/, `${name} has an IPv4 literal`);
    assert.doesNotMatch(unit, /\[Install\]/, `${name} must not have an [Install] section`);
    for (const placeholder of unit.match(/<[^>]*>/g) ?? []) assert.match(placeholder, /^<[a-z-]+>$/);
  }
});

test('systemd-analyze verify parses both templates (skipped when not installed)', (t) => {
  if (spawnSync('which', ['systemd-analyze']).status !== 0) {
    t.skip('systemd-analyze not installed');
    return;
  }
  // `--user` avoids the system manager (/run/systemd is not writable in sandboxes). Templates use
  // placeholder users and paths, so verify reports those as "not absolute: <workspace>" or
  // "does not match strict user/group name rules". Every file:line diagnostic must point at a
  // <placeholder>; any other diagnostic is a real parse/config error and fails the test.
  for (const name of Object.keys(units)) {
    const r = spawnSync('systemd-analyze', ['--user', 'verify', units[name].pathname], { encoding: 'utf8' });
    const out = `${r.stdout}${r.stderr}`;
    console.log(`systemd-analyze --user verify ${name}: exit=${r.status}\n${out}`);
    assert.doesNotMatch(out, /Failed to create directory/, `${name}: systemd-analyze did not run`);
    for (const line of out.split('\n').filter((l) => /:\d+: /.test(l))) {
      assert.match(line, /<[a-z-]+>/, `${name} has a non-placeholder diagnostic: ${line}`);
    }
  }
});
