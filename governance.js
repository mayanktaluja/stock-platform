/**
 * Governance Module — Phase 5 (Apr 2026): real NSE shareholding fetcher.
 *
 * Provides the India-specific sixth pillar for the V2 "Snowflake" scorer,
 * sourced from NSE's quarterly shareholding-pattern filings (Reg 31). The
 * stub from Phase 1 has been replaced with a live fetcher that populates
 * promoterHolding / promoterPledge / pledgeOfTotal / FII / DII / retail /
 * QoQ deltas for every symbol in the enriched universe.
 *
 * ───────────────────────────────────────────────────────────────────────
 * Why a governance pillar is India-specific
 * ───────────────────────────────────────────────────────────────────────
 *
 * Simply Wall St uses five pillars globally (Value/Future/Past/Health/Dividend).
 * Indian equities need a sixth — Governance — because the single biggest
 * predictor of multi-year underperformance in NSE smallcaps is NOT valuation
 * or growth but governance risk:
 *
 *   • Pledged promoter holding — a promoter who has pledged >30% of their
 *     stake has personal balance-sheet leverage that can force forced-selling
 *     cascades (Yes Bank 2019, Reliance Capital 2020, Zee 2023).
 *   • Falling promoter holding over time — promoters trimming their stake
 *     via open market sales is the strongest single leading indicator of
 *     future earnings disappointment (SEBI cohort studies 2018-2024).
 *   • Low DII / high FII dependence — FII flows are reflexive; smallcaps
 *     held predominantly by FIIs see 2-3× the drawdown in risk-off phases.
 *   • Related-party transactions as % of revenue — a red flag for earnings
 *     quality manipulation. SEBI LODR requires disclosure, but the data is
 *     locked in PDFs (annual reports) and needs NLP extraction.
 *
 * The scorer in Phase 2 will weight these signals within a Governance pillar
 * that can dock up to 25% off a stock's composite score for red flags.
 *
 * ───────────────────────────────────────────────────────────────────────
 * Data shape (what the V2 scorer consumes)
 * ───────────────────────────────────────────────────────────────────────
 *
 *   {
 *     fetchedAt: ISO string,
 *     source:    "bse-xbrl" | "nse-shareholding" | "kv" | "disk" | "empty",
 *     bySymbol: {
 *       "RELIANCE.NS": {
 *         asOfQuarter:      "Q4FY26",
 *         promoterHolding:  0.5031,   // ratio; SEBI max is 0.75 for listed cos
 *         promoterPledge:   0.00,     // ratio of promoter stake pledged
 *         pledgeOfTotal:    0.00,     // pledge * promoter = % of total shares
 *         fiiHolding:       0.2294,
 *         diiHolding:       0.1635,
 *         retailHolding:    0.1040,   // ratio — the residual
 *         rptAsPctRevenue:  null,     // thin; from annual report NLP (Phase 3)
 *         promoterHoldingQoQDelta: -0.0012,  // deriv: this Q − prior Q
 *         pledgeQoQDelta:          0.00,
 *       },
 *       ...
 *     }
 *   }
 *
 * Call site pattern (Phase 2 scorer):
 *   import { getGovernance } from "./governance.js";
 *   const g = getGovernance("RELIANCE.NS");
 *   if (g?.pledgeOfTotal > 0.10) warnings.push("High pledged promoter stake");
 *
 * ───────────────────────────────────────────────────────────────────────
 * Data source: NSE shareholding-pattern JSON
 * ───────────────────────────────────────────────────────────────────────
 *
 * Primary endpoint (via nseGet, authenticated with NSE cookies):
 *   /api/corporate-share-holdings-master?index=equities&symbol=RELIANCE
 *
 * This returns a list of the last ~8 quarterly filings with columns including
 * promoter/promoter-group %, public %, pledge count, DII/FII sub-breakdowns.
 * We take the two most recent rows to compute QoQ deltas.
 *
 * Field names on this endpoint drift across NSE API revisions, so the parser
 * accepts multiple aliases (pr_and_prgrp / promoter_prgrp / promotersPct /
 * etc.). Missing-field tolerance is the norm, not the exception.
 *
 * Fallback: the shareholdingPattern sub-object on /api/quote-equity when the
 * dedicated endpoint 404s. This rarer path was observed for a handful of
 * recently-delisted or paused symbols in the universe.
 *
 * Rate limit profile: per-symbol endpoint, ~250ms + small jitter per call
 * with concurrency=3 processes the enriched universe (~500 stocks) in well
 * under the Vercel serverless 60s window. The cron runs weekly on Sunday
 * because shareholding filings are quarterly — more frequent refreshes are
 * pure waste.
 *
 * Out of scope here: RPT as % of revenue (still needs annual-report PDF
 * parsing, tracked separately). Governance pillar already scores without it.
 */

import { readFileSync, existsSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { nseGet } from "./nse.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const GOVERNANCE_PATH = path.join(__dirname, "governance.json");

export const KV_GOVERNANCE_KEY = "governance:snapshot";

// ==================== IN-MEMORY CACHE ====================

let _cached = null;
let _cachedSource = null;

async function getKVClient() {
  const hasKV = !!process.env.KV_REST_API_URL && !!process.env.KV_REST_API_TOKEN;
  if (!hasKV) return null;
  const mod = await import("@vercel/kv");
  return mod.kv;
}

// ==================== NORMALISATION ====================

function toNseKey(sym) {
  if (!sym) return null;
  const s = String(sym).trim().toUpperCase();
  if (!s) return null;
  return s.endsWith(".NS") ? s : `${s}.NS`;
}

// ==================== EMPTY SNAPSHOT ====================

function emptySnapshot() {
  return {
    fetchedAt: null,
    source: "empty",
    bySymbol: {},
  };
}

// ==================== NSE FETCH ====================

/**
 * Pull a percentage out of a record by trying a list of possible field names.
 * NSE's JSON keys drift across releases, so we accept multiple aliases.
 * Returns a fraction (0.7216 not 72.16) or null.
 */
function pickPct(row, ...keys) {
  for (const k of keys) {
    const v = row?.[k];
    if (v == null || v === "") continue;
    const n = typeof v === "string" ? parseFloat(v) : v;
    if (!Number.isFinite(n)) continue;
    // NSE sometimes reports as 0-100, sometimes as 0-1. Heuristic:
    // any value >1.5 is a percent out of 100.
    return n > 1.5 ? n / 100 : n;
  }
  return null;
}

/**
 * Parse one row of a shareholding-pattern response into the normalised
 * shape the V2 scorer consumes. Returns null if nothing useful is present.
 */
function parseShareholdingRow(row) {
  if (!row || typeof row !== "object") return null;

  const promoter = pickPct(row, "pr_and_prgrp", "promoter_prgrp", "promotersPct", "promoter", "promoterHolding");
  const publicPct = pickPct(row, "public_val", "publicPct", "publicHolding", "public");
  const fii = pickPct(row, "fii", "fiiHolding", "fiiPct", "foreignPortfolioInvestor");
  const dii = pickPct(row, "dii", "diiHolding", "diiPct", "mutualFunds", "domesticInstitutionalInvestor");
  const retail = pickPct(row, "retail", "retailPct", "retailHolding", "individuals");

  // Pledge can be reported as % of promoter stake OR as a count. We prefer
  // a pledge percentage if available. "shares_pl" is the count (useless
  // without total shares), "pledge_pct_promoter" or similar is the ratio.
  const pledgePct = pickPct(
    row,
    "pledge_pct_promoter",
    "pledgePct",
    "pledgedPct",
    "pledged_shares_pct",
    "shares_pl_pct",
    "pledge_of_promoter",
  );

  // Period — various formats (Mar 2026, 31-MAR-2026, Q4FY26, etc.)
  const asOfQuarter =
    row.as_of_date || row.asOfDate || row.asOfQuarter || row.period ||
    row.quarter || row.submission_date || row.Date || null;

  // pledgeOfTotal = promoterPledge * promoterHolding
  const pledgeOfTotal =
    promoter != null && pledgePct != null
      ? +(promoter * pledgePct).toFixed(5)
      : null;

  // Reject rows that are entirely empty
  if (promoter == null && fii == null && dii == null && pledgePct == null) return null;

  return {
    asOfQuarter,
    promoterHolding: promoter,
    promoterPledge: pledgePct,
    pledgeOfTotal,
    fiiHolding: fii,
    diiHolding: dii,
    publicHolding: publicPct,
    retailHolding: retail,
  };
}

/**
 * Sort rows newest-first. NSE occasionally returns chronological, occasionally
 * reverse — we sort explicitly so the "take two most recent" logic is robust.
 */
function sortRowsNewestFirst(rows) {
  return [...rows].sort((a, b) => {
    // as_of_date format is often "31-MAR-2026" or "2026-03-31"
    const toTs = (r) => {
      const s = r.as_of_date || r.asOfDate || r.period || r.submission_date || r.Date || "";
      if (!s) return 0;
      // Try ISO first
      const iso = Date.parse(s);
      if (!isNaN(iso)) return iso;
      // Try DD-MMM-YYYY
      const m = /^(\d{2})-([A-Z]{3})-(\d{4})$/i.exec(String(s).trim());
      if (m) {
        const months = { JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11 };
        const mi = months[m[2].toUpperCase()];
        return mi == null ? 0 : new Date(+m[3], mi, +m[1]).getTime();
      }
      return 0;
    };
    return toTs(b) - toTs(a);
  });
}

/**
 * Fetch the shareholding pattern for one symbol.
 * Returns { latest, prior } where each is a parsed row, or null for either.
 *
 * Defensive: tolerates multiple response shapes (data[], rows[], or the
 * `shareholdingPattern` sub-object on quote-equity). A 404 on the primary
 * endpoint is a silent fallback, not an error.
 */
export async function fetchShareholdingForSymbol(symbol) {
  const clean = String(symbol).replace(/\.NS$/i, "").toUpperCase();
  if (!clean) return { latest: null, prior: null };

  let rows = [];

  // Primary endpoint — dedicated shareholding-pattern.
  try {
    const data = await nseGet(
      `/api/corporate-share-holdings-master?index=equities&symbol=${encodeURIComponent(clean)}`,
      `https://www.nseindia.com/companies-listing/corporate-filings-share-holdings`,
    );
    if (Array.isArray(data?.data)) rows = data.data;
    else if (Array.isArray(data?.rows)) rows = data.rows;
    else if (Array.isArray(data)) rows = data;
  } catch (e) {
    // Silent fallback — try the secondary below.
  }

  // Fallback — the quote-equity payload sometimes carries the most recent
  // shareholding row on its shareholdingPattern / shrholdPattern block.
  if (rows.length === 0) {
    try {
      const q = await nseGet(
        `/api/quote-equity?symbol=${encodeURIComponent(clean)}`,
        `https://www.nseindia.com/get-quotes/equity?symbol=${encodeURIComponent(clean)}`,
      );
      const sp = q?.shareholdingPattern || q?.shrholdPattern || q?.sharesHoldingPattern;
      if (sp) {
        if (Array.isArray(sp.data)) rows = sp.data;
        else if (Array.isArray(sp)) rows = sp;
        else if (sp && typeof sp === "object") rows = [sp];
      }
    } catch (e) {
      // Give up — leaves bySymbol[key] unset, scorer goes N/A.
    }
  }

  if (rows.length === 0) return { latest: null, prior: null };

  const sorted = sortRowsNewestFirst(rows);
  const latest = parseShareholdingRow(sorted[0]);
  const prior = sorted[1] ? parseShareholdingRow(sorted[1]) : null;
  return { latest, prior };
}

// ==================== BUILD ====================

/**
 * Build a governance snapshot by hitting NSE for each symbol in the list.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.symbols]     NSE symbols to fetch (with or without .NS suffix).
 *                                      If omitted, returns empty snapshot — callers
 *                                      must provide the universe they care about,
 *                                      since there is no "all listed" endpoint.
 * @param {number}  [opts.concurrency]  Parallel NSE calls. Default 3 — higher
 *                                      trips NSE rate limits occasionally.
 * @param {number}  [opts.delayMs]      Inter-call delay per worker. Default 250.
 * @param {function} [opts.onProgress]  Called with (processed, total, symbol)
 *                                      on every completed fetch for progress logs.
 */
export async function buildGovernance(opts = {}) {
  const symbols = Array.isArray(opts.symbols) ? opts.symbols : [];
  const concurrency = Math.max(1, opts.concurrency ?? 3);
  const delayMs = Math.max(0, opts.delayMs ?? 250);
  const onProgress = typeof opts.onProgress === "function" ? opts.onProgress : null;

  if (symbols.length === 0) {
    console.warn("[GOVERNANCE] buildGovernance called with no symbols — returning empty snapshot.");
    return { fetchedAt: new Date().toISOString(), source: "nse-shareholding", bySymbol: {}, counts: { ok: 0, empty: 0 } };
  }

  const bySymbol = {};
  let processed = 0;
  let okCount = 0;
  let emptyCount = 0;
  let currentIdx = 0;
  const total = symbols.length;

  // Worker — pulls the next index off the shared cursor and processes it.
  async function worker(workerId) {
    while (true) {
      const idx = currentIdx++;
      if (idx >= total) return;
      const rawSym = symbols[idx];
      const nseKey = toNseKey(rawSym);
      if (!nseKey) {
        processed++;
        continue;
      }

      let record = null;
      try {
        const { latest, prior } = await fetchShareholdingForSymbol(nseKey);
        if (latest) {
          record = { ...latest };
          if (prior) {
            if (latest.promoterHolding != null && prior.promoterHolding != null) {
              record.promoterHoldingQoQDelta = +(latest.promoterHolding - prior.promoterHolding).toFixed(5);
            }
            if (latest.promoterPledge != null && prior.promoterPledge != null) {
              record.pledgeQoQDelta = +(latest.promoterPledge - prior.promoterPledge).toFixed(5);
            }
          }
          bySymbol[nseKey] = record;
          okCount++;
        } else {
          emptyCount++;
        }
      } catch (err) {
        emptyCount++;
        if (processed < 5) {
          // Only log the first few failures so we don't spam the console when
          // the whole thing breaks (e.g. cookies expired → 500s for everyone).
          console.warn(`[GOVERNANCE] ${nseKey} fetch failed: ${err.message}`);
        }
      }

      processed++;
      if (onProgress) onProgress(processed, total, nseKey);

      if (delayMs > 0 && processed < total) {
        // Jitter a touch so we don't hammer NSE in phase.
        await new Promise((r) => setTimeout(r, delayMs + Math.random() * 100));
      }
    }
  }

  const workers = Array.from({ length: concurrency }, (_, i) => worker(i));
  await Promise.all(workers);

  return {
    fetchedAt: new Date().toISOString(),
    source: "nse-shareholding",
    bySymbol,
    counts: { ok: okCount, empty: emptyCount, total },
  };
}

// ==================== PERSISTENCE ====================

/**
 * Pure predicate: is this snapshot the product of a transient outage
 * (NSE cookie expiry, datacenter-IP block, total endpoint failure) rather
 * than a legitimate refresh?
 *
 * Mirrors the in-route guard at /api/cron/refresh-governance (server.js
 * ~2406-2422): if okCount < max(5, total * 10%) we treat the run as an
 * outage. Extracted here so BOTH writer paths (Vercel cron + local
 * scripts/refresh-governance.mjs) benefit from the same protection — the
 * local script previously called `saveGovernance(snap)` unconditionally,
 * which is how governance.json zero-filled to `counts: { ok: 0, empty: 744 }`
 * on 2026-05-12 and stayed dead until 2026-05-18.
 *
 * Exported for direct unit-testing (and so other writers — if any are added
 * later — can pre-check before calling saveGovernance).
 *
 * Empty snapshot ({} bySymbol, no counts) is also considered an outage so a
 * truly-empty Vercel cron payload does not wipe a populated disk file.
 */
export function isOutageSnapshot(snap) {
  if (!snap || typeof snap !== "object") return true;
  const counts = snap.counts || {};
  const okCount = Number.isFinite(counts.ok)
    ? counts.ok
    : Object.keys(snap.bySymbol || {}).length;
  const total = Number.isFinite(counts.total)
    ? counts.total
    : Number.isFinite(counts.ok) && Number.isFinite(counts.empty)
      ? counts.ok + counts.empty
      : okCount; // total unknown — fall back to okCount so threshold = max(5, ok*0.1)
  const threshold = Math.max(5, Math.floor(total * 0.10));
  return okCount < threshold;
}

/**
 * Persist a governance snapshot to KV (preferred) or disk.
 *
 * Outage-preservation guard: if `snapshot` looks like an outage payload
 * (per isOutageSnapshot) AND there is an existing snapshot with real
 * coverage, the write is SKIPPED. The function returns
 *   { skipped: true, reason, fetched, existingCount }
 * so callers can log it accordingly. If there is no existing snapshot to
 * preserve, the outage payload is written through so the diagnostics
 * surface (`getGovernanceStatus()`) shows the empty state honestly rather
 * than implying everything is fine.
 *
 * Both server.js /api/cron/refresh-governance AND
 * scripts/refresh-governance.mjs rely on this guard now. The server route
 * still does its own pre-check for observability (it returns a 200 JSON
 * with `skipped: true` to the caller) — that's belt-and-braces; this
 * function is the load-bearing braces.
 */
export async function saveGovernance(snapshot) {
  if (isOutageSnapshot(snapshot)) {
    const existing = getGovernanceSnapshot();
    const existingCount = Object.keys(existing?.bySymbol || {}).length;
    if (existingCount > 0) {
      const counts = snapshot?.counts || {};
      const okCount = Number.isFinite(counts.ok)
        ? counts.ok
        : Object.keys(snapshot?.bySymbol || {}).length;
      const totalAttempts = counts.total ?? "unknown";
      const priorDate = existing?.fetchedAt || "unknown";
      // Escalate the log level when the fetch returned ZERO records and the
      // existing snapshot has real coverage — that's the exact failure mode
      // that wiped governance.json on 2026-05-12 (the bug we now refuse to
      // re-experience). A "CRITICAL" prefix is what nightly chain wrappers
      // (sws-nightly.sh, alerting greps) look for to page on the page-zero
      // case specifically; low-yield-but-nonzero is just a warn.
      if (okCount === 0) {
        console.warn(
          `[governance] CRITICAL: 0 ok of ${totalAttempts} attempts — refusing ` +
          `to overwrite last-good (${existingCount} entries from ${priorDate})`
        );
      } else {
        console.warn(
          `[GOVERNANCE] saveGovernance refused to overwrite: snapshot reports only ` +
          `${okCount} populated records (of ${totalAttempts}); ` +
          `preserving existing snapshot with ${existingCount} entries from ${priorDate}.`
        );
      }
      return {
        skipped: true,
        reason: "zero_or_low_yield_preserved_existing",
        fetched: okCount,
        existingCount,
        priorDate,
      };
    }
    // No existing data to preserve — fall through to write the outage
    // payload so the diagnostics surface tells the truth about the failure.
  }

  const kv = await getKVClient();
  if (kv) {
    await kv.set(KV_GOVERNANCE_KEY, snapshot);
    _cached = snapshot;
    _cachedSource = "kv";
    return { target: "kv" };
  }
  writeFileSync(GOVERNANCE_PATH, JSON.stringify(snapshot, null, 2));
  _cached = snapshot;
  _cachedSource = "disk";
  return { target: "disk", path: GOVERNANCE_PATH };
}

/**
 * Prime the in-memory cache from KV at server startup. Silent on failure
 * because getGovernance() falls through to disk + empty.
 */
export async function primeGovernanceFromKV() {
  try {
    const kv = await getKVClient();
    if (!kv) return null;
    const data = await kv.get(KV_GOVERNANCE_KEY);
    if (!data || !data.bySymbol) return null;
    _cached = data;
    _cachedSource = "kv";
    console.log(
      `[GOVERNANCE] primed from KV: ${Object.keys(data.bySymbol).length} records, ` +
      `fetchedAt=${data.fetchedAt || "unknown"}`
    );
    return data;
  } catch (err) {
    console.warn("[GOVERNANCE] KV prime failed:", err.message);
    return null;
  }
}

// ==================== GETTERS ====================

/**
 * Return the full snapshot (cached → disk → empty).
 */
export function getGovernanceSnapshot() {
  if (_cached) return _cached;
  if (existsSync(GOVERNANCE_PATH)) {
    try {
      const raw = readFileSync(GOVERNANCE_PATH, "utf8");
      _cached = JSON.parse(raw);
      _cachedSource = "disk";
      return _cached;
    } catch (err) {
      console.warn("[GOVERNANCE] disk read failed:", err.message);
    }
  }
  return emptySnapshot();
}

/**
 * Fast per-symbol lookup. Returns null if the snapshot is empty or the
 * symbol isn't covered. Callers (V2 scorer) MUST tolerate null and
 * degrade the Governance pillar weight accordingly.
 *
 * Accepts both "RELIANCE" and "RELIANCE.NS" forms.
 */
export function getGovernance(symbol) {
  const key = toNseKey(symbol);
  if (!key) return null;
  const snap = getGovernanceSnapshot();
  return snap.bySymbol?.[key] || null;
}

/**
 * TEST-ONLY: invalidate the in-memory cache so a subsequent
 * getGovernanceSnapshot() / getGovernance() re-reads from disk (or KV
 * if configured). Never call this from production code paths — the cache
 * is load-bearing for cold-start latency.
 */
export function _resetGovernanceCacheForTests() {
  _cached = null;
  _cachedSource = null;
}

/**
 * Diagnostics for the UI / admin surface. Follows the same shape as
 * getSurveillanceStatus() for pattern consistency.
 */
export function getGovernanceStatus() {
  const snap = getGovernanceSnapshot();
  const count = Object.keys(snap.bySymbol || {}).length;
  if (!snap.fetchedAt) {
    return { age_hours: null, source: snap.source, stale: true, count };
  }
  const ageMs = Date.now() - new Date(snap.fetchedAt).getTime();
  const age_hours = +(ageMs / 3_600_000).toFixed(1);
  // Governance data refreshes quarterly (within 21 days of quarter end).
  // 100 days = ~3.3 months — after this, the data is stale because a new
  // quarter should have been published.
  return {
    age_hours,
    source: _cachedSource || snap.source,
    stale: age_hours > 100 * 24,
    count,
  };
}
