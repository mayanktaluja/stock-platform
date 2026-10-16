import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const script = readFileSync("scripts/sws-status.sh", "utf8");

// The real process_cwd() + active_data_dir(), cut out of the script so they run
// against a fake process table instead of this machine's.
function extractResolver() {
  const lines = script.split("\n");
  const start = lines.indexOf("process_cwd() {");
  const fnStart = lines.indexOf("active_data_dir() {");
  const end = lines.indexOf("}", fnStart);
  assert.ok(start >= 0 && fnStart > start && end > fnStart, "resolver functions moved — update the extractor");
  return lines.slice(start, end + 1).join("\n");
}

// procs: [{ pid, command, cwd }] in `ps -ax` order. `ps` and `lsof` are PATH
// shims that replay them; every cwd that should look like a checkout gets data/sws.
function resolve(procs, { checkouts = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "sws-status-resolver-"));
  try {
    const bin = join(root, "bin");
    const cwds = join(root, "cwds");
    mkdirSync(bin);
    mkdirSync(cwds);
    for (const dir of checkouts) mkdirSync(join(dir, "data/sws"), { recursive: true });

    writeFileSync(join(root, "ps.txt"), procs.map((p) => `${String(p.pid).padStart(6)} ${p.command}\n`).join(""));
    for (const p of procs) writeFileSync(join(cwds, String(p.pid)), p.cwd);
    writeFileSync(join(bin, "ps"), `#!/bin/sh\ncat "${root}/ps.txt"\n`);
    writeFileSync(
      join(bin, "lsof"),
      `#!/bin/sh
pid=""
while [ $# -gt 0 ]; do [ "$1" = "-p" ] && pid="$2"; shift; done
[ -f "${cwds}/$pid" ] || exit 1
printf 'p%s\\nfcwd\\nn%s\\n' "$pid" "$(cat "${cwds}/$pid")"
`,
    );
    chmodSync(join(bin, "ps"), 0o755);
    chmodSync(join(bin, "lsof"), 0o755);

    const res = spawnSync("bash", ["-c", `${extractResolver()}\nactive_data_dir`], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, REPO_DIR: PRIMARY },
      encoding: "utf8",
    });
    assert.equal(res.status, 0, res.stderr);
    const [dir, reason] = res.stdout.trim().split("|");
    return { dir, reason };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const SANDBOX = mkdtempSync(join(tmpdir(), "sws-status-trees-"));
process.on("exit", () => rmSync(SANDBOX, { recursive: true, force: true }));
const PRIMARY = join(SANDBOX, "stock-platform");
const WORKTREE = join(SANDBOX, ".codex/worktrees/stock-platform-sws-nightly");
const TREES = { checkouts: [PRIMARY, WORKTREE] };

// The isolated wrapper and its caffeinate child: cwd is the PRIMARY checkout.
const WRAPPER = [
  { pid: 47403, command: `/bin/bash ${PRIMARY}/scripts/sws-nightly-isolated.sh`, cwd: PRIMARY },
  { pid: 47404, command: `/usr/bin/caffeinate -dims /bin/bash ${PRIMARY}/scripts/sws-nightly-isolated.sh`, cwd: PRIMARY },
];
// sws-nightly.sh after its stable-copy re-exec, plus its log tee.
const NIGHTLY_COPY = [
  { pid: 47485, command: "bash /var/folders/qd/b2qf/T//sws-nightly.47485.sh", cwd: WORKTREE },
  { pid: 47494, command: "bash /var/folders/qd/b2qf/T//sws-nightly.47485.sh", cwd: WORKTREE },
  { pid: 47496, command: "tee -a data/sws/sws-nightly.log", cwd: WORKTREE },
];

test("post-scrape phase: the nightly's temp copy points at the isolated worktree", () => {
  // Verbatim shape of the 2026-10-16 06:27 IST process table: shards and
  // sws-refresh-api.sh gone, PR #1697 waiting on CI. This used to resolve to
  // the primary checkout and show June's log tail.
  const got = resolve([...WRAPPER, ...NIGHTLY_COPY], TREES);
  assert.equal(got.dir, WORKTREE);
  assert.equal(got.reason, "pid=47485");
});

test("scrape phase: a live shard still wins over the nightly's temp copy", () => {
  const shardTree = join(SANDBOX, "shard-tree");
  const got = resolve(
    [...WRAPPER, ...NIGHTLY_COPY, { pid: 50002, command: "node scripts/sws-api-scrape.mjs 2", cwd: shardTree }],
    { checkouts: [...TREES.checkouts, shardTree] },
  );
  assert.equal(got.dir, shardTree);
  assert.equal(got.reason, "pid=50002");
});

test("the wrapper and its re-exec copy alone never claim the primary checkout as live", () => {
  const got = resolve(
    [...WRAPPER, { pid: 47999, command: "/bin/bash /tmp/sws-nightly-isolated.reexec.Ab12Cd.sh", cwd: PRIMARY }],
    TREES,
  );
  assert.equal(got.dir, PRIMARY);
  assert.equal(got.reason, "primary checkout");
});

test("a temp copy whose cwd is not a checkout falls through to the primary checkout", () => {
  const got = resolve([{ pid: 47485, command: "bash /var/folders/T//sws-nightly.47485.sh", cwd: "/" }], TREES);
  assert.equal(got.dir, PRIMARY);
  assert.equal(got.reason, "primary checkout");
});

test("nothing running: primary checkout", () => {
  assert.deepEqual(resolve([], TREES), { dir: PRIMARY, reason: "primary checkout" });
});

test("auto-refresh PR search quotes the title phrase so GitHub doesn't parse chore(sws): as a qualifier", () => {
  assert.ok(script.includes(`AUTO_REFRESH_PR_SEARCH='"chore(sws): auto-refresh" in:title'`));
  const searches = script.match(/gh pr list --search "[^"]*"/g) || [];
  assert.ok(searches.length >= 2, "expected the snapshot and --pr searches");
  for (const s of searches) assert.equal(s, 'gh pr list --search "${AUTO_REFRESH_PR_SEARCH}"');
});

test("India SWS status resolves the active data dir from live process cwd", () => {
  assert.match(script, /process_cwd\(\)/);
  assert.match(script, /lsof -Fn -a -p "\$\{pid\}" -d cwd/);
  assert.match(script, /active_data_dir\(\)/);
  assert.match(script, /sws-api-scrape\\\.mjs\[\[:space:\]\]\+\[123\]/);
  assert.match(script, /scripts\/sws-refresh-api\\\.sh/);
  assert.match(script, /status source/);
  assert.match(script, /live isolated worktree/);
});

test("India SWS status reads mutable SWS artifacts from the detected data dir", () => {
  for (const rel of [
    "data/sws/pipeline.lock",
    "data/sws/refresh-api-shard-$s.log",
    "data/sws/last-refresh.json",
    "data/sws/sws-nightly.log",
  ]) {
    assert.ok(script.includes(`data_path "${rel}"`), `missing data_path for ${rel}`);
  }

  assert.match(script, /tail -f "\$\{DATA_DIR\}\/data\/sws\/refresh-api\.log"/);
  assert.doesNotMatch(script, /tail -6 data\/sws\/sws-nightly\.log/);
  assert.doesNotMatch(script, /\[ -f data\/sws\/pipeline\.lock \]/);
});
