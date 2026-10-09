#!/usr/bin/env bash
#
# Test the panic-gate ordering in scripts/sws-nightly.sh.
#
# WHY THIS EXISTS: from 2026-09-10 to 2026-09-17 the India nightly shipped no data
# at all. A transient Cloudflare 403 on one shard wrote data/sws/panic-stop.flag on
# 2026-09-09; the flag is gitignored and the isolated wrapper cleans with
# `git clean -fd` (no -x), so it survived every worktree reset and every subsequent
# run exited 3 about a second after starting.
#
# The outage stayed invisible for seven days because the "run started" mail was sent
# BEFORE the panic check. The operator received a 🚀 kickoff mail every morning and
# reasonably read it as proof the pipeline was alive. Two mails landed a second
# apart and only the second one meant anything.
#
# The fix moves the panic gate ahead of the started mail: a flagged run is REFUSED,
# not started, so it must never announce a start. The other pre-flight aborts
# (battery / network / git sync) deliberately keep the started->abort pair — those
# runs genuinely began before hitting a condition.
#
# It recurred anyway: on 2026-09-30 one 403 on shard 2 wrote the flag again and it
# refused all 9 nights from 10-01 to 10-09, because the flag still had no expiry.
# The gate now goes through scripts/sws-panic-policy.mjs (expires_at + escalation).
#
# Verifies:
#   1. Active flag -> exit 3 and NO "started" mail is sent.
#   2. Active flag -> the 🚨 refusal mail IS sent, naming when it auto-resumes.
#   3. No panic flag -> the "started" mail is still sent (no regression).
#   4. Source ordering: the panic gate appears before the started mail in the file.
#   5. (retired) The GNU-`stat` age case: the gate no longer shells out to stat.
#   6. The verbatim 2026-09-30 flag, 9 days on -> auto-cleared + archived, run starts.
#   7. A flag that lapses inside the wait budget is waited out, then the run starts.
#   8. A flag past the wait budget is refused (no wait).
#   9. A manual (4th consecutive trip) flag is refused with HUMAN NEEDED.
#  10. Policy CLI broken while a flag exists -> refused (fail closed, never "clear"),
#      and the refusal mail carries the CLI's own error output.
#  11. The wait never runs into the wrapper deadline (SWS_NIGHTLY_DEADLINE_EPOCH).
#  12. A dry run never waits unless SWS_PANIC_MAX_WAIT_SEC is set explicitly.

set -uo pipefail

unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
      GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_PREFIX GIT_COMMON_DIR \
      GIT_QUARANTINE_PATH GIT_INTERNAL_SUPER_PREFIX

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NIGHTLY="${REPO_ROOT}/scripts/sws-nightly.sh"
WORK="$(mktemp -d "/tmp/sws-panic-gate-test-$$.XXXXXX")"
trap 'rm -rf "${WORK}" 2>/dev/null || true' EXIT

pass=0; fail=0
ok() { if [ "$1" = "1" ]; then pass=$((pass+1)); echo "  ✓ $2"; else fail=$((fail+1)); echo "  ✗ FAIL: $2 ${3:-}"; fi; }

# Build a throwaway repo dir the script will cd into. SWS_NIGHTLY_REPO_DIR is the
# supported override, so the real checkout is never touched. The stub mailer
# records subjects instead of sending; the script only calls it when the file
# exists, so its presence is what makes mail observable at all.
mkdir -p "${WORK}/scripts" "${WORK}/data/sws"
cp "${NIGHTLY}" "${WORK}/scripts/sws-nightly.sh"
cp "${REPO_ROOT}/scripts/sws-panic-policy.mjs" "${WORK}/scripts/sws-panic-policy.mjs"
cat > "${WORK}/scripts/sws-mail-summary.mjs" <<'EOF'
import fs from "fs";
fs.appendFileSync(process.env.MAIL_LOG, process.argv[2] + "\n");
if (process.env.MAIL_BODY_LOG) fs.appendFileSync(process.env.MAIL_BODY_LOG, fs.readFileSync(0, "utf8") + "\n");
EOF

run_nightly() {
  MAIL_LOG="$1" SWS_NIGHTLY_REPO_DIR="${WORK}" \
    bash "${WORK}/scripts/sws-nightly.sh" --dry-run >/dev/null 2>&1
  echo $?
}

# Flag fixtures are built with node so every timestamp derives from the real
# clock at test time (no time-bomb dates, no BSD-vs-GNU `date -d/-v`).
write_flag() {  # write_flag <detected_offset_sec> <expires_offset_sec|null> [manual]
  node -e '
    const [det, exp, manual] = process.argv.slice(1);
    const now = Date.now();
    const f = { schema: 2, reason: "api:blocked", shard_id: 3, evidence: "status=403",
      detected_at: new Date(now + Number(det) * 1000).toISOString(),
      expires_at: exp === "null" ? null : new Date(now + Number(exp) * 1000).toISOString() };
    if (manual === "manual") { f.requires_manual_clear = true; f.trip = 4; f.ttl_hours = null; }
    process.stdout.write(JSON.stringify(f, null, 2));
  ' -- "$@" > "${WORK}/data/sws/panic-stop.flag"
}

echo "--- panic flag present (active, beyond the wait budget) ---"
write_flag -3600 72000
: > "${WORK}/mail-panic.txt"
rc="$(run_nightly "${WORK}/mail-panic.txt")"

[ "${rc}" = "3" ] && ok 1 "flagged run exits 3" || ok 0 "flagged run exits 3" "(got ${rc})"

if grep -q '🚀' "${WORK}/mail-panic.txt"; then
  ok 0 "flagged run sends NO 'started' mail" "(a 🚀 mail was sent — this is the 7-day-outage bug)"
else
  ok 1 "flagged run sends NO 'started' mail"
fi

grep -q '🚨' "${WORK}/mail-panic.txt" \
  && ok 1 "flagged run sends the refusal mail" \
  || ok 0 "flagged run sends the refusal mail"

grep -q '🚨.*auto-resumes after .* IST' "${WORK}/mail-panic.txt" \
  && ok 1 "refusal mail says when it auto-resumes" \
  || ok 0 "refusal mail says when it auto-resumes" "($(cat "${WORK}/mail-panic.txt"))"

[ -f "${WORK}/data/sws/panic-stop.flag" ] \
  && ok 1 "an active flag is left in place" \
  || ok 0 "an active flag is left in place"

echo "--- no panic flag ---"
rm -f "${WORK}/data/sws/panic-stop.flag"
: > "${WORK}/mail-clean.txt"
# Exits non-zero further down (the fixture is not a git repo); irrelevant here —
# what matters is that it got PAST the gate and announced the start.
run_nightly "${WORK}/mail-clean.txt" >/dev/null

grep -q '🚀' "${WORK}/mail-clean.txt" \
  && ok 1 "unflagged run still sends the 'started' mail (no regression)" \
  || ok 0 "unflagged run still sends the 'started' mail (no regression)"

echo "--- the verbatim 2026-09-30 flag (refused 10-01..10-09) now auto-clears ---"
printf '%s\n' '{' '  "reason": "api:blocked",' '  "shard_id": 2,' '  "evidence": "status=403",' \
  '  "detected_at": "2026-09-30T11:39:00.621Z"' '}' > "${WORK}/data/sws/panic-stop.flag"
: > "${WORK}/mail-expired.txt"
run_nightly "${WORK}/mail-expired.txt" >/dev/null

[ ! -f "${WORK}/data/sws/panic-stop.flag" ] \
  && ok 1 "expired legacy flag is removed from its path" \
  || ok 0 "expired legacy flag is removed from its path"
ls "${WORK}/data/sws/panic-archive/"panic-stop.*.json >/dev/null 2>&1 \
  && ok 1 "…archived (not deleted) under data/sws/panic-archive/" \
  || ok 0 "…archived (not deleted) under data/sws/panic-archive/"
grep -q 'ℹ️ SWS panic flag expired' "${WORK}/mail-expired.txt" \
  && ok 1 "auto-clear mail sent" \
  || ok 0 "auto-clear mail sent" "($(cat "${WORK}/mail-expired.txt"))"
grep -q '🚀' "${WORK}/mail-expired.txt" \
  && ok 1 "run proceeds past the gate (🚀 started mail)" \
  || ok 0 "run proceeds past the gate (🚀 started mail)"
grep -q 'REFUSED' "${WORK}/mail-expired.txt" \
  && ok 0 "no refusal mail for an expired flag" \
  || ok 1 "no refusal mail for an expired flag"
rm -rf "${WORK}/data/sws/panic-archive" "${WORK}/data/sws/panic-history.ndjson"

echo "--- flag lapsing inside the wait budget is waited out ---"
write_flag -3600 6
: > "${WORK}/mail-wait.txt"
wait_start=$(date +%s)
MAIL_LOG="${WORK}/mail-wait.txt" SWS_NIGHTLY_REPO_DIR="${WORK}" SWS_PANIC_POLL_SEC=1 SWS_PANIC_MAX_WAIT_SEC=60 \
  bash "${WORK}/scripts/sws-nightly.sh" --dry-run >/dev/null 2>&1
wait_elapsed=$(( $(date +%s) - wait_start ))
grep -q '⏳' "${WORK}/mail-wait.txt" \
  && ok 1 "waiting mail sent" \
  || ok 0 "waiting mail sent" "($(cat "${WORK}/mail-wait.txt"))"
[ ! -f "${WORK}/data/sws/panic-stop.flag" ] && grep -q '🚀' "${WORK}/mail-wait.txt" \
  && ok 1 "after the wait the flag is archived and the run starts" \
  || ok 0 "after the wait the flag is archived and the run starts" "($(cat "${WORK}/mail-wait.txt"))"
[ "${wait_elapsed}" -ge 3 ] \
  && ok 1 "it actually waited (${wait_elapsed}s)" \
  || ok 0 "it actually waited" "(${wait_elapsed}s)"
rm -rf "${WORK}/data/sws/panic-archive" "${WORK}/data/sws/panic-history.ndjson"

echo "--- a dry run does not wait by default ---"
write_flag -3600 20
: > "${WORK}/mail-drywait.txt"
dry_start=$(date +%s)
rc_dry="$(run_nightly "${WORK}/mail-drywait.txt")"
dry_elapsed=$(( $(date +%s) - dry_start ))
[ "${rc_dry}" = "3" ] && [ "${dry_elapsed}" -lt 15 ] && ! grep -q '⏳' "${WORK}/mail-drywait.txt" \
  && ok 1 "dry run + flag lapsing in 20s → refused at once (${dry_elapsed}s)" \
  || ok 0 "dry run + flag lapsing in 20s → refused at once" "(rc=${rc_dry}, ${dry_elapsed}s)"
rm -f "${WORK}/data/sws/panic-stop.flag"

echo "--- the wait never runs into the wrapper deadline ---"
write_flag -3600 20
: > "${WORK}/mail-deadline.txt"
dl_start=$(date +%s)
rc_dl="$(MAIL_LOG="${WORK}/mail-deadline.txt" SWS_NIGHTLY_REPO_DIR="${WORK}" SWS_PANIC_POLL_SEC=1 SWS_PANIC_MAX_WAIT_SEC=600 \
  SWS_NIGHTLY_DEADLINE_EPOCH=$(( $(date +%s) + 3600 )) SWS_PANIC_RUN_BUDGET_SEC=3590 \
  bash "${WORK}/scripts/sws-nightly.sh" --dry-run >/dev/null 2>&1; echo $?)"
dl_elapsed=$(( $(date +%s) - dl_start ))
[ "${rc_dl}" = "3" ] && [ "${dl_elapsed}" -lt 15 ] && ! grep -q '⏳' "${WORK}/mail-deadline.txt" \
  && ok 1 "20s wait but only ~10s of deadline room → refused, no wait (${dl_elapsed}s)" \
  || ok 0 "20s wait but only ~10s of deadline room → refused, no wait" "(rc=${rc_dl}, ${dl_elapsed}s)"
rm -f "${WORK}/data/sws/panic-stop.flag"

echo "--- flag beyond the wait budget is refused without waiting ---"
write_flag -3600 3600
: > "${WORK}/mail-nowait.txt"
rc_nowait="$(MAIL_LOG="${WORK}/mail-nowait.txt" SWS_NIGHTLY_REPO_DIR="${WORK}" SWS_PANIC_MAX_WAIT_SEC=60 \
  bash "${WORK}/scripts/sws-nightly.sh" --dry-run >/dev/null 2>&1; echo $?)"
[ "${rc_nowait}" = "3" ] && ! grep -q '⏳' "${WORK}/mail-nowait.txt" \
  && ok 1 "1h-left flag with a 60s budget → exit 3, no wait" \
  || ok 0 "1h-left flag with a 60s budget → exit 3, no wait" "(rc=${rc_nowait}; $(cat "${WORK}/mail-nowait.txt"))"
rm -f "${WORK}/data/sws/panic-stop.flag"

echo "--- manual flag (4th consecutive trip) ---"
write_flag -60 null manual
: > "${WORK}/mail-manual.txt"
rc_manual="$(run_nightly "${WORK}/mail-manual.txt")"
[ "${rc_manual}" = "3" ] && grep -q 'HUMAN NEEDED' "${WORK}/mail-manual.txt" \
  && ok 1 "manual flag → exit 3 + HUMAN NEEDED mail" \
  || ok 0 "manual flag → exit 3 + HUMAN NEEDED mail" "(rc=${rc_manual}; $(cat "${WORK}/mail-manual.txt"))"
rm -f "${WORK}/data/sws/panic-stop.flag"

echo "--- policy CLI broken while a flag exists → fail closed ---"
cp "${WORK}/scripts/sws-panic-policy.mjs" "${WORK}/policy.bak"
printf '%s\n' 'console.error("boom"); process.exit(2);' > "${WORK}/scripts/sws-panic-policy.mjs"
write_flag -864000 -800000   # long expired — only the broken CLI stands between it and a clear
: > "${WORK}/mail-broken.txt"
: > "${WORK}/mail-broken-body.txt"
rc_broken="$(MAIL_BODY_LOG="${WORK}/mail-broken-body.txt" run_nightly "${WORK}/mail-broken.txt")"
[ "${rc_broken}" = "3" ] && [ -f "${WORK}/data/sws/panic-stop.flag" ] && ! grep -q '🚀' "${WORK}/mail-broken.txt" \
  && ok 1 "broken policy CLI + flag → exit 3, never treated as clear" \
  || ok 0 "broken policy CLI + flag → exit 3, never treated as clear" "(rc=${rc_broken})"
grep -q '🚨' "${WORK}/mail-broken.txt" \
  && ok 1 "…and the refusal mail still goes out" \
  || ok 0 "…and the refusal mail still goes out"
grep -q 'boom' "${WORK}/mail-broken-body.txt" \
  && ok 1 "…carrying the policy CLI's own error output" \
  || ok 0 "…carrying the policy CLI's own error output" "($(cat "${WORK}/mail-broken-body.txt"))"
mv "${WORK}/policy.bak" "${WORK}/scripts/sws-panic-policy.mjs"
rm -f "${WORK}/data/sws/panic-stop.flag"

echo "--- source ordering ---"
gate_line="$(grep -n '^if \[ -e "${PANIC_FLAG_PATH}" \]; then' "${NIGHTLY}" | head -1 | cut -d: -f1)"
mail_line="$(grep -n '^START_SUBJECT=' "${NIGHTLY}" | head -1 | cut -d: -f1)"
if [ -n "${gate_line}" ] && [ -n "${mail_line}" ] && [ "${gate_line}" -lt "${mail_line}" ]; then
  ok 1 "panic gate precedes the started mail in source (gate:${gate_line} < mail:${mail_line})"
else
  ok 0 "panic gate precedes the started mail in source" "(gate:${gate_line:-?} mail:${mail_line:-?})"
fi

echo
echo "=== ${pass} passed, ${fail} failed ==="
[ "${fail}" -eq 0 ] || exit 1
