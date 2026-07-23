/**
 * scripts/sws-auto-ship.sh — failure propagation.
 *
 * A failed `git push` used to `return 0` with no mail: the data-only ship could
 * stall with zero signal, leaving prod dashboards stale and nobody told. This
 * asserts the two categories are now distinguished:
 *
 *   deliberate refusal   (limit set, scrape skipped, auto-PR off) → return 0
 *   attempted and broke  (fetch/worktree/commit/push/PR create)   → return 1 + mail
 *
 * Behavioural, not just static: the whole point of the change is a return code,
 * so it is exercised with stubbed git/gh binaries rather than grepped for.
 *
 * Run with: node test/swsAutoShipFailurePropagation.test.mjs
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const SHIP = path.join(REPO_ROOT, "scripts", "sws-auto-ship.sh");

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "auto-ship-prop-"));
process.on("exit", () => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

const bin = path.join(tmp, "bin");
fs.mkdirSync(bin, { recursive: true });

/**
 * Stub `git` so every subcommand succeeds except the one under test, and stub
 * `gh` so the CLI-present check passes.
 */
function writeStubs(failing) {
  fs.writeFileSync(
    path.join(bin, "git"),
    `#!/usr/bin/env bash
# The subcommand under test fails; everything else succeeds.
for a in "$@"; do
  case "$a" in
    ${failing}) echo "stub git: simulated ${failing} failure" >&2; exit 1 ;;
  esac
done
for a in "$@"; do
  case "$a" in
    --show-toplevel) echo "${tmp}"; exit 0 ;;
  esac
done
# \`git diff --cached --quiet --exit-code\` uses exit status as the ANSWER:
# 0 = nothing staged. Returning 0 here makes the shipper skip before it ever
# reaches commit/push, so report 1 (= there ARE staged changes).
_has_cached=0; _is_diff=0
for a in "$@"; do
  [ "$a" = "diff" ] && _is_diff=1
  [ "$a" = "--cached" ] && _has_cached=1
done
if [ "$_is_diff" = "1" ] && [ "$_has_cached" = "1" ]; then exit 1; fi
exit 0
`,
    { mode: 0o755 }
  );
  fs.writeFileSync(path.join(bin, "gh"), "#!/usr/bin/env bash\necho https://github.com/x/y/pull/1\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "rsync"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
}

/** Source the shipper and invoke it with a stubbed PATH; return its exit code. */
function runShip({ failing, extraEnv = "" }) {
  writeStubs(failing);
  const artifact = path.join(tmp, "data", "catalysts");
  fs.mkdirSync(artifact, { recursive: true });
  fs.writeFileSync(path.join(artifact, "x.json"), "{}");

  const script = `
export PATH="${bin}:$PATH"
send_mail() { echo "MAIL_SENT: $1"; touch "${tmp}/mail.sent"; }
cd "${tmp}"
source "${SHIP}"
${extraEnv}
SWS_SHIP_MARKET=india-data-only SWS_SHIP_ALLOW_WITHOUT_PICKS=1 \
  sws_auto_ship_market data/catalysts
echo "RC=$?"
`;
  try { fs.rmSync(path.join(tmp, "mail.sent")); } catch {}
  const res = spawnSync("bash", ["-c", script], { encoding: "utf-8", timeout: 60_000 });
  const out = `${res.stdout || ""}${res.stderr || ""}`;
  const m = /RC=(\d+)/.exec(out);
  return { rc: m ? Number(m[1]) : null, out, mailed: fs.existsSync(path.join(tmp, "mail.sent")) };
}

console.log("swsAutoShipFailurePropagation: attempted-and-broke returns non-zero + mails");
for (const stage of ["push", "commit"]) {
  const r = runShip({ failing: stage });
  assert(`${stage} failure returns non-zero`, r.rc !== 0 && r.rc !== null, { rc: r.rc, out: r.out.slice(-500) });
  assert(`${stage} failure sends mail`, r.mailed, r.out.slice(-400));
}

console.log("swsAutoShipFailurePropagation: deliberate refusals still return 0 silently");
for (const [label, env] of [
  ["SWS_SCRAPE_LIMIT set", "export SWS_SCRAPE_LIMIT=10"],
  ["scrape skipped", "export SWS_SHIP_SCRAPE_SKIPPED=true"],
  ["failed shards", "export SWS_SHIP_FAILED_SHARDS=2"],
  ["auto-PR disabled", "export SWS_AUTO_PR=0"],
]) {
  const r = runShip({ failing: "__never__", extraEnv: env });
  assert(`${label} returns 0`, r.rc === 0, { rc: r.rc, out: r.out.slice(-300) });
  assert(`${label} does not mail`, !r.mailed);
}

console.log("swsAutoShipFailurePropagation: US path has no send_mail and must not break");
{
  writeStubs("push");
  const script = `
export PATH="${bin}:$PATH"
cd "${tmp}"
source "${SHIP}"
SWS_SHIP_MARKET=us SWS_SHIP_ALLOW_WITHOUT_PICKS=1 sws_auto_ship_market data/catalysts
echo "RC=$?"
`;
  const res = spawnSync("bash", ["-c", script], { encoding: "utf-8", timeout: 60_000 });
  const out = `${res.stdout || ""}${res.stderr || ""}`;
  const rc = /RC=(\d+)/.exec(out);
  assert("still returns non-zero without send_mail defined", rc && Number(rc[1]) !== 0, out.slice(-400));
  assert("no 'command not found' for send_mail", !/send_mail: command not found/.test(out), out.slice(-300));
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
