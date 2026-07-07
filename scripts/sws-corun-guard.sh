#!/usr/bin/env bash
# Shared co-run guard for the SWS scrape pipelines.
#
# Both pipelines (India, US) share ONE Simply Wall St account +
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
  PS="$(ps -A -o command= 2>/dev/null)"
  for M in in us; do
    [ "${M}" = "${SELF}" ] && continue
    case "${M}" in
      in) PAT='sws-api-scrape\.mjs[ ]+[123]|sws-refresh-api\.sh' ;;
      us) PAT='sws-api-scrape-us\.mjs[ ]+[123]|sws-refresh-us\.sh' ;;
    esac
    HIT="$(echo "${PS}" | grep -E "${PAT}" | grep -v grep | head -1 || true)"
    if [ -n "${HIT}" ]; then
      echo "[corun-guard] REFUSING (${SELF}) — a '${M}' SWS scrape is live (shared SWS account/cf_clearance):"
      echo "    ${HIT}"
      echo "[corun-guard] wait for it to finish, then re-run."
      return 5
    fi
  done
  return 0
}
