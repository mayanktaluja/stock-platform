// Drizzle schema for the SWS data tier. See:
//   /Users/mayanktaluja/.claude/plans/sws-json-indexed-stroustrup.md
//
// 11 tables. Hot fields are scalar columns; nested arrays and per-pick
// blobs are JSONB. Run-scoped tables key on `run_id` (uuid) joining
// `sws_runs`. Exactly one canonical run at a time (partial unique index
// on `is_canonical`).
//
// Conventions:
//   * `*_pct` columns store percentages (12.5 = 12.5%), never fractions.
//   * Money columns use `doublePrecision` — 15+ digits of precision is
//     plenty for INR market caps; `numeric` would be exact but slow.
//   * Tickers are upper-case bare NSE symbols (RELIANCE, not RELIANCE.NS).

import {
  pgTable,
  varchar,
  text,
  integer,
  bigserial,
  boolean,
  timestamp,
  date,
  jsonb,
  uuid,
  doublePrecision,
  primaryKey,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ── sws_runs ────────────────────────────────────────────────────────────
// Pipeline run history. Exactly one row has is_canonical = true.

export const swsRuns = pgTable(
  "sws_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    pipeline: varchar("pipeline", { length: 16 }).notNull().default("api"),
    status: varchar("status", { length: 24 }).notNull().default("running"),
    durationSeconds: integer("duration_seconds"),
    scoredCount: integer("scored_count"),
    shardsFailed: integer("shards_failed"),
    newsItemsTotal: integer("news_items_total"),
    deepFilesScanned: integer("deep_files_scanned"),
    newsPopulatedCount: integer("news_populated_count"),
    isCanonical: boolean("is_canonical").notNull().default(false),
    scrapeSkipped: boolean("scrape_skipped").default(false),
    sectionsCount: jsonb("sections_count"),
    perShardProgress: jsonb("per_shard_progress"),
  },
  (t) => [
    uniqueIndex("sws_runs_canonical_unique_idx")
      .on(t.isCanonical)
      .where(sql`${t.isCanonical} = true`),
    index("sws_runs_started_at_idx").on(t.startedAt),
  ],
);

// ── sws_companies ───────────────────────────────────────────────────────
// Static-ish per-ticker info. Updated by scrape only when a field changes.

export const swsCompanies = pgTable("sws_companies", {
  ticker: varchar("ticker", { length: 32 }).primaryKey(),
  name: varchar("name", { length: 256 }),
  sector: varchar("sector", { length: 96 }),
  swsUrl: text("sws_url"),
  swsCompanyId: uuid("sws_company_id"),
  indices: jsonb("indices"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── sws_company_snapshots ───────────────────────────────────────────────
// The hot row. One per (ticker, run_id). Scalar columns for queryable
// hot fields; JSONB for nested arrays.

export const swsCompanySnapshots = pgTable(
  "sws_company_snapshots",
  {
    ticker: varchar("ticker", { length: 32 }).notNull(),
    runId: uuid("run_id")
      .notNull()
      .references(() => swsRuns.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 256 }),
    sector: varchar("sector", { length: 96 }),
    classificationStatus: varchar("classification_status", { length: 32 }),
    parsedAt: timestamp("parsed_at", { withTimezone: true }),

    // Price + valuation
    currentPriceInr: doublePrecision("current_price_inr"),
    marketCapInr: doublePrecision("market_cap_inr"),
    marketCapUsd: doublePrecision("market_cap_usd"),
    marketCapBand: varchar("market_cap_band", { length: 16 }),
    sharesOutstanding: doublePrecision("shares_outstanding"),
    fairValueInr: doublePrecision("fair_value_inr"),
    upsidePct: doublePrecision("upside_pct"),

    // Snowflake pillars (0-6 each)
    snowflakeTotal: integer("snowflake_total"),
    snowflakeValuation: integer("snowflake_valuation"),
    snowflakeFutureGrowth: integer("snowflake_future_growth"),
    snowflakePastPerformance: integer("snowflake_past_performance"),
    snowflakeFinancialHealth: integer("snowflake_financial_health"),
    snowflakeDividends: integer("snowflake_dividends"),

    // Multiples
    pe: doublePrecision("pe"),
    pb: doublePrecision("pb"),
    ps: doublePrecision("ps"),
    evEbitda: doublePrecision("ev_ebitda"),

    // Returns
    returns1mPct: doublePrecision("returns_1m_pct"),
    returns3mPct: doublePrecision("returns_3m_pct"),
    returns6mPct: doublePrecision("returns_6m_pct"),
    returns1yPct: doublePrecision("returns_1y_pct"),
    returns5yPct: doublePrecision("returns_5y_pct"),

    // Margins + growth
    netMarginPct: doublePrecision("net_margin_pct"),
    revenueGrowthPct: doublePrecision("revenue_growth_pct"),
    earningsGrowthYoyPct: doublePrecision("earnings_growth_yoy_pct"),
    forwardEarningsGrowthPct: doublePrecision("forward_earnings_growth_pct"),

    // Fiscal
    latestRevenue: doublePrecision("latest_revenue"),
    latestNetIncome: doublePrecision("latest_net_income"),
    latestEps: doublePrecision("latest_eps"),
    mostRecentReportedDate: date("most_recent_reported_date"),

    // Dividend
    dividendYieldPct: doublePrecision("dividend_yield_pct"),
    payoutPct: doublePrecision("payout_pct"),
    annualizedDividend: doublePrecision("annualized_dividend"),

    // Misc
    nextEarningsDate: date("next_earnings_date"),
    recentNewsCount: integer("recent_news_count"),
    insiderOwnershipPct: doublePrecision("insider_ownership_pct"),
    lastQuarterResult: varchar("last_quarter_result", { length: 16 }),

    // JSONB
    news: jsonb("news"),
    topHolders: jsonb("top_holders"),
    recentDividendPayments: jsonb("recent_dividend_payments"),
    fiscalYearlyHistory: jsonb("fiscal_yearly_history"),
    rewards: jsonb("rewards"),
    risks: jsonb("risks"),
    industryBenchmarks: jsonb("industry_benchmarks"),
    insiderActivity: jsonb("insider_activity"),
    recentAnalystRevisions: jsonb("recent_analyst_revisions"),
    rawExtra: jsonb("raw_extra"),
  },
  (t) => [
    primaryKey({ columns: [t.ticker, t.runId] }),
    index("sws_snap_run_ticker_idx").on(t.runId, t.ticker),
    // The sector-momentum win — replaces the O(5,517) deep-file scan in
    // services/earnings/signalAggregator.js (ensureSectorMomentum).
    index("sws_snap_run_sector_r1m_idx").on(t.runId, t.sector, t.returns1mPct),
  ],
);

// ── sws_picks ───────────────────────────────────────────────────────────
// Per (run, ticker, section). A ticker may appear in multiple sections
// (top_ranked_30_v3 + quality_growth + best_to_buy_now); narrative is
// duplicated across them by applyNarrativeAcrossSections.

export const swsPicks = pgTable(
  "sws_picks",
  {
    runId: uuid("run_id")
      .notNull()
      .references(() => swsRuns.id, { onDelete: "cascade" }),
    ticker: varchar("ticker", { length: 32 }).notNull(),
    section: varchar("section", { length: 48 }).notNull(),
    rankInSection: integer("rank_in_section"),

    name: varchar("name", { length: 256 }),
    sector: varchar("sector", { length: 96 }),
    swsUrl: text("sws_url"),

    score: doublePrecision("score"),
    v2Score: doublePrecision("v2_score"),
    v3Score: doublePrecision("v3_score"),
    v3Score100: doublePrecision("v3_score_100"),
    v3Verdict: varchar("v3_verdict", { length: 24 }),
    verdict: varchar("verdict", { length: 24 }),
    compositeVerdict: varchar("composite_verdict", { length: 24 }),
    valuationBand: varchar("valuation_band", { length: 24 }),
    snowflakeTotal: integer("snowflake_total"),

    currentPriceInr: doublePrecision("current_price_inr"),
    fairValueInr: doublePrecision("fair_value_inr"),
    upsidePct: doublePrecision("upside_pct"),
    marketCapInr: doublePrecision("market_cap_inr"),

    lastQuarterResult: varchar("last_quarter_result", { length: 16 }),
    nextEarningsDate: date("next_earnings_date"),

    snowflake: jsonb("snowflake"),
    v2Breakdown: jsonb("v2_breakdown"),
    v3Breakdown: jsonb("v3_breakdown"),
    auditTrail: jsonb("audit_trail"),
    counterThesis: text("counter_thesis"),
    narrative: jsonb("narrative"),
    sectionStatus: jsonb("section_status"),
    earningsBeatMeta: jsonb("earnings_beat_meta"),
    surveillance: jsonb("surveillance"),

    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.ticker, t.section] }),
    index("sws_picks_run_section_rank_idx").on(t.runId, t.section, t.rankInSection),
    index("sws_picks_run_ticker_idx").on(t.runId, t.ticker),
  ],
);

// ── sws_universe_entries ────────────────────────────────────────────────
// Per-run universe roster (~5,517 rows). Universe rarely changes; per-run
// for symmetry with snapshots.

export const swsUniverseEntries = pgTable(
  "sws_universe_entries",
  {
    runId: uuid("run_id")
      .notNull()
      .references(() => swsRuns.id, { onDelete: "cascade" }),
    ticker: varchar("ticker", { length: 32 }).notNull(),
    universeIndex: integer("universe_index"),
    name: varchar("name", { length: 256 }),
    sector: varchar("sector", { length: 96 }),
    industry: varchar("industry", { length: 96 }),
    exchange: varchar("exchange", { length: 16 }),
    swsShortId: varchar("sws_short_id", { length: 32 }),
    swsUrl: text("sws_url"),
    slug: varchar("slug", { length: 256 }),
    indices: jsonb("indices"),
    seedOnly: boolean("seed_only"),
    curated: boolean("curated"),
    marketCapInr: doublePrecision("market_cap_inr"),
    source: varchar("source", { length: 32 }),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.ticker] }),
    index("sws_universe_run_sector_idx").on(t.runId, t.sector),
  ],
);

// ── sws_universe_stats ──────────────────────────────────────────────────
// v3 momentum percentiles per run. One row per run_id.

export const swsUniverseStats = pgTable("sws_universe_stats", {
  runId: uuid("run_id")
    .primaryKey()
    .references(() => swsRuns.id, { onDelete: "cascade" }),
  generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
  universeSize: integer("universe_size"),
  r1m: jsonb("r1m"),
  r3m: jsonb("r3m"),
  r1y: jsonb("r1y"),
  counts: jsonb("counts"),
});

// ── sws_sanity_reports ──────────────────────────────────────────────────
// L1/L2/L3/L6 gate output per run.

export const swsSanityReports = pgTable("sws_sanity_reports", {
  runId: uuid("run_id")
    .primaryKey()
    .references(() => swsRuns.id, { onDelete: "cascade" }),
  generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
  verdict: varchar("verdict", { length: 16 }),
  blockCount: integer("block_count"),
  warnCount: integer("warn_count"),
  passCount: integer("pass_count"),
  totalChecks: integer("total_checks"),
  layers: jsonb("layers"),
});

// ── sws_scrape_failures ─────────────────────────────────────────────────
// Append-only audit log. Improvement over data/sws/failed.json which is
// overwritten each run.

export const swsScrapeFailures = pgTable(
  "sws_scrape_failures",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    runId: uuid("run_id").references(() => swsRuns.id, { onDelete: "set null" }),
    ticker: varchar("ticker", { length: 32 }).notNull(),
    failedTab: varchar("failed_tab", { length: 32 }),
    error: text("error"),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("sws_failures_ticker_recent_idx").on(t.ticker, t.recordedAt)],
);

// ── sws_shard_progress ──────────────────────────────────────────────────
// Three rows, upserted in place every 50 ticks (not per-tick — Neon
// compute-hour budget). Replaces data/sws/progress-api-{1,2,3}.json.

export const swsShardProgress = pgTable("sws_shard_progress", {
  shardId: integer("shard_id").primaryKey(),
  nextLocalIndex: integer("next_local_index").default(0),
  doneCount: integer("done_count").default(0),
  todayCount: integer("today_count").default(0),
  todayDate: date("today_date"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  lastTicker: varchar("last_ticker", { length: 32 }),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  lastDurationMs: integer("last_duration_ms"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── sws_control_flags ───────────────────────────────────────────────────
// Key/value flags: panic_stop, pipeline_lock. TTL via expires_at.
// (refresh_request deferred — not used today; active-shards-lock stays
// file-based as it's process-management state, not DAL-managed.)

export const swsControlFlags = pgTable("sws_control_flags", {
  key: varchar("key", { length: 64 }).primaryKey(),
  value: jsonb("value"),
  holderId: varchar("holder_id", { length: 128 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
});

// ── nse_event_calendar ──────────────────────────────────────────────────
// Out of `data/sws/` proper but lives on the same DB. Mirrors the
// data/sws/nse-event-calendar.json content.

export const nseEventCalendar = pgTable(
  "nse_event_calendar",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    ticker: varchar("ticker", { length: 32 }).notNull(),
    eventDate: date("event_date").notNull(),
    eventType: varchar("event_type", { length: 32 }),
    purpose: text("purpose"),
    meta: jsonb("meta"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("nse_event_unique_idx").on(t.ticker, t.eventDate, t.eventType),
    index("nse_event_ticker_date_idx").on(t.ticker, t.eventDate),
  ],
);
