/**
 * Verifier-role acceptance primitives. Pure: no filesystem, network or shell access.
 */

const nonEmpty = value => typeof value === 'string' && value.length > 0;

/** Verifier input: only the original acceptance criteria and a live artifact reference. */
export function verifierInput({ acceptanceCriteria, artifact }) {
  if (!Array.isArray(acceptanceCriteria) || acceptanceCriteria.length === 0 || !acceptanceCriteria.every(nonEmpty)) {
    throw new TypeError('acceptanceCriteria must be a non-empty array of non-empty strings');
  }
  if (!nonEmpty(artifact)) throw new TypeError('artifact must be a non-empty string');
  return { acceptanceCriteria, artifact };
}

/** The verifier must run in a session distinct from the developer's. */
export function assertIndependentVerifier({ developerSession, verifierSession }) {
  if (!nonEmpty(developerSession) || !nonEmpty(verifierSession)) {
    throw new TypeError('developerSession and verifierSession must be non-empty');
  }
  if (developerSession === verifierSession) throw new TypeError('verifier must not reuse the developer session');
}

/** Only a `pass` verdict with non-empty evidence accepts; `inconclusive` is never a pass. */
export function acceptanceOutcome({ verdict, evidence }) {
  const proven = Array.isArray(evidence) && evidence.length > 0 && evidence.every(nonEmpty);
  return verdict === 'pass' && proven ? 'accepted' : 'not-accepted';
}

/** Sequential default: a non-accepted outcome is fixed first, then verified again on the new artifact. */
export function nextAfterVerification(outcome) {
  return outcome === 'accepted' ? { action: 'accept' } : { action: 'fix', then: 'verify' };
}
