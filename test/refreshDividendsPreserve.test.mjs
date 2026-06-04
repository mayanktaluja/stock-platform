import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

let pass = 0, fail = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log("  ✓", name);
  } catch (err) {
    fail++;
    console.log("  ✗", name, "→", err.message);
  }
}

function runRefresh(env) {
  return spawnSync(process.execPath, ["scripts/refresh-dividends.mjs"], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

console.log("\nrefresh-dividends preservation tests\n");

check("refresh-dividends preserves prior non-empty cache on suspicious zero output", () => {
  const root = mkdtempSync(join(tmpdir(), "div-preserve-"));
  const deepDir = join(root, "deep");
  mkdirSync(deepDir);
  const outPath = join(root, "dividends-upcoming.json");
  const growwPath = join(root, "missing-groww.json");
  writeFileSync(outPath, JSON.stringify({
    schema_version: "dividends-upcoming-v2",
    built_at: "2026-06-04T00:00:00.000Z",
    today_iso: "2026-06-04",
    dividend_count: 1,
    dividends: [{ symbol: "CIPLA", ex_date: "2026-06-05", dps: 13, source: "sws-news" }],
  }, null, 2));

  const res = runRefresh({
    SWS_DIVIDENDS_DEEP_DIR: deepDir,
    SWS_DIVIDENDS_OUT_PATH: outPath,
    SWS_DIVIDENDS_GROWW_CACHE: growwPath,
    SWS_DIVIDENDS_NSE_ANNOUNCEMENTS: join(root, "missing-nse.json"),
    SWS_DIVIDENDS_SKIP_LIVE_ACTIONS: "1",
  });
  assert.equal(res.status, 2, `${res.stdout}\n${res.stderr}`);
  const out = JSON.parse(readFileSync(outPath, "utf8"));
  assert.equal(out.preserved_from_prior, true);
  assert.equal(out.dividends.length, 1);
  assert.equal(out.preservation.reason, "zero-confirmed-dividends");
});

check("refresh-dividends writes Groww-derived rows without live NSE/BSE fetches", () => {
  const root = mkdtempSync(join(tmpdir(), "div-groww-"));
  const deepDir = join(root, "deep");
  mkdirSync(deepDir);
  const outPath = join(root, "dividends-upcoming.json");
  const growwPath = join(root, "groww.json");
  writeFileSync(growwPath, JSON.stringify({
    schema_version: "groww-stock-v1",
    fetched_at: new Date().toISOString(),
    by_ticker: {
      RELIANCE: {
        events: [
          { title: "Dividend", type: "DIVIDEND", status: "Announced", ex_date: "2026-06-11T18:30:00.000Z", record_date: "2026-06-11T18:30:00.000Z", value: "₹6.00" },
          { title: "Dividend", type: "DIVIDEND", status: "Ex date", ex_date: "2026-06-11T18:30:00.000Z", record_date: "2026-06-11T18:30:00.000Z", value: "₹6.00" },
        ],
      },
    },
  }, null, 2));

  const res = runRefresh({
    SWS_DIVIDENDS_DEEP_DIR: deepDir,
    SWS_DIVIDENDS_OUT_PATH: outPath,
    SWS_DIVIDENDS_GROWW_CACHE: growwPath,
    SWS_DIVIDENDS_NSE_ANNOUNCEMENTS: join(root, "missing-nse.json"),
    SWS_DIVIDENDS_SKIP_LIVE_ACTIONS: "1",
  });
  assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
  const out = JSON.parse(readFileSync(outPath, "utf8"));
  assert.equal(out.schema_version, "dividends-upcoming-v2");
  assert.equal(out.dividend_count, 1);
  assert.equal(out.dividends[0].source, "groww-events");
  assert.equal(out.dividends[0].dps, 6);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

