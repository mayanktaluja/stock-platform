#!/usr/bin/env node
// backtest-entry-band-mae.mjs — PR-1 "evidence engine" for the entry-timing redesign.
//
// Measures the ACTUAL post-flag drawdown (MAE) of the Picks-tab "Actionable now"
// badge (price <= 0.85xFV via buildEntryBand) by replaying the git history of
// data/sws/picks-latest.json (committed nightly), then replays the candidate
// FALLING_KNIFE / ENTRY_CONFIRMED / STABILIZING rules from entryTimingConfig.js
// against every historical flag.
//
// CRITICAL history facts this script encodes:
//   - returns_pct appears on rows only from 2026-05-25 (commit 532066db28) -> window floor.
//   - The STORED entry_band field only exists from 2026-06-16 -> we RECOMPUTE the
//     band per historical commit via the pure buildEntryBand (never read stored entry_band).
//   - A FV-reconcile code change on 2026-06-15 shifts fair values as an artifact ->
//     flags whose transition spans 2026-06-14..2026-06-17 are stratified out of the headline.
//
// Approximations (also emitted in the JSON notes[]):
//   - Horizons T+5/T+10/T+21 TRADING days are approximated with CALENDAR-day offsets
//     between commit timestamps (nightly ~1/day cadence; gaps make horizons slightly
//     conservative, weekend commits slightly optimistic).
//   - buildEntryBand is evaluated with now = the commit timestamp, so the 96h
//     freshness gate behaves as it did at snapshot time.
//   - fifty_two_week is absent on historical rows, so the KNIFE 52w-drawdown leg and
//     the CONFIRMED off-the-floor leg are SKIPPED (degraded classifier, noted).
//   - KNIFE_EXIT hysteresis is not applied — classification is point-in-time at the flag.
//
// Usage:
//   node scripts/backtest-entry-band-mae.mjs          # human report + writes data/strategy/entry-band-mae.json
//   node scripts/backtest-entry-band-mae.mjs --json   # prints the JSON instead
//
// Exits 0 always; errors are reported inside the output.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildEntryBand } from "../services/swsIndiaSectionPolicy.js";
import { KNIFE, KNIFE_EXIT, CONFIRMED } from "../services/entry/entryTimingConfig.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const PICKS_PATH = "data/sws/picks-latest.json";
const OUT_PATH = path.join(REPO_ROOT, "data", "strategy", "entry-band-mae.json");

const WINDOW_FLOOR_MS = Date.parse("2026-05-25T00:00:00Z"); // returns_pct exists from 532066db28
const EPOCH_FROM = "2026-06-14"; // FV-reconcile artifact window (inclusive)
const EPOCH_TO = "2026-06-17";
const FV_MOVE_THRESHOLD_PCT = 2; // |dFV| > 2% between the two commits -> fv_move stratum
const HORIZONS = [5, 10, 21];
const MAX_BUFFER = 256 * 1024 * 1024; // picks-latest.json is ~6MB; git show needs headroom

// ---------------------------------------------------------------------------
// Pure math helpers (exported for test/backtestEntryBandMae.test.mjs — no git).
// ---------------------------------------------------------------------------

export const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const round2 = (v) => (isNum(v) ? Math.round(v * 100) / 100 : null);

export function avg(values) {
  const v = values.filter(isNum);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

export function median(values) {
  const v = values.filter(isNum).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/**
 * Percentile rank: fraction of `sortedValues` strictly below `value`.
 * `sortedValues` must be ascending. Returns null when unrankable.
 */
export function percentileRank(sortedValues, value) {
  if (!Array.isArray(sortedValues) || sortedValues.length === 0 || !isNum(value)) return null;
  let lo = 0;
  let hi = sortedValues.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sortedValues[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo / sortedValues.length;
}

/**
 * Forward MAE from an entry price over day-offset observations.
 * observations: [{ day, px }] with day = whole calendar days after the flag (day > 0).
 * A horizon is "resolved" only if a price exists at/after the horizon boundary
 * AND the window has at least one in-window price; unresolved = right-censored.
 * MAE_h = min over window (day <= h) of (px/entry - 1) * 100 (per the plan, no zero floor).
 */
export function computeForwardStats(entryPx, observations, opts = {}) {
  const horizons = opts.horizons || HORIZONS;
  const fairValue = isNum(opts.fairValue) && opts.fairValue > 0 ? opts.fairValue : null;
  const invalidationMult = isNum(opts.invalidationMult) ? opts.invalidationMult : 0.92;
  const out = { horizons: {}, trough_day: null, trough_mae_pct: null, touched_075fv: null, touched_invalidation: null };
  const obs = (observations || [])
    .filter((o) => o && isNum(o.day) && o.day > 0 && isNum(o.px) && o.px > 0)
    .sort((a, b) => a.day - b.day);
  if (!isNum(entryPx) || entryPx <= 0) {
    for (const h of horizons) out.horizons[`t${h}`] = { resolved: false, mae_pct: null };
    return out;
  }
  for (const h of horizons) {
    const window = obs.filter((o) => o.day <= h);
    const resolved = window.length > 0 && obs.some((o) => o.day >= h);
    out.horizons[`t${h}`] = {
      resolved,
      mae_pct: resolved ? round2(Math.min(...window.map((o) => (o.px / entryPx - 1) * 100))) : null,
    };
  }
  const maxH = Math.max(...horizons);
  const window = obs.filter((o) => o.day <= maxH);
  if (window.length) {
    let trough = window[0];
    for (const o of window) if (o.px < trough.px) trough = o;
    out.trough_day = trough.day;
    out.trough_mae_pct = round2((trough.px / entryPx - 1) * 100);
    out.touched_075fv = fairValue ? window.some((o) => o.px <= 0.75 * fairValue) : null;
    out.touched_invalidation = window.some((o) => o.px <= invalidationMult * entryPx);
  }
  return out;
}

/**
 * Point-in-time candidate-rule classifier (no hysteresis, no 52w legs — data absent
 * historically, degraded per notes). Inputs are percent returns + a 0..1 percentile.
 */
export function classifyFlag({ r1m = null, r3m = null, r7d = null, pct3m = null } = {}) {
  const knife =
    (isNum(r1m) && r1m <= KNIFE.R1M_MAX) ||
    (isNum(r3m) && r3m <= KNIFE.R3M_MAX) ||
    (isNum(r7d) && r7d <= KNIFE.R7D_MAX) ||
    (isNum(r1m) && isNum(r3m) && isNum(pct3m) &&
      r1m < 0 && r3m < 0 && pct3m < KNIFE.SLOW_BLEEDER_PCT3M_MAX);
  if (knife) return "FALLING_KNIFE";
  if (isNum(r1m) && isNum(pct3m) && r1m > CONFIRMED.R1M_MIN && pct3m >= CONFIRMED.PCT3M_MIN) {
    return "ENTRY_CONFIRMED";
  }
  return "STABILIZING";
}

/**
 * Stratum for a flag transition: fv_reconcile_epoch when either commit date falls in
 * the 2026-06-14..2026-06-17 FV-reconcile artifact window; else fv_move when the
 * fair value shifted > 2% between the two commits; else price_move.
 */
export function classifyFlagCause({ prevFv = null, curFv = null, flagDateIso = "", prevDateIso = "" } = {}) {
  const d1 = String(flagDateIso).slice(0, 10);
  const d0 = String(prevDateIso || "").slice(0, 10);
  if ((d1 >= EPOCH_FROM && d1 <= EPOCH_TO) || (d0 && d0 >= EPOCH_FROM && d0 <= EPOCH_TO)) {
    return "fv_reconcile_epoch";
  }
  if (isNum(prevFv) && prevFv > 0 && isNum(curFv) &&
    Math.abs(curFv / prevFv - 1) * 100 > FV_MOVE_THRESHOLD_PCT) {
    return "fv_move";
  }
  return "price_move";
}

/**
 * Flag-transition detector over per-commit recomputed band states (oldest -> newest).
 * perCommit: [{ date, bands: { TICKER: { entry_state, fresh_buy_eligible, px, fv, ... } } }]
 * where bands covers the best_to_buy_now cohort only.
 *
 * FLAG = transition into (BUY_ZONE && fresh_buy_eligible) from
 * (absent | NO_BUY_ABOVE | STAGGER_ONLY | ineligible-BUY_ZONE) at the immediately
 * preceding commit. In-flag rows at the FIRST commit are left-censored (excluded
 * from MAE cohorts, counted).
 */
export function detectFlags(perCommit) {
  const flags = [];
  const leftCensored = [];
  const inFlag = (s) => !!s && s.entry_state === "BUY_ZONE" && s.fresh_buy_eligible === true;
  for (let i = 0; i < perCommit.length; i++) {
    const cur = perCommit[i];
    const prev = i > 0 ? perCommit[i - 1] : null;
    for (const [ticker, st] of Object.entries(cur.bands || {})) {
      if (!inFlag(st)) continue;
      if (!prev) {
        leftCensored.push({ ticker, date: cur.date });
        continue;
      }
      const p = (prev.bands || {})[ticker] || null;
      if (inFlag(p)) continue; // still flagged — not a new transition
      const from_state = !p
        ? "absent"
        : p.entry_state === "BUY_ZONE"
          ? "ineligible"
          : p.entry_state || "absent";
      flags.push({ ticker, commit_index: i, date: cur.date, from_state, state: st });
    }
  }
  return { flags, leftCensored };
}

/** Cohort summary over per-flag forward stats at one horizon key (e.g. "t5"). */
export function summarizeHorizon(flagRecords, hKey) {
  const vals = flagRecords
    .map((f) => f.forward?.horizons?.[hKey])
    .filter((h) => h && h.resolved && isNum(h.mae_pct))
    .map((h) => h.mae_pct);
  return {
    resolved_n: vals.length,
    avg_mae_pct: round2(avg(vals)),
    median_mae_pct: round2(median(vals)),
    worst_mae_pct: vals.length ? round2(Math.min(...vals)) : null,
  };
}

function summarizeCohort(flagRecords) {
  const out = { n: flagRecords.length, mae: {} };
  for (const h of HORIZONS) out.mae[`t${h}`] = summarizeHorizon(flagRecords, `t${h}`);
  const troughs = flagRecords.filter((f) => f.forward?.horizons?.t21?.resolved && isNum(f.forward.trough_day));
  out.time_to_trough_days = {
    n: troughs.length,
    avg: round2(avg(troughs.map((f) => f.forward.trough_day))),
    median: round2(median(troughs.map((f) => f.forward.trough_day))),
  };
  const fvKnown = flagRecords.filter((f) => typeof f.forward?.touched_075fv === "boolean");
  out.pct_touching_075fv = fvKnown.length
    ? round2((fvKnown.filter((f) => f.forward.touched_075fv).length / fvKnown.length) * 100)
    : null;
  const invKnown = flagRecords.filter((f) => typeof f.forward?.touched_invalidation === "boolean");
  out.pct_touching_invalidation = invKnown.length
    ? round2((invKnown.filter((f) => f.forward.touched_invalidation).length / invKnown.length) * 100)
    : null;
  return out;
}

function momentumAverages(flagRecords) {
  const pick = (k) => flagRecords.map((f) => f.momentum?.[k]).filter(isNum);
  return {
    avg_r7d: round2(avg(pick("r7d"))),
    avg_r1m: round2(avg(pick("r1m"))),
    avg_r3m: round2(avg(pick("r3m"))),
    avg_r1y: round2(avg(pick("r1y"))),
    avg_pct3m: round2(avg(flagRecords.map((f) => f.pct3m).filter(isNum))),
  };
}

// ---------------------------------------------------------------------------
// Git archive walk (main path only — never runs on import).
// ---------------------------------------------------------------------------

function git(args) {
  return execFileSync("git", args, { cwd: REPO_ROOT, maxBuffer: MAX_BUFFER, encoding: "utf8" });
}

// Mirrors server.js rowForEntryBand (server.js:9116) EXACTLY — picks rows are flat;
// buildEntryBand reads from stock.overview.* — do not import server.js for this.
export function rowForEntryBand(row) {
  const overview = {
    ...(row?.overview || {}),
    current_price_inr: row?.current_price_inr ?? row?.overview?.current_price_inr,
    fair_value_inr: row?.fair_value_inr ?? row?.overview?.fair_value_inr,
    upside_pct: row?.upside_pct ?? row?.overview?.upside_pct,
    market_cap_inr: row?.market_cap_inr ?? row?.overview?.market_cap_inr,
    snowflake_total: row?.snowflake_total ?? row?.overview?.snowflake_total,
    parsed_at: row?.data_freshness_at || row?.parsed_at || row?.overview?.parsed_at,
  };
  return {
    ...row,
    parsed_at: row?.data_freshness_at || row?.parsed_at || overview.parsed_at,
    overview,
  };
}

function listCommits(warnings) {
  let raw = "";
  try {
    raw = git(["log", "--format=%H %cI", "--", PICKS_PATH]);
  } catch (err) {
    warnings.push(`git log failed: ${err.message}`);
    return [];
  }
  const commits = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [hash, dateIso] = l.split(" ");
      return { hash, dateIso, ms: Date.parse(dateIso) };
    })
    .filter((c) => Number.isFinite(c.ms) && c.ms >= WINDOW_FLOOR_MS);
  commits.reverse(); // oldest -> newest
  return commits;
}

function loadSnapshot(hash, warnings, counters) {
  let raw;
  try {
    raw = git(["show", `${hash}:${PICKS_PATH}`]);
  } catch (err) {
    counters.unparseable += 1;
    warnings.push(`git show failed for ${hash.slice(0, 10)}: ${String(err.message).split("\n")[0]}`);
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    counters.unparseable += 1;
    warnings.push(`unparseable JSON at ${hash.slice(0, 10)}: ${err.message}`);
    return null;
  }
}

/** Build the per-commit indices: band states for best_to_buy_now, all-sections price/fv, sorted r3m. */
function indexCommit(commit, data) {
  const sections = data?.sections;
  if (!sections || typeof sections !== "object") return null;
  const prices = new Map(); // ticker -> px (any section, first finite wins)
  const fvs = new Map(); // ticker -> fair_value_inr
  const r3mByTicker = new Map(); // deduped by ticker for percentile universe
  for (const key of Object.keys(sections)) {
    const arr = sections[key];
    if (!Array.isArray(arr)) continue;
    for (const row of arr) {
      const t = row?.ticker;
      if (!t) continue;
      if (!prices.has(t) && isNum(row.current_price_inr) && row.current_price_inr > 0) {
        prices.set(t, row.current_price_inr);
      }
      if (!fvs.has(t) && isNum(row.fair_value_inr) && row.fair_value_inr > 0) {
        fvs.set(t, row.fair_value_inr);
      }
      const r3m = row?.returns_pct?.["3M"];
      if (!r3mByTicker.has(t) && isNum(r3m)) r3mByTicker.set(t, r3m);
    }
  }
  const sortedR3m = [...r3mByTicker.values()].sort((a, b) => a - b);

  const bands = {};
  const cohort = Array.isArray(sections.best_to_buy_now) ? sections.best_to_buy_now : [];
  for (const row of cohort) {
    const t = row?.ticker;
    if (!t || bands[t]) continue;
    // Recompute — NEVER read the stored entry_band (only exists from 2026-06-16).
    // now = commit timestamp so the 96h freshness gate is evaluated as-of snapshot time.
    const band = buildEntryBand(rowForEntryBand(row), { now: new Date(commit.ms) });
    const r = row?.returns_pct || {};
    bands[t] = {
      entry_state: band.entry_state,
      fresh_buy_eligible: band.fresh_buy_eligible,
      px: isNum(row.current_price_inr) ? row.current_price_inr : band.current_price_inr,
      fv: band.fair_value_inr,
      returns: {
        r1d: isNum(r["1D"]) ? r["1D"] : null,
        r7d: isNum(r["7D"]) ? r["7D"] : null,
        r1m: isNum(r["1M"]) ? r["1M"] : null,
        r3m: isNum(r["3M"]) ? r["3M"] : null,
        r1y: isNum(r["1Y"]) ? r["1Y"] : null,
      },
      fifty_two_week: row?.fifty_two_week ?? null, // mostly absent pre-bake — kept null-safe
    };
  }
  return { date: commit.dateIso, ms: commit.ms, hash: commit.hash, bands, prices, fvs, sortedR3m };
}

function buildFlagRecords(perCommit) {
  const { flags, leftCensored } = detectFlags(perCommit);
  const records = [];
  for (const flag of flags) {
    const i = flag.commit_index;
    const cur = perCommit[i];
    const prev = perCommit[i - 1];
    const st = flag.state;
    const entryPx = st.px;
    const fairValue = st.fv;
    const prevFv = prev.fvs.get(flag.ticker) ?? null;
    const cause = classifyFlagCause({
      prevFv,
      curFv: fairValue,
      flagDateIso: cur.date,
      prevDateIso: prev.date,
    });
    // Forward observations: LATER commits' price for this ticker, any section.
    const observations = [];
    for (let j = i + 1; j < perCommit.length; j++) {
      const px = perCommit[j].prices.get(flag.ticker);
      if (!isNum(px)) continue;
      const day = Math.round((perCommit[j].ms - cur.ms) / 86400000);
      if (day > 0) observations.push({ day, px });
    }
    const forward = computeForwardStats(entryPx, observations, { horizons: HORIZONS, fairValue });
    const pct3m = percentileRank(cur.sortedR3m, st.returns.r3m);
    const klass = classifyFlag({
      r1m: st.returns.r1m,
      r3m: st.returns.r3m,
      r7d: st.returns.r7d,
      pct3m,
    });
    records.push({
      ticker: flag.ticker,
      date: cur.date,
      commit: cur.hash.slice(0, 10),
      from_state: flag.from_state,
      cause,
      entry_px: entryPx,
      fair_value: fairValue,
      momentum: st.returns,
      pct3m: pct3m == null ? null : Math.round(pct3m * 1000) / 1000,
      class: klass,
      forward,
    });
  }
  return { records, leftCensored };
}

function buildReport(perCommit, records, leftCensored, counters, warnings) {
  const epoch = records.filter((r) => r.cause === "fv_reconcile_epoch");
  const headline = records.filter((r) => r.cause !== "fv_reconcile_epoch");
  const byClass = {
    FALLING_KNIFE: headline.filter((r) => r.class === "FALLING_KNIFE"),
    STABILIZING: headline.filter((r) => r.class === "STABILIZING"),
    ENTRY_CONFIRMED: headline.filter((r) => r.class === "ENTRY_CONFIRMED"),
  };
  const ruleReplay = {};
  for (const [k, cohort] of Object.entries(byClass)) {
    ruleReplay[k] = { ...summarizeCohort(cohort), momentum_at_flag: momentumAverages(cohort) };
  }
  return {
    generated_at: new Date().toISOString(),
    entry_timing_config: { KNIFE, KNIFE_EXIT, CONFIRMED },
    window: {
      from: perCommit.length ? perCommit[0].date : null,
      to: perCommit.length ? perCommit[perCommit.length - 1].date : null,
      commits: perCommit.length,
      commits_skipped_unparseable: counters.unparseable,
      commits_skipped_no_sections: counters.noSections,
    },
    population: {
      flags: records.length,
      headline_flags: headline.length,
      left_censored: leftCensored.length,
      epoch_excluded: epoch.length,
    },
    strata: {
      price_move: summarizeCohort(headline.filter((r) => r.cause === "price_move")),
      fv_move: summarizeCohort(headline.filter((r) => r.cause === "fv_move")),
      fv_reconcile_epoch: summarizeCohort(epoch),
    },
    horizons: {
      headline_all_flags: { ...summarizeCohort(headline), momentum_at_flag: momentumAverages(headline) },
    },
    rule_replay: ruleReplay,
    flags: records.map(({ forward, ...rest }) => ({
      ...rest,
      mae_t5: forward.horizons.t5?.mae_pct ?? null,
      mae_t10: forward.horizons.t10?.mae_pct ?? null,
      mae_t21: forward.horizons.t21?.mae_pct ?? null,
      resolved_t21: !!forward.horizons.t21?.resolved,
      trough_day: forward.trough_day,
      touched_075fv: forward.touched_075fv,
      touched_invalidation: forward.touched_invalidation,
    })),
    left_censored: leftCensored,
    warnings,
    notes: [
      "Flags are RECOMPUTED per historical commit via the pure buildEntryBand (current code) — the stored entry_band field only exists from 2026-06-16 and is never read.",
      "buildEntryBand evaluated with now = commit timestamp so the 96h freshness gate behaves as-of snapshot time.",
      "T+5/T+10/T+21 trading-day horizons approximated as calendar-day offsets between nightly commits (~1/day cadence); commit gaps make windows sparser, not wrong-priced.",
      "MAE_h = min over the window of (px/entry - 1)*100 per the plan — it can be positive when price never dipped below entry.",
      `Flags whose transition spans ${EPOCH_FROM}..${EPOCH_TO} are the fv_reconcile_epoch stratum (FV-reconcile code change 2026-06-15 shifts FVs as an artifact) — excluded from headline and rule replay.`,
      "Classifier degradations: fifty_two_week absent historically, so KNIFE.PX_OVER_52WH_MAX and CONFIRMED.PX_OVER_52WL_MIN legs are skipped; KNIFE_EXIT hysteresis not applied (point-in-time classification).",
      "Invalidation-touch proxy = px <= 0.92 x entry within T+21 (INVALIDATION.ANCHOR_MULT, 52w-low leg unavailable).",
      "Slow-bleeder percentile ranks 3M return against the SAME commit's all-sections universe (deduped by ticker), fraction strictly below.",
      "Left-censored = already in BUY_ZONE+eligible at the first analyzed commit (2026-05-25 floor — returns_pct exists on rows only from commit 532066db28); counted, excluded from MAE cohorts.",
    ],
  };
}

function fmt(v, suffix = "") {
  return v == null ? "—" : `${v}${suffix}`;
}

function printHuman(report) {
  const { window: w, population: p } = report;
  console.log("Entry-band MAE backtest (PR-1 evidence engine)");
  console.log(`  window   : ${w.from} → ${w.to}  (${w.commits} commits, ${w.commits_skipped_unparseable} unparseable, ${w.commits_skipped_no_sections} no-sections)`);
  console.log(`  flags    : ${p.flags} total | headline ${p.headline_flags} | left-censored ${p.left_censored} | fv-reconcile-epoch excluded ${p.epoch_excluded}`);
  console.log(`  strata   : price_move ${report.strata.price_move.n} | fv_move ${report.strata.fv_move.n} | fv_reconcile_epoch ${report.strata.fv_reconcile_epoch.n}`);
  console.log("");
  const line = (label, c) => {
    const m5 = c.mae.t5, m10 = c.mae.t10, m21 = c.mae.t21;
    console.log(
      `  ${label.padEnd(16)} n=${String(c.n).padStart(3)}  ` +
      `T+5 avg ${fmt(m5.avg_mae_pct, "%")} med ${fmt(m5.median_mae_pct, "%")} (n${m5.resolved_n})  ` +
      `T+10 avg ${fmt(m10.avg_mae_pct, "%")} med ${fmt(m10.median_mae_pct, "%")} (n${m10.resolved_n})  ` +
      `T+21 avg ${fmt(m21.avg_mae_pct, "%")} med ${fmt(m21.median_mae_pct, "%")} worst ${fmt(m21.worst_mae_pct, "%")} (n${m21.resolved_n})  ` +
      `trough ${fmt(c.time_to_trough_days.median, "d")}  inval-touch ${fmt(c.pct_touching_invalidation, "%")}  0.75FV-touch ${fmt(c.pct_touching_075fv, "%")}`
    );
  };
  console.log("HEADLINE (non-epoch flags)");
  line("all flags", report.horizons.headline_all_flags);
  console.log("");
  console.log("RULE REPLAY (candidate classifier, point-in-time, 52w legs skipped)");
  for (const k of ["FALLING_KNIFE", "STABILIZING", "ENTRY_CONFIRMED"]) {
    line(k, report.rule_replay[k]);
    const mo = report.rule_replay[k].momentum_at_flag;
    console.log(`  ${"".padEnd(16)} momentum@flag: r7d ${fmt(mo.avg_r7d, "%")} r1m ${fmt(mo.avg_r1m, "%")} r3m ${fmt(mo.avg_r3m, "%")} pct3m ${fmt(mo.avg_pct3m)}`);
  }
  console.log("");
  console.log("STRATA");
  line("price_move", report.strata.price_move);
  line("fv_move", report.strata.fv_move);
  line("fv_reconcile", report.strata.fv_reconcile_epoch);
  if (report.warnings.length) {
    console.log("");
    console.log(`WARNINGS (${report.warnings.length})`);
    for (const wmsg of report.warnings.slice(0, 10)) console.log(`  - ${wmsg}`);
  }
  console.log("");
  console.log(`Wrote ${path.relative(REPO_ROOT, OUT_PATH)}`);
}

function main() {
  const jsonMode = process.argv.includes("--json");
  const warnings = [];
  const counters = { unparseable: 0, noSections: 0 };
  let report;
  try {
    const commits = listCommits(warnings);
    const perCommit = [];
    for (const commit of commits) {
      const data = loadSnapshot(commit.hash, warnings, counters);
      if (!data) continue;
      const indexed = indexCommit(commit, data);
      if (!indexed) {
        counters.noSections += 1;
        warnings.push(`no sections at ${commit.hash.slice(0, 10)} (${commit.dateIso}) — skipped`);
        continue;
      }
      perCommit.push(indexed);
    }
    const { records, leftCensored } = buildFlagRecords(perCommit);
    report = buildReport(perCommit, records, leftCensored, counters, warnings);
  } catch (err) {
    report = {
      generated_at: new Date().toISOString(),
      error: err.stack || String(err),
      warnings,
      window: null,
      population: null,
    };
  }
  try {
    mkdirSync(path.dirname(OUT_PATH), { recursive: true });
    writeFileSync(OUT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  } catch (err) {
    report.warnings = [...(report.warnings || []), `failed to write ${OUT_PATH}: ${err.message}`];
  }
  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
  } else if (report.error) {
    console.error("Backtest failed (exit 0 by design):");
    console.error(report.error);
  } else {
    printHuman(report);
  }
  process.exit(0);
}

const isMain = process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) main();
