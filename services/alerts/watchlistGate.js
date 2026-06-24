/**
 * Watchlist keyword gate — the NEWS-class pre-filter (zero LLM cost).
 *
 * Decides whether a headline is about a stock the owner cares about. Match is
 * on tickers + their aliases; sector keywords only count when they CO-OCCUR
 * with a ticker hit (adversarial M2 — bare "bank"/"oil"/"power" false-positive
 * on unrelated headlines). All matching is word-boundary anchored with a
 * minimum token length so short aliases don't match inside larger words.
 *
 * Class boundary (adversarial C3): this gate is NEWS-class and intentionally
 * does NOT match broad macro keywords (Fed/rate/war/oil-shock/risk-off) — those
 * are the REGIME class delivered by the macro cron. Keeping them out of the
 * watchlist avoids the same Fed headline double-firing across both classes.
 */

const MIN_TOKEN_LEN = 3;

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build a matcher whose tokens are anchored on non-word boundaries. We can't
 * use plain \b because tickers/aliases contain &, -, . (e.g. "M&M",
 * "BAJAJ-AUTO") where \b doesn't sit where you'd expect. Instead we require a
 * non-alphanumeric (or string edge) on both sides.
 */
function buildTokenRegex(tokens) {
  const safe = [...new Set(tokens.map((t) => String(t || "").trim()).filter((t) => t.length >= MIN_TOKEN_LEN))]
    .sort((a, b) => b.length - a.length) // longest-first so "BAJAJ-AUTO" wins over "BAJAJ"
    .map(escapeRegex);
  if (!safe.length) return null;
  return new RegExp(`(?<![A-Za-z0-9])(?:${safe.join("|")})(?![A-Za-z0-9])`, "i");
}

/**
 * Compile a watchlist config into matchers.
 *   watchlist = { tickers:[], aliases:{TICKER:[...]}, sectorKeywords:[] }
 * Returns { perSymbol:[{symbol, re}], sectorRe }.
 */
export function compileWatchlist(watchlist = {}) {
  const tickers = Array.isArray(watchlist.tickers) ? watchlist.tickers : [];
  const aliases = watchlist.aliases && typeof watchlist.aliases === "object" ? watchlist.aliases : {};
  const perSymbol = [];
  for (const sym of tickers) {
    const symbol = String(sym || "").trim();
    if (!symbol) continue;
    const tokens = [symbol, ...(Array.isArray(aliases[symbol]) ? aliases[symbol] : [])];
    const re = buildTokenRegex(tokens);
    if (re) perSymbol.push({ symbol, re });
  }
  const sectorRe = buildTokenRegex(Array.isArray(watchlist.sectorKeywords) ? watchlist.sectorKeywords : []);
  return { perSymbol, sectorRe };
}

/**
 * Match a headline title against the compiled watchlist.
 *   { matched:false }
 *   { matched:true, symbols:[...], sectors:[...] }
 * A sector keyword alone never matches — it must co-occur with a ticker hit.
 */
export function matchHeadline(title, compiled) {
  const text = String(title || "");
  if (!text.trim() || !compiled) return { matched: false };

  const symbols = compiled.perSymbol.filter(({ re }) => re.test(text)).map(({ symbol }) => symbol);
  if (!symbols.length) return { matched: false }; // ticker hit is required

  const sectors = [];
  if (compiled.sectorRe) {
    const m = text.match(compiled.sectorRe);
    if (m) sectors.push(m[0]);
  }
  return { matched: true, symbols, sectors };
}
