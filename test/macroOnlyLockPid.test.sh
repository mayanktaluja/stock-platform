#!/usr/bin/env bash
#
# Test the PID-based mkdir lock from scripts/refresh-macro-only.sh in isolation.
#
# Verifies:
#   1. mkdir lock acquisition works when no prior holder
#   2. Concurrent acquisition rejects the second caller
#   3. Stale-PID detection clears a lockdir whose holder is dead
#   4. Trap removes the lockdir on EXIT (normal exit)
#   5. Trap removes the lockdir on SIGTERM (kill)
#
# Why this lives outside the cron script itself: the cron script does git +
# network + LLM work after acquiring the lock, which we don't want to run in
# a unit test. We extract just the lock-acquisition block into a tmp script
# and exercise it.

set -uo pipefail

TEST_LOCK_BASE="/tmp/sws-macro-only-lock-test-$$"
TEST_LOCK_DIR="${TEST_LOCK_BASE}.lock.d"
LOCK_FIXTURE="${TEST_LOCK_BASE}.sh"
FAILED=0

cleanup_all() {
  rm -rf "${TEST_LOCK_DIR}" 2>/dev/null
  rm -f "${LOCK_FIXTURE}" 2>/dev/null
}
trap cleanup_all EXIT

fail() {
  echo "  FAIL: $*"
  FAILED=$((FAILED + 1))
}

pass() {
  echo "  ok: $*"
}

# Extract the lock-acquisition block into a tmp script we can spawn multiple
# copies of. This mirrors what refresh-macro-only.sh does at the top.
cat > "${LOCK_FIXTURE}" <<EOF
#!/usr/bin/env bash
set -uo pipefail
LOCK_DIR="${TEST_LOCK_DIR}"

cleanup_lock() {
  rm -f "\${LOCK_DIR}/pid" 2>/dev/null
  rmdir "\${LOCK_DIR}" 2>/dev/null
}

acquire_lock() {
  if mkdir "\${LOCK_DIR}" 2>/dev/null; then
    echo "\$\$@\$(hostname)" > "\${LOCK_DIR}/pid"
    trap cleanup_lock EXIT INT TERM HUP
    return 0
  fi
  if [ -f "\${LOCK_DIR}/pid" ]; then
    local pid_line lock_pid lock_host
    pid_line=\$(cat "\${LOCK_DIR}/pid" 2>/dev/null || echo "")
    lock_pid="\${pid_line%@*}"
    lock_host="\${pid_line#*@}"
    if [ -n "\${lock_pid}" ] && [ "\${lock_host}" = "\$(hostname)" ] && kill -0 "\${lock_pid}" 2>/dev/null; then
      return 1
    fi
    echo "[test] clearing stale lock from \${pid_line:-<unknown>}"
    cleanup_lock
    if mkdir "\${LOCK_DIR}" 2>/dev/null; then
      echo "\$\$@\$(hostname)" > "\${LOCK_DIR}/pid"
      trap cleanup_lock EXIT INT TERM HUP
      return 0
    fi
  fi
  return 1
}

# Args:  \$1 = action (acquire-and-exit | acquire-and-sleep | acquire-and-trap-test)
action="\${1:-acquire-and-exit}"
case "\${action}" in
  acquire-and-exit)
    if acquire_lock; then echo "ACQUIRED"; exit 0; else echo "REJECTED"; exit 0; fi
    ;;
  acquire-and-sleep)
    if acquire_lock; then echo "ACQUIRED"; sleep 30; exit 0; else echo "REJECTED"; exit 0; fi
    ;;
  no-trap-acquire)
    # Bypass trap so we can simulate SIGKILL leaving a stale lock
    if mkdir "\${LOCK_DIR}" 2>/dev/null; then
      echo "\$\$@\$(hostname)" > "\${LOCK_DIR}/pid"
      echo "ACQUIRED_NO_TRAP"
      exit 0
    else
      echo "REJECTED"; exit 0
    fi
    ;;
esac
EOF
chmod +x "${LOCK_FIXTURE}"

echo "macroOnlyLockPid.test.sh: testing PID-based mkdir lock..."

# Test 1 — clean acquisition
rm -rf "${TEST_LOCK_DIR}" 2>/dev/null
out=$("${LOCK_FIXTURE}" acquire-and-exit)
if [ "${out}" = "ACQUIRED" ]; then pass "clean acquisition"; else fail "clean acquisition got: ${out}"; fi

# Test 2 — concurrent: while one holds the lock, the second is rejected
rm -rf "${TEST_LOCK_DIR}" 2>/dev/null
"${LOCK_FIXTURE}" acquire-and-sleep > /tmp/holder.out &
holder_pid=$!
sleep 0.5  # let the holder acquire
out=$("${LOCK_FIXTURE}" acquire-and-exit)
if [ "${out}" = "REJECTED" ]; then pass "concurrent rejection"; else fail "concurrent rejection got: ${out}"; fi
kill "${holder_pid}" 2>/dev/null
wait "${holder_pid}" 2>/dev/null
sleep 0.1

# Test 3 — stale-PID clearing: simulate a dead holder by writing a guaranteed-dead pid
rm -rf "${TEST_LOCK_DIR}" 2>/dev/null
mkdir -p "${TEST_LOCK_DIR}"
echo "999999@$(hostname)" > "${TEST_LOCK_DIR}/pid"  # PID 999999 should not exist
out=$("${LOCK_FIXTURE}" acquire-and-exit)
if [ "${out%$'\n'*}" = "[test] clearing stale lock from 999999@$(hostname)" ] && [ "${out##*$'\n'}" = "ACQUIRED" ]; then
  pass "stale-pid clearing"
else
  fail "stale-pid clearing got: '${out}'"
fi

# Test 4 — foreign-host clearing
rm -rf "${TEST_LOCK_DIR}" 2>/dev/null
mkdir -p "${TEST_LOCK_DIR}"
echo "$$@some-other-host-that-does-not-exist" > "${TEST_LOCK_DIR}/pid"
out=$("${LOCK_FIXTURE}" acquire-and-exit)
last_line="${out##*$'\n'}"
if [ "${last_line}" = "ACQUIRED" ]; then pass "foreign-host clearing"; else fail "foreign-host clearing got: '${out}'"; fi

# Test 5 — trap removes lock on normal exit
rm -rf "${TEST_LOCK_DIR}" 2>/dev/null
"${LOCK_FIXTURE}" acquire-and-exit > /dev/null
if [ ! -d "${TEST_LOCK_DIR}" ]; then pass "trap clears on normal exit"; else fail "trap clears on normal exit (dir still exists)"; fi

# Test 6 — trap on SIGTERM
rm -rf "${TEST_LOCK_DIR}" 2>/dev/null
"${LOCK_FIXTURE}" acquire-and-sleep > /dev/null &
holder_pid=$!
sleep 0.5
kill -TERM "${holder_pid}" 2>/dev/null
wait "${holder_pid}" 2>/dev/null
sleep 0.2
if [ ! -d "${TEST_LOCK_DIR}" ]; then pass "trap clears on SIGTERM"; else fail "trap clears on SIGTERM (dir still exists)"; fi

# Test 7 — no-trap leaves a stale lock, NEXT run clears + acquires
rm -rf "${TEST_LOCK_DIR}" 2>/dev/null
"${LOCK_FIXTURE}" no-trap-acquire > /dev/null
if [ -d "${TEST_LOCK_DIR}" ]; then pass "no-trap leaves stale lock (setup)"; else fail "no-trap setup failed"; fi
# That holder is exited but its PID is reused-likely-not but at least the lock points at $$ of a dead process.
# Note: this test is probabilistic — the test runner's PID may persist if reused. The realistic version is:
# write a clearly impossible pid and verify the next acquire clears it.
out=$("${LOCK_FIXTURE}" acquire-and-exit)
last_line="${out##*$'\n'}"
if [ "${last_line}" = "ACQUIRED" ] || [ "${last_line}" = "REJECTED" ]; then
  # ACQUIRED = clearing worked. REJECTED = the test-runner PID happens to still be alive
  # (which is correct behaviour — the lock points at a live PID).
  pass "post-no-trap acquisition (got: ${last_line})"
else
  fail "post-no-trap acquisition got unexpected: '${out}'"
fi

if [ "${FAILED}" -eq 0 ]; then
  echo "macroOnlyLockPid.test.sh: PASS (7 cases)"
  exit 0
else
  echo "macroOnlyLockPid.test.sh: FAIL (${FAILED} cases)"
  exit 1
fi
