#!/usr/bin/env node
/**
 * Earnings Edge — refresh script.
 *
 * Reads data/catalysts/earnings-watch-latest.json (recent_results +
 * events with predictions), data/sws/deep/<T>.json (snowflake.health,
 * risks[], news[]), data/surveillance.json (ASM/GSM). Applies the
 * deterministic KEC-bug-list filter (services/earningsEdge/edgeFilter.js)
 * to every resolved BEAT event, opens paper-trade ledger entries for
 * survivors, and closes existing open trades on hard-stop / trail-stop /
 * T+30 hold expiry.
 *
 * No LLM dependency, no network IO. Chained into sws-nightly.sh after
 * refresh-compounder.mjs.
 *
 * Usage:
 *   node scripts/refresh-earnings-edge.mjs
 *   node scripts/refresh-earnings-edge.mjs --dry-run
 *
 * Exit codes:
 *   0   success
 *   1   unexpected failure
 *   75  upstream earnings-watch-latest.json missing
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  EARNINGS_EDGE_FILTER,
  applyEarningsEdgeFilter,
  sizePosition,
  evaluateExit,
} from "../services/earningsEdge/edgeFilter.js";
import {
  openTrade,
  closeTrade,
  openTradesFor,
} from "../services/compounder/paperTradeLog.js";
import {
  loadRolling as loadPromoterRolling,
  computePromoterSignal,
} from "../services/promoter/nsePitIngester.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = process.cwd();

const EVENTS_PATH = path.join(ROOT, "data", "catalysts", "earnings-watch-latest.json");
const HISTORY_DIR = path.join(ROOT, "data", "catalysts", "earnings-history");
const DEEP_DIR = path.join(ROOT, "data", "sws", "deep");
const SURVEILLANCE_PATH = path.join(ROOT, "data", "surveillance.json");
const OUT_PATH = path.join(ROOT, "data", "earnings-edge", "latest.json");
const STRATEGY = "earnings_edge";

function readJson(p) {
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}

function loadSurveillance() {
  const s = readJson(SURVEILLANCE_PATH);
  if (!s) return { ASM: new Set(), GSM: new Set() };
  // Schema varies — accept arrays of symbols or {symbol, list} objects.
  const ASM = new Set();
  const GSM = new Set();
  for (const k of ["asm", "ASM"]) {
    if (Array.isArray(s[k])) s[k].forEach((x) => ASM.add(typeof x === "string" ? x : x?.symbol));
  }
  for (const k of ["gsm", "GSM"]) {
    if (Array.isArray(s[k])) s[k].forEach((x) => GSM.add(typeof x === "string" ? x : x?.symbol));
  }
  return { ASM, GSM };
}

function loadDeep(ticker) {
  return readJson(path.join(DEEP_DIR, `${ticker}.json`));
}

// Walk earnings-history/*.json + earnings-watch-latest.json:recent_results
// and merge into a deduped list of resolved BEAT events, keyed by
// (symbol, event_iso_date).
function collectResolvedBeats() {
  const out = new Map();
  const watchLatest = readJson(EVENTS_PATH);
  for (const r of watchLatest?.recent_results || []) {
    if (r.actual_verdict !== "BEAT") continue;
    const key = `${r.symbol}|${r.event_iso_date}`;
    out.set(key, { ...r, _source: "earnings-watch-latest" });
  }
  if (fs.existsSync(HISTORY_DIR)) {
    for (const f of fs.readdirSync(HISTORY_DIR).filter((n) => n.endsWith(".json")).sort()) {
      const day = readJson(path.join(HISTORY_DIR, f));
      for (const p of day?.predictions || []) {
        if (p.actual_verdict !== "BEAT") continue;
        const key = `${p.symbol}|${p.event_iso_date}`;
        // History snapshots have richer signals; prefer over the lighter
        // recent_results row.
        if (!out.has(key) || p.signals) out.set(key, { ...p, _source: f });
      }
    }
  }
  return Array.from(out.values());
}

// Compute days_held for an open trade against today_iso.
function daysBetween(isoA, isoB) {
  const a = new Date(isoA);
  const b = new Date(isoB);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return 0;
  return Math.round((b - a) / 86_400_000);
}

function parseArgs(argv) {
  const args = { dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--dry-run") args.dryRun = true;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const startedAt = new Date();
  const today_iso = startedAt.toISOString().slice(0, 10);

  if (!fs.existsSync(EVENTS_PATH)) {
    console.error(`[edge] upstream missing: ${EVENTS_PATH}`);
    process.exit(75);
  }

  const surveillance = loadSurveillance();
  console.log(`[edge] surveillance: ASM=${surveillance.ASM.size}, GSM=${surveillance.GSM.size}`);

  // Promoter-sell veto signal from PR-7 NSE PIT scraper. Absent file is
  // fine — filter just doesn't add the veto gate.
  const promoterRolling = loadPromoterRolling();
  const promoterSignal = computePromoterSignal(promoterRolling, { today_iso, windowDays: 7 });
  const promoterSymbols = Object.keys(promoterSignal);
  console.log(`[edge] promoter signal: ${promoterSymbols.length} symbols with recent activity`);

  const beats = collectResolvedBeats();
  console.log(`[edge] ${beats.length} resolved BEAT events to evaluate`);

  // Apply filter to every resolved BEAT we haven't already opened a paper
  // trade for.
  const openTickers = new Set(openTradesFor(STRATEGY).map((t) => t.ticker));
  const passed = [];
  const rejected = [];
  const rejection_tally = Object.create(null);

  for (const event of beats) {
    if (openTickers.has(event.symbol)) continue; // already in flight
    const deep = loadDeep(event.symbol);
    const verdict = applyEarningsEdgeFilter(event, { deep, surveillance, promoterSignal });
    if (verdict.passed) {
      passed.push({ event, deep, size_inr: sizePosition(event?.signals?.market_cap_inr || deep?.overview?.market_cap_inr) });
    } else {
      rejected.push({ symbol: event.symbol, reasons: verdict.reasons });
      for (const r of verdict.reasons) {
        const key = r.split(":")[0].split("<")[0].split(" ")[0];
        rejection_tally[key] = (rejection_tally[key] || 0) + 1;
      }
    }
  }

  console.log(`[edge] filter: ${passed.length} passed, ${rejected.length} rejected`);
  console.log("[edge] rejection_tally:", rejection_tally);

  // Open paper trades for survivors.
  let opened = 0;
  if (!args.dryRun) {
    for (const { event, deep, size_inr } of passed) {
      const entry_price = deep?.overview?.current_price_inr ?? null;
      openTrade(STRATEGY, {
        ticker: event.symbol,
        name: event.company || deep?.name || null,
        sector: event.sector || deep?.sector || null,
        entry_date: today_iso,
        entry_price_inr: entry_price,
        entry_snapshot: {
          actual_verdict: event.actual_verdict,
          event_iso_date: event.event_iso_date,
          size_inr,
          snowflake_health: deep?.overview?.snowflake?.health,
          risks: deep?.overview?.risks || [],
          market_cap_inr: event?.signals?.market_cap_inr || deep?.overview?.market_cap_inr,
        },
      });
      opened++;
    }
  }

  // Walk open trades, decide exits.
  const openNow = openTradesFor(STRATEGY);
  let closed = 0;
  const exit_actions = [];
  for (const trade of openNow) {
    const deep = loadDeep(trade.ticker);
    const close = deep?.overview?.current_price_inr;
    const days_held = daysBetween(trade.entry_date, today_iso);
    // Maintain peak in entry_snapshot._peak_close_inr — bump it monotonically.
    const prev_peak = Number(trade.entry_snapshot?._peak_close_inr ?? trade.entry_price_inr) || trade.entry_price_inr;
    const peak = Number.isFinite(Number(close)) ? Math.max(prev_peak, Number(close)) : prev_peak;
    if (trade.entry_snapshot && peak !== prev_peak) {
      trade.entry_snapshot._peak_close_inr = peak;
    }
    const exit = evaluateExit(
      { entry_date: trade.entry_date, entry_price_inr: trade.entry_price_inr },
      { close_price_inr: close, peak_close_inr: peak, days_held },
    );
    exit_actions.push({ ticker: trade.ticker, days_held, close, peak, action: exit.action, reason: exit.reason });
    if (exit.action === "EXIT" && !args.dryRun) {
      closeTrade(STRATEGY, trade.ticker, {
        exit_date: today_iso,
        exit_price_inr: close,
        exit_action: "EXIT",
        exit_reason: exit.reason,
      });
      closed++;
    }
  }

  const out = {
    schema_version: "earnings-edge-latest-v1",
    generated_at: startedAt.toISOString(),
    duration_ms: Date.now() - startedAt.getTime(),
    filter: EARNINGS_EDGE_FILTER,
    resolved_beats_evaluated: beats.length,
    passed_count: passed.length,
    rejected_count: rejected.length,
    rejection_tally,
    rejected_sample: rejected.slice(0, 20),
    opened_today: opened,
    closed_today: closed,
    open_trades: openTradesFor(STRATEGY),
    exit_actions: exit_actions.slice(0, 50),
  };

  if (args.dryRun) {
    console.log("[edge] DRY RUN — passed candidates:");
    for (const p of passed.slice(0, 10)) {
      console.log(`  ${p.event.symbol.padEnd(15)} sector=${(p.event.sector || "?").padEnd(20)} size=₹${(p.size_inr / 1000).toFixed(0)}k`);
    }
    return;
  }

  if (!fs.existsSync(path.dirname(OUT_PATH))) {
    fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  }
  const tmp = `${OUT_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2));
  fs.renameSync(tmp, OUT_PATH);
  console.log(`[edge] wrote ${OUT_PATH}`);
  console.log(`[edge] paper-trade ledger: +${opened} opened, -${closed} closed, ${openTradesFor(STRATEGY).length} now open`);
}

main().catch((err) => {
  console.error("[edge] unexpected failure:", err);
  process.exit(1);
});
