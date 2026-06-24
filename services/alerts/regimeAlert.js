/**
 * Format a macro-regime transition into a Telegram alert.
 *
 * Input is the regime object written to data/macroRegime.json by
 * scripts/refresh-macro-regime.mjs (see macroRegime.js): { regime, regimeLabel,
 * severity 1-5, confidence 0-1, sectorImpacts:[{sector,impact,reason}],
 * keyEvents:[], classifierProvider }. `prev` is the previously-committed regime
 * (or null on first run) so the alert can show the transition arrow.
 *
 * Pure + deterministic — no network, no env. The dispatcher decides whether to
 * send; this only renders. Disclaimer is covered by the site-wide footer, so
 * none is inlined here.
 */

import { escapeHtml } from "./telegramSender.js";

const PROD_URL = "https://starbhai-stock-platform.vercel.app";

// Severity 1-5 → leading marker. >=4 is "breaking" (makes a sound).
const SEV_EMOJI = { 1: "🟢", 2: "🔵", 3: "🟡", 4: "🟠", 5: "🔴" };

export function isBreaking(regime) {
  return Number(regime?.severity || 0) >= 4;
}

/** Top N sector impacts, most negative first (the ones a holder cares about). */
function topSectorImpacts(regime, n = 3) {
  const arr = Array.isArray(regime?.sectorImpacts) ? regime.sectorImpacts : [];
  return [...arr]
    .filter((s) => s && s.sector)
    .sort((a, b) => Number(a.impact || 0) - Number(b.impact || 0))
    .slice(0, n);
}

function impactArrow(impact) {
  const v = Number(impact || 0);
  if (v > 0) return "↑";
  if (v < 0) return "↓";
  return "→";
}

/**
 * Build the alert. Returns { text, breaking, key } or null if `regime` is
 * unusable (caller skips silently).
 */
export function formatRegimeAlert(regime, prev = null) {
  if (!regime || typeof regime.regime !== "string") return null;

  const sev = Number(regime.severity || 0);
  const conf = Number(regime.confidence || 0);
  const label = regime.regimeLabel || regime.regime;
  const emoji = SEV_EMOJI[sev] || "⚪";
  const breaking = isBreaking(regime);

  const lines = [];
  lines.push(`${breaking ? "🚨 " : ""}${emoji} <b>${escapeHtml(label)}</b>`);

  const prevLabel = prev && prev.regime && prev.regime !== regime.regime
    ? `${escapeHtml(prev.regimeLabel || prev.regime)} → `
    : "";
  lines.push(`${prevLabel}sev <b>${sev}/5</b> · conf ${conf.toFixed(2)} · ${escapeHtml(regime.classifierProvider || "?")}`);

  const sectors = topSectorImpacts(regime);
  if (sectors.length) {
    const parts = sectors.map((s) => `${escapeHtml(s.sector)} ${impactArrow(s.impact)}`);
    lines.push(`<i>${parts.join(" · ")}</i>`);
  }

  const keyEvent = Array.isArray(regime.keyEvents) ? regime.keyEvents.find(Boolean) : null;
  if (keyEvent) lines.push(escapeHtml(String(keyEvent).slice(0, 200)));

  return {
    text: lines.join("\n"),
    breaking,
    key: `regime:${regime.regime}|${sev}`,
    buttons: [{ text: "📊 Open platform", url: PROD_URL }],
  };
}
