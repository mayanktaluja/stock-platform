// E2E test — Admin endpoint protection (P3.8, 2026-05-16).
//
// Locks the contract that every /api/admin/* surface refuses to serve data
// in AUTH_ENABLED=false mode (the Playwright harness's default — see
// playwright.config.mjs). A regression that started returning the user
// directory, a third-party portfolio XLSX, or the shadow-diff store under
// the dev convenience path would be a friends-and-family-grade data leak
// shipping straight to prod.
//
// The existing sws-refresh-admin.spec.mjs covers the four SWS refresh
// POST endpoints. This spec covers the data-read admin surface:
//
//   • GET  /api/admin/users
//   • GET  /api/admin/users/:sub/portfolio.xlsx
//   • GET  /api/admin/combined-shadow-diff
//   • POST /api/sws-refresh/quick                (state-mutating sample)
//
// Plus consistency checks (uniform error shape, no PII / stack traces).

import { test, expect } from "@playwright/test";

// Endpoints that MUST 401 with { error: "auth-disabled" } in dev mode.
// Each entry: [method, path, optional-body].
const ADMIN_READ_ENDPOINTS = [
  ["GET", "/api/admin/users"],
  ["GET", "/api/admin/users/some-fake-sub/portfolio.xlsx"],
  ["GET", "/api/admin/combined-shadow-diff"],
];

test.describe("Admin endpoint protection (AUTH_ENABLED=false harness)", () => {
  test("GET /api/admin/users returns 401 auth-disabled", async ({ request }) => {
    const r = await request.get("/api/admin/users");
    expect(r.status()).toBe(401);
    const body = await r.json().catch(() => ({}));
    expect(body.error).toBe("auth-disabled");
    // Must NOT include the actual users array even by accident.
    expect(body.users).toBeUndefined();
    expect(body.count).toBeUndefined();
  });

  test("GET /api/admin/users/:sub/portfolio.xlsx returns 401 auth-disabled", async ({ request }) => {
    // The route parses :sub before the auth check would matter — but the
    // AUTH_ENABLED short-circuit fires first, so any sub value reaches the
    // same 401. We pass a deliberately-invalid sub to assert the auth gate
    // wins over the user-lookup branch (which would otherwise 404).
    const r = await request.get("/api/admin/users/__definitely_not_a_real_sub__/portfolio.xlsx");
    expect(r.status()).toBe(401);
    const body = await r.json().catch(() => ({}));
    expect(body.error).toBe("auth-disabled");
    // Critical: response must be JSON, not the actual XLSX binary. A misrouted
    // handler that streamed an empty workbook would still leak metadata.
    const ct = (r.headers()["content-type"] || "").toLowerCase();
    expect(ct).toContain("application/json");
    expect(ct).not.toContain("spreadsheet");
    expect(ct).not.toContain("officedocument");
  });

  test("GET /api/admin/combined-shadow-diff returns 401 auth-disabled", async ({ request }) => {
    const r = await request.get("/api/admin/combined-shadow-diff");
    expect(r.status()).toBe(401);
    const body = await r.json().catch(() => ({}));
    expect(body.error).toBe("auth-disabled");
    // Must not leak the shadow-diff store contents.
    expect(body.entries).toBeUndefined();
    expect(body.schema).toBeUndefined();
    expect(body.source).toBeUndefined();
  });

  test("POST /api/sws-refresh/quick (state-mutating admin) returns 401 auth-disabled", async ({ request }) => {
    // Sanity-check a mutating admin endpoint. The dedicated coverage lives in
    // sws-refresh-admin.spec.mjs; here we use it as the "writes are also
    // blocked" sample so this file isn't read-only.
    const r = await request.post("/api/sws-refresh/quick", {
      data: {},
      headers: { "Content-Type": "application/json" },
    });
    expect(r.status()).toBe(401);
    const body = await r.json().catch(() => ({}));
    expect(body.error).toBe("auth-disabled");
    // Must not have queued the refresh request.
    expect(body.queued).toBeUndefined();
  });

  test("POST /api/admin/users/:sub/sws-input-alerts/prefs returns 401 auth-disabled", async ({ request }) => {
    const r = await request.post("/api/admin/users/some-fake-sub/sws-input-alerts/prefs", {
      data: { email: false },
      headers: { "Content-Type": "application/json" },
    });
    expect(r.status()).toBe(401);
    const body = await r.json().catch(() => ({}));
    expect(body.error).toBe("auth-disabled");
  });

  test("admin error responses do not leak PII or stack traces", async ({ request }) => {
    for (const [method, urlPath] of ADMIN_READ_ENDPOINTS) {
      const r = method === "GET"
        ? await request.get(urlPath)
        : await request.post(urlPath, { data: {}, headers: { "Content-Type": "application/json" } });
      const raw = await r.text();
      // No stack-trace markers — `at Object.<anonymous>` / `at Function.` /
      // file paths leaking implementation details.
      expect(raw).not.toMatch(/\bat\s+\w+/);
      expect(raw).not.toMatch(/\/Users\/[^/]+\//);
      expect(raw).not.toMatch(/node_modules/);
      // No email addresses (defence in depth — the user list would contain
      // emails; the error response must not).
      expect(raw).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
      // Response body should be small — large bodies hint at data leakage.
      expect(raw.length).toBeLessThan(500);
    }
  });

  test("auth-disabled error shape is consistent across admin endpoints", async ({ request }) => {
    const bodies = [];
    for (const [method, urlPath] of ADMIN_READ_ENDPOINTS) {
      const r = method === "GET"
        ? await request.get(urlPath)
        : await request.post(urlPath, { data: {}, headers: { "Content-Type": "application/json" } });
      expect(r.status(), `${method} ${urlPath}`).toBe(401);
      const body = await r.json().catch(() => ({}));
      bodies.push({ urlPath, body });
    }
    // Every admin endpoint must use the exact same { error: "auth-disabled" }
    // payload. The SPA, the CLI scripts, and any future ops tooling key off
    // this discriminator to know "this is a dev-mode short-circuit, not a
    // real authz failure" — drift here breaks the contract silently.
    for (const { urlPath, body } of bodies) {
      expect(body.error, `${urlPath} error mismatch`).toBe("auth-disabled");
      // Only the `error` field — no extra leak vectors (detail, hint, sub, …)
      const keys = Object.keys(body);
      expect(keys, `${urlPath} unexpected keys: ${keys.join(",")}`).toEqual(["error"]);
    }
  });

  test("admin endpoints under a bogus query-string still 401", async ({ request }) => {
    // Defence in depth: query-string parameters must not be able to flip the
    // dev-mode gate (e.g., a future ?devOverride=1 footgun).
    const r = await request.get("/api/admin/users?devOverride=1&apiKey=anything&sub=__local_dev");
    expect(r.status()).toBe(401);
    const body = await r.json().catch(() => ({}));
    expect(body.error).toBe("auth-disabled");
  });

  test("Users tab posts email=false and refreshes row status after Turn off", async ({ page }) => {
    let emailEnabled = true;
    let postedBody = null;

    await page.route("**/api/admin/users", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          count: 1,
          users: [{
            sub: "target_bouncing_user",
            email: "vikrant.deshmukh16@gmail.com",
            name: "Bouncing User",
            createdAt: "2026-06-10T00:00:00.000Z",
            lastSeenAt: "2026-06-10T01:00:00.000Z",
            sessionCount: 1,
            loginEvents: [],
            hasPortfolio: true,
            notificationPrefs: emailEnabled
              ? {}
              : { swsInputAlerts: { inApp: true, email: false } },
          }],
        }),
      });
    });
    await page.route("**/api/admin/users/*/sws-input-alerts/prefs", async (route) => {
      postedBody = route.request().postDataJSON();
      emailEnabled = false;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          sub: "target_bouncing_user",
          email: "vikrant.deshmukh16@gmail.com",
          prefs: { inApp: true, email: false },
        }),
      });
    });

    await page.goto("/");
    await page.waitForFunction(() => typeof window.loadUsersList === "function");
    await page.evaluate(() => {
      const tab = document.getElementById("usersTab");
      if (tab) tab.style.display = "block";
    });
    await page.evaluate(() => window.loadUsersList());

    const usersTab = page.locator("#usersTabContent");
    await expect(usersTab).toContainText("vikrant.deshmukh16@gmail.com");
    await expect(usersTab.getByText("On", { exact: true })).toBeVisible();

    await usersTab.getByRole("button", { name: "Turn off" }).click();
    await expect.poll(() => postedBody).toEqual({ email: false });
    await expect(usersTab.getByText("Off", { exact: true })).toBeVisible();
    await expect(usersTab.getByRole("button", { name: "Turn off" })).toHaveCount(0);
  });
});
