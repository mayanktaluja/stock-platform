#!/usr/bin/env node
/**
 * Panic-stop flag policy — the ONE place that decides how long a panic flag
 * binds, shared by every writer (India + US API scrapers, the legacy DOM
 * driver's `record-panic`) and every run-start gate (sws-nightly.sh step 0,
 * sws-refresh-api.sh step 1, sws-refresh-us.sh, sws-refresh.sh).
 *
 * WHY THIS EXISTS
 * ---------------
 * Until this module, `data/sws/panic-stop.flag` had no expiry. One 403 on one
 * ticker in one shard wrote it, it is gitignored, and the isolated wrapper
 * resets with `git clean -fd` (no -x) — so it survived every nightly reset and
 * refused every run until a human deleted it by hand. That turned four
 * transient one-shard Cloudflare challenges into ~19 lost nights:
 *
 *   2026-08-20  shard 2, "Just a moment..."      → 1 night
 *   2026-09-09  shard 3                           → 6 nights
 *   2026-09-19  shard 3 (peer served +2.4s after) → 1 night
 *   2026-09-30  shard 2 (peers served +6s after)  → 9 nights (10-01 … 10-09)
 *
 * None was a real block: the next full run after every manual clear scraped
 * with 0 shard failures. Earlier fixes (#1525) only made the refusal visible.
 *
 * POLICY
 * ------
 * The trip itself is unchanged and deliberately hair-trigger: any 403/429 still
 * halts every shard of the CURRENT run immediately. That is the account-safe
 * reaction to a signal we cannot yet tell apart from a real block. What changes
 * is how long the halt outlives the run:
 *
 *   - Every flag carries `expires_at`. TTL escalates with the number of
 *     CONSECUTIVE trips since the last clean scrape (TTL_LADDER_HOURS):
 *       1st → 6h   (a trip before 18:30 IST clears before the next 00:30 slot)
 *       2nd → 30h  (skips at most one slot)
 *       3rd → 78h  (skips ~three slots)
 *       4th → no expiry: four separate nights each hit a block with no clean
 *             scrape in between. That is a real block; a human must clear it.
 *   - Only a clean scrape resets the streak: a run with no panic in which SWS
 *     actually SERVED at least CLEAN_MIN_FRACTION of the universe (measured on
 *     progress-api-*.json done_count, not on shard exit codes — a scraper
 *     exits 0 even when every stock failed on 5xx/network). Expiry alone does
 *     NOT reset it — so a permanent block is
 *     re-probed at most 4 times, ever, before it waits for a human. (A 7-day
 *     look-back window would never reach the cap: the trips that justified a
 *     long TTL age out while it is running, and the block is re-probed every
 *     few days forever.)
 *   - A legacy flag (no `expires_at`, written before this module) binds for
 *     LEGACY_TTL_HOURS from its `detected_at` (or mtime). The 2026-09-30 flag
 *     would have expired at 23:09 IST the same day instead of costing 9 nights.
 *   - Run-start gates ARCHIVE an expired flag (rename into panic-archive/, never
 *     delete) and append to panic-history.ndjson. Mid-run readers keep the old
 *     "file exists == halted" check: because a run only starts when no flag
 *     exists, any flag seen mid-run was written by this run.
 *
 * All state lives next to the flag (gitignored), so it survives the same
 * `git clean -fd` that the flag does — that is what lets the streak escalate.
 *
 * CLI (all accept --data-dir <dir>, default <repo>/data/sws):
 *   gate          evaluate; archive if expired. Prints key=value lines, then
 *                 `---`, then a human summary. Exit 0 clear/auto_cleared,
 *                 1 active, 2 internal error.
 *   status        human summary only (exit 0)
 *   record-trip   REASON SHARD_ID EVIDENCE... (writes the flag; exit 0)
 *   served-count  Σ done_count over progress-api-*.json (snapshot before shards)
 *   record-clean  --served-since N [--note TEXT] — records clean_run only if
 *                 the run served ≥ CLEAN_MIN_FRACTION of universe.json; without
 *                 --served-since it records unconditionally (tests / manual)
 *   clear         --reason TEXT — manual override: archive the flag now
 *
 * Only node: builtins are imported, so bash tests can copy this file into a
 * throwaway fixture on its own.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOUR_MS = 3_600_000;

// Consecutive-trip TTLs in hours; a trip past the end of the ladder needs a human.
export const TTL_LADDER_HOURS = [6, 30, 78];
export const LEGACY_TTL_HOURS = 6;
// Upper bound on any explicit expires_at, so a units bug (s vs ms) or a hand
// edit cannot recreate the permanent outage this module exists to prevent.
export const MAX_TTL_HOURS = 174;
// A detected_at further in the future than this is distrusted (clock skew,
// hand edit) and the file mtime is used instead.
const FUTURE_SKEW_MS = 5 * 60_000;
const HISTORY_KEEP_LINES = 500;
// Share of the universe a run must actually fetch to count as "SWS served us".
export const CLEAN_MIN_FRACTION = Number(process.env.SWS_PANIC_CLEAN_MIN_FRACTION || 0.5);

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..");
export const DEFAULT_DATA_DIR = path.join(REPO_ROOT, "data", "sws");

export function panicPaths(dataDir = DEFAULT_DATA_DIR) {
  return {
    flag: path.join(dataDir, "panic-stop.flag"),
    history: path.join(dataDir, "panic-history.ndjson"),
    archiveDir: path.join(dataDir, "panic-archive"),
  };
}

const iso = (ms) => new Date(ms).toISOString();

// "2026-09-30 17:09:00 IST" — the operator reads every mail in IST, and doing
// this in node keeps BSD-vs-GNU `date` out of the bash gates entirely.
export function formatIst(ms) {
  if (!Number.isFinite(ms)) return "unknown";
  try {
    const s = new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Asia/Kolkata",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hourCycle: "h23",
    }).format(new Date(ms));
    return `${s} IST`;
  } catch {
    // small-icu Node builds lack Asia/Kolkata; IST has no DST, so shift by hand.
    return `${new Date(ms + 5.5 * HOUR_MS).toISOString().slice(0, 19).replace("T", " ")} IST`;
  }
}

function formatDuration(ms) {
  const mins = Math.max(0, Math.round(ms / 60_000));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// ────────── History ──────────

export function readHistory(dataDir = DEFAULT_DATA_DIR) {
  let raw;
  try {
    raw = fs.readFileSync(panicPaths(dataDir).history, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e && typeof e === "object" && typeof e.event === "string") out.push(e);
    } catch { /* a torn line must not take the gate down with it */ }
  }
  return out;
}

// Append-only: shards append concurrently (O_APPEND keeps small lines whole).
function appendHistory(dataDir, entry) {
  const { history } = panicPaths(dataDir);
  fs.mkdirSync(path.dirname(history), { recursive: true });
  fs.appendFileSync(history, JSON.stringify(entry) + "\n");
}

// Bounded history (~1 clean_run line a night). Rewriting the file could drop
// a line a shard appends mid-rewrite, so this runs ONLY from gate(), i.e. at
// run start, before any shard exists.
function trimHistory(dataDir) {
  const { history } = panicPaths(dataDir);
  try {
    const lines = fs.readFileSync(history, "utf8").split("\n").filter((l) => l.trim());
    if (lines.length > HISTORY_KEEP_LINES * 2) {
      const tmp = `${history}.tmp.${process.pid}`;
      fs.writeFileSync(tmp, lines.slice(-HISTORY_KEEP_LINES).join("\n") + "\n");
      fs.renameSync(tmp, history);
    }
  } catch { /* housekeeping, never fatal */ }
}

/** Trips since the most recent clean scrape. Expiry and manual clears do not reset it. */
export function consecutiveTrips(history) {
  let n = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const e = history[i];
    if (e.event === "clean_run") break;
    if (e.event === "trip") n++;
  }
  return n;
}

/**
 * TTL for the n-th consecutive trip (1-based), or null when the streak is past
 * the ladder and the flag must wait for a human.
 */
export function ttlHoursForTrip(n) {
  if (!Number.isInteger(n) || n < 1) return TTL_LADDER_HOURS[0];
  return n <= TTL_LADDER_HOURS.length ? TTL_LADDER_HOURS[n - 1] : null;
}

// ────────── Write side ──────────

/**
 * Record a panic trip. Called by every writer in place of a raw writeFileSync.
 *
 * The flag is created EXCLUSIVELY (write a temp file, then link(2), which fails
 * with EEXIST if a flag already exists). When two shards trip in the same run,
 * the first one owns the flag and its TTL; the second is logged as `trip_extra`
 * and never escalates the streak — one incident must not count as two.
 *
 * This must never lose a panic: any failure in the bookkeeping falls back to a
 * plain write of the flag, which the gates still treat as binding.
 *
 * @returns {{created: boolean, flag: object}}
 */
export function recordTrip({ dataDir = DEFAULT_DATA_DIR, reason, shardId = null, evidence = "", extra = {}, now = Date.now() } = {}) {
  const { flag: flagPath, archiveDir } = panicPaths(dataDir);
  let trip = 1;
  try {
    trip = consecutiveTrips(readHistory(dataDir)) + 1;
  } catch { /* unreadable history → treat as a first trip */ }
  const ttlHours = ttlHoursForTrip(trip);
  const flag = {
    schema: 2,
    reason: String(reason || "unknown"),
    shard_id: shardId,
    evidence: typeof evidence === "string" ? evidence : JSON.stringify(evidence),
    ...extra,
    detected_at: iso(now),
    trip,
    ttl_hours: ttlHours,
    expires_at: ttlHours == null ? null : iso(now + ttlHours * HOUR_MS),
    requires_manual_clear: ttlHours == null,
  };
  const body = JSON.stringify(flag, null, 2);

  let created = false;
  try {
    fs.mkdirSync(archiveDir, { recursive: true });
    const tmp = path.join(archiveDir, `.tmp-flag-${process.pid}-${now}-${Math.random().toString(36).slice(2)}`);
    fs.writeFileSync(tmp, body);
    try {
      fs.linkSync(tmp, flagPath);
      created = true;
    } catch (e) {
      if (e?.code !== "EEXIST") throw e;
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    }
  } catch {
    // Filesystem without link(2), permissions, anything: the halt must still land.
    if (!fs.existsSync(flagPath)) {
      fs.mkdirSync(path.dirname(flagPath), { recursive: true });
      fs.writeFileSync(flagPath, body);
      created = true;
    }
  }

  try {
    appendHistory(dataDir, created
      ? { event: "trip", at: flag.detected_at, reason: flag.reason, shard_id: shardId, evidence: flag.evidence, trip, ttl_hours: ttlHours, expires_at: flag.expires_at }
      : { event: "trip_extra", at: flag.detected_at, reason: flag.reason, shard_id: shardId, evidence: flag.evidence });
  } catch { /* history is evidence, not the halt itself */ }

  return { created, flag };
}

/** Unconditionally record a clean scrape (resets the escalation streak). */
export function recordClean({ dataDir = DEFAULT_DATA_DIR, note = "", now = Date.now(), extra = {} } = {}) {
  appendHistory(dataDir, { event: "clean_run", at: iso(now), ...(note ? { note } : {}), ...extra });
}

/**
 * Σ done_count across progress-api-*.json. done_count only moves on a
 * successful stock fetch, so (after − before) is what SWS actually served this
 * run. A torn/unreadable progress file counts 0 — under-counting is the safe
 * direction (no streak reset), over-counting is not.
 */
export function servedCount(dataDir = DEFAULT_DATA_DIR) {
  let total = 0;
  let names = [];
  try { names = fs.readdirSync(dataDir); } catch { return 0; }
  for (const name of names) {
    if (!/^progress-api-\d+\.json$/.test(name)) continue;
    try {
      const n = Number(JSON.parse(fs.readFileSync(path.join(dataDir, name), "utf8"))?.done_count);
      if (Number.isFinite(n) && n > 0) total += n;
    } catch { /* torn mid-write → 0 */ }
  }
  return total;
}

export function universeSize(dataDir = DEFAULT_DATA_DIR) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, "universe.json"), "utf8"));
    const arr = Array.isArray(raw) ? raw : raw?.stocks || raw?.universe || [];
    return Array.isArray(arr) ? arr.length : 0;
  } catch {
    return 0;
  }
}

/**
 * Record clean_run only when this run demonstrably got served: no panic flag,
 * and served ≥ CLEAN_MIN_FRACTION × universe. Exit codes are not evidence —
 * a shard exits 0 after a night of 503s, and one that died on auth_expired
 * can sit beside two that served thousands of stocks.
 */
export function recordCleanIfServed({ dataDir = DEFAULT_DATA_DIR, servedSince, note = "", now = Date.now(), minFraction = CLEAN_MIN_FRACTION } = {}) {
  const served = Math.max(0, servedCount(dataDir) - (Number(servedSince) || 0));
  const expected = universeSize(dataDir);
  const flagged = evaluateFlag({ dataDir, now }).state !== "absent";
  const recorded = !flagged && expected > 0 && served >= minFraction * expected;
  if (recorded) recordClean({ dataDir, note, now, extra: { served, expected } });
  return { recorded, served, expected, flagged };
}

// ────────── Read side ──────────

/**
 * Decide whether the flag still binds. Pure apart from reading the flag.
 *
 * @returns {{state: "absent"|"active"|"expired", manual?: boolean, expiresAtMs?: number|null,
 *            detectedAtMs?: number|null, source?: string, flag?: object|null, raw?: string|null}}
 */
export function evaluateFlag({ dataDir = DEFAULT_DATA_DIR, now = Date.now() } = {}) {
  const { flag: flagPath } = panicPaths(dataDir);
  let raw = null;
  let mtimeMs = NaN;
  try {
    raw = fs.readFileSync(flagPath, "utf8");
    mtimeMs = fs.statSync(flagPath).mtimeMs;
  } catch (e) {
    if (e?.code === "ENOENT") return { state: "absent" };
    // Exists but unreadable: fail closed, with no expiry we could honour.
    return { state: "active", manual: false, expiresAtMs: null, detectedAtMs: null, source: "unreadable", flag: null, raw };
  }

  let flag = null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") flag = parsed;
  } catch { /* unparseable → bounded by mtime below */ }

  let detectedAtMs = Date.parse(flag?.detected_at ?? flag?.at ?? "");
  if (!Number.isFinite(detectedAtMs) || detectedAtMs > now + FUTURE_SKEW_MS) detectedAtMs = mtimeMs;

  if (flag?.requires_manual_clear === true) {
    return { state: "active", manual: true, expiresAtMs: null, detectedAtMs, source: "manual", flag, raw };
  }

  let expiresAtMs;
  let source;
  const explicit = Date.parse(flag?.expires_at ?? "");
  if (Number.isFinite(explicit)) {
    const cap = Number.isFinite(detectedAtMs) ? detectedAtMs + MAX_TTL_HOURS * HOUR_MS : explicit;
    expiresAtMs = Math.min(explicit, cap);
    source = "flag";
  } else {
    expiresAtMs = detectedAtMs + LEGACY_TTL_HOURS * HOUR_MS;
    source = flag ? "legacy" : "unparseable";
  }
  if (!Number.isFinite(expiresAtMs)) {
    return { state: "active", manual: false, expiresAtMs: null, detectedAtMs, source: "unknown", flag, raw };
  }
  return { state: now >= expiresAtMs ? "expired" : "active", manual: false, expiresAtMs, detectedAtMs, source, flag, raw };
}

function stamp(ms) {
  return Number.isFinite(ms) ? iso(ms).replace(/[:.]/g, "-") : "unknown";
}

/**
 * Move the flag into panic-archive/ (never delete — it is the only evidence of
 * what tripped) and log why. Tolerates a peer having archived it first.
 */
export function archiveFlag({ dataDir = DEFAULT_DATA_DIR, event, reason = "", now = Date.now() } = {}) {
  const { flag: flagPath, archiveDir } = panicPaths(dataDir);
  const ev = evaluateFlag({ dataDir, now });
  if (ev.state === "absent") return { archived: false, gone: true };
  // Re-check at the moment of the rename: a fresh trip may have replaced the
  // expired flag since the caller evaluated it, and must not be archived.
  if (event === "expired" && ev.state !== "expired") return { archived: false, gone: false, evaluation: ev };
  fs.mkdirSync(archiveDir, { recursive: true });
  const dest = path.join(archiveDir, `panic-stop.${stamp(ev.detectedAtMs)}.${event}-${stamp(now)}.json`);
  try {
    fs.renameSync(flagPath, dest);
  } catch (e) {
    if (e?.code === "ENOENT") return { archived: false, gone: true };
    throw e;
  }
  appendHistory(dataDir, {
    event,
    at: iso(now),
    ...(reason ? { reason } : {}),
    flag_reason: ev.flag?.reason ?? null,
    shard_id: ev.flag?.shard_id ?? null,
    detected_at: Number.isFinite(ev.detectedAtMs) ? iso(ev.detectedAtMs) : null,
    expires_at: Number.isFinite(ev.expiresAtMs) ? iso(ev.expiresAtMs) : null,
    source: ev.source,
    archived_to: path.basename(dest),
  });
  return { archived: true, dest, evaluation: ev };
}

/**
 * Run-start gate. Archives an expired flag and reports a clear run; reports an
 * active flag with how long until it lapses. Only run-start gates may call this.
 */
export function gate({ dataDir = DEFAULT_DATA_DIR, now = Date.now() } = {}) {
  const ev = evaluateFlag({ dataDir, now });
  if (ev.state === "absent") return { verdict: "clear", evaluation: ev };
  trimHistory(dataDir);
  let active = ev;
  if (ev.state === "expired") {
    const res = archiveFlag({ dataDir, event: "expired", now });
    if (res.archived || res.gone) return { verdict: "auto_cleared", evaluation: ev, archivedTo: res.dest ?? null };
    active = res.evaluation; // replaced by a fresh, still-binding trip
  }
  const waitSec = Number.isFinite(active.expiresAtMs) ? Math.max(0, Math.ceil((active.expiresAtMs - now) / 1000)) : null;
  return { verdict: "active", evaluation: active, waitSec };
}

// ────────── Human summary (mail bodies, status) ──────────

export function describe({ dataDir = DEFAULT_DATA_DIR, now = Date.now(), evaluation = null } = {}) {
  const ev = evaluation ?? evaluateFlag({ dataDir, now });
  const history = readHistory(dataDir);
  const streak = consecutiveTrips(history);
  const lastClean = [...history].reverse().find((e) => e.event === "clean_run");
  const lines = [];

  if (ev.state === "absent") {
    lines.push("panic flag: none");
  } else {
    const f = ev.flag || {};
    lines.push(`panic flag: ${ev.state.toUpperCase()}${ev.manual ? " — HUMAN NEEDED (no automatic expiry)" : ""}`);
    lines.push(`detected:   ${formatIst(ev.detectedAtMs)} (shard ${f.shard_id ?? "?"}, ${f.reason ?? "unknown reason"}${f.evidence ? `, ${f.evidence}` : ""})`);
    if (ev.manual) {
      lines.push(`expires:    never — ${f.trip ?? "4+"} consecutive trips with no clean scrape in between`);
    } else if (Number.isFinite(ev.expiresAtMs)) {
      const rel = ev.expiresAtMs > now ? `in ${formatDuration(ev.expiresAtMs - now)}` : `${formatDuration(now - ev.expiresAtMs)} ago`;
      lines.push(`expires:    ${formatIst(ev.expiresAtMs)} (${rel}; ${ev.source === "flag" ? `TTL ${f.ttl_hours ?? "?"}h` : `${ev.source} flag, ${LEGACY_TTL_HOURS}h default`})`);
    } else {
      lines.push("expires:    unknown (flag unreadable) — treated as binding");
    }
  }
  lines.push(`streak:     ${streak} trip(s) since the last clean scrape${lastClean ? ` (${formatIst(Date.parse(lastClean.at))})` : ""}`);
  const nextTtl = ttlHoursForTrip(streak + 1);
  lines.push(`next trip:  ${nextTtl == null ? "no expiry — would need a human" : `binds for ${nextTtl}h`}`);

  const tail = history.slice(-6);
  if (tail.length) {
    lines.push("recent history:");
    for (const e of tail) {
      const bits = [e.event];
      if (e.shard_id != null) bits.push(`shard=${e.shard_id}`);
      if (e.reason) bits.push(e.reason);
      if (e.flag_reason) bits.push(e.flag_reason);
      if (e.ttl_hours !== undefined) bits.push(`ttl=${e.ttl_hours == null ? "manual" : `${e.ttl_hours}h`}`);
      lines.push(`  ${formatIst(Date.parse(e.at))}  ${bits.join(" ")}`);
    }
  }
  if (ev.state !== "absent") {
    if (ev.state === "active") {
      lines.push("");
      lines.push("Override (only after checking SWS in a browser):");
      lines.push(`  node scripts/sws-panic-policy.mjs clear --data-dir ${path.relative(process.cwd(), dataDir) || "."} --reason "<why>"`);
    }
    if (ev.raw != null) {
      lines.push("");
      lines.push("raw flag:");
      lines.push(String(ev.raw).split("\n").slice(0, 30).join("\n"));
    }
  }
  return lines.join("\n");
}

// ────────── CLI ──────────

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--data-dir") opts.dataDir = argv[++i];
    else if (a === "--reason") opts.reason = argv[++i];
    else if (a === "--note") opts.note = argv[++i];
    else if (a === "--served-since") opts.servedSince = argv[++i];
    else opts._.push(a);
  }
  return opts;
}

function cli(argv) {
  const [cmd, ...rest] = argv;
  const opts = parseArgs(rest);
  const dataDir = opts.dataDir ? path.resolve(opts.dataDir) : DEFAULT_DATA_DIR;
  const now = Date.now();

  switch (cmd) {
    case "gate": {
      const g = gate({ dataDir, now });
      const ev = g.evaluation;
      const kv = {
        verdict: g.verdict,
        manual: ev.manual ? 1 : 0,
        expires_at: Number.isFinite(ev.expiresAtMs) ? iso(ev.expiresAtMs) : "",
        expires_at_ist: Number.isFinite(ev.expiresAtMs) ? formatIst(ev.expiresAtMs) : "",
        wait_sec: g.waitSec ?? "",
        source: ev.source ?? "",
        archived_to: g.archivedTo ? path.basename(g.archivedTo) : "",
      };
      for (const [k, v] of Object.entries(kv)) console.log(`${k}=${v}`);
      console.log("---");
      console.log(describe({ dataDir, now, evaluation: g.verdict === "auto_cleared" ? ev : undefined }));
      return g.verdict === "active" ? 1 : 0;
    }
    case "status":
      console.log(describe({ dataDir, now }));
      return 0;
    case "record-trip": {
      const [reason, sid, ...ev] = opts._;
      const n = Number(sid);
      const r = recordTrip({ dataDir, reason, shardId: Number.isFinite(n) ? n : null, evidence: ev.join(" "), now });
      console.log(JSON.stringify({ created: r.created, expires_at: r.flag.expires_at, trip: r.flag.trip }));
      return 0;
    }
    case "served-count":
      console.log(servedCount(dataDir));
      return 0;
    case "record-clean": {
      if (opts.servedSince === undefined) {
        recordClean({ dataDir, note: opts.note || "", now });
        console.log("clean_run recorded (unconditional)");
        return 0;
      }
      const r = recordCleanIfServed({ dataDir, servedSince: opts.servedSince, note: opts.note || "", now });
      console.log(r.recorded
        ? `clean_run recorded — served ${r.served}/${r.expected}`
        : `clean_run NOT recorded — served ${r.served}/${r.expected}${r.flagged ? ", panic flag present" : ""} (needs ≥${Math.round(CLEAN_MIN_FRACTION * 100)}%)`);
      return 0;
    }
    case "clear": {
      if (!opts.reason) {
        console.error("clear requires --reason \"<why>\" — it is recorded in panic-history.ndjson");
        return 2;
      }
      const r = archiveFlag({ dataDir, event: "manual_clear", reason: opts.reason, now });
      console.log(r.archived ? `cleared → panic-archive/${path.basename(r.dest)}` : "no panic flag present");
      return 0;
    }
    default:
      console.error("usage: node scripts/sws-panic-policy.mjs <gate|status|record-trip|served-count|record-clean|clear> [--data-dir DIR] [--served-since N] [--reason TEXT] [--note TEXT]");
      return 2;
  }
}

// realpath on both sides: the nightly runs this through a symlinked worktree
// path, and a plain href comparison would silently skip the CLI there.
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
    console.error(`[panic-policy] internal error: ${e?.stack || e}`);
    code = 2;
  }
  process.exit(code);
}
