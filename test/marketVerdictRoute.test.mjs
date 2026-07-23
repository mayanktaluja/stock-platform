import http from "node:http";
import { once } from "node:events";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.AUTH_ENABLED = "false";
process.env.VERCEL = "1";
process.env.STARBHAI_SESSION_SECRET = "";
process.env.GOOGLE_CLIENT_ID = "";
process.env.GOOGLE_CLIENT_SECRET = "";
process.env.GOOGLE_OAUTH_REDIRECT_URI = "";
process.env.KV_REST_API_URL = "";
process.env.KV_REST_API_TOKEN = "";

const { default: app } = await import(`../server.js?market-verdict-route=${Date.now()}`);

// server.js:13 runs `dotenv.config({ override: true })`, which re-reads .env and
// OVERWRITES the neutralisation above. In any environment that has a real .env
// (the nightly's worktree symlinks one) this in-process app would otherwise talk
// to live KV. Re-strip AFTER the import — getKVClient() reads process.env at call
// time, so this is what actually takes effect. Don't "fix" this by disabling
// dotenv's override: the nightly relies on it to pick up rotated credentials.
delete process.env.KV_REST_API_URL;
delete process.env.KV_REST_API_TOKEN;

const server = http.createServer(app);
server.listen(0, "127.0.0.1");
await once(server, "listening");
const { port } = server.address();

function request(path) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        method: "GET",
        path,
        headers: { accept: "application/json" },
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

let pass = 0;
let fail = 0;

function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ok ${name}`);
  } catch (err) {
    fail += 1;
    console.error(`  not ok ${name}`);
    console.error(err.stack || err.message);
  }
}

try {
  console.log("marketVerdictRoute");
  const now = new Date().toISOString();
  app.locals.__marketVerdictInputProvider = async () => ({
    regime: {
      regime: "RATE_CUT",
      severity: 2,
      confidence: 0.8,
      generatedAt: now,
      classifierProvider: "test",
    },
    marketBreadth: {
      advancing: 65,
      declining: 35,
      lastUpdated: now,
      source: "route-test",
    },
    fiiDii: {
      available: true,
      date: new Date().toISOString().slice(0, 10),
      fii: { netValue: 700 },
      dii: { netValue: 300 },
      history: [{ fii: 700, dii: 300 }],
      lastUpdated: now,
    },
    trackedPickCount: 42,
  });
  app.locals.__clearMarketVerdictCache?.();

  const first = await request("/api/market-verdict");
  check("route returns 200", () => assert.equal(first.res.statusCode, 200));
  check("legacy fields remain present", () => {
    assert.equal(typeof first.json.verdict, "string");
    assert.equal(typeof first.json.verdictColor, "string");
    assert.equal(typeof first.json.verdictAction, "string");
    assert.equal(typeof first.json.score, "number");
    assert.ok(Array.isArray(first.json.signals));
  });
  check("additive analyst fields are present", () => {
    assert.equal(first.json.marketState, "CONSTRUCTIVE");
    assert.equal(typeof first.json.sourceQuality, "object");
    assert.equal(typeof first.json.decisionBasis, "object");
    assert.equal(typeof first.json.components, "object");
  });

  app.locals.__marketVerdictInputProvider = async () => ({
    regime: null,
    marketBreadth: null,
    fiiDii: { available: false },
    trackedPickCount: 0,
  });
  app.locals.__clearMarketVerdictCache?.();
  const degraded = await request("/api/market-verdict");
  check("route handles unavailable inputs without 500", () => {
    assert.equal(degraded.res.statusCode, 200);
    assert.equal(degraded.json.marketState, "INSUFFICIENT_EVIDENCE");
    assert.equal(degraded.json.sourceQuality.macro.usable, false);
  });
} finally {
  app.locals.__marketVerdictInputProvider = null;
  app.locals.__clearMarketVerdictCache?.();
  server.close();
}

console.log(`\nmarketVerdictRoute result: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
