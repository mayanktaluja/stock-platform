/**
 * Regression test for the dedicated fundamentalsHistory launchd job (PR C).
 *
 * fundamentalsHistory.json had no launchd job — CLAUDE.md claimed it did, but
 * none existed, so the file only refreshed on ad-hoc manual runs. PR C added a
 * wrapper script + plist template + resume-script registration. This test
 * guards that wiring so the job can't silently fall out of the repo again.
 *
 * Run with: node test/swsFundamentalsHistoryJob.test.mjs
 */

import { readFileSync, existsSync } from "fs";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

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

const WRAPPER = resolve(REPO_ROOT, "scripts/sws-fundamentals-history-nightly.sh");
const PLIST = resolve(REPO_ROOT, "scripts/com.starbhai.sws-fundamentals-history.plist");
const RESUME = resolve(REPO_ROOT, "scripts/sws-resume-nightly.sh");

console.log("\nfundamentalsHistory launchd job — wiring\n");

// ── Wrapper script ──
assert("wrapper script exists", existsSync(WRAPPER), WRAPPER);
if (existsSync(WRAPPER)) {
  const wrapper = readFileSync(WRAPPER, "utf-8");
  let bashOk = true;
  try {
    execFileSync("bash", ["-n", WRAPPER], { stdio: "pipe" });
  } catch (e) {
    bashOk = false;
    console.log("    bash -n error:", e.stderr?.toString() || e.message);
  }
  assert("wrapper passes `bash -n` (syntax clean)", bashOk, null);
  assert(
    "wrapper invokes refresh-fundamentals-history.mjs",
    /node scripts\/refresh-fundamentals-history\.mjs/.test(wrapper),
    null,
  );
  assert("wrapper supports --dry-run", /--dry-run/.test(wrapper), null);
}

// ── Plist template ──
assert("plist template exists", existsSync(PLIST), PLIST);
if (existsSync(PLIST)) {
  const plist = readFileSync(PLIST, "utf-8");
  assert(
    "plist Label is com.starbhai.sws-fundamentals-history",
    plist.includes("<string>com.starbhai.sws-fundamentals-history</string>"),
    null,
  );
  assert(
    "plist ProgramArguments points at the wrapper",
    plist.includes("scripts/sws-fundamentals-history-nightly.sh"),
    null,
  );
  assert("plist has a StartCalendarInterval", plist.includes("<key>StartCalendarInterval</key>"), null);

  // plutil -lint is macOS-only — self-skip where the binary isn't available.
  let plutilResult = "skipped";
  try {
    execFileSync("plutil", ["-lint", PLIST], { stdio: "pipe" });
    plutilResult = "ok";
  } catch (e) {
    if (e.code === "ENOENT") plutilResult = "skipped";
    else {
      plutilResult = "failed";
      console.log("    plutil error:", e.stderr?.toString() || e.message);
    }
  }
  if (plutilResult === "skipped") console.log("  ⊘ plutil -lint skipped (plutil not available)");
  else assert("plist passes `plutil -lint`", plutilResult === "ok", null);
}

// ── Resume-script registration ──
assert("sws-resume-nightly.sh exists", existsSync(RESUME), RESUME);
if (existsSync(RESUME)) {
  const resume = readFileSync(RESUME, "utf-8");
  assert(
    "resume script registers the fundamentalsHistory plist",
    resume.includes("com.starbhai.sws-fundamentals-history.plist"),
    null,
  );
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
