// Regression guard for the picks-vs-snapshots Fair-Value drift bug.
//
// THE BUG (2026-05-18, fixed in PR following ~/.claude/plans/so-i-have-
// attached-virtual-sphinx.md): the homepage Upcoming Earnings card for
// STAR showed FV ₹1,264 while the stock detail modal showed ₹1,078.5 —
// because /api/sws-picks reads from the sws_picks table (written by
// scoring) and /api/sws-stock/:t reads from sws_company_snapshots
// (written by the parser); a mid-day partial parser run can update
// snapshots without re-running scoring, leaving picks stale.
//
// THE FIX (Layer 1 — read-time guard in server.js): /api/sws-picks now
// looks up each ticker's snapshot via swsDal.getSnapshotFvMap, overwrites
// fair_value_inr (+ current_price_inr, upside_pct) when the picks-side
// value drifts, and surfaces a per-row `_fv_drift` marker plus a
// response-level `_meta.fv_drift_count`. The two endpoints can therefore
// never disagree on Fair Value at response time.
//
// This spec exercises the guarantee against a live server. It samples
// tickers from the picks response and cross-checks each against the
// stock-detail endpoint. Self-skips when no fixture data is loaded
// (per CLAUDE.md test-gate convention).

import { test, expect } from "@playwright/test";

const FV_TOLERANCE = 0.01; // same threshold the guard uses
const SAMPLE_PER_SECTION = 5; // bounded so the spec stays fast

test.describe("/api/sws-picks Fair-Value consistency vs /api/sws-stock/:t", () => {
  test("response includes _meta.fv_drift_count (post-Layer-1 schema)", async ({ request }) => {
    const r = await request.get("/api/sws-picks");
    if (r.status() === 404) return; // no picks data loaded
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body).toHaveProperty("_meta");
    expect(typeof body._meta.fv_drift_count).toBe("number");
    expect(body._meta.fv_drift_count).toBeGreaterThanOrEqual(0);
    expect(typeof body._meta.missing_deep_count).toBe("number");
    expect(Array.isArray(body._meta.missing_deep_sample)).toBe(true);
    const servedRows = Object.values(body.sections || {}).reduce(
      (sum, items) => sum + (Array.isArray(items) ? items.length : 0),
      0,
    );
    if (Number(body.scored_count) > 0) {
      expect(servedRows, "India Market must not render 0 rows when scored_count is positive").toBeGreaterThan(0);
    }
  });

  test("served cards always resolve through /api/sws-stock/:ticker", async ({ request }) => {
    const picksRes = await request.get("/api/sws-picks");
    if (picksRes.status() === 404) return; // empty fixture
    expect(picksRes.status()).toBe(200);
    const picks = await picksRes.json();
    if (!picks?.sections || typeof picks.sections !== "object") return;

    const sampled = [];
    const seen = new Set();
    for (const [sectionKey, items] of Object.entries(picks.sections)) {
      if (!Array.isArray(items)) continue;
      for (const it of items.slice(0, SAMPLE_PER_SECTION)) {
        if (!it?.ticker || seen.has(it.ticker)) continue;
        seen.add(it.ticker);
        sampled.push({ ticker: it.ticker, section: sectionKey });
      }
    }
    expect(sampled.length, "India picks response must expose at least one card when sections are present").toBeGreaterThan(0);

    const missing = [];
    for (const item of sampled) {
      const sr = await request.get(`/api/sws-stock/${encodeURIComponent(item.ticker)}`);
      if (sr.status() !== 200) missing.push({ ...item, status: sr.status() });
    }
    expect(
      missing,
      `/api/sws-picks served cards without deep data: ${JSON.stringify(missing.slice(0, 10))}`,
    ).toEqual([]);
  });

  test("every card's fair_value_inr equals the snapshot's overview.fair_value_inr", async ({ request }) => {
    const picksRes = await request.get("/api/sws-picks");
    if (picksRes.status() === 404) return; // empty fixture
    expect(picksRes.status()).toBe(200);
    const picks = await picksRes.json();
    if (!picks?.sections || typeof picks.sections !== "object") return;

    // Sample up to SAMPLE_PER_SECTION tickers per section. Dedupe across
    // sections so we don't pay for the same /api/sws-stock call twice.
    const sampled = new Map(); // ticker → { section, fair_value_inr }
    for (const [sectionKey, items] of Object.entries(picks.sections)) {
      if (!Array.isArray(items)) continue;
      for (const it of items.slice(0, SAMPLE_PER_SECTION)) {
        if (!it?.ticker) continue;
        if (sampled.has(it.ticker)) continue;
        // Skip rows where FV is null (the "FV unavailable" path is by
        // design, not drift).
        if (!Number.isFinite(it.fair_value_inr)) continue;
        sampled.set(it.ticker, { section: sectionKey, fair_value_inr: it.fair_value_inr });
      }
    }
    if (sampled.size === 0) return; // nothing scorable in this fixture

    // Cross-check each against the per-stock endpoint. Bounded concurrency
    // (~6 in flight) keeps the test fast without flooding the dev server.
    const entries = [...sampled.entries()];
    const concurrency = 6;
    const mismatches = [];
    for (let i = 0; i < entries.length; i += concurrency) {
      const batch = entries.slice(i, i + concurrency);
      const results = await Promise.all(
        batch.map(async ([ticker, info]) => {
          const sr = await request.get(`/api/sws-stock/${encodeURIComponent(ticker)}`);
          if (sr.status() !== 200) return null;
          const sd = await sr.json();
          const deepFv = sd?.deep?.overview?.fair_value_inr;
          if (!Number.isFinite(deepFv)) return null;
          if (Math.abs(info.fair_value_inr - deepFv) > FV_TOLERANCE) {
            return { ticker, section: info.section, cardFv: info.fair_value_inr, deepFv };
          }
          return null;
        }),
      );
      for (const r of results) if (r) mismatches.push(r);
    }

    expect(
      mismatches,
      `picks/snapshot FV drift on ${mismatches.length} tickers: ${JSON.stringify(mismatches.slice(0, 10))}`,
    ).toEqual([]);
  });

  test("ALEMBICLTD-like high but plausible FV is corrected from deep snapshot", async ({ request }) => {
    const picksRes = await request.get("/api/sws-picks");
    if (picksRes.status() === 404) return;
    expect(picksRes.status()).toBe(200);
    const picks = await picksRes.json();
    const rows = Object.values(picks.sections || {}).flatMap((items) => Array.isArray(items) ? items : []);
    const alembic = rows.find((it) => it?.ticker === "ALEMBICLTD");
    test.skip(!alembic, "ALEMBICLTD is not present in today's picks sections");

    expect(alembic.fair_value_inr).toBeGreaterThan(700);
    expect(alembic.upside_pct).toBeGreaterThan(700);
    expect(alembic.fv_reconcile_reason).toBe("ok");

    const stockRes = await request.get("/api/sws-stock/ALEMBICLTD");
    expect(stockRes.status()).toBe(200);
    const stock = await stockRes.json();
    expect(stock.card.fair_value_inr).toBe(alembic.fair_value_inr);
    expect(stock.card.upside_pct).toBe(alembic.upside_pct);
    expect(stock.card.fv_reconcile_reason).toBe("ok");
  });

  test("when _fv_drift is set on a row, the row's fair_value_inr was overwritten to snap value", async ({ request }) => {
    const r = await request.get("/api/sws-picks");
    if (r.status() === 404) return;
    expect(r.status()).toBe(200);
    const body = await r.json();
    if (!body?.sections) return;

    let drifted = 0;
    for (const items of Object.values(body.sections)) {
      if (!Array.isArray(items)) continue;
      for (const it of items) {
        if (!it?._fv_drift) continue;
        drifted++;
        // Contract: the row's fair_value_inr now matches snap (the post-guard value).
        expect(Number(it.fair_value_inr)).toBeCloseTo(it._fv_drift.snap, 2);
        // Contract: pick (the original stale value) DIFFERS from snap by > tolerance.
        expect(Math.abs(it._fv_drift.pick - it._fv_drift.snap)).toBeGreaterThan(FV_TOLERANCE);
      }
    }

    // _meta.fv_drift_count must equal the number of rows with _fv_drift.
    expect(body._meta.fv_drift_count).toBe(drifted);
  });
});
