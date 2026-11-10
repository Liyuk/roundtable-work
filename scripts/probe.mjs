export function classifyProbeResult(run, timeoutMs = 5000) {
  if (run.status === 0) return { status: 'ok', available: true, reason: null };
  if (run.error?.code === 'ENOENT') return { status: 'not-found', available: false, reason: 'not found on PATH' };
  if (run.error?.code === 'ETIMEDOUT') return { status: 'timeout', available: false, reason: `timed out after ${timeoutMs / 1000}s` };
  if (run.error) return { status: 'failed', available: false, reason: `could not run: ${run.error.code || run.error.message}` };
  return {
    status: 'failed',
    available: false,
    reason: run.signal ? `killed by ${run.signal}` : `exited with code ${run.status}`,
  };
}
