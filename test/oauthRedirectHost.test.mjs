/**
 * OAuth redirect host regression.
 *
 * The branded Vercel alias is the only production callback host. Login must
 * derive a branded redirect_uri on the branded host, allowed alternate hosts
 * must not replay that state, and removed/unknown hosts must be rejected
 * instead of resurrecting a stale alias.
 *
 * Run with: node test/oauthRedirectHost.test.mjs
 */

import http from "node:http";
import { once } from "node:events";

process.env.NODE_ENV = "test";
process.env.VERCEL = "1";
process.env.STARBHAI_SESSION_SECRET = "a".repeat(64);
process.env.GOOGLE_CLIENT_ID = "32306903038-test.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET = "test-secret";
process.env.GOOGLE_OAUTH_REDIRECT_URI = "https://starbhai-stock-platform.vercel.app/api/auth/google/callback";

const { default: app } = await import(`../server.js?oauth-host-test=${Date.now()}`);

let pass = 0;
let fail = 0;

function assert(name, cond, got) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name} — got: ${JSON.stringify(got)}`);
  }
}

const server = http.createServer(app);
server.listen(0, "127.0.0.1");
await once(server, "listening");
const { port } = server.address();

function request(host, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        method: "GET",
        path,
        headers: { Host: host, ...headers },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => resolve({ res, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function redirectTarget(location) {
  return new URL(location).searchParams.get("redirect_uri");
}

function redirectState(location) {
  return new URL(location).searchParams.get("state");
}

function oauthCookie(setCookie) {
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie || ""];
  return cookies.find((cookie) => cookie.startsWith("starbhai_oauth=")) || "";
}

console.log("\noauthRedirectHost — login host controls redirect_uri\n");

try {
  const branded = await request("starbhai-stock-platform.vercel.app", "/api/auth/google");
  assert("branded host returns OAuth redirect", branded.res.statusCode === 302, branded.res.statusCode);
  assert(
    "branded host redirects Google back to branded callback",
    redirectTarget(branded.res.headers.location) ===
      "https://starbhai-stock-platform.vercel.app/api/auth/google/callback",
    branded.res.headers.location,
  );
  assert("branded login sets oauth-state cookie", oauthCookie(branded.res.headers["set-cookie"]).length > 0);

  const brandedState = redirectState(branded.res.headers.location);
  const brandedCookie = oauthCookie(branded.res.headers["set-cookie"]).split(";")[0];
  const brandedCallback = await request(
    "starbhai-stock-platform.vercel.app",
    `/api/auth/google/callback?state=${encodeURIComponent(brandedState)}`,
    { Cookie: brandedCookie },
  );
  assert(
    "same branded host sees the state cookie before code validation",
    brandedCallback.body.includes('"missing-code"'),
    brandedCallback.body,
  );

  const crossHost = await request(
    "localhost:3000",
    `/api/auth/google/callback?state=${encodeURIComponent(brandedState)}&code=fake`,
    { Cookie: brandedCookie },
  );
  assert(
    "cross-host replay is rejected before token exchange",
    crossHost.body.includes('"oauth-redirect-uri-mismatch"'),
    crossHost.body,
  );

  const gamma = await request("stock-platform-gamma.vercel.app", "/api/auth/google");
  assert("removed gamma host is rejected at OAuth start", gamma.res.statusCode === 400, gamma.res.statusCode);
  assert(
    "removed gamma host does not produce a Google redirect",
    gamma.body.includes('"oauth-host-not-allowed"') && !gamma.res.headers.location,
    { body: gamma.body, location: gamma.res.headers.location },
  );

  const unknown = await request("stock-platform-random-preview.vercel.app", "/api/auth/google");
  assert(
    "unknown host is rejected at OAuth start",
    unknown.res.statusCode === 400 && unknown.body.includes('"oauth-host-not-allowed"'),
    { status: unknown.res.statusCode, body: unknown.body },
  );
} finally {
  server.close();
}

console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
if (fail > 0) process.exit(1);
