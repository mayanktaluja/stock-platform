// E2E — /api/macro/regime/health public probe (2026-05-17 fix).
//
// Phase 4 of the macro permanent fix added a public, no-auth endpoint
// for external monitoring of the standalone com.starbhai.macro-only
// cron's health. This spec locks the contract:
//
//   • No auth required (AUTH_EXEMPT_PATHS).
//   • Returns 200 with {status: 'fresh', ageHours, generatedAt, …}
//     when data/macroRegime.json's generatedAt is under 18h old.
//   • Returns 503 with {status: 'stale'|'missing'} otherwise — so an
//     uptime probe can alert on HTTP failure alone.
//   • thresholdHours: 18 in the response so the consumer doesn't have
//     to hardcode the value.
//
// We do NOT mutate data/macroRegime.json — the spec self-skips with a
// reason if the committed file is older than 18h (so a stale repo doesn't
// false-fire). The happy path is what we lock in.

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const MACRO_PATH = path.join(REPO_ROOT, "data", "macroRegime.json");

function readMacroFreshness() {
  try {
    const j = JSON.parse(fs.readFileSync(MACRO_PATH, "utf-8"));
    if (!j.generatedAt) return null;
    const ageMs = Date.now() - new Date(j.generatedAt).getTime();
    return { generatedAt: j.generatedAt, ageHours: ageMs / 36e5 };
  } catch { return null; }
}

test.describe("/api/macro/regime/health public probe", () => {
  test("is exempt from auth gate (returns JSON, never 401)", async ({ request }) => {
    const r = await request.get("/api/macro/regime/health");
    expect(r.status(), `unexpected HTTP ${r.status()} — endpoint should be in AUTH_EXEMPT_PATHS`).not.toBe(401);
    const ct = r.headers()["content-type"] || "";
    expect(ct).toContain("application/json");
  });

  test("reports thresholdHours: 18 (so consumers don't hardcode it)", async ({ request }) => {
    const r = await request.get("/api/macro/regime/health");
    const body = await r.json();
    expect(body.thresholdHours).toBe(18);
  });

  test("returns status:fresh + 200 when committed macro file is under 18h old", async ({ request }) => {
    const freshness = readMacroFreshness();
    test.skip(!freshness, "data/macroRegime.json missing — nothing to test");
    test.skip(freshness && freshness.ageHours >= 18,
      `committed file is ${freshness.ageHours.toFixed(1)}h old — refresh + commit before re-running`);

    const r = await request.get("/api/macro/regime/health");
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.status).toBe("fresh");
    expect(body.generatedAt).toBe(freshness.generatedAt);
    expect(body.ageHours).toBeGreaterThanOrEqual(0);
    expect(body.ageHours).toBeLessThan(18);
    expect(body.regime).toBeTruthy();
    expect(body.classifierProvider).toBeTruthy();
  });
});
