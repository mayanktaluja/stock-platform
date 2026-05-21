#!/usr/bin/env node
/**
 * SWS API client — uses an authenticated Playwright page as the network
 * transport. All fetches happen via `page.evaluate(() => fetch(...))` so they
 * use the browser's TLS fingerprint, cookies, and auto-attached JWT.
 *
 * This bypasses Cloudflare's bot detection entirely — from the network's
 * perspective we ARE the SWS frontend, just driving it programmatically.
 *
 * Per-stock cost: ~10 fetches × ~300ms (some can run in parallel) ≈ 1-3s.
 *
 * Usage (high-level):
 *   import { createClient, fetchStockData } from "./sws-api-client.mjs";
 *   const client = await createClient({ shardId: 1 });
 *   await client.warmup();
 *   const data = await fetchStockData(client, { ticker, canonicalUrl });
 *   await client.close();
 *
 * CLI usage (for testing one stock):
 *   node scripts/sws-api-client.mjs HDFCBANK
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchShardContext } from "./sws-stealth-context.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const QUERIES_PATH = path.join(REPO_ROOT, "data/sws/api-queries.json");
const UNIVERSE_PATH = path.join(REPO_ROOT, "data/sws/universe.json");

// GraphQL operations we want.
//
// News intentionally NOT here: live browser capture confirmed that SWS does
// NOT expose per-company activity through a public GraphQL operation. The
// only `updates(activityTypes: [Brief, Event])` GraphQL fragment in their
// frontend bundle is for the portfolio-level page (`limit: 1`) and is
// embedded in `getPortfolio` — useless for our per-stock feed. The actual
// per-company news / events / briefs come from the REST endpoint
// `/dashboard/company<canonicalUrl>` — see TARGET_REST_ENDPOINTS below.
export const TARGET_OPERATIONS = [
  "CompanySummary",
  "getNarrativeValuation",
  "CompanyNarrativesWithHistogram",
  "getCompanyTimeSeries",
  "getCompanyDividends",
  "getCompanyPeers",
  "NarrativeValuationHistory",
];

// REST endpoints (path templates). All GET (the captures showed GET; the
// earlier summary that said POST was a parsing bug). Query params copied
// verbatim from real captured requests.
export const TARGET_REST_ENDPOINTS = [
  {
    name: "price",
    method: "GET",
    // start_timestamp: ~1 year of history. Computed at call time.
    pathBuilder: ({ companyId }) =>
      `/api/company/price/${companyId}?start_timestamp=${Date.now() - 365 * 86400 * 1000}`,
  },
  {
    name: "estimates",
    method: "GET",
    pathBuilder: ({ canonicalUrl }) => `/api/company/estimates/coverage${canonicalUrl}`,
  },
  {
    name: "ownership",
    method: "GET",
    pathBuilder: ({ companyId }) => `/api/company/ownership/shareholders/${companyId}`,
  },
  {
    name: "industry",
    method: "GET",
    pathBuilder: ({ companyId }) => `/api/industry/company/${companyId}`,
  },
  {
    name: "competitors",
    method: "GET",
    pathBuilder: ({ companyId }) =>
      `/api/competitors/${companyId}?include=score%2Cscore.snowflake&version=2.0`,
  },
  // News / events / activity feed. Live capture (Chrome MCP, 2026-05-09)
  // showed SWS frontend pulls company-page news via:
  //   GET https://simplywall.st/dashboard/company<canonicalUrl>
  // and renders `data.events.data[]` as the on-page "Recent News & Updates"
  // section. Returns ~100 records per stock spanning multiple years, mixed:
  //   {type:"event"}            — corporate actions (headline, situation,
  //                               key_dev_type, announcement_date)
  //   {type:"brief"}            — analyst-style commentary (title, outcome,
  //                               description, name)
  //   {type:"narrative"|"narrative-update"} — SWS-published narratives
  //                               (title, content, author_*)
  // No query params or special headers needed; auth flows through the same
  // browser-context cookies as every other call. The parser reads from
  // api.rest.dashboard_company.data.events.data — see extractNews() in
  // sws-api-parser.mjs.
  {
    name: "dashboard_company",
    method: "GET",
    pathBuilder: ({ canonicalUrl }) => `/dashboard/company${canonicalUrl}`,
  },
  // Per-statement check list (~160 rows) — backs the on-page "Rewards" and
  // "Risk Analysis" sections. Each row carries {area, public, state,
  // description, outcome, severity, ...}; extractRewardsRisks() in
  // sws-api-parser.mjs filters area+public+state to reproduce exactly what
  // the SWS page renders. Public endpoint (no auth needed) confirmed via
  // live capture 2026-05-14, but still Cloudflare-gated, so — like every
  // other call here — it has to flow through the browser context.
  {
    name: "statements",
    method: "GET",
    pathBuilder: ({ canonicalUrl }) =>
      `/backend/statements${canonicalUrl}?include=statements.question,sentence&locale=en`,
  },
];

// ────────── Queries loading ──────────

let _queries = null;
function loadQueries() {
  if (_queries) return _queries;
  if (!fs.existsSync(QUERIES_PATH)) {
    throw new Error(`Queries not found. Run: node scripts/sws-api-extract-queries.mjs`);
  }
  _queries = JSON.parse(fs.readFileSync(QUERIES_PATH, "utf8"));
  return _queries;
}

// ────────── Client (wraps a Playwright page) ──────────

export class TransportError extends Error {
  constructor(msg, { kind, status, body, op } = {}) {
    super(msg);
    this.name = "TransportError";
    this.kind = kind; // "auth_expired" | "rate_limited" | "blocked" | "transient" | "graphql_error" | "unknown"
    this.status = status;
    this.body = body;
    this.op = op;
  }
}

/**
 * Create a client. Launches stealth Chrome via the project's launcher
 * (same fingerprint as the shard scrapers), opens one page, and primes the
 * SWS session.
 *
 * IMPORTANT: this acquires the shard lock (the launchShardContext does), so
 * the chosen shardId must NOT be running a scraper. Default to shard 1.
 */
export async function createClient({ shardId = 1, headless = true, cfg = null } = {}) {
  // `cfg` is forwarded to the stealth launcher so a sibling pipeline (the US
  // fork) can use its own profile dirs. Null = India defaults (unchanged).
  const ctx = await launchShardContext(shardId, { headless, cfg });
  const page = await ctx.newPage();

  // Prime the session: navigate to a stock page so SWS issues the JWT to
  // localStorage and sets all session cookies. Subsequent fetches reuse this.
  await page.goto("https://simplywall.st/dashboard", {
    timeout: 60000,
    waitUntil: "domcontentloaded",
  });
  // Brief settle so the JWT-issuing /api/user call completes.
  await new Promise((r) => setTimeout(r, 5000));

  return {
    ctx,
    page,
    shardId,
    async close() {
      try {
        await ctx.close();
      } catch {}
    },
  };
}

// ────────── In-page fetch — runs inside the browser ──────────

/**
 * Execute a fetch inside the browser page context. Returns { status, body }.
 * The browser auto-attaches the JWT and cookies, and uses Chrome's TLS
 * fingerprint, which keeps Cloudflare happy.
 */
async function pageFetch(page, { url, method, headers, body }) {
  const result = await page.evaluate(
    async ({ url, method, headers, body }) => {
      try {
        const resp = await fetch(url, {
          method,
          headers,
          body,
          credentials: "include",
        });
        const status = resp.status;
        const text = await resp.text();
        return { ok: true, status, text };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    },
    { url, method, headers, body },
  );
  if (!result.ok) {
    throw new TransportError(`network: ${result.error}`, { kind: "transient" });
  }
  if (result.status === 401) {
    throw new TransportError("HTTP 401", { kind: "auth_expired", status: 401 });
  }
  if (result.status === 403) {
    // Could be Cloudflare challenge — body usually contains "Just a moment..."
    const cf = result.text.includes("Just a moment") || result.text.includes("Cloudflare");
    throw new TransportError(`HTTP 403${cf ? " (cloudflare)" : ""}`, {
      kind: "blocked",
      status: 403,
      body: result.text.slice(0, 200),
    });
  }
  if (result.status === 429) {
    throw new TransportError("HTTP 429", { kind: "rate_limited", status: 429 });
  }
  if (result.status >= 500) {
    throw new TransportError(`HTTP ${result.status}`, {
      kind: "transient",
      status: result.status,
      body: result.text.slice(0, 200),
    });
  }
  if (result.status >= 400) {
    throw new TransportError(`HTTP ${result.status}`, {
      kind: "unknown",
      status: result.status,
      body: result.text.slice(0, 500),
    });
  }
  // Parse JSON
  let parsed = null;
  try {
    parsed = result.text.length ? JSON.parse(result.text) : null;
  } catch {
    parsed = { _raw: result.text };
  }
  return { status: result.status, body: parsed };
}

// ────────── GraphQL & REST ──────────

export async function callGraphQL(client, operationName, variables) {
  const queries = loadQueries();
  const op = queries.operations[operationName];
  if (!op) throw new Error(`Unknown GraphQL operation: ${operationName}`);

  const body = JSON.stringify({
    query: op.query,
    variables: variables || {},
    operationName,
  });
  const headers = {
    "content-type": "application/json",
    accept: "*/*",
    // apollo headers — readable by SWS for client identification but not auth
    "apollographql-client-name": "sws-frontend",
    "apollographql-client-version": "current",
  };

  const res = await pageFetch(client.page, {
    url: "https://simplywall.st/graphql",
    method: "POST",
    headers,
    body,
  });

  // GraphQL returns 200 even on auth/data errors — check `errors` field
  if (res.body && res.body.errors) {
    const firstErr = res.body.errors[0];
    const msg = firstErr?.message || "GraphQL error";
    if (/UNAUTHENTICATED|expired token|invalid token|authentication/i.test(msg)) {
      throw new TransportError(`GraphQL auth: ${msg}`, { kind: "auth_expired", op: operationName });
    }
    throw new TransportError(`GraphQL: ${msg}`, {
      kind: "graphql_error",
      body: res.body,
      op: operationName,
    });
  }
  return res.body?.data || null;
}

export async function callRest(client, { method, path: pathStr }) {
  const url = "https://simplywall.st" + pathStr;
  const headers = {
    accept: "application/vnd.simplywallst.v2",
  };
  const res = await pageFetch(client.page, { url, method, headers });
  return res.body;
}

// ────────── High-level: fetch one stock ──────────

export async function fetchStockData(client, { ticker, canonicalUrl }) {
  if (!canonicalUrl) {
    throw new Error(`fetchStockData: canonicalUrl is required`);
  }
  if (!canonicalUrl.startsWith("/")) canonicalUrl = "/" + canonicalUrl;
  canonicalUrl = canonicalUrl.replace(/^https?:\/\/simplywall\.st/, "");

  const out = {
    ticker,
    canonicalUrl,
    fetchedAt: new Date().toISOString(),
    graphql: {},
    rest: {},
    errors: [],
  };

  // Step 1: CompanySummary — gets companyId + score
  const summary = await callGraphQL(client, "CompanySummary", { canonicalUrl });
  out.graphql.CompanySummary = summary;
  const companyId = summary?.Company?.id;
  if (!companyId) {
    out.errors.push({ step: "CompanySummary", error: "no companyId in response" });
    return out;
  }
  out.companyId = companyId;

  // Step 2-7: remaining GraphQL ops in parallel (browser handles concurrency)
  const opVars = {
    getNarrativeValuation: { companyId },
    CompanyNarrativesWithHistogram: { canonicalUrl },
    getCompanyTimeSeries: { id: companyId },
    getCompanyDividends: { id: companyId },
    getCompanyPeers: { id: companyId },
    NarrativeValuationHistory: { id: companyId },
  };
  const queries = loadQueries();
  const remainingOps = TARGET_OPERATIONS.filter(
    (op) => op !== "CompanySummary" && queries.operations[op],
  );
  const opResults = await Promise.allSettled(
    remainingOps.map((op) => {
      const sampleVars = queries.operations[op].sampleVariables || {};
      const vars = { ...sampleVars, ...(opVars[op] || {}) };
      return callGraphQL(client, op, vars);
    }),
  );
  for (let i = 0; i < remainingOps.length; i++) {
    const op = remainingOps[i];
    const r = opResults[i];
    if (r.status === "fulfilled") {
      out.graphql[op] = r.value;
    } else {
      const e = r.reason;
      out.errors.push({ step: op, error: String(e), kind: e?.kind });
      if (e?.kind === "auth_expired" || e?.kind === "rate_limited" || e?.kind === "blocked") {
        throw e;
      }
    }
  }

  // Step 8-12: REST endpoints in parallel
  const restResults = await Promise.allSettled(
    TARGET_REST_ENDPOINTS.map((ep) =>
      callRest(client, {
        method: ep.method,
        path: ep.pathBuilder({ companyId, canonicalUrl }),
      }),
    ),
  );
  for (let i = 0; i < TARGET_REST_ENDPOINTS.length; i++) {
    const ep = TARGET_REST_ENDPOINTS[i];
    const r = restResults[i];
    if (r.status === "fulfilled") {
      out.rest[ep.name] = r.value;
    } else {
      const e = r.reason;
      out.errors.push({ step: `rest:${ep.name}`, error: String(e), kind: e?.kind });
      if (e?.kind === "auth_expired" || e?.kind === "rate_limited" || e?.kind === "blocked") {
        throw e;
      }
    }
  }

  return out;
}

// ────────── CLI for one-stock testing ──────────

async function main() {
  const ticker = process.argv[2];
  if (!ticker) {
    console.error("usage: node scripts/sws-api-client.mjs <TICKER>");
    process.exit(2);
  }

  const universe = JSON.parse(fs.readFileSync(UNIVERSE_PATH, "utf8"));
  const items = Array.isArray(universe) ? universe : universe.stocks || universe.universe || [];
  const stock = items.find((s) => s.ticker?.toUpperCase() === ticker.toUpperCase());
  if (!stock) {
    console.error(`ticker ${ticker} not in universe.json`);
    process.exit(1);
  }
  const canonicalUrl = stock.sws_url.replace(/^https?:\/\/simplywall\.st/, "");

  console.log(`[client] launching browser...`);
  const client = await createClient({ shardId: 1, headless: true });
  console.log(`[client] session primed; fetching ${ticker}...`);
  const t0 = Date.now();
  let data;
  try {
    data = await fetchStockData(client, { ticker, canonicalUrl });
  } finally {
    await client.close();
  }
  const elapsed = Date.now() - t0;
  console.log(`[client] done in ${elapsed}ms`);
  console.log(`[client] companyId: ${data.companyId}`);
  console.log(`[client] graphql ops: ${Object.keys(data.graphql).join(", ")}`);
  console.log(`[client] rest ops:    ${Object.keys(data.rest).join(", ")}`);
  console.log(`[client] errors:      ${data.errors.length}`);
  if (data.graphql.CompanySummary?.Company?.score) {
    const s = data.graphql.CompanySummary.Company.score;
    console.log(`[client] snowflake:   value=${s.value} future=${s.future} past=${s.past} health=${s.health} dividend=${s.dividend}`);
  }
  if (data.errors.length) {
    for (const e of data.errors) {
      console.log(`  ⚠️  ${e.step}: ${e.error}`);
    }
  }
  const dbgDir = path.join(REPO_ROOT, "data/sws/api-debug");
  fs.mkdirSync(dbgDir, { recursive: true });
  const outPath = path.join(dbgDir, `${ticker}-api.json`);
  fs.writeFileSync(outPath, JSON.stringify(data, null, 2));
  console.log(`[client] full payload saved: ${outPath}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error("[client] fatal:", e);
    if (e instanceof TransportError) {
      console.error(`  kind: ${e.kind}, status: ${e.status}, body: ${(e.body || "").slice ? e.body.slice(0, 300) : e.body}`);
    }
    process.exit(1);
  });
}
