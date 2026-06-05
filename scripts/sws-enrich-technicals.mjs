// Enrich the SWS leaderboard with live technicals from /api/stock/:symbol.
//
// Why a separate stage: the SWS deep-scrape is slow (days) and fundamentals-
// heavy. Technicals (RSI, MACD, trend, 200-DMA) change daily and live in the
// platform's existing engine at /api/stock. This script bridges the two —
// fetches live technicals for the leaderboard's top picks, computes v3 score
// (70% fundamentals + 30% technicals + catalyst − risk overlay), and writes
// back into picks-latest.json so the UI lists the blended score.
//
// Rules of the blend:
//   v4_score_100 = clamp(0, v1 * 0.7 + tech * 0.3 + catalyst + risk_overlay, 100)
//
// Falls back to v2 when tech is unavailable (recent IPO, missing history).
//
// Usage:
//   node scripts/sws-enrich-technicals.mjs                  # default Top-50 unique
//   node scripts/sws-enrich-technicals.mjs --max 30
//   node scripts/sws-enrich-technicals.mjs --port 3005      # override server port
//   node scripts/sws-enrich-technicals.mjs --concurrency 5

import fs from "node:fs";
import path from "node:path";
import { PATHS } from "./sws-config.mjs";

const args = process.argv.slice(2);
let MAX = 50;
let PORT = process.env.PORT || 3005;
let CONCURRENCY = 5;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--max") MAX = Number(args[++i]);
  else if (args[i] === "--port") PORT = Number(args[++i]);
  else if (args[i] === "--concurrency") CONCURRENCY = Number(args[++i]);
}

const BASE = `http://localhost:${PORT}`;

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

// Same v3 blend formula the UI expects. Keep in sync with the comment at top.
function computeV3(v1, technical, catalyst, riskOverlay) {
  if (technical == null) return null; // fall back to v2 outside this fn
  const blended = v1 * 0.7 + technical * 0.3 + (catalyst || 0) + (riskOverlay || 0);
  return clamp(Math.round(blended * 10) / 10, 0, 100);
}

async function fetchTechnicalsForTicker(ticker) {
  // /api/stock/:symbol auto-appends .NS for non-suffixed tickers
  const url = `${BASE}/api/stock/${encodeURIComponent(ticker)}`;
  const res = await fetch(url, { method: "GET" });
  if (!res.ok) {
    return { ticker, ok: false, status: res.status, err: `HTTP ${res.status}` };
  }
  const data = await res.json();
  // The server may return analysis.error for insufficient history (new IPO);
  // in that case technicalScore is null. Treat both as soft-fail.
  const tech = data.analysis?.technicalScore;
  const reco = data.analysis?.recommendation || null;
  const sent = data.analysis?.sentimentScore ?? null;
  return {
    ticker,
    ok: tech != null,
    technical_score_100: tech,
    sentiment_score_100: sent,
    recommendation: reco,
    soft_err: data.analysis?.error || null,
  };
}

async function processInBatches(tickers, fn, concurrency) {
  const results = [];
  let idx = 0;
  async function worker() {
    while (idx < tickers.length) {
      const my = idx++;
      try {
        results[my] = await fn(tickers[my]);
      } catch (e) {
        results[my] = { ticker: tickers[my], ok: false, err: e.message };
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

function writeJsonAtomic(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, p);
}

async function main() {
  if (!fs.existsSync(PATHS.picksLatest)) {
    console.error(`No picks file at ${PATHS.picksLatest} — run sws-scoring.mjs first.`);
    process.exit(1);
  }
  const picks = JSON.parse(fs.readFileSync(PATHS.picksLatest, "utf-8"));
  const sections = picks.sections || {};

  // Collect unique tickers from the lists where the blended score matters
  // most — the broad Top-30 plus the curated buckets users actually scan.
  const SECTIONS_TO_ENRICH = ["top_ranked_30_v4", "top_ranked_30_v3", "best_to_buy_now", "quality_growth", "smallcap_gems", "midterm", "dividend_aristocrats"];
  const seen = new Map();
  for (const key of SECTIONS_TO_ENRICH) {
    for (const card of (sections[key] || [])) {
      if (card.ticker && !seen.has(card.ticker)) seen.set(card.ticker, card);
      if (seen.size >= MAX) break;
    }
    if (seen.size >= MAX) break;
  }
  const tickers = [...seen.keys()];
  console.log(`Enriching ${tickers.length} unique tickers · concurrency=${CONCURRENCY} · base=${BASE}`);
  if (!tickers.length) { console.log("Nothing to enrich."); return; }

  const startedAt = Date.now();
  const results = await processInBatches(tickers, fetchTechnicalsForTicker, CONCURRENCY);
  const ok = results.filter((r) => r.ok).length;
  const fail = results.length - ok;
  console.log(`Fetched: ${ok} ok, ${fail} fail in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);

  // Build per-ticker enriched view
  const enrichedMap = new Map();
  for (const r of results) {
    if (!r.ok) continue;
    enrichedMap.set(r.ticker, r);
  }

  // Update every section that contains an enriched ticker — the same card can
  // appear in best_to_buy_now and top_ranked_30; both should show v3.
  let touched = 0;
  for (const [, items] of Object.entries(sections)) {
    if (!Array.isArray(items)) continue;
    for (const card of items) {
      const enr = enrichedMap.get(card.ticker);
      if (!enr) continue;
      card.technical_score_100 = enr.technical_score_100;
      card.sentiment_score_100 = enr.sentiment_score_100;
      card.live_recommendation = enr.recommendation;
      // v3 blend
      const v1 = card.score; // v1 fundamentals
      const cat = card.v2_breakdown?.pts_catalyst || 0;
      const risk = card.v2_breakdown?.pts_risk_overlay || 0;
      const v3 = computeV3(v1, enr.technical_score_100, cat, risk);
      if (v3 != null) {
        card.v4_score_100 = v3;
        card.v4_breakdown = {
          fundamentals_component: Math.round(v1 * 0.7 * 10) / 10,
          technical_component: Math.round(enr.technical_score_100 * 0.3 * 10) / 10,
          pts_catalyst: cat,
          pts_risk_overlay: risk,
          live_recommendation: enr.recommendation,
        };
      }
      touched++;
    }
  }

  picks.enrich_meta = {
    ran_at: new Date().toISOString(),
    tickers_attempted: tickers.length,
    tickers_succeeded: ok,
    tickers_failed: fail,
    duration_seconds: Math.round((Date.now() - startedAt) / 1000),
    blend_formula: "v3 = clamp(0, v1*0.7 + tech*0.3 + catalyst + risk_overlay, 100)",
  };
  writeJsonAtomic(PATHS.picksLatest, picks);
  console.log(`Wrote ${PATHS.picksLatest} — ${touched} cards touched.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
