// PR D regression: the snapshot-staleness banner.
//
// /api/health/snapshots grew from 5 monitored fixtures to 11. Two things must
// hold:
//   1. The server response actually carries all 11 snapshot keys, each with
//      a numeric max_age_hours and a boolean stale flag.
//   2. The banner (#snapshotHealthBanner, rendered by loadSnapshotHealth in
//      gated/app.js) shows a human label — not the raw key — for any stale
//      fixture, and stays hidden when nothing is stale.

import { test, expect } from "@playwright/test";
import { gotoApp } from "./helpers/app.mjs";

const EXPECTED_SNAPSHOT_KEYS = [
  "fundamentals",
  "surveillance",
  "governance",
  "picks_latest",
  "macro_regime",
  "fundamentals_history",
  "macro_calendar",
  "events_latest",
  "oi_deltas",
  "earnings_watch",
  "universe",
];

test.describe("snapshot-health banner (PR D)", () => {
  test("GET /api/health/snapshots reports all 11 monitored fixtures", async ({ page }) => {
    const res = await page.request.get("/api/health/snapshots");
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.snapshots, "response has a snapshots object").toBeTruthy();
    for (const key of EXPECTED_SNAPSHOT_KEYS) {
      const entry = body.snapshots[key];
      expect(entry, `snapshots.${key} present`).toBeTruthy();
      expect(typeof entry.max_age_hours, `snapshots.${key}.max_age_hours is numeric`).toBe("number");
      expect(typeof entry.stale, `snapshots.${key}.stale is boolean`).toBe("boolean");
    }
  });

  test("banner renders human labels for stale fixtures", async ({ page }) => {
    // Stub the health endpoint BEFORE the app boots, so the loadSnapshotHealth()
    // call in the DOMContentLoaded handler sees the stub.
    await page.route("**/api/health/snapshots", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          anyStale: true,
          staleKeys: ["fundamentals_history", "macro_calendar", "oi_deltas"],
          anyDegraded: false,
          degradedKeys: [],
          snapshots: {
            fundamentals_history: { generatedAt: "2026-01-01T00:00:00Z", age_hours: 200, max_age_hours: 72, stale: true },
            macro_calendar: { generatedAt: "2026-01-01", age_hours: 800, max_age_hours: 720, stale: true },
            oi_deltas: { generatedAt: "2026-01-01T00:00:00Z", age_hours: 100, max_age_hours: 48, stale: true },
          },
          checkedAt: new Date().toISOString(),
        }),
      }),
    );
    await gotoApp(page);
    const banner = page.locator("#snapshotHealthBanner");
    await expect(banner).toBeVisible({ timeout: 10_000 });
    const text = await banner.innerText();
    expect(text).toContain("Fundamentals history");
    expect(text).toContain("Macro calendar");
    expect(text).toContain("F&O OI deltas");
    // Raw snapshot keys must never leak into the user-facing banner.
    expect(text).not.toContain("fundamentals_history");
    expect(text).not.toContain("oi_deltas");
  });

  test("banner stays hidden when nothing is stale", async ({ page }) => {
    await page.route("**/api/health/snapshots", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          anyStale: false,
          staleKeys: [],
          anyDegraded: false,
          degradedKeys: [],
          snapshots: {},
          checkedAt: new Date().toISOString(),
        }),
      }),
    );
    await gotoApp(page);
    await expect(page.locator("#snapshotHealthBanner")).toBeHidden({ timeout: 10_000 });
  });
});
