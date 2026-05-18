// Circuit-breaker + stale-cache wrapper for routes that call flaky external
// APIs at request time (Yahoo, NSE, RSS feeds). When the upstream is healthy
// the breaker is a pure pass-through; once `openAfterFailures` consecutive
// failures land, the breaker opens for `cooldownMs` and serves the last good
// cached response (up to `staleCacheTtlMs` old) instead of a 5xx. After
// cooldown, the next call probes upstream — success closes the breaker;
// another failure restarts the cooldown clock.
//
// Closes audit finding #10 (P2): the 4 request-time external-API routes
// (/api/stock/:symbol, /api/news/market, /api/sector-heatmap, /api/market)
// previously had no circuit-breaker and would 500/timeout on any upstream
// hiccup. This wrapper preserves the user-visible response with a `fresh:
// false` marker so the UI can show a "stale data" badge.

const DEFAULTS = {
  timeoutMs: 8000,
  openAfterFailures: 3,
  cooldownMs: 60_000,
  staleCacheTtlMs: 30 * 60_000,
};

export function createBreaker(opts = {}) {
  const {
    name = "unnamed",
    timeoutMs = DEFAULTS.timeoutMs,
    openAfterFailures = DEFAULTS.openAfterFailures,
    cooldownMs = DEFAULTS.cooldownMs,
    staleCacheTtlMs = DEFAULTS.staleCacheTtlMs,
    now = () => Date.now(),
  } = opts;

  const cache = new Map(); // key -> { data, ts }
  let consecutiveFailures = 0;
  let openedAt = null;

  const isOpen = () => openedAt !== null && (now() - openedAt) < cooldownMs;

  async function call(key, upstreamFn) {
    const cached = cache.get(key);
    const staleAvailable = cached && (now() - cached.ts) < staleCacheTtlMs;

    if (isOpen()) {
      if (staleAvailable) return { data: cached.data, fresh: false, source: "stale_cache_breaker_open", breaker: name };
      return { data: null, fresh: false, source: "breaker_open_no_cache", breaker: name };
    }

    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(`${name} upstream timeout >${timeoutMs}ms`)), timeoutMs);
    });

    try {
      const data = await Promise.race([Promise.resolve().then(upstreamFn), timeoutPromise]);
      clearTimeout(timeoutId);
      consecutiveFailures = 0;
      openedAt = null;
      cache.set(key, { data, ts: now() });
      return { data, fresh: true, source: "upstream", breaker: name };
    } catch (err) {
      clearTimeout(timeoutId);
      consecutiveFailures++;
      if (consecutiveFailures >= openAfterFailures) {
        openedAt = now();
      }
      if (staleAvailable) return { data: cached.data, fresh: false, source: "stale_cache_upstream_error", breaker: name, error: err.message };
      return { data: null, fresh: false, source: "upstream_error_no_cache", breaker: name, error: err.message };
    }
  }

  function _state() {
    return { consecutiveFailures, openedAt, isOpen: isOpen(), cacheSize: cache.size };
  }

  function _reset() {
    consecutiveFailures = 0;
    openedAt = 0;
    cache.clear();
  }

  return { call, _state, _reset, name };
}
