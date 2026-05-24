#!/usr/bin/env node
/**
 * Refresh the 5x-strategy outputs — runs nightly after refresh-earnings.
 *
 * Reads (all on disk; no network):
 *   - data/sws/picks-latest.json          (V3-scored universe)
 *   - data/macroRegime.json               (regime singleton)
 *   - data/catalysts/earnings-watch-latest.json
 *   - data/catalysts/dividends-upcoming.json
 *   - data/catalysts/nse-bulk-block-rolling.json
 *   - data/catalysts/nse-announcements-rolling.json
 *
 * Writes:
 *   - data/strategy/multibagger-scores-latest.json
 *   - data/strategy/catalyst-slate-latest.json
 *   - data/strategy/multibagger-health-latest.json
 *   - data/strategy/history/<YYYY-MM-DD>.json (Sunday or first-of-day)
 *
 * Budget: ~90s. Chained into scripts/sws-nightly.sh after
 * refresh-earnings.mjs. NSE calls are absent — this stage is pure
 * disk-to-disk so Vercel can read the JSON.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { scoreCandidate } from "../services/multibagger/multibaggerScorer.js";
import { buildCatalystSlate } from "../services/multibagger/catalystComposite.js";
import { buildHealthSummary, formatHealthOneLiner } from "../services/multibagger/multibaggerHealth.js";
import { pillarsOpen } from "../services/multibagger/regimeGate.js";
import { shouldSnapshotToday, writeSnapshot } from "../services/multibagger/multibaggerHistoryArchive.js";
import { evaluatePortfolioRisk } from "../services/multibagger/riskManager.js";
import { markToMarket, readPortfolio } from "../services/paperTrade/multibaggerPortfolioService.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

function readJsonSafe(rel) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf8")); }
  catch { return null; }
}

function atomicWriteJson(rel, obj) {
  const target = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, target);
}

function today_iso() {
  return new Date().toISOString().slice(0, 10);
}

function loadDeepBrief(ticker) {
  const slug = String(ticker || "").toUpperCase().replace(/[^A-Z0-9_-]/g, "");
  if (!slug) return null;
  return readJsonSafe(`data/sws/deep/${slug}.json`);
}

async function main() {
  const t0 = Date.now();
  const TODAY = today_iso();
  const macroRegime = readJsonSafe("data/macroRegime.json");
  const picks = readJsonSafe("data/sws/picks-latest.json");
  const earnings = readJsonSafe("data/catalysts/earnings-watch-latest.json");
  const dividends = readJsonSafe("data/catalysts/dividends-upcoming.json");
  const bulkBlock = readJsonSafe("data/catalysts/nse-bulk-block-rolling.json");
  const announcements = readJsonSafe("data/catalysts/nse-announcements-rolling.json");

  const picks_rows = collectAllPicks(picks);
  console.log(`[5x] today=${TODAY} regime=${macroRegime?.regime || "?"} picks_rows=${picks_rows.length}`);

  // Score the universe — score each unique ticker once.
  const seen = new Set();
  const scored = [];
  for (const row of picks_rows) {
    if (!row || !row.ticker) continue;
    if (seen.has(row.ticker)) continue;
    seen.add(row.ticker);
    const deep = loadDeepBrief(row.ticker);
    const overview = mergeOverview(row, deep);
    const yearly_history = deep?.fiscal?.yearly_history || [];
    const news = deep?.news || [];
    const announcements_for_symbol = (announcements?.announcements || []).filter((a) => a.symbol === row.ticker);
    const verdict = scoreCandidate({
      ticker: row.ticker,
      sector: row.sector || deep?.sector || null,
      overview,
      v4_breakdown: row.v4_breakdown || row,
      data_completeness_pct: row.data_completeness_pct ?? null,
      news,
      yearly_history,
      most_recent_reported_date: overview.most_recent_reported_date,
      macroRegime,
      sector_ttm_return_pct: null, // future enhancement: load sector-ttm.json
      pledge_events: [],
      pledge_announcements: announcements_for_symbol,
      // Skip liquidity gate during universe scoring — re-checked at
      // entry-time in positionSizer with the actual tier-sized position.
      position_size_inr: null,
      now_iso: new Date().toISOString(),
    });
    scored.push(verdict);
  }

  scored.sort((a, b) => b.score_0_100 - a.score_0_100);

  const summary = {
    schema_version: "multibagger-scores-v1",
    today_iso: TODAY,
    built_at: new Date().toISOString(),
    universe_size: scored.length,
    five_x_count: scored.filter((s) => s.verdict === "5X_CANDIDATE").length,
    high_conviction_count: scored.filter((s) => s.verdict === "HIGH_CONVICTION").length,
    watch_count: scored.filter((s) => s.verdict === "WATCH").length,
    hard_reject_count: scored.filter((s) => s.verdict === "HARD_REJECT").length,
    top_50: scored.slice(0, 50),
    macro_regime: macroRegime?.regime || null,
  };
  atomicWriteJson("data/strategy/multibagger-scores-latest.json", summary);

  // Catalyst slate
  const portfolio = readPortfolio();
  const holdingsByTicker = Object.fromEntries(
    portfolio.positions.map((p) => [p.ticker, { avg_price_inr: p.avg_entry_price_inr }])
  );
  const slate = buildCatalystSlate({
    earnings_watch: earnings,
    dividends_upcoming: dividends,
    bulk_block: bulkBlock,
    current_holdings: holdingsByTicker,
    today_iso: TODAY,
  });
  atomicWriteJson("data/strategy/catalyst-slate-latest.json", slate);

  // Mark current portfolio to market (best-effort price map from deep briefs)
  const priceMap = Object.fromEntries(portfolio.positions.map((p) => {
    const d = loadDeepBrief(p.ticker);
    return [p.ticker, d?.overview?.current_price_inr ?? p.avg_entry_price_inr];
  }));
  const mtm = markToMarket(priceMap);

  // Risk + regime
  const peakValue = Math.max(portfolio.starting_capital_inr, mtm.portfolio_value_inr);
  const risk = evaluatePortfolioRisk({ current_value_inr: mtm.portfolio_value_inr, peak_value_inr: peakValue });
  const regime_open = pillarsOpen({ macroRegime });

  // Health summary
  const health = buildHealthSummary({
    macroRegime,
    scores_built_at_iso: summary.built_at,
    candidates: scored.slice(0, 200),
    portfolio_risk: risk,
    last_decision_ts_iso: null, // optional — readDecisions can supply later
    previous_regime_open: null,
    current_regime_open: regime_open,
  });
  atomicWriteJson("data/strategy/multibagger-health-latest.json", health);

  // History snapshot (Sunday or forced)
  if (shouldSnapshotToday({ today_iso: TODAY })) {
    writeSnapshot({
      type: "calendar_sunday",
      today_iso: TODAY,
      portfolio_mtm: mtm,
      scorer_summary: { candidate_count: scored.length, five_x_count: summary.five_x_count, high_conviction_count: summary.high_conviction_count, built_at_iso: summary.built_at },
      regime_open: { ...regime_open, macroRegime: macroRegime?.regime },
      risk_state: risk.state,
    });
  }

  const elapsed = (Date.now() - t0) / 1000;
  console.log(`[5x] done in ${elapsed.toFixed(1)}s · 5X=${summary.five_x_count} · HC=${summary.high_conviction_count} · WATCH=${summary.watch_count} · ${health.alerts.length} alerts`);
  console.log(`[5x] ${formatHealthOneLiner(health)}`);
  if (health.alerts.length) for (const a of health.alerts) console.log(`[5x] ALERT: ${a}`);
}

function collectAllPicks(picks) {
  if (!picks?.sections) return [];
  const rows = [];
  for (const section of Object.values(picks.sections)) {
    if (Array.isArray(section)) rows.push(...section);
  }
  return rows;
}

function mergeOverview(pickRow, deep) {
  const ovDeep = deep?.overview || {};
  return {
    market_cap_inr: pickRow.market_cap_inr ?? ovDeep.market_cap_inr ?? null,
    market_cap_band: pickRow.market_cap_band ?? ovDeep.market_cap_band ?? null,
    upside_pct: pickRow.upside_pct ?? ovDeep.upside_pct ?? null,
    fair_value_inr: pickRow.fair_value_inr ?? ovDeep.fair_value_inr ?? null,
    current_price_inr: pickRow.current_price_inr ?? ovDeep.current_price_inr ?? null,
    last_close_inr: ovDeep.last_close_inr ?? null,
    snowflake: ovDeep.snowflake || {},
    rewards: ovDeep.rewards || [],
    risks: ovDeep.risks || [],
    returns_pct: ovDeep.returns_pct || {},
    average_daily_volume_30d: ovDeep.average_daily_volume_30d ?? null,
    most_recent_reported_date: ovDeep.most_recent_reported_date ?? null,
    adv_inr_30d: null,
  };
}

main().catch((e) => {
  console.error("[5x] FATAL", e);
  process.exit(1);
});
