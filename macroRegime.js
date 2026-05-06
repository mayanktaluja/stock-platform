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

import OpenAI from "openai";
import { checkBudget, recordUsage } from "./openaiBudget.js";

const MACRO_MODEL = process.env.MACRO_MODEL || "llama-3.3-70b-versatile";
const GROQ_BASE_URL = "https://api.groq.com/openai/v1";
const MACRO_GEMINI_MODEL = process.env.MACRO_GEMINI_MODEL || "gemini-2.0-flash";
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/";

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

// ──────────────────── Heuristic classifier (last-resort fallback) ────────────────────
//
// Used only when ALL LLM providers (Groq + Gemini) are exhausted. Less
// accurate than an LLM but deterministic, free, and never fails. Keeps the
// macro banner functional through quota outages, deploy issues, or any
// other LLM unavailability — the user explicitly asked for the classifier
// to "work all the time", and this is what makes that promise stick.
//
// The heuristic counts keyword hits per regime per headline, picks the
// dominant regime, and assigns confidence proportional to signal strength.
// Sector impacts come from a precomputed map per regime (same shape the
// LLM produces).

const REGIME_KEYWORDS = {
  WAR_ESCALATION: /\b(war|missile|strike|airstrike|invasion|invade|escalat|conflict|attack|tank|drone|deploy|troop|military)\b/i,
  WAR_DE_ESCALATION: /\b(ceasefire|truce|peace ?talks?|de-?escalat|withdraw|disengage|treaty)\b/i,
  OIL_SHOCK: /\b(oil price|crude|opec|petroleum|gasoline|barrel|brent|wti|fuel price)\b/i,
  RATE_HIKE: /\b(rate hike|tighten|hawkish|raise rates?|fed hike|rbi hike|hike rate|hike repo)\b/i,
  RATE_CUT: /\b(rate cut|cuts? rates?|ease|dovish|lower rates?|fed cut|rbi cut|cut repo)\b/i,
  CURRENCY_WEAKNESS: /\b(rupee (fall|weak|slid|drop|tumb)|inr (weak|fall)|dollar (strong|surge)|forex|currency rout)\b/i,
  POLICY_STIMULUS: /\b(stimulus|budget|pli scheme|infrastructure (push|spend)|subsidy|tax cut|relief package)\b/i,
  REGULATORY_SHOCK: /\b(sebi (ban|crackdown|order)|regulator|ban on|crackdown|investigation|raid|enforcement)\b/i,
  GLOBAL_RISK_OFF: /\b(selloff|fii outflow|global rout|recession|panic sell|risk-?off|crash|tumble)\b/i,
};

const REGIME_SECTOR_TEMPLATES = {
  WAR_ESCALATION: [
    { sector: "Defence", impact: 4, reason: "War events boost defence orders" },
    { sector: "Oil & Gas", impact: 2, reason: "Conflict raises crude price expectations" },
    { sector: "Aviation", impact: -3, reason: "Higher fuel costs squeeze margins" },
  ],
  WAR_DE_ESCALATION: [
    { sector: "Defence", impact: -2, reason: "Lower urgency for new orders" },
    { sector: "Aviation", impact: 2, reason: "Fuel relief on de-escalation" },
  ],
  OIL_SHOCK: [
    { sector: "Oil & Gas", impact: 3, reason: "Crude price spike benefits upstream producers" },
    { sector: "Aviation", impact: -3, reason: "Higher fuel costs hurt airlines" },
    { sector: "Automobile", impact: -2, reason: "Higher input costs and weaker demand" },
  ],
  RATE_HIKE: [
    { sector: "Banking", impact: 2, reason: "NIM expansion in a hike cycle" },
    { sector: "NBFC", impact: -2, reason: "Cost of funds rises faster than yields" },
    { sector: "Real Estate", impact: -3, reason: "Mortgage rates dampen demand" },
    { sector: "Automobile", impact: -2, reason: "EMI affordability hit" },
  ],
  RATE_CUT: [
    { sector: "Banking", impact: -1, reason: "NIM compression on cuts" },
    { sector: "NBFC", impact: 3, reason: "Cheaper funding boosts spreads" },
    { sector: "Real Estate", impact: 3, reason: "Lower mortgage rates lift demand" },
    { sector: "Automobile", impact: 2, reason: "Cheaper EMIs lift sales" },
  ],
  CURRENCY_WEAKNESS: [
    { sector: "IT Services", impact: 3, reason: "Weak rupee inflates USD revenue in INR" },
    { sector: "Pharma", impact: 2, reason: "Dollar exporters benefit" },
    { sector: "Oil & Gas", impact: -2, reason: "Higher import costs for crude" },
  ],
  POLICY_STIMULUS: [
    { sector: "Capital Goods", impact: 3, reason: "Infra spending drives orders" },
    { sector: "Infrastructure", impact: 3, reason: "Direct beneficiary of stimulus" },
    { sector: "Cement", impact: 2, reason: "Demand pull from infra projects" },
  ],
  REGULATORY_SHOCK: [
    { sector: "Banking", impact: -2, reason: "Sector-wide regulatory uncertainty" },
    { sector: "NBFC", impact: -3, reason: "Heightened compliance pressure" },
  ],
  GLOBAL_RISK_OFF: [
    { sector: "IT Services", impact: -2, reason: "Foreign demand weakens in risk-off" },
    { sector: "Banking", impact: -2, reason: "FII outflows pressure financials" },
    { sector: "Pharma", impact: 1, reason: "Defensive bias in risk-off" },
    { sector: "FMCG", impact: 1, reason: "Defensive bias in risk-off" },
  ],
  CALM: [],
};

export function heuristicClassifyRegime(headlines) {
  if (!Array.isArray(headlines) || headlines.length === 0) {
    return { ...defaultCalmRegime(), reasoning: "No headlines available — defaulting to Calm." };
  }

  const scores = Object.fromEntries(REGIMES.map((r) => [r, 0]));
  const matchedTitles = Object.fromEntries(REGIMES.map((r) => [r, []]));
  for (const h of headlines) {
    const t = String(h.title || "");
    for (const [regime, pattern] of Object.entries(REGIME_KEYWORDS)) {
      if (pattern.test(t)) {
        scores[regime] += 1;
        if (matchedTitles[regime].length < 3) matchedTitles[regime].push(t);
      }
    }
  }

  const ranked = Object.entries(scores).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  const total = headlines.length;

  if (ranked.length === 0) {
    return {
      ...defaultCalmRegime(),
      headlineCount: total,
      confidence: 0.5,
      reasoning: `No regime-defining signals across ${total} headlines — markets appear calm.`,
      classifierProvider: "heuristic",
    };
  }

  const [topRegime, topScore] = ranked[0];
  // Confidence scaled by signal density, capped between 0.35 and 0.7 since
  // keyword matching is necessarily less reliable than LLM analysis.
  const confidence = Math.min(0.7, Math.max(0.35, 0.35 + (topScore / total) * 0.7));
  const severity = Math.min(5, Math.max(1, Math.round(1 + topScore / 2)));
  const label = REGIME_LABELS[topRegime] || topRegime;

  return {
    regime: topRegime,
    regimeLabel: label,
    severity,
    confidence,
    sectorImpacts: REGIME_SECTOR_TEMPLATES[topRegime] || [],
    keyEvents: matchedTitles[topRegime].slice(0, 3),
    // Phrasing avoids the degraded-banner trigger words ("unavailable",
    // "error", "quota", "429") so the UI renders this as a normal banner.
    reasoning: `${topScore} of ${total} recent headlines fit a "${label}" pattern (keyword-based read; switch happens automatically when full classifiers refresh).`,
    headlineCount: total,
    generatedAt: new Date().toISOString(),
    classifierProvider: "heuristic",
  };
}

// ──────────────────── LLM client (lazy) ────────────────────

let _groq = null;
function getGroq() {
  if (_groq) return _groq;
  if (!process.env.GROQ_API_KEY) return null;
  _groq = new OpenAI({ apiKey: process.env.GROQ_API_KEY, baseURL: GROQ_BASE_URL });
  return _groq;
}

let _gemini = null;
function getGeminiClient() {
  if (_gemini) return _gemini;
  if (!process.env.GEMINI_API_KEY) return null;
  _gemini = new OpenAI({ apiKey: process.env.GEMINI_API_KEY, baseURL: GEMINI_BASE_URL });
  return _gemini;
}

// Groq TPD quota state — set by withOpenAIRetry when a long-duration 429
// (>120s wait) is detected. These indicate a per-day token cap, not a
// transient spike. Callers can check getGroqQuotaState() before calling.
let groqQuotaUntil = 0;

export function getGroqQuotaState() {
  const now = Date.now();
  if (now >= groqQuotaUntil) {
    return { limited: false, retryAfterMs: 0, until: groqQuotaUntil };
  }
  return { limited: true, retryAfterMs: groqQuotaUntil - now, until: groqQuotaUntil };
}

/**
 * Retry wrapper for LLM calls. Handles transient failures like 429
 * (rate-limit), 500, 502, 503, and network errors with exponential backoff.
 * Returns the successful result or re-throws the last error after 3 attempts.
 * Delays: 1s, 4s, 15s (enough to ride out most brief spikes).
 *
 * When a 429 carries a "Please try again in Xm Ys" message and the parsed
 * wait is >120s, treats it as a daily-quota event: records groqQuotaUntil
 * and re-throws immediately so callers can fall back to cached data instead
 * of burning the remaining retries.
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

      // Always parse quota windows from 429s — even on the final retry — so
      // groqQuotaUntil reflects the latest known wait time. Callers (the
      // refresh function) check this state to decide whether to bother
      // making the next call at all.
      if (status === 429) {
        const m = (err?.message || "").match(/please try again in (?:(\d+)m)?(\d+(?:\.\d+)?)s/i);
        if (m) {
          const waitMs = (parseInt(m[1] || "0", 10) * 60 + parseFloat(m[2])) * 1000;
          // Any 429 with a parseable wait sets the quota window — protects
          // against the next instance making another wasteful call.
          groqQuotaUntil = Date.now() + waitMs;
          // Long waits (>120s) = daily quota; short skipping the remaining
          // retries since they'd all fail.
          if (waitMs > 120_000) {
            console.warn(
              `[${label}] Groq TPD quota — skipping retries, quota clears at ` +
              `${new Date(groqQuotaUntil).toISOString()} (~${Math.ceil(waitMs / 60000)}m).`
            );
            throw err;
          }
        }
      }

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
 * Run the LLM classification call against a specific provider.
 * Returns { regime, providerLabel } on success, throws on failure.
 */
async function runClassification({ client, model, label, trackBudget }, { system, userMessage, headlineCount }) {
  const response = await withOpenAIRetry(
    () => client.chat.completions.create({
      model,
      temperature: 0,
      max_tokens: 1200,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: userMessage },
      ],
    }),
    { label }
  );

  const text = (response.choices?.[0]?.message?.content || "").trim();
  if (!text) throw new Error("Empty LLM response");

  // Track spend only for paid providers (Groq is free).
  if (trackBudget) {
    const usage = response.usage || {};
    recordUsage({
      inputTokens: usage.prompt_tokens || 0,
      outputTokens: usage.completion_tokens || 0,
      label,
    });
  }

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("No JSON object in LLM response");

  const parsed = JSON.parse(jsonMatch[0]);
  return normalizeRegimeObject(parsed, headlineCount);
}

/**
 * classifyRegime(headlines) → Regime object
 *
 * headlines: Array<{ title, source, sourceTier, publishedAt, url? }>
 *
 * Three-step fallback chain: Groq → Gemini → keyword heuristic. Never throws.
 * Both LLM providers run on free tiers (Groq 100K TPD, Gemini 1500 RPD on
 * aistudio.google.com). When Groq is throttled or fails, Gemini takes over
 * with the same prompt; if Gemini is unconfigured/throttled/fails too, the
 * heuristic produces a real regime from headline keywords so the macro
 * banner stays functional. Paid providers are deliberately not in this
 * chain — see PR #114 for the trade-offs.
 */
export async function classifyRegime(headlines) {
  if (!Array.isArray(headlines) || headlines.length === 0) {
    return { ...defaultCalmRegime(), reasoning: "No headlines provided." };
  }

  // Cap headlines to stay under token budget — keep the 40 most recent.
  const capped = headlines.slice(0, 40);
  const promptCtx = {
    system: buildSystemPrompt(),
    userMessage: buildUserMessage(capped),
    headlineCount: capped.length,
  };

  // Step 1 — Groq (primary; fastest free LLM, 100K TPD).
  const groqClient = getGroq();
  const groqQuota = getGroqQuotaState();
  if (!groqClient) {
    console.warn("[MACRO] No GROQ_API_KEY — trying Gemini.");
  } else if (groqQuota.limited) {
    // Skip Groq if its TPD quota is currently exhausted — no point burning
    // a network round-trip to get the same 429 we already know about.
    console.log(`[MACRO] Groq quota active until ${new Date(groqQuota.until).toISOString()} — trying Gemini.`);
  } else {
    try {
      const regime = await runClassification(
        { client: groqClient, model: MACRO_MODEL, label: "MACRO/groq", trackBudget: false },
        promptCtx
      );
      regime.classifierProvider = "groq";
      console.log(`[MACRO] Classification via groq: ${regime.regime} (sev ${regime.severity}, conf ${regime.confidence?.toFixed?.(2) ?? regime.confidence})`);
      return regime;
    } catch (err) {
      console.warn(`[MACRO] Groq failed: ${err.message} — trying Gemini.`);
    }
  }

  // Step 2 — Gemini (free secondary; 1500 RPD on aistudio.google.com).
  const geminiClient = getGeminiClient();
  if (!geminiClient) {
    console.log("[MACRO] No GEMINI_API_KEY — using heuristic keyword classifier.");
  } else {
    try {
      const regime = await runClassification(
        { client: geminiClient, model: MACRO_GEMINI_MODEL, label: "MACRO/gemini", trackBudget: false },
        promptCtx
      );
      regime.classifierProvider = "gemini";
      console.log(`[MACRO] Classification via gemini: ${regime.regime} (sev ${regime.severity}, conf ${regime.confidence?.toFixed?.(2) ?? regime.confidence})`);
      return regime;
    } catch (err) {
      console.warn(`[MACRO] Gemini failed: ${err.message} — using heuristic keyword classifier.`);
    }
  }

  // Step 3 — keyword heuristic (deterministic, no network, never fails).
  return heuristicClassifyRegime(capped);
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
