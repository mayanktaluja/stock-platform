// Cross-market SWS data-health smoke.
//
// India requires strict list/detail consistency because India cards open the
// rich /api/sws-stock modal. Regional markets may legitimately fall back from
// deep brief to card/universe data, but each served card must still have a
// resolvable market-specific detail endpoint and currency contract.

import { test, expect } from "@playwright/test";

const SAMPLE_PER_MARKET = 5;

function sampleTickersFromSections(sections, limit = SAMPLE_PER_MARKET) {
  const out = [];
  const seen = new Set();
  for (const [sectionKey, items] of Object.entries(sections || {})) {
    if (!Array.isArray(items)) continue;
    for (const it of items) {
      if (!it?.ticker || seen.has(it.ticker)) continue;
      seen.add(it.ticker);
      out.push({ ticker: it.ticker, section: sectionKey });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

test.describe("SWS data health", () => {
  test("India picks only serve cards with rich deep data", async ({ request }) => {
    const picksRes = await request.get("/api/sws-picks");
    if (picksRes.status() === 404) return;
    expect(picksRes.status()).toBe(200);
    const picks = await picksRes.json();
    expect(typeof picks?._meta?.missing_deep_count).toBe("number");

    const sampled = sampleTickersFromSections(picks.sections);
    test.skip(sampled.length === 0, "no India SWS cards in current fixture");

    const failures = [];
    for (const item of sampled) {
      const detailRes = await request.get(`/api/sws-stock/${encodeURIComponent(item.ticker)}`);
      if (detailRes.status() !== 200) {
        failures.push({ ...item, status: detailRes.status() });
        continue;
      }
      const detail = await detailRes.json();
      if (!detail?.deep) failures.push({ ...item, status: 200, error: "missing deep payload" });
    }
    expect(failures, `India card/detail drift: ${JSON.stringify(failures)}`).toEqual([]);
  });

  test("India Gap Lab rows resolve to warning-compatible stock detail metadata", async ({ request }) => {
    const picksRes = await request.get("/api/sws-picks");
    if (picksRes.status() === 404) return;
    expect(picksRes.status()).toBe(200);
    const picks = await picksRes.json();
    const gapRows = Array.isArray(picks?.sections?.snowflake_gap_lab)
      ? picks.sections.snowflake_gap_lab.slice(0, SAMPLE_PER_MARKET)
      : [];
    test.skip(gapRows.length === 0, "no India Snowflake Gap Lab rows in current fixture");

    const failures = [];
    for (const row of gapRows) {
      if (!row?.ticker) continue;
      if (Object.prototype.hasOwnProperty.call(row, "snowflake_data_quality")) {
        failures.push({ ticker: row.ticker, error: "card exposes snowflake_data_quality" });
      }
      if (Object.prototype.hasOwnProperty.call(row, "snowflake_check_matrix")) {
        failures.push({ ticker: row.ticker, error: "card exposes snowflake_check_matrix" });
      }
      if (row?.overview != null) {
        failures.push({ ticker: row.ticker, error: "card exposes deep overview" });
      }

      const detailRes = await request.get(`/api/sws-stock/${encodeURIComponent(row.ticker)}`);
      if (detailRes.status() !== 200) {
        failures.push({ ticker: row.ticker, status: detailRes.status() });
        continue;
      }
      const detail = await detailRes.json();
      const ov = detail?.deep?.overview || {};
      if (ov.snowflake_data_quality?.insufficient !== true) {
        failures.push({ ticker: row.ticker, status: 200, error: "missing insufficient-data metadata" });
      }
      if (!Array.isArray(ov.snowflake_check_matrix?.checks) || ov.snowflake_check_matrix.checks.length === 0) {
        failures.push({ ticker: row.ticker, status: 200, error: "missing warning-compatible check matrix" });
      }
    }

    expect(failures, `Gap Lab detail warning contract drift: ${JSON.stringify(failures)}`).toEqual([]);
  });

  test("India detail derives Snowflake warning metadata from real check matrix before Gap Lab fallback", async ({ request }) => {
    const detailRes = await request.get("/api/sws-stock/TIMETECHNO");
    test.skip(detailRes.status() === 404, "TIMETECHNO fixture not present in current India SWS data");
    expect(detailRes.status()).toBe(200);
    const detail = await detailRes.json();
    const ov = detail?.deep?.overview || {};
    const matrix = ov.snowflake_check_matrix;
    test.skip(!Array.isArray(matrix?.checks), "TIMETECHNO fixture has no Snowflake check matrix");
    test.skip(!detail?.card?.snowflake_gap_lab, "TIMETECHNO fixture is not currently a Gap Lab row");

    expect(ov.snowflake_data_quality?.insufficient).toBe(true);
    expect(["snowflake_check_matrix", "snowflake_data_quality"]).toContain(ov.snowflake_data_quality?.source);
    expect(ov.snowflake_data_quality?.source).not.toBe("snowflake_gap_lab_fallback");
    expect(ov.snowflake_data_quality?.fallback).toBeUndefined();
    expect(ov.snowflake_data_quality?.by_pillar?.Future?.insufficient).toBe(
      matrix.checks.filter((check) => check.pillar === "Future" && check.insufficient === true).length,
    );
    expect(ov.snowflake_data_quality?.samples?.some((sample) => sample.title === "High Growth Earnings")).toBe(true);
  });

  for (const market of [
    { code: "us", label: "US", currency: "USD" },
    { code: "kr", label: "Korea", currency: "KRW" },
    { code: "tw", label: "Taiwan", currency: "TWD" },
  ]) {
    test(`${market.label} picks resolve via regional detail fallback contract`, async ({ request }) => {
      const picksRes = await request.get(`/api/${market.code}-picks`);
      if (picksRes.status() === 404) return;
      expect(picksRes.status()).toBe(200);
      const picks = await picksRes.json();
      const sampled = sampleTickersFromSections(picks.sections);
      test.skip(sampled.length === 0, `no ${market.label} cards in current fixture`);

      const failures = [];
      for (const item of sampled) {
        const detailRes = await request.get(`/api/${market.code}-stock/${encodeURIComponent(item.ticker)}`);
        if (detailRes.status() !== 200) {
          failures.push({ ...item, status: detailRes.status() });
          continue;
        }
        const detail = await detailRes.json();
        if (detail.currency !== market.currency) {
          failures.push({ ...item, status: 200, error: `currency ${detail.currency}` });
        }
        if (!detail.deep && !detail.card) {
          failures.push({ ...item, status: 200, error: "no deep or card fallback" });
        }
      }
      expect(failures, `${market.label} card/detail drift: ${JSON.stringify(failures)}`).toEqual([]);
    });
  }
});
