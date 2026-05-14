// PR 3 — SWS V3 100-pt breakdown is wired into the predictor.
//
// v2 of the predictor replaces the old ±32 composite-verdict echo with
// three decomposed V3 components (future+past, valuation, overlay). The
// signal is surfaced as `signals.v3` (resolved from an upcoming_earnings
// row, any picks row, or an inline computeV3Score off the SWS deep file)
// and scored into `prediction.score_breakdown.v3_*`.
//
// The headline regression this guards: the verdict mix used to be 73%
// INLINE because the predictor just echoed SWS's verdict. With the V3
// pillars decomposed it falls to ~52% — a real, independent signal.

import { test, expect } from "@playwright/test";

test.describe("Earnings V3 breakdown wiring (PR 3)", () => {
  test("scored events carry the v2 V3 components + a signals.v3 block", async ({ request }) => {
    const res = await request.get("/api/earnings/upcoming");
    expect(res.ok()).toBe(true);
    const body = await res.json();
    test.skip(!!body.missing, "no earnings snapshot committed yet");

    const scored = body.events.filter((e) => e.prediction?.verdict !== "INSUFFICIENT_DATA");
    expect(scored.length).toBeGreaterThan(0);

    for (const e of scored) {
      const sb = e.prediction.score_breakdown;
      expect(sb).toBeTruthy();
      // The three v2 V3 components must be finite numbers.
      expect(Number.isFinite(sb.v3_future_past)).toBe(true);
      expect(Number.isFinite(sb.v3_valuation)).toBe(true);
      expect(Number.isFinite(sb.v3_overlay)).toBe(true);
      // v3_overlay is penalty-only — never positive.
      expect(sb.v3_overlay).toBeLessThanOrEqual(0);
    }

    // The bulk of scored events should carry a resolved V3 block, tagged
    // with how it was resolved.
    const withV3 = scored.filter((e) => e.signals?.v3?.breakdown);
    expect(withV3.length / scored.length).toBeGreaterThan(0.8);
    for (const e of withV3.slice(0, 20)) {
      expect(["upcoming", "picks", "computed"]).toContain(e.signals.v3.source);
      expect(Number.isFinite(e.signals.v3.breakdown.pts_future)).toBe(true);
      expect(Number.isFinite(e.signals.v3.breakdown.pts_past)).toBe(true);
    }
  });

  test("verdict mix is no longer INLINE-dominated (V3 echo broken)", async ({ request }) => {
    const res = await request.get("/api/earnings/upcoming");
    const body = await res.json();
    test.skip(!!body.missing, "no earnings snapshot committed yet");

    const counts = { BEAT: 0, INLINE: 0, MISS: 0, INSUFFICIENT_DATA: 0 };
    for (const e of body.events) {
      const v = e.prediction?.verdict;
      if (v && counts[v] != null) counts[v] += 1;
    }
    const total = body.events.length;
    // Pre-PR-3 the predictor echoed the SWS composite verdict and 73%
    // of events landed on INLINE. The decomposed V3 pillars pull that
    // to ~52%. 65% is a slack regression guard — a regression back to
    // verdict-echo would blow past it.
    expect(counts.INLINE / total).toBeLessThan(0.65);
    // And both directional verdicts must be meaningfully represented.
    expect(counts.BEAT).toBeGreaterThan(20);
    expect(counts.MISS).toBeGreaterThan(20);
  });
});
