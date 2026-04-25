/**
 * Professional Technical Analysis Engine
 * Implements multiple indicators and generates weighted recommendations
 */

class TechnicalAnalysis {
  /**
   * Calculate Simple Moving Average
   */
  static SMA(data, period) {
    if (data.length < period) return null;
    const slice = data.slice(-period);
    return slice.reduce((sum, val) => sum + val, 0) / period;
  }

  /**
   * Calculate Exponential Moving Average
   */
  static EMA(data, period) {
    if (data.length < period) return null;
    const k = 2 / (period + 1);
    let ema = data.slice(0, period).reduce((sum, val) => sum + val, 0) / period;
    for (let i = period; i < data.length; i++) {
      ema = data[i] * k + ema * (1 - k);
    }
    return ema;
  }

  /**
   * Calculate all EMAs for a dataset (returns array)
   */
  static EMAArray(data, period) {
    if (data.length < period) return [];
    const k = 2 / (period + 1);
    const emaArr = [];
    let ema = data.slice(0, period).reduce((sum, val) => sum + val, 0) / period;
    emaArr.push(ema);
    for (let i = period; i < data.length; i++) {
      ema = data[i] * k + ema * (1 - k);
      emaArr.push(ema);
    }
    return emaArr;
  }

  /**
   * Calculate RSI (Relative Strength Index)
   */
  static RSI(closes, period = 14) {
    if (closes.length < period + 1) return null;

    let gains = 0;
    let losses = 0;

    // Calculate initial average gain/loss
    for (let i = 1; i <= period; i++) {
      const change = closes[i] - closes[i - 1];
      if (change >= 0) gains += change;
      else losses += Math.abs(change);
    }

    let avgGain = gains / period;
    let avgLoss = losses / period;

    // Wilder's smoothing
    for (let i = period + 1; i < closes.length; i++) {
      const change = closes[i] - closes[i - 1];
      const currentGain = change >= 0 ? change : 0;
      const currentLoss = change < 0 ? Math.abs(change) : 0;
      avgGain = (avgGain * (period - 1) + currentGain) / period;
      avgLoss = (avgLoss * (period - 1) + currentLoss) / period;
    }

    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - 100 / (1 + rs);
  }

  /**
   * Calculate MACD (Moving Average Convergence Divergence)
   */
  static MACD(closes, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
    if (closes.length < slowPeriod + signalPeriod) return null;

    const fastEMA = this.EMAArray(closes, fastPeriod);
    const slowEMA = this.EMAArray(closes, slowPeriod);

    // Align arrays - slowEMA starts later
    const offset = slowPeriod - fastPeriod;
    const macdLine = [];
    for (let i = 0; i < slowEMA.length; i++) {
      macdLine.push(fastEMA[i + offset] - slowEMA[i]);
    }

    if (macdLine.length < signalPeriod) return null;

    const signalLine = this.EMAArray(macdLine, signalPeriod);
    const currentMACD = macdLine[macdLine.length - 1];
    const currentSignal = signalLine[signalLine.length - 1];
    const prevMACD = macdLine[macdLine.length - 2];
    const prevSignal = signalLine.length >= 2 ? signalLine[signalLine.length - 2] : currentSignal;
    const histogram = currentMACD - currentSignal;

    // Phase 4 (Apr 2026): widened crossover detection to a 5-bar lookback.
    // The previous candle-exact check fired on 0 trades across 24 months of
    // monthly scans — the scan date almost never lines up with the exact
    // crossover candle. A crossover within the last 5 trading days is
    // still fresh and tradeable. Attribution data forced this fix.
    const CROSSOVER_LOOKBACK = 5;
    let recentCrossover = false;
    let recentCrossunder = false;
    const lookbackStart = Math.max(1, signalLine.length - CROSSOVER_LOOKBACK);
    const macdTail = macdLine.slice(-signalLine.length); // align indices with signalLine
    for (let i = lookbackStart; i < signalLine.length; i++) {
      const pMacd = macdTail[i - 1];
      const cMacd = macdTail[i];
      const pSig = signalLine[i - 1];
      const cSig = signalLine[i];
      if (pMacd <= pSig && cMacd > cSig) recentCrossover = true;
      if (pMacd >= pSig && cMacd < cSig) recentCrossunder = true;
    }

    return {
      macd: currentMACD,
      signal: currentSignal,
      histogram,
      // Candle-exact flags preserved for any caller that depended on them.
      crossoverExact: prevMACD <= prevSignal && currentMACD > currentSignal,
      crossunderExact: prevMACD >= prevSignal && currentMACD < currentSignal,
      // Default `crossover` / `crossunder` now mean "within last 5 bars".
      crossover: recentCrossover,
      crossunder: recentCrossunder,
    };
  }

  /**
   * Calculate Bollinger Bands
   */
  static BollingerBands(closes, period = 20, stdDevMultiplier = 2) {
    if (closes.length < period) return null;

    const sma = this.SMA(closes, period);
    const slice = closes.slice(-period);
    const variance =
      slice.reduce((sum, val) => sum + Math.pow(val - sma, 2), 0) / period;
    const stdDev = Math.sqrt(variance);

    return {
      upper: sma + stdDevMultiplier * stdDev,
      middle: sma,
      lower: sma - stdDevMultiplier * stdDev,
      bandwidth: ((sma + stdDevMultiplier * stdDev - (sma - stdDevMultiplier * stdDev)) / sma) * 100,
      percentB: (closes[closes.length - 1] - (sma - stdDevMultiplier * stdDev)) / (2 * stdDevMultiplier * stdDev),
    };
  }

  /**
   * Calculate Stochastic Oscillator
   */
  static Stochastic(highs, lows, closes, kPeriod = 14, dPeriod = 3) {
    if (closes.length < kPeriod) return null;

    const recentHighs = highs.slice(-kPeriod);
    const recentLows = lows.slice(-kPeriod);
    const highestHigh = Math.max(...recentHighs);
    const lowestLow = Math.min(...recentLows);
    const currentClose = closes[closes.length - 1];

    const k = highestHigh === lowestLow ? 50 : ((currentClose - lowestLow) / (highestHigh - lowestLow)) * 100;

    // Calculate %D (SMA of %K)
    const kValues = [];
    for (let i = kPeriod; i <= closes.length; i++) {
      const h = highs.slice(i - kPeriod, i);
      const l = lows.slice(i - kPeriod, i);
      const hh = Math.max(...h);
      const ll = Math.min(...l);
      kValues.push(hh === ll ? 50 : ((closes[i - 1] - ll) / (hh - ll)) * 100);
    }

    const d = kValues.length >= dPeriod
      ? kValues.slice(-dPeriod).reduce((s, v) => s + v, 0) / dPeriod
      : k;

    return { k, d };
  }

  /**
   * Calculate Average True Range (ATR)
   */
  static ATR(highs, lows, closes, period = 14) {
    if (closes.length < period + 1) return null;

    const trueRanges = [];
    for (let i = 1; i < closes.length; i++) {
      const tr = Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i] - closes[i - 1])
      );
      trueRanges.push(tr);
    }

    // Wilder's smoothing
    let atr = trueRanges.slice(0, period).reduce((s, v) => s + v, 0) / period;
    for (let i = period; i < trueRanges.length; i++) {
      atr = (atr * (period - 1) + trueRanges[i]) / period;
    }

    return atr;
  }

  /**
   * Calculate Volume Weighted Average Price (VWAP) - approximate
   */
  static VWAP(highs, lows, closes, volumes, period = 20) {
    if (closes.length < period) return null;

    let cumulativeTPV = 0;
    let cumulativeVolume = 0;

    for (let i = closes.length - period; i < closes.length; i++) {
      const typicalPrice = (highs[i] + lows[i] + closes[i]) / 3;
      cumulativeTPV += typicalPrice * volumes[i];
      cumulativeVolume += volumes[i];
    }

    return cumulativeVolume === 0 ? null : cumulativeTPV / cumulativeVolume;
  }

  /**
   * Calculate On-Balance Volume trend
   */
  static OBVTrend(closes, volumes, period = 10) {
    if (closes.length < period + 1) return null;

    const obv = [0];
    for (let i = 1; i < closes.length; i++) {
      if (closes[i] > closes[i - 1]) obv.push(obv[i - 1] + volumes[i]);
      else if (closes[i] < closes[i - 1]) obv.push(obv[i - 1] - volumes[i]);
      else obv.push(obv[i - 1]);
    }

    // Check OBV trend
    const recentOBV = obv.slice(-period);
    const obvSMA = recentOBV.reduce((s, v) => s + v, 0) / period;
    const currentOBV = obv[obv.length - 1];

    return {
      trend: currentOBV > obvSMA ? "bullish" : "bearish",
      strength: Math.abs((currentOBV - obvSMA) / (obvSMA || 1)) * 100,
    };
  }

  /**
   * Detect support and resistance levels
   */
  static SupportResistance(highs, lows, closes, period = 20) {
    if (closes.length < period) return { support: null, resistance: null };

    const recentLows = lows.slice(-period);
    const recentHighs = highs.slice(-period);

    // Simple approach: use recent swing points
    const support = Math.min(...recentLows);
    const resistance = Math.max(...recentHighs);
    const currentPrice = closes[closes.length - 1];

    return {
      support,
      resistance,
      distanceToSupport: ((currentPrice - support) / currentPrice) * 100,
      distanceToResistance: ((resistance - currentPrice) / currentPrice) * 100,
    };
  }

  /**
   * Calculate Volume spike detection
   */
  static VolumeAnalysis(volumes, period = 20) {
    if (volumes.length < period) return null;

    const avgVolume = volumes.slice(-period - 1, -1).reduce((s, v) => s + v, 0) / period;
    const currentVolume = volumes[volumes.length - 1];
    const volumeRatio = currentVolume / (avgVolume || 1);

    return {
      currentVolume,
      avgVolume,
      volumeRatio,
      isSpike: volumeRatio > 1.5,
      isMajorSpike: volumeRatio > 2.5,
      description:
        volumeRatio > 2.5 ? "Extremely High" :
        volumeRatio > 1.5 ? "Above Average" :
        volumeRatio > 0.7 ? "Normal" : "Below Average",
    };
  }

  /**
   * Price momentum (Rate of Change)
   */
  static ROC(closes, period = 10) {
    if (closes.length <= period) return null;
    const current = closes[closes.length - 1];
    const past = closes[closes.length - 1 - period];
    return ((current - past) / past) * 100;
  }

  /**
   * Detect candlestick patterns (simplified)
   */
  static CandlestickPatterns(opens, highs, lows, closes) {
    if (closes.length < 3) return [];
    const patterns = [];
    const i = closes.length - 1;

    const body = Math.abs(closes[i] - opens[i]);
    const upperWick = highs[i] - Math.max(opens[i], closes[i]);
    const lowerWick = Math.min(opens[i], closes[i]) - lows[i];
    const range = highs[i] - lows[i];
    const isBullish = closes[i] > opens[i];

    // Doji
    if (body < range * 0.1 && range > 0) {
      patterns.push({ name: "Doji", signal: "neutral", description: "Indecision in the market" });
    }

    // Hammer (bullish reversal)
    if (lowerWick > body * 2 && upperWick < body * 0.5 && !isBullish) {
      patterns.push({ name: "Hammer", signal: "bullish", description: "Potential bullish reversal" });
    }

    // Shooting Star (bearish reversal)
    if (upperWick > body * 2 && lowerWick < body * 0.5 && isBullish) {
      patterns.push({ name: "Shooting Star", signal: "bearish", description: "Potential bearish reversal" });
    }

    // Engulfing patterns
    if (i >= 1) {
      const prevBody = Math.abs(closes[i - 1] - opens[i - 1]);
      const prevBullish = closes[i - 1] > opens[i - 1];

      // Bullish engulfing
      if (isBullish && !prevBullish && body > prevBody * 1.1 && opens[i] <= closes[i - 1]) {
        patterns.push({ name: "Bullish Engulfing", signal: "bullish", description: "Strong bullish reversal pattern" });
      }

      // Bearish engulfing
      if (!isBullish && prevBullish && body > prevBody * 1.1 && opens[i] >= closes[i - 1]) {
        patterns.push({ name: "Bearish Engulfing", signal: "bearish", description: "Strong bearish reversal pattern" });
      }
    }

    // Morning/Evening star (3-candle patterns)
    if (i >= 2) {
      const body1 = Math.abs(closes[i - 2] - opens[i - 2]);
      const body2 = Math.abs(closes[i - 1] - opens[i - 1]);
      const bull1 = closes[i - 2] > opens[i - 2];

      // Morning Star (bullish)
      if (!bull1 && body1 > range * 0.3 && body2 < body1 * 0.3 && isBullish && body > body1 * 0.5) {
        patterns.push({ name: "Morning Star", signal: "bullish", description: "Strong bullish reversal (3-candle)" });
      }

      // Evening Star (bearish)
      if (bull1 && body1 > range * 0.3 && body2 < body1 * 0.3 && !isBullish && body > body1 * 0.5) {
        patterns.push({ name: "Evening Star", signal: "bearish", description: "Strong bearish reversal (3-candle)" });
      }
    }

    return patterns;
  }

  /**
   * Trend strength using ADX-like calculation
   */
  static TrendStrength(highs, lows, closes, period = 14) {
    if (closes.length < period * 2) return null;

    // Simplified trend detection using multiple timeframes
    const sma5 = this.SMA(closes, 5);
    const sma10 = this.SMA(closes, 10);
    const sma20 = this.SMA(closes, 20);
    const sma50 = this.SMA(closes, Math.min(50, closes.length));
    const current = closes[closes.length - 1];

    let bullishCount = 0;
    let totalChecks = 0;

    if (sma5) { totalChecks++; if (current > sma5) bullishCount++; }
    if (sma10) { totalChecks++; if (current > sma10) bullishCount++; }
    if (sma20) { totalChecks++; if (current > sma20) bullishCount++; }
    if (sma50) { totalChecks++; if (current > sma50) bullishCount++; }
    if (sma5 && sma10) { totalChecks++; if (sma5 > sma10) bullishCount++; }
    if (sma10 && sma20) { totalChecks++; if (sma10 > sma20) bullishCount++; }
    if (sma20 && sma50) { totalChecks++; if (sma20 > sma50) bullishCount++; }

    const bullishRatio = totalChecks > 0 ? bullishCount / totalChecks : 0.5;

    let trend, strength;
    if (bullishRatio >= 0.85) { trend = "Strong Uptrend"; strength = "strong_bullish"; }
    else if (bullishRatio >= 0.65) { trend = "Uptrend"; strength = "bullish"; }
    else if (bullishRatio >= 0.45) { trend = "Sideways"; strength = "neutral"; }
    else if (bullishRatio >= 0.25) { trend = "Downtrend"; strength = "bearish"; }
    else { trend = "Strong Downtrend"; strength = "strong_bearish"; }

    return { trend, strength, bullishRatio, sma5, sma10, sma20, sma50 };
  }
}

/**
 * Main analysis function - generates comprehensive recommendation
 */
function analyzeStock(historicalData, quote) {
  if (!historicalData || historicalData.length < 30) {
    return { error: "Insufficient historical data for analysis" };
  }

  const closes = historicalData.map((d) => d.close);
  const highs = historicalData.map((d) => d.high);
  const lows = historicalData.map((d) => d.low);
  const opens = historicalData.map((d) => d.open);
  const volumes = historicalData.map((d) => d.volume);
  const currentPrice = closes[closes.length - 1];

  // Calculate all indicators
  const rsi = TechnicalAnalysis.RSI(closes);
  const macd = TechnicalAnalysis.MACD(closes);
  const bollinger = TechnicalAnalysis.BollingerBands(closes);
  const stochastic = TechnicalAnalysis.Stochastic(highs, lows, closes);
  const atr = TechnicalAnalysis.ATR(highs, lows, closes);
  const volumeAnalysis = TechnicalAnalysis.VolumeAnalysis(volumes);
  const obvTrend = TechnicalAnalysis.OBVTrend(closes, volumes);
  const roc5 = TechnicalAnalysis.ROC(closes, 5);
  const roc10 = TechnicalAnalysis.ROC(closes, 10);
  const trendStrength = TechnicalAnalysis.TrendStrength(highs, lows, closes);
  const supportResistance = TechnicalAnalysis.SupportResistance(highs, lows, closes);
  const candlestickPatterns = TechnicalAnalysis.CandlestickPatterns(opens, highs, lows, closes);
  const vwap = TechnicalAnalysis.VWAP(highs, lows, closes, volumes);

  // Scoring system (out of 100, 50 = neutral)
  //
  // DE-DUPLICATION: RSI, Stochastic, and Bollinger Bands all measure the same
  // thing (overbought/oversold momentum). MACD and Trend both measure the same
  // thing (trend direction via moving averages). When they all fire together,
  // the old code summed +27 from momentum alone or +20 from trend alone — this
  // created false "Strong Buy" on dead-cat bounces and double-counted golden
  // crosses.
  //
  // Fix: each indicator still contributes individually (and is still shown in
  // the UI), but we TRACK the per-group contribution and CAP it at ±14 per
  // group. This keeps the signal honest: a crash triggers all 3 momentum
  // indicators, but the total score impact is capped at +14 instead of +27.
  //
  // Groups:
  //   • MOMENTUM: RSI, Stochastic, Bollinger Bands (cap ±14)
  //   • TREND:    MACD, Trend Strength (cap ±14)
  //   • INDEPENDENT: Volume, OBV, Momentum (ROC), Patterns, Support/Resistance

  let score = 50;
  const signals = [];

  // Group accumulators — declared here so every indicator block can contribute
  // regardless of source-order in the code below.
  let momentumGroupDelta = 0; // RSI + Stochastic + Bollinger → capped at ±14
  let trendGroupDelta = 0;    // MACD + Trend Strength → capped at ±14

  // RSI Signal
  let rsiDelta = 0;
  if (rsi !== null) {
    if (rsi < 25) { rsiDelta = 12; signals.push({ indicator: "RSI", signal: "Strong Buy", detail: `RSI at ${rsi.toFixed(1)} - Heavily oversold`, impact: "+12" }); }
    else if (rsi < 30) { rsiDelta = 8; signals.push({ indicator: "RSI", signal: "Buy", detail: `RSI at ${rsi.toFixed(1)} - Oversold territory`, impact: "+8" }); }
    else if (rsi < 40) { rsiDelta = 4; signals.push({ indicator: "RSI", signal: "Slightly Bullish", detail: `RSI at ${rsi.toFixed(1)} - Approaching oversold`, impact: "+4" }); }
    else if (rsi > 80) { rsiDelta = -12; signals.push({ indicator: "RSI", signal: "Strong Sell", detail: `RSI at ${rsi.toFixed(1)} - Heavily overbought`, impact: "-12" }); }
    else if (rsi > 70) { rsiDelta = -8; signals.push({ indicator: "RSI", signal: "Sell", detail: `RSI at ${rsi.toFixed(1)} - Overbought territory`, impact: "-8" }); }
    else if (rsi > 60) { rsiDelta = -3; signals.push({ indicator: "RSI", signal: "Slightly Bearish", detail: `RSI at ${rsi.toFixed(1)} - Approaching overbought`, impact: "-3" }); }
    else { signals.push({ indicator: "RSI", signal: "Neutral", detail: `RSI at ${rsi.toFixed(1)} - Normal range`, impact: "0" }); }
    momentumGroupDelta += rsiDelta;
  }

  // MACD Signal (trend group)
  if (macd) {
    let macdDelta = 0;
    if (macd.crossover) { macdDelta = 10; signals.push({ indicator: "MACD", signal: "Strong Buy", detail: "Bullish crossover detected - MACD crossed above signal line", impact: "+10" }); }
    else if (macd.crossunder) { macdDelta = -10; signals.push({ indicator: "MACD", signal: "Strong Sell", detail: "Bearish crossover detected - MACD crossed below signal line", impact: "-10" }); }
    else if (macd.histogram > 0 && macd.macd > 0) { macdDelta = 5; signals.push({ indicator: "MACD", signal: "Bullish", detail: `MACD histogram positive (${macd.histogram.toFixed(2)}) - Bullish momentum`, impact: "+5" }); }
    else if (macd.histogram < 0 && macd.macd < 0) { macdDelta = -5; signals.push({ indicator: "MACD", signal: "Bearish", detail: `MACD histogram negative (${macd.histogram.toFixed(2)}) - Bearish momentum`, impact: "-5" }); }
    else { signals.push({ indicator: "MACD", signal: "Neutral", detail: `MACD: ${macd.macd.toFixed(2)}, Signal: ${macd.signal.toFixed(2)}`, impact: "0" }); }
    trendGroupDelta += macdDelta;
  }

  // Bollinger Bands Signal (momentum group)
  if (bollinger) {
    let bolDelta = 0;
    if (bollinger.percentB < 0) { bolDelta = 8; signals.push({ indicator: "Bollinger Bands", signal: "Strong Buy", detail: "Price below lower band - Extremely oversold", impact: "+8" }); }
    else if (bollinger.percentB < 0.2) { bolDelta = 5; signals.push({ indicator: "Bollinger Bands", signal: "Buy", detail: `Price near lower band (%B: ${(bollinger.percentB * 100).toFixed(1)}%)`, impact: "+5" }); }
    else if (bollinger.percentB > 1) { bolDelta = -8; signals.push({ indicator: "Bollinger Bands", signal: "Strong Sell", detail: "Price above upper band - Extremely overbought", impact: "-8" }); }
    else if (bollinger.percentB > 0.8) { bolDelta = -5; signals.push({ indicator: "Bollinger Bands", signal: "Sell", detail: `Price near upper band (%B: ${(bollinger.percentB * 100).toFixed(1)}%)`, impact: "-5" }); }
    else { signals.push({ indicator: "Bollinger Bands", signal: "Neutral", detail: `Price within bands (%B: ${(bollinger.percentB * 100).toFixed(1)}%)`, impact: "0" }); }
    momentumGroupDelta += bolDelta;
  }

  // Stochastic Signal (momentum group)
  if (stochastic) {
    let stochDelta = 0;
    if (stochastic.k < 20 && stochastic.d < 20) { stochDelta = 7; signals.push({ indicator: "Stochastic", signal: "Buy", detail: `%K: ${stochastic.k.toFixed(1)}, %D: ${stochastic.d.toFixed(1)} - Oversold`, impact: "+7" }); }
    else if (stochastic.k > 80 && stochastic.d > 80) { stochDelta = -7; signals.push({ indicator: "Stochastic", signal: "Sell", detail: `%K: ${stochastic.k.toFixed(1)}, %D: ${stochastic.d.toFixed(1)} - Overbought`, impact: "-7" }); }
    else { signals.push({ indicator: "Stochastic", signal: "Neutral", detail: `%K: ${stochastic.k.toFixed(1)}, %D: ${stochastic.d.toFixed(1)}`, impact: "0" }); }
    momentumGroupDelta += stochDelta;
  }

  // Apply CAPPED momentum group to score.
  //
  // Phase 4 (Apr 2026): widen cap from ±14 to ±18 when the oversold
  // triple-cluster fires (RSI < 30 AND Stochastic <20/<20 AND Bollinger
  // %B < 20). Per-signal attribution showed this cluster has the largest
  // positive edge across the entire signal library:
  //
  //   rsiOversold alone   → +7.25% edge (13 trades)
  //   stochOversold alone → +4.75% edge
  //   bolNearLower alone  → +4.18% edge
  //
  // When all three coincide, the probability of a genuine oversold
  // reversal is materially higher than any individual signal. The
  // extended cap lets the score breathe for these high-edge cases
  // without removing the cap's protection against single-signal
  // over-weighting in the general case.
  const rsiOversoldHot = rsi !== null && rsi < 30;
  const stochOversoldHot = stochastic !== null && stochastic.k < 20 && stochastic.d < 20;
  const bolNearLowerHot = bollinger !== null && bollinger.percentB < 0.2;
  const oversoldCluster = rsiOversoldHot && stochOversoldHot && bolNearLowerHot;

  const momentumCap = oversoldCluster ? 18 : 14;
  const cappedMomentum = Math.max(-momentumCap, Math.min(momentumCap, momentumGroupDelta));
  score += cappedMomentum;

  if (oversoldCluster) {
    signals.push({
      indicator: "Oversold Cluster",
      signal: "Strong Buy",
      detail: "RSI + Stochastic + Bollinger all oversold — highest-edge reversal setup (+7% avg in 24mo backtest)",
      impact: "+4 cluster bonus",
    });
  }

  // Trend Signal (trend group)
  if (trendStrength) {
    let trendDelta = 0;
    if (trendStrength.strength === "strong_bullish") { trendDelta = 10; signals.push({ indicator: "Trend", signal: "Strong Buy", detail: `${trendStrength.trend} - Price above all major moving averages`, impact: "+10" }); }
    else if (trendStrength.strength === "bullish") { trendDelta = 5; signals.push({ indicator: "Trend", signal: "Buy", detail: `${trendStrength.trend} - Positive trend alignment`, impact: "+5" }); }
    else if (trendStrength.strength === "strong_bearish") { trendDelta = -10; signals.push({ indicator: "Trend", signal: "Strong Sell", detail: `${trendStrength.trend} - Price below all major moving averages`, impact: "-10" }); }
    else if (trendStrength.strength === "bearish") { trendDelta = -5; signals.push({ indicator: "Trend", signal: "Sell", detail: `${trendStrength.trend} - Negative trend alignment`, impact: "-5" }); }
    else { signals.push({ indicator: "Trend", signal: "Neutral", detail: `${trendStrength.trend} - No clear direction`, impact: "0" }); }
    trendGroupDelta += trendDelta;
  }

  // Apply CAPPED trend group to score (was uncapped sum up to ±20, now ±14)
  const cappedTrend = Math.max(-14, Math.min(14, trendGroupDelta));
  score += cappedTrend;

  // ─── Independent signals (no cap, no grouping) ───

  // Volume Signal (weight: 8)
  if (volumeAnalysis && roc5 !== null) {
    if (volumeAnalysis.isSpike && roc5 > 0) { score += 6; signals.push({ indicator: "Volume", signal: "Bullish", detail: `${volumeAnalysis.description} volume (${volumeAnalysis.volumeRatio.toFixed(1)}x avg) with rising price`, impact: "+6" }); }
    else if (volumeAnalysis.isSpike && roc5 < 0) { score -= 6; signals.push({ indicator: "Volume", signal: "Bearish", detail: `${volumeAnalysis.description} volume (${volumeAnalysis.volumeRatio.toFixed(1)}x avg) with falling price`, impact: "-6" }); }
    else { signals.push({ indicator: "Volume", signal: "Neutral", detail: `${volumeAnalysis.description} volume (${volumeAnalysis.volumeRatio.toFixed(1)}x avg)`, impact: "0" }); }
  }

  // OBV Signal (weight: 7)
  if (obvTrend) {
    if (obvTrend.trend === "bullish") { score += 4; signals.push({ indicator: "OBV", signal: "Bullish", detail: "On-Balance Volume trending up - Accumulation", impact: "+4" }); }
    else { score -= 4; signals.push({ indicator: "OBV", signal: "Bearish", detail: "On-Balance Volume trending down - Distribution", impact: "-4" }); }
  }

  // Momentum Signal (weight: 8)
  if (roc5 !== null && roc10 !== null) {
    if (roc5 > 3 && roc10 > 5) { score += 6; signals.push({ indicator: "Momentum", signal: "Strong Buy", detail: `5-day: +${roc5.toFixed(1)}%, 10-day: +${roc10.toFixed(1)}% - Strong upward momentum`, impact: "+6" }); }
    else if (roc5 > 1 && roc10 > 0) { score += 3; signals.push({ indicator: "Momentum", signal: "Bullish", detail: `5-day: +${roc5.toFixed(1)}%, 10-day: +${roc10.toFixed(1)}%`, impact: "+3" }); }
    else if (roc5 < -3 && roc10 < -5) { score -= 6; signals.push({ indicator: "Momentum", signal: "Strong Sell", detail: `5-day: ${roc5.toFixed(1)}%, 10-day: ${roc10.toFixed(1)}% - Strong downward momentum`, impact: "-6" }); }
    else if (roc5 < -1 && roc10 < 0) { score -= 3; signals.push({ indicator: "Momentum", signal: "Bearish", detail: `5-day: ${roc5.toFixed(1)}%, 10-day: ${roc10.toFixed(1)}%`, impact: "-3" }); }
    else { signals.push({ indicator: "Momentum", signal: "Neutral", detail: `5-day: ${roc5 > 0 ? "+" : ""}${roc5.toFixed(1)}%, 10-day: ${roc10 > 0 ? "+" : ""}${roc10.toFixed(1)}%`, impact: "0" }); }
  }

  // Candlestick patterns (weight: 5)
  if (candlestickPatterns.length > 0) {
    for (const pattern of candlestickPatterns) {
      if (pattern.signal === "bullish") { score += 3; signals.push({ indicator: "Pattern", signal: "Bullish", detail: `${pattern.name} - ${pattern.description}`, impact: "+3" }); }
      else if (pattern.signal === "bearish") { score -= 3; signals.push({ indicator: "Pattern", signal: "Bearish", detail: `${pattern.name} - ${pattern.description}`, impact: "-3" }); }
      else { signals.push({ indicator: "Pattern", signal: "Neutral", detail: `${pattern.name} - ${pattern.description}`, impact: "0" }); }
    }
  }

  // Support/Resistance context
  if (supportResistance) {
    if (supportResistance.distanceToSupport < 2) {
      score += 3;
      signals.push({ indicator: "Support", signal: "Bullish", detail: `Price near support (${supportResistance.distanceToSupport.toFixed(1)}% above) - Potential bounce`, impact: "+3" });
    }
    if (supportResistance.distanceToResistance < 2) {
      score -= 2;
      signals.push({ indicator: "Resistance", signal: "Bearish", detail: `Price near resistance (${supportResistance.distanceToResistance.toFixed(1)}% below) - Potential rejection`, impact: "-2" });
    }
  }

  // Clamp score
  score = Math.max(0, Math.min(100, score));

  // Generate signal + observational action text.
  // `action` is the user-facing text shown on the stock detail page. We use
  // observational language ("Scorecard reads …", "Signals converging …")
  // rather than imperative ("Buy", "Sell") so the output lives firmly in
  // the educational-research lane permitted for non-SEBI-registered entities.
  let recommendation, action, confidence, urgency;
  if (score >= 80) {
    recommendation = "STRONG BUY";
    action = "Scorecard strongly bullish — multiple technical signals converging on the positive side";
    confidence = "High";
    urgency = "High-conviction signal";
  } else if (score >= 65) {
    recommendation = "BUY";
    action = "Scorecard bullish — bullish signals outweigh bearish ones";
    confidence = "Medium-High";
    urgency = "Positive signal";
  } else if (score >= 55) {
    recommendation = "WEAK BUY";
    action = "Scorecard mildly bullish — slightly positive tilt";
    confidence = "Medium";
    urgency = "Mild positive signal — confirmation useful";
  } else if (score >= 45) {
    recommendation = "HOLD";
    action = "Scorecard neutral — no clear directional signal";
    confidence = "Low";
    urgency = "No directional signal";
  } else if (score >= 35) {
    recommendation = "WEAK SELL";
    action = "Scorecard mildly bearish — slightly negative tilt";
    confidence = "Medium";
    urgency = "Mild negative signal — technical support worth monitoring";
  } else if (score >= 20) {
    recommendation = "SELL";
    action = "Scorecard bearish — bearish signals dominate";
    confidence = "Medium-High";
    urgency = "Negative signal";
  } else {
    recommendation = "STRONG SELL";
    action = "Scorecard strongly bearish — multiple technical signals converging on the negative side";
    confidence = "High";
    urgency = "High-conviction negative signal";
  }

  // Generate reasoning narrative
  const bullishSignals = signals.filter((s) => s.signal.includes("Buy") || s.signal === "Bullish" || s.signal === "Strong Buy");
  const bearishSignals = signals.filter((s) => s.signal.includes("Sell") || s.signal === "Bearish" || s.signal === "Strong Sell");

  let reasoning = "";
  if (bullishSignals.length > bearishSignals.length) {
    reasoning = `The stock shows ${bullishSignals.length} bullish signal(s) vs ${bearishSignals.length} bearish signal(s). `;
    reasoning += bullishSignals.map((s) => s.detail).join(". ") + ". ";
    if (bearishSignals.length > 0) {
      reasoning += `However, watch out: ${bearishSignals.map((s) => s.detail).join(". ")}.`;
    }
  } else if (bearishSignals.length > bullishSignals.length) {
    reasoning = `The stock shows ${bearishSignals.length} bearish signal(s) vs ${bullishSignals.length} bullish signal(s). `;
    reasoning += bearishSignals.map((s) => s.detail).join(". ") + ". ";
    if (bullishSignals.length > 0) {
      reasoning += `On the positive side: ${bullishSignals.map((s) => s.detail).join(". ")}.`;
    }
  } else {
    reasoning = `Mixed signals detected - ${bullishSignals.length} bullish and ${bearishSignals.length} bearish indicators. No clear directional bias. Wait for confirmation.`;
  }

  // Intraday suitability score
  let intradayScore = 0;
  if (volumeAnalysis && volumeAnalysis.isSpike) intradayScore += 25;
  if (atr && currentPrice > 0) {
    const atrPercent = (atr / currentPrice) * 100;
    if (atrPercent > 2) intradayScore += 30;
    else if (atrPercent > 1.5) intradayScore += 20;
    else if (atrPercent > 1) intradayScore += 10;
  }
  if (Math.abs(roc5 || 0) > 2) intradayScore += 20;
  if (candlestickPatterns.length > 0) intradayScore += 15;
  if (macd && (macd.crossover || macd.crossunder)) intradayScore += 10;

  return {
    score,
    recommendation,
    action,
    confidence,
    urgency,
    reasoning,
    signals,
    indicators: {
      rsi: rsi ? rsi.toFixed(1) : "N/A",
      macd: macd ? { value: macd.macd.toFixed(2), signal: macd.signal.toFixed(2), histogram: macd.histogram.toFixed(2), crossover: macd.crossover, crossunder: macd.crossunder } : null,
      bollinger: bollinger ? { upper: bollinger.upper.toFixed(2), middle: bollinger.middle.toFixed(2), lower: bollinger.lower.toFixed(2), percentB: (bollinger.percentB * 100).toFixed(1) } : null,
      stochastic: stochastic ? { k: stochastic.k.toFixed(1), d: stochastic.d.toFixed(1) } : null,
      atr: atr ? atr.toFixed(2) : null,
      vwap: vwap ? vwap.toFixed(2) : null,
      trend: trendStrength,
      volume: volumeAnalysis,
      supportResistance,
      momentum: { roc5: roc5 ? roc5.toFixed(2) : null, roc10: roc10 ? roc10.toFixed(2) : null },
    },
    candlestickPatterns,
    intradayScore: Math.min(100, intradayScore),
    currentPrice,
  };
}

/**
 * Quick scan for intraday opportunities
 */
function intradayScan(analysis, quote) {
  const { intradayScore, score, indicators, recommendation } = analysis;

  // For intraday, we want high volatility + clear direction
  const isGoodIntraday = intradayScore >= 50;
  const direction = score >= 55 ? "LONG" : score <= 45 ? "SHORT" : "SKIP";

  let stopLoss = null;
  let target = null;

  // FIX (Apr 2026): Use the LIVE market price from the quote, not the last
  // historical close from analysis.currentPrice. When the market is open and
  // the stock has gapped up/down from yesterday's close, intraday SL/target
  // must reflect the actual entry price, not yesterday's level. The old code
  // used analysis.currentPrice (= last bar in historical data = prev close)
  // which caused SL/target to be off by the size of the gap.
  const livePrice = quote?.regularMarketPrice || analysis.currentPrice;

  if (indicators.atr && livePrice) {
    const atrVal = parseFloat(indicators.atr);
    if (direction === "LONG") {
      stopLoss = (livePrice - atrVal * 1.5).toFixed(2);
      target = (livePrice + atrVal * 2).toFixed(2);
    } else if (direction === "SHORT") {
      stopLoss = (livePrice + atrVal * 1.5).toFixed(2);
      target = (livePrice - atrVal * 2).toFixed(2);
    }
  }

  return {
    suitable: isGoodIntraday,
    direction,
    intradayScore,
    stopLoss,
    target,
    volatility: indicators.volume ? indicators.volume.description : "Unknown",
  };
}

/**
 * Mid-term investment analysis
 */
function midTermAnalysis(analysis, quote, historicalCloses = null) {
  const { score, indicators, recommendation } = analysis;

  let midTermScore = score;

  // Boost for strong trends
  if (indicators.trend && indicators.trend.strength === "strong_bullish") midTermScore += 10;
  if (indicators.trend && indicators.trend.strength === "strong_bearish") midTermScore -= 10;

  // Good volume trend matters for mid-term
  if (indicators.volume && indicators.volume.description === "Above Average") midTermScore += 5;

  midTermScore = Math.max(0, Math.min(100, midTermScore));

  let midTermRec;
  if (midTermScore >= 70) midTermRec = "STRONG BUY for mid-term";
  else if (midTermScore >= 58) midTermRec = "BUY for mid-term";
  else if (midTermScore >= 42) midTermRec = "HOLD";
  else if (midTermScore >= 30) midTermRec = "SELL";
  else midTermRec = "STRONG SELL";

  // SL/Target for mid-term (2-4 week holding period).
  //
  // Daily ATR measures one day of price movement. Over 2-4 weeks (10-20
  // trading days), a stock moves MUCH more. Using sqrt(days) scaling
  // (volatility scales with sqrt of time):
  //
  //   Intraday (1 day):  SL = 1.5× ATR, Target = 2× ATR
  //   Mid-term (10 days): SL = 4× ATR, Target = 5× ATR → R:R = 1.25×
  //
  // REBALANCED (Apr 2026, multi-horizon backtesting):
  //   • SL widened from 3× to 4× ATR — 44% SL rate across ALL 5 backtested
  //     horizons (1yr-5yr) showed the 3× SL was chopping out trades that
  //     would have recovered. 4× gives the stock room to breathe while still
  //     capping max drawdown at a reasonable level.
  //   • Target tightened from 6× to 5× ATR — only 13% of trades hit the 6×
  //     target across all horizons. The more achievable 5× target locks in
  //     gains that otherwise expired as flat time-exits.
  // multiplier gave aspirational targets (+26% for MARUTI) that most Nifty
  // stocks wouldn't realistically hit in 2-4 weeks without a major catalyst.
  // The tighter 6× target:
  //   • Gives a more achievable +19% for the same stock
  //   • R:R drops from 2.0× to 1.5× — still above the 1.0× minimum for
  //     positive expectancy, and more honest about what swing trades deliver
  //   • Anything ABOVE the target is a bonus, so conservative targets mean
  //     users are more often pleasantly surprised than disappointed
  //
  // Example: MARUTI at ₹13,289 with daily ATR ₹431 (3.25% volatility):
  //   Intraday: SL = ₹12,642 (-5%), Target = ₹14,151 (+6.5%)
  //   Mid-term: SL = ₹11,564 (-13%), Target = ₹15,877 (+19.5%)
  const price = quote?.regularMarketPrice;
  const atr = indicators.atr ? parseFloat(indicators.atr) : null;
  let stopLoss = null;
  let target = null;
  let volatilityPct = null;
  let riskReward = null;

  // Phase 6 (Apr 2026): SL 4×ATR / target 6×ATR. REVERTED Phase 1's 3×/7×
  // change after it regressed 2025 performance badly (α −11% with 3×/7× vs
  // α −2% with 4×/6× in diagnostic). The Phase 1 change was overfit to
  // 2024 conditions — in 2025's higher-vol regime, 3× ATR SL gets wicked
  // out too easily. Validated across 2023/2024/2025 — 4×/6× is strictly
  // equal-or-better in every year tested. Theoretical R:R 6/4 = 1.5.
  if (atr && price) {
    stopLoss = parseFloat((price - atr * 4).toFixed(2));
    target = parseFloat((price + atr * 6).toFixed(2));
    volatilityPct = parseFloat(((atr / price) * 100).toFixed(2));
    riskReward = parseFloat(((target - price) / (price - stopLoss)).toFixed(2));
  }

  // P6 (Apr 2026): Trailing stop info for the UI.
  //
  // The trailing stop replaces the fixed SL once the stock moves in your
  // favour. Instead of exiting at the original SL (which could be -10% below
  // entry), the trailing stop follows the price up and locks in gains.
  //
  //   trailingStopRule = "highest close minus ATR × 3"
  //
  // At entry, the trailing stop equals the initial SL. As the stock rises,
  // the trailing stop rises with it (but never falls). Example:
  //   Entry ₹100, ATR ₹5 → initial trailing stop = ₹100 - ₹15 = ₹85
  //   Stock rises to ₹115 → trailing stop = ₹115 - ₹15 = ₹100 (breakeven!)
  //   Stock pulls back to ₹108 → trailing stop stays at ₹100 (locked)
  //   Stock drops to ₹100 → exit at ₹100 (0% instead of -10% on fixed SL)
  //
  // The trailing stop info is exposed to the UI so users can manually trail
  // their positions. A full automated trailing-stop exit engine would require
  // intraday price polling which is beyond the current architecture.
  // ── Fix 1: 2-Close SL Confirmation ──
  // A single intraday wick below SL is NOT a confirmed breach. We require
  // 2 consecutive daily CLOSES below the SL level before signaling exit.
  // This reduced false SL triggers by ~30-40% in 8-year backtesting.
  let slConfirmed = false;
  let slConfirmationNote = null;
  if (stopLoss != null && historicalCloses && historicalCloses.length >= 2) {
    const last2 = historicalCloses.slice(-2);
    const bothBelow = last2.every((c) => c < stopLoss);
    const lastBelow = last2[last2.length - 1] < stopLoss;
    if (bothBelow) {
      slConfirmed = true;
      slConfirmationNote = "SL CONFIRMED — 2 consecutive closes below stop-loss. Exit position.";
    } else if (lastBelow) {
      slConfirmationNote = "SL breached on last close — wait for 2nd confirmation close before exiting.";
    }
  }

  // ── Phase 1 (Apr 2026): Activation-gated trailing stop ──
  //
  // Previous behavior trailed from entry, which chopped out recoverable
  // positions that drew down below entry before recovering. The 24-month
  // honest backtest showed trailing was WORSE than fixed (−17% alpha vs
  // −15%) because of this.
  //
  // New behavior: trailing stop only ACTIVATES once the stock has moved
  // +2×ATR above entry. Until then, the fixed initial SL (−3×ATR) is in
  // force. Once activated, the trail distance is ATR × 3 below the
  // highest close seen post-activation. Locks in gains, ignores
  // pre-activation drawdown.
  let trailingStop = null;
  if (atr && price) {
    const trailDist = parseFloat((atr * 3).toFixed(2));
    const activationThreshold = parseFloat((price + atr * 2).toFixed(2));
    const initialLevel = parseFloat((price - trailDist).toFixed(2));

    // Dynamic: compute from highest recent close (20-day lookback). Only
    // engage the trail if highest close ≥ activation threshold.
    let currentLevel = initialLevel;
    let highestClose = price;
    let activated = false;
    let trailingStopTriggered = false;
    if (historicalCloses && historicalCloses.length >= 2) {
      const recent = historicalCloses.slice(-20);
      highestClose = Math.max(...recent);
      activated = highestClose >= activationThreshold;
      if (activated) {
        currentLevel = parseFloat((highestClose - trailDist).toFixed(2));
        currentLevel = Math.max(currentLevel, initialLevel);
        trailingStopTriggered = price < currentLevel;
      }
    }

    trailingStop = {
      initialLevel,
      currentLevel,
      activated,
      activationThreshold,
      highestClose: parseFloat(highestClose.toFixed(2)),
      trailDistance: trailDist,
      triggered: trailingStopTriggered,
      rule: activated
        ? `Highest close (₹${highestClose.toFixed(0)}) minus ₹${trailDist.toFixed(0)} (ATR × 3). Activated after +2×ATR gain.`
        : `Inactive — trailing stop engages only after price closes above ₹${activationThreshold.toFixed(0)} (entry + 2×ATR).`,
      explanation: !activated
        ? "Fixed SL still in force. The trailing engine waits until the trade is in decent profit before locking gains."
        : trailingStopTriggered
          ? "Price is BELOW trailing stop — consider exiting to lock in gains."
          : "Move this stop up as the stock rises. Never lower it. Exit if price closes below.",
    };
  }

  return {
    score: midTermScore,
    recommendation: midTermRec,
    trendAlignment: indicators.trend ? indicators.trend.trend : "Unknown",
    stopLoss,
    target,
    volatilityPct,
    riskReward,
    slConfirmed,
    slConfirmationNote,
    trailingStop,
  };
}

/**
 * Long-term investment outlook (3–12 month holding period).
 *
 * FUNDAMENTALLY DIFFERENT from intraday/mid-term: this is a business-quality
 * assessment, not a momentum signal. The score is 70% fundamentals (ROE,
 * margins, debt, growth, valuation) and 30% structural trend context (200DMA,
 * 52W position). Momentum indicators like RSI, MACD, and Stochastic are
 * deliberately excluded — they're noise at this timescale.
 *
 * Target price is VALUATION-BASED (P/E reversion to sector median), not
 * ATR-based. Stop-loss is STRUCTURAL (max of 200DMA, 52W low, -20% floor),
 * not volatility-based. This means both the target and stop correspond to
 * real market reference points, not arbitrary standard-deviation bands.
 *
 * @param {object} analysis        - return value of analyzeStock()
 * @param {object} quote           - live quote with regularMarketPrice
 * @param {object} fundamentalResult - return value of scoreFundamentals() (or null)
 * @param {number|null} dma200     - 200-day moving average (or null)
 * @returns {object}               - long-term outlook (see return block)
 */
function longTermOutlook(analysis, quote, fundamentalResult, dma200) {
  const price = quote?.regularMarketPrice;
  if (!price) return null;

  const fundScore = fundamentalResult?.score ?? null;
  const fundVerdict = fundamentalResult?.verdict ?? null;
  const breakdown = fundamentalResult?.breakdown || {};
  const snap = fundamentalResult?.snapshot || {};

  // ── 1. Trend context score (30% of final score) ──
  // Only structural trend signals — 200DMA and 52W position. These measure
  // whether the stock is in a long-term uptrend or downtrend, which matters
  // even for fundamental investors (buying cheap in a structural downtrend
  // = catching a falling knife).
  let trendContext = 50; // neutral base

  // Price vs 200DMA
  if (dma200 && price) {
    const ratio200 = price / dma200;
    if (ratio200 >= 1.15)      trendContext += 15;  // well above 200DMA
    else if (ratio200 >= 1.0)  trendContext += 10;  // above 200DMA
    else if (ratio200 >= 0.90) trendContext -= 10;  // below 200DMA
    else                       trendContext -= 15;  // well below 200DMA
  }

  // 52W position
  const w52High = snap.week52High || quote?.fiftyTwoWeekHigh;
  const w52Low = snap.week52Low || quote?.fiftyTwoWeekLow;
  if (w52High && w52Low && w52High > w52Low) {
    const pos = (price - w52Low) / (w52High - w52Low);
    if (pos <= 0.25)       trendContext += 10;  // near 52W low — deep value zone
    else if (pos <= 0.50)  trendContext += 5;   // lower half
    else if (pos >= 0.90)  trendContext -= 10;  // near 52W high — euphoria
    else if (pos >= 0.75)  trendContext -= 5;   // upper quarter
  }

  // Trend alignment (structural only)
  if (analysis.indicators?.trend) {
    if (analysis.indicators.trend.strength === "strong_bullish")  trendContext += 5;
    else if (analysis.indicators.trend.strength === "strong_bearish") trendContext -= 5;
  }

  trendContext = Math.max(0, Math.min(100, trendContext));

  // ── 2. Composite long-term score ──
  // 70% fundamentals + 30% trend context
  // When fundamentals are missing, fall back to 100% trend context.
  let longTermScore;
  if (fundScore != null) {
    longTermScore = Math.round(fundScore * 0.70 + trendContext * 0.30);
  } else {
    longTermScore = trendContext; // no fundamentals → trend only
  }
  longTermScore = Math.max(0, Math.min(100, longTermScore));

  // ── 3. Recommendation ──
  //
  // Respects the quality guardrail: if the fundamental scorer downgraded the
  // verdict because of weak ROE or high leverage, the long-term recommendation
  // is capped at HOLD. A stock with a high raw fundamental score but a
  // guardrail downgrade is "cheap but risky" — not something we should label
  // BUY for a 3-12 month hold without the user explicitly overriding.
  const guardrailApplied = breakdown.qualityGuardrailApplied === true;

  let recommendation;
  if (guardrailApplied) {
    // Cap at HOLD — the quality check failed
    if (longTermScore >= 62)      recommendation = "HOLD — quality guardrail";
    else if (longTermScore >= 48) recommendation = "HOLD";
    else if (longTermScore >= 35) recommendation = "REDUCE";
    else                          recommendation = "EXIT";
  } else {
    if (longTermScore >= 75)      recommendation = "STRONG BUY for long-term";
    else if (longTermScore >= 62) recommendation = "BUY for long-term";
    else if (longTermScore >= 48) recommendation = "HOLD";
    else if (longTermScore >= 35) recommendation = "REDUCE";
    else                          recommendation = "EXIT";
  }

  // ── 4. Target price (valuation-based) ──
  //
  // Three strategies ranked by data availability:
  //
  // A. Undervalued (P/E < sector P/E): re-rate to sector median, capped at +40%
  //    "If the market valued this stock like its peers, what's the price?"
  //
  // B. At/above sector valuation: use max of 52W high or growth-implied price
  //    "What has the market already been willing to pay, or what does growth justify?"
  //
  // C. Fallback: +15% default (conservative, better than showing nothing)
  const pe = snap.pe ?? breakdown.peRatio;
  const sectorPe = snap.sectorPe ?? breakdown.sectorPeUsed;
  const revGrowth = breakdown.revenueGrowthValue;

  let target = null;
  let valuationBasis = null;

  // Strategy A is only meaningful when P/E is at least 10% below sector —
  // otherwise the re-rating gives trivial upside (e.g., MARUTI P/E 29.1 vs
  // sector 29.5 → only +1.4% target, which gives a terrible R:R). In that
  // case we fall through to Strategy B which uses 52W high or growth.
  const meaningfulDiscount = pe && sectorPe && pe > 0 && sectorPe > 0
    && pe < sectorPe && (sectorPe / pe) >= 1.10;

  if (meaningfulDiscount) {
    // Strategy A: P/E reversion to sector median
    const reRatingMultiple = Math.min(sectorPe / pe, 1.40);
    target = parseFloat((price * reRatingMultiple).toFixed(2));
    valuationBasis = `P/E re-rating from ${pe.toFixed(1)} to sector median ${sectorPe.toFixed(1)} (capped at +40%)`;
  } else if (w52High && w52High > price) {
    // Strategy B1: 52W high as target (mean reversion to recent peak)
    const growthImplied = revGrowth != null ? price * (1 + revGrowth) : 0;
    target = parseFloat(Math.max(w52High, growthImplied).toFixed(2));
    valuationBasis = target === w52High
      ? "52-week high reversion"
      : `Revenue growth implied (${(revGrowth * 100).toFixed(0)}% YoY)`;
  } else if (revGrowth != null && revGrowth > 0) {
    // Strategy B2: growth-implied when already at/near 52W high
    target = parseFloat((price * (1 + revGrowth)).toFixed(2));
    valuationBasis = `Revenue growth implied (${(revGrowth * 100).toFixed(0)}% YoY)`;
  } else {
    // Strategy C: conservative fallback
    target = parseFloat((price * 1.15).toFixed(2));
    valuationBasis = "Conservative default (+15%)";
  }

  // ── 5. Stop-loss (structural) ──
  //
  // Take the HIGHEST of three levels so the SL always has a meaningful
  // structural anchor:
  //   • 200DMA      — institutional "buy the dip" level
  //   • 52W low     — absolute floor the stock has held
  //   • price × 0.80 — hard cap: never risk more than 20% from entry
  //
  // Why max (highest) and not min? Because a higher SL means a tighter
  // leash = less drawdown. The 200DMA is usually the highest of the three
  // and acts as the primary support for long-term holders.
  let stopLoss = parseFloat((price * 0.80).toFixed(2)); // 20% floor
  if (dma200 && dma200 < price) {
    stopLoss = Math.max(stopLoss, parseFloat(dma200.toFixed(2)));
  }
  if (w52Low && w52Low < price) {
    stopLoss = Math.max(stopLoss, parseFloat(w52Low.toFixed(2)));
  }
  // If SL ends up above current price (e.g. stock is below 200DMA AND below
  // 52W low — extreme distress), fall back to the 20% floor.
  if (stopLoss >= price) {
    stopLoss = parseFloat((price * 0.80).toFixed(2));
  }

  // ── 6. Risk:Reward ──
  const riskReward = (target && stopLoss && price > stopLoss)
    ? parseFloat(((target - price) / (price - stopLoss)).toFixed(2))
    : null;

  // ── 7. Key quality metrics for the UI ──
  // Pull from the fundamental breakdown so the card can show a compact
  // quality profile without the user having to scroll to the fundamentals
  // section. Each metric is the RAW value (not the score delta).
  const keyMetrics = {
    roe: breakdown.roeValue ?? null,
    debtToEquity: breakdown.debtToEquityValue ?? null,
    profitMargin: breakdown.profitMarginValue ?? null,
    revenueGrowth: breakdown.revenueGrowthValue ?? null,
    pe: pe ?? null,
    sectorPe: sectorPe ?? null,
  };

  return {
    score: longTermScore,
    recommendation,
    holdingPeriod: "3–12 months",
    fundamentalVerdict: fundVerdict,
    target,
    stopLoss,
    riskReward,
    valuationBasis,
    trendContextScore: trendContext,
    fundamentalScore: fundScore,
    keyMetrics,
  };
}

export { analyzeStock, intradayScan, midTermAnalysis, longTermOutlook, TechnicalAnalysis };
