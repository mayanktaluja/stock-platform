/**
 * Tests for scripts/sws-panic-policy.mjs — the expiry + escalation policy for
 * data/sws/panic-stop.flag.
 *
 * WHY THIS EXISTS: the flag had no expiry. A single transient Cloudflare 403 on
 * one shard on 2026-09-30 refused every nightly from 10-01 to 10-09 (the fifth
 * recurrence; ~19 nights lost since 2026-08-20) until a human renamed the file.
 * These tests replay that exact flag and pin the three properties that matter:
 *
 *   1. A transient trip cannot outlive the next nightly slot by more than hours.
 *   2. A REAL block still backs off — 6h → 30h → 78h → human — and is re-probed
 *      at most 4 times in total, ever, without a clean scrape in between.
 *   3. The state survives the isolated wrapper's `git clean -fd`, or (2) is void.
 *
 * Every time is injected via `now`; nothing here sleeps or reads the wall clock
 * for its verdicts.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  TTL_LADDER_HOURS,
  LEGACY_TTL_HOURS,
  MAX_TTL_HOURS,
  ttlHoursForTrip,
  consecutiveTrips,
  readHistory,
  recordTrip,
  recordClean,
  recordCleanIfServed,
  servedCount,
  universeSize,
  evaluateFlag,
  archiveFlag,
  gate,
  formatIst,
  panicPaths,
} from "../scripts/sws-panic-policy.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const POLICY = path.join(REPO_ROOT, "scripts/sws-panic-policy.mjs");
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

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sws-panic-policy-"));
let dirSeq = 0;
function freshDir() {
  const d = path.join(tmpRoot, `d${++dirSeq}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
const writeFlag = (dir, content) => fs.writeFileSync(panicPaths(dir).flag, typeof content === "string" ? content : JSON.stringify(content, null, 2));
const flagExists = (dir) => fs.existsSync(panicPaths(dir).flag);

try {
  // ───────────────────────────────────────────────────────────────────────────
  console.log("\nescalation ladder\n");

  assert("ladder is 6h → 30h → 78h", JSON.stringify(TTL_LADDER_HOURS) === "[6,30,78]", TTL_LADDER_HOURS);
  assert("trip 1 binds 6h", ttlHoursForTrip(1) === 6, ttlHoursForTrip(1));
  assert("trip 2 binds 30h", ttlHoursForTrip(2) === 30, ttlHoursForTrip(2));
  assert("trip 3 binds 78h", ttlHoursForTrip(3) === 78, ttlHoursForTrip(3));
  assert("trip 4 needs a human (null)", ttlHoursForTrip(4) === null, ttlHoursForTrip(4));
  assert("trip 9 still needs a human", ttlHoursForTrip(9) === null, ttlHoursForTrip(9));

  const hist = [
    { event: "trip" }, { event: "clean_run" },
    { event: "trip" }, { event: "expired" }, { event: "trip_extra" },
    { event: "trip" }, { event: "manual_clear" }, { event: "trip" },
  ];
  assert(
    "streak counts trips since the last clean_run; expiry, manual clear and trip_extra never reset or add",
    consecutiveTrips(hist) === 3,
    consecutiveTrips(hist),
  );
  assert("empty history → streak 0", consecutiveTrips([]) === 0, consecutiveTrips([]));

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\nreplay: the verbatim 2026-09-30 flag that refused 9 nights\n");
  {
    const d = freshDir();
    // Byte-for-byte what sws-api-scrape.mjs wrote on 2026-09-30 (pre-policy writer).
    writeFlag(d, '{\n  "reason": "api:blocked",\n  "shard_id": 2,\n  "evidence": "status=403",\n  "detected_at": "2026-09-30T11:39:00.621Z"\n}');
    const detected = Date.parse("2026-09-30T11:39:00.621Z");

    const atTrip = evaluateFlag({ dataDir: d, now: detected + 60_000 });
    assert("legacy flag is active right after the trip", atTrip.state === "active", atTrip.state);
    assert("legacy flag binds exactly LEGACY_TTL_HOURS from detected_at",
      atTrip.expiresAtMs === detected + LEGACY_TTL_HOURS * H, atTrip.expiresAtMs);
    assert("…which is 23:09 IST the same evening", formatIst(atTrip.expiresAtMs) === "2026-09-30 23:09:00 IST", formatIst(atTrip.expiresAtMs));

    // The first 00:30 IST slot after the trip: 2026-10-01 00:30 IST = 2026-09-30T19:00Z.
    const firstSlot = Date.parse("2026-09-30T19:00:00Z");
    const g = gate({ dataDir: d, now: firstSlot });
    assert("the 10-01 00:30 slot auto-clears it (0 refused nights, was 9)", g.verdict === "auto_cleared", g.verdict);
    assert("auto-clear removes the flag from its path", !flagExists(d), flagExists(d));
    const archived = fs.readdirSync(panicPaths(d).archiveDir).filter((f) => f.endsWith(".json"));
    assert("…by archiving it, not deleting it", archived.length === 1, archived);
    assert("archived copy keeps the original evidence",
      fs.readFileSync(path.join(panicPaths(d).archiveDir, archived[0]), "utf8").includes('"shard_id": 2'), archived[0]);
    const h = readHistory(d);
    assert("history records the expiry", h.length === 1 && h[0].event === "expired" && h[0].source === "legacy", h);
    assert("a second gate call is simply clear", gate({ dataDir: d, now: firstSlot + 1000 }).verdict === "clear", null);
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\nlegacy and malformed flags are bounded, never permanent\n");
  {
    const now = Date.parse("2026-10-09T05:00:00Z");

    const d1 = freshDir();
    writeFlag(d1, { reason: "test-panic", at: new Date(now - 7 * H).toISOString() });
    assert("{reason, at} shape uses `at` → expired after 7h", evaluateFlag({ dataDir: d1, now }).state === "expired", evaluateFlag({ dataDir: d1, now }));

    const d2 = freshDir();
    writeFlag(d2, "not json at all");
    fs.utimesSync(panicPaths(d2).flag, (now - 7 * H) / 1000, (now - 7 * H) / 1000);
    const e2 = evaluateFlag({ dataDir: d2, now });
    assert("unparseable flag falls back to mtime + 6h → expired", e2.state === "expired" && e2.source === "unparseable", e2);

    const d3 = freshDir();
    writeFlag(d3, "garbage");
    fs.utimesSync(panicPaths(d3).flag, (now - 1 * H) / 1000, (now - 1 * H) / 1000);
    assert("unparseable flag 1h old still binds (fail closed, bounded)", evaluateFlag({ dataDir: d3, now }).state === "active", evaluateFlag({ dataDir: d3, now }));

    const d4 = freshDir();
    writeFlag(d4, { reason: "api:blocked", detected_at: "2027-10-09T05:00:00Z" });
    fs.utimesSync(panicPaths(d4).flag, (now - 7 * H) / 1000, (now - 7 * H) / 1000);
    assert("a future-dated detected_at (typo year) is distrusted → mtime used → expired",
      evaluateFlag({ dataDir: d4, now }).state === "expired", evaluateFlag({ dataDir: d4, now }));

    const d5 = freshDir();
    const det5 = now - 1 * H;
    writeFlag(d5, { schema: 2, reason: "api:blocked", detected_at: new Date(det5).toISOString(), expires_at: new Date(now + 1000 * 24 * H).toISOString() });
    const e5 = evaluateFlag({ dataDir: d5, now });
    assert("an absurd expires_at is clamped to detected_at + MAX_TTL_HOURS", e5.expiresAtMs === det5 + MAX_TTL_HOURS * H, e5.expiresAtMs);

    const d6 = freshDir();
    writeFlag(d6, { schema: 2, reason: "api:blocked", detected_at: new Date(now).toISOString(), expires_at: null, requires_manual_clear: true });
    const e6 = evaluateFlag({ dataDir: d6, now: now + 365 * 24 * H });
    assert("a requires_manual_clear flag never expires on its own", e6.state === "active" && e6.manual === true, e6);
    assert("gate never auto-clears a manual flag", gate({ dataDir: d6, now: now + 365 * 24 * H }).verdict === "active", null);

    const d7 = freshDir();
    writeFlag(d7, { schema: 2, reason: "x", detected_at: new Date(now - H).toISOString(), expires_at: new Date(now).toISOString() });
    assert("expiry is inclusive at exactly expires_at", evaluateFlag({ dataDir: d7, now }).state === "expired", null);
    assert("…and still binding 1ms before", evaluateFlag({ dataDir: d7, now: now - 1 }).state === "active", null);
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\nwrite side: exclusive create, one incident = one trip\n");
  {
    const d = freshDir();
    const t0 = Date.parse("2026-10-10T10:00:00Z");
    const a = recordTrip({ dataDir: d, reason: "api:blocked", shardId: 2, evidence: "status=403", extra: { ticker: "CENTRALBK", body_head: "<!DOCTYPE html>…Just a moment..." }, now: t0 });
    assert("first trip creates the flag", a.created === true && flagExists(d), a);
    const f = JSON.parse(fs.readFileSync(panicPaths(d).flag, "utf8"));
    assert("flag is schema 2 with trip 1 / 6h", f.schema === 2 && f.trip === 1 && f.ttl_hours === 6, f);
    assert("flag expires_at = detected + 6h", f.expires_at === new Date(t0 + 6 * H).toISOString(), f.expires_at);
    assert("flag carries ticker + body head for forensics", f.ticker === "CENTRALBK" && f.body_head.includes("Just a moment"), f);

    const b = recordTrip({ dataDir: d, reason: "api:blocked", shardId: 3, evidence: "status=403", now: t0 + 5000 });
    const f2 = JSON.parse(fs.readFileSync(panicPaths(d).flag, "utf8"));
    assert("a second shard tripping in the same run does not overwrite the flag", b.created === false && f2.shard_id === 2 && f2.expires_at === f.expires_at, f2);
    const h = readHistory(d);
    assert("…and is logged as trip_extra, not a second trip", h.map((e) => e.event).join(",") === "trip,trip_extra", h.map((e) => e.event));
    assert("streak stays 1 for one incident", consecutiveTrips(h) === 1, consecutiveTrips(h));
    const leftovers = fs.readdirSync(panicPaths(d).archiveDir).filter((n) => n.startsWith(".tmp-flag-"));
    assert("no temp files are left behind", leftovers.length === 0, leftovers);
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\nescalation across nights, reset only by a clean scrape\n");
  {
    const d = freshDir();
    let t = Date.parse("2026-10-10T19:05:00Z"); // 00:35 IST
    const ttls = [];
    for (let i = 0; i < 4; i++) {
      recordTrip({ dataDir: d, reason: "api:blocked", shardId: 1, evidence: "status=403", now: t });
      const f = JSON.parse(fs.readFileSync(panicPaths(d).flag, "utf8"));
      ttls.push(f.ttl_hours);
      t += 200 * H; // well past any ladder TTL
      gate({ dataDir: d, now: t });
    }
    assert("consecutive trips escalate 6 → 30 → 78 → manual", JSON.stringify(ttls) === "[6,30,78,null]", ttls);
    assert("the 4th flag is still in place (needs a human)", flagExists(d), null);

    const d2 = freshDir();
    let t2 = Date.parse("2026-10-10T19:05:00Z");
    recordTrip({ dataDir: d2, reason: "api:blocked", shardId: 1, evidence: "", now: t2 });
    gate({ dataDir: d2, now: (t2 += 7 * H) });
    recordTrip({ dataDir: d2, reason: "api:blocked", shardId: 1, evidence: "", now: (t2 += 24 * H) });
    gate({ dataDir: d2, now: (t2 += 31 * H) });
    recordClean({ dataDir: d2, note: "3 shards ok", now: (t2 += 8 * H) });
    recordTrip({ dataDir: d2, reason: "api:blocked", shardId: 1, evidence: "", now: (t2 += 24 * H) });
    const f = JSON.parse(fs.readFileSync(panicPaths(d2).flag, "utf8"));
    assert("a clean scrape resets the streak: next trip is back to 6h", f.trip === 1 && f.ttl_hours === 6, f);
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\nsimulation: 60 nights of a PERMANENT block (account safety)\n");
  {
    // Mirrors sws-nightly.sh step 0: at each 00:30 IST slot, gate; if active and
    // it lapses within the 8h wait budget, wait for it and gate again; if clear,
    // the scrape's first request trips immediately. No run is ever clean.
    const d = freshDir();
    const MAX_WAIT_MS = 8 * H;
    let slot = Date.parse("2026-10-10T19:00:00Z"); // 2026-10-11 00:30 IST
    let probes = 0;
    let refused = 0;
    for (let night = 0; night < 60; night++, slot += 24 * H) {
      let now = slot;
      let g = gate({ dataDir: d, now });
      if (g.verdict === "active" && g.waitSec != null && g.waitSec * 1000 <= MAX_WAIT_MS) {
        now += g.waitSec * 1000;
        g = gate({ dataDir: d, now });
      }
      if (g.verdict === "active") { refused++; continue; }
      probes++;
      recordTrip({ dataDir: d, reason: "api:blocked", shardId: 1, evidence: "status=403", now: now + 10 * 60_000 });
    }
    assert("a permanent block is probed at most 4 times in 60 nights", probes <= 4, probes);
    assert("…and ends parked on a manual flag", evaluateFlag({ dataDir: d, now: slot }).manual === true, evaluateFlag({ dataDir: d, now: slot }));
    assert("…refusing the remaining nights", refused === 60 - probes, { refused, probes });
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\ntrip timing: a late-evening trip is waited out, not a lost day\n");
  {
    const d = freshDir();
    const trip = Date.parse("2026-10-10T14:30:00Z"); // 20:00 IST — expires 02:00 IST
    recordTrip({ dataDir: d, reason: "api:blocked", shardId: 2, evidence: "status=403", now: trip });
    const slot = Date.parse("2026-10-10T19:00:00Z"); // 00:30 IST
    const g = gate({ dataDir: d, now: slot });
    assert("at the slot it is still active", g.verdict === "active", g.verdict);
    assert("…with 1.5h left, inside the 8h wait budget the nightly honours", g.waitSec === 90 * 60, g.waitSec);

    const d2 = freshDir();
    recordTrip({ dataDir: d2, reason: "api:blocked", shardId: 2, evidence: "status=403", now: Date.parse("2026-10-10T11:39:00Z") }); // 17:09 IST
    assert("a 17:09 IST trip (the 09-30 shape) is gone by the next 00:30 slot",
      gate({ dataDir: d2, now: slot }).verdict === "auto_cleared", null);
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\narchive races\n");
  {
    const d = freshDir();
    const r = archiveFlag({ dataDir: d, event: "expired", now: Date.now() });
    assert("archiving an absent flag is a no-op, not a throw", r.gone === true && r.archived === false, r);

    // A gate evaluated an expired flag, then a shard's fresh trip replaced it
    // before the rename: the fresh, binding flag must NOT be archived.
    const now = Date.now();
    writeFlag(d, { schema: 2, reason: "api:blocked", detected_at: new Date(now).toISOString(), expires_at: new Date(now + 6 * H).toISOString() });
    const r2 = archiveFlag({ dataDir: d, event: "expired", now });
    assert("archiveFlag(expired) refuses a flag that is not expired", r2.archived === false && flagExists(d), r2);
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\nclean_run needs evidence SWS served us, not exit codes\n");
  {
    const d = freshDir();
    const t = Date.parse("2026-10-11T10:00:00Z");
    fs.writeFileSync(path.join(d, "universe.json"), JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ ticker: `T${i}` }))));
    const prog = (n, done) => fs.writeFileSync(path.join(d, `progress-api-${n}.json`), JSON.stringify({ shard_id: n, done_count: done }));
    prog(1, 1000); prog(2, 2000); prog(3, 3000);
    fs.writeFileSync(path.join(d, "progress-api-4.json"), "{ torn");
    assert("servedCount sums done_count; a torn file counts 0", servedCount(d) === 6000, servedCount(d));
    assert("universeSize reads universe.json", universeSize(d) === 100, universeSize(d));

    recordTrip({ dataDir: d, reason: "api:blocked", shardId: 1, evidence: "", now: t });
    gate({ dataDir: d, now: t + 7 * H }); // expired → archived
    const before = servedCount(d);

    // A night of 503s: every shard exits 0, nothing served.
    let r = recordCleanIfServed({ dataDir: d, servedSince: before, now: t + 30 * H });
    assert("0 stocks served → NOT clean (shards exiting 0 is not evidence)", r.recorded === false && r.served === 0, r);
    assert("…so the streak survives", consecutiveTrips(readHistory(d)) === 1, consecutiveTrips(readHistory(d)));

    prog(1, 1030); prog(2, 2010);
    r = recordCleanIfServed({ dataDir: d, servedSince: before, now: t + 31 * H });
    assert("40% served → NOT clean", r.recorded === false && r.served === 40, r);

    prog(3, 3015);
    recordTrip({ dataDir: d, reason: "api:blocked", shardId: 2, evidence: "", now: t + 32 * H });
    r = recordCleanIfServed({ dataDir: d, servedSince: before, now: t + 32 * H + 60_000 });
    assert("a panic flag present → NOT clean even at 55% served", r.recorded === false && r.flagged === true, r);
    gate({ dataDir: d, now: t + 100 * H });

    r = recordCleanIfServed({ dataDir: d, servedSince: before, now: t + 101 * H });
    assert("≥50% served, no flag → clean_run (even if a shard failed)", r.recorded === true && r.served === 55, r);
    assert("…and the streak resets", consecutiveTrips(readHistory(d)) === 0, consecutiveTrips(readHistory(d)));
    assert("…recording served/expected in history", readHistory(d).at(-1).served === 55 && readHistory(d).at(-1).expected === 100, readHistory(d).at(-1));

    const empty = freshDir();
    assert("no universe.json → never clean", recordCleanIfServed({ dataDir: empty, servedSince: 0 }).recorded === false, null);
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\nhistory trimming happens only at the run-start gate\n");
  {
    const d = freshDir();
    const lines = Array.from({ length: 1100 }, (_, i) => JSON.stringify({ event: "clean_run", at: new Date(Date.UTC(2026, 0, 1) + i * H).toISOString() })).join("\n") + "\n";
    fs.writeFileSync(panicPaths(d).history, lines);
    recordTrip({ dataDir: d, reason: "api:blocked", shardId: 1, evidence: "", now: Date.now() });
    assert("a shard's append never rewrites the file (no lost concurrent lines)", readHistory(d).length === 1101, readHistory(d).length);
    gate({ dataDir: d, now: Date.now() });
    const after = readHistory(d);
    assert("the gate trims to the last 500 lines", after.length === 500 && after.at(-1).event === "trip", { n: after.length, last: after.at(-1)?.event });
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\nCLI contract used by the bash gates\n");
  {
    const run = (args, cwd = REPO_ROOT, script = POLICY) => spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8" });
    const kv = (out, k) => (out.split("\n---\n")[0].match(new RegExp(`^${k}=(.*)$`, "m")) || [])[1];

    const d = freshDir();
    let r = run(["gate", "--data-dir", d]);
    assert("gate with no flag → exit 0, verdict=clear", r.status === 0 && kv(r.stdout, "verdict") === "clear", { status: r.status, out: r.stdout });

    const now = Date.now();
    writeFlag(d, { schema: 2, reason: "api:blocked", shard_id: 2, detected_at: new Date(now - H).toISOString(), expires_at: new Date(now + 2 * H).toISOString(), trip: 1, ttl_hours: 3 });
    r = run(["gate", "--data-dir", d]);
    assert("gate with an active flag → exit 1, verdict=active", r.status === 1 && kv(r.stdout, "verdict") === "active", { status: r.status, out: r.stdout });
    const wait = Number(kv(r.stdout, "wait_sec"));
    assert("…reports wait_sec ≈ 2h", wait > 7100 && wait <= 7200, wait);
    assert("…reports an IST expiry for the mail subject", / IST$/.test(kv(r.stdout, "expires_at_ist") || ""), kv(r.stdout, "expires_at_ist"));
    assert("…summary after --- names the override command", r.stdout.includes("sws-panic-policy.mjs clear"), r.stdout);
    assert("…flag untouched", flagExists(d), null);

    writeFlag(d, { schema: 2, reason: "api:blocked", shard_id: 2, detected_at: new Date(now - 7 * H).toISOString(), expires_at: new Date(now - H).toISOString() });
    r = run(["gate", "--data-dir", d]);
    assert("gate with an expired flag → exit 0, verdict=auto_cleared, flag archived",
      r.status === 0 && kv(r.stdout, "verdict") === "auto_cleared" && !flagExists(d) && /^panic-stop\./.test(kv(r.stdout, "archived_to") || ""), { status: r.status, out: r.stdout });

    r = run(["record-trip", "api:blocked", "3", "status=403", "--data-dir", d]);
    const rec = JSON.parse(r.stdout || "{}");
    assert("record-trip CLI writes a schema-2 flag (DOM / slash-command path)", r.status === 0 && rec.created === true && rec.trip === 1 && flagExists(d), r.stdout);

    r = run(["clear", "--data-dir", d]);
    assert("clear without --reason is refused (exit 2) and leaves the flag", r.status === 2 && flagExists(d), r.status);
    r = run(["clear", "--data-dir", d, "--reason", "checked SWS in browser"]);
    const last = readHistory(d).at(-1);
    assert("clear --reason archives and records the reason", r.status === 0 && !flagExists(d) && last.event === "manual_clear" && last.reason === "checked SWS in browser", last);

    r = run(["record-clean", "--data-dir", d, "--note", "ok"]);
    assert("record-clean (no --served-since) appends clean_run", r.status === 0 && readHistory(d).at(-1).event === "clean_run", readHistory(d).at(-1));

    r = run(["served-count", "--data-dir", d]);
    assert("served-count prints an integer", r.status === 0 && /^\d+\n$/.test(r.stdout), r.stdout);
    r = run(["record-clean", "--data-dir", d, "--served-since", "0"]);
    assert("record-clean --served-since with no universe → NOT recorded, exit 0", r.status === 0 && /NOT recorded/.test(r.stdout), r.stdout);

    // The nightly reaches this file through a symlinked worktree path; the
    // entrypoint guard must still run the CLI (sws-deep-scrape.mjs's href guard
    // would silently do nothing there).
    const linkDir = path.join(tmpRoot, "linked");
    fs.mkdirSync(linkDir, { recursive: true });
    const linked = path.join(linkDir, "sws-panic-policy.mjs");
    fs.symlinkSync(POLICY, linked);
    writeFlag(d, { schema: 2, reason: "x", detected_at: new Date(now).toISOString(), expires_at: new Date(now + H).toISOString() });
    r = run(["gate", "--data-dir", d], REPO_ROOT, linked);
    assert("CLI runs through a symlinked path (active → exit 1)", r.status === 1 && kv(r.stdout, "verdict") === "active", { status: r.status, out: r.stdout, err: r.stderr });
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\nstate survives the isolated wrapper's `git clean -fd`\n");
  {
    // sws-nightly-isolated.sh resets with `git clean -fd -- .` (no -x). If any
    // policy file were merely untracked, the streak would be wiped every night
    // and a real block would be re-probed at 6h forever.
    const repo = path.join(tmpRoot, "gitrepo");
    fs.mkdirSync(path.join(repo, "data/sws-us"), { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, ".gitignore"), path.join(repo, ".gitignore"));
    fs.copyFileSync(path.join(REPO_ROOT, "data/sws-us/.gitignore"), path.join(repo, "data/sws-us/.gitignore"));
    const env = { ...process.env };
    for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_PREFIX", "GIT_COMMON_DIR", "GIT_QUARANTINE_PATH", "GIT_INTERNAL_SUPER_PREFIX"]) delete env[k];
    const git = (...a) => spawnSync("git", a, { cwd: repo, env, encoding: "utf8" });
    git("init", "-q");
    git("-c", "user.email=t@t", "-c", "user.name=t", "add", ".gitignore", "data/sws-us/.gitignore");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init");
    const files = [
      "data/sws/panic-stop.flag",
      "data/sws/panic-history.ndjson",
      "data/sws/panic-archive/panic-stop.x.expired-y.json",
      "data/sws-us/panic-stop.flag",
      "data/sws-us/panic-history.ndjson",
      "data/sws-us/panic-archive/panic-stop.x.expired-y.json",
    ];
    for (const f of files) {
      fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
      fs.writeFileSync(path.join(repo, f), "{}\n");
    }
    fs.writeFileSync(path.join(repo, "data/sws/untracked-control.json"), "{}\n");
    const c = git("clean", "-fd", "--", ".");
    assert("git clean ran", c.status === 0, c.stderr);
    assert("control: an untracked, unignored file IS removed", !fs.existsSync(path.join(repo, "data/sws/untracked-control.json")), null);
    for (const f of files) assert(`survives git clean -fd: ${f}`, fs.existsSync(path.join(repo, f)), f);
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\nwriters go through the policy\n");
  for (const rel of ["scripts/sws-api-scrape.mjs", "scripts/sws-api-scrape-us.mjs", "scripts/sws-deep-scrape.mjs"]) {
    const src = fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
    assert(`${rel} imports recordTrip from the policy`, /import \{ recordTrip \} from "\.\/sws-panic-policy\.mjs";/.test(src), null);
    assert(`${rel} never writes the flag directly`, !/writeFileSync\(PANIC_FLAG/.test(src) && !/writeJsonAtomic\(PATHS\.panicStop/.test(src), null);
  }
  const policySrc = fs.readFileSync(POLICY, "utf8");
  const imports = [...policySrc.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
  assert("policy module imports only node: builtins (bash tests copy it alone)", imports.every((m) => m.startsWith("node:")), imports);
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
