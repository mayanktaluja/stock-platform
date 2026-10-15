#!/usr/bin/env bash
#
# Pin that both SWS publish paths in scripts/sws-nightly.sh ship the SAME
# generated-artifact list: step 5 (the change check + `git add` before
# assert_health_critical_staged) and republish_conflicted_pr_on_latest_main
# (the rebuild of a CONFLICTING auto-refresh PR on latest origin/main).
#
# WHY THIS EXISTS: those were three hand-copied lists, and the republish copy
# drifted. Step 5 staged data/track-record/section-performance-latest.json and
# data/track-record/paper-trades-live.jsonl; the republish did not, so a
# republished run shipped main's stale Track Record Section Alpha — the
# staleness step 5 exits 8 to avoid when build-section-performance fails.
# Both paths now read the top-level SWS_SHIP_PATHS array.
#
# The test RUNS each consumer with git (and, for the republish, node / tar /
# gh / mktemp) stubbed, and compares the paths it actually passes — so it
# fails however the lists diverge again: a re-introduced literal list, a path
# skipped in one loop, an extra path tacked onto one `git add`. Invariants:
#   1. SWS_SHIP_PATHS is non-empty and duplicate-free.
#   2. It never ships data/macroRegime.json (single-writer rule) or anything
#      under data/sws/deep/ (prod reads only data/sws/deep.tar.gz).
#   3. It covers every HEALTH_CRITICAL_FILES entry, or
#      assert_health_critical_staged would exit 8 on every run.
#   4. Step 5's `git status --short` and `git add` pass exactly SWS_SHIP_PATHS.
#   5. The republish sources exactly SWS_SHIP_PATHS from the PR branch and
#      stages exactly SWS_SHIP_PATHS.
#   6. The republish merges SWS_PAPER_LEDGER per row, never checks it out.
#   7. No hand-maintained path list survives in either consumer.
# The last block mutates each consumer to prove the comparison bites.
#
# Run with: bash test/swsNightlyShipPaths.test.sh

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${HERE}/../scripts/sws-nightly.sh"
pass=0
fail=0

ok()  { pass=$((pass + 1)); echo "  ✓ $1"; }
bad() { fail=$((fail + 1)); echo "  ✗ $1 → $2"; }
check() { if eval "$2"; then ok "$1"; else bad "$1" "${3:-}"; fi; }

# ── extracts ────────────────────────────────────────────────────────────────
SHIP="$(awk '/── SWS ship paths \(extracted verbatim/{f=1} f{print} /── end SWS ship paths/{f=0}' "${SCRIPT}")"
[ -n "${SHIP}" ] || { echo "FAIL: could not extract the SWS_SHIP_PATHS block from ${SCRIPT}"; exit 1; }
FN="$(awk '/── conflicted-PR republish \(extracted verbatim/{f=1} f{print} /── end conflicted-PR republish/{f=0}' "${SCRIPT}")"
[ -n "${FN}" ] || { echo "FAIL: could not extract republish_conflicted_pr_on_latest_main from ${SCRIPT}"; exit 1; }
HEALTH="$(awk '/^HEALTH_CRITICAL_FILES=\(/{f=1} f{print} f&&/^\)/{f=0}' "${SCRIPT}")"
[ -n "${HEALTH}" ] || { echo "FAIL: could not extract HEALTH_CRITICAL_FILES from ${SCRIPT}"; exit 1; }

# Step 5, from its header to the first assert_health_critical_staged call.
STEP5="$(awk '/^# ---- 5\. Commit \+ push ----/{f=1} f{print} f&&/^assert_health_critical_staged$/{exit}' "${SCRIPT}")"
[ -n "${STEP5}" ] || { echo "FAIL: could not extract step 5 from ${SCRIPT}"; exit 1; }
# stmt <regex> — the LAST statement in step 5 whose first line matches, with
# its backslash-continued lines joined (a re-introduced multi-line list too).
stmt() {
  awk -v re="$1" '
    !f && $0 ~ re { f = 1; s = "" }
    f { s = s $0 "\n"; if ($0 !~ /\\$/) { f = 0; last = s } }
    END { printf "%s", last }' <<<"${STEP5}"
}
STATUS_STMT="$(stmt '^CHANGED_FILES=[$][(]git status')"
ADD_STMT="$(stmt '^git add')"
[ -n "${STATUS_STMT}" ] || { echo "FAIL: no CHANGED_FILES=\$(git status ...) statement in step 5"; exit 1; }
[ -n "${ADD_STMT}" ] || { echo "FAIL: no git add statement in step 5"; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/sws-ship-paths-test-$$.XXXXXX")"
trap 'rm -rf "${WORK}"' EXIT

# sorted, de-duplicated set of non-empty lines
set_of() { printf '%s\n' "$1" | sed '/^$/d' | LC_ALL=C sort -u; }

SHIP_LIST="$(eval "${SHIP}"; printf '%s\n' "${SWS_SHIP_PATHS[@]}")"
SHIP_SET="$(set_of "${SHIP_LIST}")"
LEDGER="$(eval "${SHIP}"; printf '%s' "${SWS_PAPER_LEDGER}")"

# step5_args <statement> — pathspecs the statement hands to git (stubbed).
step5_args() {
  : > "${WORK}/step5-args"
  (
    git() {
      shift   # subcommand
      while [ $# -gt 0 ] && [ "${1#-}" != "$1" ]; do shift; done   # --short, --
      printf '%s\n' "$@" > "${WORK}/step5-args"
    }
    eval "${SHIP}"
    eval "$1"
  ) >/dev/null 2>&1
  cat "${WORK}/step5-args"
}

# ── republish stubs: record what is sourced from the branch and staged ──────
mkdir -p "${WORK}/bin"
cat > "${WORK}/bin/git" <<'STUB'
#!/usr/bin/env bash
[ "${1:-}" = -C ] && shift 2
case "${1:-}" in
  checkout)   for last; do :; done; echo "${last}" >> "${LOG_DIR}/checkout" ;;   # checkout <rev> -- <path>
  merge-base) echo 0000000000000000000000000000000000000000 ;;
  add)        shift; [ "${1:-}" = -- ] && shift; printf '%s\n' "$@" >> "${LOG_DIR}/staged" ;;
  diff)       case " $* " in *" --quiet "*) exit 1 ;; esac ;;   # something is staged; no loose deep paths
esac
exit 0   # fetch, branch, worktree, cat-file (branch has the ledger), ls-tree, commit, push
STUB
cat > "${WORK}/bin/node" <<'STUB'
#!/usr/bin/env bash
case " $* " in
  *sws-merge-paper-ledger.mjs*)
    while [ $# -gt 0 ]; do [ "$1" = --path ] && echo "$2" >> "${LOG_DIR}/merged"; shift; done ;;
esac
exit 0   # the sanity gate passes
STUB
cat > "${WORK}/bin/gh" <<'STUB'
#!/usr/bin/env bash
[ "${1:-} ${2:-}" = "pr create" ] && echo "https://github.com/mayanktaluja/stock-platform/pull/2001"
exit 0
STUB
printf '#!/usr/bin/env bash\nexit 0\n' > "${WORK}/bin/tar"
printf '#!/usr/bin/env bash\nmkdir -p "%s/wt" && echo "%s/wt"\n' "${WORK}" "${WORK}" > "${WORK}/bin/mktemp"
chmod +x "${WORK}/bin/"*

# run_republish <function body> — runs it against a throwaway worktree holding
# every ship path, so the staging loop is limited only by SWS_SHIP_PATHS.
run_republish() {
  local logs="${WORK}/logs"
  rm -rf "${logs}" "${WORK}/wt"
  mkdir -p "${logs}" "${WORK}/wt"
  : > "${logs}/checkout"; : > "${logs}/merged"; : > "${logs}/staged"
  local p
  while IFS= read -r p; do
    case "${p}" in
      */) mkdir -p "${WORK}/wt/${p}" ;;
      *)  mkdir -p "$(dirname "${WORK}/wt/${p}")" && : > "${WORK}/wt/${p}" ;;
    esac
  done <<<"${SHIP_LIST}"
  {
    echo 'set -uo pipefail'
    echo "REPO_DIR=\"${WORK}/no-repo\""
    echo 'RUN_LABEL="2026-10-14 00:30"'
    echo 'COMMIT_BODY="fixture body"'
    # sws-nightly.sh sources the push helper at startup; the extract doesn't.
    echo ". \"${HERE}/../scripts/sws-git-push.sh\""
    printf '%s\n' "${SHIP}"
    printf '%s\n' "$1"
    echo 'republish_conflicted_pr_on_latest_main https://github.com/mayanktaluja/stock-platform/pull/1649 chore/sws-auto-refresh-x'
    echo 'echo "RESULT_RC=$?"'
  } > "${WORK}/driver.sh"
  ( PATH="${WORK}/bin:${PATH}" LOG_DIR="${logs}" bash "${WORK}/driver.sh" 2>&1 )
}
sourced() { set_of "$(cat "${WORK}/logs/checkout" "${WORK}/logs/merged")"; }
staged()  { set_of "$(grep -v '^reports/sws-picks$' "${WORK}/logs/staged")"; }

echo "SWS ship paths"

# ── 1-3. the array itself ───────────────────────────────────────────────────
check "SWS_SHIP_PATHS is non-empty" '[ -n "${SHIP_SET}" ]'
DUPES="$(printf '%s\n' "${SHIP_LIST}" | LC_ALL=C sort | uniq -d)"
check "SWS_SHIP_PATHS has no duplicates" '[ -z "${DUPES}" ]' "${DUPES}"
check "SWS_SHIP_PATHS excludes data/macroRegime.json (single-writer rule)" \
  '! grep -qx "data/macroRegime.json" <<<"${SHIP_SET}"'
check "SWS_SHIP_PATHS ships nothing under data/sws/deep/ (prod reads deep.tar.gz)" \
  '! grep -q "^data/sws/deep/\|^data/sws/deep$" <<<"${SHIP_SET}" && ! grep -qx "data/sws/" <<<"${SHIP_SET}" && ! grep -qx "data/" <<<"${SHIP_SET}"' "${SHIP_SET}"
check "SWS_SHIP_PATHS ships the Track Record artifacts" \
  'grep -qx "data/track-record/section-performance-latest.json" <<<"${SHIP_SET}" && grep -qx "${LEDGER}" <<<"${SHIP_SET}"'
UNCOVERED=""
while IFS= read -r h; do
  covered=""
  while IFS= read -r p; do
    case "${p}" in
      */) [ "${h#"${p}"}" != "${h}" ] && covered=1 ;;
      *)  [ "${h}" = "${p}" ] && covered=1 ;;
    esac
  done <<<"${SHIP_SET}"
  [ -n "${covered}" ] || UNCOVERED+="${h} "
done <<<"$(eval "${HEALTH}"; printf '%s\n' "${HEALTH_CRITICAL_FILES[@]}")"
check "every HEALTH_CRITICAL_FILES entry is shipped" '[ -z "${UNCOVERED}" ]' "${UNCOVERED}"

# ── 4. step 5 ───────────────────────────────────────────────────────────────
STATUS_SET="$(set_of "$(step5_args "${STATUS_STMT}")")"
ADD_SET="$(set_of "$(step5_args "${ADD_STMT}")")"
check "step 5 change check (git status --short) inspects exactly SWS_SHIP_PATHS" \
  '[ "${STATUS_SET}" = "${SHIP_SET}" ]' "$(diff <(echo "${SHIP_SET}") <(echo "${STATUS_SET}") | tr '\n' ' ')"
check "step 5 git add stages exactly SWS_SHIP_PATHS" \
  '[ "${ADD_SET}" = "${SHIP_SET}" ]' "$(diff <(echo "${SHIP_SET}") <(echo "${ADD_SET}") | tr '\n' ' ')"

# ── 5-6. the conflicted-PR republish ────────────────────────────────────────
OUT="$(run_republish "${FN}")"
check "republish runs to completion under the stubs" 'grep -q "RESULT_RC=0" <<<"${OUT}"' "${OUT}"
SOURCED="$(sourced)"
STAGED="$(staged)"
check "republish sources exactly SWS_SHIP_PATHS from the PR branch" \
  '[ "${SOURCED}" = "${SHIP_SET}" ]' "$(diff <(echo "${SHIP_SET}") <(echo "${SOURCED}") | tr '\n' ' ')"
check "republish stages exactly SWS_SHIP_PATHS" \
  '[ "${STAGED}" = "${SHIP_SET}" ]' "$(diff <(echo "${SHIP_SET}") <(echo "${STAGED}") | tr '\n' ' ')"
check "republish and step 5 stage the same set" '[ "${STAGED}" = "${ADD_SET}" ]'
check "the ledger is merged per row, never checked out over main's copy" \
  'grep -qx "${LEDGER}" "${WORK}/logs/merged" && ! grep -qx "${LEDGER}" "${WORK}/logs/checkout"' \
  "merged: $(cat "${WORK}/logs/merged") checkout-has-ledger: $(grep -cx "${LEDGER}" "${WORK}/logs/checkout")"

# ── 7. one list, not copies ─────────────────────────────────────────────────
# A bare path line (optionally backslash-continued) is how every hand list in
# this script was written.
LITERAL='^[[:space:]]+(data/|fundamentals|surveillance|governance)[^[:space:]]*([[:space:]]+\\)?$'
check "step 5 holds no hand-maintained path list" '! grep -Eq "${LITERAL}" <<<"${STEP5}"' \
  "$(grep -E "${LITERAL}" <<<"${STEP5}" | head -3)"
check "the republish holds no hand-maintained path list" '! grep -Eq "${LITERAL}" <<<"${FN}"' \
  "$(grep -E "${LITERAL}" <<<"${FN}" | head -3)"

# ── mutations: prove the comparisons bite ───────────────────────────────────
# The 2026-10 drift: the republish loops over a list that lacks data/track-record/*.
DRIFTED="$(sed 's|for path in "${SWS_SHIP_PATHS\[@\]}"; do|for path in $(printf "%s\\n" "${SWS_SHIP_PATHS[@]}" \| grep -v "^data/track-record/"); do|' <<<"${FN}")"
check "mutation applied (republish loops skip data/track-record/*)" '[ "${DRIFTED}" != "${FN}" ]'
run_republish "${DRIFTED}" >/dev/null
check "a republish that drops data/track-record/* is caught" \
  '[ "$(sourced)" != "${SHIP_SET}" ] && [ "$(staged)" != "${SHIP_SET}" ]'
EXTRA_ADD="${ADD_STMT%$'\n'} data/macroRegime.json"
check "a step-5 git add with an extra path is caught" \
  '[ "$(set_of "$(step5_args "${EXTRA_ADD}")")" != "${SHIP_SET}" ]'

echo ""
echo "${pass} passed, ${fail} failed"
[ "${fail}" -eq 0 ]
