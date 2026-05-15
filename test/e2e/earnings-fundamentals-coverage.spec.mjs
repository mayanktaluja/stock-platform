// PR 2 — fundamentals coverage surfaces through /api/earnings/upcoming.
//
// scripts/refresh-fundamentals-history.mjs grows fundamentalsHistory.json
// (curated stockList ∪ Earnings Watch symbols) and the next
// refresh-earnings run folds the fresh quarterly EPS into each event's
// `signals.trajectory.eps_yoy_pct`. That field drives the predictor's
// YoY-EPS-trajectory component (±15 pts) — it was null for ~95% of
// events before this PR.
//
// This spec asserts the trajectory field's CONTRACT always holds, and
// that the committed snapshot carries a healthy coverage level (the
// regression guard: a broken fundamentals refresh would crater this).

import { test, expect } from "@playwright/test";

test.describe("Earnings fundamentals coverage (PR 2)", () => {
  test("every event exposes a trajectory block", async ({ request }) => {
    const res = await request.get("/api/earnings/upcoming");
    expect(res.ok()).toBe(true);
    const body = await res.json();
    test.skip(!!body.missing, "no earnings snapshot committed yet");
    expect(Array.isArray(body.events)).toBe(true);
    expect(body.events.length).toBeGreaterThan(0);

    for (const e of body.events) {
      expect(e.signals).toBeTruthy();
      // trajectory is always an object — eps_yoy_pct is a number or null.
      expect(e.signals.trajectory).toBeTruthy();
      const eps = e.signals.trajectory.eps_yoy_pct;
      expect(eps === null || typeof eps === "number").toBe(true);
    }
  });

  test("YoY-EPS trajectory is populated for the bulk of events", async ({ request }) => {
    const res = await request.get("/api/earnings/upcoming");
    const body = await res.json();
    test.skip(!!body.missing, "no earnings snapshot committed yet");

    const total = body.events.length;
    const withEps = body.events.filter(
      (e) => e.signals?.trajectory?.eps_yoy_pct != null,
    ).length;

    // Pre-PR-2 baseline was 25/488 (~5%). The fundamentals refresh lifts
    // this to ~389/488 (~80%). 250 is a deliberately slack regression
    // guard — it stays green as the earnings calendar rotates, but a
    // broken or un-run fundamentals refresh (back toward the ~25
    // baseline) trips it loudly.
    expect(withEps).toBeGreaterThanOrEqual(250);
    // Sanity: can't have more covered than total.
    expect(withEps).toBeLessThanOrEqual(total);
  });
});
