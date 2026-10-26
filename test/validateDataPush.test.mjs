/**
 * scripts/validate-data-push.mjs — the data-only pre-push gate.
 *
 * Exit-code contract (relied on by .githooks/pre-push):
 *   0 = pure data, all valid   2 = contains a non-data path   3 = data is invalid
 * Anything else must fall through to the full suite, so a crash can never block
 * a push.
 *
 * Run with: node test/validateDataPush.test.mjs
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const SCRIPT = path.join(REPO_ROOT, "scripts", "validate-data-push.mjs");

let pass = 0;
let fail = 0;
function assert(name, cond, got) {
  if (cond) {
    pass++;
    console.log("  ✓", name);
  } else {
    fail++;
    console.log("  ✗", name, got !== undefined ? `→ got ${JSON.stringify(got)}` : "");
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "validate-data-push-"));
process.on("exit", () => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
});

/** Write a file under a fake repo-relative data path and return that rel path. */
function fixture(rel, contents) {
  const abs = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, contents);
  return rel;
}

/** Run the validator with cwd = the fixture dir so relative paths resolve there. */
function run(paths) {
  const res = spawnSync(process.execPath, [SCRIPT, "--files-from", "-"], {
    input: paths.join("\n"),
    cwd: tmp,
    encoding: "utf-8",
  });
  return { code: res.status, out: `${res.stdout}${res.stderr}` };
}

console.log("validateDataPush: valid data");
{
  const f = fixture("data/catalysts/ok.json", JSON.stringify({ a: 1 }));
  const r = run([f]);
  assert("valid JSON under data/ → exit 0", r.code === 0, { code: r.code, out: r.out });
}
{
  const f = fixture("data/track-record/ok.jsonl", '{"a":1}\n{"b":2}\n\n');
  const r = run([f]);
  assert("valid JSONL (blank lines tolerated) → exit 0", r.code === 0, r.code);
}
{
  const r = run(["data/catalysts/deleted-by-this-push.json"]);
  assert("a deleted data file → exit 0 (deletion is still data-only)", r.code === 0, r.code);
}

console.log("validateDataPush: conflict markers — the class with no guard before this");
{
  const f = fixture(
    "data/macroRegime.json",
    '<<<<<<< Updated upstream\n{"a":1}\n=======\n{"a":2}\n>>>>>>> theirs\n'
  );
  const r = run([f]);
  assert("git conflict markers → exit 3", r.code === 3, { code: r.code, out: r.out });
  assert("names the marker in the output", /conflict marker/.test(r.out), r.out.slice(0, 200));
}
{
  // The false-positive guard. A bare row of '=' is legal content (setext heading
  // underline, ASCII rule) and must NOT be read as a conflict marker.
  const f = fixture("data/coverage/report.md", "Coverage Report\n=======\n\nAll good.\n");
  const r = run([f]);
  assert("bare '=======' with no opener → exit 0 (setext heading, not a marker)", r.code === 0, {
    code: r.code,
    out: r.out,
  });
}

console.log("validateDataPush: malformed data");
{
  const f = fixture("data/catalysts/truncated.json", '{"a": 1, "b":');
  const r = run([f]);
  assert("truncated JSON → exit 3", r.code === 3, r.code);
}
{
  const f = fixture("data/track-record/bad.jsonl", '{"a":1}\nnot json\n');
  const r = run([f]);
  assert("invalid JSONL line → exit 3", r.code === 3, r.code);
}
{
  const f = fixture("data/sws/empty.tar.gz", "");
  const r = run([f]);
  assert("empty binary artifact → exit 3", r.code === 3, r.code);
}
{
  // Brotli payload (the earnings-history archive) is binary: existence-checked,
  // never utf-8-scanned. Scanned as text, these bytes would read as a conflict marker.
  const f = fixture(
    "data/catalysts/earnings-history.tar.br",
    Buffer.concat([Buffer.from([0x1b, 0x00, 0xff, 0x0a]), Buffer.from("<<<<<<< x\n")]),
  );
  const r = run([f]);
  assert("non-empty .tar.br passes as binary → exit 0", r.code === 0, r.code);
}

console.log("validateDataPush: non-data paths fall through to the full suite");
for (const [label, p] of [
  ["a source file", "server.js"],
  ["a test file", "test/foo.test.mjs"],
  ["a script", "scripts/sws-nightly.sh"],
  ["a workflow", ".github/workflows/ci.yml"],
  ["package.json", "package.json"],
  ["a .gitignore under data/", "data/sws/.gitignore"],
  ["a JS file smuggled under data/", "data/evil.mjs"],
  ["an absolute path", "/etc/passwd"],
  ["a traversal path", "data/../server.js"],
]) {
  const r = run([p]);
  assert(`${label} → exit 2 (never the fast path)`, r.code === 2, { p, code: r.code });
}
{
  const f = fixture("data/catalysts/ok2.json", "{}");
  const r = run([f, "server.js"]);
  assert("one code file among many data files → exit 2", r.code === 2, r.code);
}

// 2026-10-26: the bundle-size budget (an early warning) failed the nightly's
// data push at 201.09 MB and prod stayed on 10-23 data. A content suite that
// only WARNS must pass the push and still be visible in the push log; a failing
// one must still block. Stubbed here so the real 200 MB tree-walk never runs.
console.log("validateDataPush: content-suite warnings pass, failures block");
{
  const stub = "test/vercel-bundle-size.test.mjs";
  const f = fixture("data/catalysts/ok3.json", "{}");

  fixture(stub, `console.log("  ⚠ WARNING: api/index bundle 201.09 MB is over the 200.00 MB budget");\n`);
  let r = run([f]);
  assert("warning-only content suite → exit 0 (a warning never blocks the push)", r.code === 0, {
    code: r.code,
    out: r.out,
  });
  assert(
    "the warning is echoed into the push log",
    r.out.includes("WARNING: api/index bundle 201.09 MB"),
    r.out,
  );

  fixture(stub, `console.log("  ✗ over the 240.00 MB push block");\nprocess.exit(1);\n`);
  r = run([f]);
  assert("failing content suite → exit 3 (the block still blocks)", r.code === 3, { code: r.code, out: r.out });

  fs.rmSync(path.join(tmp, stub));
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
