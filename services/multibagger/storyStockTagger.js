// Story-stock narrative tagger — regex over SWS rewards/risks/news text
// for thematic tags that historically compress the P/E re-rating cycle:
// PLI, defense, renewable, EV, hydrogen, data center, AI, semiconductor.
//
// Returns { tags: string[], score_bonus } where bonus is +3 if 2+ tags
// hit, +1 if 1 tag hits, 0 otherwise. Caller adds to composite score.

const TAG_PATTERNS = Object.freeze({
  PLI: /\b(PLI|production[\s-]?linked incentive)\b/i,
  DEFENSE: /\b(defen[cs]e|indigenisation|naval|army|aerospace)\b/i,
  RENEWABLE: /\b(renewable|solar|wind|green energy|biofuel)\b/i,
  EV: /\b(electric vehicle|EV adoption|battery|lithium|charging)\b/i,
  HYDROGEN: /\b(hydrogen|green hydrogen|fuel cell)\b/i,
  DATA_CENTER: /\b(data centre|data center|hyperscale|colocation)\b/i,
  AI: /\b(artificial intelligence|machine learning|GenAI|generative AI|AI)\b/i,
  SEMICONDUCTOR: /\b(semiconductor|chip fab|fabrication|wafer|FPGA|ASIC)\b/i,
  RAILWAY_PSU: /\b(railway|metro|Vande Bharat|KAVACH|RVNL|IRCON)\b/i,
  CAPEX: /\b(capacity expansion|new plant|greenfield|brownfield|capex)\b/i,
});

const BONUS_TWO_PLUS = 3;
const BONUS_ONE = 1;

// Accepts a `texts` array OR a SWS overview-like object with rewards/
// risks. Concatenates and pattern-matches.
export function tagStoryStock(input) {
  const texts = collectTexts(input);
  const hits = [];
  for (const [tag, pattern] of Object.entries(TAG_PATTERNS)) {
    if (texts.some((t) => pattern.test(t))) hits.push(tag);
  }
  const score_bonus =
    hits.length >= 2 ? BONUS_TWO_PLUS :
    hits.length === 1 ? BONUS_ONE :
    0;
  return { tags: hits, score_bonus };
}

function collectTexts(input) {
  if (Array.isArray(input)) {
    return input.map((s) => String(s ?? "")).filter(Boolean);
  }
  if (!input || typeof input !== "object") return [];
  const out = [];
  if (Array.isArray(input.rewards)) for (const r of input.rewards) if (r) out.push(String(r));
  if (Array.isArray(input.risks)) for (const r of input.risks) if (r) out.push(String(r));
  if (Array.isArray(input.news)) {
    for (const n of input.news) {
      if (n && (n.title || n.body)) out.push(String(n.title || "") + " " + String(n.body || ""));
    }
  }
  return out;
}

export const STORY_TAGGER_CONFIG = Object.freeze({
  TAGS: Object.keys(TAG_PATTERNS),
  BONUS_TWO_PLUS,
  BONUS_ONE,
});
