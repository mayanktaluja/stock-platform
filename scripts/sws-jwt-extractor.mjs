#!/usr/bin/env node
/**
 * Extract a fresh SWS JWT (and the full set of authenticated headers) by
 * briefly opening .sws-profile-1 in headless Chrome, capturing the first
 * /graphql POST the page makes, and saving its headers to disk.
 *
 * The cache is consumed by sws-api-client.mjs so we don't need a browser at
 * scrape time — pure HTTP for everything else.
 *
 * Usage:
 *   node scripts/sws-jwt-extractor.mjs              # extract if missing/expired
 *   node scripts/sws-jwt-extractor.mjs --force      # always re-extract
 *   node scripts/sws-jwt-extractor.mjs --status     # print current cache status
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchShardContext } from "./sws-stealth-context.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const CACHE_PATH = path.join(REPO_ROOT, "data/sws/.jwt-cache.json");

// JWT-aware shard ID. We use shard-1's profile (same as research) since it's
// guaranteed to have a logged-in subscription session.
const SHARD_ID = 1;

// How long before expiry should we treat the cache as stale and refresh? 1 day.
const REFRESH_BEFORE_EXPIRY_SECONDS = 24 * 3600;

function decodeJwtPayload(jwt) {
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  const padded = parts[1] + "=".repeat((-parts[1].length % 4 + 4) % 4);
  try {
    const decoded = Buffer.from(padded, "base64").toString("utf8");
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

function readCache() {
  if (!fs.existsSync(CACHE_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
  } catch {
    return null;
  }
}

function isCacheFresh(cache) {
  if (!cache || !cache.headers || !cache.headers.authorization) return false;
  const jwt = cache.headers.authorization.replace(/^Bearer\s+/i, "");
  const payload = decodeJwtPayload(jwt);
  if (!payload || !payload.exp) return false;
  const nowSec = Math.floor(Date.now() / 1000);
  return payload.exp - nowSec > REFRESH_BEFORE_EXPIRY_SECONDS;
}

function summarise(cache) {
  if (!cache) return { status: "missing" };
  const jwt = (cache.headers || {}).authorization?.replace(/^Bearer\s+/i, "") || "";
  const payload = decodeJwtPayload(jwt);
  if (!payload) return { status: "invalid" };
  const nowSec = Math.floor(Date.now() / 1000);
  const expiresInSec = payload.exp - nowSec;
  return {
    status: expiresInSec > REFRESH_BEFORE_EXPIRY_SECONDS ? "fresh" : (expiresInSec > 0 ? "stale" : "expired"),
    sub: payload.sub,
    scope: payload.scope,
    exp: new Date(payload.exp * 1000).toISOString(),
    expiresInHours: (expiresInSec / 3600).toFixed(1),
    extractedAt: cache.extractedAt,
  };
}

async function extract() {
  console.log("[jwt] launching stealth browser to extract JWT...");
  const ctx = await launchShardContext(SHARD_ID, { headless: false }); // headed so we can see if login state breaks
  const page = await ctx.newPage();

  // Strategy: navigate to a stock page (fires both /graphql + /api/ calls)
  // and capture the FIRST authenticated request of each type. We need both
  // because GraphQL requests carry apollo-specific headers (client-name/version)
  // that REST requests don't.
  const capturedGraphQL = { headers: null, url: null };
  const capturedRest = { headers: null, url: null };

  // Listen for ALL requests; the first authenticated /graphql and first
  // authenticated /api/ (non-graphql) wins.
  page.on("request", (req) => {
    const u = req.url();
    const h = req.headers();
    if (!h.authorization) return;
    if (u.includes("/graphql") && !capturedGraphQL.headers) {
      capturedGraphQL.headers = { ...h };
      capturedGraphQL.url = u;
    } else if (u.includes("simplywall.st/api/") && !capturedRest.headers) {
      capturedRest.headers = { ...h };
      capturedRest.url = u;
    }
  });

  // Navigate to a stock page that fires both call types
  const stockUrl = "https://simplywall.st/stocks/in/banks/nse-hdfcbank/hdfc-bank-shares";
  console.log(`[jwt] navigating to ${stockUrl}`);
  await page.goto(stockUrl, { timeout: 60000, waitUntil: "domcontentloaded" });

  console.log("[jwt] waiting up to 30s for both header types to be captured...");
  const deadline = Date.now() + 30000;
  while ((!capturedGraphQL.headers || !capturedRest.headers) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
  }

  if (!capturedGraphQL.headers) {
    console.error("[jwt] ❌ no authenticated /graphql request captured — login may have broken");
    await ctx.close();
    process.exit(1);
  }
  if (!capturedRest.headers) {
    console.warn("[jwt] ⚠️  no authenticated /api/ request captured — REST calls may fail");
  }

  // Use GraphQL request as primary (it has the most complete header set)
  const captured = {
    headers: capturedGraphQL.headers,
    method: "POST",
    url: capturedGraphQL.url,
    capturedAt: new Date().toISOString(),
  };

  // Sanity check: decode JWT
  const jwt = (captured.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const payload = decodeJwtPayload(jwt);
  if (!payload) {
    console.error("[jwt] could not decode JWT from captured authorization header");
    await ctx.close();
    process.exit(1);
  }

  console.log(`[jwt] ✅ captured JWT for sub=${payload.sub}`);
  console.log(`[jwt]    expires: ${new Date(payload.exp * 1000).toISOString()}`);
  console.log(`[jwt]    scope: ${payload.scope}`);
  console.log(`[jwt]    captured from: ${captured.url}`);

  // Persist BOTH header sets (GraphQL + REST) so the client picks the right
  // one per call type. Strip per-request volatile headers from each.
  const cache = {
    extractedAt: captured.capturedAt,
    jwtPayload: payload,
    graphqlHeaders: stripVolatileHeaders(capturedGraphQL.headers),
    restHeaders: capturedRest.headers ? stripVolatileHeaders(capturedRest.headers) : null,
    // Backwards-compat: also expose `headers` (= graphqlHeaders)
    headers: stripVolatileHeaders(capturedGraphQL.headers),
    capturedFromGraphqlUrl: capturedGraphQL.url,
    capturedFromRestUrl: capturedRest.url,
  };
  fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
  console.log(`[jwt] saved to ${CACHE_PATH}`);

  await ctx.close();
}

function stripVolatileHeaders(h) {
  // Headers we want to KEEP for replay (the stable per-session/per-app set):
  //   authorization, user-agent, accept-language, sec-ch-ua, sec-ch-ua-mobile,
  //   sec-ch-ua-platform, content-type, apollographql-client-name,
  //   apollographql-client-version, accept, origin, referer
  // Headers we strip (per-request or auto-generated by fetch):
  //   baggage, sentry-trace, host, content-length, connection, cookie
  const STRIP = new Set([
    "baggage",
    "sentry-trace",
    "host",
    "content-length",
    "connection",
    "cookie", // cookies will be reattached by fetch from a stored cookie jar if needed
    ":authority",
    ":method",
    ":path",
    ":scheme",
  ]);
  const out = {};
  for (const [k, v] of Object.entries(h)) {
    if (!STRIP.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const statusOnly = args.includes("--status");

  if (statusOnly) {
    const cache = readCache();
    console.log(JSON.stringify(summarise(cache), null, 2));
    return;
  }

  if (!force) {
    const cache = readCache();
    if (isCacheFresh(cache)) {
      const s = summarise(cache);
      console.log(`[jwt] cache is fresh (expires in ${s.expiresInHours}h, sub=${s.sub})`);
      return;
    }
  }

  await extract();
}

main().catch((e) => {
  console.error("[jwt] fatal:", e);
  process.exit(1);
});
