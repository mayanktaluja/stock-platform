/**
 * Tests for services/earnings/signalAggregator.js
 *
 * Focus: data_quality tier classification + sector-momentum
 * computation + safe handling of empty/missing inputs. Tests run
 * with hand-crafted contexts (no disk I/O) so they're hermetic.
 *
 * Run with: node test/signalAggregator.test.mjs
 */

import {
  buildAggregatorContext,
  aggregateSignalsForEvent,
  summariseSignals,
} from "../services/earnings/signalAggregator.js";

let pass = 0, fail = 0;
function assert(name, cond, got) {
  if (cond) { console.log(`✓ ${name}`); pass++; }
  else { console.log(`✗ ${name} — got: ${JSON.stringify(got)}`); fail++; }
}

// Build a hand-crafted context with everything injected (no disk).
function ctxWith({ swsByTicker = {}, history = {}, picks = {}, upcoming = {}, sectorMomentum = new Map() }) {
  // Convert the upcoming/picks objects (keyed by ticker) into the
  // sectioned shape the aggregator expects.
  const sections = {
    upcoming_earnings: Object.values(upcoming),
    top_ranked_30_v3: Object.values(picks),
  };
  return buildAggregatorContext({
    fundamentalsHistory: { stocks: history },
    picksLatest: { sections },
    readSwsDeep: (sym) => swsByTicker[sym] || null,
    sectorMomentumMap: sectorMomentum,
  });
}

// ──── HIGH tier: in upcoming_earnings + has SWS deep + sector + returns ────
{
  const ctx = ctxWith({
    swsByTicker: {
      ABC: {
        sector: "Materials",
        overview: {
          returns_pct: { "1Y": 25, "1M": 5, "3M": 12 },
          snowflake_total: 22,
          market_cap_inr: 1e11,
          multiples: { pe: 18 },
          upside_pct: 12,
        },
      },
    },
    upcoming: {
      ABC: { ticker: "ABC", composite_verdict: "STRONG", v3_verdict: "STRONG", v3_score_100: 75, snowflake_total: 22, current_price_inr: 500, counter_thesis: { text: "test", falsification_trigger: ["a", "b", "c"] } },
    },
    sectorMomentum: new Map([["Materials", { avg_1m_pct: 4, sample_size: 50 }]]),
  });
  const event = aggregateSignalsForEvent({ symbol: "ABC", event_iso_date: "2026-05-12", days_until: 3 }, ctx, { includeSectorMomentum: false });
  assert("HIGH: data_quality=HIGH", event.signals.data_quality === "HIGH", event.signals.data_quality);
  assert("HIGH: sws_upcoming_earnings populated", event.signals.sws_upcoming_earnings != null, event.signals.sws_upcoming_earnings);
  assert("HIGH: counter_thesis forwarded", Array.isArray(event.signals.sws_upcoming_earnings?.counter_thesis?.falsification_trigger), event.signals.sws_upcoming_earnings?.counter_thesis);
  assert("HIGH: runup_vs_sector computed", event.signals.momentum.runup_vs_sector_pct === 1, event.signals.momentum);
}

// ──── MEDIUM tier: has SWS deep but NOT in upcoming_earnings ────
{
  const ctx = ctxWith({
    swsByTicker: {
      DEF: {
        sector: "Tech",
        overview: { returns_pct: { "1Y": 10 }, snowflake_total: 15, market_cap_inr: 1e10 },
      },
    },
    sectorMomentum: new Map([["Tech", { avg_1m_pct: 0, sample_size: 30 }]]),
  });
  const event = aggregateSignalsForEvent({ symbol: "DEF", event_iso_date: "2026-05-12", days_until: 3 }, ctx, { includeSectorMomentum: false });
  assert("MEDIUM: data_quality=MEDIUM", event.signals.data_quality === "MEDIUM", event.signals.data_quality);
  assert("MEDIUM: sws_upcoming_earnings is null", event.signals.sws_upcoming_earnings === null, event.signals.sws_upcoming_earnings);
}

// ──── LOW tier: no SWS deep at all ────
{
  const ctx = ctxWith({ swsByTicker: {} });
  const event = aggregateSignalsForEvent({ symbol: "GHI", event_iso_date: "2026-05-12", days_until: 3 }, ctx, { includeSectorMomentum: false });
  assert("LOW: data_quality=LOW", event.signals.data_quality === "LOW", event.signals.data_quality);
  assert("LOW: sector is null", event.signals.sector === null, event.signals.sector);
  assert("LOW: snowflake is null", event.signals.snowflake_total === null, event.signals.snowflake_total);
}

// ──── Pre-runup classification ────
{
  // Stock 12% up vs sector 2% — spike (>8 pts above + stock >10%)
  const ctx = ctxWith({
    swsByTicker: { JKL: { sector: "X", overview: { returns_pct: { "1M": 12, "1Y": 30 } } } },
    sectorMomentum: new Map([["X", { avg_1m_pct: 2, sample_size: 30 }]]),
  });
  const event = aggregateSignalsForEvent({ symbol: "JKL", event_iso_date: "2026-05-12", days_until: 3 }, ctx, { includeSectorMomentum: false });
  assert("Spike runup detected", event.signals.momentum.pre_runup_signal === "spike", event.signals.momentum);
}
{
  // Stock 4% up vs sector 0% — smooth (3-8 pts above sector)
  const ctx = ctxWith({
    swsByTicker: { MNO: { sector: "Y", overview: { returns_pct: { "1M": 4, "1Y": 10 } } } },
    sectorMomentum: new Map([["Y", { avg_1m_pct: 0, sample_size: 30 }]]),
  });
  const event = aggregateSignalsForEvent({ symbol: "MNO", event_iso_date: "2026-05-12", days_until: 3 }, ctx, { includeSectorMomentum: false });
  assert("Smooth runup detected", event.signals.momentum.pre_runup_signal === "smooth", event.signals.momentum);
}
{
  // Stock -8% vs sector +5% — lagging
  const ctx = ctxWith({
    swsByTicker: { PQR: { sector: "Z", overview: { returns_pct: { "1M": -8, "1Y": 5 } } } },
    sectorMomentum: new Map([["Z", { avg_1m_pct: 5, sample_size: 30 }]]),
  });
  const event = aggregateSignalsForEvent({ symbol: "PQR", event_iso_date: "2026-05-12", days_until: 3 }, ctx, { includeSectorMomentum: false });
  assert("Lagging runup detected", event.signals.momentum.pre_runup_signal === "lagging", event.signals.momentum);
}

// ──── P2.4 — Trajectory data-quality flag ────
{
  // Covered: stock is in fundamentalsHistory with >=2 quarters with non-
  // null dilutedEPS → trajectory = "covered".
  const ctx = ctxWith({
    swsByTicker: {
      ABC: { sector: "Materials", overview: { returns_pct: { "1Y": 10, "1M": 3 } } },
    },
    history: {
      "ABC.NS": {
        quarterly: [
          { endDate: "2025-03-31", dilutedEPS: 5, totalRevenue: 1000 },
          { endDate: "2025-06-30", dilutedEPS: 6, totalRevenue: 1100 },
          { endDate: "2025-09-30", dilutedEPS: 7, totalRevenue: 1200 },
        ],
      },
    },
    sectorMomentum: new Map([["Materials", { avg_1m_pct: 2, sample_size: 30 }]]),
  });
  const event = aggregateSignalsForEvent(
    { symbol: "ABC", event_iso_date: "2026-05-12", days_until: 3 },
    ctx,
    { includeSectorMomentum: false },
  );
  assert(
    "P2.4: data_quality_flags.trajectory = 'covered' when ≥2 quarters with EPS",
    event.signals.data_quality_flags?.trajectory === "covered",
    event.signals.data_quality_flags,
  );
  assert(
    "P2.4: data_quality_inputs.trajectory_coverage mirrors the flag",
    event.signals.data_quality_inputs?.trajectory_coverage === "covered",
    event.signals.data_quality_inputs,
  );
}
{
  // Absent: stock missing from fundamentalsHistory entirely (the common
  // case — ~4,000 tickers).
  const ctx = ctxWith({
    swsByTicker: {
      XYZ: { sector: "Tech", overview: { returns_pct: { "1Y": 10, "1M": 3 } } },
    },
    history: {},
    sectorMomentum: new Map([["Tech", { avg_1m_pct: 2, sample_size: 30 }]]),
  });
  const event = aggregateSignalsForEvent(
    { symbol: "XYZ", event_iso_date: "2026-05-12", days_until: 3 },
    ctx,
    { includeSectorMomentum: false },
  );
  assert(
    "P2.4: data_quality_flags.trajectory = 'absent' when ticker missing",
    event.signals.data_quality_flags?.trajectory === "absent",
    event.signals.data_quality_flags,
  );
}
{
  // Absent: ticker present in history but only 1 quarter with non-null
  // EPS — can't form a YoY pair anyway, treated as "absent" so the
  // predictor surfaces UNKNOWN-not-NEGATIVE.
  const ctx = ctxWith({
    swsByTicker: {
      ABC: { sector: "Materials", overview: { returns_pct: { "1Y": 10, "1M": 3 } } },
    },
    history: {
      "ABC.NS": {
        quarterly: [
          { endDate: "2025-09-30", dilutedEPS: 7, totalRevenue: 1200 },
          { endDate: "2025-06-30", dilutedEPS: null, totalRevenue: 1100 },
        ],
      },
    },
    sectorMomentum: new Map([["Materials", { avg_1m_pct: 2, sample_size: 30 }]]),
  });
  const event = aggregateSignalsForEvent(
    { symbol: "ABC", event_iso_date: "2026-05-12", days_until: 3 },
    ctx,
    { includeSectorMomentum: false },
  );
  assert(
    "P2.4: <2 quarters with non-null EPS → 'absent'",
    event.signals.data_quality_flags?.trajectory === "absent",
    event.signals.data_quality_flags,
  );
}

// ──── P2.7 — Sector volatility surfaced when present ────
{
  // Sector momentum map carries an optional vol_1m_pct — surface it
  // through to signals.momentum.sector_volatility_1m_pct AND stamp
  // data_quality_flags.sector_vol = "scaled".
  const ctx = ctxWith({
    swsByTicker: {
      ABC: { sector: "Materials", overview: { returns_pct: { "1Y": 10, "1M": 3 } } },
    },
    sectorMomentum: new Map([
      ["Materials", { avg_1m_pct: 5, sample_size: 30, vol_1m_pct: 4.5 }],
    ]),
  });
  const event = aggregateSignalsForEvent(
    { symbol: "ABC", event_iso_date: "2026-05-12", days_until: 3 },
    ctx,
    { includeSectorMomentum: false },
  );
  assert(
    "P2.7: sector_volatility_1m_pct forwarded when present",
    event.signals.momentum.sector_volatility_1m_pct === 4.5,
    event.signals.momentum,
  );
  assert(
    "P2.7: data_quality_flags.sector_vol = 'scaled' when vol present",
    event.signals.data_quality_flags?.sector_vol === "scaled",
    event.signals.data_quality_flags,
  );
}
{
  // No vol on the sector map → sector_volatility_1m_pct is null and
  // data_quality_flags.sector_vol = "unscaled". Preserves legacy
  // unscaled predictor path.
  const ctx = ctxWith({
    swsByTicker: {
      ABC: { sector: "Materials", overview: { returns_pct: { "1Y": 10, "1M": 3 } } },
    },
    sectorMomentum: new Map([["Materials", { avg_1m_pct: 5, sample_size: 30 }]]),
  });
  const event = aggregateSignalsForEvent(
    { symbol: "ABC", event_iso_date: "2026-05-12", days_until: 3 },
    ctx,
    { includeSectorMomentum: false },
  );
  assert(
    "P2.7: sector_volatility_1m_pct = null when not on map",
    event.signals.momentum.sector_volatility_1m_pct === null,
    event.signals.momentum,
  );
  assert(
    "P2.7: data_quality_flags.sector_vol = 'unscaled' when vol absent",
    event.signals.data_quality_flags?.sector_vol === "unscaled",
    event.signals.data_quality_flags,
  );
}

// ──── summariseSignals roll-up ────
{
  const events = [
    { signals: { data_quality: "HIGH", sector: "Tech", momentum: { pre_runup_signal: "spike" } } },
    { signals: { data_quality: "HIGH", sector: "Tech", momentum: { pre_runup_signal: "smooth" } } },
    { signals: { data_quality: "MEDIUM", sector: "Materials", momentum: { pre_runup_signal: "lagging" } } },
    { signals: { data_quality: "LOW", momentum: { pre_runup_signal: "neutral" } } },
  ];
  const s = summariseSignals(events);
  assert("summarise: HIGH count", s.by_data_quality.HIGH === 2, s);
  assert("summarise: MEDIUM count", s.by_data_quality.MEDIUM === 1, s);
  assert("summarise: LOW count", s.by_data_quality.LOW === 1, s);
  assert("summarise: spike count", s.by_pre_runup.spike === 1, s);
  assert("summarise: top sector = Tech (2)", s.top_sectors[0]?.sector === "Tech" && s.top_sectors[0]?.count === 2, s.top_sectors);
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
