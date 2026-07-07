#!/usr/bin/env node
/**
 * Tier-0 unbiased backtest harness for the REAL picks pipeline.
 * ============================================================
 *
 * WHY THIS EXISTS (see ~/.claude/plans/brainstorm-india-stock-picking-logic-*.md §1, Tier-0):
 *
 * The widely-cited "−14.7% alpha" number comes from `scripts/paper-trade-honest.mjs`,
 * which RE-SCORES stocks with the LEGACY `fundamentals.js` engine on synthetic monthly
 * scan dates — it never touches `computeV4Score` or `buildLeaderboard`. So it does not
 * measure the pipeline we actually ship.
 *
 * This harness instead reads the ACTUAL historical `data/sws/picks-latest.json` out of
 * git history — i.e. exactly what `buildLeaderboard` published on each past date — and
 * forward-prices those real picks. That makes it:
 *   • point-in-time & survivorship-free (uses the snapshot as-of the date, not today's list)
 *   • a measurement of the real V4 + section-selection output, not a legacy proxy
 *   • cost-net (0.5% round-trip) and benchmarked vs Nifty (^NSEI)
 *   • regime-split (via data/macroRegime-history/*.jsonl)
 *
 * HONEST LIMITATION (logged in every run, never silently capped): the point-in-time picks
 * ledger only starts 2026-04-28 (~when picks-latest.json began being committed nightly), so
 * only SHORT holds (≈1 month, some 2 months) have matured. Longer horizons report
 * n_resolved≈0 until the ledger ages — that is expected and shown, not hidden.
 *
 * This is the PROMOTION GATE: no 🔴 score / 🟠 section change goes live without beating V4
 * out-of-sample on this instrument in ≥2 regimes. It edits NOTHING — additive new file.
 *
 * Usage:
 *   node scripts/backtest-buildleaderboard.mjs                      # human report, default holds 1m,2m,3m
 *   node scripts/backtest-buildleaderboard.mjs --json               # machine-readable
 *   node scripts/backtest-buildleaderboard.mjs --holds 1m,3m        # pick horizons
 *   node scripts/backtest-buildleaderboard.mjs --sample 5           # every 5th git snapshot (default)
 *   node scripts/backtest-buildleaderboard.mjs --top 30             # cap picks per section per snapshot
 *   node scripts/backtest-buildleaderboard.mjs --sections top_ranked_30_v4,best_to_buy_now
 *   node scripts/backtest-buildleaderboard.mjs --friction 0.5       # round-trip cost in pct points
 *   node scripts/backtest-buildleaderboard.mjs --max-symbols 400    # bound Yahoo fetch
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YahooFinance from "yahoo-finance2";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");
const PICKS_PATH = "data/sws/picks-latest.json";
const REGIME_HISTORY_DIR = path.join(REPO, "data", "macroRegime-history");
const OUT_JSON = path.join(REPO, "data", "track-record", "buildleaderboard-backtest-latest.json");

const NIFTY_SYMBOL = "^NSEI";
const CONCURRENCY = 6;

// Buy-side sections worth measuring. `avoid` is a short/negative list (would need a
// sign-flip), `top_ranked_30_v3` is a legacy alias of v4, `insider_buying` is dead
// (null data universe-wide), `upcoming_earnings` is event-horizon — all excluded by
// default. Override with --sections.
const DEFAULT_SECTIONS = [
  "top_ranked_30_v4",
  "best_to_buy_now",
  "deep_value",
  "growing_sector_value",
  "quality_growth",
  "best_fundamentals",
  "midterm",
  "dividend_aristocrats",
  "smallcap_gems",
  "snowflake_gap_lab",
];

// ---------------- CLI ----------------
function parseArgs() {
  const out = {};
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith("--")) {
      const key = a[i].slice(2);
      const next = a[i + 1];
      if (next === undefined || next.startsWith("--")) out[key] = true;
      else { out[key] = next; i++; }
    }
  }
  return out;
}
const CLI = parseArgs();
const HOLDS = String(CLI.holds || "1m,2m,3m").split(",").map((s) => s.trim()).filter(Boolean);
const SAMPLE = CLI.sample !== undefined ? Math.max(1, parseInt(CLI.sample, 10)) : 5;
const TOP_N = CLI.top !== undefined ? Math.max(1, parseInt(CLI.top, 10)) : 30;
const FRICTION_PCT = CLI.friction !== undefined ? parseFloat(CLI.friction) : 0.5;
const MAX_SYMBOLS = CLI["max-symbols"] !== undefined ? parseInt(CLI["max-symbols"], 10) : 600;
const SECTIONS = CLI.sections ? String(CLI.sections).split(",").map((s) => s.trim()) : DEFAULT_SECTIONS;
const AS_JSON = !!CLI.json;
const THIN_N = 10; // below this, metrics are shown but flagged "thin"

// ---------------- date helpers ----------------
function toDateStr(d) {
  const dt = d instanceof Date ? d : new Date(d);
  return dt.toISOString().slice(0, 10);
}
function addCalendarMonths(dateStr, months) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCMonth(d.getUTCMonth() + months);
  return toDateStr(d);
}
function holdToMonths(h) {
  const m = /^(\d+)m$/.exec(h);
  return m ? parseInt(m[1], 10) : null;
}
const TODAY = toDateStr(new Date());

// ---------------- git snapshot reader ----------------
function git(args) {
  return execFileSync("git", args, { cwd: REPO, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}
function listPicksCommits() {
  // newest -> oldest
  const raw = git(["log", "--follow", "--format=%H|%ad", "--date=short", "--", PICKS_PATH]);
  return raw.trim().split("\n").filter(Boolean).map((line) => {
    const [hash, date] = line.split("|");
    return { hash, date };
  });
}
function readPicksAtCommit(hash) {
  try {
    const raw = git(["show", `${hash}:${PICKS_PATH}`]);
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ---------------- regime history ----------------
function loadRegimeHistory() {
  const events = [];
  if (fs.existsSync(REGIME_HISTORY_DIR)) {
    for (const f of fs.readdirSync(REGIME_HISTORY_DIR)) {
      if (!f.endsWith(".jsonl")) continue;
      const lines = fs.readFileSync(path.join(REGIME_HISTORY_DIR, f), "utf8").trim().split("\n");
      for (const ln of lines) {
        if (!ln.trim()) continue;
        try {
          const j = JSON.parse(ln);
          const at = j.generatedAt || j.date || j.ts;
          if (at && j.regime) events.push({ at: toDateStr(at), regime: String(j.regime) });
        } catch { /* skip */ }
      }
    }
  }
  events.sort((a, b) => a.at.localeCompare(b.at));
  return events;
}
function regimeAt(events, dateStr) {
  let cur = "UNKNOWN";
  for (const e of events) {
    if (e.at <= dateStr) cur = e.regime; else break;
  }
  return cur;
}

// ---------------- Yahoo ----------------
const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });
function tickerToYahoo(ticker) {
  const t = String(ticker || "").trim().toUpperCase();
  if (!t) return null;
  if (t.includes(".")) return t;            // already suffixed
  return `${t}.NS`;                          // NSE default
}
async function fetchHistory(symbol, period1) {
  try {
    const result = await yf.chart(symbol, { period1, period2: TODAY, interval: "1d" });
    if (!result || !result.quotes || !result.quotes.length) return null;
    const bars = [];
    for (const q of result.quotes) {
      if (q.close == null) continue;
      const adj = q.adjclose != null ? q.adjclose : q.close;
      bars.push({ date: toDateStr(q.date), close: adj });
    }
    return bars.length ? bars : null;
  } catch (err) {
    return null;
  }
}
async function fetchAll(symbols, period1) {
  const hist = new Map();
  const queue = [...symbols];
  let done = 0;
  const total = queue.length;
  async function worker() {
    while (queue.length) {
      const sym = queue.shift();
      const bars = await fetchHistory(sym, period1);
      if (bars) hist.set(sym, bars);
      done++;
      if (!AS_JSON && (done % 25 === 0 || done === total)) {
        process.stderr.write(`  fetched ${done}/${total}\n`);
      }
    }
  }
  if (!AS_JSON) process.stderr.write(`Fetching ${total} symbols (concurrency ${CONCURRENCY})...\n`);
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return hist;
}
// close on-or-before dateStr (last bar <= date)
function closeAtOrBefore(bars, dateStr) {
  let v = null;
  for (const b of bars) { if (b.date <= dateStr) v = b.close; else break; }
  return v;
}

// ---------------- stats ----------------
function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function mean(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; }

// ---------------- main ----------------
async function main() {
  const commits = listPicksCommits();
  if (!commits.length) {
    console.error("No git history for " + PICKS_PATH);
    process.exit(1);
  }
  // sample newest->oldest every SAMPLE-th
  const sampled = commits.filter((_, i) => i % SAMPLE === 0);
  const oldest = commits[commits.length - 1].date;
  const newest = commits[0].date;

  if (!AS_JSON) {
    process.stderr.write(`Point-in-time picks history: ${commits.length} commits ${oldest} → ${newest}\n`);
    process.stderr.write(`Sampling every ${SAMPLE} → ${sampled.length} snapshots; sections: ${SECTIONS.join(", ")}\n`);
  }

  const regimeEvents = loadRegimeHistory();

  // Collect entries: {section, ticker, symbol, entryDate}
  const entries = [];
  const symbolSet = new Set();
  for (const c of sampled) {
    const picks = readPicksAtCommit(c.hash);
    if (!picks || !picks.sections) continue;
    for (const sec of SECTIONS) {
      const rows = Array.isArray(picks.sections[sec]) ? picks.sections[sec] : [];
      for (const row of rows.slice(0, TOP_N)) {
        const ticker = row.ticker || row.symbol;
        const symbol = tickerToYahoo(ticker);
        if (!symbol) continue;
        entries.push({ section: sec, ticker, symbol, entryDate: c.date });
        symbolSet.add(symbol);
      }
    }
  }

  let symbols = [...symbolSet];
  if (symbols.length > MAX_SYMBOLS) {
    if (!AS_JSON) process.stderr.write(`[cap] ${symbols.length} unique symbols > --max-symbols ${MAX_SYMBOLS}; capping (logged, not silent).\n`);
    symbols = symbols.slice(0, MAX_SYMBOLS);
  }
  const symbolAllowed = new Set(symbols);
  symbols.push(NIFTY_SYMBOL);

  const histories = await fetchAll(symbols, oldest);
  const niftyBars = histories.get(NIFTY_SYMBOL);
  if (!niftyBars) { console.error("Failed to fetch Nifty benchmark ^NSEI"); process.exit(1); }

  // Evaluate each entry × hold horizon.
  // agg[section][hold] = { alphas:[], hits, resolved, open, noData }
  const agg = {};
  const aggRegime = {}; // aggRegime[section][hold][regime] = {alphas, hits, resolved}
  let totalResolved = 0, totalOpen = 0, totalNoData = 0;

  for (const e of entries) {
    if (!symbolAllowed.has(e.symbol)) continue;
    const bars = histories.get(e.symbol);
    agg[e.section] = agg[e.section] || {};
    aggRegime[e.section] = aggRegime[e.section] || {};
    for (const hold of HOLDS) {
      const months = holdToMonths(hold);
      if (months == null) continue;
      agg[e.section][hold] = agg[e.section][hold] || { alphas: [], hits: 0, resolved: 0, open: 0, noData: 0 };
      aggRegime[e.section][hold] = aggRegime[e.section][hold] || {};
      const slot = agg[e.section][hold];
      const exitDate = addCalendarMonths(e.entryDate, months);
      if (exitDate > TODAY) { slot.open++; totalOpen++; continue; } // not matured — honest
      if (!bars) { slot.noData++; totalNoData++; continue; }
      const entryPx = closeAtOrBefore(bars, e.entryDate);
      const exitPx = closeAtOrBefore(bars, exitDate);
      const nEntry = closeAtOrBefore(niftyBars, e.entryDate);
      const nExit = closeAtOrBefore(niftyBars, exitDate);
      if (!entryPx || !exitPx || !nEntry || !nExit || entryPx <= 0 || nEntry <= 0) { slot.noData++; totalNoData++; continue; }
      const pickRetNet = ((exitPx - entryPx) / entryPx) * 100 - FRICTION_PCT;
      const niftyRet = ((nExit - nEntry) / nEntry) * 100;
      const alpha = pickRetNet - niftyRet;
      slot.alphas.push(alpha);
      if (alpha > 0) slot.hits++;
      slot.resolved++;
      totalResolved++;
      const reg = regimeAt(regimeEvents, e.entryDate);
      const rslot = (aggRegime[e.section][hold][reg] = aggRegime[e.section][hold][reg] || { alphas: [], hits: 0, resolved: 0 });
      rslot.alphas.push(alpha);
      if (alpha > 0) rslot.hits++;
      rslot.resolved++;
    }
  }

  // Build report structure
  const report = {
    schema: "buildleaderboard-backtest-v1",
    generated_for_commit_range: { oldest, newest, commits: commits.length, sampled: sampled.length },
    params: { holds: HOLDS, sample_every: SAMPLE, top_per_section: TOP_N, friction_pct: FRICTION_PCT, benchmark: NIFTY_SYMBOL },
    honesty: "Point-in-time from git history of picks-latest.json (survivorship-free). Cost-net; vs Nifty 50 price index. Overlapping daily entries are autocorrelated. Only short holds have matured given the ~" +
      Math.round((Date.parse(newest) - Date.parse(oldest)) / 86400000) + "-day ledger — longer horizons show n_resolved≈0 until it ages. Not a durable forward edge; a measured, growing instrument.",
    totals: { resolved: totalResolved, open_not_matured: totalOpen, no_data: totalNoData },
    sections: {},
  };
  for (const sec of SECTIONS) {
    report.sections[sec] = {};
    for (const hold of HOLDS) {
      const slot = agg[sec]?.[hold];
      if (!slot) { report.sections[sec][hold] = { resolved: 0, open: 0 }; continue; }
      const byRegime = {};
      for (const [reg, rs] of Object.entries(aggRegime[sec]?.[hold] || {})) {
        byRegime[reg] = { n: rs.resolved, hit_rate_pct: rs.resolved ? +(100 * rs.hits / rs.resolved).toFixed(1) : null, median_alpha_pct: rs.alphas.length ? +median(rs.alphas).toFixed(2) : null };
      }
      report.sections[sec][hold] = {
        resolved: slot.resolved,
        open_not_matured: slot.open,
        no_data: slot.noData,
        thin: slot.resolved < THIN_N,
        hit_rate_pct: slot.resolved ? +(100 * slot.hits / slot.resolved).toFixed(1) : null,
        median_alpha_pct: slot.alphas.length ? +median(slot.alphas).toFixed(2) : null,
        mean_alpha_pct: slot.alphas.length ? +mean(slot.alphas).toFixed(2) : null,
        regimes_covered: Object.keys(byRegime).length,
        by_regime: byRegime,
      };
    }
  }

  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  fs.writeFileSync(OUT_JSON, JSON.stringify(report, null, 2));

  if (AS_JSON) { process.stdout.write(JSON.stringify(report, null, 2) + "\n"); return; }

  // human table
  console.log("\n=== Tier-0 buildLeaderboard backtest (real historical picks, cost-net vs Nifty) ===");
  console.log(report.honesty + "\n");
  console.log(`Snapshots: ${sampled.length}/${commits.length}  |  resolved: ${totalResolved}  open(not matured): ${totalOpen}  no-data: ${totalNoData}\n`);
  const pad = (s, n) => String(s).padEnd(n);
  const padL = (s, n) => String(s).padStart(n);
  for (const hold of HOLDS) {
    console.log(`── hold ${hold} ──`);
    console.log(pad("section", 24), padL("n", 5), padL("hit%", 7), padL("medα%", 8), padL("open", 6), padL("regimes", 8));
    for (const sec of SECTIONS) {
      const r = report.sections[sec][hold];
      if (!r || (!r.resolved && !r.open)) continue;
      console.log(
        pad(sec, 24),
        padL(r.resolved ?? 0, 5),
        padL(r.hit_rate_pct == null ? "—" : r.hit_rate_pct, 7),
        padL(r.median_alpha_pct == null ? "—" : r.median_alpha_pct, 8),
        padL(r.open_not_matured ?? 0, 6),
        padL(r.regimes_covered ?? 0, 8) + (r.thin ? "  (thin)" : "")
      );
    }
    console.log("");
  }
  console.log(`Wrote ${path.relative(REPO, OUT_JSON)}`);
}

// Pure helpers exported for unit testing (no network). Kept deterministic so the
// harness's point-in-time / no-lookahead guarantees can be asserted in test/.
export { toDateStr, addCalendarMonths, holdToMonths, regimeAt, closeAtOrBefore, tickerToYahoo, median, mean };

// Only run the network-driven backtest when invoked directly as a CLI, so tests
// can import the pure helpers without triggering Yahoo fetches.
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
