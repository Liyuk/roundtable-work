// Breaking-commit detection for a red main. Pure: the history comes only from the `history` argument.
// findBreakingCommit(history) -> sha | null
//   history: [{ sha, state: 'green'|'red'|'pending' }] newest-first.
//   Returns the first red commit after the last green one (the oldest red of the run that starts after it).
//   Pending entries are skipped. Without a green commit in the history the breaking commit is unprovable: null.
export function findBreakingCommit(history) {
  let breaking = null;
  for (const { sha, state } of history) {
    if (state === 'green') return breaking;
    if (state === 'red') breaking = sha;
  }
  return null;
}
