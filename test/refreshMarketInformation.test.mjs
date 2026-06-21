import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runRefreshMarketInformation } from "../scripts/refresh-market-information.mjs";

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "market-info-refresh-"));
  return path.join(dir, "latest.json");
}

test("runRefreshMarketInformation writes an atomic non-empty snapshot", async () => {
  const out = tmpFile();
  const pages = [];
  const fetchImpl = async (url) => {
    pages.push(url.searchParams.get("page"));
    return new Response(JSON.stringify({
      data: [
        {
          id: "a1",
          ticker: "NSE:TCS",
          company_name: "TCS",
          published_date: "2026-06-21T02:00:00Z",
          ai_insights: { announcement_type: "Financial Results", summary_text: "Result filed" },
        },
      ],
    }), { status: 200 });
  };
  const result = await runRefreshMarketInformation({
    argv: ["--from=2026-06-20", "--to=2026-06-21", "--limit=50"],
    env: { STOCKINSIGHTS_API_KEY: "test-key", MARKET_INFORMATION_MAX_PAGES: "1" },
    fetchImpl,
    outPath: out,
    logger: { log() {}, error() {} },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(pages, ["1"]);
  const written = JSON.parse(fs.readFileSync(out, "utf-8"));
  assert.equal(written.schema_version, "market-information-v1");
  assert.equal(written.items.length, 1);
  assert.equal(written.items[0].ticker, "TCS");
});

test("runRefreshMarketInformation refuses to overwrite on zero rows", async () => {
  const out = tmpFile();
  fs.writeFileSync(out, JSON.stringify({ keep: true }));
  const result = await runRefreshMarketInformation({
    env: { STOCKINSIGHTS_API_KEY: "test-key", MARKET_INFORMATION_MAX_PAGES: "1" },
    fetchImpl: async () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
    outPath: out,
    logger: { log() {}, error() {} },
  });
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 75);
  assert.deepEqual(JSON.parse(fs.readFileSync(out, "utf-8")), { keep: true });
});

test("runRefreshMarketInformation refuses to overwrite on provider failure", async () => {
  const out = tmpFile();
  fs.writeFileSync(out, JSON.stringify({ keep: true }));
  const result = await runRefreshMarketInformation({
    env: { STOCKINSIGHTS_API_KEY: "test-key", MARKET_INFORMATION_MAX_PAGES: "1" },
    fetchImpl: async () => new Response(JSON.stringify({ error: "nope" }), { status: 502 }),
    outPath: out,
    logger: { log() {}, error() {} },
  });
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 75);
  assert.deepEqual(JSON.parse(fs.readFileSync(out, "utf-8")), { keep: true });
});

test("runRefreshMarketInformation respects explicit free-trial page cap", async () => {
  const out = tmpFile();
  const pages = [];
  const fetchImpl = async (url) => {
    pages.push(url.searchParams.get("page"));
    return new Response(JSON.stringify({
      data: [
        { id: `row-${url.searchParams.get("page")}`, ticker: "NSE:TCS", published_date: "2026-06-21T02:00:00Z", ai_insights: { summary_text: "filed" } },
      ],
    }), { status: 200 });
  };
  const result = await runRefreshMarketInformation({
    argv: ["--max-pages=1", "--limit=1"],
    env: { STOCKINSIGHTS_API_KEY: "test-key", MARKET_INFORMATION_MAX_PAGES: "3" },
    fetchImpl,
    outPath: out,
    logger: { log() {}, error() {} },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(pages, ["1"]);
});

test("runRefreshMarketInformation fails closed when API key is missing", async () => {
  const out = tmpFile();
  fs.writeFileSync(out, JSON.stringify({ keep: true }));
  const result = await runRefreshMarketInformation({
    env: {},
    fetchImpl: async () => {
      throw new Error("should not call provider");
    },
    outPath: out,
    logger: { log() {}, error() {} },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "missing_api_key");
  assert.deepEqual(JSON.parse(fs.readFileSync(out, "utf-8")), { keep: true });
});
