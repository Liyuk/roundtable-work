import test from 'node:test';
import assert from 'node:assert/strict';
import { parseUsage } from '../../runtime/lib/usage-parse.mjs';

const jsonl = (...events) => events.map((e) => JSON.stringify(e)).join('\n');

test('codex: turn.completed usage is summed across turns', () => {
  const output = jsonl(
    { type: 'thread.started', thread_id: 't1' },
    { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 7 } },
    { type: 'item.completed', item: { type: 'agent_message', text: 'hi' } },
    { type: 'turn.completed', usage: { input_tokens: 50, cached_input_tokens: 0, output_tokens: 3 } },
  );
  assert.deepEqual(parseUsage('codex', output), { inputTokens: 150, cachedInputTokens: 40, outputTokens: 10 });
});

test('codex: a fixture without usage returns null', () => {
  assert.equal(parseUsage('codex', jsonl({ type: 'thread.started', thread_id: 't1' }, { type: 'turn.failed' })), null);
});

test('pi: assistant message_end usage is summed; cacheRead maps to cachedInputTokens', () => {
  const output = jsonl(
    { type: 'message_end', message: { role: 'assistant', usage: { input: 120, output: 9, cacheRead: 30, cacheWrite: 0, totalTokens: 159 } } },
    { type: 'message_end', message: { role: 'assistant', usage: { input: 5, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 6 } } },
  );
  assert.deepEqual(parseUsage('pi', output), { inputTokens: 125, cachedInputTokens: 30, outputTokens: 10 });
});

test('pi: plain text output without usage returns null', () => {
  assert.equal(parseUsage('pi', 'Hello from pi\nno json here'), null);
  assert.equal(parseUsage('pi', jsonl({ type: 'message_end', message: { role: 'user' } })), null);
});

test('unknown harness returns null', () => {
  assert.equal(parseUsage('host-agent', jsonl({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } })), null);
});
