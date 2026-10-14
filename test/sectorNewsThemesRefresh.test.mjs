/**
 * scripts/refresh-sector-news-themes.mjs — the walk must always finish.
 *
 * WHY THIS EXISTS: on 2026-10-14 Gemini 429'd, each call burned its 1s+4s
 * backoff before falling to Groq, and the 900s step timeout SIGTERMed the walk
 * partway through the alphabet. Every ticker it never reached kept the stale
 * classified-news JSONL from git (2026-05-26), so Sector Outlook's 90-day
 * evidence fell 24 → 3 sectors and growing_sector_value shipped 100 → 0. And
 * the LLM cache, tracked but never committed by the nightly, was reset to that
 * same May copy every night, so every run started cold.
 *
 * Pinned here, with fixture deep briefs, fake providers and a fake clock:
 *   - a provider that keeps failing is skipped after 3 failures (breaker);
 *   - --llm-budget-sec stops LLM calls on wall clock, the walk still finishes;
 *   - every ticker's JSONL is rewritten from this run's news, even with the
 *     LLM gone from the first ticker on;
 *   - the cache is checkpointed during the walk, and flushed on SIGTERM
 *     (real child process, real signal);
 *   - refine candidates the budget didn't reach are NOT cached, so a
 *     persisted cache drains the backlog night by night instead of freezing
 *     the first night's alphabetical prefix as permanent heuristic hits;
 *   - --max-llm-calls=0 means zero (the shell's no-LLM re-run), not unlimited.
 *
 * Run with: node test/sectorNewsThemesRefresh.test.mjs
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  refreshSectorNewsThemes,
  parseArgs,
} from "../scripts/refresh-sector-news-themes.mjs";
import { loadCache } from "../services/sectorOutlook/llmThemeRefiner.js";
import { CLASSIFIER_VERSION } from "../services/sectorOutlook/themeTaxonomy.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(__dirname, "../scripts/refresh-sector-news-themes.mjs");

let failed = 0;
function assert(name, cond, got) {
  if (cond) console.log(`  ok: ${name}`);
  else {
    failed += 1;
    console.log(`  FAIL: ${name}${got !== undefined ? ` — got ${JSON.stringify(got)}` : ""}`);
  }
}

const quiet = () => {};
const DAY = 86_400_000;
// Derived from the real clock: the recency window is 365d of "now", and the
// SIGTERM child runs on the real clock (no time-bomb fixture dates).
const START = Date.now();
const FRESH_DATE = new Date(START - 5 * DAY).toISOString().slice(0, 10);

// 16 ambiguous (LLM-refine) items per ticker → 2 chunks of 8 per ticker.
const ITEMS_PER_TICKER = 16;
function makeFixture(label, tickerCount, { highConfPerTicker = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sector-themes-${label}-`));
  const deepDir = path.join(dir, "deep");
  const outDir = path.join(dir, "classified-news");
  fs.mkdirSync(deepDir);
  const tickers = Array.from({ length: tickerCount }, (_, i) => `T${String(i).padStart(3, "0")}`);
  for (const t of tickers) {
    fs.writeFileSync(path.join(deepDir, `${t}.json`), JSON.stringify({
      overview: { sector: "Industrials" },
      news: [
        ...Array.from({ length: ITEMS_PER_TICKER }, (_, k) => ({
          id: `${t}-n${k}`,
          date: FRESH_DATE,
          title: `Board meeting scheduled next month ${t} ${k}`,
          body: "",
        })),
        // High-confidence heuristic items: never LLM'd, always cached.
        ...Array.from({ length: highConfPerTicker }, (_, k) => ({
          id: `${t}-h${k}`,
          date: FRESH_DATE,
          title: `Q3 EPS exceeded analyst expectations ${t} ${k}`,
          body: "",
        })),
      ],
    }));
  }
  return { dir, deepDir, outDir, cachePath: path.join(dir, "llm-theme-cache.json"), tickers };
}

function okSignals(provider) {
  return (items) => items.map(() => ({
    theme: "ORDER_WINS",
    sign: 1,
    intensity: 2,
    confidence: 0.8,
    time_hint: "medium",
    top_reason: "fake",
    classifier_provider: provider,
    classifier_version: CLASSIFIER_VERSION,
  }));
}

function err429() {
  const e = new Error("429 status code (no body)");
  e.status = 429;
  return e;
}

function readJsonl(outDir, ticker) {
  const p = path.join(outDir, `${ticker}.jsonl`);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function attempts(cache) {
  const out = {};
  for (const e of Object.values(cache.entries)) out[e._last_provider_attempt] = (out[e._last_provider_attempt] || 0) + 1;
  return out;
}

// ─── parseArgs ───────────────────────────────────────────────────────
console.log("refresh-sector-news-themes: parseArgs");
{
  const p = (...a) => parseArgs(["node", "x", ...a]);
  assert("--max-llm-calls=0 is zero, not unlimited", p("--max-llm-calls=0").maxLlmCalls === 0, p("--max-llm-calls=0").maxLlmCalls);
  assert("--max-llm-calls=400", p("--max-llm-calls=400").maxLlmCalls === 400);
  assert("--max-llm-calls=abc → unlimited", p("--max-llm-calls=abc").maxLlmCalls === Infinity);
  assert("--max-llm-calls= → unlimited", p("--max-llm-calls=").maxLlmCalls === Infinity);
  assert("--llm-budget-sec=600", p("--llm-budget-sec=600").llmBudgetSec === 600);
  assert("no --llm-budget-sec → unlimited", p().llmBudgetSec === Infinity);
  assert("--checkpoint-every=0 ignored", p("--checkpoint-every=0").checkpointEvery === 100);
}

// ─── Gemini keeps 429ing, Groq healthy: Gemini skipped after 3 ───────
console.log("refresh-sector-news-themes: breaker skips a failing provider");
{
  const fx = makeFixture("breaker-one", 20);
  const calls = { gemini: 0, groq: 0 };
  const providers = [
    { name: "gemini", classify: async () => { calls.gemini += 1; throw err429(); } },
    { name: "groq", classify: async (items) => { calls.groq += 1; return okSignals("groq")(items); } },
  ];
  const s = await refreshSectorNewsThemes({ ...fx, providers, log: quiet });
  // Concurrency 2 lets one extra call be in flight when the 3rd failure opens it.
  assert("gemini called ≤ 4 times across 40 chunks", calls.gemini <= 4, calls);
  assert("gemini circuit is open", s.breaker.gemini?.open === true, s.breaker);
  assert("groq classified every chunk", calls.groq === 40 && s.breaker.groq?.successes === 40, calls);
  assert("LLM never stopped (groq carried it)", s.llm_stopped_reason === null, s.llm_stopped_reason);
  assert("all 20 tickers written", s.tickers_processed === 20, s.tickers_processed);
  const rows = readJsonl(fx.outDir, "T019");
  assert("last ticker's rows came from groq", rows.length === 16 && rows.every((r) => r.classifier_provider === "groq"), rows[0]);
  fs.rmSync(fx.dir, { recursive: true, force: true });
}

// ─── Both providers 429: LLM stops, walk finishes, stale JSONL replaced ──
console.log("refresh-sector-news-themes: all providers tripped → walk still completes");
{
  const fx = makeFixture("breaker-all", 30);
  // Seed every ticker with a stale May JSONL — what git hands the nightly.
  fs.mkdirSync(fx.outDir, { recursive: true });
  for (const t of fx.tickers) {
    fs.writeFileSync(path.join(fx.outDir, `${t}.jsonl`), JSON.stringify({
      ticker: t, news_id: `${t}-stale`, date: "2026-05-20", theme: "NEUTRAL", classifier_version: CLASSIFIER_VERSION,
    }) + "\n");
  }
  const calls = { gemini: 0, groq: 0 };
  const providers = [
    { name: "gemini", classify: async () => { calls.gemini += 1; throw err429(); } },
    { name: "groq", classify: async () => { calls.groq += 1; throw err429(); } },
  ];
  const s = await refreshSectorNewsThemes({ ...fx, providers, maxLlmCalls: 400, log: quiet });
  assert("stopped because providers tripped", s.llm_stopped_reason === "providers_tripped", s.llm_stopped_reason);
  assert("each provider called ≤ 4 times", calls.gemini <= 4 && calls.groq <= 4, calls);
  assert("all 30 tickers processed", s.tickers_processed === 30, s.tickers_processed);
  const stale = fx.tickers.filter((t) => readJsonl(fx.outDir, t).some((r) => r.news_id.endsWith("-stale")));
  assert("NO ticker keeps its stale JSONL", stale.length === 0, stale);
  const late = readJsonl(fx.outDir, "T029");
  assert("last ticker carries this run's news (heuristic)", late.length === 16 && late.every((r) => r.date === FRESH_DATE && r.classifier_provider === "heuristic"), late[0]);
  const a = attempts(loadCache(fx.cachePath));
  assert("only the batches actually sent are cached (as failed)", a.failed > 0 && a.failed <= 32 && !a["heuristic-only"], a);
  assert("never-sent items are deferred, not cached", s.llm_deferred_items === 30 * 16 - (a.failed || 0), { deferred: s.llm_deferred_items, a });
  fs.rmSync(fx.dir, { recursive: true, force: true });
}

// ─── A per-minute rate limit pauses the LLM; it does not end the night ─
console.log("refresh-sector-news-themes: open circuit re-probes after cooldown and the LLM resumes");
{
  const fx = makeFixture("resume", 30);
  let clock = START;
  let calls = 0;
  const providers = [{
    name: "gemini",
    classify: async (items) => {
      calls += 1;
      // 4, not 3: two chunks run concurrently, so both in flight must fail too.
      if (calls <= 4) throw err429(); // a burst of RPM 429s, then the window rolls
      return okSignals("gemini")(items);
    },
  }];
  const lines = [];
  // Every clock read advances 5s: a few reads per ticker ≈ 15-25s/ticker.
  const s = await refreshSectorNewsThemes({ ...fx, providers, now: () => (clock += 5_000), log: (l) => lines.push(l) });
  assert("paused once, then resumed", s.llm_pauses === 1 && lines.some((l) => /LLM resumed at/.test(l)), { pauses: s.llm_pauses, lines: lines.filter((l) => /LLM/.test(l)) });
  assert("not reported as stopped at the end", s.llm_stopped_reason === null, s.llm_stopped_reason);
  assert("circuit opened once and closed again", s.breaker.gemini?.times_opened === 1 && s.breaker.gemini?.open === false, s.breaker.gemini);
  const last = readJsonl(fx.outDir, "T029");
  assert("tickers after the pause are LLM-classified again", last.length === 16 && last.every((r) => r.classifier_provider === "gemini"), last[0]);
  fs.rmSync(fx.dir, { recursive: true, force: true });
}

// ─── --llm-budget-sec on a fake clock ────────────────────────────────
console.log("refresh-sector-news-themes: LLM budget stops calls on wall clock");
{
  const fx = makeFixture("deadline", 10);
  let clock = START;
  let calls = 0;
  let callsAfterStop = 0;
  let stopped = false;
  const providers = [{
    name: "gemini",
    classify: async (items) => {
      calls += 1;
      if (stopped) callsAfterStop += 1;
      clock += 100_000; // each call "takes" 100s
      return okSignals("gemini")(items);
    },
  }];
  const s = await refreshSectorNewsThemes({
    ...fx, providers, llmBudgetSec: 250, now: () => clock,
    log: (line) => { if (/LLM stopped/.test(line)) stopped = true; },
  });
  assert("stopped on llm_budget_sec", s.llm_stopped_reason === "llm_budget_sec", s.llm_stopped_reason);
  assert("3–4 calls fit in a 250s budget at 100s each", calls >= 3 && calls <= 4, calls);
  assert("no call starts after the stop", callsAfterStop === 0, callsAfterStop);
  assert("walk finished all 10 tickers", s.tickers_processed === 10 && fs.readdirSync(fx.outDir).length === 10, s.tickers_processed);
  fs.rmSync(fx.dir, { recursive: true, force: true });
}

// ─── Cache is checkpointed DURING the walk ───────────────────────────
console.log("refresh-sector-news-themes: cache checkpoints mid-walk");
{
  const fx = makeFixture("checkpoint", 4);
  const onDisk = [];
  const providers = [{
    name: "gemini",
    classify: async (items) => {
      onDisk.push(fs.existsSync(fx.cachePath) ? Object.keys(loadCache(fx.cachePath).entries).length : 0);
      return okSignals("gemini")(items);
    },
  }];
  const s = await refreshSectorNewsThemes({ ...fx, providers, checkpointEvery: 1, log: quiet });
  assert("nothing on disk before the first ticker", onDisk[0] === 0, onDisk);
  assert("ticker 1's 16 entries on disk while ticker 2 is classifying", onDisk[2] >= 16, onDisk);
  assert("ticker 3's view includes tickers 1–2", onDisk[4] >= 32, onDisk);
  assert("final cache holds all 64", Object.keys(loadCache(fx.cachePath).entries).length === 64);
  assert("checkpoint count reported", s.cache_checkpoints >= 4, s.cache_checkpoints);
  fs.rmSync(fx.dir, { recursive: true, force: true });
}

// ─── Persisted cache drains the backlog, never freezes it ────────────
console.log("refresh-sector-news-themes: backlog drains across runs (deferred items not cached)");
{
  const fx = makeFixture("drain", 3); // 48 candidates = 6 chunks
  const runs = [];
  for (let night = 1; night <= 4; night += 1) {
    let calls = 0;
    const providers = [{ name: "gemini", classify: async (items) => { calls += 1; return okSignals("gemini")(items); } }];
    const s = await refreshSectorNewsThemes({ ...fx, providers, maxLlmCalls: 2, log: quiet });
    runs.push({ calls, hits: s.cache_hits, deferred: s.llm_deferred_items });
  }
  assert("nights 1–3 each spend the 2-call budget on NEW items", runs.slice(0, 3).every((r) => r.calls === 2), runs);
  assert("cache hits grow 0 → 16 → 32 → 48", runs.map((r) => r.hits).join(",") === "0,16,32,48", runs);
  assert("night 4: backlog empty, zero calls", runs[3].calls === 0 && runs[3].deferred === 0, runs[3]);
  const rows = fx.tickers.flatMap((t) => readJsonl(fx.outDir, t));
  assert("every item now LLM-classified", rows.length === 48 && rows.every((r) => r.classifier_provider === "gemini"), rows.filter((r) => r.classifier_provider !== "gemini").length);
  fs.rmSync(fx.dir, { recursive: true, force: true });
}

// ─── --max-llm-calls=0: cache + heuristic, no network ────────────────
console.log("refresh-sector-news-themes: maxLlmCalls=0 re-run uses cache, calls nothing");
{
  const fx = makeFixture("zero", 3);
  const warm = [{ name: "gemini", classify: async (items) => okSignals("gemini")(items) }];
  await refreshSectorNewsThemes({ ...fx, providers: warm, maxLlmCalls: 3, log: quiet }); // 24 of 48 cached
  let calls = 0;
  const providers = [{ name: "gemini", classify: async (items) => { calls += 1; return okSignals("gemini")(items); } }];
  const s = await refreshSectorNewsThemes({ ...fx, providers, maxLlmCalls: 0, log: quiet });
  assert("zero provider calls", calls === 0 && s.llm_calls === 0, { calls, s: s.llm_calls });
  assert("24 cache hits served", s.cache_hits === 24, s.cache_hits);
  const rows = fx.tickers.flatMap((t) => readJsonl(fx.outDir, t));
  assert("rows mix cached LLM and heuristic", rows.filter((r) => r.classifier_provider === "gemini").length === 24 && rows.length === 48, rows.length);
  fs.rmSync(fx.dir, { recursive: true, force: true });
}

// ─── SIGTERM mid-walk flushes the cache (real process, real signal) ──
console.log("refresh-sector-news-themes: SIGTERM flushes the cache before exit");
{
  const fx = makeFixture("sigterm", 5);
  const child = path.join(fx.dir, "child.mjs");
  fs.writeFileSync(child, `
    const { refreshSectorNewsThemes } = await import(${JSON.stringify(pathToFileURL(SCRIPT).href)});
    let calls = 0;
    const ok = (items) => items.map(() => ({ theme: "ORDER_WINS", sign: 1, intensity: 2, confidence: 0.8,
      time_hint: "medium", top_reason: "", classifier_provider: "gemini", classifier_version: ${JSON.stringify(CLASSIFIER_VERSION)} }));
    const providers = [{ name: "gemini", classify: async (items) => {
      calls += 1;
      if (calls <= 4) return ok(items);
      console.log("HUNG");                 // ticker 3: hang like a stuck LLM call
      setInterval(() => {}, 1000);         // keep the loop alive
      return new Promise(() => {});
    } }];
    await refreshSectorNewsThemes({
      deepDir: ${JSON.stringify(fx.deepDir)}, outDir: ${JSON.stringify(fx.outDir)}, cachePath: ${JSON.stringify(fx.cachePath)},
      providers, checkpointEvery: 1e9, checkpointMs: 1e12, installSignalHandlers: true,
    });
  `);
  const result = await new Promise((resolve) => {
    const proc = spawn(process.execPath, [child], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const killer = setTimeout(() => proc.kill("SIGKILL"), 15_000);
    proc.stdout.on("data", (d) => {
      out += d;
      if (out.includes("HUNG")) proc.kill("SIGTERM");
    });
    proc.stderr.on("data", (d) => { out += d; });
    proc.on("exit", (code, signal) => { clearTimeout(killer); resolve({ code, signal, out }); });
  });
  assert("child exits 143 (still reads as a kill to with_timeout)", result.code === 143, { code: result.code, signal: result.signal, out: result.out.slice(-400) });
  assert("SIGTERM log line names the ticker", /SIGTERM at T002 — cache flushed/.test(result.out), result.out.slice(-400));
  const cache = loadCache(fx.cachePath);
  const a = attempts(cache);
  assert("the 4 completed batches (32 items) survived the kill", a.succeeded === 32, a);
  fs.rmSync(fx.dir, { recursive: true, force: true });
}

// ─── SIGTERM during the no-LLM part of the walk ──────────────────────
// After LLM calls stop, the walk is sync I/O plus resolved promises. Without a
// per-ticker macrotask yield the event loop never turns, the handler never
// runs, and with_timeout's KILL follows with nothing flushed.
console.log("refresh-sector-news-themes: SIGTERM is handled mid-walk with no LLM in flight");
{
  const fx = makeFixture("sigterm-nollm", 200, { highConfPerTicker: 2 });
  const child = path.join(fx.dir, "child-nollm.mjs");
  fs.writeFileSync(child, `
    const { refreshSectorNewsThemes } = await import(${JSON.stringify(pathToFileURL(SCRIPT).href)});
    await refreshSectorNewsThemes({
      deepDir: ${JSON.stringify(fx.deepDir)}, outDir: ${JSON.stringify(fx.outDir)}, cachePath: ${JSON.stringify(fx.cachePath)},
      providers: [], maxLlmCalls: 0, verbose: true, checkpointEvery: 1e9, checkpointMs: 1e12, installSignalHandlers: true,
      // Slow, fully synchronous per-ticker work (like parsing a big deep brief).
      log: (line) => { console.log(line); const until = Date.now() + 20; while (Date.now() < until) {} },
    });
    console.log("WALK_DONE");
  `);
  const result = await new Promise((resolve) => {
    const proc = spawn(process.execPath, [child], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let sent = false;
    const killer = setTimeout(() => proc.kill("SIGKILL"), 20_000);
    proc.stdout.on("data", (d) => {
      out += d;
      if (!sent && /\] T005:/.test(out)) { sent = true; proc.kill("SIGTERM"); }
    });
    proc.stderr.on("data", (d) => { out += d; });
    proc.on("exit", (code, signal) => { clearTimeout(killer); resolve({ code, signal, out }); });
  });
  const at = (result.out.match(/SIGTERM at (T\d+)/) || [])[1];
  assert("handler ran mid-walk: exit 143, walk not finished", result.code === 143 && !result.out.includes("WALK_DONE"), { code: result.code, tail: result.out.slice(-300) });
  assert("…at an early ticker, not after the last one", !!at && Number(at.slice(1)) < 150, at);
  const entries = Object.keys(loadCache(fx.cachePath).entries).length;
  assert("…and flushed the cache it had built (2 entries/ticker so far)", entries >= 10 && entries % 2 === 0, entries);
  fs.rmSync(fx.dir, { recursive: true, force: true });
}

if (failed > 0) {
  console.log(`\nsectorNewsThemesRefresh: ${failed} failures`);
  process.exit(1);
}
console.log("\nsectorNewsThemesRefresh: all tests passed");
