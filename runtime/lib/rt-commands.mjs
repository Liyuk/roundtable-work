export const RT_COMMANDS = Object.freeze(['pause', 'resume', 'requeue', 'status']);
export const ACTION_COMMANDS = Object.freeze(['confirm', 'rollback', 'amend']);

/** Text comes from GitHub comments (untrusted): only the listed shapes are accepted. Never throws. */
export function parseRtCommand(text) {
  const m = typeof text === 'string' ? text.trim().match(/^\/rt (\S+)(?: (\S+)(?: ([\s\S]+))?)?$/) : null;
  if (!m) return { ok: false, reason: 'expected exactly "/rt <command>"' };
  const [, word, actionId, body] = m;
  if (word === 'merge') return { ok: false, reason: 'merge is not accepted from /rt' };
  if (RT_COMMANDS.includes(word) && actionId === undefined) return { ok: true, command: word };
  if (['confirm', 'rollback'].includes(word) && actionId !== undefined && body === undefined) return { ok: true, command: word, actionId };
  if (word === 'amend' && body !== undefined) return { ok: true, command: word, actionId, text: body };
  if (RT_COMMANDS.includes(word) || ACTION_COMMANDS.includes(word)) return { ok: false, reason: `wrong arguments for /rt ${word}` };
  return { ok: false, reason: `unknown /rt command: ${word}` };
}
