// PR 4 (2026-05-19) — Macro Thesis transparency.
//
// Verifies:
//   1. /api/risk-lab/macro-thesis surfaces regime.reasoning + regime.key_events
//   2. Each branch carries reasoning.modulator_applied + analog_pool_regime
//   3. UI renders the "Why this regime" block + per-branch reasoning expander
//      + audit footer

import { test, expect } from "@playwright/test";
import { gotoApp } from "./helpers/app.mjs";

test.describe("Risk Lab — Macro Thesis transparency (PR 4)", () => {
  test("/api/risk-lab/macro-thesis exposes regime reasoning + key_events", async ({ request }) => {
    const res = await request.get("/api/risk-lab/macro-thesis");
    if (res.status() === 404 || res.status() === 503) test.skip(true, "lab disabled");
    const body = await res.json();
    if (body.indeterminate) test.skip(true, "thesis indeterminate");
    expect(body.regime).toBeTruthy();
    // Reasoning + key_events are the SEBI Reg 16 disclosure fields.
    expect(typeof body.regime.reasoning).toBe("string");
    expect(Array.isArray(body.regime.key_events)).toBe(true);
    expect(body.regime).toHaveProperty("classifier_provider");
    expect(body).toHaveProperty("audit");
    expect(body.audit).toHaveProperty("thesis_schema", "macro-thesis-v1");
    expect(body.audit).toHaveProperty("regime_classifier");
  });

  test("each branch carries reasoning.modulator_applied + analog_pool_regime", async ({ request }) => {
    const body = await (await request.get("/api/risk-lab/macro-thesis")).json();
    if (body.indeterminate) test.skip(true, "indeterminate");
    for (const b of body.branches || []) {
      expect(b).toHaveProperty("reasoning");
      expect(b.reasoning).toHaveProperty("modulator_applied");
      expect(b.reasoning).toHaveProperty("base_probability");
      expect(b.reasoning).toHaveProperty("analog_pool_regime");
      expect(Array.isArray(b.reasoning.analog_warnings)).toBe(true);
    }
  });

  test("UI renders Why-this-regime block + reasoning expanders + audit footer", async ({ page, request }) => {
    const body = await (await request.get("/api/risk-lab/macro-thesis")).json();
    if (body.indeterminate) test.skip(true, "indeterminate");
    await gotoApp(page, { tab: "riskLab" });
    await page.click("button:has-text('Macro Thesis')");
    await expect(page.locator('[data-testid="macro-thesis-root"]')).toBeVisible({ timeout: 10_000 });
    // Why-this-regime block
    await expect(page.locator('[data-testid="thesis-why-regime"]')).toBeVisible();
    // Per-branch reasoning expanders (4 branches)
    const reasoningCount = await page.locator('[data-testid^="thesis-branch-reasoning-"]').count();
    expect(reasoningCount).toBe(4);
    // Audit footer
    await expect(page.locator('[data-testid="thesis-audit"]')).toBeVisible();
    const auditText = await page.locator('[data-testid="thesis-audit"]').innerText();
    expect(auditText).toMatch(/schema:/);
    expect(auditText).toMatch(/classifier:/);
  });
});
