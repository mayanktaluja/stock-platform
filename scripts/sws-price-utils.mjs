const RETURN_HORIZONS = [
  ["1D", 1],
  ["7D", 7],
  ["1M", 30],
  ["3M", 90],
  ["6M", 180],
  ["1Y", 365],
];

function finiteDateTs(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : 0;
}

function finiteClose(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function swsPriceSeries(apiOrSeries) {
  const data = Array.isArray(apiOrSeries)
    ? apiOrSeries
    : (Array.isArray(apiOrSeries?.rest?.price?.data) ? apiOrSeries.rest.price.data : []);
  return [...data]
    .filter((p) => p && p.date != null && finiteClose(p.close) != null)
    .sort((a, b) => finiteDateTs(a.date) - finiteDateTs(b.date));
}

export function extractSwsCurrentPrice(apiOrSeries) {
  const p = swsPriceSeries(apiOrSeries);
  if (!p.length) return null;
  return finiteClose(p[p.length - 1]?.close);
}

export function extractSwsPriceAsOf(apiOrSeries) {
  const p = swsPriceSeries(apiOrSeries);
  if (!p.length) return null;
  const d = p[p.length - 1]?.date;
  const t = finiteDateTs(d);
  return t ? new Date(t).toISOString() : null;
}

export function extractSwsReturnsPct(apiOrSeries) {
  const series = swsPriceSeries(apiOrSeries);
  if (series.length < 2) return null;
  const last = series[series.length - 1];
  const lastPrice = finiteClose(last?.close);
  const lastTs = finiteDateTs(last?.date);
  if (lastPrice == null || !lastTs) return null;

  const findBaselineDays = (days) => {
    const targetTs = lastTs - days * 86400 * 1000;
    let best = null;
    let earliestPrior = null;
    for (const p of series) {
      const t = finiteDateTs(p.date);
      if (!t || t >= lastTs) continue;
      if (!earliestPrior) earliestPrior = p;
      if (t <= targetTs) best = p;
    }
    return best || earliestPrior || null;
  };

  const ret = (days) => {
    const p = findBaselineDays(days);
    const close = finiteClose(p?.close);
    if (close == null) return null;
    return ((lastPrice - close) / close) * 100;
  };

  const out = {};
  for (const [key, days] of RETURN_HORIZONS) out[key] = ret(days);
  out["5Y"] = null;
  return out;
}

export function extractSwsFiftyTwoWeek(apiOrSeries) {
  const closes = swsPriceSeries(apiOrSeries)
    .map((p) => finiteClose(p?.close))
    .filter((v) => v != null);
  if (!closes.length) return null;
  return {
    low: Math.min(...closes),
    high: Math.max(...closes),
  };
}
