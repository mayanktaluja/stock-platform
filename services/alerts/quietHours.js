/**
 * Quiet hours for the NEWS class only.
 *
 * Suppresses routine per-ticker headline alerts overnight IST (23:00–07:00) so
 * the phone isn't pinged by a low-value company headline at 3am. Two deliberate
 * carve-outs from the adversarial review:
 *   - **REGIME-class alerts are NEVER quiet-houred** (M1). A Fed/Trump/oil move
 *     at 02:00 IST is exactly the pre-open signal that matters — the regime path
 *     simply never calls this function.
 *   - `breaking` alerts bypass quiet hours even within the NEWS class.
 *
 * Pure + deterministic. Computes the IST hour from a UTC instant (IST = UTC+5:30)
 * without depending on the host timezone.
 */

const IST_OFFSET_MIN = 5 * 60 + 30;
const QUIET_START_HR = 23; // inclusive
const QUIET_END_HR = 7; // exclusive

export function istHour(date = new Date()) {
  const utcMin = date.getUTCHours() * 60 + date.getUTCMinutes();
  return Math.floor(((utcMin + IST_OFFSET_MIN) % (24 * 60)) / 60);
}

/** True if `date` falls in the overnight IST quiet window. */
export function isQuietHoursIST(date = new Date()) {
  const h = istHour(date);
  return h >= QUIET_START_HR || h < QUIET_END_HR;
}

/**
 * Should a NEWS-class alert be suppressed right now?
 * Breaking always passes. Routine is suppressed during quiet hours.
 */
export function suppressNews({ breaking = false, date = new Date() } = {}) {
  if (breaking) return false;
  return isQuietHoursIST(date);
}
