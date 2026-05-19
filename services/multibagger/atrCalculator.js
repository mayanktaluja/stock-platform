// 90-day Average True Range — pure compute from OHLC bars.
// Powers tier-aware stops in services/multibagger/riskManager.js:
// Anchor/High tiers stop at max(-2.5 × ATR, -35%). Without ATR we fall
// back to the -35% absolute floor.
//
// Input shape: array of { date, open, high, low, close } sorted ascending.
// Returns ATR in price units (₹), not percentage.

const DEFAULT_PERIOD = 90;

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function trueRange(bar, prevClose) {
  if (!isFiniteNumber(bar?.high) || !isFiniteNumber(bar?.low)) return null;
  const hl = bar.high - bar.low;
  if (!isFiniteNumber(prevClose)) return hl;
  const hc = Math.abs(bar.high - prevClose);
  const lc = Math.abs(bar.low - prevClose);
  return Math.max(hl, hc, lc);
}

export function computeATR(bars, period = DEFAULT_PERIOD) {
  if (!Array.isArray(bars) || bars.length < 2) return null;
  if (!Number.isInteger(period) || period < 2) return null;

  const trs = [];
  for (let i = 1; i < bars.length; i++) {
    const tr = trueRange(bars[i], bars[i - 1]?.close);
    if (isFiniteNumber(tr)) trs.push(tr);
  }
  if (trs.length === 0) return null;

  const window = trs.slice(-period);
  const effectivePeriod = window.length;
  if (effectivePeriod === 0) return null;

  const sum = window.reduce((acc, x) => acc + x, 0);
  return Number((sum / effectivePeriod).toFixed(4));
}

// Convenience: ATR-based stop price for a long position.
// stop_price = entry_price - (atr_multiplier × ATR).
// Returns null if any input invalid.
export function atrStopPrice(entryPrice, atr, atrMultiplier = 2.5) {
  if (!isFiniteNumber(entryPrice) || entryPrice <= 0) return null;
  if (!isFiniteNumber(atr) || atr <= 0) return null;
  if (!isFiniteNumber(atrMultiplier) || atrMultiplier <= 0) return null;
  const stop = entryPrice - atrMultiplier * atr;
  return stop <= 0 ? null : Number(stop.toFixed(2));
}

// Tier-aware stop: max(ATR-band, absolute-floor) for Anchor/High tiers.
// Returns the WIDER (more permissive) of the two — preserves the J-curve
// of multibagger drawdowns. For Catalyst/Sector tiers, caller should use
// the absolute floor directly without ATR.
export function tierStopPrice({ entryPrice, atr, atrMultiplier = 2.5, absoluteFloorPct = 0.35 }) {
  if (!isFiniteNumber(entryPrice) || entryPrice <= 0) return null;
  if (!isFiniteNumber(absoluteFloorPct) || absoluteFloorPct <= 0 || absoluteFloorPct >= 1) return null;
  const absStop = Number((entryPrice * (1 - absoluteFloorPct)).toFixed(2));
  const atrStop = atrStopPrice(entryPrice, atr, atrMultiplier);
  if (!isFiniteNumber(atrStop)) return absStop;
  return Math.min(absStop, atrStop);
}
