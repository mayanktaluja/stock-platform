// E2E test — CORS origin allowlist (P0.2, 2026-05-16).
//
// Verifies the friends-and-family CORS policy: same-origin requests work,
// allowlist origins (canonical alias, preview pattern, localhost) work, and
// arbitrary origins do NOT get the Access-Control-Allow-Origin header back
// (so the browser refuses to surface the response to the page).
//
// The pre-fix policy was `app.use(cors())` — wide-open. A logged-in friend
// visiting any sketchy site could have their session cookie used to fetch
// /api/portfolio. SameSite=Lax already blocked the subresource case in
// modern browsers, but having CORS open was belt-and-braces wrong.

import { test, expect } from "@playwright/test";

test.describe("CORS origin allowlist", () => {
  test("same-origin GET works (no Origin header → callback allow)", async ({ request }) => {
    const r = await request.get("/api/sws-picks");
    // Either 200 or service-error; the test only asserts the route is
    // reachable from same-origin (no CORS rejection).
    expect([200, 404, 500, 503]).toContain(r.status());
  });

  test("allowlisted origin (localhost:4011) returns ACAO header", async ({ request }) => {
    const r = await request.get("/api/sws-picks", {
      headers: { Origin: "http://localhost:4011" },
    });
    // cors() echoes the matched origin back when allowlisted.
    expect(r.headers()["access-control-allow-origin"]).toBe("http://localhost:4011");
  });

  test("branded Vercel alias is allowlisted", async ({ request }) => {
    const r = await request.get("/api/sws-picks", {
      headers: { Origin: "https://starbhai-stock-platform.vercel.app" },
    });
    expect(r.headers()["access-control-allow-origin"]).toBe(
      "https://starbhai-stock-platform.vercel.app",
    );
  });

  test("removed gamma Vercel alias is not allowlisted", async ({ request }) => {
    const r = await request.get("/api/sws-picks", {
      headers: { Origin: "https://stock-platform-gamma.vercel.app" },
    });
    expect(r.headers()["access-control-allow-origin"]).toBeFalsy();
  });

  test("Vercel preview pattern is allowlisted", async ({ request }) => {
    const r = await request.get("/api/sws-picks", {
      headers: {
        Origin:
          "https://stock-platform-abc123-mtaluja11-3604s-projects.vercel.app",
      },
    });
    expect(r.headers()["access-control-allow-origin"]).toBe(
      "https://stock-platform-abc123-mtaluja11-3604s-projects.vercel.app",
    );
  });

  test("arbitrary origin gets NO Access-Control-Allow-Origin header (browser blocks)", async ({ request }) => {
    const r = await request.get("/api/sws-picks", {
      headers: { Origin: "https://evil.example.com" },
    });
    // The server still responds (it can't refuse — that would 500 for legit
    // server-to-server callers), but the absence of ACAO means the browser
    // refuses to expose the response body to evil.example.com's JS.
    expect(r.headers()["access-control-allow-origin"]).toBeFalsy();
  });

  test("arbitrary-origin preflight (OPTIONS) returns NO ACAO", async ({ request }) => {
    const r = await request.fetch("/api/portfolio", {
      method: "OPTIONS",
      headers: {
        Origin: "https://evil.example.com",
        "Access-Control-Request-Method": "POST",
      },
    });
    expect(r.headers()["access-control-allow-origin"]).toBeFalsy();
  });
});
