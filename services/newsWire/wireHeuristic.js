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

/**
 * The CLOSED category vocabulary. These are exactly the channel categories in
 * data/alerts/news-sources.json, which the heuristic path has always emitted.
 *
 * It lives here (and not in wireImpactSignal.js) because wireImpactSignal
 * already imports from this module and this module imports nothing from it —
 * so there is no cycle, and both classifiers can share one source of truth.
 */
export const WIRE_CATEGORIES = Object.freeze(["markets", "crypto", "trump", "geopolitics", "india"]);

/**
 * Coerce any category into the closed vocabulary: model value → channel value → "markets".
 *
 * This exists because the LLM prompt's JSON template used to read
 * `"category": "short"` as a *placeholder*, and Gemini faithfully echoed the
 * string "short" as the value — on 19 of 19 LLM-scored items in production,
 * while all 21 heuristic items were correct. The prompt is only a hint; THIS is
 * the guarantee.
 */
export function normaliseWireCategory(raw, fallback) {
  const c = String(raw ?? "").toLowerCase().trim();
  if (WIRE_CATEGORIES.includes(c)) return c;
  const f = String(fallback ?? "").toLowerCase().trim();
  if (WIRE_CATEGORIES.includes(f)) return f;
  return "markets";
}

const BULL = [
  "rally", "rallies", "rallied", "surge", "surges", "surged", "gain", "gains", "gained",
  "jump", "jumps", "jumped", "rise", "rises", "rose", "rising", "bull", "buy",
  "profit", "growth", "record", "beat", "beats", "upgrade", "upgraded", "strong",
  "recover", "recovers", "rebound", "rebounds", "high", "positive", "soar", "soars",
  "boost", "optimism", "stimulus", "ease", "eases", "easing", "approval", "approved",
  "wins", "expansion", "outperform", "climbs", "climbed", "advances", "advanced",
];
const BEAR = [
  "fall", "falls", "fell", "crash", "crashes", "drop", "drops", "dropped", "slip",
  "slips", "slipped", "sell", "selloff", "bear", "loss", "losses", "decline",
  "declines", "weak", "concern", "concerns", "negative", "correction", "plunge",
  "plunges", "plunged", "cut", "cuts", "downgrade", "downgraded", "pressure", "fear",
  "fears", "risk", "slump", "slumps", "sank", "sink", "sinks", "tumble", "tumbles",
  "tumbled", "default", "recession", "sanction", "sanctions", "tariff", "tariffs",
  "probe", "fraud", "ban", "banned", "halt", "warning", "warns", "miss", "misses",
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
    impact: 1,
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
    const impact = clamp(Math.round(heat * 10) / 10, 0, 10);

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

    const category = normaliseWireCategory(Array.isArray(cluster.categories) ? cluster.categories[0] : null);
    const parts = [];
    parts.push(`${sourceCount} source${sourceCount === 1 ? "" : "s"}`);
    parts.push(direction === "neutral" ? "no clear lean" : `${direction} tone`);
    if (breaking) parts.push("flagged breaking");
    if (symbols.length) parts.push(`mentions ${symbols.slice(0, 3).join(", ")}`);
    const why = parts.join(" · ").slice(0, 200);

    return {
      direction,
      impact,
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

export default { heuristicClassifyCluster, WIRE_SIGNAL_VERSION, WIRE_CATEGORIES, normaliseWireCategory };
