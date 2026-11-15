// Per-harness token usage parsers. Pure: string in, `{ inputTokens, cachedInputTokens, outputTokens }` or null out.
// Choice: usage is summed over every reporting event, because each codex `turn.completed` and each pi assistant
// `message_end` carries that turn's own usage, not a running total.
// Non-JSON lines are skipped: harness stdout is external data and may mix plain text with JSON events.

const jsonEvents = (output) => String(output).split('\n').flatMap((line) => {
  try { return [JSON.parse(line)]; } catch { return []; }
});

const sumUsage = (usages, fields) => usages.reduce((sum, u) => ({
  inputTokens: sum.inputTokens + (u[fields.input] ?? 0),
  cachedInputTokens: sum.cachedInputTokens + (u[fields.cached] ?? 0),
  outputTokens: sum.outputTokens + (u[fields.output] ?? 0),
}), { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 });

// codex exec --json: `{"type":"turn.completed","usage":{"input_tokens","cached_input_tokens","output_tokens"}}`
function parseCodex(output) {
  const usages = jsonEvents(output).filter((e) => e?.type === 'turn.completed' && e.usage).map((e) => e.usage);
  return usages.length ? sumUsage(usages, { input: 'input_tokens', cached: 'cached_input_tokens', output: 'output_tokens' }) : null;
}

// pi --mode json: `{"type":"message_end","message":{"role":"assistant","usage":{"input","output","cacheRead"}}}`
function parsePi(output) {
  const usages = jsonEvents(output)
    .filter((e) => e?.type === 'message_end' && e.message?.role === 'assistant' && e.message.usage)
    .map((e) => e.message.usage);
  return usages.length ? sumUsage(usages, { input: 'input', cached: 'cacheRead', output: 'output' }) : null;
}

const PARSERS = Object.freeze({ codex: parseCodex, pi: parsePi });

/** Usage for one call's stdout, or null when the harness reported none (or has no parser, e.g. host-agent). */
export function parseUsage(harness, output) {
  return Object.hasOwn(PARSERS, harness) ? PARSERS[harness](output) : null;
}
