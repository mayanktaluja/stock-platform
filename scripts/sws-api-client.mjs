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
import { classifyBlock, parseRetryAfter, CHALLENGE_TITLE_RE } from "./sws-panic-ladder.mjs";

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
// An injected (test) client carries its own operations, so the hook needs no
// gitignored api-queries.json on disk.
function loadQueries(client = null) {
  if (client?.queries) return client.queries;
  if (_queries) return _queries;
  if (!fs.existsSync(QUERIES_PATH)) {
    throw new Error(`Queries not found. Run: node scripts/sws-api-extract-queries.mjs`);
  }
  _queries = JSON.parse(fs.readFileSync(QUERIES_PATH, "utf8"));
  return _queries;
}

function payloadBytes(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value ?? null));
  } catch {
    return null;
  }
}

async function timedEndpoint(timings, meta, fn) {
  const t0 = Date.now();
  try {
    const value = await fn();
    timings.push({
      ...meta,
      ok: true,
      ms: Date.now() - t0,
      bytes: payloadBytes(value),
    });
    return value;
  } catch (err) {
    timings.push({
      ...meta,
      ok: false,
      ms: Date.now() - t0,
      bytes: 0,
      error_kind: err?.kind || null,
      status: err?.status || null,
    });
    throw err;
  }
}

// ────────── Client (wraps a Playwright page) ──────────

export class TransportError extends Error {
  constructor(msg, { kind, status, body, op, cfClass = null, headers = null, retryAfterSec = null } = {}) {
    super(msg);
    this.name = "TransportError";
    this.kind = kind; // "auth_expired" | "rate_limited" | "blocked" | "transient" | "graphql_error" | "unknown"
    this.status = status;
    this.body = body;
    this.op = op;
    // 403/429 only — see classifyBlock() in sws-panic-ladder.mjs:
    // "challenge" | "hard_block" | "rate_limited" | "unclassified".
    this.cfClass = cfClass;
    this.headers = headers;
    this.cfRay = headers?.["cf-ray"] ?? null;
    this.cfMitigated = headers?.["cf-mitigated"] ?? null;
    this.retryAfterSec = retryAfterSec;
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

// Response headers kept on a TransportError (forensics + Retry-After).
const CAPTURED_HEADERS = ["cf-mitigated", "cf-ray", "retry-after"];

/**
 * Record that a request SENT at `sentAt` came back 2xx. The scraper persists
 * the max into progress-api-<N>.json as `last_ok_sent_at`; the panic quorum
 * (sws-panic-ladder.mjs) reads it to tell "this shard is blocked" from "SWS
 * is blocking us". Send time, not completion time: a request already in
 * flight when a peer voted proves nothing about after the vote.
 */
function noteServed(client, sentAt) {
  if (!client.lastOkSentAt || sentAt > client.lastOkSentAt) client.lastOkSentAt = sentAt;
}

/**
 * Execute a fetch inside the browser page context. Returns { status, body }.
 * The browser auto-attaches the JWT and cookies, and uses Chrome's TLS
 * fingerprint, which keeps Cloudflare happy.
 */
async function pageFetch(client, { url, method, headers, body }) {
  // Taken in node before the hop into the page, so it is never later than
  // the real send — the conservative side for the quorum's "sent after".
  const sentAt = Date.now();
  const result = await client.page.evaluate(
    async ({ url, method, headers, body, headerNames }) => {
      try {
        const resp = await fetch(url, {
          method,
          headers,
          body,
          credentials: "include",
        });
        const status = resp.status;
        const text = await resp.text();
        const respHeaders = {};
        for (const name of headerNames) {
          const v = resp.headers.get(name);
          if (v != null) respHeaders[name] = v;
        }
        return { ok: true, status, text, headers: respHeaders };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    },
    { url, method, headers, body, headerNames: CAPTURED_HEADERS },
  );
  if (!result.ok) {
    throw new TransportError(`network: ${result.error}`, { kind: "transient" });
  }
  const respHeaders = result.headers || {};
  if (result.status >= 200 && result.status < 300) noteServed(client, sentAt);
  if (result.status === 401) {
    throw new TransportError("HTTP 401", { kind: "auth_expired", status: 401 });
  }
  if (result.status === 403) {
    // Classified on the FULL body: the challenge markers sit past the 200
    // chars kept below. "challenge" ("Just a moment...") is what every trip
    // 2026-08-20 → 09-30 was; "hard_block" is "you have been blocked" / 1020.
    const cfClass = classifyBlock({ status: 403, body: result.text, headers: respHeaders });
    throw new TransportError(`HTTP 403${cfClass === "unclassified" ? "" : ` (cloudflare ${cfClass})`}`, {
      kind: "blocked",
      status: 403,
      body: result.text.slice(0, 200),
      cfClass,
      headers: respHeaders,
      retryAfterSec: parseRetryAfter(respHeaders["retry-after"]),
    });
  }
  if (result.status === 429) {
    throw new TransportError("HTTP 429", {
      kind: "rate_limited",
      status: 429,
      body: result.text.slice(0, 200),
      cfClass: "rate_limited",
      headers: respHeaders,
      retryAfterSec: parseRetryAfter(respHeaders["retry-after"]),
    });
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
  const queries = loadQueries(client);
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

  const res = await pageFetch(client, {
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
  const res = await pageFetch(client, { url, method, headers });
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
    telemetry: { endpoint_timings: [] },
  };

  // Step 1: CompanySummary — gets companyId + score
  const summary = await timedEndpoint(
    out.telemetry.endpoint_timings,
    { kind: "graphql", name: "CompanySummary" },
    () => callGraphQL(client, "CompanySummary", { canonicalUrl }),
  );
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
    NarrativeValuationHistory: { companyId },
  };
  const queries = loadQueries(client);
  const remainingOps = TARGET_OPERATIONS.filter(
    (op) => op !== "CompanySummary" && queries.operations[op],
  );
  const opResults = await Promise.allSettled(
    remainingOps.map((op) => {
      const sampleVars = queries.operations[op].sampleVariables || {};
      const vars = { ...sampleVars, ...(opVars[op] || {}) };
      return timedEndpoint(
        out.telemetry.endpoint_timings,
        { kind: "graphql", name: op },
        () => callGraphQL(client, op, vars),
      );
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
      {
        const restPath = ep.pathBuilder({ companyId, canonicalUrl });
        return timedEndpoint(
          out.telemetry.endpoint_timings,
          { kind: "rest", name: ep.name, method: ep.method, path: restPath.split("?")[0] },
          () => callRest(client, {
            method: ep.method,
            path: restPath,
          }),
        );
      }
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

// ────────── Panic ladder helpers (SWS_PANIC_LADDER=1) ──────────

/**
 * One cheap request for the same ticker: CompanySummary. Served = the ladder
 * clears. An HTTP 200 carrying a GraphQL error still means SWS served us.
 */
export async function probeTicker(client, { canonicalUrl }) {
  try {
    await callGraphQL(client, "CompanySummary", { canonicalUrl });
    return { ok: true };
  } catch (err) {
    if (err?.kind === "graphql_error") return { ok: true, note: "graphql_error" };
    return { ok: false, err };
  }
}

/**
 * Re-navigate the shard's page to /dashboard so the browser can solve a fresh
 * Cloudflare challenge (and pick up a new cf_clearance), then wait up to
 * `maxWaitMs` for the title to stop reading "Just a moment...". Never throws.
 */
export async function reprimePage(client, { maxWaitMs = 30_000, pollMs = 1_000 } = {}) {
  const t0 = Date.now();
  try {
    await client.page.goto("https://simplywall.st/dashboard", { timeout: 60000, waitUntil: "domcontentloaded" });
  } catch (e) {
    return { challenged: null, title: null, error: String(e?.message || e).slice(0, 200), ms: Date.now() - t0 };
  }
  const waitStart = Date.now();
  let title = "";
  for (;;) {
    title = await client.page.title().catch(() => "");
    if (!CHALLENGE_TITLE_RE.test(title) || Date.now() - waitStart >= maxWaitMs) break;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return { challenged: CHALLENGE_TITLE_RE.test(title), title, ms: Date.now() - t0 };
}

/**
 * In-page fetches only work from a simplywall.st origin. If a reprime's
 * navigation failed, the page may sit on chrome-error:// and every later
 * fetch fails as a "network" error until the shard ends — so navigate back
 * first. No-op (no request) while the page is on-site.
 */
export async function ensureOnSite(client, opts = {}) {
  let url = "";
  try { url = client.page.url(); } catch { /* closed page: let the fetch report it */ }
  if (/^https:\/\/simplywall\.st\//.test(url)) return { ok: true, url };
  return { ok: false, url, reprime: await reprimePage(client, opts) };
}

// ────────── Injected transport (tests only: SWS_INJECT_BLOCK) ──────────

// Head of the verbatim 2026-09-30 17:09 IST CENTRALBK body, plus the script
// marker a real challenge page carries further down.
const INJECTED_CHALLENGE_BODY =
  '<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"><meta http-equiv="X-UA-Compatible" content="IE=Edge"><meta name="robots" content="noindex,nofollow"></head><body><script src="/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1"></script></body></html>';

const INJECTED_RESPONSES = {
  challenge: (n) => ({ status: 403, text: INJECTED_CHALLENGE_BODY, headers: { "cf-mitigated": "challenge", "cf-ray": `inject${n}-BOM` } }),
  hard_block: (n) => ({ status: 403, text: "<!DOCTYPE html><title>Attention Required! | Cloudflare</title><h1>Sorry, you have been blocked</h1><span class=\"cf-error-code\">1020</span>", headers: { "cf-ray": `inject${n}-BOM` } }),
  unclassified: (n) => ({ status: 403, text: '{"error":"forbidden"}', headers: { "cf-ray": `inject${n}-BOM` } }),
  rate_limited: (n, retryAfterSec) => ({ status: 429, text: "Too Many Requests", headers: { "cf-ray": `inject${n}-BOM`, ...(retryAfterSec != null ? { "retry-after": String(retryAfterSec) } : {}) } }),
};

/**
 * A client whose page is fake: no Chrome, no network. The first `blocks`
 * requests (stock fetches and ladder probes, in order) get a synthetic
 * `kind` response (only those matching `match`, when given); everything else
 * is a minimal 200. The REAL pageFetch,
 * classification, last_ok_sent_at stamping, fetchStockData and the scraper's
 * loop all run on top of it — only the browser is replaced.
 */
export function createInjectedClient({ shardId = 1, blocks = 0, kind = "challenge", retryAfterSec = null, match = null } = {}) {
  const make = INJECTED_RESPONSES[kind];
  if (!make) throw new Error(`SWS_INJECT_BLOCK_KIND must be one of ${Object.keys(INJECTED_RESPONSES).join("|")}`);
  let remaining = blocks;
  const stats = { requests: 0, blocked: 0 };
  // `match` (SWS_INJECT_BLOCK_MATCH): only requests whose URL or body contain
  // it are blocked — one refused stock among served ones.
  const targeted = (url, body) => !match || String(url).includes(match) || String(body ?? "").includes(match);
  const page = {
    async evaluate(_fn, { url, body }) {
      stats.requests++;
      if (remaining > 0 && targeted(url, body)) {
        remaining--;
        stats.blocked++;
        return { ok: true, ...make(stats.blocked, retryAfterSec) };
      }
      let text = "{}";
      if (url.endsWith("/graphql")) {
        const op = (() => { try { return JSON.parse(body).operationName; } catch { return null; } })();
        text = op === "CompanySummary"
          ? JSON.stringify({ data: { Company: { id: `inject-${shardId}-${stats.requests}`, score: { value: 1, future: 1, past: 1, health: 1, dividend: 1 } } } })
          : JSON.stringify({ data: {} });
      }
      return { ok: true, status: 200, text, headers: {} };
    },
    url() { return "https://simplywall.st/dashboard"; },
    async goto() {},
    async title() { return remaining > 0 && kind === "challenge" ? "Just a moment..." : "Simply Wall St"; },
  };
  const queries = { operations: Object.fromEntries(TARGET_OPERATIONS.map((op) => [op, { query: `query ${op} { __typename }`, sampleVariables: {} }])) };
  return { ctx: null, page, shardId, injected: true, stats, queries, async close() {} };
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
