import { test, expect } from "@playwright/test";

test.describe("Market Radar API", () => {
  test("schema probe returns cached snapshot or self-skips while warming", async ({ request }) => {
    const res = await request.get("/api/market-information/latest");
    if (res.status() === 503) {
      test.skip(true, "Market Radar snapshot is not generated in this environment");
    }
    expect(res.status()).toBe(200);
    expect(res.headers()["cache-control"] || "").toContain("private");
    const body = await res.json();
    expect(body.schema_version).toBe("market-information-v1");
    expect(body.runtime_audit).toBeTruthy();
    expect(body.sections).toBeTruthy();
    expect(Array.isArray(body.sections.breaking_filings)).toBe(true);
  });
});
