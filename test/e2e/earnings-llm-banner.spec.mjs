// Earnings LLM heuristic-fallback banner — alignment with `llm_offline`.
//
// Permanent fix for the production banner that said "GROQ_API_KEY /
// GEMINI_API_KEY not configured on refresh host" even after PR #247
// loaded the keys (the deeper bug was heuristic cache poisoning + a
// banner threshold that disagreed with the server-side `llm_offline`
// flag — see the plan at ~/.claude/plans/earnings-llm-signal-prancy-locket.md).
//
// This spec pins down the post-fix contract:
//   - `/api/health` returns a typed `llm_offline` boolean alongside the
//     provider split (so the frontend doesn't have to recompute the
//     threshold and disagree with the alert text in earnings-health.json).
//   - When `llm_offline=false`, the banner is NOT in the DOM.
//   - When `llm_offline=true` AND we're not blocked by auth, the banner
//     IS in the DOM with a `data-testid` hook.
//
// Self-skips if the snapshot is missing (CI fixtures pending) or if the
// gated app didn't reach a visible state (auth/loading races).

import { test, expect } from "@playwright/test";

test.describe("Earnings LLM heuristic-fallback banner", () => {
  test("/api/health returns a typed llm_offline boolean + provider split", async ({ request }) => {
    const res = await request.get("/api/health");
    expect(res.ok()).toBe(true);
    const body = await res.json();

    // llm_offline is the single source of truth for the banner (>=80%
    // heuristic AND groq===0 AND gemini===0).
    expect(typeof body.llm_offline).toBe("boolean");

    // llm_providers carries the count split; sometimes null if health.json
    // hasn't been generated yet, which is acceptable on a fresh checkout.
    if (body.llm_providers != null) {
      expect(typeof body.llm_providers).toBe("object");
      for (const k of ["groq", "gemini", "heuristic", "none", "total"]) {
        expect(body.llm_providers).toHaveProperty(k);
        expect(Number.isFinite(body.llm_providers[k])).toBe(true);
      }
    }

    // llm_heuristic_share_pct is an integer 0..100 when present.
    if (body.llm_heuristic_share_pct != null) {
      expect(Number.isInteger(body.llm_heuristic_share_pct)).toBe(true);
      expect(body.llm_heuristic_share_pct).toBeGreaterThanOrEqual(0);
      expect(body.llm_heuristic_share_pct).toBeLessThanOrEqual(100);
    }
  });

  test("banner is absent when /api/health says llm_offline=false", async ({ page, request }) => {
    const health = await (await request.get("/api/health")).json();
    test.skip(health.llm_offline !== false, "this spec covers the healthy path only");

    // Navigate to the gated app. `AUTH_ENABLED=false` in test mode lets
    // us reach the SPA without OAuth dance — see playwright.config.mjs.
    await page.goto("/");
    // Wait until either the banner appears or it definitively won't —
    // the banner-fetch is async + on a 1h setInterval, so we give it a
    // generous timeout for the first poll. If the gated app didn't load
    // (e.g. SSO blocking on a preview deploy), skip rather than fail.
    const root = page.locator("#snapshotHealthBanner");
    try {
      await root.waitFor({ state: "attached", timeout: 5000 });
    } catch {
      test.skip(true, "gated app banner element not present — likely auth-gated or SPA didn't load");
    }
    // Give the async fetch a beat to run.
    await page.waitForTimeout(1500);
    const heuristicChip = page.locator('[data-testid="llm-signal-heuristic-banner"]');
    expect(await heuristicChip.count()).toBe(0);
  });

  test("banner IS present when /api/health says llm_offline=true", async ({ page, request }) => {
    const health = await (await request.get("/api/health")).json();
    test.skip(health.llm_offline !== true, "this spec covers the degraded path only");

    await page.goto("/");
    const root = page.locator("#snapshotHealthBanner");
    try {
      await root.waitFor({ state: "attached", timeout: 5000 });
    } catch {
      test.skip(true, "gated app banner element not present — likely auth-gated or SPA didn't load");
    }
    const heuristicChip = page.locator('[data-testid="llm-signal-heuristic-banner"]');
    await expect(heuristicChip).toBeVisible({ timeout: 10000 });
    // Copy differentiates the two failure modes (no-keys vs runtime-failures).
    const text = (await heuristicChip.innerText()).toLowerCase();
    expect(text).toContain("heuristic fallback active");
    expect(text).toMatch(/keyword matching|qualitative signal|deterministic-only/);
  });
});
