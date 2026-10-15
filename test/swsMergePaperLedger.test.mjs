/**
 * Tests for scripts/sws-merge-paper-ledger.mjs — the per-row three-way merge the
 * nightly's conflicted-PR republish uses for data/track-record/paper-trades-live.jsonl.
 *
 * WHY THIS EXISTS: the republish rebuilds a CONFLICTING SWS auto-refresh PR on
 * latest origin/main by checking out the generated-artifact allow-list from the
 * PR branch. For snapshots that is right. The forward ledger accrues instead —
 * each nightly appends a day of picks and rewrites matured rows — and main's
 * copy moves when an earlier run's orphaned PR or a hand-replayed ship lands
 * while this run waits. A ledger that moved on both sides is what makes the PR
 * conflict in the first place, so a blind checkout of the branch's copy would
 * drop exactly the rows main gained. These tests pin:
 *   1. main unchanged since the fork → output is byte-identical to the branch
 *   2. rows main appended after the fork survive, ahead of the branch's new rows
 *   3. a row only main changed keeps main's line; only the branch → branch's
 *   4. both changed → branch's line (latest resolver run), and it is counted
 *   5. an unkeyable ledger (bad JSON, no id, duplicate id) is refused
 *   6. the CLI reads the two revs from git and rewrites the file in place
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { mergeLedgerText } from "../scripts/sws-merge-paper-ledger.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, "../scripts/sws-merge-paper-ledger.mjs");

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
function throws(fn) {
  try {
    fn();
    return null;
  } catch (err) {
    return err.message;
  }
}

// One ledger row as FileStorage writes it: JSON.stringify, one per line.
const row = (id, extra = {}) => JSON.stringify({ id, dateKey: "2026-10-01", type: "sws", symbol: id.toUpperCase(), ...extra });
const ledger = (...lines) => `${lines.join("\n")}\n`;
const ids = (text) => text.trim().split("\n").map((l) => JSON.parse(l).id);

const A = row("a");
const B = row("b");
const A_RESOLVED = row("a", { closedAt: "2026-10-14", closingPrice: 120 });
const A_CORRECTED = row("a", { symbol: "A-FIXED" });
const C = row("c", { dateKey: "2026-10-14" });
const M = row("m", { dateKey: "2026-10-13" });

console.log("\nsws-merge-paper-ledger.mjs\n");

console.log("--- main has not moved since the fork ---");
{
  const base = ledger(A, B);
  const theirs = ledger(A_RESOLVED, B, C);
  const { text, stats } = mergeLedgerText({ base, ours: base, theirs });
  assert("output is byte-identical to the branch's ledger", text === theirs, text);
  assert("stats: 1 updated, 1 new, nothing main-only or both-changed",
    stats.branch_updated === 1 && stats.branch_new === 1 && stats.main_only === 0 && stats.both_changed === 0, stats);
}

console.log("--- main appended a row after the fork (orphaned PR / hand-replay landed) ---");
{
  const base = ledger(A, B);
  const ours = ledger(A, B, M);
  const theirs = ledger(A_RESOLVED, B, C);
  const { text, stats } = mergeLedgerText({ base, ours, theirs });
  assert("main's interim row survives (a blind checkout would drop it)", ids(text).includes("m"), ids(text));
  assert("order: main's rows in main's order, then the branch's new rows", ids(text).join(",") === "a,b,m,c", ids(text));
  assert("branch's resolution of a row main left alone wins", text.split("\n")[0] === A_RESOLVED, text);
  assert("stats count the main-only row", stats.main_only === 1 && stats.branch_new === 1 && stats.out_rows === 4, stats);
}

console.log("--- one side changed a shared row ---");
{
  const base = ledger(A, B);
  const { text } = mergeLedgerText({ base, ours: ledger(A_CORRECTED, B), theirs: ledger(A, B, C) });
  assert("main-only change (e.g. a hand backfill) is kept when the branch left the row alone",
    text.split("\n")[0] === A_CORRECTED, text);
}

console.log("--- both sides changed the same row ---");
{
  const base = ledger(A, B);
  const { text, stats } = mergeLedgerText({ base, ours: ledger(A_CORRECTED, B), theirs: ledger(A_RESOLVED, B) });
  assert("branch's line wins (latest nightly's resolver)", text.split("\n")[0] === A_RESOLVED, text);
  assert("…and the collision is counted", stats.both_changed === 1, stats);
}

console.log("--- no merge base / no main ledger ---");
{
  const r = mergeLedgerText({ base: "", ours: ledger(A, M), theirs: ledger(A_RESOLVED, C) });
  assert("no base: union, branch wins on shared ids", r.text === ledger(A_RESOLVED, M, C), r.text);
  const fresh = mergeLedgerText({ base: "", ours: "", theirs: ledger(A, C) });
  assert("main has no ledger yet: output is the branch's", fresh.text === ledger(A, C), fresh.text);
  assert("all empty: empty output, no stray newline", mergeLedgerText({}).text === "", mergeLedgerText({}).text);
}

console.log("--- blank lines and raw bytes ---");
{
  const spaced = `${A}\n\n${B}\n`;
  const { text } = mergeLedgerText({ base: spaced, ours: spaced, theirs: ledger(A, B, C) });
  assert("blank lines are ignored, not keyed", ids(text).join(",") === "a,b,c", text);
  const odd = '{"id":"a","price":1.50,"name":"\\u00e9"}';
  const kept = mergeLedgerText({ base: "", ours: "", theirs: ledger(odd) });
  assert("lines are carried verbatim, never re-serialised", kept.text === ledger(odd), kept.text);
}

console.log("--- unkeyable ledgers are refused ---");
{
  assert("invalid JSON line", /branch line 2: not valid JSON/.test(throws(() => mergeLedgerText({ theirs: ledger(A, "{oops") })) || ""), null);
  assert("row without an id", /main line 1: row has no id/.test(throws(() => mergeLedgerText({ ours: ledger('{"symbol":"X"}') })) || ""), null);
  assert("duplicate id", /base line 2: duplicate id a/.test(throws(() => mergeLedgerText({ base: ledger(A, A_RESOLVED) })) || ""), null);
}

console.log("--- CLI: revs read from git, file rewritten in place ---");
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sws-merge-ledger-"));
  const env = { ...process.env };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_COMMON_DIR", "GIT_PREFIX"]) delete env[k];
  const git = (...args) => spawnSync("git", args, { cwd: dir, encoding: "utf8", env });
  const rel = "data/track-record/paper-trades-live.jsonl";
  const file = path.join(dir, rel);
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, ledger(A, B));
  git("add", "-A");
  git("commit", "-qm", "base");
  const baseRev = git("rev-parse", "HEAD").stdout.trim();
  fs.writeFileSync(file, ledger(A_RESOLVED, B, C));
  git("commit", "-qam", "branch");
  const theirsRev = git("rev-parse", "HEAD").stdout.trim();
  fs.writeFileSync(file, ledger(A, B, M)); // main's copy, as checked out in the republish worktree

  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: "utf8", env });
  const ok = run("--path", rel, "--base-rev", baseRev, "--theirs-rev", theirsRev);
  assert("exits 0 and reports the merge", ok.status === 0 && /→ 4 rows .*main_only=1/.test(ok.stdout), ok.stdout + ok.stderr);
  assert("file now holds the merged ledger", fs.readFileSync(file, "utf8") === ledger(A_RESOLVED, B, M, C), fs.readFileSync(file, "utf8"));
  assert("no temp file left behind", fs.readdirSync(path.dirname(file)).length === 1, fs.readdirSync(path.dirname(file)));

  const missing = run("--path", rel, "--base-rev", baseRev, "--theirs-rev", "no-such-rev");
  assert("unreadable branch rev: exit 1, file untouched",
    missing.status === 1 && fs.readFileSync(file, "utf8") === ledger(A_RESOLVED, B, M, C), missing.stderr);

  fs.writeFileSync(file, ledger(A, "{broken"));
  const refused = run("--path", rel, "--base-rev", baseRev, "--theirs-rev", theirsRev);
  assert("unkeyable main ledger: exit 1, file untouched",
    refused.status === 1 && /refusing: main line 2/.test(refused.stderr) && fs.readFileSync(file, "utf8") === ledger(A, "{broken"),
    refused.stderr);

  const usage = run("--path", rel);
  assert("missing --theirs-rev: exit 2 with usage", usage.status === 2 && /usage/.test(usage.stderr), usage.status);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
