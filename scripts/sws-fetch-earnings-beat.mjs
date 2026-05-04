// Backfill last_quarter_result on upcoming_earnings cards from Yahoo Finance.
//
// Coverage note: today's run resolved 117/242 tickers (48%); the remainder
// are smaller small-caps that Yahoo doesn't carry quarterly EPS history for.
// The badge gracefully hides on those — see classify() return paths below.
//
// Why: SWS DOM scraper used to populate this field; the API parser that
// replaced it can't (REST endpoint doesn't expose it), so the field has been
// null on every card since the migration. We source it from Yahoo's
// earningsHistory module, which exposes epsActual + epsEstimate + a
// pre-computed surprisePercent per quarter for most NSE-listed stocks.
//
// Output values stay "beat" | "miss" | "inline" | null so the field remains
// compatible with:
//   - the +3 catalyst bonus at scripts/sws-scoring.mjs:130
//   - the counter-thesis logic at services/swsCounterThesis.js:19
//   - the modal display at gated/app.js:10108
//
// Decision rule (locked in the plan):
//   surprisePercent >= +0.02 → beat
//   surprisePercent <= -0.02 → miss
//   else                     → inline
//   null when: estimate missing, actual missing, no history, or last quarter
//   reported >180 days ago (annual reporters etc — hide the badge rather than
//   pretending an old result is recent).
//
// Mutates ONLY sections.upcoming_earnings — the deep file's
// overview.last_quarter_result stays null.
//
// Usage:
//   node scripts/sws-fetch-earnings-beat.mjs                      # default
//   node scripts/sws-fetch-earnings-beat.mjs --concurrency 5
//   node scripts/sws-fetch-earnings-beat.mjs --max-age-days 180

import fs from "node:fs";
import path from "node:path";
import YahooFinance from "yahoo-finance2";
import { PATHS } from "./sws-config.mjs";

const args = process.argv.slice(2);
let CONCURRENCY = 5;
let MAX_AGE_DAYS = 180;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--concurrency") CONCURRENCY = Number(args[++i]);
  else if (args[i] === "--max-age-days") MAX_AGE_DAYS = Number(args[++i]);
}

const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });
const BEAT_RATIO = 0.02;
const MISS_RATIO = -0.02;

function classify({ epsActual, epsEstimate, surprisePercent, quarter }) {
  if (epsActual == null || epsEstimate == null) return { result: null, reason: "missing_eps" };
  if (epsEstimate === 0) return { result: null, reason: "zero_estimate" };
  if (quarter) {
    const ageDays = (Date.now() - new Date(quarter).getTime()) / 86400000;
    if (ageDays > MAX_AGE_DAYS) return { result: null, reason: `stale_${Math.round(ageDays)}d` };
  }
  // Yahoo computes surprisePercent = (actual - estimate) / |estimate|. Trust
  // it when present; otherwise fall back to a fresh ratio computation.
  const ratio = surprisePercent != null ? surprisePercent : (epsActual - epsEstimate) / Math.abs(epsEstimate);
  if (ratio >= BEAT_RATIO) return { result: "beat", reason: "ok" };
  if (ratio <= MISS_RATIO) return { result: "miss", reason: "ok" };
  return { result: "inline", reason: "ok" };
}

async function fetchOne(ticker) {
  // SWS universe is NSE-listed; default to .NS suffix. Bare-ticker SWS keys
  // (e.g. RELIANCE) become RELIANCE.NS; pre-suffixed tickers pass through.
  const symbol = (ticker.endsWith(".NS") || ticker.endsWith(".BO")) ? ticker : `${ticker}.NS`;
  try {
    const res = await yf.quoteSummary(symbol, { modules: ["earningsHistory"] });
    const rows = res?.earningsHistory?.history || [];
    if (!rows.length) return { ticker, result: null, reason: "no_history" };
    // Yahoo orders this array oldest-first (period -4q .. -1q). Sort by
    // quarter desc explicitly so we don't depend on the ordering contract.
    const sorted = [...rows].sort((a, b) => {
      const da = a.quarter ? new Date(a.quarter).getTime() : 0;
      const db = b.quarter ? new Date(b.quarter).getTime() : 0;
      return db - da;
    });
    const latest = sorted[0];
    const out = classify({
      epsActual: latest.epsActual ?? null,
      epsEstimate: latest.epsEstimate ?? null,
      surprisePercent: latest.surprisePercent ?? null,
      quarter: latest.quarter ?? null,
    });
    return {
      ticker,
      ...out,
      epsActual: latest.epsActual ?? null,
      epsEstimate: latest.epsEstimate ?? null,
      surprisePercent: latest.surprisePercent ?? null,
      quarter: latest.quarter ? new Date(latest.quarter).toISOString().slice(0, 10) : null,
    };
  } catch (err) {
    return { ticker, result: null, reason: "yahoo_err", err: err.message };
  }
}

// Worker-pool batcher, copied verbatim from scripts/sws-enrich-technicals.mjs:69
async function processInBatches(tickers, fn, concurrency) {
  const results = [];
  let idx = 0;
  async function worker() {
    while (idx < tickers.length) {
      const my = idx++;
      try {
        results[my] = await fn(tickers[my]);
      } catch (e) {
        results[my] = { ticker: tickers[my], result: null, reason: "thrown", err: e.message };
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

// Atomic write: stage to .tmp.<pid> and rename so a mid-write crash or a
// concurrent reader (the API route) never sees a half-written JSON file.
function writeJsonAtomic(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, p);
}

async function main() {
  if (!fs.existsSync(PATHS.picksLatest)) {
    console.error(`No picks file at ${PATHS.picksLatest} — run scripts/sws-scoring.mjs first.`);
    process.exit(1);
  }
  const picks = JSON.parse(fs.readFileSync(PATHS.picksLatest, "utf-8"));
  const upcoming = picks.sections?.upcoming_earnings || [];
  if (!upcoming.length) {
    console.log("No upcoming_earnings cards. Nothing to enrich.");
    return;
  }

  console.log(`Fetching Yahoo earningsHistory for ${upcoming.length} tickers · concurrency=${CONCURRENCY} · max-age-days=${MAX_AGE_DAYS}`);
  const t0 = Date.now();
  const tickers = upcoming.map((c) => c.ticker);
  const results = await processInBatches(tickers, fetchOne, CONCURRENCY);
  const byTicker = new Map(results.map((r) => [r.ticker, r]));

  let nBeat = 0, nMiss = 0, nInline = 0, nUnknown = 0;
  for (const card of upcoming) {
    const r = byTicker.get(card.ticker);
    card.last_quarter_result = r?.result ?? null;
    if (r?.result === "beat") nBeat++;
    else if (r?.result === "miss") nMiss++;
    else if (r?.result === "inline") nInline++;
    else nUnknown++;
    const surp = r?.surprisePercent != null ? `${(r.surprisePercent * 100).toFixed(1)}%` : "—";
    const q = r?.quarter || "—";
    console.log(`  ${card.ticker.padEnd(14)} ${(r?.result || "—").padEnd(7)} surp=${surp.padStart(6)} q=${q} (${r?.reason || "no_data"})`);
  }

  picks.earnings_beat_meta = {
    ran_at: new Date().toISOString(),
    tickers_attempted: upcoming.length,
    n_beat: nBeat,
    n_miss: nMiss,
    n_inline: nInline,
    n_unknown: nUnknown,
    duration_seconds: Math.round((Date.now() - t0) / 1000),
    rule: "beat: surprisePercent >= +2%; miss: <= -2%; inline: between; null when estimate/actual missing, no history, or last quarter > " + MAX_AGE_DAYS + " days old.",
    source: "yahoo-finance2 quoteSummary { modules: ['earningsHistory'] }",
  };
  writeJsonAtomic(PATHS.picksLatest, picks);
  console.log(`\nWrote ${PATHS.picksLatest}`);
  console.log(`Summary: beat=${nBeat} miss=${nMiss} inline=${nInline} unknown=${nUnknown} (of ${upcoming.length} upcoming-earnings cards)`);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
