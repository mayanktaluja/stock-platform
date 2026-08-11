#!/usr/bin/env bash
#
# Test the PR create + reconcile block in scripts/sws-nightly.sh.
#
# WHY THIS EXISTS: on 2026-08-11 the nightly finished a clean full-universe
# rescan, committed 84 files, pushed the branch — and then `gh pr create`
# returned `HTTP 502: 502 Bad Gateway (https://api.github.com/graphql)`. The
# createPullRequest mutation had ALREADY committed server-side: the PR existed
# as #1272. But gh reported rc=1, the old code treated that as "no PR was
# created", mailed the operator and exited 8. The auto-merge step never ran, so
# the PR sat open with every required check green (Smoke + unit tests, E2E,
# Vercel all SUCCESS) until a human merged it 4h25m later. Production served
# day-old data the whole time, and the PR timeline confirms no
# auto_merge_enabled event was ever recorded.
#
# The same 502-after-commit was observed independently on `gh pr merge` that
# night — the merge landed at 20:36:22Z while gh printed a 502 body.
#
# The invariant under test: a non-zero gh rc means "outcome unknown", never
# "nothing happened". The block must reconcile against the head branch (the
# authoritative server state) before declaring failure, and must never open a
# second PR for a branch that already has one open.
#
# Run with: bash test/swsNightlyPrReconcile.test.sh

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${HERE}/../scripts/sws-nightly.sh"
pass=0
fail=0

ok()  { pass=$((pass + 1)); echo "  ✓ $1"; }
bad() { fail=$((fail + 1)); echo "  ✗ $1 → $2"; }

BLOCK="$(awk '/extracted verbatim by test\/swsNightlyPrReconcile/{f=1} f{print} /end PR create . reconcile/{f=0}' "${SCRIPT}")"
[ -n "${BLOCK}" ] || { echo "FAIL: could not extract the PR create + reconcile block from ${SCRIPT}"; exit 1; }

WORK="$(mktemp -d)"
cleanup() { rm -rf "${WORK}"; }
trap cleanup EXIT
mkdir -p "${WORK}/bin"

# Stub gh. Behaviour is driven by GH_CREATE_MODE / GH_LIST_MODE so each case can
# script an exact server response sequence. Every subcommand invocation appends a
# marker to GH_CALL_LOG so the assertions can count calls — this is how the
# no-duplicate-PR guarantee is verified.
cat > "${WORK}/bin/gh" <<'STUB'
#!/usr/bin/env bash
log_call() { echo "$1" >> "${GH_CALL_LOG}"; }
# grep -c counts LINES, which is what we want: one marker per line. It prints
# "0" AND exits 1 on no-match, so a `|| echo 0` fallback would emit TWO zeros
# and poison the integer comparisons — assign, don't append.
count_calls() { local n; n="$(grep -c "^$1\$" "${GH_CALL_LOG}" 2>/dev/null)"; echo "${n:-0}"; }

[ "${1:-}" = "pr" ] || exit 0
shift
case "${1:-}" in
  create)
    log_call pr-create
    n="$(count_calls pr-create)"
    case "${GH_CREATE_MODE}" in
      ok)
        echo "https://github.com/mayanktaluja/stock-platform/pull/999"; exit 0 ;;
      502)
        # Verbatim shape of the 2026-08-11 failure, warning line included.
        echo "Warning: 5454 uncommitted changes"
        echo "pull request create failed: HTTP 502: 502 Bad Gateway (https://api.github.com/graphql)"
        exit 1 ;;
      fail)
        echo "pull request create failed: GraphQL: Head sha can't be blank"; exit 1 ;;
      ok_on_second)
        if [ "${n}" -ge 2 ]; then
          echo "https://github.com/mayanktaluja/stock-platform/pull/777"; exit 0
        fi
        echo "pull request create failed: HTTP 502: 502 Bad Gateway"; exit 1 ;;
      rc0_no_url)
        # rc=0 but the URL is unparseable — must not be accepted blindly.
        echo "Warning: something odd happened"; exit 0 ;;
    esac
    ;;
  list)
    log_call pr-list
    n="$(count_calls pr-list)"
    case "${GH_LIST_MODE}" in
      empty) exit 0 ;;
      url)   echo "https://github.com/mayanktaluja/stock-platform/pull/1272"; exit 0 ;;
      empty_then_url)
        [ "${n}" -ge 2 ] && echo "https://github.com/mayanktaluja/stock-platform/pull/1272"
        exit 0 ;;
    esac
    ;;
esac
exit 0
STUB
chmod +x "${WORK}/bin/gh"

# Drive one scenario. Echoes the block's stdout plus a RESULT_/EXIT_ trailer.
run_case() {
  local create_mode="$1" list_mode="$2" attempts="$3"
  local driver="${WORK}/driver.sh"
  : > "${WORK}/gh-calls.log"

  {
    echo 'set -uo pipefail'
    echo 'BRANCH="chore/sws-auto-refresh-2026-08-12-0030"'
    echo 'RUN_LABEL="2026-08-12 00:30"'
    echo 'PR_BODY="test body"'
    echo 'ts() { echo "2026-08-12 00:30:00 IST"; }'
    echo 'send_mail() { echo "MAIL_SENT: $1"; }'
    printf '%s\n' "${BLOCK}"
    echo 'echo "RESULT_PR_URL=${PR_URL}"'
  } > "${driver}"

  PATH="${WORK}/bin:${PATH}" \
  GH_CALL_LOG="${WORK}/gh-calls.log" \
  GH_CREATE_MODE="${create_mode}" \
  GH_LIST_MODE="${list_mode}" \
  SWS_NIGHTLY_PR_CREATE_ATTEMPTS="${attempts}" \
  SWS_NIGHTLY_PR_RETRY_BASE_SECONDS=0 \
    bash "${driver}" 2>&1
  echo "EXIT_CODE=$?"
}

# See the note on count_calls in the stub: grep -c prints "0" and exits 1, so an
# `|| echo 0` fallback would emit two zeros and every comparison would fail.
calls_of() { local n; n="$(grep -c "^$1\$" "${WORK}/gh-calls.log" 2>/dev/null)"; echo "${n:-0}"; }

echo "PR create + reconcile"

# ── 1. Happy path ───────────────────────────────────────────────────────────
OUT="$(run_case ok empty 3)"
if grep -q 'RESULT_PR_URL=https://github.com/mayanktaluja/stock-platform/pull/999' <<<"${OUT}" \
   && grep -q 'EXIT_CODE=0' <<<"${OUT}"; then
  ok "clean create adopts the URL gh printed"
else
  bad "clean create adopts the URL gh printed" "${OUT}"
fi
if [ "$(calls_of pr-create)" = "1" ]; then
  ok "clean create calls gh pr create exactly once"
else
  bad "clean create calls gh pr create exactly once" "calls=$(calls_of pr-create)"
fi

# ── 2. THE REGRESSION: 502 after the mutation committed ─────────────────────
OUT="$(run_case 502 empty_then_url 3)"
if grep -q 'RESULT_PR_URL=https://github.com/mayanktaluja/stock-platform/pull/1272' <<<"${OUT}" \
   && grep -q 'EXIT_CODE=0' <<<"${OUT}"; then
  ok "502-after-commit reconciles to the PR that actually exists"
else
  bad "502-after-commit reconciles to the PR that actually exists" "${OUT}"
fi
if grep -q 'reconciled to https' <<<"${OUT}"; then
  ok "502 reconcile is logged, not silent"
else
  bad "502 reconcile is logged, not silent" "${OUT}"
fi
if ! grep -q 'MAIL_SENT' <<<"${OUT}"; then
  ok "502-after-commit does not page the operator"
else
  bad "502-after-commit does not page the operator" "${OUT}"
fi

# ── 3. No duplicate PR when the branch already has one open ─────────────────
OUT="$(run_case fail url 3)"
if grep -q 'RESULT_PR_URL=https://github.com/mayanktaluja/stock-platform/pull/1272' <<<"${OUT}" \
   && [ "$(calls_of pr-create)" = "0" ]; then
  ok "pre-existing open PR is adopted without a second gh pr create"
else
  bad "pre-existing open PR is adopted without a second gh pr create" "calls=$(calls_of pr-create) ${OUT}"
fi

# ── 4. Genuine failure still exits 8 and mails ──────────────────────────────
OUT="$(run_case fail empty 2)"
if grep -q 'EXIT_CODE=8' <<<"${OUT}" && grep -q 'MAIL_SENT' <<<"${OUT}"; then
  ok "genuine create failure still exits 8 and mails the operator"
else
  bad "genuine create failure still exits 8 and mails the operator" "${OUT}"
fi
if [ "$(calls_of pr-create)" = "2" ]; then
  ok "genuine failure exhausts the configured attempt budget"
else
  bad "genuine failure exhausts the configured attempt budget" "calls=$(calls_of pr-create)"
fi

# ── 5. Transient failure then success ───────────────────────────────────────
OUT="$(run_case ok_on_second empty 3)"
if grep -q 'RESULT_PR_URL=https://github.com/mayanktaluja/stock-platform/pull/777' <<<"${OUT}" \
   && grep -q 'EXIT_CODE=0' <<<"${OUT}"; then
  ok "transient 502 retries and succeeds on the next attempt"
else
  bad "transient 502 retries and succeeds on the next attempt" "${OUT}"
fi

# ── 6. rc=0 with an unparseable URL must not be accepted ────────────────────
OUT="$(run_case rc0_no_url empty 1)"
if grep -q 'EXIT_CODE=8' <<<"${OUT}"; then
  ok "rc=0 with no parseable URL is treated as failure, not an empty PR ref"
else
  bad "rc=0 with no parseable URL is treated as failure, not an empty PR ref" "${OUT}"
fi

# ── 7. The merge path carries the same guard ────────────────────────────────
if grep -q 'pr_is_merged "\${PR_URL}"' "${SCRIPT}"; then
  ok "merge failure path confirms server state before paging (pr_is_merged)"
else
  bad "merge failure path confirms server state before paging (pr_is_merged)" "guard missing"
fi

echo
echo "  ${pass} passed, ${fail} failed"
[ "${fail}" -eq 0 ] || exit 1
