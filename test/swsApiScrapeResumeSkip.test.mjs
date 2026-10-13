/**
 * Drives the REAL scripts/sws-api-scrape.mjs loop (no Chrome, no network) to
 * pin the resume-after-abort skip at the process level. Uses the scraper's
 * SWS_INJECT_* test hook: SWS_INJECT_BLOCK=0 swaps the browser page for a fake
 * that blocks nothing, SWS_INJECT_DATA_DIR relocates data/sws, and
 * SWS_INJECT_TIME_SCALE compresses the pacing sleeps. Same harness shape as
 * test/swsApiScrapeLadder.test.mjs.
 *
 * WHY THIS EXISTS: after a deadline abort, sws-refresh-api.sh hands the shards
 * SWS_SCRAPE_SKIP_FRESH_SEC so a stock whose raw payload is still young is not
 * fetched again (see scripts/sws-scrape-progress.mjs for why it is per stock,
 * not a carried cursor). The skip is only safe if it: skips ONLY usable young
 * payloads, never counts a skip as served (done_count feeds the panic policy's
 * clean_run), still advances the cursor, logs the event step 4b's top-up reads
 * back, and never applies to an explicit --tickers run (that IS the top-up).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRAPER = path.resolve(__dirname, "../scripts/sws-api-scrape.mjs");
const SCALE = "0.004";
const H = 3_600_000;

let pass = 0;
let fail = 0;
function assert(name, cond, got) {
  if (cond) {
    pass++;
    console.log("  ✓", name);
  } else {
    fail++;
    console.log("  ✗", name, "→ got", JSON.stringify(got));
  }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sws-scrape-resume-"));
let seq = 0;
const ticker = (i) => `T${String(i).padStart(4, "0")}`;

// 6 stocks → shard 1's contiguous slice is T0000, T0001.
function mkDataDir({ payloads = {} } = {}) {
  const d = path.join(tmpRoot, `d${++seq}`);
  fs.mkdirSync(path.join(d, "deep-api"), { recursive: true });
  const universe = Array.from({ length: 6 }, (_, i) => ({ ticker: ticker(i), sws_url: `https://simplywall.st/stocks/in/test/nse-${ticker(i).toLowerCase()}/x` }));
  fs.writeFileSync(path.join(d, "universe.json"), JSON.stringify(universe));
  fs.writeFileSync(path.join(d, "progress-api-1.json"), JSON.stringify({ shard_id: 1, next_local_index: 0, done_count: 100 }));
  for (const [t, spec] of Object.entries(payloads)) {
    const body = spec.raw ?? JSON.stringify({
      ticker: t, canonicalUrl: "/x", fetchedAt: new Date(Date.now() - spec.ageH * H).toISOString(),
      graphql: { CompanySummary: { Company: { id: 1 } } }, rest: {}, errors: [], marker: "ORIGINAL",
    }, null, 2);
    fs.writeFileSync(path.join(d, "deep-api", `${t}.json`), body);
  }
  return d;
}

function runShard(dir, { env = {}, args = [] } = {}) {
  return new Promise((resolve) => {
    const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^SWS_(PANIC_LADDER|PANIC_RUN_ID|INJECT_|RESUME|SCRAPE_SKIP)/.test(k)));
    const child = spawn(process.execPath, [SCRAPER, "1", ...args], {
      env: { ...base, SWS_INJECT_BLOCK: "0", SWS_INJECT_DATA_DIR: dir, SWS_INJECT_TIME_SCALE: SCALE, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => { out += c; });
    child.stderr.on("data", (c) => { err += c; });
    child.on("close", (code) => {
      const events = out.split("\n").flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
      resolve({ code, events, err });
    });
  });
}
const done = (r) => r.events.filter((e) => e.event === "stock_done").map((e) => e.ticker);
const skips = (r) => r.events.filter((e) => e.event === "skip" && e.reason === "fresh_payload").map((e) => e.ticker);
const progressOf = (d) => JSON.parse(fs.readFileSync(path.join(d, "progress-api-1.json"), "utf8"));
const rawOf = (d, t) => fs.readFileSync(path.join(d, "deep-api", `${t}.json`), "utf8");

console.log("\nsws-api-scrape.mjs — resume skip (real loop, injected page)\n");

try {
  const SKIP = { SWS_SCRAPE_SKIP_FRESH_SEC: String(7 * 3600) };

  {
    const d = mkDataDir({ payloads: { T0000: { ageH: 1 }, T0001: { ageH: 10 } } });
    const r = await runShard(d, { env: SKIP });
    assert("exit 0", r.code === 0, { code: r.code, err: r.err.slice(-300) });
    assert("the 1h-old payload is skipped (fresh_payload event — what step 4b reads back)", JSON.stringify(skips(r)) === '["T0000"]', skips(r));
    assert("…and only the 10h-old one is fetched", JSON.stringify(done(r)) === '["T0001"]', done(r));
    assert("the skipped payload is left untouched on disk", rawOf(d, "T0000").includes('"marker": "ORIGINAL"'), rawOf(d, "T0000").slice(0, 120));
    const p = progressOf(d);
    assert("cursor still advances past the skip (end of slice)", p.next_local_index === 2, p.next_local_index);
    assert("a skip is NOT counted as served: done_count +1, not +2", p.done_count === 101, p.done_count);
    const end = r.events.find((e) => e.event === "session_end");
    assert("session_end reports skipped_fresh", end?.skipped_fresh === 1 && end?.scraped === 1, end);
  }

  {
    const d = mkDataDir({ payloads: { T0000: { ageH: 1 }, T0001: { ageH: 10 } } });
    const r = await runShard(d);
    assert("knob unset → every stock fetched, exactly as before", JSON.stringify(done(r)) === '["T0000","T0001"]' && skips(r).length === 0, { done: done(r), skips: skips(r) });
  }

  {
    const d = mkDataDir({ payloads: { T0000: { ageH: 1 } } });
    const r = await runShard(d, { env: SKIP, args: ["--tickers", "T0000"] });
    assert("an explicit --tickers run (the step-4b top-up) never skips", JSON.stringify(done(r)) === '["T0000"]' && skips(r).length === 0, { done: done(r), skips: skips(r) });
  }

  {
    const full = JSON.stringify({ ticker: "T0000", fetchedAt: new Date(Date.now() - H).toISOString(), graphql: { CompanySummary: { Company: {} } }, errors: [] }, null, 2);
    const d = mkDataDir({ payloads: { T0000: { raw: full.slice(0, full.length - 9) }, T0001: { ageH: 1 } } });
    const r = await runShard(d, { env: SKIP });
    assert("a payload torn by the deadline KILL is fetched again, a clean young one is skipped", JSON.stringify(done(r)) === '["T0000"]' && JSON.stringify(skips(r)) === '["T0001"]', { done: done(r), skips: skips(r) });
  }
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
