/**
 * scripts/data-paths.mjs — the security property behind the data-only fast path,
 * plus anti-drift against the bash arrays in scripts/sws-nightly.sh.
 *
 * The fast path skips the full test suite for pushes that only touch data. That
 * is only safe while NO executable code lives under an allow-listed path. This
 * test is what stops that from rotting: if someone adds data/scripts/foo.mjs a
 * year from now, this goes red BEFORE the allow-list becomes a hole.
 *
 * Run with: node test/dataPathAllowlist.test.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  isDataPushPath,
  DATA_ONLY_SHIP_PATHS,
  CODE_EXTENSIONS,
  PUSH_DATA_PREFIXES,
  PUSH_DATA_FILES,
} from "../scripts/data-paths.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const NIGHTLY = path.join(REPO_ROOT, "scripts", "sws-nightly.sh");

let pass = 0;
let fail = 0;
function assert(name, cond, got) {
  if (cond) {
    pass++;
    console.log("  ok:", name);
  } else {
    fail++;
    console.log("  FAIL:", name, got !== undefined ? `-- got ${JSON.stringify(got)}` : "");
  }
}

console.log("dataPathAllowlist: no executable code is reachable via the fast path");
{
  const tracked = execFileSync(
    "git",
    ["ls-files", ...PUSH_DATA_PREFIXES.map((p) => p.replace(/\/$/, ""))],
    { cwd: REPO_ROOT, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 }
  )
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  assert("the data tree is actually populated (guards a vacuous pass)", tracked.length > 100, tracked.length);

  const code = tracked.filter((f) => CODE_EXTENSIONS.some((ext) => f.toLowerCase().endsWith(ext)));
  assert("no tracked code-extension file under any data prefix", code.length === 0, code.slice(0, 10));

  // Belt and braces: even if such a file appeared, classification must reject it.
  assert("a hypothetical data/evil.mjs is still rejected", !isDataPushPath("data/evil.mjs"));
  assert("a hypothetical data/evil.sh is still rejected", !isDataPushPath("data/evil.sh"));
}

console.log("dataPathAllowlist: classification rules");
{
  assert("data/ subtree is data", isDataPushPath("data/catalysts/x.json"));
  for (const f of PUSH_DATA_FILES) assert(`${f} is data`, isDataPushPath(f));
  assert("server.js is not data", !isDataPushPath("server.js"));
  assert("package.json is not data", !isDataPushPath("package.json"));
  assert("a .gitignore under data/ is not data", !isDataPushPath("data/sws/.gitignore"));
  assert("traversal is rejected", !isDataPushPath("data/../server.js"));
  assert("absolute paths are rejected", !isDataPushPath("/etc/passwd"));
  assert("empty/garbage input is rejected", !isDataPushPath("") && !isDataPushPath(null));
}

console.log("dataPathAllowlist: no drift from scripts/sws-nightly.sh");
{
  // Centralised by ASSERTION, deliberately not by having bash source this module:
  // a node failure there would yield an empty array, and `git status --short ""`
  // reports 0 changes -- the nightly would then silently ship nothing.
  const sh = fs.readFileSync(NIGHTLY, "utf-8");

  function extractArray(name) {
    const m = new RegExp(`${name}=\\(([\\s\\S]*?)\\)`, "m").exec(sh);
    if (!m) return null;
    return m[1]
      .split("\n")
      .map((l) => l.replace(/#.*$/, "").trim())
      .filter(Boolean);
  }

  for (const name of ["nightly_data_only_paths", "DATA_FILES"]) {
    const arr = extractArray(name);
    assert(`${name} still exists in sws-nightly.sh`, Array.isArray(arr) && arr.length > 0, arr);
    if (!arr) continue;
    assert(
      `${name} matches DATA_ONLY_SHIP_PATHS`,
      JSON.stringify(arr) === JSON.stringify(DATA_ONLY_SHIP_PATHS),
      { sh: arr, mjs: DATA_ONLY_SHIP_PATHS }
    );
    assert(`every ${name} entry classifies as data`, arr.every(isDataPushPath), arr.filter((p) => !isDataPushPath(p)));
  }
}

console.log("dataPathAllowlist: the nightly's staged set is entirely data");
{
  // Whatever the full nightly `git add`s must also be fast-path-eligible,
  // otherwise the nightly silently reverts to the slow suite forever.
  const sh = fs.readFileSync(NIGHTLY, "utf-8");
  const m = /git add (data\/sws\/deep\.tar\.gz[\s\S]*?)\n\s*\n/.exec(sh);
  assert("found the nightly's git add allow-list", !!m);
  if (m) {
    // A `git add a \` / `b \` / `c` continuation ends at the first line WITHOUT a
    // trailing backslash. Stop there, or the next shell statement gets swallowed.
    const paths = [];
    for (const raw of m[1].split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      const continues = line.endsWith("\\");
      const token = line.replace(/\\$/, "").trim();
      if (token) paths.push(token);
      if (!continues) break;
    }
    assert("the staged allow-list is non-trivial", paths.length > 20, paths.length);
    const bad = paths.filter((p) => !isDataPushPath(p));
    assert("every staged path classifies as data", bad.length === 0, bad);
  }
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
