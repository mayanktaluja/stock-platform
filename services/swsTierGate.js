// Liquidity-tier gate for the SWS recommendation engine.
//
// The Step 4 universe expansion adds ~78 SWS-scrapeable stocks across BSE
// liquidity groups we previously excluded entirely (T trade-to-trade, X / XT
// permitted, Z surveillance, M/MS/MT SME). Ingesting them is correct — every
// stock a user can hold should be analysable. But the recommendation engine
// must NOT recommend BUY / TOP-UP on these tiers: SEBI flags them as
// high-risk for retail and execution slippage on illiquid groups can be
// 5-10% of the trade.
//
// This module gates only the BUY direction. EXIT / Reduction / HOLD are
// always allowed — protective actions remain valid regardless of tier.
//
// Tier source of truth: BSE's daily ListofScripData feed (cached at
// data/coverage/bse_equity_active.json). Loaded lazily on first use.
// When the file isn't present (e.g. fresh checkout, production where the
// coverage scripts haven't run yet) the gate is a no-op — preserving
// existing behaviour rather than blocking actions on unknown stocks.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const BSE_MASTER_PATH = path.join(REPO_ROOT, "data/coverage/bse_equity_active.json");

let _bseByCode = null; // lazy: numeric scrip code → row
let _bseLoadAttempted = false;

function loadBseIndex() {
  if (_bseLoadAttempted) return _bseByCode;
  _bseLoadAttempted = true;
  if (!fs.existsSync(BSE_MASTER_PATH)) return null;
  try {
    const arr = JSON.parse(fs.readFileSync(BSE_MASTER_PATH, "utf-8"));
    const map = new Map();
    for (const r of arr) {
      const code = String(r.SCRIP_CD || "").trim();
      if (code) map.set(code, r);
    }
    _bseByCode = map;
    return map;
  } catch {
    return null;
  }
}

// SEBI / BSE-aligned tier mapping. Keep this in sync with the same function
// in scripts/coverage-gap-analysis.mjs — both consume the same BSE GROUP
// values. Centralising would require pulling the scripts/ helper into the
// services/ tree (or the other way), which we'll do in a follow-up cleanup.
function tierFromBseGroup(group) {
  switch ((group || "").toUpperCase()) {
    case "A":
      return "highly_liquid";
    case "B":
      return "liquid";
    case "T":
    case "TS":
      return "trade_to_trade";
    case "X":
    case "XT":
      return "low_liquidity";
    case "Z":
    case "ZP":
      return "surveillance";
    case "M":
    case "MS":
    case "MT":
      return "sme";
    case "P":
    case "R":
    case "IP":
    case "Y":
      return "special";
    default:
      return "unknown";
  }
}

// Extract a BSE numeric code from any of the ticker forms our universe
// stores: bare numeric ("500285"), prefixed ("BSE_526783"), or the holding
// object's `bseCode` / `bse_code` field if present.
function extractBseCode(stockOrTicker) {
  if (!stockOrTicker) return null;
  if (typeof stockOrTicker === "string") {
    if (/^\d{6}$/.test(stockOrTicker)) return stockOrTicker;
    const m = stockOrTicker.match(/^BSE_(\d+)$/);
    if (m) return m[1];
    return null;
  }
  // Object: try fields in priority order
  return (
    stockOrTicker.bse_code ||
    stockOrTicker.bseCode ||
    extractBseCode(stockOrTicker.ticker || stockOrTicker.symbol || "")
  );
}

// Public: return the liquidity tier for a stock or ticker.
//
//   getLiquidityTier("RELIANCE")        → "unknown" (NSE-only ticker form,
//                                          we don't tier NSE stocks; the
//                                          NSE BE/BZ flag is upstream of this)
//   getLiquidityTier("500325")          → "highly_liquid" (BSE A-group)
//   getLiquidityTier("BSE_526783")      → "liquid"        (BSE B-group)
//   getLiquidityTier({ ticker, bse_group: "T" })
//                                       → "trade_to_trade" (universe entry)
//
// Returns "unknown" when no BSE side is identifiable.
export function getLiquidityTier(stockOrTicker) {
  if (!stockOrTicker) return "unknown";
  // If the universe entry / holding directly carries a bse_group, use it.
  if (typeof stockOrTicker === "object") {
    const direct = stockOrTicker.bse_group || stockOrTicker.bseGroup;
    if (direct) return tierFromBseGroup(direct);
  }
  const code = extractBseCode(stockOrTicker);
  if (!code) return "unknown";
  const idx = loadBseIndex();
  const row = idx?.get(code);
  if (!row) return "unknown";
  return tierFromBseGroup(row.GROUP);
}

// Tiers on which BUY-side recommendations are suppressed. Anything else
// (highly_liquid, liquid, unknown) is allowed through.
const NO_BUY_TIERS = new Set([
  "surveillance",
  "sme",
  "trade_to_trade",
  "low_liquidity",
  "special",
]);

// Action labels we want to gate. Catches both the v1 legacy labels emitted
// by scoreBandAction and the ladder-v2 / v4 promoted labels (Top-up-25%,
// Top-up-50%, Top-up-100%). The gate matches by prefix so future rung
// additions don't silently slip past.
function isBuyAction(action) {
  if (!action) return false;
  const a = String(action);
  return /^(STRONG\s+)?Top-up/i.test(a);
}

// Public: given an action and the stock's tier, return the gated action +
// (when downgraded) a human-readable reason for the reasons[] array.
//
//   gateActionByTier("Top-up-modest", "surveillance")
//     → { action: "HOLD", downgraded: true, tier: "surveillance",
//         reason: "Liquidity gate: BSE surveillance (Z-group) — no buy recommendation." }
//
//   gateActionByTier("HOLD", anything)         → unchanged
//   gateActionByTier("EXIT", anything)         → unchanged
//   gateActionByTier("Top-up-25%", "liquid")   → unchanged
//   gateActionByTier("Top-up-25%", "unknown")  → unchanged (don't penalise unknowns)
export function gateActionByTier(action, tier) {
  if (!isBuyAction(action) || !NO_BUY_TIERS.has(tier)) {
    return { action, downgraded: false, tier };
  }
  const label = TIER_LABELS[tier] || tier;
  return {
    action: "HOLD",
    originalAction: action,
    downgraded: true,
    tier,
    reason: `Liquidity gate: BSE ${label} — recommendation engine never emits buy actions on this tier (SEBI retail-risk caution + execution slippage).`,
  };
}

const TIER_LABELS = {
  surveillance: "surveillance (Z-group)",
  sme: "SME segment (M / MS / MT)",
  trade_to_trade: "trade-to-trade (T-group)",
  low_liquidity: "low-liquidity (X / XT)",
  special: "permitted / IPO / right-issue (P / R / IP)",
};

// For tests — clears the lazy cache so a fresh load can be exercised.
export function _resetCache() {
  _bseByCode = null;
  _bseLoadAttempted = false;
}
