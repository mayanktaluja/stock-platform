/**
 * Market-relevance gate — the POSITIVE allowlist.
 *
 * The user only wants news that relates to a stock or moves the market; the
 * channels also carry general news (crime, weather, celebrity, a restaurant
 * opening). A message is forwarded only if it hits a market keyword here, OR a
 * macro-breaking keyword, OR a watchlist ticker (the router combines all three).
 * Everything else is dropped in routeMessage — cutting the firehose to signal.
 *
 * Broad on purpose (high recall — keep real market news): leading-boundary stem
 * match so "share" catches "shares"/"shareholder", "bank" catches "banking".
 * Keywords live in data/alerts/market-keywords.json (user-tunable). Pure.
 */

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function compileMarketGate(keywords = []) {
  const safe = [...new Set((Array.isArray(keywords) ? keywords : []).map((t) => String(t || "").trim().toLowerCase()).filter(Boolean))]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegex);
  if (!safe.length) return { re: null };
  return { re: new RegExp(`(?<![A-Za-z0-9])(?:${safe.join("|")})`, "i") };
}

/** True if `text` looks market-relevant (hits any market keyword). */
export function matchMarket(text, compiled) {
  const str = String(text || "");
  if (!str.trim()) return false;
  if (!compiled || !compiled.re) return true; // no list configured → don't filter (fail-open)
  return new RegExp(compiled.re.source, "i").test(str);
}
