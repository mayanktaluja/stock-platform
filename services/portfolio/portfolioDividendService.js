function normalizeSymbol(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().toUpperCase();
  if (!s) return null;
  return s.replace(/\.(NS|BO|BSE)$/i, "");
}

function dateMinusOne(iso) {
  if (!iso || typeof iso !== "string") return null;
  const ms = Date.parse(iso + "T00:00:00Z");
  if (!Number.isFinite(ms)) return null;
  const prev = new Date(ms - 86_400_000);
  return prev.toISOString().slice(0, 10);
}

function daysUntil(iso, todayIso) {
  if (!iso || !todayIso) return null;
  const a = Date.parse(todayIso + "T00:00:00Z");
  const b = Date.parse(iso + "T00:00:00Z");
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.ceil((b - a) / 86_400_000);
}

function todayIstIso() {
  const ist = new Date(Date.now() + 5.5 * 3600 * 1000);
  return ist.toISOString().slice(0, 10);
}

function indexByNormalizedSymbol(dividends) {
  const map = new Map();
  for (const d of dividends || []) {
    const sym = normalizeSymbol(d?.symbol);
    if (!sym || !d?.ex_date) continue;
    const list = map.get(sym) || [];
    list.push(d);
    map.set(sym, list);
  }
  for (const [, list] of map) {
    list.sort((a, b) => (a.ex_date < b.ex_date ? -1 : a.ex_date > b.ex_date ? 1 : 0));
  }
  return map;
}

export function buildNextDividend(holding, dividendsForSymbol, { todayIso } = {}) {
  if (!holding || !Array.isArray(dividendsForSymbol) || dividendsForSymbol.length === 0) return null;
  const today = todayIso || todayIstIso();
  const future = dividendsForSymbol.filter((d) => d.ex_date >= today);
  if (future.length === 0) return null;

  const next = future[0];
  const otherCount = future.length - 1;
  const qty = Number(holding.quantity);
  const dps = Number(next.dps);

  const totalPayoutInr = Number.isFinite(qty) && Number.isFinite(dps) && qty > 0 && dps > 0
    ? Number((qty * dps).toFixed(2))
    : null;

  const avgPrice = Number(holding.avgPrice);
  const yieldOnCostPct = Number.isFinite(avgPrice) && avgPrice > 0 && Number.isFinite(dps)
    ? Number(((dps / avgPrice) * 100).toFixed(2))
    : null;

  const holdByDate = dateMinusOne(next.ex_date);

  return {
    ex_date: next.ex_date,
    record_date: next.record_date,
    pay_date: next.pay_date,
    hold_by_date: holdByDate,
    dps,
    dividend_type: next.dividend_type,
    days_until_ex: daysUntil(next.ex_date, today),
    days_until_hold_by: daysUntil(holdByDate, today),
    total_payout_inr: totalPayoutInr,
    yield_on_cost_pct: yieldOnCostPct,
    other_dividends_count: otherCount,
    source: next.source || "sws-news",
  };
}

export function attachDividendsToHoldings(holdings, dividends, { todayIso } = {}) {
  if (!Array.isArray(holdings) || holdings.length === 0) return holdings || [];
  const index = indexByNormalizedSymbol(dividends);
  const today = todayIso || todayIstIso();
  const unmatchedWithUpcoming = [];

  for (const h of holdings) {
    const sym = normalizeSymbol(h?.symbol || h?.sws?.ticker);
    if (!sym) continue;
    const forSymbol = index.get(sym);
    if (!forSymbol || forSymbol.length === 0) {
      unmatchedWithUpcoming.push(sym);
      continue;
    }
    const next = buildNextDividend(h, forSymbol, { todayIso: today });
    if (next) {
      h.sws = h.sws || {};
      h.sws.next_dividend = next;
    }
  }

  return holdings;
}

export const __testing__ = { normalizeSymbol, dateMinusOne, daysUntil, indexByNormalizedSymbol };
