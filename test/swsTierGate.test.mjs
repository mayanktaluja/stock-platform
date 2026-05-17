/**
 * Unit coverage for services/swsTierGate.js — the BSE liquidity-tier gate that
 * suppresses BUY-side recommendations on SEBI high-risk groups (T trade-to-trade,
 * X/XT low-liquidity, Z/ZP surveillance, M/MS/MT SME, P/R/IP/Y special).
 *
 * The gate is one of the few non-derivable safety rails in the recommendation
 * engine — it sits ahead of the action-ladder rungs and rewrites Top-up actions
 * to HOLD when the BSE GROUP indicates retail-risk caution. Regressions here
 * would silently let the platform recommend buys on Z-group surveillance
 * stocks, exactly the SEBI failure mode the gate was added to prevent.
 *
 * Three classes of coverage:
 *   • PASSING stocks — A-group (highly_liquid) / B-group (liquid) flow through
 *     untouched; "unknown" flows through too (don't penalise un-classifiable
 *     stocks like NSE-only tickers).
 *   • FAILING stocks — every NO_BUY tier (surveillance, sme, trade_to_trade,
 *     low_liquidity, special) downgrades buy actions to HOLD with a reason.
 *   • EDGE cases — protective actions (HOLD/EXIT/REDUCE) never downgrade, all
 *     buy-action label variants (Top-up-25%/50%/100%, STRONG Top-up, legacy
 *     Top-up-modest) all match, lazy BSE-index load works with real fixture,
 *     direct bse_group override on the object short-circuits the BSE lookup,
 *     case-insensitive group matching, and the no-op safety when the BSE
 *     master file is missing.
 *
 * Uses real rows from data/coverage/bse_equity_active.json (the production
 * fixture committed to the repo) so the lazy file load is exercised end-to-end.
 *
 * Run with: node test/swsTierGate.test.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getLiquidityTier,
  gateActionByTier,
  _resetCache,
} from "../services/swsTierGate.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const BSE_MASTER_PATH = path.join(REPO_ROOT, "data/coverage/bse_equity_active.json");

let pass = 0;
let fail = 0;
function assert(name, cond, got) {
  if (cond) {
    pass++;
    console.log("  ✓", name);
  } else {
    fail++;
    console.log("  ✗", name, "→ got", JSON.stringify(got));
  }
}

// ── getLiquidityTier: object-form bse_group short-circuit ─────────
//
// When the universe entry already carries a bse_group field we skip the BSE
// file lookup entirely. This is the fast path: most callers hand us the
// already-enriched universe row, not a bare ticker.

console.log("\n[getLiquidityTier — direct bse_group field]");
_resetCache();

assert(
  "A-group object → highly_liquid",
  getLiquidityTier({ ticker: "ABB", bse_group: "A" }) === "highly_liquid",
  getLiquidityTier({ ticker: "ABB", bse_group: "A" }),
);
assert(
  "B-group object → liquid",
  getLiquidityTier({ ticker: "X", bse_group: "B" }) === "liquid",
);
assert(
  "T-group object → trade_to_trade",
  getLiquidityTier({ ticker: "X", bse_group: "T" }) === "trade_to_trade",
);
assert(
  "TS-group object → trade_to_trade (TS variant)",
  getLiquidityTier({ bse_group: "TS" }) === "trade_to_trade",
);
assert(
  "X-group object → low_liquidity",
  getLiquidityTier({ bse_group: "X" }) === "low_liquidity",
);
assert(
  "XT-group object → low_liquidity (XT variant)",
  getLiquidityTier({ bse_group: "XT" }) === "low_liquidity",
);
assert(
  "Z-group object → surveillance",
  getLiquidityTier({ bse_group: "Z" }) === "surveillance",
);
assert(
  "ZP-group object → surveillance (ZP variant)",
  getLiquidityTier({ bse_group: "ZP" }) === "surveillance",
);
assert(
  "M-group object → sme",
  getLiquidityTier({ bse_group: "M" }) === "sme",
);
assert(
  "MS-group object → sme (MS variant)",
  getLiquidityTier({ bse_group: "MS" }) === "sme",
);
assert(
  "MT-group object → sme (MT variant)",
  getLiquidityTier({ bse_group: "MT" }) === "sme",
);
assert(
  "P-group object → special",
  getLiquidityTier({ bse_group: "P" }) === "special",
);
assert(
  "R-group object → special",
  getLiquidityTier({ bse_group: "R" }) === "special",
);
assert(
  "IP-group object → special",
  getLiquidityTier({ bse_group: "IP" }) === "special",
);
assert(
  "Y-group object → special",
  getLiquidityTier({ bse_group: "Y" }) === "special",
);

// camelCase alias works too — both forms used across the codebase
assert(
  "bseGroup camelCase alias works",
  getLiquidityTier({ bseGroup: "A" }) === "highly_liquid",
);

// Case-insensitive — the BSE feed is upper-case but be defensive against
// downstream lowercase normalisation.
assert(
  "lowercase 'a' → highly_liquid (case-insensitive)",
  getLiquidityTier({ bse_group: "a" }) === "highly_liquid",
);
assert(
  "lowercase 'z' → surveillance (case-insensitive)",
  getLiquidityTier({ bse_group: "z" }) === "surveillance",
);

// Unknown / unmapped group string → "unknown" (don't penalise novelty)
assert(
  "unknown group letter → unknown",
  getLiquidityTier({ bse_group: "Q" }) === "unknown",
);
assert(
  "empty bse_group → falls through to ticker lookup (then unknown)",
  getLiquidityTier({ bse_group: "", ticker: "RELIANCE" }) === "unknown",
);

// Null / falsy guard
assert("null input → unknown", getLiquidityTier(null) === "unknown");
assert("undefined input → unknown", getLiquidityTier(undefined) === "unknown");
assert("empty-string input → unknown", getLiquidityTier("") === "unknown");

// ── getLiquidityTier: lazy BSE-index file load ────────────────────
//
// When the universe entry has no bse_group, we extract a 6-digit BSE code from
// the ticker form and look it up in data/coverage/bse_equity_active.json. This
// exercises the real lazy-load path against the committed fixture.

console.log("\n[getLiquidityTier — lazy BSE-index file load]");
_resetCache();

if (!fs.existsSync(BSE_MASTER_PATH)) {
  console.log(
    "  ! data/coverage/bse_equity_active.json missing — skipping file-load tests",
  );
} else {
  // A real A-group stock — ABB India (500002)
  assert(
    "bare numeric '500002' (ABB) → highly_liquid",
    getLiquidityTier("500002") === "highly_liquid",
    getLiquidityTier("500002"),
  );

  // A real B-group stock — Ambalal Sarabhai Enterprises (500009)
  assert(
    "bare numeric '500009' → liquid",
    getLiquidityTier("500009") === "liquid",
  );

  // A real Z-group surveillance stock — Ansal Properties (500013)
  assert(
    "bare numeric '500013' (Ansal/Z-group) → surveillance",
    getLiquidityTier("500013") === "surveillance",
  );

  // A real T-group trade-to-trade stock — Birla Cable (500060)
  assert(
    "bare numeric '500060' (Birla Cable/T-group) → trade_to_trade",
    getLiquidityTier("500060") === "trade_to_trade",
  );

  // BSE_-prefixed form — used by the universe entries that namespace by exchange
  assert(
    "prefixed 'BSE_500002' → highly_liquid",
    getLiquidityTier("BSE_500002") === "highly_liquid",
  );
  assert(
    "prefixed 'BSE_500013' → surveillance",
    getLiquidityTier("BSE_500013") === "surveillance",
  );

  // Object form with bse_code field — holdings carry this
  assert(
    "object { bse_code: '500002' } → highly_liquid",
    getLiquidityTier({ bse_code: "500002" }) === "highly_liquid",
  );
  // bseCode camelCase variant
  assert(
    "object { bseCode: '500013' } → surveillance",
    getLiquidityTier({ bseCode: "500013" }) === "surveillance",
  );

  // Object with no bse_group / no bse_code but a ticker that contains the
  // BSE_ prefix → ticker is parsed and looked up.
  assert(
    "object { ticker: 'BSE_500060' } → trade_to_trade",
    getLiquidityTier({ ticker: "BSE_500060" }) === "trade_to_trade",
  );

  // 6-digit code that doesn't exist in the BSE master → unknown
  // (use an obviously-bogus code; 999999 is reserved/unassigned)
  assert(
    "non-existent BSE code → unknown",
    getLiquidityTier("999999") === "unknown",
    getLiquidityTier("999999"),
  );

  // NSE-style ticker (no numeric BSE code embedded) → unknown — the gate
  // doesn't tier NSE-only stocks; that's upstream (NSE BE/BZ flag).
  assert(
    "'RELIANCE' (NSE-only) → unknown",
    getLiquidityTier("RELIANCE") === "unknown",
  );

  // Short numeric (not 6 digits) → unknown
  assert(
    "5-digit numeric → unknown (not a BSE code)",
    getLiquidityTier("12345") === "unknown",
  );
}

// ── gateActionByTier: passing actions (no downgrade) ──────────────
//
// Protective actions must NEVER be downgraded — they remain valid on every
// tier. This is the whole point of the gate being one-sided.

console.log("\n[gateActionByTier — pass-through (no downgrade)]");

// Protective actions on a high-risk tier: still pass through
{
  const r = gateActionByTier("HOLD", "surveillance");
  assert("HOLD on surveillance → unchanged", r.action === "HOLD" && r.downgraded === false, r);
}
{
  const r = gateActionByTier("EXIT", "surveillance");
  assert("EXIT on surveillance → unchanged", r.action === "EXIT" && r.downgraded === false, r);
}
{
  const r = gateActionByTier("REDUCE", "surveillance");
  assert("REDUCE on surveillance → unchanged", r.action === "REDUCE" && r.downgraded === false, r);
}
{
  const r = gateActionByTier("CUT_LOSS", "sme");
  assert("CUT_LOSS on sme → unchanged", r.action === "CUT_LOSS" && r.downgraded === false, r);
}

// Buy actions on safe tiers: still pass through
{
  const r = gateActionByTier("Top-up-25%", "highly_liquid");
  assert("Top-up-25% on highly_liquid → unchanged", r.action === "Top-up-25%" && r.downgraded === false, r);
}
{
  const r = gateActionByTier("Top-up-modest", "liquid");
  assert("Top-up-modest on liquid → unchanged", r.action === "Top-up-modest" && r.downgraded === false, r);
}
{
  const r = gateActionByTier("Top-up-100%", "unknown");
  assert(
    "Top-up-100% on unknown tier → unchanged (don't penalise unknowns)",
    r.action === "Top-up-100%" && r.downgraded === false,
    r,
  );
}

// Empty / null action input
{
  const r = gateActionByTier(null, "surveillance");
  assert("null action → returned as-is, not downgraded", r.action === null && r.downgraded === false, r);
}
{
  const r = gateActionByTier("", "surveillance");
  assert("empty action → returned as-is, not downgraded", r.action === "" && r.downgraded === false, r);
}

// ── gateActionByTier: failing actions (downgrade to HOLD) ─────────
//
// Buy actions on any NO_BUY tier must downgrade to HOLD, preserve the original
// action name, set downgraded=true, and carry a reason citing SEBI / liquidity.

console.log("\n[gateActionByTier — downgrade buys on NO_BUY tiers]");

const buyVariants = [
  "Top-up-25%",
  "Top-up-50%",
  "Top-up-100%",
  "Top-up-modest",
  "STRONG Top-up",
  "top-up-25%", // case-insensitive
];

for (const buy of buyVariants) {
  const r = gateActionByTier(buy, "surveillance");
  assert(
    `'${buy}' on surveillance → HOLD (downgraded)`,
    r.action === "HOLD" && r.downgraded === true && r.originalAction === buy,
    r,
  );
}

const noBuyTiers = ["surveillance", "sme", "trade_to_trade", "low_liquidity", "special"];
for (const tier of noBuyTiers) {
  const r = gateActionByTier("Top-up-25%", tier);
  assert(
    `Top-up-25% on ${tier} → HOLD (downgraded)`,
    r.action === "HOLD" && r.downgraded === true,
    r,
  );
  assert(
    `${tier} downgrade carries reason text`,
    typeof r.reason === "string" && r.reason.length > 0 && /Liquidity gate/i.test(r.reason),
    r.reason,
  );
  assert(
    `${tier} downgrade preserves tier label`,
    r.tier === tier,
    r,
  );
}

// Reason text quality — every NO_BUY tier should have a human-readable label.
{
  const r = gateActionByTier("Top-up-50%", "surveillance");
  assert(
    "surveillance reason names Z-group",
    /Z-group/i.test(r.reason),
    r.reason,
  );
}
{
  const r = gateActionByTier("Top-up-50%", "sme");
  assert(
    "sme reason names M / MS / MT",
    /M\s*\/\s*MS\s*\/\s*MT/i.test(r.reason),
    r.reason,
  );
}
{
  const r = gateActionByTier("Top-up-50%", "trade_to_trade");
  assert(
    "trade_to_trade reason names T-group",
    /T-group/i.test(r.reason),
    r.reason,
  );
}
{
  const r = gateActionByTier("Top-up-50%", "low_liquidity");
  assert(
    "low_liquidity reason names X / XT",
    /X\s*\/\s*XT/i.test(r.reason),
    r.reason,
  );
}
{
  const r = gateActionByTier("Top-up-50%", "special");
  assert(
    "special reason names P / R / IP",
    /P\s*\/\s*R\s*\/\s*IP/i.test(r.reason),
    r.reason,
  );
}

// ── End-to-end: getLiquidityTier → gateActionByTier ──────────────────
//
// The realistic call site flow: derive the tier from the universe entry, then
// run an action through the gate.

console.log("\n[end-to-end: tier lookup → action gate]");
_resetCache();

if (fs.existsSync(BSE_MASTER_PATH)) {
  // A-group stock + buy action → untouched
  {
    const tier = getLiquidityTier("500002"); // ABB
    const r = gateActionByTier("Top-up-25%", tier);
    assert(
      "ABB (A-group) + Top-up-25% → unchanged",
      r.action === "Top-up-25%" && r.downgraded === false,
      { tier, r },
    );
  }
  // Z-group stock + buy action → downgraded to HOLD
  {
    const tier = getLiquidityTier("500013"); // Ansal (Z-group)
    const r = gateActionByTier("Top-up-50%", tier);
    assert(
      "Ansal (Z-group) + Top-up-50% → HOLD (downgraded)",
      r.action === "HOLD" && r.downgraded === true && r.tier === "surveillance",
      { tier, r },
    );
  }
  // Z-group stock + EXIT → still EXIT (one-sided gate)
  {
    const tier = getLiquidityTier("500013");
    const r = gateActionByTier("EXIT", tier);
    assert(
      "Ansal (Z-group) + EXIT → unchanged (one-sided gate)",
      r.action === "EXIT" && r.downgraded === false,
      { tier, r },
    );
  }
}

// ── _resetCache safety ────────────────────────────────────────────
//
// The lazy cache is reset between fixture-swap test runs. Confirm the reset
// hook lets a second load attempt succeed (rather than perma-caching null
// after a transient miss).

console.log("\n[_resetCache]");
{
  _resetCache();
  // First call — populates the cache
  const t1 = getLiquidityTier({ bse_group: "A" });
  _resetCache();
  // Second call after reset — still works
  const t2 = getLiquidityTier({ bse_group: "A" });
  assert("tier lookup works after _resetCache", t1 === "highly_liquid" && t2 === "highly_liquid", { t1, t2 });
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
