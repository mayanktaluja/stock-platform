#!/usr/bin/env bash
# Suspend clock for the SWS nightly scripts: how long was the host asleep
# while a command ran? And may it scrape right now? Source it, then:
#   sws_suspend_clock_start <state_file>   background ticker (SWS_SUSPEND_CLOCK_PID)
#   sws_suspend_clock_stop  <state_file>   stops it; sets SWS_SUSPENDED_SEC
#   sws_host_can_scrape                    true on AC, or with the lid open
#
# On Darwin `sleep N` counts AWAKE time only, while `date +%s` jumps across a
# suspend. So a tick whose wall-clock gap exceeds 3 ticks was suspended for
# (gap − tick), almost exactly. The same rule is the nightly watchdog's (in
# sws-nightly-isolated.sh); see CLAUDE.md "SWS nightly on a sleeping laptop".
#
# ONE clock read per tick, and each gap runs from the previous READ (last=now),
# never from a second read taken after the tick's own work. Every wall-clock
# second then lands in exactly one gap, wherever the suspend falls. The watchdog
# used to re-read the clock after its pmset call, so a suspend that began during
# that call landed between two reads and vanished: on 2026-10-25 it reported
# 0.7h asleep against pmset's 2.5h, missing 7 of 10 Deep Idle sleeps (1.7h).
#
# A suspend still in progress when the command ends (it can exit in the same
# DarkWake the ticker wakes in, before the ticker's next read) is added at stop
# from the last read. bash 3.2 compatible.
SWS_SUSPEND_TICK_SEC="${SWS_SUSPEND_TICK_SEC:-5}"

sws_suspend_clock_start() {  # <state_file>
  local file="$1"
  echo "0 $(date +%s)" > "${file}"
  # fds closed: killing this subshell orphans its `sleep`, which must not hold
  # the caller's stdout pipe open (see sws-with-timeout.sh).
  (
    total=0
    last="$(date +%s)"
    while : ; do
      sleep "${SWS_SUSPEND_TICK_SEC}"
      now="$(date +%s)"
      gap=$(( now - last ))
      if [ "${gap}" -gt $(( 3 * SWS_SUSPEND_TICK_SEC )) ]; then
        total=$(( total + gap - SWS_SUSPEND_TICK_SEC ))
      fi
      last="${now}"
      echo "${total} ${last}" > "${file}.tmp" && mv -f "${file}.tmp" "${file}"
    done
  ) >/dev/null 2>&1 </dev/null &
  SWS_SUSPEND_CLOCK_PID=$!
}

sws_suspend_clock_stop() {  # <state_file>
  local file="$1" total="" last="" pending
  if [ -n "${SWS_SUSPEND_CLOCK_PID:-}" ]; then
    kill "${SWS_SUSPEND_CLOCK_PID}" 2>/dev/null || true
    wait "${SWS_SUSPEND_CLOCK_PID}" 2>/dev/null || true
  fi
  SWS_SUSPEND_CLOCK_PID=""
  read -r total last < "${file}" 2>/dev/null || true
  rm -f "${file}" "${file}.tmp" 2>/dev/null || true
  case "${total}" in ''|*[!0-9]*) total=0 ;; esac
  case "${last}" in
    ''|*[!0-9]*) ;;
    *)
      pending=$(( $(date +%s) - last ))
      if [ "${pending}" -gt $(( 3 * SWS_SUSPEND_TICK_SEC )) ]; then
        total=$(( total + pending - SWS_SUSPEND_TICK_SEC ))
      fi
      ;;
  esac
  SWS_SUSPENDED_SEC="${total}"
}

# Owner policy (2026-10-27): scrape on AC (lid open or closed) or with the lid
# open on battery — never with the lid closed on battery. That host only runs
# in 2-7s DarkWakes, so a scrape there costs battery and fails anyway. pmset
# 10-20..10-27: lid open on battery slept 0 times; a closed lid on AC bounced
# back to DarkWake within 0-4s. Unknown state (no pmset/ioreg) counts as able.
sws_on_ac_power() { pmset -g batt 2>/dev/null | head -1 | grep -q "AC Power"; }
sws_lid_closed() { ioreg -r -k AppleClamshellState -d 4 2>/dev/null | grep -q '"AppleClamshellState" = Yes'; }
sws_host_can_scrape() { sws_on_ac_power || ! sws_lid_closed; }
