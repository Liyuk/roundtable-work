export const RT_COMMANDS = Object.freeze(['pause', 'resume', 'requeue', 'status']);

/** Text comes from GitHub comments (untrusted): only exactly `/rt <word>` with a listed word is accepted. Never throws. */
export function parseRtCommand(text) {
  const word = typeof text === 'string' ? text.trim().match(/^\/rt (\S+)$/)?.[1] : undefined;
  if (word === undefined) return { ok: false, reason: 'expected exactly "/rt <command>"' };
  if (word === 'merge') return { ok: false, reason: 'merge is not accepted from /rt' };
  if (!RT_COMMANDS.includes(word)) return { ok: false, reason: `unknown /rt command: ${word}` };
  return { ok: true, command: word };
}
