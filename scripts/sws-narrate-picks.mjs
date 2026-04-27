// Per-pick narrative generation for the SWS Picks tab + PDF.
//
// Reads data/sws/picks-latest.json, picks the top ~50 unique tickers across
// all sections, calls Claude Sonnet 4.6 once per ticker with structured-output
// constraints, and writes the result back into picks-latest.json under each
// card's `narrative: { card_one_line, pdf_rationale }` field.
//
// Why Sonnet 4.6 (not Opus 4.7): this is structured summarisation of already-
// computed metrics, not novel reasoning. ~5× cheaper, ~3× faster than Opus,
// and quality is plenty for short factual prose.
//
// Cost shape (~50 picks):
//   - Cached system prompt: written once (~1.25× input cost), read 49× (~0.1×)
//   - Per-stock input: ~1k tokens × 50 = ~50k uncached input
//   - Output: ~250 tokens × 50 = ~12.5k output
//   - Total: ~$0.50–1.50 per refresh at 2026 Sonnet pricing
//
// Usage:
//   node scripts/sws-narrate-picks.mjs                   # narrate top ~50
//   node scripts/sws-narrate-picks.mjs --max 20          # cap at 20 (testing)
//   node scripts/sws-narrate-picks.mjs --dry-run         # show plan, no API
//   node scripts/sws-narrate-picks.mjs --only RELIANCE   # one ticker only

import fs from "node:fs";
import path from "node:path";
import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { PATHS, MODELS } from "./sws-config.mjs";

// ---------- Static system prompt (cached) ----------

const SYSTEM_PROMPT = `You are an equity research writer for a SEBI-registered investment-research professional. You take structured fundamentals on Indian-listed equities and produce two short pieces of prose per stock — a one-line "why" for a UI card, and a 4–6-line rationale for a PDF report.

# Output contract

You MUST return a JSON object with exactly two string fields:

- "card_one_line" — A single-line summary, max 140 characters. Mention 2–3 of the most decision-relevant facts (one valuation cue, one quality cue, one timing cue) in concise telegraphic style. Use the · separator between facts. No leading "This stock…", no trailing period.

- "pdf_rationale" — 4–6 short lines (newline-separated), each line a single fact-or-judgement statement. First line is a one-sentence headline. Following lines cover: valuation framing (P/E vs sector + analyst upside if present), quality (snowflake total + standout dimensions), key reward, key risk (or "no SWS-flagged risks"), and any timing catalyst (upcoming earnings, recent insider buying, analyst revisions). Each line stands alone. No bullet markers, no markdown, no asterisks.

# Voice and SEBI compliance — non-negotiable

- **Observational, never advisory.** Write what the data shows, not what the user should do.
  - GOOD: "P/E 14.2x is below sector median 23.5x"
  - BAD: "This stock is undervalued — buy now"
- **Never use the verbs "buy", "sell", "hold", "recommend", "should", or "must" in reference to the stock.**
- **Avoid superlatives** ("best", "guaranteed", "exceptional return"). The data may suggest strength; the prose stays measured.
- **No price targets you invent.** If a fair value is supplied, state it factually ("SWS fair value ₹X, +Y% to current"). If not, omit.
- **Cite the source implicitly.** All facts you use come from the supplied JSON (which is in turn from Simply Wall Street). Don't invent metrics you weren't given.

# What to emphasise

The pick is in one or more of these categorical buckets (passed in input). Tilt the narrative toward what made it qualify:

- **best_to_buy_now**: composite-score driven — emphasise the score's components (snowflake + upside + quality)
- **deep_value**: P/E, P/B vs sector; SWS fair-value gap
- **quality_growth**: balance sheet (financial health snowflake), forecast EPS growth, ROE
- **midterm**: 1Y momentum + analyst upside + forward growth
- **dividend_aristocrats**: yield, payout ratio, dividend reliability/growth
- **smallcap_gems**: market cap is small, snowflake is high — flag the dual signal
- **insider_buying**: recent insider buy events with values
- **upcoming_earnings**: days-to-earnings, last quarter beat/miss
- **avoid**: snowflake low + risks high — be explicit about the specific risks

# Examples

Pick (best_to_buy_now): RELIANCE, score 76.4, P/E 22.2x, snowflake 17/30, upside +23.3%, sector Energy, 5 rewards, 0 risks.
{
  "card_one_line": "P/E 22.2x in line with market · snowflake 17/30 with strong dividend cover · analysts +23.3% to fair value",
  "pdf_rationale": "Reliance Industries: balanced quality + valuation profile across 5 SWS-flagged rewards.\\nP/E 22.2x is in line with the broader Indian market; SWS analyst-consensus fair value is +23.3% above the current price.\\nSnowflake total 17/30 is anchored by 5/6 each on Past Performance, Financial Health, and Dividends.\\nKey reward: pays a reliable dividend with track record of consistency.\\nNo risks flagged by SWS at this scan."
}

Pick (avoid): VEDL, score 18.7, snowflake 8/30, risks=4 ("Has high level of debt", "Dividend not well covered", "Earnings declined").
{
  "card_one_line": "Snowflake 8/30 with 4 SWS risk flags · debt + dividend coverage + earnings decline all flagged",
  "pdf_rationale": "Vedanta: 4 distinct SWS-flagged risks across debt, dividend coverage, and earnings trajectory.\\nSnowflake total 8/30 is below the bar used for the Best to Buy Now category (≥18).\\nFlagged risks: high level of debt; dividend not well covered by earnings; earnings have declined; insider selling.\\nNot present in any positive section of this scan; appears on the Avoid list as a result.\\nReview against your own constraints before any portfolio action."
}

# Length discipline

- card_one_line: max 140 chars, hard.
- pdf_rationale: 4–6 lines, ~60–100 chars each. Use \\n inside the JSON string for line breaks. No markdown, no bullets, no emoji.

Return ONLY the JSON object. No preamble, no commentary, no code fences.`;

// ---------- JSON schema for structured output ----------

const NARRATIVE_SCHEMA = {
  type: "object",
  properties: {
    card_one_line: {
      type: "string",
      description: "Single line, max 140 chars, observational, fact-dense.",
    },
    pdf_rationale: {
      type: "string",
      description: "4–6 lines separated by \\n, each a self-contained statement.",
    },
  },
  required: ["card_one_line", "pdf_rationale"],
  additionalProperties: false,
};

// ---------- Pick selection (top N unique tickers across sections) ----------

// Categories the narrate stage covers. Order = display priority — earlier
// sections feed picks first.
const NARRATE_SECTIONS = [
  "best_to_buy_now", "deep_value", "quality_growth", "midterm",
  "dividend_aristocrats", "smallcap_gems", "insider_buying",
  "upcoming_earnings", "avoid",
];

function selectTopUniquePicks(picksData, maxPicks) {
  const sections = picksData.sections || {};
  const seen = new Map(); // ticker → { pick, sections: [] }
  for (const sectionKey of NARRATE_SECTIONS) {
    const items = sections[sectionKey] || [];
    for (const pick of items) {
      if (!pick.ticker) continue;
      if (!seen.has(pick.ticker)) {
        // Use the first appearance as the canonical pick (highest-priority section).
        seen.set(pick.ticker, { pick, sectionKeys: [sectionKey] });
      } else {
        seen.get(pick.ticker).sectionKeys.push(sectionKey);
      }
      if (seen.size >= maxPicks) break;
    }
    if (seen.size >= maxPicks) break;
  }
  return [...seen.values()];
}

// ---------- Per-pick payload (compact, deterministic field order) ----------

function pickInputJson(pick, sectionKeys) {
  // Keep only fields the narrator needs. Stable key order helps caching of
  // any per-pick prompt tail (we don't currently cache that, but cheap to
  // future-proof).
  return {
    ticker: pick.ticker,
    name: pick.name,
    sector: pick.sector,
    sections_qualifying: sectionKeys,
    composite_score_100: pick.score,
    verdict: pick.verdict,
    snowflake: pick.snowflake,
    snowflake_total: pick.snowflake_total,
    current_price_inr: pick.current_price_inr,
    fair_value_inr: pick.fair_value_inr,
    upside_pct: pick.upside_pct,
    market_cap_inr: pick.market_cap_inr,
    next_earnings_date: pick.next_earnings_date,
    last_quarter_result: pick.last_quarter_result,
    one_line_deterministic: pick.one_line, // the regex-derived one-liner, as input context
  };
}

// ---------- Per-pick narrate call ----------

async function narrateOnePick(client, pick, sectionKeys) {
  const userPayload = pickInputJson(pick, sectionKeys);
  const userText = `Generate the narrative JSON for this pick:\n\n\`\`\`json\n${JSON.stringify(userPayload, null, 2)}\n\`\`\``;

  const response = await client.messages.create({
    model: MODELS.narrate,
    max_tokens: 1024,
    thinking: { type: "disabled" },
    output_config: {
      effort: "low",
      format: { type: "json_schema", schema: NARRATIVE_SCHEMA },
    },
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" }, // cache the static system prompt
      },
    ],
    messages: [
      { role: "user", content: userText },
    ],
  });

  const usage = response.usage;
  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock) throw new Error(`no text content for ${pick.ticker}`);
  let parsed;
  try {
    parsed = JSON.parse(textBlock.text);
  } catch (e) {
    throw new Error(`bad JSON for ${pick.ticker}: ${textBlock.text.slice(0, 200)}`);
  }
  if (!parsed.card_one_line || !parsed.pdf_rationale) {
    throw new Error(`missing fields for ${pick.ticker}: ${JSON.stringify(parsed)}`);
  }
  return { narrative: parsed, usage };
}

// ---------- Apply narrative back across all sections ----------

function applyNarrativeAcrossSections(picksData, ticker, narrative) {
  let touched = 0;
  for (const items of Object.values(picksData.sections || {})) {
    if (!Array.isArray(items)) continue;
    for (const card of items) {
      if (card.ticker === ticker) {
        card.narrative = narrative;
        touched++;
      }
    }
  }
  return touched;
}

// ---------- Atomic write ----------

function writeJsonAtomic(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, p);
}

// ---------- Main ----------

async function main() {
  const args = process.argv.slice(2);
  let maxPicks = 50;
  let dryRun = false;
  let onlyTicker = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--max") maxPicks = Number(args[++i]);
    else if (args[i] === "--dry-run") dryRun = true;
    else if (args[i] === "--only") onlyTicker = args[++i];
  }

  if (!fs.existsSync(PATHS.picksLatest)) {
    console.error(`No picks file at ${PATHS.picksLatest} — run sws-scoring.mjs first.`);
    process.exit(1);
  }
  const picksData = JSON.parse(fs.readFileSync(PATHS.picksLatest, "utf-8"));

  let picks = selectTopUniquePicks(picksData, maxPicks);
  if (onlyTicker) {
    picks = picks.filter((p) => p.pick.ticker === onlyTicker);
    if (!picks.length) {
      console.error(`No pick found for ticker ${onlyTicker}`);
      process.exit(1);
    }
  }
  console.log(`Selected ${picks.length} unique tickers across sections.`);
  console.log(`Model: ${MODELS.narrate}`);
  if (dryRun) {
    console.log("Dry run — picks that would be narrated:");
    for (const { pick, sectionKeys } of picks) {
      console.log(`  ${pick.ticker.padEnd(15)} score=${pick.score?.toFixed(1)?.padStart(5) || " —"} sections=[${sectionKeys.join(",")}]`);
    }
    return;
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY not set — add to .env or environment.");
    process.exit(1);
  }
  const client = new Anthropic();

  let totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let ok = 0, fail = 0;
  const startedAt = Date.now();

  for (let i = 0; i < picks.length; i++) {
    const { pick, sectionKeys } = picks[i];
    process.stdout.write(`[${i + 1}/${picks.length}] ${pick.ticker.padEnd(15)} `);
    try {
      const { narrative, usage } = await narrateOnePick(client, pick, sectionKeys);
      const touched = applyNarrativeAcrossSections(picksData, pick.ticker, narrative);
      totals.input += usage.input_tokens || 0;
      totals.output += usage.output_tokens || 0;
      totals.cacheRead += usage.cache_read_input_tokens || 0;
      totals.cacheWrite += usage.cache_creation_input_tokens || 0;
      ok++;
      console.log(`✓ touched=${touched}  in=${usage.input_tokens} out=${usage.output_tokens} cacheR=${usage.cache_read_input_tokens || 0} cacheW=${usage.cache_creation_input_tokens || 0}`);
    } catch (e) {
      fail++;
      console.log(`✗ ${e.message}`);
    }
  }

  picksData.narrate_meta = {
    ran_at: new Date().toISOString(),
    model: MODELS.narrate,
    picks_attempted: picks.length,
    picks_succeeded: ok,
    picks_failed: fail,
    duration_seconds: Math.round((Date.now() - startedAt) / 1000),
    token_usage: totals,
  };

  writeJsonAtomic(PATHS.picksLatest, picksData);
  const cacheHitRate = totals.cacheRead / Math.max(1, totals.cacheRead + totals.cacheWrite + totals.input);
  console.log(`\nDone. ${ok} succeeded, ${fail} failed.`);
  console.log(`Tokens — uncached input: ${totals.input}, output: ${totals.output}, cache reads: ${totals.cacheRead}, cache writes: ${totals.cacheWrite}`);
  console.log(`Cache hit rate (input side): ${(cacheHitRate * 100).toFixed(1)}%`);
  console.log(`Wrote: ${PATHS.picksLatest}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
