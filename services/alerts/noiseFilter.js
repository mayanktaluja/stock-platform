/**
 * Noise mute filter for the news router.
 *
 * Coverage-first forwards everything, but some channels (e.g. FinancialJuice)
 * carry high-volume non-market spam — earthquake/tsunami/magnitude disaster
 * monitoring, weather, etc. A message matching ANY mute keyword is dropped
 * before it ever becomes an alert (routeMessage returns null), so it never
 * pings the user. Keywords live in data/alerts/mute-keywords.json (user-tunable).
 *
 * Same word-boundary-anchored, longest-first matcher style as watchlistGate /
 * macroBreakingGate. Pure — no network, no env.
 */

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Compile a mute-keyword list into one case-insensitive matcher. */
export function compileNoiseGate(keywords = []) {
  const safe = [...new Set((Array.isArray(keywords) ? keywords : []).map((t) => String(t || "").trim().toLowerCase()).filter(Boolean))]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegex);
  if (!safe.length) return { re: null };
  // Leading boundary only (no trailing) so a stem also mutes its plural/inflection
  // — "earthquake" catches "earthquakes", "magnitude" catches "magnitudes".
  return { re: new RegExp(`(?<![A-Za-z0-9])(?:${safe.join("|")})`, "i") };
}

/** True if `text` hits any mute keyword (→ caller drops the message). */
export function matchNoise(text, compiled) {
  const str = String(text || "");
  if (!str.trim() || !compiled || !compiled.re) return false;
  return new RegExp(compiled.re.source, "i").test(str);
}
