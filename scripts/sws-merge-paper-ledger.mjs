#!/usr/bin/env node
/**
 * Three-way, per-row merge of the forward Track Record ledger
 * (data/track-record/paper-trades-live.jsonl) for the nightly's conflicted-PR
 * republish.
 *
 * The ledger is not a snapshot. Every nightly appends that day's picks
 * (FileStorage.append) and rewrites matured rows in place with their forward
 * returns (FileStorage.updateById). Its only committed writer is the nightly
 * (sws-nightly.sh exports PAPER_TRADES_FILE for the snapshot + resolver steps),
 * so main's copy normally does not move while a run waits for auto-merge. It
 * does move when an earlier run's orphaned PR is merged by hand, or a killed
 * run's publish is hand-replayed — and a ledger that moved on both sides is
 * exactly what makes the run's PR CONFLICTING (both append at EOF). Checking
 * out the branch's copy over newer main would then drop main's rows, so
 * republish_conflicted_pr_on_latest_main merges per row id instead:
 *
 *   - a row the branch changed (or added) since the merge base → branch's line
 *   - a row the branch left alone → main's line (keeps a correction or a row
 *     main appended after the fork)
 *   - both changed → branch's line: the branch is the latest nightly, so its
 *     resolver saw the most matured horizons
 *
 * Output is main's rows in main's order, then the branch's new rows in the
 * branch's order, as raw lines — never re-serialised. When main has not moved
 * since the fork, the result is byte-identical to the branch's file.
 *
 * Fails closed (throws / exit 1) on an unparseable line, a row without an id or
 * a duplicate id: a ledger we cannot key must not ship either side's guess.
 *
 * CLI (run from the republish worktree, which holds main's copy at --path):
 *   node scripts/sws-merge-paper-ledger.mjs --path <file> --theirs-rev <rev> [--base-rev <rev>]
 * Rewrites <file> in place (atomic rename). An empty --base-rev means "no
 * merge base": every branch row counts as changed. Exit 0 ok, 1 merge refused,
 * 2 usage.
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);

function indexLedger(text, label) {
  const byId = new Map();
  const order = [];
  const lines = String(text || "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      throw new Error(`${label} line ${i + 1}: not valid JSON`);
    }
    const id = row && typeof row === "object" ? row.id : undefined;
    if ((typeof id !== "string" && typeof id !== "number") || id === "") {
      throw new Error(`${label} line ${i + 1}: row has no id`);
    }
    const key = String(id);
    if (byId.has(key)) throw new Error(`${label} line ${i + 1}: duplicate id ${key}`);
    byId.set(key, line);
    order.push(key);
  }
  return { byId, order };
}

export function mergeLedgerText({ base = "", ours = "", theirs = "" } = {}) {
  const b = indexLedger(base, "base");
  const o = indexLedger(ours, "main");
  const t = indexLedger(theirs, "branch");
  const stats = {
    base_rows: b.order.length,
    main_rows: o.order.length,
    branch_rows: t.order.length,
    branch_updated: 0,
    main_only: 0,
    branch_new: 0,
    both_changed: 0,
  };
  const out = [];
  for (const id of o.order) {
    const mainLine = o.byId.get(id);
    const branchLine = t.byId.get(id);
    if (branchLine === undefined) {
      stats.main_only++;
      out.push(mainLine);
      continue;
    }
    const baseLine = b.byId.get(id);
    if (branchLine === baseLine || branchLine === mainLine) {
      out.push(mainLine);
      continue;
    }
    if (mainLine !== baseLine) stats.both_changed++;
    stats.branch_updated++;
    out.push(branchLine);
  }
  for (const id of t.order) {
    if (o.byId.has(id)) continue;
    stats.branch_new++;
    out.push(t.byId.get(id));
  }
  stats.out_rows = out.length;
  return { text: out.length ? `${out.join("\n")}\n` : "", stats };
}

function gitShow(rev, file) {
  return execFileSync("git", ["show", `${rev}:${file}`], {
    encoding: "utf8",
    maxBuffer: 1 << 30,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!["--path", "--base-rev", "--theirs-rev"].includes(flag) || i + 1 >= argv.length) return null;
    args[flag.slice(2)] = argv[++i];
  }
  return args.path && args["theirs-rev"] ? args : null;
}

export function cli(argv) {
  const args = parseArgs(argv);
  if (!args) {
    console.error("usage: node scripts/sws-merge-paper-ledger.mjs --path <file> --theirs-rev <rev> [--base-rev <rev>]");
    return 2;
  }
  const file = args.path;
  let base = "";
  if (args["base-rev"]) {
    try {
      base = gitShow(args["base-rev"], file);
    } catch {
      base = ""; // the ledger did not exist at the merge base
    }
  }
  let theirs;
  try {
    theirs = gitShow(args["theirs-rev"], file);
  } catch (err) {
    console.error(`refusing: cannot read ${args["theirs-rev"]}:${file} (${String(err.stderr || err.message).trim()})`);
    return 1;
  }
  const ours = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";

  let merged;
  try {
    merged = mergeLedgerText({ base, ours, theirs });
  } catch (err) {
    console.error(`refusing: ${err.message}`);
    return 1;
  }
  const tmp = `${file}.merge-${process.pid}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, merged.text, "utf8");
  fs.renameSync(tmp, file);
  const s = merged.stats;
  console.log(
    `merged ${file}: base=${s.base_rows} main=${s.main_rows} branch=${s.branch_rows} → ${s.out_rows} rows ` +
      `(branch_updated=${s.branch_updated} branch_new=${s.branch_new} main_only=${s.main_only} both_changed=${s.both_changed})`,
  );
  return 0;
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

if (isEntrypoint()) process.exit(cli(process.argv.slice(2)));
