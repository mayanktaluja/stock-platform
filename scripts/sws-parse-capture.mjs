// Parse raw SWS page text (one tab per call) into structured JSON.
// All extractors return `null` (or `[]`) on missing field — never throw.
// The model just drives navigation; this file is deterministic regex logic.

// ---------- Generic numeric/currency extractors ----------

// "₹1,327.80" → 1327.80 ; "₹2.40k" → 2400 ; "₹17.97t" → 17_970_000_000_000
function parseInr(raw) {
  if (raw == null) return null;
  const s = String(raw).replace(/[₹,\s]/g, "").trim();
  if (!s) return null;
  const m = s.match(/^(-?[\d.]+)([kmbt])?$/i);
  if (!m) {
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const mult = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 }[(m[2] || "").toLowerCase()] || 1;
  return n * mult;
}

// "23.3% undervalued" → 23.3 ; "21% overvalued" → -21
function parsePctSigned(raw, kind) {
  if (raw == null) return null;
  const m = String(raw).match(/(-?[\d.]+)\s*%/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  if (kind === "overvalued") return -n;
  return n;
}

// "21.6x" or "2.1x" → 21.6
function parseMultiple(raw) {
  if (raw == null) return null;
  const m = String(raw).match(/(-?[\d.]+)\s*x/i);
  return m ? Number(m[1]) : null;
}

// ---------- Per-field extractors ----------

// Snowflake panel: "Valuation 4/6 Future Growth 2/6 Past Performance 3/6 ..."
// Returns { valuation, future_growth, past_performance, financial_health, dividends } each 0-6 or null.
export function extractSnowflake(text) {
  const out = {
    valuation: null,
    future_growth: null,
    past_performance: null,
    financial_health: null,
    dividends: null,
  };
  const dims = [
    ["valuation", /Valuation\s*(\d)\s*\/\s*6/i],
    ["future_growth", /Future\s*Growth\s*(\d)\s*\/\s*6/i],
    ["past_performance", /Past\s*Performance\s*(\d)\s*\/\s*6/i],
    ["financial_health", /Financial\s*Health\s*(\d)\s*\/\s*6/i],
    ["dividends", /Dividends?\s*(\d)\s*\/\s*6/i],
  ];
  for (const [key, re] of dims) {
    const m = text.match(re);
    if (m) out[key] = Number(m[1]);
  }
  return out;
}

// Snowflake summary phrase — appears after "Snowflake Analysis"
// e.g., "Solid track record with excellent balance sheet and pays a dividend."
export function extractSnowflakeSummary(text) {
  const m = text.match(/Snowflake Analysis\s*([^.]+\.)/i);
  return m ? m[1].trim() : null;
}

// Rewards — bullet list between "Rewards" and "Risk Analysis".
// SWS renders one reward per line in some captures, all-concatenated in others.
// Strategy: extract the rewards block, split into candidate lines (newline OR known sentence-starters),
// then keep lines that match any of the known SWS reward shapes.
export function extractRewards(text) {
  const m = text.match(/Rewards([\s\S]+?)(?:Risk Analysis|See All Risk)/i);
  if (!m) return [];
  let block = m[1];
  // Insert newlines before each known reward starter so single-line concatenated output also splits.
  block = block.replace(
    /(?<!^)(?<![\n])(Price-To-|Earnings (?:are forecast to grow|grew|have grown)|Pays a |Trading at|Analysts (?:in good agreement|are bullish))/g,
    "\n$1",
  );
  const rewardStarters = [
    /^Price-To-/i,
    /^Earnings (?:are forecast to grow|grew|have grown)/i,
    /^Pays a /i,
    /^Trading at/i,
    /^Analysts (?:in good agreement|are bullish)/i,
    /^Has a (?:high|good)/i, // sometimes rewards too
  ];
  const out = [];
  for (let line of block.split(/\n+/)) {
    line = line.trim().replace(/\s+/g, " ");
    if (!line) continue;
    if (rewardStarters.some((re) => re.test(line))) {
      // Trim trailing punctuation chains and over-long lines
      if (line.length > 200) line = line.slice(0, 200);
      out.push(line);
    }
  }
  return [...new Set(out)];
}

// Risks — between "Risk Analysis" and the next major header
export function extractRisks(text) {
  const m = text.match(/Risk Analysis([\s\S]+?)(?:See All Risk Checks|Community Fair Values|RELIANCE Community|HDFCBANK Community|My Notes|Competitors|$)/i);
  if (!m) return [];
  const block = m[1];
  if (/No risks detected/i.test(block)) return [];
  const risks = [];
  const patterns = [
    /Has a high level of debt/i,
    /Unstable dividend track record/i,
    /Dividend of [^.]+? not well covered[^.]+/i,
    /Debt is not well covered[^.]+/i,
    /Less than half of directors are independent/i,
    /High number of new (?:and inexperienced )?directors/i,
    /Insider selling/i,
    /Shareholder dilution/i,
    /Revenue and earnings growth/i,
    /Profit margins (?:have )?(?:declined|fallen)[^.]*/i,
    /Highly volatile share price[^.]*/i,
    /Significant insider selling[^.]*/i,
  ];
  for (const re of patterns) {
    const mm = block.match(re);
    if (mm) risks.push(mm[0].trim());
  }
  return risks;
}

// Risk count — fallback if pattern matching misses some
export function extractRiskCountFromHeader(text) {
  // Sometimes shown as a count in the snowflake panel, e.g. "3 Risks"
  const m = text.match(/(\d+)\s+Risks?/i);
  return m ? Number(m[1]) : null;
}

// Current share price
export function extractCurrentPrice(text) {
  const patterns = [
    /Current Share Price\s*₹([\d,.]+)/i,
    /Last Share Price\s*₹([\d,.]+)/i,
    /Last Price\s*₹([\d,.]+)/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return parseInr("₹" + m[1]);
  }
  return null;
}

// 52-week high/low
export function extractFiftyTwoWeek(text) {
  const out = { high: null, low: null };
  const hi = text.match(/52\s*Week High\s*₹([\d,.]+)/i);
  const lo = text.match(/52\s*Week Low\s*₹([\d,.]+)/i);
  if (hi) out.high = parseInr("₹" + hi[1]);
  if (lo) out.low = parseInr("₹" + lo[1]);
  return out;
}

export function extractBeta(text) {
  const m = text.match(/Beta\s*(-?[\d.]+)/i);
  return m ? Number(m[1]) : null;
}

// Returns (1M / 3M / 1Y / 3Y / 5Y)
export function extractReturns(text) {
  const out = { "1M": null, "3M": null, "1Y": null, "3Y": null, "5Y": null };
  const map = [
    ["1M", /1 Month Change\s*(-?[\d.]+)\s*%/i],
    ["3M", /3 Month Change\s*(-?[\d.]+)\s*%/i],
    ["1Y", /1 Year Change\s*(-?[\d.]+)\s*%/i],
    ["3Y", /3 Year Change\s*(-?[\d.]+)\s*%/i],
    ["5Y", /5 Year Change\s*(-?[\d.]+)\s*%/i],
  ];
  for (const [k, re] of map) {
    const m = text.match(re);
    if (m) out[k] = Number(m[1]);
  }
  return out;
}

// Fair value & analyst upside %.
// Look for phrasings like "23.3% undervalued AnalystConsensusTarget" or "21% overvalued".
export function extractFairValue(text) {
  // Try consensus first
  const consensus = text.match(/(\d+(?:\.\d+)?)\s*%\s*(undervalued|overvalued)\s*(?:intrinsic discount\s*)?(?:[\s\S]{0,80}?)AnalystConsensusTarget/i)
    || text.match(/AnalystConsensusTarget[\s\S]{0,80}?(\d+(?:\.\d+)?)\s*%\s*(undervalued|overvalued)/i)
    || text.match(/(\d+(?:\.\d+)?)\s*%\s*(undervalued|overvalued)/i);
  let upsidePct = null;
  if (consensus) {
    const n = Number(consensus[1]);
    upsidePct = consensus[2].toLowerCase() === "overvalued" ? -n : n;
  }
  // Try fair value figure (e.g., "₹1.73k FV" or "FV ₹2.61k" or "₹1.73k AnalystConsensusTarget")
  const fvMatch = text.match(/₹([\d.]+[kmbt]?)\s*(?:FV|Analyst(?:Consensus|High)Target)/i)
    || text.match(/AnalystConsensusTarget[\s\S]{0,40}?₹([\d.]+[kmbt]?)/i);
  const fairValue = fvMatch ? parseInr("₹" + fvMatch[1]) : null;
  return { fair_value_inr: fairValue, upside_pct: upsidePct };
}

// Market cap
export function extractMarketCap(text) {
  const m = text.match(/Market\s*cap\s*₹([\d.]+[kmbt]?)/i);
  return m ? parseInr("₹" + m[1]) : null;
}

// P/E, P/B, P/S
export function extractMultiples(text) {
  return {
    pe: parseMultiple((text.match(/(\d+(?:\.\d+)?)\s*x\s*P\/E Ratio/i) || [])[0])
        || (text.match(/P\/E Ratio\s*([\d.]+)\s*x/i) ? Number(text.match(/P\/E Ratio\s*([\d.]+)\s*x/i)[1]) : null),
    pb: (text.match(/([\d.]+)\s*x\s*P\/B Ratio/i) ? Number(text.match(/([\d.]+)\s*x\s*P\/B Ratio/i)[1]) : null),
    ps: (text.match(/([\d.]+)\s*x\s*P\/S Ratio/i) ? Number(text.match(/([\d.]+)\s*x\s*P\/S Ratio/i)[1]) : null),
  };
}

// EPS
export function extractEps(text) {
  const m = text.match(/Earnings per share \(EPS\)\s*([\d.]+)/i);
  return m ? Number(m[1]) : null;
}

// Margins + D/E
export function extractMarginsAndLeverage(text) {
  const grossM = text.match(/Gross Margin\s*([\d.]+)\s*%/i);
  const netM = text.match(/Net Profit Margin\s*([\d.]+)\s*%/i);
  const de = text.match(/Debt\/Equity Ratio\s*([\d.]+)\s*%/i);
  return {
    gross_margin_pct: grossM ? Number(grossM[1]) : null,
    net_margin_pct: netM ? Number(netM[1]) : null,
    debt_to_equity_pct: de ? Number(de[1]) : null,
  };
}

// Dividend yield + payout
export function extractDividend(text) {
  const yld = text.match(/(?:Current Dividend Yield\s*)?([\d.]+)\s*%\s*Current Dividend Yield/i)
    || text.match(/Dividend(?:s)?\s*([\d.]+)\s*%\s*Current Dividend Yield/i)
    || text.match(/Dividends?\s*([\d.]+)\s*%/i);
  const payout = text.match(/(\d+)\s*%\s*Payout Ratio/i)
    || text.match(/Payout Ratio\s*([\d.]+)\s*%/i);
  return {
    yield_pct: yld ? Number(yld[1]) : null,
    payout_pct: payout ? Number(payout[1]) : null,
  };
}

// "Reliance Industries Limited Fundamentals Summary" → company name parts; CEO; founded; employees
export function extractCompanyMeta(text) {
  const founded = text.match(/Founded\s*Employees\s*CEO\s*Website\s*(\d{4})\s*([\d,]+)\s*([^\n]+?)\s*www\./i);
  if (founded) {
    return {
      founded: Number(founded[1]),
      employees: Number(founded[2].replace(/,/g, "")),
      ceo: founded[3].trim(),
    };
  }
  return { founded: null, employees: null, ceo: null };
}

// Next earnings date — from overview "Next Earnings Date" field.
// Parses "Apr 30, 2026" → "2026-04-30" using UTC to avoid timezone shifts.
function parseSwsDate(s) {
  // Accepts "Apr 30, 2026" or "Apr 30 2026"
  const m = String(s).trim().match(/^([A-Z][a-z]{2})\s+(\d{1,2}),?\s*(\d{4})$/);
  if (!m) return null;
  const monIdx = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]
    .indexOf(m[1]);
  if (monIdx < 0) return null;
  const day = Number(m[2]);
  const yr = Number(m[3]);
  if (!day || !yr) return null;
  const yyyy = String(yr);
  const mm = String(monIdx + 1).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
export function extractNextEarningsDate(text) {
  // "Next Earnings Date Apr 30, 2026" or "Next Earnings Date n/a"
  const m = text.match(/Next Earnings Date\s*([A-Z][a-z]{2}\s+\d{1,2},?\s*\d{4})/i);
  if (m) {
    const iso = parseSwsDate(m[1]);
    if (iso) return iso;
  }
  // Fallback: look in news feed for "to Report Q[1-4], YYYY Results on [date]" — earliest future date
  const news = [...text.matchAll(/to Report (?:Q\d|Fiscal Year|First Half)[^]+?Results on ([A-Z][a-z]{2}\s+\d{1,2},?\s*\d{4})/gi)];
  let best = null;
  const today = new Date();
  for (const nm of news) {
    const iso = parseSwsDate(nm[1]);
    if (!iso) continue;
    const dt = new Date(iso + "T00:00:00Z");
    if (dt > today && (!best || dt < best)) best = dt;
  }
  return best ? best.toISOString().slice(0, 10) : null;
}

// Last quarter result — from news entries
export function extractLastQuarterResult(text) {
  const news = [...text.matchAll(/(?:full year|first quarter|second quarter|third quarter|fourth quarter|Q[1-4])\s+\d{4}\s+earnings[^.]*?(EPS exceeds|EPS misses|Revenues and EPS in line|Revenues exceed|Revenues miss|EPS and revenues exceed|EPS and revenues miss|EPS in line)[^.]*/gi)];
  if (news.length === 0) return null;
  // Most recent (first match in feed since it's chronological top-down)
  const phrase = news[0][1];
  if (/exceeds|exceed/i.test(phrase)) return "beat";
  if (/misses|miss/i.test(phrase)) return "miss";
  return "in_line";
}

// Recent analyst price target revisions in last ~30 days
export function extractAnalystRevisions(text) {
  const out = [];
  const matches = [...text.matchAll(/Price target (increased|decreased) by ([\d.]+)\s*%\s*to\s*₹([\d,]+)\s+([A-Z][a-z]{2}\s+\d{1,2})/g)];
  for (const m of matches.slice(0, 5)) {
    out.push({
      direction: m[1].toLowerCase(),
      pct: Number(m[2]),
      new_target_inr: Number(m[3].replace(/,/g, "")),
      date: m[4],
    });
  }
  return out;
}

// Insider activity — recent buys/sells from news + ownership tab.
// SWS phrasings vary widely:
//   "MD, CEO & Executive Director exercised options to buy ₹292m worth of stock. Apr 26"
//   "MD & Executive Director recently sold ₹1.8b worth of stock Feb 12"
//   "Insider recently sold ₹39m worth of stock Mar 23"
//   "Executive VP notifies of intention to sell stock Mar 14"
// We capture monetary buy/sell events with date.
export function extractInsiderActivity(text) {
  const out = [];
  // Greedy who-prefix; allow ", " inside it; allow "to" or no "to" before "buy/sell"
  const re = /([A-Z][A-Za-z,&\s]{0,60}?(?:Director|Insider|VP|CEO|CFO|Officer|Executive))\s+(exercised options to buy|recently sold|recently bought|bought|sold)\s*₹([\d.]+)\s*([bm])(?:\s+worth of stock)?\.?\s+([A-Z][a-z]{2}\s+\d{1,2})/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const mult = m[4].toLowerCase() === "b" ? 1e9 : 1e6;
    out.push({
      who: m[1].replace(/\s+/g, " ").trim(),
      direction: /buy|bought/i.test(m[2]) ? "buy" : "sell",
      value_inr: Number(m[3]) * mult,
      date: m[5],
    });
    if (out.length >= 10) break;
  }
  return out;
}

// ---------- Tab-specific parsers ----------

// Overview — the main company page. Most fields live here.
export function parseOverview(rawText) {
  const text = rawText || "";
  const snowflake = extractSnowflake(text);
  const snowflake_total = Object.values(snowflake).reduce(
    (a, v) => (v == null ? a : a + v), 0,
  );
  const fv = extractFairValue(text);
  return {
    snowflake,
    snowflake_total: snowflake_total || null,
    snowflake_summary: extractSnowflakeSummary(text),
    rewards: extractRewards(text),
    risks: extractRisks(text),
    risk_count: extractRisks(text).length || extractRiskCountFromHeader(text),
    current_price_inr: extractCurrentPrice(text),
    fifty_two_week: extractFiftyTwoWeek(text),
    beta: extractBeta(text),
    returns_pct: extractReturns(text),
    fair_value_inr: fv.fair_value_inr,
    upside_pct: fv.upside_pct,
    market_cap_inr: extractMarketCap(text),
    multiples: extractMultiples(text),
    eps: extractEps(text),
    ...extractMarginsAndLeverage(text),
    dividend: extractDividend(text),
    company: extractCompanyMeta(text),
    next_earnings_date: extractNextEarningsDate(text),
    last_quarter_result: extractLastQuarterResult(text),
    recent_analyst_revisions: extractAnalystRevisions(text),
    insider_activity: extractInsiderActivity(text),
  };
}

// Sub-tab parsers — currently capture rewards/risks per-tab + the snowflake number for that dim.
// Detail extraction (DCF inputs, ROE history, etc.) extends here as we see the actual page text from sub-tabs.
export function parseValuation(rawText) {
  const text = rawText || "";
  return {
    snowflake_score: extractSnowflake(text).valuation,
    rewards: extractRewards(text),
    risks: extractRisks(text),
    raw_length: text.length,
  };
}
export function parseFutureGrowth(rawText) {
  const text = rawText || "";
  const snow = extractSnowflake(text);
  return {
    snowflake_score: snow.future_growth,
    rewards: extractRewards(text),
    risks: extractRisks(text),
    raw_length: text.length,
  };
}
export function parsePastPerformance(rawText) {
  const text = rawText || "";
  const snow = extractSnowflake(text);
  // Past Performance often shows ROE etc.
  const roe = text.match(/Return on Equity\s*([\d.]+)\s*%/i);
  const roce = text.match(/Return on Capital Employed\s*([\d.]+)\s*%/i);
  return {
    snowflake_score: snow.past_performance,
    rewards: extractRewards(text),
    risks: extractRisks(text),
    roe_pct: roe ? Number(roe[1]) : null,
    roce_pct: roce ? Number(roce[1]) : null,
    raw_length: text.length,
  };
}
export function parseFinancialHealth(rawText) {
  const text = rawText || "";
  const snow = extractSnowflake(text);
  const debtCover = text.match(/Operating cash flow[^.]*?(\d+(?:\.\d+)?)\s*%/i);
  const intCover = text.match(/interest payments[^.]*?(\d+(?:\.\d+)?)\s*x/i);
  return {
    snowflake_score: snow.financial_health,
    rewards: extractRewards(text),
    risks: extractRisks(text),
    debt_cover_pct: debtCover ? Number(debtCover[1]) : null,
    interest_cover_x: intCover ? Number(intCover[1]) : null,
    raw_length: text.length,
  };
}
export function parseDividend(rawText) {
  const text = rawText || "";
  const snow = extractSnowflake(text);
  const stable = /stable[^.]*growing/i.test(text) || /reliable/i.test(text);
  const growing = /growing\s+over\s+the\s+past/i.test(text);
  return {
    snowflake_score: snow.dividends,
    rewards: extractRewards(text),
    risks: extractRisks(text),
    yield_pct: extractDividend(text).yield_pct,
    payout_pct: extractDividend(text).payout_pct,
    is_stable: stable,
    is_growing: growing,
    raw_length: text.length,
  };
}
export function parseManagement(rawText) {
  const text = rawText || "";
  const ceoTenure = text.match(/CEO[^.]*?tenure[^.]*?(\d+(?:\.\d+)?)\s*(?:year|yr)/i);
  const boardIndep = text.match(/independent[^.]*?(\d+(?:\.\d+)?)\s*%/i);
  return {
    rewards: extractRewards(text),
    risks: extractRisks(text),
    ceo_tenure_years: ceoTenure ? Number(ceoTenure[1]) : null,
    board_independence_pct: boardIndep ? Number(boardIndep[1]) : null,
    raw_length: text.length,
  };
}
export function parseOwnership(rawText) {
  const text = rawText || "";
  const inst = text.match(/Institutional[^.]*?(\d+(?:\.\d+)?)\s*%/i);
  const insider = text.match(/Insider[s]?[^.]*?(\d+(?:\.\d+)?)\s*%/i);
  return {
    rewards: extractRewards(text),
    risks: extractRisks(text),
    institutional_pct: inst ? Number(inst[1]) : null,
    insider_pct: insider ? Number(insider[1]) : null,
    insider_activity: extractInsiderActivity(text),
    raw_length: text.length,
  };
}

// ---------- Top-level: parse all 8 captures into one structured stock record ----------

// Look up a capture under either the SWS URL slug ("past-performance") or
// the legacy short alias ("past"). Returns "" if neither found.
function pick(captures, ...keys) {
  for (const k of keys) if (captures[k]) return captures[k];
  return "";
}

export function parseStock(captures, ticker) {
  const overview = parseOverview(captures.overview);
  return {
    ticker,
    parsed_at: new Date().toISOString(),
    overview,
    valuation: parseValuation(pick(captures, "valuation")),
    future_growth: parseFutureGrowth(pick(captures, "future-growth", "future")),
    past_performance: parsePastPerformance(pick(captures, "past-performance", "past")),
    financial_health: parseFinancialHealth(pick(captures, "financial-health", "health")),
    dividend: parseDividend(pick(captures, "dividend")),
    management: parseManagement(pick(captures, "management")),
    ownership: parseOwnership(pick(captures, "ownership")),
  };
}
