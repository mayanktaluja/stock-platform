#!/usr/bin/env bash
# Shared co-run guard for the SWS scrape pipelines.
#
# All four markets (India, US, Korea, Taiwan) share ONE Simply Wall St account +
# cf_clearance cookie. Two scrapes at once double the ban exposure and contend on
# the Chrome profile lock, so the pipelines must NEVER co-run.
#
# Usage — source it, then call with your OWN market code (so it isn't matched
# against itself):
#   . "$(dirname "$0")/sws-corun-guard.sh"
#   corun_guard us || exit 5
#
# Returns 0 if no OTHER market's scraper/orchestrator is live; 5 (and prints the
# offending command) otherwise. bash 3.2 compatible (macOS system bash) — no
# associative arrays.
corun_guard() {
  local SELF="$1"
  local PS M PAT HIT
  # SWS_CORUN_PS_OVERRIDE is a test seam — when set, the guard inspects it
  # instead of the live process table, so test/swsCorunGuard.test.sh can feed
  # synthetic `ps` output deterministically. Unset in every real invocation.
  PS="${SWS_CORUN_PS_OVERRIDE:-$(ps -A -o command= 2>/dev/null)}"
  for M in in us kr tw; do
    [ "${M}" = "${SELF}" ] && continue
    # Anchor each pattern to an actual INVOCATION — a `node …scrape….mjs <shard>`
    # worker or a `bash …refresh….sh` orchestrator — so a mere mention of the
    # script name (an editor, a `cat`, a `gh pr --body` quoting the filename)
    # can't trip the guard. [^|]* keeps the match inside one pipeline segment.
    case "${M}" in
      in) PAT='node[^|]*sws-api-scrape\.mjs[ ]+[123]|bash[^|]*sws-refresh-api\.sh' ;;
      us) PAT='node[^|]*sws-api-scrape-us\.mjs[ ]+[123]|bash[^|]*sws-refresh-us\.sh' ;;
      kr) PAT='node[^|]*sws-api-scrape-region\.mjs.*--region[ ]+kr|bash[^|]*sws-refresh-region\.sh[ ]+kr' ;;
      tw) PAT='node[^|]*sws-api-scrape-region\.mjs.*--region[ ]+tw|bash[^|]*sws-refresh-region\.sh[ ]+tw' ;;
    esac
    # Exclude the guard's own grep plus read-only tooling that legitimately
    # mentions the patterns: `gh pr create --body '…'` (a PR body can quote a
    # script name — the 2026-05-21 false-positive) and the sws-status monitors.
    HIT="$(echo "${PS}" | grep -E "${PAT}" | grep -vE 'grep|gh pr|pr create|--body|sws-status' | head -1 || true)"
    if [ -n "${HIT}" ]; then
      echo "[corun-guard] REFUSING (${SELF}) — a '${M}' SWS scrape is live (shared SWS account/cf_clearance):"
      echo "    ${HIT}"
      echo "[corun-guard] wait for it to finish, then re-run."
      return 5
    fi
  done
  return 0
}
