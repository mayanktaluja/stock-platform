/**
 * Tests for scripts/sws-panic-ladder.mjs — the retry ladder + cross-shard
 * quorum that decides whether a 403/429 on one shard becomes the global
 * panic-stop flag (SWS_PANIC_LADDER=1).
 *
 * WHY THIS EXISTS: every panic trip 2026-08-20 → 09-30 was ONE Cloudflare
 * "Just a moment..." challenge on ONE ticker in ONE shard, with the other
 * shards served seconds later. The expiry fix bounded how long such a flag
 * binds; the trip itself still cost that night's entire scrape. These tests pin
 * the confirmation rules that make a trip need evidence over TIME (the ladder)
 * and BREADTH (the quorum), and the escapes that must stay immediate:
 *
 *   1. classifyBlock: the verbatim 09-30 body is a challenge; "you have been
 *      blocked" / 1020 are hard blocks; a plain 403 is unclassified.
 *   2. decideOnTransportError is pure and maps every class to the right action,
 *      with the ladder OFF reproducing the old immediate panic exactly.
 *   3. evaluateQuorum: ≥2 live votes AND no 2xx sent after the first vote.
 *   4. runLadder / handleBlockIncident on a fake clock: probe timing, reprime,
 *      the 5s flag poll, inconclusive vs exhausted, persisted counts, the cap.
 *
 * The real scrape loop is driven end-to-end in test/swsApiScrapeLadder.test.mjs.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  LADDER_PROBE_SEC,
  VOTE_TTL_MS,
  QUORUM_CONFIRM_MS,
  MAX_CONFIRMED_INCIDENTS,
  MAX_STOCK_SKIPS,
  SHARD_LOCAL_HALT_EXIT,
  classifyBlock,
  parseRetryAfter,
  ladderSchedule,
  decideOnTransportError,
  decideOnConfirmed,
  classifyProbeError,
  evaluateQuorum,
  ladderPaths,
  writeJsonAtomic,
  readVotes,
  readPeers,
  writeVote,
  loadIncidentState,
  saveIncidentState,
  runConfirmedTotal,
  runLadder,
  handleBlockIncident,
  describeLadder,
} from "../scripts/sws-panic-ladder.mjs";
import { BURST_PAUSE_MAX_MS, INTER_STOCK_MAX_MS } from "../scripts/sws-api-scrape.mjs";
import { ensureOnSite } from "../scripts/sws-api-client.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const LADDER = path.join(REPO_ROOT, "scripts/sws-panic-ladder.mjs");
const MIN = 60_000;

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

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sws-panic-ladder-"));
let dirSeq = 0;
function freshDir() {
  const d = path.join(tmpRoot, `d${++dirSeq}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// Verbatim head of the 2026-09-30 17:09 IST shard-2 / CENTRALBK trip, as the
// shard log kept it (TransportError keeps 200 chars).
const BODY_0930 = '<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"><meta http-equiv="X-UA-Compatible" content="IE=Edge"><meta nam';

const challengeErr = (extra = {}) => ({ kind: "blocked", status: 403, cfClass: "challenge", ...extra });
const fixedRng = (v) => () => v;

// Virtual clock: sleep() advances time instead of waiting.
function fakeClock(start = Date.parse("2026-09-30T11:39:00Z")) {
  const c = { t: start, sleeps: [] };
  c.now = () => c.t;
  c.sleep = async (ms) => { c.sleeps.push(ms); c.t += ms; if (c.onSleep) c.onSleep(c.t); };
  return c;
}

function ladderDeps(clock, { probes = [], flagAt = Infinity, reprimeResult = { challenged: false, title: "Simply Wall St", ms: 0 }, control } = {}) {
  const calls = { probe: 0, reprime: 0, control: 0, probeAt: [], reprimeAt: [], logs: [], globals: [] };
  const deps = {
    now: clock.now,
    sleep: clock.sleep,
    checkFlag: () => clock.t >= flagAt,
    probe: async () => {
      calls.probeAt.push(clock.t);
      const r = probes[calls.probe++] ?? probes[probes.length - 1];
      return typeof r === "function" ? r() : r;
    },
    reprime: async () => { calls.reprime++; calls.reprimeAt.push(clock.t); return reprimeResult; },
    probeControl: control === undefined ? null : async () => { calls.control++; return control; },
    log: (o) => calls.logs.push({ ...o, _t: clock.t }),
    recordGlobal: (reason, evidence, extra) => calls.globals.push({ reason, evidence, extra }),
    flagPollMs: 5000,
  };
  return { deps, calls };
}
const OK = { ok: true };
const CHALLENGE = { ok: false, err: challengeErr() };
const NETWORK = { ok: false, err: { kind: "transient" } };
const HARD = { ok: false, err: { kind: "blocked", status: 403, cfClass: "hard_block" } };

try {
  // ───────────────────────────────────────────────────────────────────────────
  console.log("\nclassifyBlock\n");

  assert("verbatim 2026-09-30 body head → challenge", classifyBlock({ status: 403, body: BODY_0930 }) === "challenge", classifyBlock({ status: 403, body: BODY_0930 }));
  assert("cf-mitigated: challenge header alone → challenge", classifyBlock({ status: 403, body: "", headers: { "cf-mitigated": "challenge" } }) === "challenge", null);
  assert("header names are case-insensitive", classifyBlock({ status: 403, body: "", headers: { "CF-Mitigated": "Challenge" } }) === "challenge", null);
  assert("challenge-platform script marker → challenge", classifyBlock({ status: 403, body: '<script src="/cdn-cgi/challenge-platform/h/b/orchestrate"></script>' }) === "challenge", null);
  assert("Cloudflare's JS-detections script alone is NOT a challenge (it rides ordinary pages)",
    classifyBlock({ status: 403, body: '<html><body>Forbidden<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script></body></html>' }) === "unclassified", null);
  assert("challenge-platform orchestrate path → challenge", classifyBlock({ status: 403, body: '<script src="/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1"></script>' }) === "challenge", null);
  assert("cf-chl marker → challenge", classifyBlock({ status: 403, body: "window._cf_chl_opt={cvId:'3'}; cf-chl-widget" }) === "challenge", null);
  assert("'Sorry, you have been blocked' → hard_block", classifyBlock({ status: 403, body: "<h1>Sorry, you have been blocked</h1>" }) === "hard_block", null);
  assert("'Error 1020' → hard_block", classifyBlock({ status: 403, body: "<title>Access denied</title> Error 1020" }) === "hard_block", null);
  assert("'error code: 1020' → hard_block", classifyBlock({ status: 403, body: "error code: 1020" }) === "hard_block", null);
  assert("cf-error-code span 1020 → hard_block", classifyBlock({ status: 403, body: '<span class="cf-error-type">Error</span> <span class="cf-error-code">1020</span>' }) === "hard_block", null);
  assert("hard block wins over challenge markers on the same page", classifyBlock({ status: 403, body: "Just a moment... you have been blocked", headers: { "cf-mitigated": "challenge" } }) === "hard_block", null);
  assert("a 1020 that is not an error code is not a hard block", classifyBlock({ status: 403, body: '{"companyId":1020}' }) === "unclassified", null);
  assert("JSON 403 → unclassified", classifyBlock({ status: 403, body: '{"error":"forbidden"}' }) === "unclassified", null);
  assert("429 → rate_limited", classifyBlock({ status: 429, body: "" }) === "rate_limited", null);
  assert("200 / 503 → null", classifyBlock({ status: 200 }) === null && classifyBlock({ status: 503 }) === null, null);

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\nparseRetryAfter + ladderSchedule\n");

  const now0 = Date.parse("2026-10-09T00:00:00Z");
  assert("delta-seconds", parseRetryAfter("120", now0) === 120, parseRetryAfter("120", now0));
  assert("HTTP-date 10 min ahead → 600", parseRetryAfter(new Date(now0 + 10 * MIN).toUTCString(), now0) === 600, parseRetryAfter(new Date(now0 + 10 * MIN).toUTCString(), now0));
  assert("past HTTP-date → 0", parseRetryAfter(new Date(now0 - MIN).toUTCString(), now0) === 0, null);
  assert("garbage / empty / null → null", parseRetryAfter("soon", now0) === null && parseRetryAfter("", now0) === null && parseRetryAfter(null) === null, null);

  assert("probes at 0s, 60s, 180s, 600s", JSON.stringify(LADDER_PROBE_SEC) === "[0,60,180,600]", LADDER_PROBE_SEC);
  assert("no jitter (rng 0.5) → exact ladder", JSON.stringify(ladderSchedule({ rng: fixedRng(0.5) })) === "[0,60000,180000,600000]", ladderSchedule({ rng: fixedRng(0.5) }));
  assert("rng 0 → −20%", JSON.stringify(ladderSchedule({ rng: fixedRng(0) })) === "[0,48000,144000,480000]", ladderSchedule({ rng: fixedRng(0) }));
  let jitterOk = true;
  for (let n = 0; n < 2000; n++) {
    const s = ladderSchedule();
    const inBand = s.length === 4 && s[0] === 0 && s.every((ms, i) => i === 0 || (ms >= LADDER_PROBE_SEC[i] * 800 && ms <= LADDER_PROBE_SEC[i] * 1200));
    const increasing = s.every((ms, i) => i === 0 || ms > s[i - 1]);
    if (!inBand || !increasing) { jitterOk = false; break; }
  }
  assert("2000 random schedules: 4 probes, first at 0, each within ±20%, increasing", jitterOk, null);
  assert("Retry-After 120 → nothing before 120s, collapsed probes dropped", JSON.stringify(ladderSchedule({ retryAfterSec: 120, rng: fixedRng(0.5) })) === "[120000,180000,600000]", ladderSchedule({ retryAfterSec: 120, rng: fixedRng(0.5) }));
  assert("Retry-After 900 (boundary) → one probe at 900s", JSON.stringify(ladderSchedule({ retryAfterSec: 900, rng: fixedRng(0.5) })) === "[900000]", ladderSchedule({ retryAfterSec: 900, rng: fixedRng(0.5) }));
  assert("Retry-After 901 → no early probe at all", ladderSchedule({ retryAfterSec: 901 }).length === 0, ladderSchedule({ retryAfterSec: 901 }));
  assert("scale compresses (test hook)", JSON.stringify(ladderSchedule({ rng: fixedRng(0.5), scale: 0.001 })) === "[0,60,180,600]", ladderSchedule({ rng: fixedRng(0.5), scale: 0.001 }));

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\ndecideOnTransportError (pure)\n");

  const on = { ladderEnabled: true, confirmedTotal: 0, laddersForTicker: 0, rng: fixedRng(0.5) };
  const d = (state, err) => decideOnTransportError(state, err);

  let r = d({ ladderEnabled: false }, challengeErr());
  assert("ladder OFF: challenge → global api:blocked (unchanged legacy panic)", r.action === "global" && r.reason === "api:blocked" && r.legacy === true, r);
  r = d({ ladderEnabled: false }, { kind: "rate_limited", status: 429 });
  assert("ladder OFF: 429 → global api:rate_limited", r.action === "global" && r.reason === "api:rate_limited", r);
  r = d({}, challengeErr());
  assert("ladderEnabled missing = OFF (default off)", r.action === "global" && r.legacy === true, r);

  r = d(on, challengeErr());
  assert("challenge → ladder with reprime, 4 probes", r.action === "ladder" && r.reprime === true && r.schedule.length === 4, r);
  r = d(on, { kind: "rate_limited", status: 429, cfClass: "rate_limited", retryAfterSec: 30 });
  assert("429 → ladder, no reprime, first probe at Retry-After", r.action === "ladder" && r.reprime === false && r.schedule[0] === 30000, r);
  r = d(on, { kind: "blocked", status: 403, cfClass: "hard_block" });
  assert("hard block → global immediately", r.action === "global" && r.reason === "api:hard_block", r);
  r = d(on, { kind: "blocked", status: 403, cfClass: "unclassified" });
  assert("unclassified 403 → global (old account-safe reaction)", r.action === "global" && r.reason === "api:blocked", r);
  r = d(on, { kind: "blocked", status: 403 });
  assert("blocked without cfClass (pre-ladder error shape) → unclassified → global", r.action === "global" && r.cls === "unclassified", r);
  r = d({ ...on, confirmedTotal: MAX_CONFIRMED_INCIDENTS }, challengeErr());
  assert(`run already at ${MAX_CONFIRMED_INCIDENTS} confirmed → global api:incident_cap`, r.action === "global" && r.reason === "api:incident_cap", r);
  r = d({ ...on, laddersForTicker: 1 }, challengeErr());
  assert("2nd challenge on one ticker after a clear → another ladder", r.action === "ladder", r);
  r = d({ ...on, laddersForTicker: 2 }, challengeErr());
  assert("3rd challenge on one ticker after two clears → fail just that stock, no 3rd ladder", r.action === "skip_stock" && r.reason === "recurred_after_clear", r);
  r = d({ ...on, laddersForTicker: 2, stockSkips: MAX_STOCK_SKIPS }, challengeErr());
  assert(`…but once ${MAX_STOCK_SKIPS} stocks were skipped this run it confirms instead`, r.action === "confirm" && r.reason === "recurred_after_clear", r);
  r = d(on, { kind: "rate_limited", status: 429, cfClass: "rate_limited", retryAfterSec: 1200 });
  assert("Retry-After 1200s → confirmed with no probe", r.action === "confirm" && r.reason === "retry_after_exceeds_ladder", r);
  assert("auth_expired → halt exit 5", d(on, { kind: "auth_expired" }).exitCode === 5, null);
  assert("transient / graphql_error / unknown → fail_stock (not an incident)",
    ["transient", "graphql_error", "unknown"].every((kind) => d(on, { kind }).action === "fail_stock"), null);

  const stateIn = { ...on };
  const errIn = challengeErr({ retryAfterSec: 30 });
  const snapshot = JSON.stringify([stateIn.confirmedTotal, stateIn.laddersForTicker, errIn]);
  const a1 = d(stateIn, errIn);
  const a2 = d(stateIn, errIn);
  assert("pure: same input → same decision, inputs untouched", JSON.stringify(a1) === JSON.stringify(a2) && JSON.stringify([stateIn.confirmedTotal, stateIn.laddersForTicker, errIn]) === snapshot, [a1, a2]);

  assert("decideOnConfirmed: 0 before → vote (1)", JSON.stringify(decideOnConfirmed({ confirmedTotal: 0 })) === JSON.stringify({ action: "vote", confirmedTotal: 1 }), null);
  assert("decideOnConfirmed: 2 before → vote (3)", decideOnConfirmed({ confirmedTotal: 2 }).action === "vote", null);
  assert("decideOnConfirmed: 3 before → 4th goes global", decideOnConfirmed({ confirmedTotal: 3 }).action === "global", null);
  assert("classifyProbeError: network is inconclusive, challenge stays challenge",
    classifyProbeError({ kind: "transient" }) === "inconclusive" && classifyProbeError(challengeErr()) === "challenge" && classifyProbeError({ kind: "rate_limited" }) === "rate_limited", null);

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\nevaluateQuorum\n");

  const T = Date.parse("2026-09-30T11:50:00Z");
  const vote = (shard_id, agoMs, run_id = "R") => ({ shard_id, at: new Date(T - agoMs).toISOString(), run_id });
  const peer = (shard_id, agoMs) => ({ shard_id, last_ok_sent_at: agoMs == null ? null : new Date(T - agoMs).toISOString() });
  const q = (votes, peers, extra = {}) => evaluateQuorum({ votes, peers, now: T, runId: "R", ...extra });

  r = q([vote(2, MIN)], [peer(1, 20 * MIN), peer(2, 12 * MIN), peer(3, 20 * MIN)]);
  assert("one vote → no quorum (the 09-30 shape: one shard alone)", !r.met && r.reason === "insufficient_votes", r);
  r = q([vote(2, 5 * MIN), vote(3, MIN)], [peer(1, 16 * MIN), peer(2, 16 * MIN), peer(3, 12 * MIN)]);
  assert("two live votes, nobody served after the first → quorum", r.met && JSON.stringify(r.voters) === "[2,3]", r);
  assert("…firstVoteAt is the earlier vote", r.firstVoteAt === new Date(T - 5 * MIN).toISOString(), r.firstVoteAt);
  r = q([vote(2, VOTE_TTL_MS + 1000), vote(3, MIN)], [peer(1, 30 * MIN)]);
  assert("a vote older than 15 min is not live", !r.met && r.reason === "insufficient_votes", r);
  r = q([vote(2, 5 * MIN), vote(3, MIN)], [peer(1, 3 * MIN), peer(2, 16 * MIN), peer(3, 12 * MIN)]);
  assert("peer 2xx SENT after the first vote → no quorum", !r.met && r.reason === "peer_served_after_first_vote" && JSON.stringify(r.servedAfter) === "[1]", r);
  r = q([vote(2, 5 * MIN), vote(3, MIN)], [peer(1, 5 * MIN)]);
  assert("2xx sent exactly at the first vote is not 'after'", r.met, r);
  r = q([vote(2, 5 * MIN), vote(3, MIN)], [peer(3, 4 * MIN)]);
  assert("a voter's own 2xx after the first vote also blocks quorum", !r.met && JSON.stringify(r.servedAfter) === "[3]", r);
  r = q([vote(2, 5 * MIN), vote(3, MIN, "OTHER")], []);
  assert("a vote from another run does not count", !r.met, r);
  r = evaluateQuorum({ votes: [vote(2, 5 * MIN, null), vote(3, MIN, "x")], peers: [], now: T, runId: null });
  assert("no run id (manual shards): any live vote counts", r.met, r);
  r = q([vote(2, -10 * MIN), vote(3, MIN)], []);
  assert("a vote stamped >5 min in the future is distrusted", !r.met, r);
  r = q([vote(2, 5 * MIN), vote(2, MIN)], []);
  assert("two votes from one shard = one shard", !r.met && r.voters.length === 1, r);
  r = q([vote(1, MIN), vote(2, MIN), vote(3, MIN)], [peer(1, null), peer(2, null)]);
  assert("peers with no last_ok_sent_at are no evidence either way", r.met, r);

  // ───────────────────────────────────────────────────────────────────────────
  assert("confirm window outlasts a healthy shard's longest silence (burst pause + one inter-stock gap + 30s)",
    QUORUM_CONFIRM_MS >= BURST_PAUSE_MAX_MS + INTER_STOCK_MAX_MS + 30_000, [QUORUM_CONFIRM_MS, BURST_PAUSE_MAX_MS, INTER_STOCK_MAX_MS]);

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\nstate files\n");

  {
    const dir = freshDir();
    writeJsonAtomic(path.join(dir, "progress-api-1.json"), { shard_id: 1, last_ok_sent_at: "2026-09-30T11:39:06.000Z" });
    fs.writeFileSync(path.join(dir, "progress-api-2.json"), "{ torn");
    const peers = readPeers(dir).sort((x, y) => x.shard_id - y.shard_id);
    assert("readPeers: last_ok_sent_at read; a torn file is 'no evidence', not a crash",
      peers.length === 2 && peers[0].last_ok_sent_at === "2026-09-30T11:39:06.000Z" && peers[1].last_ok_sent_at === null, peers);
    assert("writeJsonAtomic leaves no temp files", fs.readdirSync(dir).every((n) => !n.includes(".tmp.")), fs.readdirSync(dir));

    writeVote(dir, { shard_id: 2, run_id: "R", at: new Date().toISOString() });
    assert("writeVote → panic-vote-2.json, readVotes sees it", fs.existsSync(ladderPaths(dir, 2).vote) && readVotes(dir)[0].shard_id === 2, readVotes(dir));

    const s1 = loadIncidentState(dir, 1, "R");
    s1.opened = 3; s1.confirmed = 2;
    saveIncidentState(dir, s1);
    const resumed = loadIncidentState(dir, 1, "R");
    assert("same run id → counts resume (rc-retry restart)", resumed.resumed === true && resumed.opened === 3 && resumed.confirmed === 2, resumed);
    assert("…and 'resumed' itself is not persisted", !("resumed" in JSON.parse(fs.readFileSync(ladderPaths(dir, 1).incidents, "utf8"))), null);
    const other = loadIncidentState(dir, 1, "R2");
    assert("different run id → fresh counts", other.confirmed === 0 && !other.resumed, other);
    const manual = loadIncidentState(dir, 1, null);
    assert("no run id → fresh counts (each manual process is its own run)", manual.confirmed === 0, manual);

    saveIncidentState(dir, { ...loadIncidentState(dir, 2, "R"), confirmed: 1 });
    saveIncidentState(dir, { ...loadIncidentState(dir, 3, "OLD"), confirmed: 5 });
    assert("runConfirmedTotal: own (memory) + same-run peers, other runs ignored", runConfirmedTotal(dir, "R", 1, 2) === 3, runConfirmedTotal(dir, "R", 1, 2));
    assert("runConfirmedTotal: own on-disk file ignored in favour of memory", runConfirmedTotal(dir, "R", 1, 0) === 1, runConfirmedTotal(dir, "R", 1, 0));
    assert("runConfirmedTotal: no run id → own only", runConfirmedTotal(dir, null, 1, 2) === 2, null);
    assert("describeLadder renders without throwing", /ladder incidents/.test(describeLadder({ dataDir: dir, runId: "R" })), null);
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\nrunLadder (fake clock)\n");

  const sched = [0, 60_000, 180_000, 600_000];
  {
    const c = fakeClock();
    const t0 = c.t;
    const { deps, calls } = ladderDeps(c, { probes: [CHALLENGE, CHALLENGE, OK] });
    r = await runLadder({ schedule: sched, reprime: true, startedAt: t0, deps });
    assert("cleared on the 3rd probe", r.outcome === "cleared" && r.probes.length === 3, r);
    assert("probes fired at 0s, 60s, 180s", JSON.stringify(calls.probeAt.map((t) => t - t0)) === "[0,60000,180000]", calls.probeAt.map((t) => t - t0));
    assert("reprimed before each probe that followed a challenge (and the first)", calls.reprime === 3, calls.reprime);
    assert("never slept longer than the 5s flag poll", c.sleeps.every((ms) => ms <= 5000), Math.max(...c.sleeps));
  }
  {
    const c = fakeClock();
    const { deps, calls } = ladderDeps(c, { probes: [CHALLENGE] });
    r = await runLadder({ schedule: sched, reprime: true, startedAt: c.t, deps });
    assert("4 challenges → exhausted", r.outcome === "exhausted" && r.probes.length === 4 && calls.probe === 4, r);
  }
  {
    const c = fakeClock();
    const { deps, calls } = ladderDeps(c, { probes: [{ ok: false, err: { kind: "rate_limited", status: 429 } }] });
    r = await runLadder({ schedule: sched, reprime: false, startedAt: c.t, deps });
    assert("429 ladder: exhausted, never reprimed", r.outcome === "exhausted" && calls.reprime === 0, [r.outcome, calls.reprime]);
  }
  {
    const c = fakeClock();
    const { deps } = ladderDeps(c, { probes: [NETWORK] });
    r = await runLadder({ schedule: sched, reprime: true, startedAt: c.t, deps });
    assert("every probe a network error → inconclusive (not a confirmed block)", r.outcome === "inconclusive", r);
  }
  {
    const c = fakeClock();
    const { deps } = ladderDeps(c, { probes: [CHALLENGE, NETWORK, NETWORK, NETWORK] });
    r = await runLadder({ schedule: sched, reprime: true, startedAt: c.t, deps });
    assert("challenge then network errors → exhausted (a block was still seen)", r.outcome === "exhausted", r);
  }
  {
    const c = fakeClock();
    const { deps } = ladderDeps(c, { probes: [CHALLENGE, HARD] });
    r = await runLadder({ schedule: sched, reprime: true, startedAt: c.t, deps });
    assert("hard block mid-ladder → global at once", r.outcome === "global" && r.cls === "hard_block" && r.probes.length === 2, r);
  }
  {
    const c = fakeClock();
    const { deps } = ladderDeps(c, { probes: [{ ok: false, err: { kind: "rate_limited", status: 429, retryAfterSec: 3600 } }] });
    r = await runLadder({ schedule: sched, reprime: false, startedAt: c.t, deps });
    assert("429 with Retry-After 3600 mid-ladder → exhausted without the later probes", r.outcome === "exhausted" && r.probes.length === 1, r);
  }
  {
    const c = fakeClock();
    const t0 = c.t;
    const RL120 = { ok: false, err: { kind: "rate_limited", status: 429, retryAfterSec: 120 } };
    const { deps, calls } = ladderDeps(c, { probes: [RL120, OK] });
    r = await runLadder({ schedule: sched, reprime: false, startedAt: t0, deps });
    assert("a probe's Retry-After 120 pushes the 60s probe out to ≥120s", r.outcome === "cleared" && calls.probeAt[1] - t0 >= 120_000, calls.probeAt.map((t) => t - t0));
  }
  {
    const c = fakeClock();
    const { deps, calls } = ladderDeps(c, { probes: [NETWORK], reprimeResult: { challenged: null, title: null, error: "net::ERR_NAME_NOT_RESOLVED" } });
    r = await runLadder({ schedule: sched, reprime: true, startedAt: c.t, deps });
    assert("a failed reprime is retried before every later probe (page may be stranded off-site)", calls.reprime === 4 && r.outcome === "inconclusive", [calls.reprime, r.outcome]);
  }
  {
    const c = fakeClock();
    const t0 = c.t;
    const { deps, calls } = ladderDeps(c, { probes: [CHALLENGE], flagAt: t0 + 70_000 });
    r = await runLadder({ schedule: sched, reprime: true, startedAt: t0, deps });
    assert("peer flag at +70s while waiting for the 180s probe → halted", r.outcome === "halted" && calls.probe === 2, [r.outcome, calls.probe]);
    assert("…noticed within one 5s poll", c.t - (t0 + 70_000) <= 5000, c.t - t0);
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\nhandleBlockIncident (fake clock, real state files)\n");

  const incidentRun = async ({ dir, shardId = 2, runId = "R", probes, err = challengeErr(), laddersForTicker = 0, clock = fakeClock(), flagAt, onSleep, control }) => {
    const { deps, calls } = ladderDeps(clock, { probes, flagAt, control });
    if (onSleep) clock.onSleep = onSleep;
    const incident = loadIncidentState(dir, shardId, runId);
    const res = await handleBlockIncident({ err, ticker: "CENTRALBK", shardId, runId, dataDir: dir, incident, laddersForTicker, rng: fixedRng(0.5), deps });
    return { res, calls, incident, clock };
  };
  {
    const dir = freshDir();
    const { res, calls, incident } = await incidentRun({ dir, probes: [OK] });
    assert("09-30 replay: probe at 0s served → retry the stock, no flag", res.next === "retry" && calls.globals.length === 0, res);
    assert("…counted opened 1 / cleared 1 / confirmed 0, persisted", incident.opened === 1 && incident.cleared === 1 && incident.confirmed === 0
      && JSON.parse(fs.readFileSync(ladderPaths(dir, 2).incidents, "utf8")).cleared === 1, incident);
    assert("…no vote written", !fs.existsSync(ladderPaths(dir, 2).vote), null);
  }
  {
    const dir = freshDir();
    const { res, calls, incident } = await incidentRun({ dir, probes: [CHALLENGE] });
    assert("exhausted, no other votes → halt this shard alone (exit 7), no flag", res.next === "halt_local" && res.exitCode === SHARD_LOCAL_HALT_EXIT && calls.globals.length === 0, res);
    assert("…vote written with run id, confirmed 1", readVotes(dir)[0]?.run_id === "R" && incident.confirmed === 1, readVotes(dir));
  }
  {
    const dir = freshDir();
    const clock = fakeClock();
    writeVote(dir, { shard_id: 3, run_id: "R", at: new Date(clock.t + 9 * MIN).toISOString() });
    writeJsonAtomic(path.join(dir, "progress-api-1.json"), { last_ok_sent_at: new Date(clock.t - MIN).toISOString() });
    const { res, calls } = await incidentRun({ dir, probes: [CHALLENGE], clock });
    assert("a 2nd shard's live vote, no 2xx after it → global api:quorum", res.next === "global" && calls.globals[0]?.reason === "api:quorum", [res, calls.globals]);
    const qEvals = calls.logs.filter((l) => l.event === "quorum_eval");
    assert(`…only after quorum held through the ${QUORUM_CONFIRM_MS / 1000}s confirm window`, qEvals.length === 2 && qEvals[1].confirm === true
      && qEvals[1]._t - qEvals[0]._t >= QUORUM_CONFIRM_MS, qEvals.map((e) => e._t - qEvals[0]._t));
    assert("…the flag evidence names the voters", /shards 2,3/.test(calls.globals[0]?.evidence ?? ""), calls.globals[0]?.evidence);
  }
  {
    const dir = freshDir();
    const clock = fakeClock();
    writeVote(dir, { shard_id: 3, run_id: "R", at: new Date(clock.t + 9 * MIN).toISOString() });
    let peerServed = false;
    const ladderEnd = clock.t + 10 * MIN;
    const onSleep = (t) => {
      // Shard 1 is healthy: during the confirm window it finishes a stock it
      // had requested after the votes, and persists that at end-of-stock.
      if (!peerServed && t > ladderEnd + 1000) {
        peerServed = true;
        writeJsonAtomic(path.join(dir, "progress-api-1.json"), { last_ok_sent_at: new Date(t - 500).toISOString() });
      }
    };
    const { res, calls } = await incidentRun({ dir, probes: [CHALLENGE], clock, onSleep });
    assert("quorum seen, then a peer's post-vote 2xx lands in the confirm window → no flag, halt alone",
      res.next === "halt_local" && res.reason === "peer_served_after_first_vote" && calls.globals.length === 0, [res, calls.globals]);
  }
  {
    const dir = freshDir();
    saveIncidentState(dir, { ...loadIncidentState(dir, 1, "R"), confirmed: 3 });
    const { res, calls } = await incidentRun({ dir, probes: [CHALLENGE] });
    assert(`${MAX_CONFIRMED_INCIDENTS}th confirmed incident of the run → global api:incident_cap, no quorum needed`,
      res.next === "global" && calls.globals[0]?.reason === "api:incident_cap", [res, calls.globals]);
    assert("…without writing a vote", !fs.existsSync(ladderPaths(dir, 2).vote), null);
  }
  {
    const dir = freshDir();
    const { res, calls } = await incidentRun({ dir, probes: [OK], err: { kind: "blocked", status: 403, cfClass: "hard_block" } });
    assert("hard block → global with no probe", res.next === "global" && calls.probe === 0 && calls.globals[0]?.reason === "api:hard_block", [res, calls.probe]);
  }
  {
    const dir = freshDir();
    const { res, calls } = await incidentRun({ dir, probes: [OK], err: { kind: "rate_limited", status: 429, cfClass: "rate_limited", retryAfterSec: 1800 } });
    assert("429 Retry-After 1800 → confirmed + voted with no probe", res.next === "halt_local" && calls.probe === 0 && readVotes(dir)[0]?.reason === "retry_after_exceeds_ladder", [res, calls.probe]);
  }
  {
    const dir = freshDir();
    const { res, incident } = await incidentRun({ dir, probes: [NETWORK] });
    assert("all-network ladder → skip the stock, inconclusive counted, nothing confirmed", res.next === "skip" && incident.inconclusive === 1 && incident.confirmed === 0, [res, incident]);
  }
  {
    const dir = freshDir();
    const clock = fakeClock();
    const { res, calls } = await incidentRun({ dir, probes: [CHALLENGE], clock, flagAt: clock.t + 30_000 });
    assert("peer's flag appears mid-ladder → halted, no vote, no second flag", res.next === "halted" && calls.globals.length === 0 && !fs.existsSync(ladderPaths(dir, 2).vote), res);
  }
  {
    const dir = freshDir();
    const { res, calls, incident } = await incidentRun({ dir, probes: [OK], laddersForTicker: 2 });
    assert("challenge recurring after two cleared ladders → fail that stock only (no ladder, no vote)",
      res.next === "skip" && res.reason === "recurred_after_clear" && calls.probe === 0 && incident.skipped === 1 && incident.confirmed === 0 && readVotes(dir).length === 0, [res, incident]);
  }
  {
    const dir = freshDir();
    saveIncidentState(dir, { ...loadIncidentState(dir, 2, "R"), skipped: MAX_STOCK_SKIPS });
    const { res } = await incidentRun({ dir, probes: [OK], laddersForTicker: 2 });
    assert(`…with the run's ${MAX_STOCK_SKIPS}-stock skip budget spent → confirmed + voted`, res.next === "halt_local" && readVotes(dir)[0]?.reason === "recurred_after_clear", res);
  }

  console.log("\ncontrol probe (is it this stock, or this shard?)\n");
  {
    const dir = freshDir();
    const { res, calls, incident } = await incidentRun({ dir, probes: [CHALLENGE], control: { ok: true, ticker: "CEMPRO" } });
    assert("exhausted, but a previously served ticker is served → fail just this stock, no vote, no flag",
      res.next === "skip" && res.reason === "control_served" && calls.control === 1 && incident.skipped === 1 && incident.confirmed === 0
      && readVotes(dir).length === 0 && calls.globals.length === 0, [res, incident]);
  }
  {
    const dir = freshDir();
    const { res, calls, incident } = await incidentRun({ dir, probes: [CHALLENGE], control: { ok: false, err: challengeErr(), ticker: "CEMPRO" } });
    assert("control challenged too → confirmed, voted", res.next === "halt_local" && calls.control === 1 && incident.confirmed === 1 && readVotes(dir).length === 1, [res, incident]);
  }
  {
    const dir = freshDir();
    saveIncidentState(dir, { ...loadIncidentState(dir, 2, "R"), skipped: MAX_STOCK_SKIPS });
    const { res } = await incidentRun({ dir, probes: [CHALLENGE], control: { ok: true, ticker: "CEMPRO" } });
    assert("control served but the skip budget is spent → confirmed", res.next === "halt_local" && readVotes(dir)[0]?.reason === "control_served_skip_budget_spent", [res, readVotes(dir)]);
  }
  {
    const dir = freshDir();
    const { res, calls } = await incidentRun({ dir, probes: [CHALLENGE], control: { ok: false, err: { kind: "blocked", status: 403, cfClass: "hard_block" }, ticker: "CEMPRO" } });
    assert("control hits a hard block → global", res.next === "global" && calls.globals[0]?.reason === "api:hard_block", [res, calls.globals]);
  }
  {
    const dir = freshDir();
    const { res, calls } = await incidentRun({ dir, probes: [CHALLENGE], control: null });
    assert("no control ticker available (first stock of the shard) → confirmed", res.next === "halt_local" && calls.control === 1, [res, calls.control]);
  }

  console.log("\nRetry-After carried across restarts (not_before)\n");
  {
    const dir = freshDir();
    const clock = fakeClock();
    const t0 = clock.t;
    const { res, incident } = await incidentRun({ dir, probes: [OK], clock, err: { kind: "rate_limited", status: 429, cfClass: "rate_limited", retryAfterSec: 1800 } });
    const saved = JSON.parse(fs.readFileSync(ladderPaths(dir, 2).incidents, "utf8"));
    assert("429 Retry-After 1800 → not_before = trip + 1800s, persisted for the restart",
      res.next === "halt_local" && incident.not_before === new Date(t0 + 1800_000).toISOString() && saved.not_before === incident.not_before, saved.not_before);
    assert("…and loadIncidentState hands it back on the same run", loadIncidentState(dir, 2, "R").not_before === incident.not_before, null);
  }
  {
    const dir = freshDir();
    const RL = (sec) => ({ ok: false, err: { kind: "rate_limited", status: 429, cfClass: "rate_limited", retryAfterSec: sec } });
    const { res, calls, incident } = await incidentRun({ dir, probes: [RL(60), RL(60), RL(60), RL(300)], err: { kind: "rate_limited", status: 429, cfClass: "rate_limited" }, control: { ok: true, ticker: "X" } });
    assert("Retry-After seen on a probe → no control probe (no request allowed), not_before = last probe + 300s",
      res.next === "halt_local" && calls.control === 0 && Date.parse(incident.not_before) >= calls.probeAt[3] + 300_000, [res, incident.not_before, calls.control]);
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\nensureOnSite (page stranded by a failed reprime)\n");
  {
    const fakeClient = (url) => {
      const page = { gotos: 0, url: () => url, goto: async () => { page.gotos++; }, title: async () => "Simply Wall St" };
      return { page };
    };
    const on = fakeClient("https://simplywall.st/dashboard");
    const r1 = await ensureOnSite(on);
    assert("on-site → no navigation (no request)", r1.ok && on.page.gotos === 0, r1);
    const off = fakeClient("chrome-error://chromewebdata/");
    const r2 = await ensureOnSite(off, { maxWaitMs: 0 });
    assert("chrome-error:// → navigates back to /dashboard", !r2.ok && off.page.gotos === 1 && r2.reprime?.challenged === false, r2);
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\nmodule hygiene\n");

  const src = fs.readFileSync(LADDER, "utf8");
  const imports = [...src.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
  assert("ladder module imports only node: builtins (bash tests copy it alone)", imports.every((m) => m.startsWith("node:")), imports);
  assert("ladder module never writes the panic flag itself (only via recordGlobal → recordTrip)", !/panic-stop\.flag/.test(src.replace(/^ \*.*$/gm, "")), null);
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
