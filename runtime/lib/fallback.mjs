const isBalanceError = (error) => error?.status === 402 || error?.statusCode === 402;

/**
 * Route calls by role. A balance error (HTTP 402) on a role's primary model switches every role
 * sharing that harness to the configured fallback model until `now() + ttlMs`, and re-runs the
 * failed call once on the fallback. Other errors propagate unchanged.
 * `routes`: role -> { harness, model }; `fallback`: harness -> model.
 */
export function createFallbackRouter({ routes, fallback, ttlMs, now }) {
  for (const { harness } of Object.values(routes)) {
    if (typeof fallback?.[harness] !== 'string' || fallback[harness].trim() === '') {
      throw new TypeError(`a fallback model must be configured for harness "${harness}"`);
    }
  }
  const switchedUntil = new Map();

  return async function call(role, invoke) {
    const { harness, model } = routes[role];
    const until = switchedUntil.get(harness);
    if (until !== undefined && now() < until) return invoke(fallback[harness]);
    try {
      return await invoke(model);
    } catch (error) {
      if (!isBalanceError(error)) throw error;
      switchedUntil.set(harness, now() + ttlMs);
      return invoke(fallback[harness]);
    }
  };
}

/** Wait until `until`, running the injected main-CI check on every pass (at least once). */
export async function waitForUsageLimit({ until, now, sleep, intervalMs, checkMainCi }) {
  do {
    await checkMainCi();
    await sleep(intervalMs);
  } while (now() < until);
}
