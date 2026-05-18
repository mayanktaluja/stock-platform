/**
 * Tests for services/swsCounterThesis.js
 *
 * Counter-thesis + falsification-trigger builder for the v2 conviction
 * engine. Pure templating module, no I/O — surfaces "the case against the
 * current call" and "the specific event that would reverse it" on each
 * pick card. SEBI-style analyst output should always articulate the
 * opposite case, so a regression here = degraded analyst quality on
 * every pick the user sees.
 *
 * Run with: node test/swsCounterThesis.test.mjs
 */

import { buildCounterThesis } from "../services/swsCounterThesis.js";

let pass = 0, fail = 0;
function assert(name, cond, got) {
  if (cond) { console.log(`✓ ${name}`); pass++; }
  else { console.log(`✗ ${name} — got: ${JSON.stringify(got)}`); fail++; }
}

// ──── Output shape contract ────
// Every call must return { text, falsification_trigger } both as non-empty
// strings — the UI renders these without null-guards.
{
  const out = buildCounterThesis({ action: "HOLD" });
  assert("returns object with text + falsification_trigger keys",
    typeof out === "object" && "text" in out && "falsification_trigger" in out, Object.keys(out));
  assert("text is a non-empty string", typeof out.text === "string" && out.text.length > 0, out.text);
  assert("falsification_trigger is a non-empty string",
    typeof out.falsification_trigger === "string" && out.falsification_trigger.length > 0,
    out.falsification_trigger);
}

// ──── Bullish action with no opposing signals → "well-grounded" fallback ────
// Top-up / STRONG Top-up classify as bullish; with empty signals there is
// nothing in _bearCase that triggers, so the fallback "no strong opposing
// signal" copy must be used.
{
  const out = buildCounterThesis({ action: "Top-up", sws_v3: 60, fiscal: {}, catalyst: {}, crosscheck: {} });
  assert("Top-up + no signals → fallback 'no strong opposing signal' text",
    /no strong opposing signal/i.test(out.text), out.text);
  assert("Top-up + no signals → 'well-grounded' phrasing",
    /well-grounded/.test(out.text), out.text);
}

// ──── Bullish action with bearish signals → bear-case bullets rendered ────
// Top-up means the call is bullish, so the counter-thesis pulls from
// _bearCase. A lower Layer-2 score + analyst PT cut + last-quarter miss +
// surveillance flag + earnings decline should all appear in the text.
{
  const out = buildCounterThesis({
    action: "STRONG Top-up",
    sws_v3: 70,
    crosscheck: {
      available: true,
      independent_score: 40,
      divergent_pillars: [{ pillar: "Past Performance", delta: -20 }],
    },
    catalyst: {
      recent_pt_actions: [{ direction: "decreased" }],
      last_quarter_result: "miss",
      momentum_1m: 30,
    },
    indianRisk: { surveillance: { list: "ASM Stage 2" } },
    fiscal: { earnings_growth_pct: -15 },
  });
  assert("bull action picks up Layer-2 lower-score bullet",
    /Layer-2 independent fundamentals score this 40\/100/.test(out.text), out.text);
  assert("bull action picks up analyst PT cut bullet",
    /recent analyst PT cut/.test(out.text), out.text);
  assert("bull action picks up last-quarter miss bullet",
    /last quarter missed estimates/.test(out.text), out.text);
  assert("bull action picks up surveillance bullet",
    /NSE ASM Stage 2 surveillance/.test(out.text), out.text);
  assert("bull action picks up earnings-decline bullet",
    /earnings declining -15\.0% YoY/.test(out.text), out.text);
  // Bullish action → falsification triggers should be the bull-flavoured set
  // (next quarter MISSES, layer agreement drops, momentum turns negative,
  // India-risk overlay materialises). Should NOT include "beats consensus".
  assert("bullish action → trigger 'next quarter misses estimates'",
    /next quarterly result misses/.test(out.falsification_trigger), out.falsification_trigger);
  assert("bullish action → trigger references India-risk overlay",
    /India-risk overlay/.test(out.falsification_trigger), out.falsification_trigger);
  assert("bullish action → trigger does NOT include 'beats consensus' wording",
    !/beats consensus/.test(out.falsification_trigger), out.falsification_trigger);
  assert("bullish action → momentum trigger surfaces when 1M > 25",
    /1M return turns negative.*\+30\.0%/.test(out.falsification_trigger), out.falsification_trigger);
}

// ──── Bearish action (EXIT) with bullish signals → bull-case bullets rendered ────
// EXIT means the call is bearish, so the counter-thesis pulls from
// _bullCase. Higher Layer-2 score + analyst PT raise + last-quarter beat +
// margin compression with intact revenue growth should all appear.
{
  const out = buildCounterThesis({
    action: "EXIT",
    sws_v3: 30,
    crosscheck: {
      available: true,
      independent_score: 55,
      divergent_pillars: [{ pillar: "Financial Health", delta: 25 }],
    },
    catalyst: {
      recent_pt_actions: [{ direction: "increased" }],
      last_quarter_result: "beat",
    },
    indianRisk: { surveillance: { list: "GSM Stage 4" } },
    fiscal: { revenue_growth_pct: 18, earnings_growth_pct: -5 },
  });
  assert("bear action picks up Layer-2 higher-score bullet",
    /Layer-2 independent fundamentals score this 55\/100 — higher/.test(out.text), out.text);
  assert("bear action picks up analyst PT raise bullet",
    /recent analyst PT raise/.test(out.text), out.text);
  assert("bear action picks up last-quarter beat bullet",
    /last-quarter beat/.test(out.text), out.text);
  assert("bear action picks up revenue-growth-intact bullet",
    /top-line growth is intact.*\+18\.0%/.test(out.text), out.text);
  // Bearish action → falsification triggers should be the bear-flavoured
  // set (next quarter BEATS, Layer-2 pillar improves, NSE removes
  // surveillance, new analyst PT raise ≥15%). Should NOT include "misses".
  assert("bearish action → trigger 'next quarterly result beats consensus'",
    /next quarterly result beats consensus by ≥10%/.test(out.falsification_trigger),
    out.falsification_trigger);
  assert("bearish action → trigger references Layer-2 weakest pillar (Financial Health)",
    /Layer-2 Financial Health pillar improves/.test(out.falsification_trigger),
    out.falsification_trigger);
  assert("bearish action → trigger 'NSE removes the GSM Stage 4 surveillance flag'",
    /NSE removes the GSM Stage 4 surveillance flag/.test(out.falsification_trigger),
    out.falsification_trigger);
  assert("bearish action → trigger 'new analyst PT is raised by ≥15%'",
    /new analyst PT is raised by ≥15%/.test(out.falsification_trigger),
    out.falsification_trigger);
  assert("bearish action → trigger does NOT include 'misses estimates'",
    !/misses estimates/.test(out.falsification_trigger), out.falsification_trigger);
}

// ──── Reduction action also treated as bearish ────
// Reduction-Small, Reduction-Large, etc. all start with "Reduction" — the
// _isBearishAction helper uses startsWith, so any variant should route into
// the _bullCase counter-thesis.
{
  const out = buildCounterThesis({
    action: "Reduction-Large",
    sws_v3: 40,
    crosscheck: { available: true, independent_score: 65 },
    catalyst: {},
    fiscal: {},
  });
  assert("Reduction-Large is treated as bearish → bull-case bullet appears",
    /higher than SWS v3/.test(out.text), out.text);
  assert("Reduction-Large → falsification trigger uses bear set",
    /next quarterly result beats consensus/.test(out.falsification_trigger),
    out.falsification_trigger);
}

// ──── Neutral action (HOLD) → empty opposite-case → fallback text + neutral triggers ────
// Anything that isn't bullish-prefixed or bearish-prefixed falls through:
// oppositeCase is [], so the fallback copy fires AND the triggers come
// from the else branch ("new material catalyst" + "layer agreement drops").
{
  const out = buildCounterThesis({ action: "HOLD" });
  assert("neutral action → fallback text",
    /no strong opposing signal/.test(out.text), out.text);
  assert("neutral action → trigger 'new material catalyst'",
    /new material catalyst lands in the next 30 days/.test(out.falsification_trigger),
    out.falsification_trigger);
  assert("neutral action → trigger 'layer agreement drops below 33%'",
    /layer agreement drops below 33%/.test(out.falsification_trigger),
    out.falsification_trigger);
}

// ──── Falsification trigger phrasing contract ────
// The UI relies on `Hold the **<action>**` and numbered "(1) … (2) …"
// structure for rendering — guard against accidental template drift.
{
  const out = buildCounterThesis({ action: "Top-up", sws_v3: 50, catalyst: {}, fiscal: {} });
  assert("falsification opens with 'Hold the **<action>** view unless'",
    /^Hold the \*\*Top-up\*\* view unless any of:/.test(out.falsification_trigger),
    out.falsification_trigger);
  assert("falsification numbers triggers (1) (2) …",
    /\(1\).*\(2\)/.test(out.falsification_trigger), out.falsification_trigger);
}

// ──── num() fallback: missing fiscal fields must not throw or render NaN ────
// _bullCase / _bearCase both call num(fiscal?.revenue_growth_pct, 0) etc.
// When fiscal is undefined or fields are missing, the helper must coerce
// to 0 and skip the conditional bullets cleanly.
{
  const out = buildCounterThesis({ action: "Top-up" }); // everything undefined
  assert("undefined inputs do not throw + return strings",
    typeof out.text === "string" && typeof out.falsification_trigger === "string", out);
  assert("undefined inputs → no NaN rendered",
    !/NaN/.test(out.text) && !/NaN/.test(out.falsification_trigger),
    [out.text, out.falsification_trigger]);
  assert("undefined inputs → no undefined rendered",
    !/undefined/.test(out.text) && !/undefined/.test(out.falsification_trigger),
    [out.text, out.falsification_trigger]);
}

// ──── crosscheck.available=false must NOT inject Layer-2 bullet ────
// Layer-2 bullets gate on crosscheck.available AND a non-null
// independent_score. When the crosscheck didn't run, we must NOT render
// the Layer-2 sentence even if independent_score happens to be present.
{
  const out = buildCounterThesis({
    action: "Top-up",
    sws_v3: 60,
    crosscheck: { available: false, independent_score: 40 },
    catalyst: {},
    fiscal: {},
  });
  assert("crosscheck.available=false → no Layer-2 bullet",
    !/Layer-2 independent fundamentals/.test(out.text), out.text);
}

// ──── Momentum trigger only fires when momentum_1m > 25 ────
// Bullish-action triggers include "1M return turns negative" ONLY when
// the run-up is already >25%. Guard against the trigger leaking when
// momentum is modest or absent.
{
  const out = buildCounterThesis({
    action: "Top-up",
    sws_v3: 50,
    catalyst: { momentum_1m: 10 },
    fiscal: {},
  });
  assert("bullish + momentum 10% → no '1M return turns negative' trigger",
    !/1M return turns negative/.test(out.falsification_trigger), out.falsification_trigger);
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
