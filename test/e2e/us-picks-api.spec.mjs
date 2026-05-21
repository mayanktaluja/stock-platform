// US Picks API contract + isolation from the India SWS pipeline.
//
// The US read routes use requireAdminRead, which is OPEN when AUTH_ENABLED=false
// (the harness default) so the tab is reachable in dev/e2e — unlike the India
// admin/refresh routes that 401 in dev (see admin.spec.mjs). This spec locks
// the US route contract and proves the India picks route shape is unchanged.

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HAS_FIXTURE = fs.existsSync(
  path.join(__dirname, "..", "..", "data", "sws-us", "picks-latest.json"),
);

test.describe("US Picks API", () => {
  test.skip(!HAS_FIXTURE, "no data/sws-us/picks-latest.json fixture present");

  test("GET /api/us-picks → 200 USD sections, no avoid list", async ({ request }) => {
    const r = await request.get("/api/us-picks");
    expect(r.status()).toBe(200);
    const b = await r.json();
    expect(b.region).toBe("US");
    expect(b.currency).toBe("USD");
    expect(b.sections).toBeTruthy();
    expect(Array.isArray(b.sections.top_ranked_30_v3)).toBe(true);
    expect(b.sections.avoid).toBeUndefined();
  });

  test("GET /api/us-picks?limit=2&category=top_ranked_30_v3 paginates", async ({ request }) => {
    const r = await request.get("/api/us-picks?limit=2&category=top_ranked_30_v3");
    expect(r.status()).toBe(200);
    const b = await r.json();
    expect(Object.keys(b.sections)).toEqual(["top_ranked_30_v3"]);
    expect(b.sections.top_ranked_30_v3.length).toBeLessThanOrEqual(2);
  });

  test("GET /api/us-stock/:ticker → 200 with currency USD", async ({ request }) => {
    const picks = await (await request.get("/api/us-picks")).json();
    const ticker = picks.sections.top_ranked_30_v3[0]?.ticker;
    expect(ticker).toBeTruthy();
    const s = await request.get(`/api/us-stock/${encodeURIComponent(ticker)}`);
    expect(s.status()).toBe(200);
    const sb = await s.json();
    expect(sb.ticker).toBe(ticker);
    expect(sb.currency).toBe("USD");
  });

  test("GET /api/us-stock/BAD!! → 400 invalid_ticker", async ({ request }) => {
    const r = await request.get("/api/us-stock/BAD!!");
    expect(r.status()).toBe(400);
  });

  test("GET /api/us-scan/status → 200 with 3 shards", async ({ request }) => {
    const r = await request.get("/api/us-scan/status");
    expect(r.status()).toBe(200);
    const b = await r.json();
    expect(Array.isArray(b.shards)).toBe(true);
    expect(b.shards.length).toBe(3);
  });

  test("ISOLATION: India /api/sws-picks shape unchanged", async ({ request }) => {
    const r = await request.get("/api/sws-picks");
    // 200 (India fixture present, the common case) → must still carry sections.
    // 404 no_picks_yet is also acceptable in a bare harness without India data.
    if (r.status() === 200) {
      const b = await r.json();
      expect(b.sections).toBeTruthy();
      // India route must NOT have sprouted a `region: "US"` marker.
      expect(b.region).not.toBe("US");
    } else {
      expect(r.status()).toBe(404);
    }
  });
});
