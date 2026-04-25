/**
 * StarBhai — long-term narrative engine for individual stocks.
 *
 * Produces a structured 3–12 month thesis combining:
 *   • The pre-computed longTermOutlook() recommendation + score
 *   • Fundamentals (ROE, D/E, margin, growth, P/E vs sector)
 *   • Quality flags from analysis.js (single failures we did NOT cap on)
 *   • Recent classified news from stockNews.js
 *   • Macro regime from macroRegime.js
 *
 * Output is strict JSON: { thesis, growthDrivers[], keyRisks[],
 * catalystsToWatch[], horizonView, newsContext, confidence }.
 *
 * Cost control:
 *   • Per-symbol cache keyed on (symbol, actionBucket, scoreBucket10) —
 *     same call on the same band hits cache; a re-rated stock invalidates
 *   • Honors openaiBudget circuit breaker — falls back to a deterministic
 *     template narrative when the cap is hit so the UI never shows a
 *     blank section
 *   • OpenAI key missing or LLM throws → deterministic template narrative
 *
 * SEBI tone: observational, never advisory. Cites the metrics tracked,
 * not "buy this stock."
 */

import NodeCache from "node-cache";
import { checkBudget, recordUsage } from "./openaiBudget.js";
import { withOpenAIRetry } from "./macroRegime.js";

const narrativeCache = new NodeCache({ stdTTL: 24 * 3600, checkperiod: 1800 });

const NARRATIVE_MODEL = process.env.STOCK_NARRATIVE_MODEL || "gpt-5.4";

const SYSTEM_PROMPT = `You are StarBhai, a SEBI-registered Research Analyst's structured-narrative engine for Indian equity LONG-TERM outlooks (3–12 month horizon).

INPUTS you receive:
  • Stock identity (symbol, name, sector, market-cap tier)
  • Pre-computed long-term recommendation, score, target, stop-loss
  • Fundamentals: ROE, D/E, profit margin, revenue growth, P/E vs sector
  • Quality flags (e.g., ROE_BELOW_10, DE_ABOVE_1, MARGIN_SOFT, GROWTH_SOFT)
  • Recent news (already classified MATERIAL/CONTEXT with sentiment + summary)
  • Current macro regime (WAR_ESCALATION, RATE_CUT, CALM, etc.) + impacted sectors

YOUR JOB: produce a structured JSON narrative explaining WHY this recommendation makes sense.

CRITICAL RULES:
  • Be SPECIFIC. Cite real ROE %, growth %, P/E numbers, named news events. Don't say "good fundamentals" — say "ROE 18% with revenue up 14% YoY."
  • Be OBSERVATIONAL, not advisory. Frame as "the metrics suggest…" or "the data points to…", NEVER as "buy this stock" or "you should sell."
  • Do NOT invent data. If a metric is null/missing, do not cite it. If recent news is empty, say so plainly.
  • Tie claims to inputs. If you say "earnings momentum strong," it must trace to a news item or revenue growth value you were given.
  • Confidence calibration:
      LOW    — fundamentals are thin (no ROE, no DMA, no sector P/E) OR data is contradictory
      MEDIUM — default — fundamentals + trend present, news ambiguous
      HIGH   — strong fundamentals AND supportive news AND constructive macro
  • Each list (growthDrivers, keyRisks, catalystsToWatch) must have AT LEAST 1 item and AT MOST 3.
  • newsContext is exactly ONE sentence — either summarize the 1-2 most material recent items, or state "No material recent news."

Return STRICTLY this JSON shape (no markdown, no prose outside JSON):
{
  "thesis": "1-2 sentence summary citing specific metrics and the recommendation.",
  "growthDrivers": ["bullet 1", "bullet 2", "bullet 3"],
  "keyRisks": ["bullet 1", "bullet 2", "bullet 3"],
  "catalystsToWatch": ["bullet 1", "bullet 2", "bullet 3"],
  "horizonView": "1-2 sentences specifically on the 3-12 month outlook.",
  "newsContext": "1 sentence on whether recent news shifts the picture, or 'No material recent news.'",
  "confidence": "HIGH|MEDIUM|LOW"
}`;

// ──────────────────── Cache key bucketing ────────────────────

function actionBucket(recommendation) {
  if (!recommendation) return "UNKNOWN";
  const r = String(recommendation).toUpperCase();
  if (r.includes("STRONG BUY")) return "STRONG_BUY";
  if (r.includes("BUY"))        return "BUY";
  if (r.includes("ACCUMULATE")) return "ACCUMULATE";
  if (r.includes("HOLD"))       return "HOLD";
  if (r.includes("REDUCE"))     return "REDUCE";
  if (r.includes("EXIT"))       return "EXIT";
  return "OTHER";
}

function scoreBucket10(score) {
  if (score == null) return "NULL";
  return String(Math.floor(score / 10) * 10);
}

// ──────────────────── Deterministic fallback ────────────────────
//
// When the LLM is unavailable (no key, budget exhausted, malformed
// response), we still return a useful narrative built from the inputs.
// Better than an empty section — the user always sees the WHY tied to
// the actual metrics.

function pct(v) {
  return v != null && Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : null;
}

function fmtNum(v, digits = 1) {
  return v != null && Number.isFinite(v) ? v.toFixed(digits) : null;
}

function fallbackNarrative({ symbol, name, sector, longTerm, fundamentals, news, macroRegime }) {
  const km = longTerm?.keyMetrics || {};
  const flags = longTerm?.qualityFlags || [];
  const rec = longTerm?.recommendation || "HOLD";
  const score = longTerm?.score;
  const verdict = longTerm?.fundamentalVerdict;

  const drivers = [];
  if (km.revenueGrowth != null && km.revenueGrowth >= 0.10)
    drivers.push(`Revenue growing ${pct(km.revenueGrowth)} YoY — top-line momentum intact`);
  if (km.roe != null && km.roe >= 0.15)
    drivers.push(`ROE of ${pct(km.roe)} signals efficient capital deployment`);
  if (km.profitMargin != null && km.profitMargin >= 0.15)
    drivers.push(`Net margin ${pct(km.profitMargin)} reflects pricing power`);
  if (km.pe != null && km.sectorPe != null && km.pe < km.sectorPe)
    drivers.push(`P/E ${fmtNum(km.pe)} trades below sector ${fmtNum(km.sectorPe)} — relative value cushion`);
  if (drivers.length === 0)
    drivers.push(`Long-term score ${score ?? "—"}/100 reflects current fundamental + trend mix`);

  const risks = [];
  if (flags.includes("ROE_BELOW_10")) risks.push(`ROE ${pct(km.roe)} below 10% — capital efficiency under watch`);
  if (flags.includes("DE_ABOVE_1"))   risks.push(`Debt/Equity ${fmtNum(km.debtToEquity)} above 1.0 — leverage elevated`);
  if (flags.includes("MARGIN_SOFT"))  risks.push(`Profit margin ${pct(km.profitMargin)} thin — limited cushion for cost shocks`);
  if (flags.includes("GROWTH_SOFT"))  risks.push(`Revenue growth ${pct(km.revenueGrowth)} muted — top-line traction limited`);
  if (km.pe != null && km.sectorPe != null && km.pe > km.sectorPe * 1.3)
    risks.push(`P/E ${fmtNum(km.pe)} ~${Math.round((km.pe / km.sectorPe - 1) * 100)}% above sector — valuation premium`);
  if (risks.length === 0)
    risks.push(`No standout quality concerns flagged on current data`);

  const catalysts = [];
  catalysts.push(`Next earnings print — confirmation of ${pct(km.revenueGrowth) || "growth"} run-rate`);
  if (km.pe != null && km.sectorPe != null && km.pe < km.sectorPe)
    catalysts.push(`Re-rating toward sector P/E ${fmtNum(km.sectorPe)} would unlock target`);
  if (longTerm?.target)
    catalysts.push(`Price action above ₹${fmtNum(longTerm.target)} confirms thesis; below stop-loss invalidates`);

  const newsItems = (news?.items || []).filter((i) => i.materiality === "MATERIAL").slice(0, 2);
  let newsContext = "No material recent news.";
  if (newsItems.length > 0) {
    newsContext = newsItems.map((i) => i.summary || i.title).join(" ");
  } else if ((news?.items || []).length > 0) {
    newsContext = "Recent coverage is general/contextual — no thesis-changing item.";
  }

  const macroLine = macroRegime?.regime && macroRegime.regime !== "CALM"
    ? ` Macro regime is ${macroRegime.regime.replace(/_/g, " ").toLowerCase()}.`
    : "";

  const thesis = `${name || symbol} carries a ${rec} on a long-term score of ${score ?? "—"}/100${verdict ? ` (${verdict.replace("_", " ").toLowerCase()})` : ""}.${macroLine}`;
  const horizonView = `Over a 3–12 month horizon, the call rests on ${verdict ? verdict.replace("_", " ").toLowerCase() : "current"} fundamentals and ${flags.length === 0 ? "no quality flags" : `${flags.length} quality flag${flags.length > 1 ? "s" : ""}`}. Watch the catalysts above for a re-rating.`;

  let confidence = "MEDIUM";
  if (km.roe == null || km.pe == null) confidence = "LOW";
  else if (flags.length === 0 && newsItems.some((i) => i.sentiment === "POSITIVE")) confidence = "HIGH";

  return {
    thesis,
    growthDrivers: drivers.slice(0, 3),
    keyRisks: risks.slice(0, 3),
    catalystsToWatch: catalysts.slice(0, 3),
    horizonView,
    newsContext,
    confidence,
    source: "fallback",
  };
}

// ──────────────────── LLM payload ────────────────────

function buildUserMessage(input) {
  const { symbol, name, sector, marketCapTier, longTerm, fundamentals, news, macroRegime } = input;
  const km = longTerm?.keyMetrics || {};
  const flags = longTerm?.qualityFlags || [];

  const lines = [
    `Symbol: ${symbol}`,
    `Name: ${name || symbol}`,
    sector ? `Sector: ${sector}` : null,
    marketCapTier ? `Market-cap tier: ${marketCapTier}` : null,
    "",
    "RECOMMENDATION (pre-computed):",
    `  Action: ${longTerm?.recommendation ?? "—"}`,
    `  Long-term score: ${longTerm?.score ?? "—"}/100  (fund ${longTerm?.fundamentalScore ?? "—"} · trend ${longTerm?.trendContextScore ?? "—"})`,
    `  Fundamental verdict: ${longTerm?.fundamentalVerdict ?? "—"}`,
    longTerm?.target ? `  Target: ₹${longTerm.target}` : null,
    longTerm?.stopLoss ? `  Stop-loss: ₹${longTerm.stopLoss}` : null,
    longTerm?.valuationBasis ? `  Target basis: ${longTerm.valuationBasis}` : null,
    "",
    "FUNDAMENTALS:",
    km.roe != null ? `  ROE: ${pct(km.roe)}` : "  ROE: not reported",
    km.debtToEquity != null ? `  Debt/Equity: ${fmtNum(km.debtToEquity, 2)}` : "  Debt/Equity: not reported",
    km.profitMargin != null ? `  Profit margin: ${pct(km.profitMargin)}` : "  Profit margin: not reported",
    km.revenueGrowth != null ? `  Revenue growth (YoY): ${pct(km.revenueGrowth)}` : "  Revenue growth: not reported",
    km.pe != null ? `  P/E: ${fmtNum(km.pe)}` : "  P/E: not reported",
    km.sectorPe != null ? `  Sector P/E: ${fmtNum(km.sectorPe)}` : "  Sector P/E: not reported",
    "",
    `QUALITY FLAGS: ${flags.length === 0 ? "none" : flags.join(", ")}`,
    "",
    "RECENT NEWS (last 30 days, classified):",
    ...(((news?.items || []).slice(0, 5)).map((it, i) =>
      `  ${i + 1}. [${it.materiality || "?"} · ${it.eventKind || "OTHER"} · ${it.sentiment || "NEUTRAL"}] ${it.summary || it.title}`
    )),
    (news?.items || []).length === 0 ? "  (no recent news from sources)" : null,
    "",
    `MACRO REGIME: ${macroRegime?.regime || "CALM"}`,
    macroRegime?.tailwindSectors?.length ? `  Tailwind sectors: ${macroRegime.tailwindSectors.join(", ")}` : null,
    macroRegime?.headwindSectors?.length ? `  Headwind sectors: ${macroRegime.headwindSectors.join(", ")}` : null,
  ].filter(Boolean);

  return lines.join("\n");
}

// ──────────────────── Public API ────────────────────

/**
 * Generate the long-term narrative for one stock.
 *
 * @param {object} input - see buildUserMessage for shape
 * @returns {object} narrative — { thesis, growthDrivers, keyRisks,
 *   catalystsToWatch, horizonView, newsContext, confidence, source }
 */
export async function generateNarrative(input) {
  const { symbol, longTerm, openai = null } = input;
  if (!symbol || !longTerm) {
    return fallbackNarrative({ ...input, longTerm: longTerm || {} });
  }

  const cacheKey = `narrative.${String(symbol).toLowerCase()}.${actionBucket(longTerm.recommendation)}.${scoreBucket10(longTerm.score)}`;
  const cached = narrativeCache.get(cacheKey);
  if (cached) return cached;

  // No key OR budget exhausted → deterministic fallback
  if (!openai) {
    const out = fallbackNarrative(input);
    narrativeCache.set(cacheKey, out);
    return out;
  }
  const budget = checkBudget();
  if (!budget.allowed) {
    console.warn(`[NARRATIVE] Budget cap hit ($${budget.spent.toFixed(2)} / $${budget.cap}) — fallback narrative for ${symbol}`);
    const out = fallbackNarrative(input);
    narrativeCache.set(cacheKey, out);
    return out;
  }

  const userMessage = buildUserMessage(input);

  try {
    const resp = await withOpenAIRetry(
      () => openai.chat.completions.create({
        model: NARRATIVE_MODEL,
        temperature: 0.2,
        max_completion_tokens: 700,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userMessage },
        ],
      }),
      { label: "stock-narrative", maxAttempts: 2 },
    );

    if (resp.usage) {
      recordUsage({
        inputTokens: resp.usage.prompt_tokens || 0,
        outputTokens: resp.usage.completion_tokens || 0,
        label: "stock-narrative",
      });
    }

    const text = (resp.choices?.[0]?.message?.content || "").trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON in narrative response");

    const parsed = JSON.parse(jsonMatch[0]);

    // Validate shape — fall back to template if any required field is missing.
    if (!parsed.thesis || !Array.isArray(parsed.growthDrivers) || !Array.isArray(parsed.keyRisks)
        || !Array.isArray(parsed.catalystsToWatch) || !parsed.horizonView || !parsed.newsContext
        || !parsed.confidence) {
      throw new Error("Narrative response missing required fields");
    }

    const out = {
      thesis: String(parsed.thesis).trim(),
      growthDrivers: parsed.growthDrivers.slice(0, 3).map((s) => String(s).trim()).filter(Boolean),
      keyRisks: parsed.keyRisks.slice(0, 3).map((s) => String(s).trim()).filter(Boolean),
      catalystsToWatch: parsed.catalystsToWatch.slice(0, 3).map((s) => String(s).trim()).filter(Boolean),
      horizonView: String(parsed.horizonView).trim(),
      newsContext: String(parsed.newsContext).trim(),
      confidence: ["HIGH", "MEDIUM", "LOW"].includes(parsed.confidence)
        ? parsed.confidence : "MEDIUM",
      source: "llm",
    };

    narrativeCache.set(cacheKey, out);
    return out;
  } catch (err) {
    console.warn(`[NARRATIVE] LLM failed for ${symbol}:`, err.message);
    const out = fallbackNarrative(input);
    narrativeCache.set(cacheKey, out);
    return out;
  }
}

/**
 * Bulk: enrich each stock holding with `narrative`. Concurrency 3.
 */
export async function enrichStockNarratives(holdings = [], { openai = null, macroRegime = null } = {}) {
  if (!Array.isArray(holdings) || holdings.length === 0) return holdings;

  const CONCURRENCY = 3;
  let i = 0;
  async function worker() {
    while (i < holdings.length) {
      const idx = i++;
      const h = holdings[idx];
      if (!h?.longTerm) continue;
      try {
        h.longTerm.narrative = await generateNarrative({
          symbol: h.symbol,
          name: h.name,
          sector: h.sector,
          marketCapTier: h.marketCapTier || h.fundamentals?.breakdown?.tier,
          longTerm: h.longTerm,
          fundamentals: h.fundamentals,
          news: h.news,
          macroRegime,
          openai,
        });
      } catch (err) {
        console.warn(`[NARRATIVE] enrich failed for ${h.symbol}:`, err.message);
        h.longTerm.narrative = fallbackNarrative({
          symbol: h.symbol, name: h.name, sector: h.sector,
          longTerm: h.longTerm, fundamentals: h.fundamentals,
          news: h.news, macroRegime,
        });
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return holdings;
}
