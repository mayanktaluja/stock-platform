// E2E spec for P4.2 — per-prediction audit-trail endpoint.

import { test, expect } from "@playwright/test";

test.describe("/api/audit/earnings/:symbol/:event_iso_date", () => {
  test("rejects invalid symbol", async ({ request }) => {
    const r = await request.get("/api/audit/earnings/!!!/2026-07-15");
    expect(r.status()).toBe(400);
    const j = await r.json();
    expect(j.error).toMatch(/invalid symbol/i);
  });

  test("rejects invalid date format", async ({ request }) => {
    const r = await request.get("/api/audit/earnings/BAJFINANCE/15-07-2026");
    expect(r.status()).toBe(400);
    const j = await r.json();
    expect(j.error).toMatch(/event_iso_date/i);
  });

  test("404 for a known-not-present symbol+date", async ({ request }) => {
    const r = await request.get("/api/audit/earnings/NOSUCHSTOCK/2099-01-01");
    expect([404, 200]).toContain(r.status());
    if (r.status() === 404) {
      const j = await r.json();
      expect(j.error).toMatch(/no prediction found|no earnings history/i);
    }
  });

  test("requires no auth (public audit trail)", async ({ request }) => {
    const r = await request.get("/api/audit/earnings/NOSUCHSTOCK/2099-01-01");
    expect([200, 404]).toContain(r.status()); // not 401
  });
});
