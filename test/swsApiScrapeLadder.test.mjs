/**
 * Drives the REAL scripts/sws-api-scrape.mjs loop through the panic ladder +
 * quorum, using the SWS_INJECT_BLOCK test hook: the browser page is swapped
 * for a fake whose first N requests get a synthetic Cloudflare response, and
 * everything else — pageFetch's classification and last_ok_sent_at stamp,
 * fetchStockData, the per-stock loop, the ladder, votes, quorum, recordTrip —
 * is production code. SWS_INJECT_TIME_SCALE compresses the 0/60/180/600s
 * ladder and the 15-min vote window to a few seconds.
 *
 * WHY THIS EXISTS: on 2026-09-30 one "Just a moment..." challenge on CENTRALBK
 * in shard 2 wrote the global flag; shards 1 and 3 were served 6s later. These
 * scenarios pin, at the process level (exit codes + files on disk):
 *
 *   - ladder OFF (default) is still the immediate global panic, exit 4;
 *   - ladder ON replays 09-30 as a non-event: reprime, probe, retry, finish;
 *   - one stuck shard halts ALONE (exit 7) while the run keeps its data;
 *   - two stuck shards with nobody served → quorum → global flag;
 *   - two stuck shards while a third is served → NO flag;
 *   - hard blocks / unclassified 403s stay immediate; Retry-After > 900s
 *     skips the probes; counts persist across restarts with the same run id;
 *     the 4th confirmed incident of a run goes global without quorum.
 *
 * Every scenario has its own temp data dir and they run concurrently.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const SCRAPER = path.join(REPO_ROOT, "scripts/sws-api-scrape.mjs");
// 0.004 → ladder ≈ 2.4–2.9s, vote window 3.6s, flag poll 20ms.
const SCALE = "0.004";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sws-scrape-ladder-"));
let dirSeq = 0;
const ticker = (i) => `T${String(i).padStart(4, "0")}`;
function mkDataDir(n = 6) {
  const d = path.join(tmpRoot, `d${++dirSeq}`);
  fs.mkdirSync(d, { recursive: true });
  const universe = Array.from({ length: n }, (_, i) => ({ ticker: ticker(i), sws_url: `https://simplywall.st/stocks/in/test/nse-${ticker(i).toLowerCase()}/x` }));
  fs.writeFileSync(path.join(d, "universe.json"), JSON.stringify(universe));
  return d;
}
const tickers = (from, to) => Array.from({ length: to - from }, (_, i) => ticker(from + i));
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
const flagOf = (dir) => readJson(path.join(dir, "panic-stop.flag"));
const exists = (dir, name) => fs.existsSync(path.join(dir, name));

// Never let the caller's environment steer a scenario.
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) =>
  !/^SWS_(PANIC_LADDER|PANIC_RUN_ID|INJECT_|RESUME)/.test(k)));

/**
 * Spawn one shard. `onEvent(ev)` sees each JSON log line as it lands. The
 * returned promise carries `.child` so a scenario can stop a long-running shard.
 */
function runShard(dir, shard, { env = {}, list, onEvent } = {}) {
  let child;
  const p = new Promise((resolve) => {
    child = spawn(process.execPath, [SCRAPER, String(shard), "--tickers", list.join(",")], {
      env: { ...baseEnv, SWS_INJECT_DATA_DIR: dir, SWS_INJECT_TIME_SCALE: SCALE, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const events = [];
    let buf = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        try {
          const ev = JSON.parse(line);
          events.push(ev);
          if (onEvent) onEvent(ev);
        } catch { /* non-JSON line */ }
      }
    });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("close", (code, signal) => resolve({ code, signal, events, stderr }));
  });
  p.child = child;
  return p;
}
const count = (r, event) => r.events.filter((e) => e.event === event).length;
const find = (r, event) => r.events.find((e) => e.event === event);

const LADDER = { SWS_PANIC_LADDER: "1" };
const scenarios = [];
const scenario = (name, fn) => scenarios.push({ name, fn });

// ─────────────────────────────────────────────────────────────────────────────

scenario("ladder OFF (default): one challenge is still an immediate global panic", async () => {
  const dir = mkDataDir();
  const r = await runShard(dir, 2, { env: { SWS_INJECT_BLOCK: "1" }, list: tickers(0, 3) });
  const flag = flagOf(dir);
  return [
    ["exit 4", r.code === 4, r.code],
    ["flag written: api:blocked, ticker + cf_class recorded", flag?.reason === "api:blocked" && flag?.ticker === "T0000" && flag?.cf_class === "challenge", flag],
    ["no ladder events, no ladder state files", count(r, "incident_open") === 0 && !exists(dir, "panic-incidents-2.json") && !exists(dir, "panic-vote-2.json"), r.events.map((e) => e.event)],
  ];
});

scenario("ladder ON, 2026-09-30 replay: one challenge → reprime, probe, retry, finish", async () => {
  const dir = mkDataDir();
  const r = await runShard(dir, 2, { env: { ...LADDER, SWS_INJECT_BLOCK: "1" }, list: tickers(0, 3) });
  const prog = readJson(path.join(dir, "progress-api-2.json"));
  const inc = readJson(path.join(dir, "panic-incidents-2.json"));
  return [
    ["exit 0, no flag", r.code === 0 && !exists(dir, "panic-stop.flag"), [r.code, flagOf(dir)]],
    ["all 3 stocks done, the challenged one included", count(r, "stock_done") === 3 && exists(dir, "deep-api/T0000.json"), count(r, "stock_done")],
    ["reprimed, then the 0s probe cleared it", count(r, "ladder_reprime") === 1 && find(r, "ladder_probe")?.result === "ok" && count(r, "incident_cleared") === 1, r.events.filter((e) => e.event.startsWith("ladder"))],
    ["progress carries last_ok_sent_at (atomic write, no temp files left)", Number.isFinite(Date.parse(prog?.last_ok_sent_at)) && fs.readdirSync(dir).every((n) => !n.includes(".tmp.")), prog],
    ["incident counts: opened 1, cleared 1, confirmed 0", inc?.opened === 1 && inc?.cleared === 1 && inc?.confirmed === 0, inc],
  ];
});

scenario("ladder ON, hard block → immediate global, no probe", async () => {
  const dir = mkDataDir();
  const r = await runShard(dir, 1, { env: { ...LADDER, SWS_INJECT_BLOCK: "1", SWS_INJECT_BLOCK_KIND: "hard_block" }, list: tickers(0, 3) });
  return [
    ["exit 4, flag api:hard_block", r.code === 4 && flagOf(dir)?.reason === "api:hard_block", [r.code, flagOf(dir)]],
    ["no ladder probe", count(r, "ladder_probe") === 0, count(r, "ladder_probe")],
  ];
});

scenario("ladder ON, unclassified 403 → immediate global (old behaviour)", async () => {
  const dir = mkDataDir();
  const r = await runShard(dir, 1, { env: { ...LADDER, SWS_INJECT_BLOCK: "1", SWS_INJECT_BLOCK_KIND: "unclassified" }, list: tickers(0, 3) });
  return [["exit 4, flag api:blocked, no probe", r.code === 4 && flagOf(dir)?.reason === "api:blocked" && count(r, "ladder_probe") === 0, [r.code, flagOf(dir)]]];
});

scenario("ladder ON, one shard stuck alone → exit 7, vote, NO flag", async () => {
  const dir = mkDataDir();
  const r = await runShard(dir, 2, { env: { ...LADDER, SWS_INJECT_BLOCK: "999" }, list: tickers(0, 3) });
  const vote = readJson(path.join(dir, "panic-vote-2.json"));
  return [
    ["exit 7 (halts alone)", r.code === 7, r.code],
    ["4 probes, each preceded by a reprime", count(r, "ladder_probe") === 4 && count(r, "ladder_reprime") === 4, [count(r, "ladder_probe"), count(r, "ladder_reprime")]],
    ["no flag", !exists(dir, "panic-stop.flag"), flagOf(dir)],
    ["vote written for T0000", vote?.shard_id === 2 && vote?.ticker === "T0000", vote],
    ["progress cursor NOT advanced past the stuck stock (a retry resumes on it)", (readJson(path.join(dir, "progress-api-2.json"))?.next_local_index ?? 0) === 0, readJson(path.join(dir, "progress-api-2.json"))],
  ];
});

scenario("ladder ON, two shards stuck, nobody served → quorum → global", async () => {
  const dir = mkDataDir(9);
  const env = { ...LADDER, SWS_INJECT_BLOCK: "999", SWS_PANIC_RUN_ID: "run-quorum" };
  const [a, b] = await Promise.all([
    runShard(dir, 1, { env, list: tickers(0, 3) }),
    runShard(dir, 2, { env, list: tickers(3, 6) }),
  ]);
  const flag = flagOf(dir);
  return [
    ["flag written with reason api:quorum", flag?.reason === "api:quorum", flag],
    ["one shard exited 4; the other 0 (saw the flag) or 7 (voted first)", [a.code, b.code].includes(4) && [a.code, b.code].every((c) => [0, 4, 7].includes(c)), [a.code, b.code]],
    ["the flag names both voters", JSON.stringify(flag?.quorum?.voters) === "[1,2]", flag?.quorum],
  ];
});

scenario("ladder ON, two shards stuck while a third is served → NO flag", async () => {
  const dir = mkDataDir(2100);
  const env = { ...LADDER, SWS_PANIC_RUN_ID: "run-breadth" };
  const healthyP = runShard(dir, 3, { env: { ...env, SWS_INJECT_BLOCK: "0" }, list: tickers(100, 2100) });
  const [a, b] = await Promise.all([
    runShard(dir, 1, { env: { ...env, SWS_INJECT_BLOCK: "999" }, list: tickers(0, 3) }),
    runShard(dir, 2, { env: { ...env, SWS_INJECT_BLOCK: "999" }, list: tickers(3, 6) }),
  ]);
  // The healthy shard would scrape 2000 stocks; it has made its point.
  const flagBeforeStop = exists(dir, "panic-stop.flag");
  healthyP.child.kill("SIGTERM");
  const h = await healthyP;
  const evals = [...a.events, ...b.events].filter((e) => e.event === "quorum_eval");
  return [
    ["no flag", !flagBeforeStop, flagOf(dir)],
    ["both stuck shards exit 7", a.code === 7 && b.code === 7, [a.code, b.code]],
    ["shard 3 was still being served when the votes landed", h.code === null && count(h, "stock_done") > 0, [h.code, h.signal, count(h, "stock_done")]],
    ["the second voter saw 2 votes and was vetoed by shard 3's post-vote 2xx",
      evals.some((e) => e.reason === "peer_served_after_first_vote" && e.servedAfter.includes(3)), evals],
  ];
});

scenario("ladder ON, 429 with Retry-After 1200s → confirmed with no probe", async () => {
  const dir = mkDataDir();
  const r = await runShard(dir, 1, { env: { ...LADDER, SWS_INJECT_BLOCK: "999", SWS_INJECT_BLOCK_KIND: "rate_limited", SWS_INJECT_RETRY_AFTER: "1200" }, list: tickers(0, 3) });
  return [
    ["exit 7, zero probes", r.code === 7 && count(r, "ladder_probe") === 0, [r.code, count(r, "ladder_probe")]],
    ["vote reason retry_after_exceeds_ladder", readJson(path.join(dir, "panic-vote-1.json"))?.reason === "retry_after_exceeds_ladder", readJson(path.join(dir, "panic-vote-1.json"))],
  ];
});

scenario("ladder ON, 429 with Retry-After 30s → no reprime, first probe not before 30s", async () => {
  const dir = mkDataDir();
  const r = await runShard(dir, 1, { env: { ...LADDER, SWS_INJECT_BLOCK: "2", SWS_INJECT_BLOCK_KIND: "rate_limited", SWS_INJECT_RETRY_AFTER: "30" }, list: tickers(0, 3) });
  const probes = r.events.filter((e) => e.event === "ladder_probe");
  return [
    ["exit 0, all done, no flag", r.code === 0 && count(r, "stock_done") === 3 && !exists(dir, "panic-stop.flag"), [r.code, count(r, "stock_done")]],
    ["never reprimed (not a challenge)", count(r, "ladder_reprime") === 0, count(r, "ladder_reprime")],
    ["first probe ≥ 30s (scaled), second one served", probes[0]?.elapsed_ms >= 30_000 * Number(SCALE) && probes[1]?.result === "ok", probes],
  ];
});

scenario("same run id: counts persist across restarts; a new run starts fresh", async () => {
  const dir = mkDataDir();
  const env = { ...LADDER, SWS_INJECT_BLOCK: "999" };
  const r1 = await runShard(dir, 1, { env: { ...env, SWS_PANIC_RUN_ID: "run-A" }, list: tickers(0, 3) });
  const r2 = await runShard(dir, 1, { env: { ...env, SWS_PANIC_RUN_ID: "run-A" }, list: tickers(0, 3) });
  const afterA = readJson(path.join(dir, "panic-incidents-1.json"));
  const r3 = await runShard(dir, 1, { env: { ...env, SWS_PANIC_RUN_ID: "run-B" }, list: tickers(0, 3) });
  const afterB = readJson(path.join(dir, "panic-incidents-1.json"));
  return [
    ["restart with the same run id resumes (confirmed 2, opened 2)", r1.code === 7 && r2.code === 7 && find(r2, "incident_state_resumed") && afterA?.confirmed === 2 && afterA?.opened === 2, afterA],
    ["a new run id starts from 0 (confirmed 1)", r3.code === 7 && !find(r3, "incident_state_resumed") && afterB?.confirmed === 1 && afterB?.run_id === "run-B", afterB],
  ];
});

scenario("4th confirmed incident of the run goes global without quorum", async () => {
  const dir = mkDataDir();
  fs.writeFileSync(path.join(dir, "panic-incidents-2.json"), JSON.stringify({ schema: 1, shard_id: 2, run_id: "run-cap", opened: 3, cleared: 0, inconclusive: 0, confirmed: 3 }));
  const r = await runShard(dir, 1, { env: { ...LADDER, SWS_INJECT_BLOCK: "999", SWS_PANIC_RUN_ID: "run-cap" }, list: tickers(0, 3) });
  return [
    ["exit 4, flag api:incident_cap", r.code === 4 && flagOf(dir)?.reason === "api:incident_cap", [r.code, flagOf(dir)]],
    ["no vote needed", !exists(dir, "panic-vote-1.json"), null],
  ];
});

scenario("peer's flag lands mid-ladder → halt within one poll, no vote", async () => {
  const dir = mkDataDir();
  let wroteAt = null;
  const r = await runShard(dir, 1, {
    env: { ...LADDER, SWS_INJECT_BLOCK: "999" },
    list: tickers(0, 3),
    onEvent: (ev) => {
      if (ev.event === "ladder_probe" && ev.k === 1 && wroteAt == null) {
        wroteAt = Date.now();
        fs.writeFileSync(path.join(dir, "panic-stop.flag"), JSON.stringify({ reason: "api:quorum", shard_id: 3, detected_at: new Date().toISOString() }));
      }
    },
  });
  const halt = r.events.find((e) => e.event === "halt");
  return [
    ["halted with panic_mid_ladder, exit 0 (like panic_mid_session)", r.code === 0 && halt?.reason === "panic_mid_ladder", [r.code, halt]],
    ["stopped before the last probes, no vote", count(r, "ladder_probe") === 2 && !exists(dir, "panic-vote-1.json"), count(r, "ladder_probe")],
    ["flag left as the peer wrote it", flagOf(dir)?.shard_id === 3, flagOf(dir)],
  ];
});

scenario("a vote left by a previous attempt is withdrawn at the first served stock", async () => {
  const dir = mkDataDir();
  fs.writeFileSync(path.join(dir, "panic-vote-1.json"), JSON.stringify({ shard_id: 1, run_id: "run-w", at: new Date().toISOString() }));
  const r = await runShard(dir, 1, { env: { ...LADDER, SWS_INJECT_BLOCK: "0", SWS_PANIC_RUN_ID: "run-w" }, list: tickers(0, 3) });
  return [["vote removed, vote_withdrawn logged", r.code === 0 && !exists(dir, "panic-vote-1.json") && count(r, "vote_withdrawn") === 1, [r.code, count(r, "vote_withdrawn")]]];
});

scenario("only ONE stock is refused → control ticker served → that stock fails, the shard carries on", async () => {
  const dir = mkDataDir();
  const r = await runShard(dir, 1, { env: { ...LADDER, SWS_INJECT_BLOCK: "999", SWS_INJECT_BLOCK_MATCH: "nse-t0001/" }, list: tickers(0, 4) });
  const failed = r.events.find((e) => e.event === "stock_failed");
  const control = find(r, "ladder_control_probe");
  return [
    ["exit 0, no flag, no vote", r.code === 0 && !exists(dir, "panic-stop.flag") && !exists(dir, "panic-vote-1.json"), [r.code, flagOf(dir)]],
    ["control probe on the last served ticker (T0000) was served", control?.control === "T0000" && control?.result === "ok", control],
    ["T0001 failed as control_served; T0000, T0002, T0003 done", failed?.ticker === "T0001" && failed?.kind === "control_served" && count(r, "stock_done") === 3, [failed, count(r, "stock_done")]],
    ["counted as skipped, not confirmed", readJson(path.join(dir, "panic-incidents-1.json"))?.skipped === 1 && readJson(path.join(dir, "panic-incidents-1.json"))?.confirmed === 0, readJson(path.join(dir, "panic-incidents-1.json"))],
  ];
});

scenario("Retry-After binds the rc-retry restart: it waits BEFORE booting the browser", async () => {
  const dir = mkDataDir();
  const env = { ...LADDER, SWS_PANIC_RUN_ID: "run-ra", SWS_INJECT_BLOCK_KIND: "rate_limited" };
  const r1 = await runShard(dir, 1, { env: { ...env, SWS_INJECT_BLOCK: "999", SWS_INJECT_RETRY_AFTER: "1000" }, list: tickers(0, 3) });
  const nb = Date.parse(readJson(path.join(dir, "panic-incidents-1.json"))?.not_before ?? "");
  const seen = {};
  const r2 = await runShard(dir, 1, { env: { ...env, SWS_INJECT_BLOCK: "0" }, list: tickers(0, 3), onEvent: (ev) => { seen[ev.event] ??= Date.now(); } });
  return [
    ["1st attempt: 429 Retry-After 1000s → exit 7 with not_before persisted", r1.code === 7 && Number.isFinite(nb), [r1.code, nb]],
    ["restart logs retry_after_wait before client_start", seen.retry_after_wait != null && seen.retry_after_wait <= seen.client_start, seen],
    ["…and boots the browser only once not_before has passed", seen.client_start >= nb, [seen.client_start, nb]],
    ["then scrapes normally", r2.code === 0 && count(r2, "stock_done") === 3, [r2.code, count(r2, "stock_done")]],
  ];
});

scenario("Retry-After too far out → the restart halts alone without sending anything", async () => {
  const dir = mkDataDir();
  const env = { ...LADDER, SWS_PANIC_RUN_ID: "run-ra2", SWS_INJECT_BLOCK_KIND: "rate_limited" };
  const r1 = await runShard(dir, 1, { env: { ...env, SWS_INJECT_BLOCK: "999", SWS_INJECT_RETRY_AFTER: "7200" }, list: tickers(0, 3) });
  const r2 = await runShard(dir, 1, { env: { ...env, SWS_INJECT_BLOCK: "0" }, list: tickers(0, 3) });
  return [["exit 7 with halt retry_after_not_before and no client_start",
    r1.code === 7 && r2.code === 7 && r2.events.some((e) => e.event === "halt" && e.reason === "retry_after_not_before") && count(r2, "client_start") === 0, [r1.code, r2.code, r2.events.map((e) => e.event)]]];
});

scenario("SWS_INJECT_BLOCK without its own data dir refuses to run", async () => {
  // No shard arg: if the guard ever regressed, the usage check would still
  // stop the run before it touched the real data/sws.
  const r = await new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRAPER], { env: { ...baseEnv, SWS_INJECT_BLOCK: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("close", (code) => resolve({ code, stderr }));
  });
  return [["exit 2 with the SWS_INJECT_DATA_DIR refusal (fake payloads never reach data/sws)", r.code === 2 && /requires SWS_INJECT_DATA_DIR/.test(r.stderr), r]];
});

// ─────────────────────────────────────────────────────────────────────────────

let pass = 0;
let fail = 0;
try {
  const results = await Promise.all(scenarios.map(async (s) => {
    try {
      return { s, out: await s.fn() };
    } catch (e) {
      return { s, out: [[`scenario threw: ${e?.stack || e}`, false, null]] };
    }
  }));
  for (const { s, out } of results) {
    console.log(`\n${s.name}\n`);
    for (const [name, cond, got] of out) {
      if (cond) { pass++; console.log("  ✓", name); } else { fail++; console.log("  ✗", name, "→ got", JSON.stringify(got)); }
    }
  }
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
