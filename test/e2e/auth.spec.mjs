// E2E test — Auth surface in AUTH_ENABLED=false mode (P3.8, 2026-05-16).
//
// The Playwright harness intentionally boots server.js without OAuth env
// vars (see playwright.config.mjs — STARBHAI_SESSION_SECRET="" etc.), so
// AUTH_ENABLED is false. In that mode the auth surface must behave like:
//
//   • /api/auth/google           → 500 { error: "auth-not-configured" }
//   • /api/auth/google/callback  → 500 { error: "auth-not-configured" }
//   • /api/auth/me               → 401 { error: "auth-disabled" }
//   • /api/logout                → 200 { ok: true } (no-op)
//   • no real session cookie     (Set-Cookie absent on every safe endpoint)
//   • universal data endpoints   reachable without auth
//
// Pre-this-spec there was zero e2e coverage for the auth surface, so a
// regression that silently flipped any of the above (e.g. /api/auth/me
// starting to leak a stub user record, or /api/logout starting to set a
// fresh session) would not be caught. This is the regression guard.

import { test, expect } from "@playwright/test";

test.describe("Auth surface (AUTH_ENABLED=false harness)", () => {
  test("GET /api/auth/google returns 500 auth-not-configured", async ({ request }) => {
    // Disable redirect-following — the live endpoint 302s to Google, the
    // not-configured branch 500s with JSON. We want to see the JSON, not chase
    // the redirect.
    const r = await request.get("/api/auth/google", { maxRedirects: 0 });
    expect(r.status()).toBe(500);
    const body = await r.json().catch(() => ({}));
    expect(body.error).toBe("auth-not-configured");
  });

  test("GET /api/auth/google/callback returns 500 auth-not-configured", async ({ request }) => {
    // Even with a (bogus) code+state pair, the endpoint must short-circuit
    // on the AUTH_ENABLED check before touching the OAuth client.
    const r = await request.get("/api/auth/google/callback?code=fake&state=fake", {
      maxRedirects: 0,
    });
    expect(r.status()).toBe(500);
    const body = await r.json().catch(() => ({}));
    expect(body.error).toBe("auth-not-configured");
  });

  test("GET /api/auth/me returns 401 auth-disabled in dev mode", async ({ request }) => {
    const r = await request.get("/api/auth/me");
    expect(r.status()).toBe(401);
    const body = await r.json().catch(() => ({}));
    expect(body.error).toBe("auth-disabled");
    // The dev-mode response must NEVER leak a stub user record — only the
    // `error` discriminator. If a future refactor accidentally returns
    // { userId, email, … } here, the SPA would think it's logged in as a
    // ghost user and skip the login screen on prod too.
    expect(body.userId).toBeUndefined();
    expect(body.email).toBeUndefined();
    expect(body.name).toBeUndefined();
  });

  test("POST /api/logout is a 200 no-op in dev mode", async ({ request }) => {
    const r = await request.post("/api/logout");
    expect(r.status()).toBe(200);
    const body = await r.json().catch(() => ({}));
    expect(body.ok).toBe(true);
  });

  test("no real session cookie set on safe endpoints in dev mode", async ({ request }) => {
    // When AUTH_ENABLED is false, the gate middleware never runs setSessionCookie.
    // The only Set-Cookie that may appear here is the clear-cookie on /api/logout
    // (Max-Age=0), so spot-check the non-mutating /api/sws-picks and /api/auth/me
    // responses — neither should bake a fresh starbhai_session into the browser.
    const checks = [
      await request.get("/api/sws-picks"),
      await request.get("/api/auth/me"),
    ];
    for (const r of checks) {
      const sc = r.headers()["set-cookie"] || "";
      // Either no Set-Cookie at all, or no `starbhai_session=<non-empty>` payload.
      if (sc) {
        // sc can be a single string or an array depending on Playwright build;
        // normalise to a single string for the regex check.
        const joined = Array.isArray(sc) ? sc.join("\n") : sc;
        expect(joined).not.toMatch(/starbhai_session=[A-Za-z0-9._-]+/);
      }
    }
  });

  test("universal endpoints work without auth in dev mode (sws-picks)", async ({ request }) => {
    const r = await request.get("/api/sws-picks");
    // Either 200 (data loaded) or a service-data-missing state; what matters
    // is the absence of an auth wall — never 401/403/redirect-to-login.
    expect([200, 404, 500, 503]).toContain(r.status());
    expect(r.status()).not.toBe(401);
    expect(r.status()).not.toBe(403);
  });

  test("universal endpoints work without auth in dev mode (earnings/upcoming)", async ({ request }) => {
    const r = await request.get("/api/earnings/upcoming");
    expect([200, 404, 500, 503]).toContain(r.status());
    expect(r.status()).not.toBe(401);
    expect(r.status()).not.toBe(403);
  });
});
