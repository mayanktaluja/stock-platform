// Market Wire — deterministic heuristic classifier (Phase 3).
//
// Scores a cluster into the EXACT wire-signal schema the LLM also emits, so the
// two are interchangeable. This is the never-throw floor: every cluster gets a
// signal even with no LLM keys, and the builder ranks the whole set on this
// cheap pass BEFORE spending any LLM budget on only the top-N (Phase 4).
//
// Keyword seeds are the same bull/bear lists the deterministic Market Digest
// uses (server.js:4145). Direction certainty is deliberately humble — this is a
// keyword guess over unverified scraped chatter, so confidence caps low and the
// UI shows a bucketed heat, never a precise number (D3 honesty rule).

import { normalizeSector } from "../../macroRegime.js";

export const WIRE_SIGNAL_VERSION = "news-wire-v1";
const MODEL_ID = "news-wire-heuristic-v1";

const BULL = [
  "rally", "surge", "gain", "gains", "jump", "jumps", "rise", "rises", "bull", "buy",
  "profit", "growth", "record", "beat", "beats", "upgrade", "upgraded", "strong",
  "recover", "rebound", "high", "positive", "soar", "soars", "boost", "optimism",
  "stimulus", "approval", "approved", "wins", "expansion", "outperform",
];
const BEAR = [
  "fall", "falls", "crash", "drop", "drops", "slip", "sell", "selloff", "bear",
  "loss", "losses", "decline", "weak", "concern", "concerns", "negative",
  "correction", "plunge", "plunges", "cut", "cuts", "downgrade", "downgraded",
  "pressure", "fear", "fears", "risk", "slump", "default", "recession", "sanction",
  "sanctions", "tariff", "tariffs", "probe", "fraud", "ban", "banned", "halt",
  "warning", "warns", "miss", "misses",
];

// High-precision sector triggers → canonical SECTORS. Kept small; the LLM fills
// richer sector impacts for the top-N. normalizeSector canonicalizes each label.
const SECTOR_TRIGGERS = [
  [/\bbank(s|ing)?\b|\blender/, "Banking"],
  [/\bit (services|sector|stocks)\b|software|\bnasscom/, "IT Services"],
  [/pharma|\bdrug|healthcare/, "Pharma"],
  [/\bauto\b|automobile|\bvehicle|\bcar sales/, "Automobile"],
  [/metal|\bsteel\b/, "Metals"],
  [/\boil\b|crude|petroleum|\bopec/, "Oil & Gas"],
  [/telecom|spectrum/, "Telecom"],
  [/real estate|realty|housing finance/, "Real Estate"],
  [/\bfmcg\b|consumer goods/, "FMCG"],
  [/\bpower\b|electricity|\bgrid\b/, "Power"],
  [/\bcement\b/, "Cement"],
  [/\bdefen[cs]e\b|missile|airstrike/, "Defence"],
];

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function countMatches(text, words) {
  const re = new RegExp(`(?<![a-z0-9])(?:${words.join("|")})(?![a-z0-9])`, "g");
  const m = text.match(re);
  return m ? m.length : 0;
}

function neutralFloor(now) {
  return {
    direction: "neutral",
    heat_raw: 1,
    confidence: 0.3,
    tickers: [],
    sectors: [],
    category: "markets",
    why: "No clear directional signal.",
    breaking: false,
    classifier_provider: "heuristic",
    model_id: MODEL_ID,
    signal_version: WIRE_SIGNAL_VERSION,
    generated_at: new Date(now).toISOString(),
  };
}

/**
 * heuristicClassifyCluster(cluster, opts) → wire signal. Never throws.
 * cluster: { representative, members[], source_count, breaking, symbols, categories }
 */
export function heuristicClassifyCluster(cluster, { now = Date.now() } = {}) {
  try {
    if (!cluster || !cluster.representative) return neutralFloor(now);
    const bodies = [cluster.representative, ...(cluster.members || []).map((m) => m.text)].filter(Boolean);
    const text = bodies.join(" • ").toLowerCase();

    const bull = countMatches(text, BULL);
    const bear = countMatches(text, BEAR);
    let direction = "neutral";
    if (bull > bear) direction = "bullish";
    else if (bear > bull) direction = "bearish";

    const sourceCount = Number(cluster.source_count) || 1;
    const breaking = !!cluster.breaking;
    const symbols = Array.isArray(cluster.symbols) ? cluster.symbols : [];

    // Heat: keyword intensity + corroboration + breaking + a named ticker.
    const signalStrength = Math.min(bull + bear, 5);
    let heat = 1.5 + signalStrength * 0.9;
    heat += Math.min(sourceCount - 1, 3) * 1.2; // corroboration
    if (breaking) heat += 2;
    if (symbols.length) heat += 1;
    const heat_raw = clamp(Math.round(heat * 10) / 10, 0, 10);

    // Confidence: humble base, lifted by corroboration + keyword clarity.
    let confidence = 0.3;
    confidence += Math.min(sourceCount - 1, 3) * 0.08;
    confidence += Math.min(Math.abs(bull - bear), 4) * 0.05;
    confidence = clamp(Math.round(confidence * 100) / 100, 0.3, 0.85);

    // Sectors: keyword-sniffed, signed by overall direction.
    const dirSign = direction === "bullish" ? 1 : direction === "bearish" ? -1 : 0;
    const sectors = [];
    if (dirSign !== 0) {
      const seen = new Set();
      for (const [re, label] of SECTOR_TRIGGERS) {
        if (re.test(text)) {
          const canon = normalizeSector(label) || label;
          if (seen.has(canon)) continue;
          seen.add(canon);
          sectors.push({ sector: canon, impact: clamp(dirSign * (breaking ? 2 : 1), -3, 3) });
        }
      }
    }

    const category = (Array.isArray(cluster.categories) && cluster.categories[0]) || "markets";
    const parts = [];
    parts.push(`${sourceCount} source${sourceCount === 1 ? "" : "s"}`);
    parts.push(direction === "neutral" ? "no clear lean" : `${direction} tone`);
    if (breaking) parts.push("flagged breaking");
    if (symbols.length) parts.push(`mentions ${symbols.slice(0, 3).join(", ")}`);
    const why = parts.join(" · ").slice(0, 200);

    return {
      direction,
      heat_raw,
      confidence,
      tickers: symbols,
      sectors,
      category,
      why,
      breaking,
      classifier_provider: "heuristic",
      model_id: MODEL_ID,
      signal_version: WIRE_SIGNAL_VERSION,
      generated_at: new Date(now).toISOString(),
    };
  } catch {
    return neutralFloor(now);
  }
}

export default { heuristicClassifyCluster, WIRE_SIGNAL_VERSION };
