/**
 * convictionMap.js — score-band → realized hit-rate map.
 *
 * Closes the P1.6 TODO surfaced in the per-card SEBI Disclosure pane
 * ("conviction-% calibration to live track record pending — P1.6").
 *
 * Pure-math bucketing. The price-fetch + caching plumbing lives in
 * server.js where fetchQuote is already wired with the 60s NodeCache
 * (importing it here would be circular). server.js calls
 * `bucketTradesByScoreBand(tradesWithReturns)` once per cache window,
 * caches the result, and attaches `r.convictionPct` to every pick via
 * `getConvictionPct(score, map)`.
 *
 * Bands are 5-point wide from 50 upward. Picks below 50 share a single
 * "<50" bucket — the dual-lane Buy Now floor is 65 and Mid-Term is 58,
 * so the lower band is informational only.
 *
 * Hit rate = trades with returnPct > 0 ÷ total trades in the band.
 * Sample-size minimum = 10 trades; a band with n<10 returns null
 * conviction so the disclosure pane can fall back to the qualitative
 * label (STRONG / MODERATE / WEAK) rather than show a noisy %.
 */

const MIN_BAND_SAMPLE = 10;
const MIN_DAYS_HELD = 7; // give trades at least a week of holding

const BAND_EDGES = Object.freeze([50, 55, 60, 65, 70, 75, 80, 85, 90, 95]);

/**
 * Map a numeric score (0..100) to a string band label like "65-69".
 * Scores below 50 collapse to "<50". Scores ≥ 95 collapse to "95+".
 */
export function getBandLabel(score) {
  const s = Number(score);
  if (!Number.isFinite(s)) return null;
  if (s < 50) return "<50";
  if (s >= 95) return "95+";
  for (let i = BAND_EDGES.length - 1; i >= 0; i--) {
    if (s >= BAND_EDGES[i]) {
      const lo = BAND_EDGES[i];
      const hi = lo + 4;
      return `${lo}-${hi}`;
    }
  }
  return "<50";
}

/**
 * Build the conviction map from an array of trades-with-computed-returns.
 *
 * @param {Array<{scoreAtSnapshot: number, returnPct: number, daysHeld: number}>} entries
 * @returns {{
 *   bands: Record<string, { hitRate: number|null, n: number, avgReturn: number }>,
 *   builtAt: string,
 *   totalTrades: number,
 *   eligibleTrades: number,
 * }}
 */
export function bucketTradesByScoreBand(entries) {
  if (!Array.isArray(entries)) entries = [];
  const buckets = new Map();
  let eligible = 0;
  for (const e of entries) {
    if (!e || !Number.isFinite(e.scoreAtSnapshot) || !Number.isFinite(e.returnPct)) continue;
    if (Number.isFinite(e.daysHeld) && e.daysHeld < MIN_DAYS_HELD) continue;
    const band = getBandLabel(e.scoreAtSnapshot);
    if (!band) continue;
    eligible++;
    if (!buckets.has(band)) buckets.set(band, { wins: 0, n: 0, sumReturn: 0 });
    const b = buckets.get(band);
    if (e.returnPct > 0) b.wins++;
    b.n++;
    b.sumReturn += e.returnPct;
  }
  const bands = {};
  for (const [band, b] of buckets) {
    bands[band] = {
      hitRate: b.n >= MIN_BAND_SAMPLE ? +(b.wins / b.n).toFixed(3) : null,
      n: b.n,
      avgReturn: +(b.sumReturn / b.n).toFixed(2),
    };
  }
  return {
    bands,
    builtAt: new Date().toISOString(),
    totalTrades: entries.length,
    eligibleTrades: eligible,
  };
}

/**
 * Lookup the conviction % for a single pick's score from a built map.
 * Returns a 0-1 ratio (e.g., 0.62 for 62%) or null when the band has
 * no data or sample-size is too small.
 *
 * @param {number} score
 * @param {ReturnType<typeof bucketTradesByScoreBand>} map
 * @returns {number|null} 0..1 hit rate, or null
 */
export function getConvictionPct(score, map) {
  if (!map || !map.bands) return null;
  const band = getBandLabel(score);
  if (!band) return null;
  const entry = map.bands[band];
  return entry?.hitRate ?? null;
}

export { MIN_BAND_SAMPLE, MIN_DAYS_HELD };
