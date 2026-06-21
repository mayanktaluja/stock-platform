import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";

const ROOT = process.cwd();
const PORT = 4153;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const SUB = "market-radar-reader";
const USERS_PATH = path.join(ROOT, "users.json");
const SNAPSHOT_PATH = path.join(ROOT, "data", "marketInformation", "latest.json");

function backup(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : null;
}

function restore(file, prior) {
  if (prior === null) fs.rmSync(file, { force: true });
  else fs.writeFileSync(file, prior);
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function signSession(sub) {
  const payload = Buffer.from(`sess:${JSON.stringify({ sub, ts: Date.now() })}`, "utf8").toString("base64url");
  const sig = createHmac("sha256", SECRET).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

async function waitForServer(child) {
  let out = "";
  child.stdout.on("data", (d) => { out += String(d); });
  child.stderr.on("data", (d) => { out += String(d); });
  const started = Date.now();
  while (Date.now() - started < 20_000) {
    if (out.includes(`http://localhost:${PORT}`)) return;
    if (child.exitCode !== null) throw new Error(`server exited early:\n${out}`);
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`server did not start:\n${out}`);
}

const priorUsers = backup(USERS_PATH);
const priorSnapshot = backup(SNAPSHOT_PATH);
let child;

try {
  writeJson(USERS_PATH, {
    [SUB]: {
      sub: SUB,
      email: "market-reader@example.com",
      name: "Market Reader",
      picture: "",
      isAdmin: false,
    },
  });
  fs.rmSync(SNAPSHOT_PATH, { force: true });

  child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(PORT),
      STARBHAI_SESSION_SECRET: SECRET,
      GOOGLE_CLIENT_ID: "test-client",
      GOOGLE_CLIENT_SECRET: "test-secret",
      GOOGLE_OAUTH_REDIRECT_URI: `${BASE}/api/auth/google/callback`,
      KV_REST_API_URL: "",
      KV_REST_API_TOKEN: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForServer(child);

  const signedIn = {
    headers: {
      cookie: `starbhai_session=${signSession(SUB)}`,
      accept: "application/json",
    },
  };

  const anon = await fetch(`${BASE}/api/market-information/latest`, { headers: { accept: "application/json" } });
  assert.equal(anon.status, 401, "Market Radar API must remain signed-in only");

  const missing = await fetch(`${BASE}/api/market-information/latest?ticker=MISSINGCASE`, signedIn);
  const missingBody = await missing.json();
  assert.equal(missing.status, 503);
  assert.equal(missingBody.status, "warming");

  writeJson(SNAPSHOT_PATH, {
    schema_version: "market-information-v1",
    generated_at: "2026-06-20T00:00:00.000Z",
    provider: "stockinsights",
    mode: "manual_cached",
    items: [
      {
        stable_id: "api-1",
        provider: "stockinsights",
        source_market: "india",
        source_kind: "corporate_announcement",
        ticker: "RELIANCE",
        company_name: "Reliance",
        category: "Credit Rating",
        sentiment: "negative",
        summary: "Rating action filed",
        source_url: "https://bse.test/reliance",
        published_at: "2026-06-20T00:10:00.000Z",
      },
      {
        stable_id: "api-2",
        provider: "stockinsights",
        source_market: "us",
        source_kind: "sec_filing",
        ticker: "MSFT",
        company_name: "Microsoft",
        category: "8-K",
        sentiment: "neutral",
        summary: "Current report filed",
        source_url: "https://sec.test/msft",
        published_at: "2026-06-20T00:20:00.000Z",
      },
    ],
  });

  const ok = await fetch(`${BASE}/api/market-information/latest?sentiment=negative&source=india`, signedIn);
  const body = await ok.json();
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get("cache-control") || "", /private/);
  assert.match(ok.headers.get("cache-control") || "", /max-age=300/);
  assert.equal(body.schema_version, "market-information-v1");
  assert.equal(body.runtime_audit.stale, true);
  assert.equal(body.sections.breaking_filings.length, 1);
  assert.equal(body.sections.breaking_filings[0].ticker, "RELIANCE");
  assert.equal(body.sections.us_sec_filings.length, 0);
} finally {
  if (child && child.exitCode === null) child.kill("SIGTERM");
  restore(USERS_PATH, priorUsers);
  restore(SNAPSHOT_PATH, priorSnapshot);
}

console.log("market information API contract ok");
