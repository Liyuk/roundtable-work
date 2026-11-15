// Reference operator handler. A starting point for an operator, not a live implementer: it runs no work and
// reports every phase as failed, so nothing is recorded as done. Replace `default` with a real handler before a live run.

/** Runs one phase; the reference has no implementer configured, so the phase fails. */
export default async function handler() {
  return { exitCode: 1, output: 'reference handler: no implementer configured' };
}

/** Pre-dispatch preflight required by rtd.mjs; the reference allows dispatch and leaves the work to `handler`. */
export async function preDispatch() {
  return { ok: true };
}
