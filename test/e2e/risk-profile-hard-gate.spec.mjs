// E2E test — Risk-profile hard-gate (P0.1, 2026-05-16).
//
// Verifies that the analyser's personalised endpoints refuse to run without
// a completed risk profile (412 RISK_PROFILE_REQUIRED) and unblock once the
// profile is set. The pre-fix behaviour was a "soft gate" — recommendations
// rendered with default MODERATE assumptions even when no profile was set,
// which meant a 60-year-old retiree saw the same advice as a 25-year-old
// day trader. SEBI IA Reg 2013 Schedule III treats this as a regulatory
// red line; this spec is the regression guard.

import { test, expect } from "@playwright/test";
import { gotoApp, clearRiskProfile, setRiskProfile } from "./helpers/app.mjs";

test.describe("Risk-profile hard-gate", () => {
  test("POST /api/portfolio/analyze returns 412 when no profile is set", async ({ page }) => {
    // Clear any profile left over from prior tests (the e2e default
    // setRiskProfile MODERATE in gotoApp would mask the gate).
    await gotoApp(page, { riskProfile: null });
    await clearRiskProfile(page);

    const form = await page.evaluateHandle(() => {
      const fd = new FormData();
      fd.append("file", new Blob(["dummy"], { type: "text/csv" }), "fake.csv");
      return fd;
    });
    const result = await page.evaluate(async () => {
      const fd = new FormData();
      fd.append("file", new Blob(["symbol,qty\nRELIANCE,10\n"], { type: "text/csv" }), "fake.csv");
      const r = await fetch("/api/portfolio/analyze", { method: "POST", body: fd });
      const j = await r.json().catch(() => ({}));
      return { status: r.status, code: j?.code, profile_endpoint: j?.profile_endpoint };
    });
    expect(result.status).toBe(412);
    expect(result.code).toBe("RISK_PROFILE_REQUIRED");
    expect(result.profile_endpoint).toBe("/api/risk-profile");
  });

  test("POST /api/portfolio/analyze/rerun returns 412 when no profile is set", async ({ page }) => {
    await gotoApp(page, { riskProfile: null });
    await clearRiskProfile(page);
    const result = await page.evaluate(async () => {
      const r = await fetch("/api/portfolio/analyze/rerun", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const j = await r.json().catch(() => ({}));
      return { status: r.status, code: j?.code };
    });
    expect(result.status).toBe(412);
    expect(result.code).toBe("RISK_PROFILE_REQUIRED");
  });

  test("POST /api/portfolio/optimize returns 412 when no profile is set", async ({ page }) => {
    await gotoApp(page, { riskProfile: null });
    await clearRiskProfile(page);
    const result = await page.evaluate(async () => {
      const r = await fetch("/api/portfolio/optimize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "fake" }),
      });
      const j = await r.json().catch(() => ({}));
      return { status: r.status, code: j?.code };
    });
    expect(result.status).toBe(412);
    expect(result.code).toBe("RISK_PROFILE_REQUIRED");
  });

  test("setting a profile clears the 412 (analyze no longer gated)", async ({ page }) => {
    await gotoApp(page, { riskProfile: null });
    await clearRiskProfile(page);
    await setRiskProfile(page, "MODERATE");

    const result = await page.evaluate(async () => {
      const r = await fetch("/api/portfolio/analyze/rerun", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      return { status: r.status };
    });
    // The route may legitimately 404 (no stored portfolio) or 500 (no live
    // data) after the gate clears — the test only asserts the gate itself
    // does not fire. Any non-412 status passes the regression check.
    expect(result.status).not.toBe(412);
  });

  test("universal-data endpoints stay open without a profile", async ({ page }) => {
    await gotoApp(page, { riskProfile: null });
    await clearRiskProfile(page);
    const swsPicks = await page.evaluate(async () => {
      const r = await fetch("/api/sws-picks");
      return { status: r.status };
    });
    const earningsCal = await page.evaluate(async () => {
      const r = await fetch("/api/earnings/upcoming");
      return { status: r.status };
    });
    // Either OK or a service-data-missing error; neither should be 412.
    expect(swsPicks.status).not.toBe(412);
    expect(earningsCal.status).not.toBe(412);
  });
});
