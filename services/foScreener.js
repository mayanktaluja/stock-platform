/**
 * F&O OI-Delta Swing Screener — orchestrator.
 *
 * runOnce() is the single entry point used by both the cron route
 * (/api/cron/refresh-fo-oi) and the local script (scripts/refresh-fo-oi.mjs).
 * It:
 *   1. Resolves the trading date to fetch (defaults to most recent IST trading day).
 *   2. Fetches the F&O bhavcopy ZIP, unpacks, parses → rows + aggregated.
 *   3. Persists raw parsed file under data/nse-fo/bhavcopy/YYYY-MM-DD.json.
 *   4. Computes volume_ratios from rolling history.
 *   5. Computes per-underlying deltas + signals + score.
 *   6. Appends today's per-underlying row to history.
 *   7. Cross-references portfolio.json + picks-latest.json.
 *   8. Writes the screener payload atomically to data/nse-fo/oi-deltas-latest.json.
 *
 * Errors propagate. Idempotent: re-running with the same date overwrites.
 */

import fs from "node:fs";
import path from "node:path";

import {
  fetchBhavcopy,
  BhavcopyNotPublished,
  BhavcopyBlocked,
} from "./foBhavcopyFetcher.js";
import { parseBhavcopy } from "./foBhavcopyParser.js";
import { computeOiDeltas } from "./foOiDelta.js";
import {
  appendAllHistoryPoints,
  computeVolumeRatios,
} from "./foHistory.js";
import {
  saveFoScreenerToKV,
  saveFoHistoryToKVFromDisk,
  restoreFoHistoryFromKVToDisk,
} from "./foKvStore.js";
import { FO_CONFIG } from "./foConfig.js";

const ROOT = process.cwd();
const FO_DIR = path.join(ROOT, "data", "nse-fo");
const BHAVCOPY_DIR = path.join(FO_DIR, "bhavcopy");
const LATEST_PATH = path.join(FO_DIR, "oi-deltas-latest.json");
const PORTFOLIO_PATH = path.join(ROOT, "portfolio.json");
const PICKS_PATH = path.join(ROOT, "data", "sws", "picks-latest.json");

const METHODOLOGY = [
  "OI aggregated across all stock-futures expiries (avoids rollover-Thursday phantoms);",
  "Δ vs prior session = ChngInOpnIntrst / (OI − ChngInOpnIntrst).",
  `Volume confirmation: today's vol vs ${FO_CONFIG.VOLUME_AVG_DAYS}-session mean.`,
  `Decoupling co-flag: |OI Δ| ≥ ${FO_CONFIG.DECOUPLE_OI_MIN}% with |price Δ| < ${FO_CONFIG.DECOUPLE_PRICE_MAX}%.`,
  "Score 0–100 = scaled OI move × volume confirmation × decouple boost × direction consistency.",
  "Educational analytics. Not investment advice.",
].join(" ");

function pad2(n) {
  return String(n).padStart(2, "0");
}

/**
 * Most recent IST weekday (Mon–Fri). For Sat/Sun we walk back to Friday.
 * Holidays aren't handled here — we'll just 404 and the orchestrator falls
 * back to the prior date (see resolveLatestPublishedDate).
 */
export function mostRecentIstTradingDate(now = new Date()) {
  // Convert to IST and read the date components in IST.
  const istMs = now.getTime() + 5.5 * 3600 * 1000;
  const ist = new Date(istMs);
  let y = ist.getUTCFullYear();
  let m = ist.getUTCMonth();
  let d = ist.getUTCDate();
  let dow = ist.getUTCDay(); // 0=Sun, 6=Sat

  // Walk back to Fri/Thu/Wed... if weekend
  let walkBack = 0;
  if (dow === 0) walkBack = 2; // Sun → Fri
  else if (dow === 6) walkBack = 1; // Sat → Fri

  if (walkBack > 0) {
    const back = new Date(Date.UTC(y, m, d - walkBack));
    y = back.getUTCFullYear();
    m = back.getUTCMonth();
    d = back.getUTCDate();
  }
  return `${y}-${pad2(m + 1)}-${pad2(d)}`;
}

function ymdMinusDays(ymd, days) {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d - days));
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

function writeJsonAtomic(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, p);
}

function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function loadPortfolioTickers() {
  const data = readJsonSafe(PORTFOLIO_PATH);
  const stocks = data?.stocks || [];
  const out = new Map();
  for (const s of stocks) {
    const sym = String(s.symbol || "").replace(/\.(NS|BO)$/i, "").toUpperCase();
    if (!sym) continue;
    out.set(sym, { name: s.name, sector: s.sector, qty: s.quantity });
  }
  return out;
}

/**
 * Pull the union of all SWS picks tickers from picks-latest.json.
 * Sections vary over time; flatten everything that looks like a stock card.
 */
function loadPicksTickers() {
  const picks = readJsonSafe(PICKS_PATH);
  if (!picks) return new Set();
  const out = new Set();
  const seen = new WeakSet();

  function walk(node) {
    if (!node || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    // A "stock card" has a ticker / symbol / sws_url-ish key
    const tkr =
      node.ticker || node.symbol || node.tckrSymb || node.code || null;
    if (typeof tkr === "string" && /^[A-Z0-9&-]{1,15}$/.test(tkr)) {
      out.add(tkr.replace(/\.(NS|BO)$/i, "").toUpperCase());
    }
    for (const k of Object.keys(node)) walk(node[k]);
  }
  walk(picks);
  return out;
}

function partitionSections(deltas, portfolio, picks) {
  const inBook = [];
  const inPicks = [];
  const broader = [];

  for (const row of deltas) {
    if (portfolio.has(row.underlying)) {
      const meta = portfolio.get(row.underlying);
      inBook.push({ ...row, portfolio: { qty: meta.qty, sector: meta.sector, name: meta.name } });
    } else if (picks.has(row.underlying)) {
      inPicks.push(row);
    } else {
      broader.push(row);
    }
  }

  // Each section sorted desc by score (already mostly sorted from caller; re-sort to be safe)
  const byScore = (a, b) => (b.score ?? 0) - (a.score ?? 0);
  inBook.sort(byScore);
  inPicks.sort(byScore);
  broader.sort(byScore);

  // Cap inPicks + broader; keep all of inBook
  return {
    inBook,
    inPicks: inPicks.slice(0, FO_CONFIG.BROADER_TOP_N), // re-use top-N as picks cap
    broader: broader.slice(0, FO_CONFIG.BROADER_TOP_N),
  };
}

/**
 * Resolve the trading date whose bhavcopy we should fetch. If `requested`
 * is supplied, use it as-is. Otherwise default to the most recent IST
 * weekday. The caller can fall back to walking back if the fetch 404s.
 */
function resolveTargetDate(requested) {
  if (requested) return requested;
  return mostRecentIstTradingDate();
}

/**
 * Wrap fetch+parse with a walk-back fallback: if the requested date 404s
 * (BhavcopyNotPublished), try the prior session up to N times. This
 * gracefully handles holidays and pre-publish runs.
 */
async function fetchAndParseWithFallback(targetDate, maxLookback) {
  let date = targetDate;
  let lastErr = null;
  for (let i = 0; i <= maxLookback; i++) {
    try {
      const fetched = await fetchBhavcopy(date);
      const parsed = parseBhavcopy(fetched.csv, new Date().toISOString());
      return { date, fetched, parsed, walked: i };
    } catch (err) {
      if (err instanceof BhavcopyNotPublished) {
        lastErr = err;
        date = ymdMinusDays(date, 1);
        // Skip weekends without burning a probe
        const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
        if (dow === 0) date = ymdMinusDays(date, 2);
        else if (dow === 6) date = ymdMinusDays(date, 1);
        continue;
      }
      throw err;
    }
  }
  throw lastErr || new BhavcopyNotPublished(targetDate);
}

/**
 * Idempotent run. Returns a small status object — full payload lives on disk.
 *
 * options:
 *   date        — explicit YYYY-MM-DD (else most-recent IST weekday)
 *   forceRefetch — bypass the 10-min mtime grace; always hit NSE
 */
export async function runOnce(options = {}) {
  const targetDate = resolveTargetDate(options.date);
  const startTs = Date.now();

  // On Vercel the per-ticker history files are ephemeral. Hydrate them from
  // KV before computeVolumeRatios runs — otherwise vol_ratio is always null
  // in prod, and the score formula falls back to the conservative 0.5×
  // floor. This is a no-op on a local box (KV not configured) AND when the
  // disk already has fresher copies (existing files are kept as-is).
  const historyRestored = await restoreFoHistoryFromKVToDisk();

  // Idempotent skip: if we already have today's parsed file and it's < grace,
  // recompute deltas only (cheap, lets threshold tweaks land without re-hitting NSE).
  const cachedParsedPath = path.join(BHAVCOPY_DIR, `${targetDate}.json`);
  let parsed = null;
  let urlUsed = null;
  let walked = 0;
  let actualDate = targetDate;

  const cachedStat = fs.existsSync(cachedParsedPath)
    ? fs.statSync(cachedParsedPath)
    : null;
  const cacheFresh =
    cachedStat &&
    !options.forceRefetch &&
    Date.now() - cachedStat.mtimeMs < FO_CONFIG.REFETCH_GRACE_MS;

  if (cacheFresh) {
    const cached = readJsonSafe(cachedParsedPath);
    if (cached?.aggregated) {
      parsed = cached;
      urlUsed = "(cache)";
    }
  }

  if (!parsed) {
    const result = await fetchAndParseWithFallback(
      targetDate,
      FO_CONFIG.PRIOR_DAY_LOOKBACK_SESSIONS,
    );
    parsed = result.parsed;
    urlUsed = result.fetched.urlUsed;
    walked = result.walked;
    actualDate = result.date;

    // Persist raw parsed file. This becomes a permanent archival record.
    writeJsonAtomic(path.join(BHAVCOPY_DIR, `${actualDate}.json`), {
      schemaVersion: "fo-bhav-v1",
      tradeDate: parsed.tradeDate,
      fetchedAt: parsed.fetchedAt,
      urlUsed,
      rowCount: parsed.rows.length,
      rows: parsed.rows,
      aggregated: parsed.aggregated,
    });
  }

  // 4. Volume ratios (need history BEFORE we append today's point).
  const volumeRatios = computeVolumeRatios(parsed.tradeDate, parsed.aggregated);

  // 5. Compute deltas + classify
  const deltas = computeOiDeltas(parsed.aggregated, volumeRatios);

  // 6. Append today's history points (after vol-ratio computation so we don't
  //    bias the mean with today's value).
  const appended = appendAllHistoryPoints(parsed.tradeDate, parsed.aggregated);

  // 7. Cross-reference + partition
  const portfolio = loadPortfolioTickers();
  const picks = loadPicksTickers();
  const sections = partitionSections(deltas, portfolio, picks);

  const stats = {
    totalUniverse: deltas.length,
    withSignal: deltas.filter((d) => d.signal !== "neutral").length,
    decoupled: deltas.filter((d) => d.decoupled).length,
    inBookCount: sections.inBook.length,
    inPicksCount: sections.inPicks.length,
    broaderCount: sections.broader.length,
    historyPointsAppended: appended,
    historyRestoredFromKV: historyRestored,
    walkedBack: walked,
  };

  // 8. Atomic write of the served payload
  const payload = {
    schemaVersion: "fo-screener-v1",
    asOf: parsed.tradeDate,
    fetchedAt: parsed.fetchedAt,
    urlUsed,
    methodology: METHODOLOGY,
    stats,
    sections,
  };
  writeJsonAtomic(LATEST_PATH, payload);

  // 9. Mirror to KV so the next Vercel function invocation can read it
  //    (filesystem writes don't survive). No-op locally when KV is unset.
  const screenerSavedToKV = await saveFoScreenerToKV(payload);
  const historySavedToKV = await saveFoHistoryToKVFromDisk();

  return {
    ok: true,
    asOf: parsed.tradeDate,
    targetDate,
    actualDate,
    walked,
    stats,
    durationMs: Date.now() - startTs,
    sinks: {
      disk: true,
      kvScreener: screenerSavedToKV,
      kvHistory: historySavedToKV,
    },
  };
}
