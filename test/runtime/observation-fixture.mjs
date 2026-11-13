import { runQueue as runRuntimeQueue } from '../../runtime/rtd.mjs';
export { exitCodeFor, EXIT_LOCKED, EXIT_LOCK_LOST } from '../../runtime/rtd.mjs';

// Legacy runtime scenarios use a consistent, injected read-only observation by default.
export function observationFixture() {
  let sha = 'a'.repeat(40);
  return {
    expectedSha({ expectedSha }) { sha = expectedSha ?? sha; return sha; },
    issue: { async get() { return { state: 'open', labels: ['rt:running'] }; } },
    worktree: { async inspect() { return { dirty: false }; } },
    git: { async head() { return sha; }, async commit() { return { sha }; } },
    evidence: { async checks() { return { sha, conclusion: 'success' }; }, async review() { return { sha, conclusion: 'approved' }; } },
  };
}
export function runQueue(options) {
  return runRuntimeQueue({ ...options, observationClients: options.observationClients ?? options.autoMerge?.observationClients ?? observationFixture() });
}
