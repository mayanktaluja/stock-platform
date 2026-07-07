#!/usr/bin/env node
/**
 * Pillar-reweight backtest (Tier-3 / A1 evidence).
 * ================================================
 *
 * Question: would a different H/F/V/P pillar weighting have picked BETTER
 * top-30 lists than the live 22/20/18/16 over the archived history?
 *
 * Method (point-in-time, no lookahead):
 *   1. Walk the git history of data/sws/picks-latest.json (last commit per
 *      day). Each snapshot's card pool = every unique ticker that appears in
 *      any section WITH a v4_breakdown + price (~2,000 names/day). This pool
 *      is the candidate set for re-ranking — an approximation (only section
 *      members are archived), but mild reweights draw their top-30 from the
 *      near-top pool, which IS archived.
 *   2. For each candidate weight set, recompute an adjusted score per card:
 *        adj = v4_score_100 + Σ_pillar (pts_pillar / oldW) × (newW − oldW)
 *      (pts_pillar/oldW recovers the 0..1 sub-score fraction — same recovery
 *      the shadow A1 variant uses.) Re-rank the pool, take the top N.
 *   3. LIVE baseline = the SAME pool ranked by archived v4_score_100 — so
 *      pool truncation biases every candidate equally.
 *   4. Forward mark: the same ticker's price in the nearest snapshot 18–35
 *      days later (prices come from the archived files themselves — no
 *      network). Nifty benchmark from the paper-trades ledger's
 *      niftyAtSnapshot. Unresolvable picks are dropped and counted.
 *
 * Honesty: overlapping daily entries are autocorrelated (not independent
 * bets); window is ~10 weeks in ONE regime; gross of costs (identical
 * turnover assumption across candidates); pool truncation ~2k names. This
 * ranks candidates RELATIVE to live under identical bias — it is not an
 * absolute-alpha claim, and it is NOT sufficient alone to promote a reweight.
 *
 * Usage:
 *   node scripts/backtest-pillar-reweight.mjs             # human report
 *   node scripts/backtest-pillar-reweight.mjs --json
 *   node scripts/backtest-pillar-reweight.mjs --top 30 --hold-days 21
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YahooFinance from "yahoo-finance2";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");
const PICKS_PATH = "data/sws/picks-latest.json";
const LEDGER = path.join(REPO, "data", "track-record", "paper-trades-live.jsonl");
const SEED_LEDGER = path.join(REPO, "data", "track-record", "paper-trades-seed.jsonl");

// The pillar weights each scoring_version scored its cards under. Fraction
// recovery MUST use the era the card was scored in — else, once post-v4.1 cards
// accrue in the git history, applying the swap to an already-swapped card
// double-counts it. (Ripple-map finding #10.)
const WEIGHTS_BY_VERSION = {
  "sws-v4-100pt-2026-05": { health: 22, future: 20, valuation: 18, past: 16 },   // pre-v4.1
  "sws-v4.1-100pt-2026-07": { health: 20, future: 22, valuation: 18, past: 16 }, // v4.1 (now LIVE)
};
const PRE_V41 = WEIGHTS_BY_VERSION["sws-v4-100pt-2026-05"];
const LIVE_NOW = WEIGHTS_BY_VERSION["sws-v4.1-100pt-2026-07"]; // the v4.1 swap is live
function recoveryWeightsFor(version) {
  return WEIGHTS_BY_VERSION[version] || PRE_V41; // absent stamp = pre-v4.1 era
}
// Candidates all sum to 76. LIVE = the CURRENT production weighting (the swap was
// promoted, so it is the baseline now, not a candidate). The rest are the next
// hypotheses to explore against fresh out-of-sample evidence.
const CANDIDATES = {
  LIVE: LIVE_NOW,
  "GROWTH_MORE_20/24/18/14": { health: 20, future: 24, valuation: 18, past: 14 },
  "PAST_TILT_20/22/16/18": { health: 20, future: 22, valuation: 16, past: 18 },
  "HEALTH_BACK_21/21/18/16": { health: 21, future: 21, valuation: 18, past: 16 },
};

function parseArgs() {
  const out = {}; const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith("--")) { const k = a[i].slice(2); const n = a[i + 1];
      if (n === undefined || n.startsWith("--")) out[k] = true; else { out[k] = n; i++; } }
  }
  return out;
}
const CLI = parseArgs();
const TOP_N = CLI.top ? parseInt(CLI.top, 10) : 30;
const HOLD_DAYS = CLI["hold-days"] ? parseInt(CLI["hold-days"], 10) : 21;
const HOLD_MIN = HOLD_DAYS - 3, HOLD_MAX = HOLD_DAYS + 14;
const AS_JSON = !!CLI.json;

function git(args) {
  return execFileSync("git", args, { cwd: REPO, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

// Last picks-latest commit per calendar day, oldest → newest.
function dailySnapshots() {
  const raw = git(["log", "--format=%H|%ad", "--date=short", "--", PICKS_PATH]);
  const byDay = new Map(); // newest-first stream; keep FIRST seen per day (= latest that day)
  for (const line of raw.trim().split("\n")) {
    const [hash, date] = line.split("|");
    if (hash && date && !byDay.has(date)) byDay.set(date, hash);
  }
  return [...byDay.entries()].map(([date, hash]) => ({ date, hash })).sort((a, b) => a.date.localeCompare(b.date));
}

// Extract the re-rankable pool + price map from one archived picks file.
function poolFromSnapshot(hash) {
  let j;
  try { j = JSON.parse(git(["show", `${hash}:${PICKS_PATH}`])); } catch { return null; }
  const seen = new Map(); // ticker -> card
  for (const arr of Object.values(j.sections || {})) {
    if (!Array.isArray(arr)) continue;
    for (const c of arr) {
      if (!c || !c.ticker || seen.has(c.ticker)) continue;
      const bd = c.v4_breakdown;
      const px = Number(c.current_price_inr);
      if (!bd || !Number.isFinite(Number(c.v4_score_100)) || !Number.isFinite(px) || px <= 0) continue;
      seen.set(c.ticker, {
        ticker: c.ticker, px,
        v4: Number(c.v4_score_100),
        h: Number(bd.pts_health) || 0, f: Number(bd.pts_future) || 0,
        v: Number(bd.pts_valuation) || 0, p: Number(bd.pts_past) || 0,
      });
    }
  }
  return seen.size ? { pool: seen, scoringVersion: j.scoring_version || null } : null;
}

// Recover each pillar's 0..1 fraction using the weights the card was SCORED
// under (recoveryW = its era), then re-apply the candidate target weights.
function adjustedScore(card, targetW, recoveryW) {
  return card.v4
    + (card.h / recoveryW.health) * (targetW.health - recoveryW.health)
    + (card.f / recoveryW.future) * (targetW.future - recoveryW.future)
    + (card.v / recoveryW.valuation) * (targetW.valuation - recoveryW.valuation)
    + (card.p / recoveryW.past) * (targetW.past - recoveryW.past);
}

// Nifty level per date. Primary: Yahoo ^NSEI daily closes (the ledger's
// niftyAtSnapshot has a 7-week hole: V1 seed rows end 2026-05-08, live V2
// accrual restarted 2026-07-06). Fallback: the ledger map. Snapshot dates are
// calendar days while Nifty trades weekdays, so lookups walk back ≤4 days.
async function niftyByDate(fromDate, toDate) {
  const map = new Map();
  try {
    const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });
    const chart = await yf.chart("^NSEI", { period1: fromDate, period2: toDate, interval: "1d" });
    for (const q of chart?.quotes || []) {
      const d = q?.date ? new Date(q.date).toISOString().slice(0, 10) : null;
      const c = Number(q?.close);
      if (d && Number.isFinite(c) && c > 0) map.set(d, c);
    }
  } catch (e) {
    console.error(`[reweight] Yahoo ^NSEI fetch failed (${e?.message}) — falling back to ledger niftyAtSnapshot`);
  }
  ledgerNiftyInto(map);
  return map;
}
function niftyAt(map, date) {
  let d = date;
  for (let i = 0; i < 5; i++) {
    if (map.has(d)) return map.get(d);
    d = new Date(Date.parse(d) - 86400000).toISOString().slice(0, 10);
  }
  return null;
}
function ledgerNiftyInto(map) {
  for (const file of [SEED_LEDGER, LEDGER]) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const t = JSON.parse(line);
        const d = t.dateKey || (t.snapshotAt || "").slice(0, 10);
        const n = Number(t.niftyAtSnapshot);
        if (d && Number.isFinite(n) && n > 0 && !map.has(d)) map.set(d, n);
      } catch { /* skip */ }
    }
  }
  return map;
}

function daysBetween(a, b) { return (Date.parse(b) - Date.parse(a)) / 86400000; }
function median(xs) { if (!xs.length) return null; const s = xs.slice().sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; }

async function main() {
  const snaps = dailySnapshots();
  const pools = [];
  for (const s of snaps) {
    const snap = poolFromSnapshot(s.hash);
    if (snap) pools.push({ ...s, pool: snap.pool, recoveryW: recoveryWeightsFor(snap.scoringVersion) });
  }
  const nifty = pools.length
    ? await niftyByDate(pools[0].date, new Date(Date.parse(pools[pools.length - 1].date) + 3 * 86400000).toISOString().slice(0, 10))
    : new Map();

  const res = {};
  for (const k of Object.keys(CANDIDATES)) {
    res[k] = { alphas: [], returns: [], resolved: 0, unresolved: 0, hits: 0, overlapSum: 0, overlapN: 0 };
  }

  for (let i = 0; i < pools.length; i++) {
    const entry = pools[i];
    // exit snapshot: nearest later snapshot with hold in [HOLD_MIN, HOLD_MAX], prefer >= HOLD_DAYS
    let exit = null;
    for (const cand of pools.slice(i + 1)) {
      const d = daysBetween(entry.date, cand.date);
      if (d < HOLD_MIN) continue;
      if (d > HOLD_MAX) break;
      exit = cand; if (d >= HOLD_DAYS) break;
    }
    if (!exit) continue;
    const nEntry = niftyAt(nifty, entry.date), nExit = niftyAt(nifty, exit.date);
    const niftyRet = nEntry && nExit ? ((nExit - nEntry) / nEntry) * 100 : null;

    const cards = [...entry.pool.values()];
    const rw = entry.recoveryW; // era the cards in this snapshot were scored under
    const liveTop = cards.slice().sort((a, b) => adjustedScore(b, LIVE_NOW, rw) - adjustedScore(a, LIVE_NOW, rw)).slice(0, TOP_N);
    const liveSet = new Set(liveTop.map((c) => c.ticker));

    for (const [k, w] of Object.entries(CANDIDATES)) {
      const top = k === "LIVE" ? liveTop
        : cards.slice().sort((a, b) => adjustedScore(b, w, rw) - adjustedScore(a, w, rw)).slice(0, TOP_N);
      if (k !== "LIVE") {
        const overlap = top.filter((c) => liveSet.has(c.ticker)).length;
        res[k].overlapSum += overlap / TOP_N; res[k].overlapN++;
      }
      for (const c of top) {
        const exitCard = exit.pool.get(c.ticker);
        if (!exitCard) { res[k].unresolved++; continue; }
        const ret = ((exitCard.px - c.px) / c.px) * 100;
        res[k].resolved++;
        res[k].returns.push(ret);
        if (niftyRet != null) {
          const alpha = ret - niftyRet;
          res[k].alphas.push(alpha);
          if (alpha > 0) res[k].hits++;
        }
      }
    }
  }

  const report = {
    schema: "pillar-reweight-backtest-v1",
    window: pools.length ? `${pools[0].date} → ${pools[pools.length - 1].date}` : "no snapshots",
    snapshots: pools.length, top_n: TOP_N, hold_days: HOLD_DAYS,
    honesty: "Point-in-time pool re-rank from archived section cards (~2k names/day). Overlapping daily entries are autocorrelated; single regime; gross of costs; pool truncation biases all candidates equally. Relative ranking evidence only — NOT sufficient alone to promote a reweight.",
    candidates: {},
  };
  for (const [k, r] of Object.entries(res)) {
    report.candidates[k] = {
      weights: CANDIDATES[k],
      resolved: r.resolved, unresolved: r.unresolved,
      hit_rate_pct: r.alphas.length ? +(100 * r.hits / r.alphas.length).toFixed(1) : null,
      median_alpha_pct: r.alphas.length ? +median(r.alphas).toFixed(2) : null,
      mean_alpha_pct: r.alphas.length ? +(r.alphas.reduce((a, b) => a + b, 0) / r.alphas.length).toFixed(2) : null,
      median_return_pct: r.returns.length ? +median(r.returns).toFixed(2) : null,
      avg_overlap_with_live_pct: r.overlapN ? +(100 * r.overlapSum / r.overlapN).toFixed(0) : null,
    };
  }

  if (AS_JSON) { console.log(JSON.stringify(report, null, 2)); return; }
  console.log(`\n=== Pillar-reweight backtest — top-${TOP_N}, ~${HOLD_DAYS}d hold, ${report.snapshots} snapshots (${report.window}) ===`);
  console.log(report.honesty + "\n");
  const rows = Object.entries(report.candidates);
  console.log("candidate                 H/F/V/P        n     hit%   med-α    mean-α   overlap");
  for (const [k, c] of rows) {
    const w = c.weights;
    console.log(
      `${k.padEnd(24)} ${String(`${w.health}/${w.future}/${w.valuation}/${w.past}`).padEnd(13)} ${String(c.resolved).padStart(5)}  ${String(c.hit_rate_pct ?? "—").padStart(5)}  ${String(c.median_alpha_pct ?? "—").padStart(6)}  ${String(c.mean_alpha_pct ?? "—").padStart(7)}   ${c.avg_overlap_with_live_pct != null ? c.avg_overlap_with_live_pct + "%" : "—"}`
    );
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
