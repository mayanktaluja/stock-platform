/**
 * Prod-like auth/cache coverage for the public market ticker endpoint.
 *
 * Run with: node test/marketPublicCacheAuth.test.mjs
 */

import http from "node:http";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { createHmac } from "node:crypto";

process.env.NODE_ENV = "test";
process.env.VERCEL = "1";
process.env.STARBHAI_SESSION_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.GOOGLE_CLIENT_ID = "test-client";
process.env.GOOGLE_CLIENT_SECRET = "test-secret";
process.env.GOOGLE_OAUTH_REDIRECT_URI = "https://starbhai-stock-platform.vercel.app/api/auth/google/callback";
process.env.KV_REST_API_URL = "";
process.env.KV_REST_API_TOKEN = "";

const { default: app } = await import(`../server.js?market-public-cache-auth=${Date.now()}`);

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
const panicPath = path.join(process.cwd(), "data", "sws", "panic-stop.flag");
const priorPanic = fs.existsSync(panicPath) ? fs.readFileSync(panicPath, "utf8") : null;

function signSession(sub) {
  const payload = Buffer.from(`sess:${JSON.stringify({ sub, ts: Date.now() })}`, "utf8").toString("base64url");
  const sig = createHmac("sha256", process.env.STARBHAI_SESSION_SECRET).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

function request(path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        method: "GET",
        path,
        headers: { accept: "application/json", ...headers },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => {
          let json = null;
          try { json = JSON.parse(body); } catch {}
          resolve({ res, body, json });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function marketPayload(overrides = {}) {
  return {
    indices: [
      {
        symbol: "^NSEI",
        name: "NIFTY 50",
        price: 25000,
        change: 10,
        changePercent: 0.04,
        source: "test",
      },
    ],
    source: "test",
    lastUpdated: new Date().toISOString(),
    marketStatus: "OPEN",
    giftNiftyLastTradedAt: null,
    ...overrides,
  };
}

try {
  console.log("\nmarketPublicCacheAuth — anonymous market access");
  app.locals.__clearMarketCache();
  let providerCalls = 0;
  app.locals.__marketDataProvider = async () => {
    providerCalls += 1;
    return marketPayload();
  };

  const publicMarket = await request("/api/market");
  assert("anonymous /api/market returns 200", publicMarket.res.statusCode === 200, publicMarket.res.statusCode);
  assert("market response is public-cacheable while open", publicMarket.res.headers["cache-control"] === "public, s-maxage=300, stale-while-revalidate=600", publicMarket.res.headers["cache-control"]);
  assert("market response does not set cookies", !publicMarket.res.headers["set-cookie"], publicMarket.res.headers["set-cookie"]);
  assert("market JSON preserves existing fields", Array.isArray(publicMarket.json.indices) && publicMarket.json.source === "test" && publicMarket.json.marketStatus === "OPEN", publicMarket.json);
  assert("market JSON adds stale metadata only", publicMarket.json.stale === false && publicMarket.json.stale_age_sec === 0, publicMarket.json);
  assert(
    "market JSON has no user-specific identity fields",
    !("userId" in publicMarket.json) && !("email" in publicMarket.json) && !("name" in publicMarket.json) && !("isAdmin" in publicMarket.json),
    publicMarket.json,
  );

  const cachedMarket = await request("/api/market");
  assert("second local /api/market request is process-cache HIT", cachedMarket.res.headers["x-cache"] === "HIT" && providerCalls === 1, { cache: cachedMarket.res.headers["x-cache"], providerCalls });

  console.log("\nmarketPublicCacheAuth — concurrent cold misses coalesce");
  app.locals.__clearMarketCache();
  providerCalls = 0;
  app.locals.__marketDataProvider = async () => {
    providerCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 50));
    return marketPayload({ marketStatus: "CLOSED" });
  };
  const [a, b, c] = await Promise.all([
    request("/api/market"),
    request("/api/market"),
    request("/api/market"),
  ]);
  assert("concurrent cold /api/market calls all return 200", [a, b, c].every((r) => r.res.statusCode === 200), [a.res.statusCode, b.res.statusCode, c.res.statusCode]);
  assert("concurrent cold calls share one provider call", providerCalls === 1, providerCalls);
  assert("closed market response gets longer s-maxage", a.res.headers["cache-control"] === "public, s-maxage=1800, stale-while-revalidate=3600", a.res.headers["cache-control"]);

  console.log("\nmarketPublicCacheAuth — bounded stale fallback");
  app.locals.__clearMarketCache();
  providerCalls = 0;
  app.locals.__marketDataProvider = async () => {
    providerCalls += 1;
    if (providerCalls === 1) return marketPayload({ marketStatus: "CLOSED" });
    throw new Error("upstream down");
  };
  const fresh = await request("/api/market");
  assert("first request seeds last-good market payload", fresh.res.statusCode === 200 && fresh.json?.stale === false, { status: fresh.res.statusCode, body: fresh.json });
  app.locals.__clearMarketCache({ keepLastGood: true });
  const stale = await request("/api/market");
  assert("upstream failure serves bounded stale response", stale.res.statusCode === 200 && stale.res.headers["x-cache"] === "STALE" && stale.json.stale === true, { status: stale.res.statusCode, cache: stale.res.headers["x-cache"], body: stale.json });

  console.log("\nmarketPublicCacheAuth — private APIs remain anonymous-gated");
  for (const route of [
    "/api/sws-picks?limit=1",
    "/api/us-picks?limit=1",
    "/api/kr-picks?limit=1",
    "/api/tw-picks?limit=1",
    "/api/watchlist",
    "/api/portfolio",
    "/api/admin/users",
    "/api/sws-scan/status",
  ]) {
    const blocked = await request(route);
    assert(`${route} rejects anonymous request`, blocked.res.statusCode === 401 && blocked.json?.error === "unauthenticated", { status: blocked.res.statusCode, body: blocked.json });
  }

  console.log("\nmarketPublicCacheAuth — scan status never caches over panic");
  fs.writeFileSync(panicPath, JSON.stringify({ reason: "test-panic", at: new Date().toISOString() }));
  const signedCookie = `starbhai_session=${signSession("scan-status-reader")}`;
  const scanStatus = await request("/api/sws-scan/status", { cookie: signedCookie });
  assert("signed scan status returns 200", scanStatus.res.statusCode === 200, scanStatus.res.statusCode);
  assert("scan status is no-store", scanStatus.res.headers["cache-control"] === "private, no-store", scanStatus.res.headers["cache-control"]);
  assert("panic state is visible immediately", scanStatus.json?.panic_stop?.active === true && scanStatus.json?.panic_stop?.reason === "test-panic", scanStatus.json);
} finally {
  app.locals.__marketDataProvider = null;
  app.locals.__clearMarketCache();
  if (priorPanic === null) {
    try { fs.unlinkSync(panicPath); } catch {}
  } else {
    fs.writeFileSync(panicPath, priorPanic);
  }
  server.close();
}

console.log(`\nResult: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
