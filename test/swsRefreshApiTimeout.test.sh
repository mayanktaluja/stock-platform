#!/usr/bin/env bash
#
# Test that scripts/sws-refresh-api.sh actually bounds its timed steps.
#
# WHY THIS EXISTS: refresh-api had its own run_with_timeout that called GNU
# `timeout` when present and otherwise ran the command with NO limit. launchd's
# PATH has neither `timeout` nor `gtimeout`, so on the host that matters every
# guard was decorative: on 2026-08-14 `run_with_timeout 900 node
# scripts/refresh-sector-news-themes.mjs` ran 2h40m. A genuinely hung LLM call
# would have stalled the nightly until the 21h deadline killed the whole run.
#
# refresh-api now sources scripts/sws-with-timeout.sh, the same helper
# sws-nightly.sh uses. This test extracts the REAL sector step block from the
# script, forces the bash fallback (what launchd runs — eval'd directly so the
# test means the same thing on a Linux CI box that has coreutils), and stubs
# `node` with a process that never finishes.
#
# Run with: bash test/swsRefreshApiTimeout.test.sh

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="${REPO_ROOT}/scripts/sws-refresh-api.sh"
HELPER="${REPO_ROOT}/scripts/sws-with-timeout.sh"
WORK="$(mktemp -d "/tmp/sws-refresh-api-timeout-$$.XXXXXX")"
trap 'rm -rf "${WORK}" 2>/dev/null || true' EXIT

pass=0; fail=0
ok() { if [ "$1" = "1" ]; then pass=$((pass+1)); echo "  ✓ $2"; else fail=$((fail+1)); echo "  ✗ FAIL: $2 ${3:-}"; fi; }

echo ""
echo "sws-refresh-api.sh step timeouts"
echo ""

echo "--- static ---"
grep -q '^\. "\${SCRIPT_DIR}/sws-with-timeout.sh"$' "${SCRIPT}" \
  && ok 1 "refresh-api sources the shared helper" \
  || ok 0 "refresh-api sources the shared helper"
grep -qE '^[[:space:]]*(run_)?with_timeout\(\) *\{' "${SCRIPT}" \
  && ok 0 "refresh-api defines no private timeout helper" \
  || ok 1 "refresh-api defines no private timeout helper"
grep -vE '^[[:space:]]*#' "${SCRIPT}" | grep -q 'run_with_timeout' \
  && ok 0 "no callsite still uses the old unbounded run_with_timeout" \
  || ok 1 "no callsite still uses the old unbounded run_with_timeout"
[ "$(grep -c '^if ! with_timeout [0-9]* node scripts/refresh-sector-' "${SCRIPT}")" = "2" ] \
  && ok 1 "both sector steps go through with_timeout" \
  || ok 0 "both sector steps go through with_timeout" "($(grep -n 'refresh-sector-' "${SCRIPT}" | tr '\n' ' '))"

# The themes walk must FINISH inside its timeout (a ticker it never reaches keeps
# stale JSONL from git — 2026-10-14 zeroed growing_sector_value that way), so the
# LLM budget has to stop calls well before the step's kill.
themes_line="$(grep '^if ! with_timeout [0-9]* node scripts/refresh-sector-news-themes.mjs' "${SCRIPT}")"
themes_timeout="$(printf '%s' "${themes_line}" | sed -E 's/^if ! with_timeout ([0-9]+) .*/\1/')"
themes_budget="$(printf '%s' "${themes_line}" | sed -nE 's/.*--llm-budget-sec=([0-9]+).*/\1/p')"
[ -n "${themes_budget}" ] && [ "${themes_budget}" -le $(( themes_timeout * 3 / 4 )) ] \
  && ok 1 "themes LLM budget (${themes_budget}s) leaves ≥25% of the ${themes_timeout}s timeout to finish the walk" \
  || ok 0 "themes LLM budget leaves room to finish the walk" "(line: ${themes_line})"
grep -qE '^  if ! with_timeout [0-9]+ node scripts/refresh-sector-news-themes\.mjs --max-llm-calls=0 ' "${SCRIPT}" \
  && ok 1 "a killed themes run falls back to a bounded no-LLM re-run" \
  || ok 0 "a killed themes run falls back to a bounded no-LLM re-run"

# Sourcing the helper must define with_timeout no matter which branch it takes.
( . "${HELPER}"; declare -F with_timeout >/dev/null ) \
  && ok 1 "helper defines with_timeout when sourced" \
  || ok 0 "helper defines with_timeout when sourced"

# ── runtime: the real sector block, forced onto the bash fallback ──────────
# Step 7.5 from "refreshing sector news themes" up to (not incl.) final scoring.
BLOCK="$(awk '
  index($0, "echo \"[refresh-api] refreshing sector news themes") == 1 { f=1 }
  index($0, "echo \"[refresh-api] running final scoring") == 1 { f=0 }
  f
' "${SCRIPT}")"
[ -n "${BLOCK}" ] && ok 1 "sector step block extracted" || ok 0 "sector step block extracted" "(markers moved?)"

FALLBACK="$(awk '
  /^else$/ { in_else=1; next }
  in_else && /^  with_timeout\(\) \{$/ { f=1 }
  f { print }
  f && /^  \}$/ { exit }
' "${HELPER}")"
[ -n "${FALLBACK}" ] && ok 1 "bash fallback extracted from helper" || ok 0 "bash fallback extracted from helper"

# Shrink the real 900s/120s to 2s so a hang is observable in test time. Only
# the numbers change; the pipeline shape (`if ! with_timeout … | tail | sed`)
# is the shipped one — that shape is what decides whether a kill is noticed.
SHORT_BLOCK="$(printf '%s\n' "${BLOCK}" | sed -E 's/with_timeout [0-9]+ /with_timeout 2 /')"

mkdir -p "${WORK}/bin"
# `exec` so the stub IS the long-lived process. A bash stub that forks `sleep`
# would orphan it on TERM and that orphan would hold the tail pipe open — a test
# artifact, since real node closes its fds when it dies.
cat > "${WORK}/bin/node" <<'STUB'
#!/usr/bin/env bash
case "${NODE_STUB_MODE:-hang}" in
  hang) exec sleep 60 ;;
  fast) echo "stub ran: $*"; exit 0 ;;
  # The LLM run dies (e.g. killed on a laptop wake); the no-LLM re-run works.
  fail-first)
    case "$*" in
      *--max-llm-calls=0*) echo "stub ran: $*"; exit 0 ;;
      *) echo "stub died: $*"; exit 143 ;;
    esac ;;
esac
STUB
chmod +x "${WORK}/bin/node"

run_block() {
  NODE_STUB_MODE="$1" PATH="${WORK}/bin:${PATH}" bash -c "
    set -uo pipefail
    ${FALLBACK}
    ${SHORT_BLOCK}
    echo BLOCK_DONE
  " 2>&1
}

echo "--- runtime: hung step ---"
start=$(date +%s)
out="$(run_block hang)"
elapsed=$(( $(date +%s) - start ))
echo "${out}" | grep -q 'command not found' \
  && ok 0 "the block's timeout helper resolves (no 'command not found')" "(${out})" \
  || ok 1 "the block's timeout helper resolves (no 'command not found')"
[ "${elapsed}" -le 15 ] \
  && ok 1 "three hung steps (themes, its no-LLM re-run, outlook) are killed at their bound (${elapsed}s; was unbounded)" \
  || ok 0 "three hung steps are killed at their bound" "(took ${elapsed}s)"
echo "${out}" | grep -q 'BLOCK_DONE' \
  && ok 1 "…and the pipeline continues past them" || ok 0 "…and the pipeline continues past them" "(${out})"
echo "${out}" | grep -q '^\[sector-themes\] \[timeout\] command exceeded 2s' \
  && ok 1 "the kill reason reaches the log through the tail pipe" \
  || ok 0 "the kill reason reaches the log through the tail pipe" "(${out})"
# pipefail makes `if !` see with_timeout's non-zero, not just sed's 0. This is
# what turns a kill into the documented "continuing with prior themes" path.
echo "${out}" | grep -q '^\[sector-themes\] non-zero exit' \
  && ok 1 "a killed sector-themes step is reported as non-zero (pipefail)" \
  || ok 0 "a killed sector-themes step is reported as non-zero" "(${out})"
echo "${out}" | grep -q '^\[sector-outlook\] non-zero exit' \
  && ok 1 "a killed sector-outlook step is reported as non-zero" \
  || ok 0 "a killed sector-outlook step is reported as non-zero" "(${out})"
echo "${out}" | grep -q '^\[sector-themes\] no-LLM re-run also failed' \
  && ok 1 "a hung no-LLM re-run is reported, and the pipeline still continues" \
  || ok 0 "a hung no-LLM re-run is reported" "(${out})"

echo "--- runtime: LLM run killed, no-LLM re-run succeeds ---"
out="$(run_block fail-first)"
echo "${out}" | grep -q '^\[sector-themes\] non-zero exit — re-running on cache + heuristic only' \
  && ok 1 "a dead themes run triggers the no-LLM re-run" \
  || ok 0 "a dead themes run triggers the no-LLM re-run" "(${out})"
echo "${out}" | grep -q '^\[sector-themes\] stub ran: scripts/refresh-sector-news-themes.mjs --max-llm-calls=0$' \
  && ok 1 "…which runs with --max-llm-calls=0 (zero, no network)" \
  || ok 0 "…which runs with --max-llm-calls=0" "(${out})"
echo "${out}" | grep -q 'also failed' \
  && ok 0 "a successful re-run is not reported as a failure" "(${out})" \
  || ok 1 "a successful re-run is not reported as a failure"

echo "--- runtime: healthy step ---"
start=$(date +%s)
out="$(run_block fast)"
elapsed=$(( $(date +%s) - start ))
[ "${elapsed}" -le 2 ] \
  && ok 1 "a fast step is not padded to its timeout (${elapsed}s)" \
  || ok 0 "a fast step is not padded to its timeout" "(took ${elapsed}s)"
echo "${out}" | grep -q '^\[sector-themes\] stub ran: scripts/refresh-sector-news-themes.mjs --max-llm-calls=400' \
  && ok 1 "the command's own output still reaches the log" \
  || ok 0 "the command's own output still reaches the log" "(${out})"
echo "${out}" | grep -q 'non-zero exit' \
  && ok 0 "a successful step is not reported as a failure" "(${out})" \
  || ok 1 "a successful step is not reported as a failure"
echo "${out}" | grep -q -- '--max-llm-calls=0' \
  && ok 0 "a healthy themes run does not trigger the no-LLM re-run" "(${out})" \
  || ok 1 "a healthy themes run does not trigger the no-LLM re-run"

echo ""
echo "=== ${pass} passed, ${fail} failed ==="
[ "${fail}" -eq 0 ]
