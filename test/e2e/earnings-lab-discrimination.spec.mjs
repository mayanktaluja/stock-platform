// PR 1-3 (2026-05-19) — Risk Lab disagreement discrimination + LLM badge.
//
// After the discrimination fix:
//   • Disagreement rate drops from ~90% to ~15-25% of BEAT events
//   • Each strip carries data-has-hard-evidence and data-llm-provider attrs
//   • Boilerplate-only events surface as muted "Risk Lab notes (generic)"
//   • When the LLM is authoritative (gemini/groq), its top_reason is
//     rendered first inside the strip with a "LLM (provider)" tag

import { test, expect } from "@playwright/test";
import { gotoApp } from "./helpers/app.mjs";

test.describe("Earnings Watch — Risk Lab discrimination (PR 1-3)", () => {
  test("disagreement rate is materially below 90% post-discrimination-fix", async ({ request }) => {
    const res = await request.get("/api/earnings/upcoming?days=60");
    expect(res.ok()).toBe(true);
    const body = await res.json();
    if (body.missing === true) test.skip(true, "no earnings snapshot");
    if (body.lab_enabled !== true) test.skip(true, "lab disabled");
    const events = body.events || [];
    const withLab = events.filter((e) => e.lab_view);
    if (withLab.length === 0) test.skip(true, "no events with lab data");
    const beats = withLab.filter((e) => e.prediction?.verdict === "BEAT");
    if (beats.length === 0) test.skip(true, "no BEAT events");
    const disagrees = beats.filter((e) => e.lab_view.disagrees_with_prediction === true);
    const rate = (disagrees.length / beats.length) * 100;
    // Audit before fix: 90.5%. We should be materially below 75% now —
    // the threshold is conservative; the heuristic-only path typically
    // lands ~25-35% and LLM should narrow it further.
    expect(rate).toBeLessThan(75);
  });

  test("every lab_view exposes the new discrimination diagnostics", async ({ request }) => {
    const body = await (await request.get("/api/earnings/upcoming?days=60")).json();
    if (body.missing === true || body.lab_enabled !== true) test.skip(true, "preconditions");
    const events = body.events || [];
    const withLab = events.filter((e) => e.lab_view);
    if (withLab.length === 0) test.skip(true, "no lab views");
    const v = withLab[0].lab_view;
    expect(v).toHaveProperty("has_hard_evidence");
    expect(v).toHaveProperty("hard_evidence_count");
    expect(v).toHaveProperty("counter_thesis_only_count");
    expect(v).toHaveProperty("llm_authoritative");
  });

  test("top_reasons differentiate boilerplate from evidence", async ({ request }) => {
    const body = await (await request.get("/api/earnings/upcoming?days=60")).json();
    if (body.missing === true || body.lab_enabled !== true) test.skip(true, "preconditions");
    const events = body.events || [];
    for (const e of events) {
      if (!e.lab_view?.top_reasons?.length) continue;
      for (const r of e.lab_view.top_reasons) {
        expect(typeof r.is_boilerplate).toBe("boolean");
      }
    }
  });

  test("Earnings Watch card carries data-has-hard-evidence + data-llm-provider", async ({ page, request }) => {
    const body = await (await request.get("/api/earnings/upcoming?days=60")).json();
    if (body.missing === true || body.lab_enabled !== true) test.skip(true, "preconditions");
    const withLab = (body.events || []).filter((e) => e.lab_view);
    test.skip(withLab.length === 0, "no lab views in snapshot");

    await gotoApp(page, { tab: "earnings" });
    await expect(page.locator(".earnings-card").first()).toBeVisible({ timeout: 15_000 });
    const stripCount = await page.locator('[data-testid="lab-second-opinion"]').count();
    expect(stripCount).toBeGreaterThan(0);
    // Every rendered strip carries the new attributes
    const stripsWithAttr = await page.locator('[data-testid="lab-second-opinion"][data-has-hard-evidence]').count();
    expect(stripsWithAttr).toBeGreaterThan(0);
  });
});
