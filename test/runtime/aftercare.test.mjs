import test from 'node:test';
import assert from 'node:assert/strict';
import { createAftercareRecorder } from '../../runtime/lib/aftercare.mjs';

function fixture() {
  const calls = [];
  let record;
  let pr = { state: 'open', merged: false, headSha: 'head-a', baseSha: 'base-a' };
  let comments = [];
  let conclusion = 'success';
  let comparison = { ahead: 1, behind: 0 };
  const client = {
    async getPullRequest() { calls.push('pr'); return pr; },
    async listComments({ after }) { calls.push(['comments', after]); return comments; },
    async getRequiredChecks({ headSha }) { calls.push(['checks', headSha]); return { conclusion }; },
    async compare(args) { calls.push(['compare', args]); return comparison; },
  };
  const store = {
    async load() { calls.push('load'); return record; },
    async save(value) { calls.push('save'); record = structuredClone(value); },
  };
  return {
    calls, client, store,
    set pr(value) { pr = value; }, set comments(value) { comments = value; },
    set conclusion(value) { conclusion = value; }, set comparison(value) { comparison = value; },
    get record() { return record; }, get pr() { return pr; },
  };
}

test('disabled recorder performs no GitHub or local persistence calls', async () => {
  const f = fixture();
  const result = await createAftercareRecorder({ enabled: false, client: f.client, store: f.store }).poll();
  assert.deepEqual(result, { enabled: false, record: null, events: [] });
  assert.deepEqual(f.calls, []);
});

test('comment cursor and later same-head CI failure are each recorded once without body persistence', async () => {
  const f = fixture();
  f.comments = [{ id: 17, body: 'private review text', user: { login: 'reviewer-private' } }];
  const recorder = createAftercareRecorder({ enabled: true, client: f.client, store: f.store });
  const first = await recorder.poll();
  assert.deepEqual(first.events.map((event) => event.type), ['new_comment', 'ci_success']);
  assert.equal(f.record.commentCursor, '17');
  assert.equal(f.record.requiredCheck.headSha, 'head-a');
  assert.equal(f.record.requiredCheck.conclusion, 'success');
  assert.doesNotMatch(JSON.stringify(f.record), /private review text|reviewer-private/);

  f.conclusion = 'failure';
  const second = await recorder.poll();
  assert.deepEqual(second.events.map((event) => event.type), ['ci_failure']);
  assert.equal(second.record.suggestedAction, 'inspect_ci_failure');
  const third = await recorder.poll();
  assert.deepEqual(third.events, []);
  assert.equal(f.record.seenCheckCursors.filter((cursor) => cursor === 'head-a:failure').length, 1);
  assert.equal(f.calls.filter((call) => Array.isArray(call) && call[0] === 'comments').length, 3);
});

test('base movement and behind state are classified and persisted', async () => {
  const f = fixture();
  const recorder = createAftercareRecorder({ enabled: true, client: f.client, store: f.store });
  await recorder.poll();
  f.pr = { ...f.pr, baseSha: 'base-b' };
  f.comparison = { ahead: 2, behind: 3 };
  const result = await recorder.poll();
  assert.deepEqual(result.events.map((event) => event.type), ['base_moved', 'branch_behind']);
  assert.deepEqual([result.record.baseSha, result.record.ahead, result.record.behind], ['base-b', 2, 3]);
});

test('merged and closed pull requests emit terminal state once and stop subsequent polling', async () => {
  for (const [pr, expected] of [
    [{ state: 'closed', merged: true, headSha: 'h', baseSha: 'b' }, 'merged'],
    [{ state: 'closed', merged: false, headSha: 'h', baseSha: 'b' }, 'closed'],
  ]) {
    const f = fixture();
    const recorder = createAftercareRecorder({ enabled: true, client: f.client, store: f.store });
    await recorder.poll();
    f.pr = pr;
    const result = await recorder.poll();
    assert.ok(result.events.some((event) => event.type === expected));
    const before = f.calls.length;
    assert.deepEqual((await recorder.poll()).events, []);
    assert.equal(f.calls.length, before + 1, 'terminal record only loads from local storage');
  }
});
