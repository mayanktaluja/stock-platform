/**
 * Parse F&O bhavcopy CSV (UDiFF format) into row objects + per-underlying
 * aggregates. We keep only futures rows (STF=stock, IDF=index) and drop
 * options for the screener.
 *
 * UDiFF header (34 cols, NSE-stable since 2024):
 *   TradDt,BizDt,Sgmt,Src,FinInstrmTp,FinInstrmId,ISIN,TckrSymb,SctySrs,
 *   XpryDt,FininstrmActlXpryDt,StrkPric,OptnTp,FinInstrmNm,OpnPric,HghPric,
 *   LwPric,ClsPric,LastPric,PrvsClsgPric,UndrlygPric,SttlmPric,OpnIntrst,
 *   ChngInOpnIntrst,TtlTradgVol,TtlTrfVal,TtlNbOfTxsExctd,SsnId,
 *   NewBrdLotQty,Rmks,Rsvd1..4
 *
 * We index by header name (not column position) so an NSE column reorder
 * doesn't silently corrupt parsed values.
 */

const FUT_INSTRUMENT_TYPES = new Set(["STF", "IDF"]);

function num(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Split a CSV line. The bhavcopy is plain CSV — no embedded quotes or
 * escaped commas anywhere in the futures rows. A simple `split(",")` is
 * correct and ~10× faster than a quote-aware parser.
 */
function splitLine(line) {
  return line.split(",");
}

/**
 * Parse the full CSV. Returns:
 *   {
 *     tradeDate: "2026-05-05",
 *     fetchedAt: ISO string,
 *     rows: [ {underlying, instrument, expiry, open, high, low, close,
 *              prevClose, settle, oi, oiChange, volume, trades, lotSize}, ... ],
 *     aggregated: {
 *       RELIANCE: { underlying, oiTotal, oiChangeTotal, volumeTotal,
 *                   nearMonthSettle, nearMonthPrevClose, nearMonthExpiry,
 *                   instrumentType, expiryCount }
 *       ...
 *     }
 *   }
 */
export function parseBhavcopy(csv, fetchedAt = new Date().toISOString()) {
  const lines = csv.split(/\r?\n/);
  const header = splitLine(lines[0]);
  const idx = Object.fromEntries(header.map((h, i) => [h.trim(), i]));

  const required = [
    "TradDt",
    "FinInstrmTp",
    "TckrSymb",
    "XpryDt",
    "ClsPric",
    "PrvsClsgPric",
    "SttlmPric",
    "OpnIntrst",
    "ChngInOpnIntrst",
    "TtlTradgVol",
    "NewBrdLotQty",
  ];
  for (const col of required) {
    if (idx[col] == null) {
      throw new Error(`bhavcopy missing required column: ${col}`);
    }
  }

  let tradeDate = null;
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const c = splitLine(line);
    const instrument = c[idx.FinInstrmTp];
    if (!FUT_INSTRUMENT_TYPES.has(instrument)) continue;

    const underlying = c[idx.TckrSymb];
    if (!underlying) continue;

    if (!tradeDate) tradeDate = c[idx.TradDt];

    rows.push({
      underlying,
      instrument,
      expiry: c[idx.XpryDt],
      open: num(c[idx.OpnPric]),
      high: num(c[idx.HghPric]),
      low: num(c[idx.LwPric]),
      close: num(c[idx.ClsPric]),
      prevClose: num(c[idx.PrvsClsgPric]),
      settle: num(c[idx.SttlmPric]),
      underlyingPrice: num(c[idx.UndrlygPric]),
      oi: num(c[idx.OpnIntrst]),
      oiChange: num(c[idx.ChngInOpnIntrst]),
      volume: num(c[idx.TtlTradgVol]),
      trades: num(c[idx.TtlNbOfTxsExctd]),
      lotSize: num(c[idx.NewBrdLotQty]),
    });
  }

  if (!tradeDate) {
    throw new Error("bhavcopy CSV had zero futures rows");
  }

  return {
    tradeDate,
    fetchedAt,
    rows,
    aggregated: aggregateByUnderlying(rows),
  };
}

/**
 * Aggregate rows per underlying. OI/volume sum across all live expiries;
 * price uses the near-month contract (smallest non-past expiry date — for
 * a same-day bhavcopy, the front month is the near-month).
 */
function aggregateByUnderlying(rows) {
  const map = new Map();

  for (const r of rows) {
    let agg = map.get(r.underlying);
    if (!agg) {
      agg = {
        underlying: r.underlying,
        instrumentType: r.instrument,
        oiTotal: 0,
        oiChangeTotal: 0,
        volumeTotal: 0,
        expiryCount: 0,
        // near-month tracker
        _nearestExpiryMs: Infinity,
        nearMonthSettle: null,
        nearMonthPrevClose: null,
        nearMonthExpiry: null,
        nearMonthOi: null,
        nearMonthOiChange: null,
        nearMonthVolume: null,
        nearMonthLotSize: null,
        underlyingPrice: r.underlyingPrice,
      };
      map.set(r.underlying, agg);
    }

    if (r.oi != null) agg.oiTotal += r.oi;
    if (r.oiChange != null) agg.oiChangeTotal += r.oiChange;
    if (r.volume != null) agg.volumeTotal += r.volume;
    agg.expiryCount += 1;
    if (r.underlyingPrice != null) agg.underlyingPrice = r.underlyingPrice;

    const expMs = r.expiry ? Date.parse(r.expiry) : NaN;
    if (Number.isFinite(expMs) && expMs < agg._nearestExpiryMs) {
      agg._nearestExpiryMs = expMs;
      agg.nearMonthSettle = r.settle ?? r.close;
      agg.nearMonthPrevClose = r.prevClose;
      agg.nearMonthExpiry = r.expiry;
      agg.nearMonthOi = r.oi;
      agg.nearMonthOiChange = r.oiChange;
      agg.nearMonthVolume = r.volume;
      agg.nearMonthLotSize = r.lotSize;
    }
  }

  // strip the working field
  const out = {};
  for (const [k, v] of map.entries()) {
    delete v._nearestExpiryMs;
    out[k] = v;
  }
  return out;
}
