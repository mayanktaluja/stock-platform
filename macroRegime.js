/**
 * Macro Regime Classifier
 *
 * Turns a batch of trusted-source macro headlines into a structured
 * "market regime" object the Buy Now scanner can use to tilt its
 * recommendations by sector.
 *
 * This module is DELIBERATELY separate from sentiment.js. Per-stock
 * sentiment there is strict (headlines must name the company); macro
 * regime detection here is the opposite — it lives on top-down signals
 * (war, rate decisions, oil shocks, policy) that sentiment.js
 * intentionally filters out.
 *
 * Pure functions only — no I/O beyond the LLM call. Caller provides
 * headlines, caller owns caching.
 */

import Anthropic from "@anthropic-ai/sdk";
import { checkBudget, recordUsage } from "./openaiBudget.js";

const MACRO_MODEL = process.env.MACRO_MODEL || "claude-haiku-4-5-20251001";

// ──────────────────── Enums ────────────────────

export const REGIMES = [
  "WAR_ESCALATION",    // active conflict affecting oil, defence, risk assets
  "WAR_DE_ESCALATION", // peace talks, ceasefire — reverses war trades
  "OIL_SHOCK",         // crude spikes unrelated to war (OPEC+ cut)
  "RATE_HIKE",         // RBI/Fed hawkish
  "RATE_CUT",          // dovish pivot
  "CURRENCY_WEAKNESS", // INR under pressure → IT exporters win
  "POLICY_STIMULUS",   // budget, PLI, infra push
  "REGULATORY_SHOCK",  // SEBI crackdown, ban on sector
  "GLOBAL_RISK_OFF",   // selloff in US / FII outflows
  "CALM",              // no significant macro event
];

// Canonical sector vocabulary used in regime output. The LLM is instructed to
// only emit these values; stockList.js sectors are mapped to these via
// `normalizeSector` before lookup.
export const SECTORS = [
  "Energy",
  "Oil & Gas",
  "Defence",
  "IT Services",
  "Banking",
  "NBFC",
  "Aviation",
  "Automobile",
  "FMCG",
  "Pharma",
  "Metals",
  "Real Estate",
  "Infrastructure",
  "Power",
  "Telecom",
  "Chemicals",
  "Retail",
  "Cement",
  "Capital Goods",
  "Media",
];

// Friendly human labels for regimes
export const REGIME_LABELS = {
  WAR_ESCALATION: "War Escalation",
  WAR_DE_ESCALATION: "War De-escalation",
  OIL_SHOCK: "Oil Shock",
  RATE_HIKE: "Rate Hike",
  RATE_CUT: "Rate Cut",
  CURRENCY_WEAKNESS: "Currency Weakness",
  POLICY_STIMULUS: "Policy Stimulus",
  REGULATORY_SHOCK: "Regulatory Shock",
  GLOBAL_RISK_OFF: "Global Risk-Off",
  CALM: "Calm",
};

// ──────────────────── Sector normalization ────────────────────

/**
 * Map the loose sector strings in stockList.js / portfolio.json to the
 * canonical SECTORS vocabulary used by the LLM prompt. Returns null if the
 * stock's sector doesn't cleanly map to any canonical sector — the macro
 * delta is zero in that case.
 */
export function normalizeSector(raw) {
  if (!raw) return null;
  const s = String(raw).trim().toLowerCase();

  // ─── Substring sniffing (before exact map) ───
  // NSE's sector labels are verbose ("Oil Gas & Consumable Fuels", "Metals &
  // Mining", "Financial Services") so we look for distinguishing substrings
  // first. More specific terms win — check "oil" before "gas", "defence"
  // before "capital goods", etc.
  if (s.includes("oil") || s.includes("petroleum") || s.includes("refineries")) return "Oil & Gas";
  if (s.includes("defen")) return "Defence"; // defence / defense
  if (s.includes("aviat") || s.includes("airline")) return "Aviation";
  if (s.includes("bank")) return "Banking";
  if (s.includes("nbfc") || s.includes("non banking") || s.includes("non-banking")) return "NBFC";
  if (s.includes("insur")) return "NBFC";
  if (s.includes("stockbrok") || s.includes("broker") || s.includes("wealth") || s.includes("asset manag")) return "NBFC";
  if (s.includes("financial product") || s.includes("financial servic") || s.includes("housing finance")) return "NBFC";
  if (s.includes("pharma") || s.includes("healthcare") || s.includes("hospital") || s.includes("diagnostic")) return "Pharma";
  if (s.includes("auto") || s.includes("2/3 wheeler") || s.includes("two wheeler") || s.includes("tyre")) return "Automobile";
  if (s.includes("ev ") || /\belectric vehicle/.test(s)) return "Automobile";
  if (s.includes("fmcg") || s.includes("consumer good") || s.includes("consumer durable")) return "FMCG";
  if (s.includes("personal care") || s.includes("household") || s.includes("food") || s.includes("beverage") || s.includes("agro")) return "FMCG";
  if (s.includes("sugar") || s.includes("dairy")) return "FMCG";
  if (s.includes("metal") || s.includes("steel") || s.includes("copper") || s.includes("alumin") || s.includes("iron")) return "Metals";
  if (s.includes("cement")) return "Cement";
  if (s.includes("realty") || s.includes("real estate")) return "Real Estate";
  if (s.includes("power") || s.includes("utilit") || s.includes("renewable") || s.includes("solar")) return "Power";
  if (s.includes("telecom")) return "Telecom";
  if (s.includes("chemic") || s.includes("fertiliz") || s.includes("agrochem")) return "Chemicals";
  if (s.includes("media") || s.includes("entertain") || s.includes("broadcast") || s.includes("gaming")) return "Media";
  if (s.includes("retail") || s.includes("e-commerce") || s.includes("e-retail") || s.includes("qsr") || s.includes("apparel") || s.includes("footwear")) return "Retail";
  if (s.includes("it ") || s.includes("information tech") || s.includes("software") || s.includes("technology")) return "IT Services";
  if (s.includes("infra") || s.includes("construction") || s.includes("logistic")) return "Infrastructure";
  if (s.includes("capital good") || s.includes("industrial") || s.includes("electric") || s.includes("machinery") || s.includes("engineering")) return "Capital Goods";

  // Direct / alias map (for exact-match cases not caught by substring sniffing)
  const MAP = {
    // Energy / oil & gas
    "energy": "Oil & Gas",
    "oil & gas": "Oil & Gas",
    "oil and gas": "Oil & Gas",
    "refineries": "Oil & Gas",
    "mining": "Metals",

    // IT
    "it": "IT Services",
    "it services": "IT Services",
    "information technology": "IT Services",
    "technology": "IT Services",
    "software": "IT Services",
    "internet": "IT Services",

    // Banking vs NBFC vs Insurance
    "banking": "Banking",
    "banks": "Banking",
    "private bank": "Banking",
    "psu bank": "Banking",
    "finance": "NBFC",
    "nbfc": "NBFC",
    "financial services": "NBFC",
    "fintech": "NBFC",
    "insurance": "NBFC", // close enough for rate-sensitivity purposes

    // Autos
    "auto": "Automobile",
    "automobile": "Automobile",
    "auto components": "Automobile",
    "automotive": "Automobile",

    // FMCG / consumer
    "fmcg": "FMCG",
    "consumer": "FMCG",
    "consumer goods": "FMCG",
    "consumer durables": "FMCG",

    // Pharma / healthcare
    "pharma": "Pharma",
    "pharmaceuticals": "Pharma",
    "healthcare": "Pharma",
    "health": "Pharma",

    // Metals
    "metals": "Metals",
    "steel": "Metals",
    "mining & metals": "Metals",

    // Real estate / infra / cement
    "real estate": "Real Estate",
    "realty": "Real Estate",
    "infrastructure": "Infrastructure",
    "infra": "Infrastructure",
    "construction": "Infrastructure",
    "cement": "Cement",

    // Power / utilities
    "power": "Power",
    "utilities": "Power",
    "renewable energy": "Power",

    // Telecom / media
    "telecom": "Telecom",
    "telecommunications": "Telecom",
    "media": "Media",
    "entertainment": "Media",

    // Chemicals
    "chemicals": "Chemicals",
    "specialty chemicals": "Chemicals",

    // Retail
    "retail": "Retail",
    "e-commerce": "Retail",
    "qsr": "Retail",

    // Capital goods / defence / aviation
    "capital goods": "Capital Goods",
    "industrial": "Capital Goods",
    "electricals": "Capital Goods",
    "electronics": "Capital Goods",
    "defence": "Defence",
    "defense": "Defence",
    "aviation": "Aviation",
    "airlines": "Aviation",
    "tourism": "Aviation", // travel-sensitive
    "hospitality": "Aviation", // travel-sensitive
    "diversified": null, // can't normalize cleanly
  };

  if (s in MAP) return MAP[s];

  // Fuzzy fallback: check if any canonical sector name appears in the string
  for (const canon of SECTORS) {
    if (s.includes(canon.toLowerCase())) return canon;
  }
  return null;
}

// ──────────────────── Default regime ────────────────────

export function defaultCalmRegime() {
  return {
    regime: "CALM",
    regimeLabel: "Calm",
    severity: 1,
    confidence: 0,
    sectorImpacts: [],
    keyEvents: [],
    reasoning: "No recent macro signal.",
    headlineCount: 0,
    generatedAt: new Date().toISOString(),
  };
}

// ──────────────────── LLM client (lazy) ────────────────────

let _anthropic = null;
function getAnthropic() {
  if (_anthropic) return _anthropic;
  if (!process.env.ANTHROPIC_API_KEY) return null;
  _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _anthropic;
}

/**
 * Retry wrapper for LLM calls. Handles transient failures like 429
 * (rate-limit), 500, 502, 503, and network errors with exponential backoff.
 * Returns the successful result or re-throws the last error after 3 attempts.
 * Delays: 1s, 4s, 15s (enough to ride out most brief spikes).
 */
export async function withOpenAIRetry(fn, { label = "openai", maxAttempts = 3 } = {}) {
  const delays = [1000, 4000, 15000];
  let lastErr = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      // Only retry on transient errors — don't loop on bad requests / auth failures
      const status = err?.status || err?.response?.status;
      const isTransient =
        status === 429 || status === 500 || status === 502 || status === 503 || status === 504 ||
        err?.code === "ECONNRESET" || err?.code === "ETIMEDOUT" || err?.code === "ENOTFOUND" ||
        /network|timeout|socket|fetch failed/i.test(err?.message || "");
      if (!isTransient || attempt === maxAttempts - 1) throw err;
      const delay = delays[attempt];
      console.warn(`[${label}] Attempt ${attempt + 1}/${maxAttempts} failed (${status || err.code || err.message}), retrying in ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// ──────────────────── Core classifier ────────────────────

/**
 * classifyRegime(headlines) → Regime object
 *
 * headlines: Array<{ title, source, sourceTier, publishedAt, url? }>
 *
 * Returns the full regime object. Never throws — on any failure returns
 * defaultCalmRegime() tagged with a reason.
 */
export async function classifyRegime(headlines) {
  if (!Array.isArray(headlines) || headlines.length === 0) {
    return { ...defaultCalmRegime(), reasoning: "No headlines provided." };
  }

  const client = getAnthropic();
  if (!client) {
    return { ...defaultCalmRegime(), reasoning: "LLM unavailable (no ANTHROPIC_API_KEY)." };
  }

  // Cap headlines to stay under token budget — keep the 40 most recent.
  const capped = headlines.slice(0, 40);

  const system = buildSystemPrompt();
  const userMessage = buildUserMessage(capped);

  // Phase 2: monthly budget circuit-breaker — if we've hit the cap, skip
  // the LLM call and return CALM. Scanner will continue to work just
  // without regime tilt until next month.
  const budget = checkBudget();
  if (!budget.allowed) {
    console.warn(`[MACRO] Monthly LLM cap hit ($${budget.spent.toFixed(2)} / $${budget.cap}). Falling back to CALM regime.`);
    return { ...defaultCalmRegime(), reasoning: "LLM monthly cap hit — using CALM fallback." };
  }

  try {
    const response = await withOpenAIRetry(
      () => client.messages.create({
        model: MACRO_MODEL,
        temperature: 0,
        max_tokens: 1200,
        system,
        messages: [{ role: "user", content: userMessage }],
      }),
      { label: "MACRO" }
    );

    const text = (response.content?.[0]?.text || "").trim();
    if (!text) throw new Error("Empty LLM response");

    const usage = response.usage || {};
    recordUsage({
      inputTokens: usage.input_tokens || 0,
      outputTokens: usage.output_tokens || 0,
      label: "macro",
    });

    // Extract the JSON object (LLM may wrap in code fence or prose)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON object in LLM response");

    const parsed = JSON.parse(jsonMatch[0]);
    return normalizeRegimeObject(parsed, capped.length);
  } catch (err) {
    console.error("[MACRO] classifyRegime failed:", err.message);
    return {
      ...defaultCalmRegime(),
      reasoning: `Classifier error: ${err.message}`,
    };
  }
}

// ──────────────────── Prompt building ────────────────────

function buildSystemPrompt() {
  return (
    "You are a macro strategist covering Indian equities. Given recent " +
    "trusted-source headlines, identify the single dominant MARKET REGIME " +
    "and its sector-level impact on Indian stocks.\n\n" +
    "OUTPUT RULES — strict JSON only, no prose, no code fence:\n" +
    "{\n" +
    '  "regime": "<one of: ' + REGIMES.join(" | ") + '>",\n' +
    '  "severity": <integer 1-5>,\n' +
    '  "confidence": <float 0-1>,\n' +
    '  "reasoning": "<one sentence, under 200 chars>",\n' +
    '  "keyEvents": ["<headline summary> (<source>)", ...3-5 items],\n' +
    '  "sectorImpacts": [\n' +
    '    { "sector": "<one of: ' + SECTORS.join(" | ") + '>", "impact": <integer -3..+3>, "reason": "<under 120 chars>" }\n' +
    "  ]\n" +
    "}\n\n" +
    "GUIDELINES:\n" +
    "  1. Pick ONE dominant regime. If headlines are mixed/stale, return CALM with severity 1.\n" +
    "  2. Severity: 1 = weak/background, 3 = meaningful, 5 = major shock (war, rate shock).\n" +
    "  3. Confidence: how clearly the headlines support this regime (0-1).\n" +
    "  4. sectorImpacts: ONLY include sectors with a clear directional impact. Impact -3 = strong sell, +3 = strong buy.\n" +
    "  5. Tier weighting: A+ (RBI/SEBI) and A (Reuters/Bloomberg) headlines are more authoritative than B (ET/MC/LiveMint/BS).\n" +
    "  6. Weight last 24h headlines heaviest. Ignore headlines older than 48h unless unusually important.\n" +
    "  7. Be CONSERVATIVE. When in doubt, lower severity/confidence or return CALM.\n" +
    "  8. Every sector value MUST be spelled exactly as listed above. No synonyms, no new sectors.\n" +
    "  9. keyEvents: copy headline gist + source name in parens, e.g. \"Brent crosses $95 on Iran strikes (Reuters)\".\n" +
    "\nOutput JSON and nothing else."
  );
}

function buildUserMessage(headlines) {
  const lines = headlines.map((h, i) => {
    const hoursAgo = h.publishedAt
      ? Math.round((Date.now() - new Date(h.publishedAt).getTime()) / 3600000)
      : "?";
    return `${i + 1}. [${h.sourceTier || "B"}] [${h.source}] [${hoursAgo}h ago] ${h.title}`;
  });
  return (
    `Classify the current Indian market macro regime from these ${headlines.length} headlines:\n\n` +
    lines.join("\n") +
    "\n\nReturn strict JSON only."
  );
}

// ──────────────────── Output normalization ────────────────────

function normalizeRegimeObject(raw, headlineCount) {
  const regime = REGIMES.includes(raw.regime) ? raw.regime : "CALM";
  const severity = clamp(Math.round(Number(raw.severity) || 1), 1, 5);
  const confidence = clamp(Number(raw.confidence) || 0, 0, 1);

  const sectorImpacts = Array.isArray(raw.sectorImpacts)
    ? raw.sectorImpacts
        .filter((s) => s && SECTORS.includes(s.sector))
        .map((s) => ({
          sector: s.sector,
          impact: clamp(Math.round(Number(s.impact) || 0), -3, 3),
          reason: String(s.reason || "").slice(0, 200),
        }))
        .filter((s) => s.impact !== 0)
    : [];

  const keyEvents = Array.isArray(raw.keyEvents)
    ? raw.keyEvents.map((e) => String(e).slice(0, 200)).slice(0, 5)
    : [];

  return {
    regime,
    regimeLabel: REGIME_LABELS[regime] || regime,
    severity,
    confidence,
    sectorImpacts,
    keyEvents,
    reasoning: String(raw.reasoning || "").slice(0, 300),
    headlineCount,
    generatedAt: new Date().toISOString(),
  };
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// ──────────────────── Macro delta for a stock ────────────────────

/**
 * Compute the macro score delta for a stock given the current regime.
 * Returns { delta: number (-15..+15), reason: string | null, sector: canonical | null }
 *
 * delta = impact * 2.5 * (severity / 3) * confidence
 *
 * The multiplier scales impact from [-3..+3] to roughly [-15..+15] at a
 * severity-5 confident regime. Clamped defensively.
 */
export function computeMacroDelta(regime, stockSector) {
  if (!regime || !Array.isArray(regime.sectorImpacts) || regime.sectorImpacts.length === 0) {
    return { delta: 0, reason: null, sector: null };
  }
  const canonical = normalizeSector(stockSector);
  if (!canonical) return { delta: 0, reason: null, sector: null };

  const hit = regime.sectorImpacts.find((s) => s.sector === canonical);
  if (!hit) return { delta: 0, reason: null, sector: canonical };

  const raw = hit.impact * 2.5 * (regime.severity / 3) * regime.confidence;
  const delta = clamp(Number(raw.toFixed(2)), -10, 10);
  return {
    delta,
    reason: `${canonical}: ${hit.reason}`,
    sector: canonical,
  };
}
