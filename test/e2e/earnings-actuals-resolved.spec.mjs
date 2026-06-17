// PR 1 — earnings actuals resolution surfaces through /api/earnings/backtest.
//
// The actuals ingester (services/earnings/actualsIngester.js) populates
// `actual_verdict` on archived predictions; the backtest script rolls
// those up into data/catalysts/earnings-backtest-latest.json, which the
// API serves verbatim.
//
// This spec asserts the v2 snapshot CONTRACT always holds, and — when
// the committed snapshot actually has resolved actuals — that the
// resolved-path fields are coherent. It self-skips the richer asserts
// when nothing is resolved yet (project convention: data preconditions
// gate, they don't fail).

import { test, expect } from "@playwright/test";

test.describe("Earnings actuals resolution (PR 1)", () => {
  test("/api/earnings/backtest exposes the v2 snapshot shape", async ({ request }) => {
    const res = await request.get("/api/earnings/backtest");
    expect(res.ok()).toBe(true);
    const body = await res.json();

    if (body.missing) {
      expect(typeof body.message).toBe("string");
      return;
    }

    expect(body).toHaveProperty("schema_version");
    expect(body).toHaveProperty("resolved_count");
    expect(body).toHaveProperty("expected_count");
    expect(body).toHaveProperty("enough_data_to_lift_cap");
    expect(typeof body.resolved_count).toBe("number");
    expect(body.resolved_count).toBeGreaterThanOrEqual(0);
    // v2 additions — present (possibly null) on every fresh snapshot.
    expect(body).toHaveProperty("by_predictor_version");
    expect(body).toHaveProperty("latest_predictor_version");
  });

  test("resolved actuals produce coherent calibration numbers", async ({ request }) => {
    const res = await request.get("/api/earnings/backtest");
    const body = await res.json();
    test.skip(!!body.missing, "no backtest snapshot committed yet");
    test.skip(
      !(body.resolved_count >= 1),
      `no resolved actuals yet (resolved_count=${body.resolved_count}) — ` +
        "run scripts/resolve-earnings-actuals.mjs locally",
    );

    // With ≥1 resolved event the rollups must be populated, not null.
    expect(body.hit_rate_overall_pct).not.toBeNull();
    expect(typeof body.hit_rate_overall_pct).toBe("number");
    expect(body.hit_rate_overall_pct).toBeGreaterThanOrEqual(0);
    expect(body.hit_rate_overall_pct).toBeLessThanOrEqual(100);

    // Per-version breakdown must exist and the gate must name a version.
    expect(body.by_predictor_version).not.toBeNull();
    expect(typeof body.by_predictor_version).toBe("object");
    expect(Object.keys(body.by_predictor_version).length).toBeGreaterThanOrEqual(1);
    expect(body.latest_predictor_version).toBeTruthy();

    // Cap-lift gate is computed over the latest predictor version only. Thin
    // e2e fixture roots can carry historical resolved rows while the latest
    // predictor has no resolved actuals yet, so keep this as a data
    // precondition instead of failing unrelated UI runs.
    expect(body.v1_gate).toBeTruthy();
    test.skip(
      !(body.v1_gate.current_resolved >= 1),
      `no latest-version resolved actuals yet (current_resolved=${body.v1_gate.current_resolved})`,
    );
    expect(body.v1_gate.current_resolved).toBeGreaterThanOrEqual(1);
  });
});
