// E2E spec — helmet security headers (audit finding #4, P0, 2026-05-18).
//
// Pre-fix prod only carried `strict-transport-security` (injected by Vercel
// at the edge). Missing CSP, X-Frame-Options, X-Content-Type-Options,
// Referrer-Policy. Clickjacking + MIME-sniff surface.
//
// helmet() is mounted in server.js immediately after CORS and before the
// rate limiter so EVERY response — static assets AND /api/* — carries the
// hardening headers.

import { test, expect } from "@playwright/test";

const SECURITY_PATHS = [
  // Pick representative surfaces: gated landing page (HTML) + a public-ish
  // API route (health) + a CORS-friendly one (sws-picks). All three should
  // carry the hardening headers because helmet sits before the routers.
  "/index.html",
  "/api/health",
  "/api/sws-picks",
];

test.describe("helmet security headers", () => {
  for (const target of SECURITY_PATHS) {
    test(`${target} responds with helmet headers`, async ({ request }) => {
      const r = await request.get(target);
      // We don't assert status — some paths (e.g. /api/sws-picks on a fresh
      // test env) may legitimately 404 or 503. Headers must be present
      // regardless because helmet runs before the route handler.
      const headers = r.headers();

      // CSP — single most important header. Must include the script-src + the
      // Google Fonts allowance + frame-ancestors 'none'.
      const csp = headers["content-security-policy"];
      expect(csp, "CSP must be present").toBeTruthy();
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("script-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("fonts.googleapis.com");
      expect(csp).toContain("fonts.gstatic.com");
      // Defence-in-depth nuggets that should always be locked down.
      expect(csp).toContain("object-src 'none'");
      expect(csp).toContain("base-uri 'self'");

      // X-Frame-Options: DENY — clickjacking defence. We set frameguard:
      // { action: "deny" } explicitly so the value is DENY, not SAMEORIGIN.
      expect(headers["x-frame-options"]).toBe("DENY");

      // X-Content-Type-Options: nosniff — blocks MIME-sniffing attacks that
      // could let a user-uploaded .xlsx be re-interpreted as a script.
      expect(headers["x-content-type-options"]).toBe("nosniff");

      // Referrer-Policy: strict-origin-when-cross-origin — never leaks the
      // full URL (which may carry per-user query params) on cross-origin
      // navigations.
      expect(headers["referrer-policy"]).toBe(
        "strict-origin-when-cross-origin",
      );
    });
  }

  test("HSTS is set with a multi-month max-age", async ({ request }) => {
    // Vercel injects HSTS at the edge in prod; helmet sets it locally too so
    // dev/test/prod stay consistent. Either way the header MUST be present
    // when the response leaves Express.
    const r = await request.get("/index.html");
    const hsts = r.headers()["strict-transport-security"];
    expect(hsts, "HSTS must be set").toBeTruthy();
    // 15552000 = 180 days (helmet's chosen default in our config).
    expect(hsts).toContain("max-age=");
    const m = /max-age=(\d+)/.exec(hsts);
    expect(m, "HSTS max-age must be numeric").toBeTruthy();
    expect(Number(m[1])).toBeGreaterThanOrEqual(15552000);
  });

  test("gated SPA renders without CSP-blocking errors", async ({ page }) => {
    // If CSP were too strict for the gated UI (e.g. forgot 'unsafe-inline'
    // for the 150+ inline style="" attributes or 28 onclick handlers), the
    // browser would emit a flood of "Refused to execute inline script" /
    // "Refused to apply inline style" violation messages here.
    const cspViolations = [];
    page.on("console", (msg) => {
      const text = msg.text();
      if (
        text.includes("Content Security Policy") ||
        text.includes("Refused to execute") ||
        text.includes("Refused to apply")
      ) {
        cspViolations.push(text);
      }
    });

    await page.goto("/index.html", { waitUntil: "domcontentloaded" });
    // Wait for the SPA bootstrap so any deferred inline handlers fire.
    await page
      .waitForFunction(() => typeof window.switchTab === "function", null, {
        timeout: 10_000,
      })
      .catch(() => {});

    expect(
      cspViolations,
      `CSP violations should be empty; saw:\n${cspViolations.join("\n")}`,
    ).toEqual([]);
  });
});
