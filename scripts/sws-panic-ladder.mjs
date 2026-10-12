#!/usr/bin/env node
/**
 * Panic retry ladder + cross-shard quorum — decides WHETHER a 403/429 seen by
 * one shard becomes the global panic-stop flag. sws-panic-policy.mjs decides
 * how long a flag binds once written; this module decides if it is written.
 *
 * Behind SWS_PANIC_LADDER=1. Default off: every 403/429 trips the global flag
 * immediately, exactly as before (decideOnTransportError returns `legacy`).
 *
 * WHY THIS EXISTS
 * ---------------
 * Four trips, 2026-08-20 → 09-30, every one a single Cloudflare "Just a
 * moment..." challenge on ONE ticker in ONE shard while the other shards were
 * served seconds later. None was a real block. The expiry fix bounded how long
 * such a trip binds, but the trip itself still costs that night's whole scrape:
 * every shard halts at its next per-stock check and sws-refresh-api.sh step 5
 * skips parse/score. Confirm over TIME before believing a transient signal,
 * and over BREADTH before escalating local → global:
 *
 *   TIME    A challenge-class 403 opens an incident: reprime the shard's page
 *           (goto /dashboard, wait ≤30s for the title to stop matching
 *           /Just a moment/) and probe the same ticker at 0s, 60s, 180s, 600s
 *           (±20% jitter), checking the global flag every 5s while asleep. Any
 *           served probe clears the incident and the stock is retried.
 *   BREADTH A shard whose ladder is exhausted writes panic-vote-<N>.json. The
 *           global flag is written only on quorum: ≥2 distinct shards with live
 *           votes (≤15 min old) AND no shard got a 2xx for a request SENT after
 *           the first live vote (progress-api-<N>.json `last_ok_sent_at`,
 *           stamped in pageFetch). Without quorum the shard halts alone (exit
 *           7) and sws-refresh-api.sh restarts it with a fresh browser.
 *   ESCAPES Hard blocks ("you have been blocked", Cloudflare error 1020), a
 *           403 that is neither (unclassified — old behaviour), and the
 *           MAX_CONFIRMED_INCIDENTS-th confirmed incident of a run go global
 *           immediately. Retry-After > 900s skips the early probes entirely.
 *
 * A "confirmed" incident is one the ladder could not clear: every probe failed
 * and at least one of them was still blocked, AND a control probe on a
 * different, previously served ticker was blocked too (or there is none) —
 * or Retry-After put the next allowed probe beyond the ladder. Evidence that
 * only THIS stock is refused (control served, or the same ticker challenged
 * again after two cleared ladders) fails just that stock, up to
 * MAX_STOCK_SKIPS per shard per run; past that it confirms. All-network-error
 * ladders are inconclusive — the stock fails as a network error always did.
 * A Retry-After seen in the incident is persisted as `not_before`, which the
 * scraper honours before relaunching its browser on an rc-retry restart.
 * Confirmed counts are keyed on SWS_PANIC_RUN_ID (exported once per
 * sws-refresh-api.sh invocation) and persisted in panic-incidents-<N>.json, so
 * the rc-retry restarts accumulate instead of resetting to 0.
 *
 * Only node: builtins are imported, so bash tests can copy this file into a
 * throwaway fixture on its own.
 *
 * CLI: node scripts/sws-panic-ladder.mjs status    [--data-dir DIR] [--run-id ID]
 *      node scripts/sws-panic-ladder.mjs confirmed --run-id ID [--data-dir DIR]
 *        → Σ confirmed incidents this run, all shards (0 without a run id)
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..");
export const DEFAULT_DATA_DIR = path.join(REPO_ROOT, "data", "sws");

// Probe offsets from the start of an incident. The last one is the ladder's end.
export const LADDER_PROBE_SEC = Object.freeze([0, 60, 180, 600]);
export const LADDER_JITTER = 0.2;
// Retry-After beyond this puts the next allowed probe past the whole ladder.
export const RETRY_AFTER_NO_PROBE_SEC = 900;
export const VOTE_TTL_MS = 15 * 60_000;
export const QUORUM_MIN_SHARDS = 2;
// Quorum must still hold this long after it is first seen. A HEALTHY peer can
// be silent for a whole burst pause (sws-api-scrape.mjs BURST_PAUSE_MAX_MS,
// 180s) plus one stock before its next 2xx lands in progress-api-<N>.json; a
// shorter window let two stuck shards outvote a paused healthy one (7/32 runs
// in review). Pinned against the scraper's constants in the ladder tests.
export const QUORUM_CONFIRM_MS = 240_000;
export const MAX_CONFIRMED_INCIDENTS = 4;
// Two cleared ladders on one ticker, then a third challenge = stock-specific.
export const MAX_LADDERS_PER_STOCK = 2;
// Stocks a shard may fail as "only this stock is refused" per run before such
// evidence stops being believed and confirms instead (bounds the challenged
// requests a path-wide rule could draw).
export const MAX_STOCK_SKIPS = 3;
// A not_before further out than this is not waited for: the shard exits 7
// without sending anything.
export const MAX_NOT_BEFORE_WAIT_MS = 3_600_000;
export const FLAG_POLL_MS = 5_000;
export const REPRIME_MAX_WAIT_MS = 30_000;
export const SHARD_LOCAL_HALT_EXIT = 7;
const FUTURE_SKEW_MS = 5 * 60_000;

const iso = (ms) => new Date(ms).toISOString();

// ────────── Classification ──────────

const HARD_BLOCK_RES = [
  /you have been blocked/i,
  /error(?:\s|&nbsp;)*(?:code)?(?:\s|&nbsp;|:)*1020\b/i,
  /cf-error-code[^>]*>\s*1020\s*</i,
];
// challenge-platform minus /scripts/jsd: Cloudflare's JS-detections script
// sits under that path on ordinary HTML pages, challenge or not.
const CHALLENGE_RES = [/Just a moment/i, /cf-chl/i, /challenge-platform\/(?!scripts\/jsd)/i];
export const CHALLENGE_TITLE_RE = /Just a moment/i;

/**
 * Classify a 403/429 response. Run on the FULL body — the challenge markers
 * (cf-chl, challenge-platform) sit past the 200 chars TransportError keeps.
 *
 * @returns {"hard_block"|"challenge"|"rate_limited"|"unclassified"|null}
 *          null for any other status.
 */
export function classifyBlock({ status, body = "", headers = {} } = {}) {
  if (status === 429) return "rate_limited";
  if (status !== 403) return null;
  const text = typeof body === "string" ? body : JSON.stringify(body ?? "");
  // Hard first: a block page must never be mistaken for a solvable challenge.
  if (HARD_BLOCK_RES.some((re) => re.test(text))) return "hard_block";
  const mitigated = String(lowerKeys(headers)["cf-mitigated"] ?? "").toLowerCase();
  if (mitigated === "challenge") return "challenge";
  if (CHALLENGE_RES.some((re) => re.test(text))) return "challenge";
  return "unclassified";
}

function lowerKeys(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) out[String(k).toLowerCase()] = v;
  return out;
}

/** Retry-After as seconds (delta-seconds or HTTP-date), or null. */
export function parseRetryAfter(value, now = Date.now()) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s);
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.ceil((t - now) / 1000));
}

/**
 * Probe offsets (ms from incident start), jittered ±LADDER_JITTER. No probe is
 * scheduled before Retry-After; offsets it collapses together are dropped, and
 * Retry-After > RETRY_AFTER_NO_PROBE_SEC means no early probe at all ([]).
 * `scale` is a test-only time compression (SWS_INJECT_TIME_SCALE).
 */
export function ladderSchedule({ retryAfterSec = null, rng = Math.random, scale = 1 } = {}) {
  const ra = Number.isFinite(retryAfterSec) ? retryAfterSec : null;
  if (ra != null && ra > RETRY_AFTER_NO_PROBE_SEC) return [];
  const floorMs = ra != null && ra > 0 ? ra * 1000 : 0;
  const out = [];
  for (const sec of LADDER_PROBE_SEC) {
    const jitter = 1 + (rng() * 2 - 1) * LADDER_JITTER;
    const ms = Math.max(Math.round(sec * 1000 * jitter), floorMs);
    if (out.length && ms <= out[out.length - 1]) continue;
    out.push(ms);
  }
  return out.map((ms) => Math.round(ms * scale));
}

// ────────── Decisions (pure) ──────────

/**
 * What to do about one transport error from a stock fetch.
 *
 * @param {object} state
 *   ladderEnabled      SWS_PANIC_LADDER=1
 *   confirmedTotal     confirmed incidents this run, all shards, before this one
 *   laddersForTicker   ladders already cleared on this ticker in this process
 *   stockSkips         stocks this shard already failed as stock-specific this run
 *   maxConfirmed / maxLaddersPerStock / maxStockSkips   overrides (tests)
 *   rng, scale         passed through to ladderSchedule
 * @param {{kind?: string, cfClass?: string, retryAfterSec?: number|null}} err
 * @returns {{action: "global"|"ladder"|"confirm"|"skip_stock"|"halt"|"fail_stock", ...}}
 */
export function decideOnTransportError(state = {}, err = {}) {
  const kind = err?.kind;
  if (kind === "auth_expired") return { action: "halt", exitCode: 5, reason: "auth_expired" };
  if (kind !== "blocked" && kind !== "rate_limited") return { action: "fail_stock" };

  const cls = err.cfClass || (kind === "rate_limited" ? "rate_limited" : "unclassified");
  if (!state.ladderEnabled) return { action: "global", reason: `api:${kind}`, cls, legacy: true };
  if (cls === "hard_block") return { action: "global", reason: "api:hard_block", cls };
  // A 403 that is neither a challenge nor a block page: no evidence it is
  // transient, so keep the old account-safe reaction.
  if (cls === "unclassified") return { action: "global", reason: "api:blocked", cls };

  const max = state.maxConfirmed ?? MAX_CONFIRMED_INCIDENTS;
  if ((state.confirmedTotal ?? 0) >= max) return { action: "global", reason: "api:incident_cap", cls };

  const maxLadders = state.maxLaddersPerStock ?? MAX_LADDERS_PER_STOCK;
  if ((state.laddersForTicker ?? 0) >= maxLadders) {
    // Its probes were served twice, yet the stock keeps failing: only this
    // stock (or one of its endpoints) is refused. Fail it, within a budget.
    return (state.stockSkips ?? 0) < (state.maxStockSkips ?? MAX_STOCK_SKIPS)
      ? { action: "skip_stock", reason: "recurred_after_clear", cls }
      : { action: "confirm", reason: "recurred_after_clear", cls };
  }

  const retryAfterSec = Number.isFinite(err.retryAfterSec) ? err.retryAfterSec : null;
  if (retryAfterSec != null && retryAfterSec > RETRY_AFTER_NO_PROBE_SEC) {
    return { action: "confirm", reason: "retry_after_exceeds_ladder", cls, retryAfterSec };
  }
  return {
    action: "ladder",
    cls,
    reprime: cls === "challenge",
    retryAfterSec,
    schedule: ladderSchedule({ retryAfterSec, rng: state.rng, scale: state.scale ?? 1 }),
  };
}

/** After an incident is confirmed: vote, or — at the per-run cap — go global. */
export function decideOnConfirmed(state = {}) {
  const confirmedTotal = (state.confirmedTotal ?? 0) + 1;
  const max = state.maxConfirmed ?? MAX_CONFIRMED_INCIDENTS;
  return confirmedTotal >= max
    ? { action: "global", reason: "api:incident_cap", confirmedTotal }
    : { action: "vote", confirmedTotal };
}

/** Probe failure → ladder class. Anything that is not a block is inconclusive. */
export function classifyProbeError(err) {
  const kind = err?.kind;
  if (kind === "auth_expired") return "auth_expired";
  if (kind === "rate_limited") return "rate_limited";
  if (kind === "blocked") return err.cfClass || "unclassified";
  return "inconclusive";
}

/**
 * Quorum across shards.
 *
 * @param {object} p
 *   votes  [{shard_id, at, run_id}] from panic-vote-*.json
 *   peers  [{shard_id, last_ok_sent_at}] from progress-api-*.json (every shard,
 *          voters included: a voter served after the first vote is evidence too)
 *   runId  when set, only votes stamped with this run count
 */
export function evaluateQuorum({ votes = [], peers = [], now = Date.now(), runId = null, voteTtlMs = VOTE_TTL_MS, minShards = QUORUM_MIN_SHARDS } = {}) {
  const byShard = new Map();
  for (const v of votes) {
    const at = Date.parse(v?.at ?? "");
    if (!Number.isFinite(at) || at > now + FUTURE_SKEW_MS) continue;
    if (now - at > voteTtlMs) continue;
    if (runId != null && v.run_id !== runId) continue;
    const prev = byShard.get(v.shard_id);
    if (!prev || at > prev.atMs) byShard.set(v.shard_id, { ...v, atMs: at });
  }
  const voters = [...byShard.keys()].sort((a, b) => a - b);
  if (voters.length < minShards) {
    return { met: false, reason: "insufficient_votes", voters, firstVoteAt: null, servedAfter: [] };
  }
  const firstVoteAt = Math.min(...[...byShard.values()].map((v) => v.atMs));
  const servedAfter = peers
    .filter((p) => {
      const t = Date.parse(p?.last_ok_sent_at ?? "");
      return Number.isFinite(t) && t > firstVoteAt;
    })
    .map((p) => p.shard_id)
    .sort((a, b) => a - b);
  if (servedAfter.length) {
    return { met: false, reason: "peer_served_after_first_vote", voters, firstVoteAt: iso(firstVoteAt), servedAfter };
  }
  return { met: true, reason: "quorum", voters, firstVoteAt: iso(firstVoteAt), servedAfter: [] };
}

// ────────── State files (votes, incident counts) ──────────

export function ladderPaths(dataDir, shardId) {
  return {
    vote: path.join(dataDir, `panic-vote-${shardId}.json`),
    incidents: path.join(dataDir, `panic-incidents-${shardId}.json`),
  };
}

/** tmp + rename: a reader on another shard never sees a torn file. */
export function writeJsonAtomic(file, obj) {
  const tmp = `${file}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n");
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    throw e;
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function listMatching(dataDir, re) {
  let names = [];
  try { names = fs.readdirSync(dataDir); } catch { return []; }
  const out = [];
  for (const name of names) {
    const m = name.match(re);
    if (m) out.push({ name, shardId: Number(m[1]) });
  }
  return out;
}

export function readVotes(dataDir = DEFAULT_DATA_DIR) {
  const out = [];
  for (const { name, shardId } of listMatching(dataDir, /^panic-vote-(\d+)\.json$/)) {
    const v = readJson(path.join(dataDir, name));
    if (v && typeof v === "object") out.push({ ...v, shard_id: v.shard_id ?? shardId });
  }
  return out;
}

export function readPeers(dataDir = DEFAULT_DATA_DIR) {
  const out = [];
  for (const { name, shardId } of listMatching(dataDir, /^progress-api-(\d+)\.json$/)) {
    const p = readJson(path.join(dataDir, name));
    out.push({ shard_id: shardId, last_ok_sent_at: p?.last_ok_sent_at ?? null });
  }
  return out;
}

export function writeVote(dataDir, vote) {
  writeJsonAtomic(ladderPaths(dataDir, vote.shard_id).vote, { schema: 1, ...vote });
}

export function hasVote(dataDir, shardId) {
  return fs.existsSync(ladderPaths(dataDir, shardId).vote);
}

export function withdrawVote(dataDir, shardId) {
  try {
    fs.unlinkSync(ladderPaths(dataDir, shardId).vote);
    return true;
  } catch {
    return false;
  }
}

const COUNT_KEYS = ["opened", "cleared", "inconclusive", "skipped", "confirmed"];

/**
 * This shard's incident counts for `runId`. Resumed from disk when the file
 * belongs to the same run (an rc-retry restart); fresh otherwise. With no run
 * id (manual invocation) every process is its own run.
 */
export function loadIncidentState(dataDir, shardId, runId) {
  const fresh = { schema: 1, shard_id: shardId, run_id: runId ?? null, opened: 0, cleared: 0, inconclusive: 0, skipped: 0, confirmed: 0, not_before: null, last: null };
  if (runId == null) return fresh;
  const prev = readJson(ladderPaths(dataDir, shardId).incidents);
  if (!prev || prev.run_id !== runId) return fresh;
  const out = { ...fresh, last: prev.last ?? null, not_before: prev.not_before ?? null, resumed: true };
  for (const k of COUNT_KEYS) out[k] = Number.isFinite(prev[k]) ? prev[k] : 0;
  return out;
}

export function saveIncidentState(dataDir, state, now = Date.now()) {
  const { resumed, ...rest } = state;
  writeJsonAtomic(ladderPaths(dataDir, state.shard_id).incidents, { ...rest, updated_at: iso(now) });
}

/** Confirmed incidents this run across all shards; this shard's from memory. */
export function runConfirmedTotal(dataDir, runId, shardId, ownConfirmed) {
  let total = ownConfirmed;
  if (runId == null) return total;
  for (const { name, shardId: sid } of listMatching(dataDir, /^panic-incidents-(\d+)\.json$/)) {
    if (sid === shardId) continue;
    const s = readJson(path.join(dataDir, name));
    if (s?.run_id === runId && Number.isFinite(s.confirmed)) total += s.confirmed;
  }
  return total;
}

// ────────── Orchestration ──────────

/**
 * Walk the probe schedule. Reprimes before a probe whenever the previous
 * result was a challenge (a fresh cf_clearance needs the page, not just time).
 *
 * deps: now(), sleep(ms), checkFlag(), probe() → {ok, err?}, reprime() →
 *       {challenged, title, error?} (must not throw), log(obj), flagPollMs.
 * @returns {{outcome: "cleared"|"exhausted"|"inconclusive"|"halted"|"global"|"auth_expired", probes, cls?}}
 */
export async function runLadder({ schedule, reprime: reprimeFirst, startedAt, deps, scale = 1 }) {
  const { now, sleep, checkFlag, probe, reprime, log } = deps;
  const pollMs = deps.flagPollMs ?? FLAG_POLL_MS;
  const probes = [];
  let needReprime = Boolean(reprimeFirst);
  // A Retry-After on a probe's response pushes every later probe past it.
  let holdUntil = 0;
  for (let k = 0; k < schedule.length; k++) {
    const target = Math.max(startedAt + schedule[k], holdUntil);
    for (;;) {
      if (checkFlag()) return { outcome: "halted", probes };
      const left = target - now();
      if (left <= 0) break;
      await sleep(Math.min(pollMs, left));
    }
    let reprimeFailed = false;
    if (needReprime) {
      const r = await reprime();
      reprimeFailed = Boolean(r?.error);
      log({ event: "ladder_reprime", k, challenged: Boolean(r?.challenged), title: r?.title ?? null, error: r?.error ?? null, ms: r?.ms ?? null });
    }
    const res = await probe();
    const result = res.ok ? "ok" : classifyProbeError(res.err);
    const entry = { k, result, status: res.err?.status ?? null, elapsed_ms: now() - startedAt };
    if (Number.isFinite(res.err?.retryAfterSec)) {
      entry.retry_after_sec = res.err.retryAfterSec;
      holdUntil = Math.max(holdUntil, now() + res.err.retryAfterSec * 1000 * scale);
    }
    probes.push(entry);
    log({ event: "ladder_probe", ...entry, cf_ray: res.err?.cfRay ?? null });
    if (res.ok) return { outcome: "cleared", probes };
    if (result === "hard_block" || result === "unclassified") return { outcome: "global", probes, cls: result, err: res.err };
    if (result === "auth_expired") return { outcome: "auth_expired", probes };
    // A failed navigation can strand the page off-site (chrome-error://),
    // where every later in-page fetch fails: navigate again before the next.
    needReprime = result === "challenge" || reprimeFailed;
    if (result === "rate_limited" && Number.isFinite(res.err?.retryAfterSec) && res.err.retryAfterSec > RETRY_AFTER_NO_PROBE_SEC) {
      return { outcome: "exhausted", probes, reason: "retry_after_exceeds_ladder" };
    }
  }
  const sawBlock = probes.some((p) => p.result === "challenge" || p.result === "rate_limited");
  return { outcome: sawBlock ? "exhausted" : "inconclusive", probes };
}

/**
 * Handle one blocked/rate_limited error end-to-end (ladder on). Mutates and
 * persists `incident` (loadIncidentState). Writes the global flag only via
 * deps.recordGlobal.
 *
 * deps.probeControl() (optional) → {ok, err?, ticker} | null probes a different,
 * previously served ticker once the ladder is exhausted.
 *
 * @returns {{next: "retry"|"skip"|"halted"|"halt_local"|"global"|"halt", exitCode?: number, reason?: string}}
 *   retry       ladder cleared — fetch the same stock again
 *   skip        fail the stock and move on: inconclusive (probes never reached
 *               SWS), or only this stock is refused (within MAX_STOCK_SKIPS)
 *   halted      the global flag appeared (a peer escalated) — stop
 *   halt_local  confirmed, voted, no quorum — exit SHARD_LOCAL_HALT_EXIT
 *   global      flag written — exit 4
 *   halt        auth expired during the ladder — exit 5
 */
export async function handleBlockIncident({ err, ticker, shardId, runId = null, dataDir, incident, laddersForTicker = 0, scale = 1, rng = Math.random, deps }) {
  const { now, sleep, checkFlag, log, recordGlobal } = deps;
  const save = () => {
    try { saveIncidentState(dataDir, incident, now()); } catch (e) { log({ event: "incident_state_write_failed", shard: shardId, error: String(e?.message || e) }); }
  };
  const errInfo = {
    status: err?.status ?? null,
    cf_class: err?.cfClass ?? null,
    cf_ray: err?.cfRay ?? null,
    cf_mitigated: err?.cfMitigated ?? null,
    retry_after_sec: err?.retryAfterSec ?? null,
  };
  const startedAt = now();
  // Latest moment SWS asked us not to come back before (Retry-After), across
  // the triggering error and every probe. Persisted on confirm.
  let notBeforeMs = null;
  const noteRetryAfter = (sec, atMs) => {
    if (!Number.isFinite(sec) || sec <= 0) return;
    const nb = atMs + sec * 1000 * scale;
    if (notBeforeMs == null || nb > notBeforeMs) notBeforeMs = nb;
  };
  noteRetryAfter(err?.retryAfterSec, startedAt);
  const decision = decideOnTransportError({
    ladderEnabled: true,
    confirmedTotal: runConfirmedTotal(dataDir, runId, shardId, incident.confirmed),
    laddersForTicker,
    stockSkips: incident.skipped ?? 0,
    rng,
    scale,
  }, err);
  log({ event: "incident_open", shard: shardId, ticker, action: decision.action, reason: decision.reason ?? null, schedule_ms: decision.schedule ?? null, ...errInfo });

  const goGlobal = (reason, evidence, extra = {}) => {
    recordGlobal(reason, evidence, { ticker, ...errInfo, incidents: pickCounts(incident), ...extra });
    return { next: "global", exitCode: 4, reason };
  };

  if (decision.action === "halt") return { next: "halt", exitCode: decision.exitCode, reason: decision.reason };
  if (decision.action === "fail_stock") return { next: "skip", reason: "not_a_block" };
  if (decision.action === "global") return goGlobal(decision.reason, `status=${errInfo.status} class=${decision.cls}`);

  incident.opened += 1;
  incident.last = { ticker, cls: decision.cls, at: iso(startedAt), outcome: "open" };
  if (decision.action === "skip_stock") {
    incident.skipped = (incident.skipped ?? 0) + 1;
    incident.last = { ...incident.last, outcome: "skipped", reason: decision.reason };
    save();
    log({ event: "incident_stock_skipped", shard: shardId, ticker, reason: decision.reason, skipped: incident.skipped });
    return { next: "skip", reason: decision.reason };
  }
  save();

  let confirmReason = decision.reason;
  if (decision.action === "ladder") {
    const res = await runLadder({ schedule: decision.schedule, reprime: decision.reprime, startedAt, deps, scale });
    for (const p of res.probes) noteRetryAfter(p.retry_after_sec, startedAt + p.elapsed_ms);
    incident.last = { ...incident.last, outcome: res.outcome, probes: res.probes.length };
    if (res.outcome === "cleared") {
      incident.cleared += 1;
      save();
      log({ event: "incident_cleared", shard: shardId, ticker, probes: res.probes.length, elapsed_ms: now() - startedAt });
      return { next: "retry" };
    }
    if (res.outcome === "halted") { save(); return { next: "halted" }; }
    if (res.outcome === "auth_expired") { save(); return { next: "halt", exitCode: 5, reason: "auth_expired" }; }
    if (res.outcome === "global") {
      save();
      return goGlobal(res.cls === "hard_block" ? "api:hard_block" : "api:blocked", `ladder probe ${res.probes.length}: class=${res.cls}`);
    }
    if (res.outcome === "inconclusive") {
      incident.inconclusive += 1;
      save();
      log({ event: "incident_inconclusive", shard: shardId, ticker, probes: res.probes.length });
      return { next: "skip", reason: "ladder_inconclusive" };
    }
    confirmReason = res.reason || "ladder_exhausted";

    // Breadth inside the shard: is it this stock, or this shard? One probe of
    // a different ticker SWS already served us. Skipped when SWS told us to
    // stay away (Retry-After) — no request is allowed then.
    if (confirmReason === "ladder_exhausted" && deps.probeControl && notBeforeMs == null) {
      if (checkFlag()) { save(); return { next: "halted" }; }
      const c = await deps.probeControl();
      if (c) {
        const cr = c.ok ? "ok" : classifyProbeError(c.err);
        log({ event: "ladder_control_probe", shard: shardId, ticker, control: c.ticker ?? null, result: cr, status: c.err?.status ?? null });
        noteRetryAfter(c.err?.retryAfterSec, now());
        if (cr === "hard_block" || cr === "unclassified") {
          save();
          return goGlobal(cr === "hard_block" ? "api:hard_block" : "api:blocked", `control probe ${c.ticker ?? "?"}: class=${cr}`);
        }
        if (cr === "auth_expired") { save(); return { next: "halt", exitCode: 5, reason: "auth_expired" }; }
        if (cr === "ok") {
          if ((incident.skipped ?? 0) < MAX_STOCK_SKIPS) {
            incident.skipped = (incident.skipped ?? 0) + 1;
            incident.last = { ...incident.last, outcome: "skipped", reason: "control_served" };
            save();
            log({ event: "incident_stock_skipped", shard: shardId, ticker, reason: "control_served", control: c.ticker ?? null, skipped: incident.skipped });
            return { next: "skip", reason: "control_served" };
          }
          confirmReason = "control_served_skip_budget_spent";
        }
      }
    }
  }

  // ── Confirmed: count it (persisted BEFORE any further step, so a crash
  //    between here and the vote still counts toward the per-run cap).
  const totalBefore = runConfirmedTotal(dataDir, runId, shardId, incident.confirmed);
  incident.confirmed += 1;
  incident.last = { ...incident.last, outcome: "confirmed", confirm_reason: confirmReason };
  // Honoured by the scraper before it relaunches the browser (rc-retry).
  if (notBeforeMs != null) incident.not_before = iso(notBeforeMs);
  save();
  const d2 = decideOnConfirmed({ confirmedTotal: totalBefore });
  log({ event: "incident_confirmed", shard: shardId, ticker, reason: confirmReason, confirmed_shard: incident.confirmed, confirmed_run_total: d2.confirmedTotal, action: d2.action });
  if (checkFlag()) return { next: "halted" };
  if (d2.action === "global") {
    return goGlobal("api:incident_cap", `${d2.confirmedTotal} confirmed incidents this run (cap ${MAX_CONFIRMED_INCIDENTS})`, { confirmed_run_total: d2.confirmedTotal });
  }

  const vote = { shard_id: shardId, run_id: runId, at: iso(now()), ticker, reason: confirmReason, cls: decision.cls, incident_started_at: iso(startedAt), confirmed_run_total: d2.confirmedTotal, pid: process.pid };
  writeVote(dataDir, vote);
  log({ event: "panic_vote", shard: shardId, ticker, run_id: runId, reason: confirmReason });

  const evalNow = () => evaluateQuorum({
    votes: readVotes(dataDir),
    peers: readPeers(dataDir),
    now: now(),
    runId,
    voteTtlMs: VOTE_TTL_MS * scale,
  });
  let q = evalNow();
  log({ event: "quorum_eval", shard: shardId, ...q });
  if (q.met) {
    const until = now() + QUORUM_CONFIRM_MS * scale;
    for (;;) {
      if (checkFlag()) return { next: "halted" };
      const left = until - now();
      if (left <= 0) break;
      await sleep(Math.min(deps.flagPollMs ?? FLAG_POLL_MS, left));
    }
    q = evalNow();
    log({ event: "quorum_eval", shard: shardId, confirm: true, ...q });
    if (q.met) {
      return goGlobal("api:quorum", `shards ${q.voters.join(",")} confirmed blocked; no 2xx sent after ${q.firstVoteAt}`, { quorum: q });
    }
  }
  return { next: "halt_local", exitCode: SHARD_LOCAL_HALT_EXIT, reason: q.reason };
}

function pickCounts(s) {
  const out = {};
  for (const k of COUNT_KEYS) out[k] = s?.[k] ?? 0;
  return out;
}

// ────────── Status (mails, logs) ──────────

export function describeLadder({ dataDir = DEFAULT_DATA_DIR, runId = null, now = Date.now() } = {}) {
  const lines = [];
  const incidents = listMatching(dataDir, /^panic-incidents-(\d+)\.json$/)
    .map(({ name }) => readJson(path.join(dataDir, name)))
    .filter((s) => s && (runId == null || s.run_id === runId))
    .sort((a, b) => (a.shard_id ?? 0) - (b.shard_id ?? 0));
  lines.push(`ladder incidents${runId ? ` (run ${runId})` : ""}: ${incidents.length ? "" : "none"}`.trimEnd());
  for (const s of incidents) {
    const last = s.last ? ` — last ${s.last.ticker ?? "?"} ${s.last.cls ?? ""} ${s.last.outcome ?? ""}`.trimEnd() : "";
    lines.push(`  shard ${s.shard_id}: opened ${s.opened ?? 0}, cleared ${s.cleared ?? 0}, inconclusive ${s.inconclusive ?? 0}, skipped ${s.skipped ?? 0}, confirmed ${s.confirmed ?? 0}${s.not_before ? `, not before ${s.not_before}` : ""}${last}`);
  }
  const votes = readVotes(dataDir);
  for (const v of votes) {
    const age = now - Date.parse(v.at ?? "");
    const live = Number.isFinite(age) && age <= VOTE_TTL_MS && (runId == null || v.run_id === runId);
    lines.push(`  vote shard ${v.shard_id}: ${v.at ?? "?"} ${v.ticker ?? ""} ${v.reason ?? ""} (${live ? "live" : "stale"})`);
  }
  const q = evaluateQuorum({ votes, peers: readPeers(dataDir), now, runId });
  lines.push(`quorum: ${q.met ? "MET" : `not met (${q.reason})`}`);
  return lines.join("\n");
}

function cli(argv) {
  const [cmd, ...rest] = argv;
  let dataDir = DEFAULT_DATA_DIR;
  let runId = null;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--data-dir") dataDir = path.resolve(rest[++i]);
    else if (rest[i] === "--run-id") runId = rest[++i] || null;
  }
  if (cmd === "status") {
    console.log(describeLadder({ dataDir, runId }));
    return 0;
  }
  if (cmd === "confirmed") {
    console.log(runId == null ? 0 : runConfirmedTotal(dataDir, runId, null, 0));
    return 0;
  }
  console.error("usage: node scripts/sws-panic-ladder.mjs <status|confirmed> [--data-dir DIR] [--run-id ID]");
  return 2;
}

const isEntrypoint = () => {
  try {
    return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(__filename);
  } catch {
    return false;
  }
};

if (isEntrypoint()) {
  let code;
  try {
    code = cli(process.argv.slice(2));
  } catch (e) {
    console.error(`[panic-ladder] internal error: ${e?.stack || e}`);
    code = 2;
  }
  process.exit(code);
}
