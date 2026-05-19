/**
 * Sector Outlook — Heuristic Theme Classifier.
 *
 * Deterministic regex-keyword classifier over an SWS news item's title +
 * body. Emits the same shape as the LLM classifier so the aggregator
 * doesn't know or care which path produced the row.
 *
 * Two reasons this is the FIRST-PASS classifier (not a fallback):
 *
 *   1. Cost. The adversarial review showed that LLM-classifying all
 *      ~83k SWS news items on the Gemini free tier (15 RPM × 1500 RPD)
 *      would take ~73 days at the daily cap, or trigger a 429-cascade
 *      after the first 15 requests/minute. Heuristic-first is what
 *      makes this feature buildable on free providers.
 *
 *   2. Determinism. Most SWS news titles are templated by Simply Wall St
 *      ("Q3 earnings: EPS exceeds analyst expectations", "X just announced
 *      a 20% capacity expansion at its Y plant", "Z agreed to acquire W
 *      for $N million"). Regex matches these reliably with near-zero
 *      false-positive rate. The LLM refiner only sees the ~5% of items
 *      that don't match cleanly (confidence < MIN_CONFIDENCE).
 *
 * Each pattern carries a (theme, sign, intensity, time_hint, weight)
 * label. Multiple patterns can match one news item — we aggregate by
 * accumulating weights into a per-theme score, then pick the argmax.
 * Final confidence = top_score / sum(all_scores) (i.e. the share of
 * total evidence the winning theme captured). UNCLASSIFIED is emitted
 * when confidence < MIN_CONFIDENCE.
 */

import { sanitiseText } from "../earnings/llmPromptHardener.js";
import {
  THEME_LABELS,
  CLASSIFIER_VERSION,
  MIN_CONFIDENCE,
} from "./themeTaxonomy.js";

/**
 * Each pattern entry: { theme, sign, intensity, time_hint, weight, re }.
 * - `weight` scales the pattern's contribution to the theme's score.
 *   Highly-specific patterns get higher weights so they win over generic
 *   ones (e.g. "miss EPS by 41%" beats a stray mention of "miss").
 * - `time_hint` is "short"/"medium"/"long" — a per-news suggestion the
 *   aggregator uses to break ties between identical theme×sign rows.
 * - The classifier merges sign from multiple matching patterns by
 *   summing signed contributions and taking the sign of the result.
 */
const PATTERNS = Object.freeze([
  // ─── EARNINGS_MOVE ──────────────────────────────────────────────────
  // Positive
  {
    theme: "EARNINGS_MOVE", sign: 1, intensity: 2, time_hint: "short", weight: 3.0,
    re: /\beps\s+(?:exceeded?|beat|surpass(?:ed)?)\s+(?:analyst|estimate|expectation)/i,
  },
  {
    theme: "EARNINGS_MOVE", sign: 1, intensity: 2, time_hint: "short", weight: 3.0,
    re: /\b(?:exceed(?:ed|s)?|beat|surpass(?:ed)?)\s+analyst\s+(?:estimate|expectation|forecast)/i,
  },
  {
    theme: "EARNINGS_MOVE", sign: 1, intensity: 3, time_hint: "short", weight: 3.5,
    re: /\b(?:eps|earnings)\s+(?:exceeded?|beat|surpass(?:ed)?)\s+(?:estimate|expectation)s?\s+by\s+\d+%/i,
  },
  {
    theme: "EARNINGS_MOVE", sign: 1, intensity: 3, time_hint: "short", weight: 3.5,
    re: /\b(?:just\s+)?(?:exceeded?|beat|surpass(?:ed)?)\s+(?:eps|earnings)\s+(?:estimate|expectation)s?\s+by\s+\d+%/i,
  },
  {
    theme: "EARNINGS_MOVE", sign: 1, intensity: 2, time_hint: "short", weight: 2.5,
    re: /\bbeat\s+(?:eps|earnings)\s+(?:estimate|expectation)/i,
  },
  {
    theme: "EARNINGS_MOVE", sign: 1, intensity: 2, time_hint: "short", weight: 2.5,
    re: /\bhealthy\s+earnings\b|\bstrong\s+(?:earnings|results|profits?)\b|\brecord\s+(?:earnings|profits?)\b/i,
  },
  // Negative
  {
    theme: "EARNINGS_MOVE", sign: -1, intensity: 2, time_hint: "short", weight: 3.0,
    re: /\bmiss(?:ed)?\s+analyst\s+(?:estimate|expectation|forecast)/i,
  },
  {
    theme: "EARNINGS_MOVE", sign: -1, intensity: 2, time_hint: "short", weight: 3.0,
    re: /\b(?:eps|earnings|revenues?)\s+(?:and\s+\w+\s+)?miss(?:ed)?\s+(?:analyst|estimate|expectation)/i,
  },
  {
    theme: "EARNINGS_MOVE", sign: -1, intensity: 3, time_hint: "short", weight: 3.5,
    re: /\bjust\s+miss(?:ed)?\s+eps\s+by\s+\d+%/i,
  },
  // ─── CAPACITY_CAPEX ─────────────────────────────────────────────────
  {
    theme: "CAPACITY_CAPEX", sign: 1, intensity: 2, time_hint: "long", weight: 2.5,
    re: /\bcapacity\s+(?:expansion|expand|increase|addition|ramp(?:-?up)?)\b/i,
  },
  {
    theme: "CAPACITY_CAPEX", sign: 1, intensity: 3, time_hint: "long", weight: 3.0,
    re: /\bnew\s+(?:plant|facility|factory|capacity)\b.*?(?:commission|inaugurat|launch|operationali)/i,
  },
  {
    theme: "CAPACITY_CAPEX", sign: 1, intensity: 3, time_hint: "long", weight: 3.0,
    re: /\b(?:commission(?:ed|ing)?|inaugurat(?:ed|ing)?|launch(?:ed|ing)?|operationali[sz]ed?)\s+(?:its\s+|the\s+|a\s+)?new\s+(?:plant|facility|factory|capacity)\b/i,
  },
  {
    theme: "CAPACITY_CAPEX", sign: 1, intensity: 2, time_hint: "long", weight: 2.0,
    re: /\bcapex\s+(?:plan|guidance|commitment|investment|outlay|of)\b/i,
  },
  {
    theme: "CAPACITY_CAPEX", sign: 1, intensity: 3, time_hint: "long", weight: 3.0,
    re: /\bgreen(?:[-\s]?field|\s+ammonia|\s+hydrogen|\s+energy)\b[^.]{0,40}?\b(?:plant|project|facility|capacity|construction)\b/i,
  },
  {
    theme: "CAPACITY_CAPEX", sign: 1, intensity: 2, time_hint: "medium", weight: 2.0,
    re: /\b(?:debottlenecking|brownfield|expansion)\s+(?:project|plant|investment)\b/i,
  },
  // ─── M_AND_A ────────────────────────────────────────────────────────
  {
    theme: "M_AND_A", sign: 1, intensity: 3, time_hint: "medium", weight: 3.5,
    re: /\b(?:agreed?\s+to|to)\s+acquire\b|\bacquisition\s+of\b|\bacquired\b/i,
  },
  {
    theme: "M_AND_A", sign: 1, intensity: 3, time_hint: "medium", weight: 3.0,
    re: /\bmerger\s+(?:with|of|announced)\b|\bmerge\s+with\b/i,
  },
  {
    theme: "M_AND_A", sign: 0, intensity: 2, time_hint: "medium", weight: 2.5,
    re: /\bdemerger\b|\bspin[-\s]?off\b|\bdivest(?:iture|ment)?\b/i,
  },
  {
    theme: "M_AND_A", sign: 1, intensity: 2, time_hint: "medium", weight: 2.0,
    re: /\bjoint\s+venture\b|\bjv\s+(?:with|announce|launch|form)/i,
  },
  // ─── ORDER_WINS ─────────────────────────────────────────────────────
  {
    theme: "ORDER_WINS", sign: 1, intensity: 2, time_hint: "short", weight: 2.5,
    re: /\b(?:wins?|won|secured?|bagged?|received?)\s+(?:large|major|new|significant)?\s*(?:order|contract|tender|mandate)/i,
  },
  {
    theme: "ORDER_WINS", sign: 1, intensity: 2, time_hint: "medium", weight: 2.0,
    re: /\border\s+book\s+(?:grew|growth|expansion|strong|robust|healthy|swelled?)/i,
  },
  {
    theme: "ORDER_WINS", sign: 1, intensity: 3, time_hint: "medium", weight: 3.0,
    re: /\b(?:offtake|long[-\s]?term)\s+(?:agreement|contract|deal)\b/i,
  },
  {
    theme: "ORDER_WINS", sign: 1, intensity: 2, time_hint: "medium", weight: 2.0,
    re: /\b(?:long[-\s]?term\s+)?offtake\b(?:\s+(?:is|to|will|expected))?/i,
  },
  {
    theme: "ORDER_WINS", sign: 1, intensity: 2, time_hint: "medium", weight: 2.0,
    re: /\bbacklog\s+(?:ramp|growth|increase|strong|robust)/i,
  },
  // ─── REGULATORY_EVENT ───────────────────────────────────────────────
  // Positive (subsidy, license grant, favourable policy)
  {
    theme: "REGULATORY_EVENT", sign: 1, intensity: 3, time_hint: "long", weight: 3.0,
    re: /\b(?:granted|awarded|received)\s+(?:license|approval|authoris(?:ation|ed))\b/i,
  },
  {
    theme: "REGULATORY_EVENT", sign: 1, intensity: 2, time_hint: "long", weight: 2.5,
    re: /\b(?:pli|production[-\s]linked\s+incentive|subsid(?:y|ies))\s+(?:approved|granted|scheme)/i,
  },
  {
    theme: "REGULATORY_EVENT", sign: 1, intensity: 2, time_hint: "medium", weight: 2.0,
    re: /\b(?:tariff|duty)\s+(?:hike|increase|raised|imposed)\s+on\s+(?:import|chinese|foreign)/i,
  },
  // Negative
  {
    theme: "REGULATORY_EVENT", sign: -1, intensity: 3, time_hint: "medium", weight: 3.5,
    re: /\b(?:ban(?:ned)?|prohibited?|suspended?|revoked?)\b.*?(?:export|import|license|approval|drug|product)/i,
  },
  {
    theme: "REGULATORY_EVENT", sign: -1, intensity: 2, time_hint: "medium", weight: 2.5,
    re: /\b(?:price\s+cap|price\s+control|nppa\s+(?:order|cap))\b/i,
  },
  {
    theme: "REGULATORY_EVENT", sign: -1, intensity: 2, time_hint: "medium", weight: 2.0,
    re: /\busfda\s+(?:warning|483|import\s+alert|adverse)/i,
  },
  {
    theme: "REGULATORY_EVENT", sign: -1, intensity: 2, time_hint: "medium", weight: 2.0,
    re: /\b(?:fine|penalty)\s+(?:imposed|of\s+(?:inr|rs|usd|\$|₹))/i,
  },
  // ─── MARGIN_MOVE ────────────────────────────────────────────────────
  // Positive
  {
    theme: "MARGIN_MOVE", sign: 1, intensity: 2, time_hint: "short", weight: 2.5,
    re: /\b(?:margin|ebitda|operating)\s+(?:expansion|expand(?:ed)?|improved?|increased?|widened?)/i,
  },
  {
    theme: "MARGIN_MOVE", sign: 1, intensity: 2, time_hint: "short", weight: 2.0,
    re: /\bgross\s+margin\s+(?:up|grew|rose|jumped|increased)\s+to/i,
  },
  // Negative
  {
    theme: "MARGIN_MOVE", sign: -1, intensity: 2, time_hint: "short", weight: 2.5,
    re: /\b(?:margin|ebitda|operating)\s+(?:pressure|compress(?:ed|ion)?|contract(?:ed|ion)?|squeeze|decline)/i,
  },
  {
    theme: "MARGIN_MOVE", sign: -1, intensity: 2, time_hint: "short", weight: 2.5,
    re: /\b(?:raw\s+material|input)\s+(?:cost|price)\s+(?:inflation|surge|spike|pressure)/i,
  },
  // ─── STRATEGIC_GEOPOLITICAL ─────────────────────────────────────────
  // Positive — patterns weighted higher than ORDER_WINS so co-mentions
  // resolve to the geopolitical theme (e.g. "China+1 driving order book").
  {
    theme: "STRATEGIC_GEOPOLITICAL", sign: 1, intensity: 3, time_hint: "long", weight: 4.0,
    re: /\bchina\s*[++]\s*1\b|\bchina\s*plus\s*one\b|\bdecoupling\s+from\s+china\b/i,
  },
  {
    theme: "STRATEGIC_GEOPOLITICAL", sign: 1, intensity: 3, time_hint: "long", weight: 4.0,
    re: /\b(?:make\s+in\s+india|atmanirbhar|import\s+substitution)\b/i,
  },
  {
    theme: "STRATEGIC_GEOPOLITICAL", sign: 1, intensity: 2, time_hint: "long", weight: 2.5,
    re: /\b(?:export(?:s|er)?\s+to\s+(?:us|usa|europe|uk|gulf))\b.*?(?:tailwind|grow|surge|robust|strong)/i,
  },
  // Negative
  {
    theme: "STRATEGIC_GEOPOLITICAL", sign: -1, intensity: 3, time_hint: "long", weight: 3.5,
    re: /\b(?:us|usa|european|eu)\s+(?:tariff|sanction|trade\s+ban)\s+on\s+(?:indian|india)/i,
  },
  {
    theme: "STRATEGIC_GEOPOLITICAL", sign: -1, intensity: 3, time_hint: "long", weight: 3.0,
    re: /\b(?:sanctions?|trade\s+ban|export\s+control)\s+(?:imposed|announced|threatened)/i,
  },
  {
    theme: "STRATEGIC_GEOPOLITICAL", sign: -1, intensity: 2, time_hint: "medium", weight: 2.5,
    re: /\b(?:rupee|inr)\s+(?:depreciation|weakness|slump|crash)\s+(?:hit|impact|hurt|pressure)/i,
  },
  {
    theme: "STRATEGIC_GEOPOLITICAL", sign: 1, intensity: 2, time_hint: "medium", weight: 2.0,
    re: /\b(?:rupee|inr)\s+(?:weakness|depreciation)\s+(?:tailwind|benefit|boost|help)/i,
  },
]);

// Negation guards reused from the consecutive-miss detector pattern —
// "won't miss", "did not beat", etc. should suppress the positive/negative
// match. The negation must appear within ~4 words before the trigger word.
const NEGATION_PATTERN = /\b(?:won['']?t|will\s+not|cannot|did\s?n['']?t|do\s?n['']?t|never|no(?:t|ne)?)\s+(?:\w+\s+){0,4}(?:miss|beat|exceed|surpass|grow|expand|wins?|won|acquire|merge|expand|increase|improve|decline|fall|drop)/i;

const MAX_TITLE_LEN = 220;
const MAX_BODY_LEN = 800;

/**
 * Classify a single SWS news item.
 *
 * @param {{title?: string, body?: string, date?: string}} newsItem
 * @returns {{
 *   theme: string,
 *   sign: -1|0|1,
 *   intensity: 1|2|3,
 *   confidence: number,
 *   time_hint: "short"|"medium"|"long",
 *   classifier_provider: "heuristic",
 *   classifier_version: string,
 *   matches: Array<{theme: string, pattern_index: number}>,
 * }}
 */
export function classifyOne(newsItem) {
  const safeTitle = sanitiseText(newsItem?.title || "", MAX_TITLE_LEN);
  const safeBody = sanitiseText(newsItem?.body || "", MAX_BODY_LEN);
  const haystack = `${safeTitle}\n${safeBody}`;

  // Tally theme weights and signed contributions
  const scores = Object.fromEntries(THEME_LABELS.map((t) => [t, 0]));
  const signedSums = Object.fromEntries(THEME_LABELS.map((t) => [t, 0]));
  const intensitySums = Object.fromEntries(THEME_LABELS.map((t) => [t, { num: 0, denom: 0 }]));
  const timeHintTally = Object.fromEntries(
    THEME_LABELS.map((t) => [t, { short: 0, medium: 0, long: 0 }]),
  );
  const matches = [];

  // Negation guard — if the haystack has a top-level negation phrase, we
  // suppress the most-confidence-eroding patterns. We don't drop the
  // match entirely (some sentences flip — "won't miss but might just
  // beat") — we just halve the weight.
  const negated = NEGATION_PATTERN.test(haystack);
  const negationMultiplier = negated ? 0.5 : 1.0;

  for (let i = 0; i < PATTERNS.length; i += 1) {
    const p = PATTERNS[i];
    if (!p.re.test(haystack)) continue;
    const w = p.weight * negationMultiplier;
    scores[p.theme] += w;
    signedSums[p.theme] += p.sign * w;
    intensitySums[p.theme].num += p.intensity * w;
    intensitySums[p.theme].denom += w;
    timeHintTally[p.theme][p.time_hint] += w;
    matches.push({ theme: p.theme, pattern_index: i });
  }

  // Pick the winning theme (argmax of score). NEUTRAL is the absorbing
  // default when no pattern fires.
  let bestTheme = "NEUTRAL";
  let bestScore = 0;
  let totalScore = 0;
  for (const t of THEME_LABELS) {
    totalScore += scores[t];
    if (scores[t] > bestScore) {
      bestScore = scores[t];
      bestTheme = t;
    }
  }

  // No matches at all → NEUTRAL with low confidence; the LLM refiner
  // gets to take a second look if it's a recent item.
  if (bestScore === 0) {
    return {
      theme: "NEUTRAL",
      sign: 0,
      intensity: 1,
      confidence: 0.2,
      time_hint: "medium",
      classifier_provider: "heuristic",
      classifier_version: CLASSIFIER_VERSION,
      matches: [],
    };
  }

  // Confidence = best theme's share of total evidence weight.
  // High when patterns cluster on one theme; low when they're split.
  const confidence = totalScore > 0 ? bestScore / totalScore : 0;

  // Resolve sign from the WINNING theme's signed sum. A flip-flop within
  // one theme (positive + negative both match) typically means low
  // certainty — we let confidence reflect that automatically.
  const winnerSignedSum = signedSums[bestTheme];
  let sign = 0;
  if (winnerSignedSum > 0) sign = 1;
  else if (winnerSignedSum < 0) sign = -1;

  // Average intensity weighted by pattern weights.
  const intInfo = intensitySums[bestTheme];
  const avgIntensity = intInfo.denom > 0 ? intInfo.num / intInfo.denom : 1;
  const intensity = Math.max(1, Math.min(3, Math.round(avgIntensity)));

  // Time hint = argmax of per-theme time tally.
  const th = timeHintTally[bestTheme];
  let timeHint = "medium";
  if (th.short >= th.medium && th.short >= th.long) timeHint = "short";
  else if (th.long > th.medium) timeHint = "long";

  return {
    theme: bestTheme,
    sign,
    intensity,
    confidence,
    time_hint: timeHint,
    classifier_provider: "heuristic",
    classifier_version: CLASSIFIER_VERSION,
    matches,
  };
}

/**
 * Classify many news items. Pure-function batch wrapper; no IO, no LLM.
 *
 * @param {Array<{title?: string, body?: string, date?: string}>} newsItems
 * @returns {Array<ReturnType<classifyOne>>}
 */
export function classifyBatch(newsItems) {
  if (!Array.isArray(newsItems)) return [];
  return newsItems.map(classifyOne);
}

/**
 * True if a heuristic classification result is reliable enough that the
 * LLM refiner can skip it. Used by `llmThemeRefiner.js` to gate which
 * items get an LLM second pass.
 */
export function isHighConfidenceHeuristic(result) {
  return (
    result &&
    typeof result.confidence === "number" &&
    result.confidence >= MIN_CONFIDENCE &&
    result.theme !== "NEUTRAL"
  );
}

export default {
  classifyOne,
  classifyBatch,
  isHighConfidenceHeuristic,
};
