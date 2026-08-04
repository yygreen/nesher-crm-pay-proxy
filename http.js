/**
 * fetch with timeout so Mercury/auth/FX never hang the pay button forever.
 */

/**
 * @param {string} url
 * @param {RequestInit & { timeoutMs?: number }} [init]
 * @param {typeof fetch} [fetchImpl]
 */
export async function fetchWithTimeout(url, init = {}, fetchImpl = fetch) {
  const timeoutMs = Number(init.timeoutMs ?? process.env.HTTP_TIMEOUT_MS ?? 12000);
  const { timeoutMs: _drop, ...rest } = init;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    // If caller already passed a signal, abort either side
    if (rest.signal) {
      if (rest.signal.aborted) ctrl.abort();
      else rest.signal.addEventListener("abort", () => ctrl.abort(), { once: true });
    }
    return await fetchImpl(url, { ...rest, signal: ctrl.signal });
  } catch (e) {
    if (e && (e.name === "AbortError" || e.code === "ABORT_ERR")) {
      const err = new Error(`Request timed out after ${timeoutMs}ms: ${url}`);
      err.code = "TIMEOUT";
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
