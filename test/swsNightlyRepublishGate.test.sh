#!/usr/bin/env bash
#
# Test republish_conflicted_pr_on_latest_main in scripts/sws-nightly.sh — the
# path that rebuilds a CONFLICTING SWS auto-refresh PR on latest origin/main.
#
# WHY THIS EXISTS: that path builds a throwaway worktree from origin/main,
# copies the generated-artifact allow-list from the PR branch and re-runs
# scripts/sws-sanity-gate.mjs there. The gate's fresh_pct_floor BLOCK (and the
# price-freshness layer) read the LOOSE data/sws/deep/*.json briefs — but the
# nightly never commits those: it ships data/sws/deep.tar.gz, and the ~5.5k
# loose files still tracked on main are frozen at 2026-06-15. So the republish
# gate measured fresh_pct = 0/5307 and BLOCKED every time. #1443 (2026-09-04)
# and #1649 (2026-10-10) sat CONFLICTING with auto-merge armed and never merged;
# prod India SWS data went 16 days stale until the hand-replayed #1681.
#
# The invariants under test:
#   1. The republish gate measures the PR branch's tarball (what prod serves),
#      not main's frozen loose files: fresh tarball + stale loose files → ships.
#   2. A stale tarball still BLOCKs — the fix must not bypass the gate.
#   3. An unextractable tarball fails closed before the gate runs.
#   4. The extracted loose briefs never reach the recovery commit, even if a
#      future edit widens the allow-list to cover data/sws/deep/.
#   5. node_modules is linked into the throwaway worktree (the gate needs it).
#   6. The recovery commit ships the Track Record artifacts step 5 ships: the
#      branch's section-performance-latest.json (the republish allow-list used
#      to lack it, re-shipping main's stale Section Alpha), and a per-row merge
#      of paper-trades-live.jsonl that keeps the row main gained after the fork.
#   7. An unmergeable ledger fails closed: nothing pushed.
#
# The function reads the top-level SWS_SHIP_PATHS array, so the driver loads
# that block (also extracted verbatim) ahead of the function.
#
# The fixture's scripts/sws-sanity-gate.mjs runs the REAL gate from this repo
# against the throwaway worktree, then gates only on fresh_pct_floor: the rest
# of the real gate wants a full nightly's artifacts this fixture doesn't build.
#
# Run with: bash test/swsNightlyRepublishGate.test.sh

set -uo pipefail

# git hooks export GIT_DIR & co. into child processes; under `npm test` from
# .githooks/pre-push they would retarget every fixture git command below at
# the REAL repository. Scrub before touching git.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
      GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_PREFIX GIT_COMMON_DIR \
      GIT_QUARANTINE_PATH GIT_INTERNAL_SUPER_PREFIX

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${HERE}/../scripts/sws-nightly.sh"
REAL_GATE="${HERE}/../scripts/sws-sanity-gate.mjs"
pass=0
fail=0

ok()  { pass=$((pass + 1)); echo "  ✓ $1"; }
bad() { fail=$((fail + 1)); echo "  ✗ $1 → $2"; }
check() { if eval "$2"; then ok "$1"; else bad "$1" "${3:-}"; fi; }

FN="$(awk '/── conflicted-PR republish \(extracted verbatim/{f=1} f{print} /── end conflicted-PR republish/{f=0}' "${SCRIPT}")"
[ -n "${FN}" ] || { echo "FAIL: could not extract republish_conflicted_pr_on_latest_main from ${SCRIPT}"; exit 1; }
SHIP="$(awk '/── SWS ship paths \(extracted verbatim/{f=1} f{print} /── end SWS ship paths/{f=0}' "${SCRIPT}")"
[ -n "${SHIP}" ] || { echo "FAIL: could not extract the SWS_SHIP_PATHS block from ${SCRIPT}"; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/sws-republish-test-$$.XXXXXX")"
trap 'rm -rf "${WORK}"' EXIT
mkdir -p "${WORK}/bin" "${WORK}/tmp"
export COPYFILE_DISABLE=1   # no macOS AppleDouble entries in fixture tarballs

NOW_ISO="$(node -e 'console.log(new Date().toISOString())')"
FRESH_ISO="$(node -e 'console.log(new Date(Date.now() - 3600e3).toISOString())')"
STALE_ISO="2026-06-15T00:51:07.473Z"   # what main's tracked loose briefs carry

# ── gh stub: logs every subcommand; pr create prints a recovery URL ─────────
cat > "${WORK}/bin/gh" <<'STUB'
#!/usr/bin/env bash
echo "$1-$2" >> "${GH_CALL_LOG}"
[ "$1 $2" = "pr create" ] && echo "https://github.com/mayanktaluja/stock-platform/pull/2001"
exit 0
STUB
chmod +x "${WORK}/bin/gh"

# ── fixture origin ──────────────────────────────────────────────────────────
ORIGIN="${WORK}/origin.git"
SEED="${WORK}/seed"
CLONE="${WORK}/clone"
# Pin the branch name: the fixture checks out / pushes "main" by name, and a
# runner without init.defaultBranch (GitHub Actions) would create "master".
git init -q --bare --initial-branch=main "${ORIGIN}"
git init -q --initial-branch=main "${SEED}"
git -C "${SEED}" config user.email t@t
git -C "${SEED}" config user.name t
git -C "${SEED}" remote add origin "${ORIGIN}"

brief() {  # brief <dir> <ticker> <parsed_at>
  printf '{"ticker":"%s","parsed_at":"%s","price":{"last":100}}\n' "$2" "$3" > "$1/$2.json"
}
universe() {  # universe <ticker>...
  local t sep="" out="["
  for t in "$@"; do out+="${sep}{\"ticker\":\"${t}\",\"slug\":\"${t}\"}"; sep=","; done
  echo "${out}]" > "${SEED}/data/sws/universe.json"
}
LEDGER="data/track-record/paper-trades-live.jsonl"
SECTION_PERF="data/track-record/section-performance-latest.json"
row() {  # row <id> [closingPrice] — one ledger line as FileStorage writes it
  if [ -n "${2:-}" ]; then
    printf '{"id":"%s","type":"sws","closingPrice":%s}\n' "$1" "$2"
  else
    printf '{"id":"%s","type":"sws"}\n' "$1"
  fi
}
pack() {  # pack <parsed_at> <ticker>... — same layout as scripts/sws-pack-deep.sh
  local at="$1" t stage
  shift
  stage="$(mktemp -d "${WORK}/stage.XXXXXX")"
  mkdir -p "${stage}/deep"
  for t in "$@"; do brief "${stage}/deep" "${t}" "${at}"; done
  tar -czf "${SEED}/data/sws/deep.tar.gz" -C "${stage}" deep
}

mkdir -p "${SEED}/scripts" "${SEED}/data/sws/deep" "${SEED}/data/track-record"
cp "${HERE}/../scripts/sws-merge-paper-ledger.mjs" "${SEED}/scripts/"
cat > "${SEED}/scripts/sws-sanity-gate.mjs" <<'SHIM'
import { spawnSync } from "child_process";
import { existsSync, readFileSync, rmSync } from "fs";
const report = "data/sws/_sanity/_latest.json";
rmSync(report, { force: true });   // never read a report copied from the branch
spawnSync(process.execPath, [process.env.REAL_SANITY_GATE], { stdio: "ignore" });
const checks = Object.values(JSON.parse(readFileSync(report, "utf-8")).layers)
  .flatMap((l) => l.checks);
const fresh = checks.find((c) => c.name === "fresh_pct_floor");
console.log(`FIXTURE_FRESH_PCT=${fresh?.detail?.fresh_pct} ok=${fresh?.ok}`);
console.log(`FIXTURE_NODE_MODULES=${existsSync("node_modules/.fixture-marker") ? "linked" : "missing"}`);
process.exit(fresh?.ok ? 0 : 1);
SHIM
# Mirror the real repo: loose briefs are gitignored, yet still tracked (force-added).
printf '%s\n' 'data/sws/deep/*.json' 'node_modules/' > "${SEED}/.gitignore"
for t in AAA BBB CCC DDD EEE; do brief "${SEED}/data/sws/deep" "${t}" "${STALE_ISO}"; done
universe AAA BBB CCC DDD EEE
pack "${STALE_ISO}" AAA BBB CCC DDD EEE
echo "{\"finished_at\":\"${STALE_ISO}\"}" > "${SEED}/data/sws/last-refresh.json"
echo '{"scanned_at":"2026-06-15"}' > "${SEED}/data/sws/picks-latest.json"
echo '{"generated_at":"2026-06-15"}' > "${SEED}/${SECTION_PERF}"
{ row a; row b; } > "${SEED}/${LEDGER}"
git -C "${SEED}" add -A
git -C "${SEED}" add -f data/sws/deep
git -C "${SEED}" commit -qm "main: loose briefs frozen 2026-06-15"
git -C "${SEED}" push -q origin HEAD:main

# Nightly branches fork here. Like the real nightly they commit the tarball +
# allow-listed JSON and never the loose briefs. FFF is a brand-new ticker that
# exists only inside the tarball (untracked + ignored once extracted). Each
# run rebuilds Section Alpha, resolves ledger row a and appends today's row c.
nightly_branch() {  # nightly_branch <name> <tarball parsed_at|corrupt> [bad-ledger]
  git -C "${SEED}" checkout -q -b "$1" main
  universe AAA BBB CCC DDD EEE FFF
  if [ "$2" = corrupt ]; then
    echo "not a gzip stream" > "${SEED}/data/sws/deep.tar.gz"
  else
    pack "$2" AAA BBB CCC DDD EEE FFF
  fi
  echo "{\"finished_at\":\"${NOW_ISO}\"}" > "${SEED}/data/sws/last-refresh.json"
  echo "{\"scanned_at\":\"${NOW_ISO}\"}" > "${SEED}/data/sws/picks-latest.json"
  echo "{\"generated_at\":\"${NOW_ISO}\"}" > "${SEED}/${SECTION_PERF}"
  if [ "${3:-}" = bad-ledger ]; then
    { row a 120; row b; row b; } > "${SEED}/${LEDGER}"   # duplicate id: unkeyable
  else
    { row a 120; row b; row c; } > "${SEED}/${LEDGER}"
  fi
  git -C "${SEED}" add -A
  git -C "${SEED}" commit -qm "chore(sws): auto-refresh $1"
  git -C "${SEED}" push -q origin "$1"
  git -C "${SEED}" checkout -q main
}
nightly_branch chore/sws-auto-refresh-fresh  "${FRESH_ISO}"
nightly_branch chore/sws-auto-refresh-stale  "${STALE_ISO}"
nightly_branch chore/sws-auto-refresh-broken corrupt
nightly_branch chore/sws-auto-refresh-guard  "${FRESH_ISO}"
nightly_branch chore/sws-auto-refresh-ledger "${FRESH_ISO}" bad-ledger

# main advances while the nightly waits for auto-merge → the PRs conflict. The
# commit that lands first is an earlier run's ship: it also appends ledger row
# m, which a blind checkout of the branch's ledger would drop.
echo '{"scanned_at":"main-moved-on"}' > "${SEED}/data/sws/picks-latest.json"
row m >> "${SEED}/${LEDGER}"
git -C "${SEED}" commit -qam "main: an earlier run's ship lands first"
git -C "${SEED}" push -q origin HEAD:main

git clone -q "${ORIGIN}" "${CLONE}"
git -C "${CLONE}" config user.email t@t
git -C "${CLONE}" config user.name t
mkdir -p "${CLONE}/node_modules" && touch "${CLONE}/node_modules/.fixture-marker"

# run_case <source branch> [ship-paths block] — prints the function's output
# plus a RESULT_ trailer. Both blocks default to the verbatim extracts.
run_case() {
  local branch="$1" ship="${2:-${SHIP}}"
  : > "${WORK}/gh-calls.log"
  {
    echo 'set -uo pipefail'
    echo "REPO_DIR=\"${CLONE}\""
    echo 'RUN_LABEL="2026-10-10 00:30"'
    echo 'COMMIT_BODY="fixture body"'
    echo "BRANCH=\"${branch}\""
    echo 'PR_URL="https://github.com/mayanktaluja/stock-platform/pull/1649"'
    # sws-nightly.sh sources the push helper at startup; the extract doesn't.
    echo ". \"${HERE}/../scripts/sws-git-push.sh\""
    printf '%s\n' "${ship}"
    printf '%s\n' "${FN}"
    echo 'republish_conflicted_pr_on_latest_main "${PR_URL}" "${BRANCH}"'
    echo 'echo "RESULT_RC=$? RESULT_PR_URL=${PR_URL}"'
  } > "${WORK}/driver.sh"
  ( cd "${CLONE}" && PATH="${WORK}/bin:${PATH}" TMPDIR="${WORK}/tmp" \
      GH_CALL_LOG="${WORK}/gh-calls.log" REAL_SANITY_GATE="${REAL_GATE}" \
      bash "${WORK}/driver.sh" 2>&1 )
}
recovery_ref() { git -C "${CLONE}" ls-remote --heads origin "$1-rebase-*" | awk '{print $2}' | head -1; }
gh_calls() { local n; n="$(grep -c "^$1\$" "${WORK}/gh-calls.log" 2>/dev/null)"; echo "${n:-0}"; }
worktrees() { git -C "${CLONE}" worktree list | wc -l | tr -d ' '; }

echo "conflicted-PR republish gate"

# ── 1. fresh tarball, frozen loose briefs → gate passes, recovery ships ─────
OUT="$(run_case chore/sws-auto-refresh-fresh)"
check "fresh tarball over frozen loose briefs: republish returns 0" \
  'grep -q "RESULT_RC=0 " <<<"${OUT}"' "${OUT}"
check "republish gate measured the branch tarball (fresh_pct=100)" \
  'grep -q "FIXTURE_FRESH_PCT=100 ok=true" <<<"${OUT}"' "${OUT}"
check "node_modules is linked into the throwaway worktree" \
  'grep -q "FIXTURE_NODE_MODULES=linked" <<<"${OUT}"' "${OUT}"
check "PR_URL moves to the recovery PR" \
  'grep -q "RESULT_PR_URL=https://github.com/mayanktaluja/stock-platform/pull/2001" <<<"${OUT}"' "${OUT}"
check "gh pr create called once, auto-merge armed" \
  '[ "$(gh_calls pr-create)" = 1 ] && [ "$(gh_calls pr-merge)" -ge 1 ]' "$(cat "${WORK}/gh-calls.log")"
REC="$(recovery_ref chore/sws-auto-refresh-fresh)"
check "recovery branch was pushed" '[ -n "${REC}" ]' "no -rebase-* head on origin"
if [ -n "${REC}" ]; then
  git -C "${CLONE}" fetch -q origin "${REC}:refs/remotes/test/recovery"
  CHANGED="$(git -C "${CLONE}" diff --name-only origin/main test/recovery)"
  check "recovery commit ships the branch's deep.tar.gz blob" \
    '[ "$(git -C "${CLONE}" rev-parse test/recovery:data/sws/deep.tar.gz)" = "$(git -C "${CLONE}" rev-parse origin/chore/sws-auto-refresh-fresh:data/sws/deep.tar.gz)" ]'
  check "recovery commit touches no loose data/sws/deep/ path" \
    '! grep -q "^data/sws/deep/" <<<"${CHANGED}"' "${CHANGED}"
  check "recovery commit ships the branch's Section Alpha (was missing from the republish list)" \
    '[ "$(git -C "${CLONE}" rev-parse "test/recovery:${SECTION_PERF}")" = "$(git -C "${CLONE}" rev-parse "origin/chore/sws-auto-refresh-fresh:${SECTION_PERF}")" ]'
  REC_LEDGER="$(git -C "${CLONE}" show "test/recovery:${LEDGER}")"
  WANT_LEDGER="$(row a 120; row b; row m; row c)"
  check "recovery ledger = per-row merge: branch's resolution + new row, main's interim row kept" \
    '[ "${REC_LEDGER}" = "${WANT_LEDGER}" ]' "${REC_LEDGER}"
  check "ledger merge is logged" 'grep -q "\[ledger-merge\] merged .*main_only=1" <<<"${OUT}"' "${OUT}"
fi
check "throwaway worktree removed" '[ "$(worktrees)" = 1 ]' "$(git -C "${CLONE}" worktree list)"

# ── 2. stale tarball → the gate still blocks ────────────────────────────────
OUT="$(run_case chore/sws-auto-refresh-stale)"
check "stale tarball: republish returns 1" 'grep -q "RESULT_RC=1 " <<<"${OUT}"' "${OUT}"
check "stale tarball: fresh_pct_floor blocks (fresh_pct=0)" \
  'grep -q "FIXTURE_FRESH_PCT=0 ok=false" <<<"${OUT}" && grep -q "republish sanity gate failed" <<<"${OUT}"' "${OUT}"
check "stale tarball: nothing pushed, no PR opened" \
  '[ -z "$(recovery_ref chore/sws-auto-refresh-stale)" ] && [ "$(gh_calls pr-create)" = 0 ]'
check "stale tarball: throwaway worktree removed" '[ "$(worktrees)" = 1 ]'

# ── 3. unextractable tarball → fail closed before the gate ──────────────────
OUT="$(run_case chore/sws-auto-refresh-broken)"
check "corrupt tarball: republish returns 1" 'grep -q "RESULT_RC=1 " <<<"${OUT}"' "${OUT}"
check "corrupt tarball: refused at extraction, gate never ran" \
  'grep -q "could not extract" <<<"${OUT}" && ! grep -q "FIXTURE_FRESH_PCT" <<<"${OUT}"' "${OUT}"
check "corrupt tarball: nothing pushed" '[ -z "$(recovery_ref chore/sws-auto-refresh-broken)" ]'

# ── 4. allow-list widened to data/sws/deep/ → staging guard refuses ─────────
# A gate that passes plus an allow-list that sweeps in the extracted briefs:
# only the staged-path guard stands between that and committing ~5.5k files.
WIDENED="$(awk '{print} /^  data\/sws\/deep\.tar\.gz$/{print "  data/sws/deep/"}' <<<"${SHIP}")"
check "mutation applied (allow-list now includes data/sws/deep/)" \
  'grep -q "^  data/sws/deep/$" <<<"${WIDENED}"'
OUT="$(run_case chore/sws-auto-refresh-guard "${WIDENED}")"
check "widened allow-list: gate passed, so only the guard can stop it" \
  'grep -q "FIXTURE_FRESH_PCT=100 ok=true" <<<"${OUT}"' "${OUT}"
check "widened allow-list: republish refuses loose deep paths" \
  'grep -q "RESULT_RC=1 " <<<"${OUT}" && grep -q "loose data/sws/deep/" <<<"${OUT}"' "${OUT}"
check "widened allow-list: nothing pushed, no PR opened" \
  '[ -z "$(recovery_ref chore/sws-auto-refresh-guard)" ] && [ "$(gh_calls pr-create)" = 0 ]'
check "widened allow-list: throwaway worktree removed" '[ "$(worktrees)" = 1 ]'

# ── 5. unmergeable ledger → fail closed before the gate ─────────────────────
OUT="$(run_case chore/sws-auto-refresh-ledger)"
check "unkeyable branch ledger: republish returns 1" 'grep -q "RESULT_RC=1 " <<<"${OUT}"' "${OUT}"
check "unkeyable branch ledger: refused at the merge, gate never ran" \
  'grep -q "could not merge ${LEDGER}" <<<"${OUT}" && grep -q "duplicate id b" <<<"${OUT}" && ! grep -q "FIXTURE_FRESH_PCT" <<<"${OUT}"' "${OUT}"
check "unkeyable branch ledger: nothing pushed, no PR opened" \
  '[ -z "$(recovery_ref chore/sws-auto-refresh-ledger)" ] && [ "$(gh_calls pr-create)" = 0 ]'
check "unkeyable branch ledger: throwaway worktree removed" '[ "$(worktrees)" = 1 ]'

echo ""
echo "${pass} passed, ${fail} failed"
[ "${fail}" -eq 0 ]
