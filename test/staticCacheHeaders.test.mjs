/**
 * Cache header coverage for protected gated assets and public login assets.
 *
 * Run with: node test/staticCacheHeaders.test.mjs
 */

import http from "node:http";
import { once } from "node:events";
import { createHmac } from "node:crypto";
import { execSync } from "node:child_process";

process.env.NODE_ENV = "test";
process.env.VERCEL = "1";
process.env.STARBHAI_SESSION_SECRET = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
process.env.GOOGLE_CLIENT_ID = "test-client";
process.env.GOOGLE_CLIENT_SECRET = "test-secret";
process.env.GOOGLE_OAUTH_REDIRECT_URI = "https://starbhai-stock-platform.vercel.app/api/auth/google/callback";
process.env.KV_REST_API_URL = "";
process.env.KV_REST_API_TOKEN = "";

execSync("node scripts/prepare-public-assets.mjs", { stdio: "inherit" });

const { default: app } = await import(`../server.js?static-cache-headers=${Date.now()}`);

// server.js:13 runs `dotenv.config({ override: true })`, which re-reads .env and
// OVERWRITES the neutralisation above. Re-strip AFTER the import so this
// in-process app can never reach live KV. See test/marketVerdictRoute.test.mjs.
delete process.env.KV_REST_API_URL;
delete process.env.KV_REST_API_TOKEN;

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

function signSession(sub) {
  const payload = Buffer.from(`sess:${JSON.stringify({ sub, ts: Date.now() })}`, "utf8").toString("base64url");
  const sig = createHmac("sha256", process.env.STARBHAI_SESSION_SECRET).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

const server = http.createServer(app);
server.listen(0, "127.0.0.1");
await once(server, "listening");
const { port } = server.address();
const signedCookie = `starbhai_session=${signSession("static-reader")}`;

function request(path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        method: "GET",
        path,
        headers,
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

try {
  console.log("\nstaticCacheHeaders — gated shell/assets");
  const index = await request("/index.html", { cookie: signedCookie });
  assert("gated index.html remains no-cache", index.statusCode === 200 && index.headers["cache-control"] === "no-cache", { status: index.statusCode, cache: index.headers["cache-control"] });

  const appJs = await request("/app.js", { cookie: signedCookie });
  assert("stable gated app.js gets only short private cache", appJs.statusCode === 200 && appJs.headers["cache-control"] === "private, max-age=300, must-revalidate", { status: appJs.statusCode, cache: appJs.headers["cache-control"] });

  const publicAppJs = await request("/assets/gated/app.js");
  assert("public generated app.js is reachable without session", publicAppJs.statusCode === 200, { status: publicAppJs.statusCode });
  assert("public generated app.js gets edge-friendly short cache", publicAppJs.headers["cache-control"] === "public, max-age=300, stale-while-revalidate=3600", { cache: publicAppJs.headers["cache-control"] });

  console.log("\nstaticCacheHeaders — public assets");
  const login = await request("/login.html");
  assert("public login.html remains no-cache", login.statusCode === 200 && login.headers["cache-control"] === "no-cache", { status: login.statusCode, cache: login.headers["cache-control"] });

  const icon = await request("/favicon-32.png");
  assert("public icon gets edge-friendly cache", icon.statusCode === 200 && icon.headers["cache-control"] === "public, max-age=86400, stale-while-revalidate=604800", { status: icon.statusCode, cache: icon.headers["cache-control"] });
} finally {
  server.close();
}

console.log(`\nResult: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
