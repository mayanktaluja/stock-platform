/**
 * Starbhai Glossary
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Single source of truth for every technical / fundamental / macro term that
 * appears in the platform UI. Each entry has:
 *
 *   • term      — display name shown in the popover header
 *   • short     — one-sentence summary (the headline)
 *   • full      — 2-3 sentence explanation including how to read it
 *   • category  — "technical" | "fundamental" | "verdict" | "recommendation"
 *                 | "macro" | "track" | "portfolio"
 *
 * The tooltip system in app.js reads from this object via window.GLOSSARY[id].
 * Term IDs are short, lowercase, underscore-separated identifiers — they get
 * baked into HTML as `data-term-id="rsi"`, `data-term-id="combined_score"`, etc.
 *
 * EDITORIAL VOICE: written for working market analysts. Assume the reader
 * knows what a stock is, but explain WHY each metric matters and HOW to read
 * extreme values. No filler, no marketing copy, no "stocks can go up or down".
 */

window.GLOSSARY = {
  // ══════════════════════════════════════════════════════════════════════
  // TECHNICAL INDICATORS
  // ══════════════════════════════════════════════════════════════════════

  rsi: {
    term: "RSI · Relative Strength Index",
    category: "technical",
    short: "Momentum oscillator measuring the speed and magnitude of price changes (0–100 scale).",
    full: "RSI compares the average size of up moves to the average size of down moves over the last 14 days. Above 70 typically signals overbought (price has rallied hard, may pull back). Below 30 signals oversold (price has fallen hard, bounce likely). Mid-range (40–60) is neutral. Use it as a confirming signal — strong trends can stay overbought or oversold for weeks.",
  },

  macd: {
    term: "MACD · Moving Average Convergence Divergence",
    category: "technical",
    short: "Trend-following momentum indicator built from two moving averages.",
    full: "MACD subtracts a 26-day EMA from a 12-day EMA, then plots a 9-day EMA of that difference as the 'signal line'. When MACD crosses above its signal line, momentum is shifting bullish. When it crosses below, bearish. Histogram bars (MACD minus signal) growing larger = momentum accelerating. The most powerful signal is divergence: price makes a new high but MACD doesn't — that's a warning that the trend is losing strength.",
  },

  bollinger_bands: {
    term: "Bollinger Bands",
    category: "technical",
    short: "Price channel showing volatility — bands tighten in calm markets, widen in volatile ones.",
    full: "Three lines: a 20-day moving average in the middle, plus upper and lower bands at ±2 standard deviations. Roughly 95% of price action stays inside the bands. Touching the upper band = stretched to the upside; touching the lower = stretched to the downside. A 'squeeze' (bands tightening sharply) often precedes a breakout in either direction. Best used to identify overextension, not entry signals on their own.",
  },

  sma: {
    term: "SMA · Simple Moving Average",
    category: "technical",
    short: "Average closing price over N days, smoothing out daily noise.",
    full: "The 50-day SMA shows the medium-term trend; the 200-day SMA shows the long-term trend. Price above the 200-day SMA is generally considered a bull market for that stock. The 'golden cross' (50-day crosses above 200-day) is a classic bullish signal; the 'death cross' (50-day crosses below 200-day) is bearish. Lagging indicator — it confirms trends after they've started, doesn't predict them.",
  },

  ema: {
    term: "EMA · Exponential Moving Average",
    category: "technical",
    short: "Like SMA but weights recent prices more heavily.",
    full: "Reacts faster to price changes than a Simple Moving Average because today's price gets more weight than last month's. The 12-day and 26-day EMAs are the building blocks of MACD. Use EMAs when you need to catch trend changes earlier; use SMAs when you want to filter out noise.",
  },

  volume: {
    term: "Volume",
    category: "technical",
    short: "Total number of shares traded — the conviction behind a price move.",
    full: "Price moves on high volume are more credible than the same moves on low volume. A breakout above resistance with 2× average volume is a strong signal; the same breakout on light volume is suspicious. 'Above Average' / 'High' labels here mean the day's volume vs the 20-day average. Always check volume before trusting a price move.",
  },

  atr: {
    term: "ATR · Average True Range",
    category: "technical",
    short: "Measures how much a stock typically moves in a day — pure volatility, no direction.",
    full: "ATR is the average daily price range over the last 14 days. A stock with ATR of ₹50 typically swings ₹50 between high and low each session. Used to set stop-loss distances (e.g. 1.5× ATR below entry) and position sizes (smaller positions on higher-ATR stocks). Doesn't tell you which way price will move, only how much.",
  },

  vwap: {
    term: "VWAP · Volume-Weighted Average Price",
    category: "technical",
    short: "The average price weighted by trading volume — institutional traders' benchmark.",
    full: "VWAP resets daily and shows the average price at which the day's volume traded. If you bought above VWAP, you paid more than the day's average — institutional desks use it as a 'fair execution' benchmark. Stocks trading above VWAP are showing intraday strength; below VWAP shows intraday weakness. Most useful for intraday trades.",
  },

  long_term_outlook: {
    term: "Long-Term Outlook",
    category: "fundamental",
    short: "3–12 month investment view driven by business quality and valuation, not price momentum.",
    full: "The Long-Term Score blends 70% fundamentals (the 9-dimension pillar engine: ROE, margins, debt, revenue growth, P/E vs sector) with 30% structural trend context (200-day moving average position, 52-week range). Unlike Intraday and Mid-Term which are pure technical signals, this section answers 'Is this business worth owning for the next year?' Target price is valuation-based: if P/E is below the sector median, the target is the implied price if the market re-rates the stock to peer levels (capped at +40%). Stop-loss is structural: the highest of the 200-day moving average, the 52-week low, or a -20% hard floor. Key quality metrics (ROE, Debt/Equity, Net Margin, Revenue Growth, P/E vs Sector) are shown inline so you can see the quality profile at a glance.",
  },

  long_term_narrative: {
    term: "Starbhai Thesis",
    category: "fundamental",
    short: "Structured 3–12 month explanation of WHY the long-term recommendation makes sense — drivers, risks, catalysts, news context.",
    full: "The Starbhai thesis is generated by combining the pre-computed long-term score with classified recent news (last 30 days), the macro regime, and the company's quality flags. It produces a one-paragraph thesis plus collapsible Growth Drivers, Key Risks, and Catalysts to Watch sections. Confidence is HIGH only when fundamentals are strong AND recent news is supportive AND the macro regime is constructive — LOW when fundamentals are thin (no ROE, no DMA, missing sector P/E). The narrative is observational, not advisory — it cites the metrics tracked, never tells you to buy or sell. When the OpenAI budget cap is reached or the LLM is unavailable, a deterministic template is built from the same metrics so the section is never empty.",
  },

  trend: {
    term: "Trend",
    category: "technical",
    short: "Direction of the medium-term price path: uptrend, downtrend, or sideways.",
    full: "Determined by the slope of moving averages and the structure of higher highs / higher lows (uptrend) vs lower highs / lower lows (downtrend). 'Strong Uptrend' means price is above all major moving averages and rising. 'Sideways' means no clear direction — typically the worst environment for trend-following strategies. Always trade WITH the trend unless you have a specific contrarian reason.",
  },

  stochastic: {
    term: "Stochastic Oscillator",
    category: "technical",
    short: "Compares current price to its high-low range over the last 14 days (0–100 scale).",
    full: "Above 80 is overbought, below 20 is oversold — similar bands to RSI but the calculation is different. %K is the fast line, %D is a 3-day average of %K. A %K-cross-above-%D from below 20 is a classic buy signal. Very sensitive — generates more signals than RSI, but also more false positives. Use it as a filter, not a trigger.",
  },

  fifty_two_week_high: {
    term: "52-Week High / Low",
    category: "technical",
    short: "Highest and lowest prices in the last 365 days.",
    full: "The 52-week high acts as psychological resistance — many holders bought higher and want to break even before selling. Breaking above a multi-year 52-week high is one of the strongest bullish signals in investing (it means everyone holding the stock is in profit). Trading near 52-week lows is a warning unless there's a clear contrarian thesis.",
  },

  // ══════════════════════════════════════════════════════════════════════
  // FUNDAMENTAL METRICS
  // ══════════════════════════════════════════════════════════════════════

  pe_ratio: {
    term: "P/E Ratio · Price-to-Earnings",
    category: "fundamental",
    short: "How many years of current earnings the stock is priced at.",
    full: "P/E of 20 means investors are paying ₹20 for every ₹1 of annual earnings — equivalent to a 20-year payback if earnings stay flat. Lower P/E = cheaper relative to current profits, but a low P/E often reflects low growth or high risk. Compare to the sector average (see Sector P/E) rather than absolute thresholds. Loss-making companies have no meaningful P/E.",
  },

  sector_pe: {
    term: "Sector P/E",
    category: "fundamental",
    short: "Average P/E ratio of all stocks in the same sector — the relevant benchmark.",
    full: "A P/E of 25 sounds expensive in absolute terms but is actually cheap if the sector average is 35. A P/E of 12 sounds cheap but is overpriced if sector average is 8. Starbhai uses NSE's reported sector P/E when available, and falls back to a computed median across all stocks in the sector when NSE's value is circular (a known issue with heavyweight stocks like Reliance and ICICI).",
  },

  market_cap: {
    term: "Market Cap",
    category: "fundamental",
    short: "Total value of all the company's shares — share price × shares outstanding.",
    full: "Categorised by Indian standards: Large Cap (>₹50,000 Cr), Mid Cap (₹10,000–50,000 Cr), Small Cap (₹2,000–10,000 Cr), Micro Cap (<₹2,000 Cr). Smaller caps tend to be more volatile, less liquid, and more sensitive to macro shocks — but also offer higher growth potential. Position sizing should scale inversely: smaller positions in smaller caps.",
  },

  eps: {
    term: "EPS · Earnings Per Share",
    category: "fundamental",
    short: "Annual net profit divided by shares outstanding — the per-share profit.",
    full: "Used as the denominator in P/E (P/E = price ÷ EPS). Growing EPS year-over-year is the cleanest sign of a fundamentally improving business. Watch for one-time gains or accounting adjustments that can inflate a single quarter's EPS without reflecting underlying business strength.",
  },

  // ══════════════════════════════════════════════════════════════════════
  // FUNDAMENTAL VERDICTS
  // ══════════════════════════════════════════════════════════════════════

  deep_value: {
    term: "DEEP VALUE",
    category: "verdict",
    short: "Cheap versus sector AND backed by strong quality fundamentals — value without the trap.",
    full: "Score 72+. Stock is cheap on the valuation pillar (low P/E vs sector median, near 52-week lows) AND passes the quality guardrail — positive contributions from ROE and debt-to-equity. The guardrail is the critical distinction: a cheap stock with weak ROE or high leverage is downgraded to FAIR VALUE regardless of score, because those are the exact signals that distinguish a genuine opportunity from a value trap. Always pair with technical confirmation before buying.",
  },

  quality_growth: {
    term: "QUALITY GROWTH",
    category: "verdict",
    short: "Reasonably priced quality compounders — strong ROE, manageable debt, growing revenue.",
    full: "Score 58–71. Not the cheapest stock in the sector, but backed by solid fundamentals across the profitability pillar (ROE, net margin), financial health (debt-to-equity), and growth (YoY revenue). Often shows bullish technicals (above 200-day moving average, healthy RSI) alongside fair valuation. Slower rebounds than DEEP VALUE picks but more durable — this is the 'compound at a reasonable rate' bucket. Like DEEP VALUE, picks in this bucket must clear the ROE + leverage guardrail.",
  },

  fair_value: {
    term: "FAIR VALUE",
    category: "verdict",
    short: "Priced about right relative to fundamentals — no clear edge in either direction.",
    full: "Score 48–57. Not cheap, not expensive. No reason to buy or sell purely on fundamentals. Decisions should be driven by technicals, news, or macro context. Many heavyweight stocks (Reliance, ICICI) land here because they're widely covered and efficiently priced.",
  },

  fully_valued: {
    term: "FULLY VALUED",
    category: "verdict",
    short: "Priced at a premium — limited upside, vulnerable to multiple compression.",
    full: "Score 40–47. The stock is pricing in continued strong execution and any disappointment will trigger selling. Holding existing positions can still make sense if the business is exceptional, but don't initiate new positions here. Watch for the first sign of slowing growth — that's when premium-valued stocks crack hardest.",
  },

  overvalued: {
    term: "OVERVALUED",
    category: "verdict",
    short: "Priced for perfection — significant downside if execution slips.",
    full: "Score below 40. Trading at a steep premium to the sector with limited valuation support. These stocks can keep rising on momentum (NYKAA at P/E 500, DMART at P/E 100), but the risk-reward is asymmetric — the downside is much larger than the remaining upside. Avoid initiating; consider trimming if you already hold.",
  },

  // ══════════════════════════════════════════════════════════════════════
  // RECOMMENDATIONS (combined-score driven)
  // ══════════════════════════════════════════════════════════════════════

  strong_buy: {
    term: "STRONG BUY",
    category: "recommendation",
    short: "All three signals (technical + news + fundamentals) align strongly bullish.",
    full: "Combined score 75+. Confluence of positive signals across every dimension Starbhai analyses. These are rare — typically 2-5 stocks in the entire Nifty 100 at any given time. High conviction entry, but always size positions based on your risk tolerance, not the rating. Confirm volume and avoid chasing if the stock has already rallied 10%+ today.",
  },

  buy: {
    term: "BUY",
    category: "recommendation",
    short: "Bullish picture across most dimensions — good entry candidate.",
    full: "Combined score 62–74. Solid setup but not as confluent as STRONG BUY. Most signals are positive with maybe one neutral. Good for adding to a watchlist position or initiating a starter position (50% of intended size, scale up on confirmation).",
  },

  weak_buy: {
    term: "WEAK BUY",
    category: "recommendation",
    short: "Mildly positive — small starter position only.",
    full: "Combined score 53–61. Edge is real but not strong. Use a small position size (1-3% of portfolio max) and tight stops. Often appears when one strong signal (fundamentals) is offset by weaker signals elsewhere. Wait for confirmation before adding.",
  },

  hold: {
    term: "HOLD",
    category: "recommendation",
    short: "No clear edge — neutral on entry, neutral on exit.",
    full: "Combined score 47–52. The signals are mixed or weak in both directions. Don't initiate new positions, but no urgency to exit existing ones either. Wait for one dimension to break the tie. For existing holdings, focus on your cost basis and position size rather than the rating.",
  },

  weak_sell: {
    term: "WEAK SELL",
    category: "recommendation",
    short: "Mildly negative — consider trimming, set a stop-loss.",
    full: "Combined score 38–46. Some signals are deteriorating but it's not a thesis break. Trim oversized positions, set stop-losses on remaining holdings. Not an emergency exit signal, but a 'reduce risk' signal.",
  },

  sell: {
    term: "SELL",
    category: "recommendation",
    short: "Bearish across multiple dimensions — exit the position.",
    full: "Combined score 25–37. Signals are clearly negative. Reduce exposure soon. Holding through a bearish setup is one of the most common ways analysts lose money — discipline matters more than conviction.",
  },

  strong_sell: {
    term: "STRONG SELL",
    category: "recommendation",
    short: "All signals bearish — significant downside risk.",
    full: "Combined score below 25. Heavy bearish confluence across every dimension. Exit immediately. These setups frequently precede 15-30% drawdowns. The cost of being wrong (missing a bounce) is much smaller than the cost of being right and not acting.",
  },

  combined_score: {
    term: "Combined Score",
    category: "technical",
    short: "Weighted blend of technical, news sentiment, and fundamental scores (0–100).",
    full: "Starbhai's headline scoring metric. Default weights: 40% technical + 20% news + 25% fundamentals + macro tilt. When a dimension is missing (e.g. new IPO with no fundamentals), its weight is redistributed and the recommendation strength is automatically downgraded. The score itself is just a ranking aid — always read the underlying reasoning.",
  },

  data_confidence: {
    term: "Data Confidence",
    category: "technical",
    short: "How many signal dimensions contributed: HIGH (3) / MEDIUM (2) / LOW (1).",
    full: "When all 3 dimensions (technical, news, fundamentals) contribute, confidence is HIGH and full recommendation strength is allowed. With only 2 dimensions, STRONG ratings are downgraded to BUY/SELL. With only 1 dimension, the recommendation is capped at WEAK BUY/WEAK SELL with explicit warnings. Low confidence means 'this is a hint, not a trade signal'.",
  },

  // ══════════════════════════════════════════════════════════════════════
  // MACRO REGIME
  // ══════════════════════════════════════════════════════════════════════

  macro_regime: {
    term: "Macro Regime",
    category: "macro",
    short: "Dominant macroeconomic theme classified by AI from trusted news headlines.",
    full: "Starbhai reads ~60 headlines per refresh from RBI, SEBI, Reuters, Bloomberg, FT, ET, LiveMint and others, then asks GPT-5.4 to identify the single dominant theme: WAR_ESCALATION, OIL_SHOCK, RATE_HIKE, RATE_CUT, POLICY_STIMULUS, CALM, and others. The classification produces severity (1–5), confidence (0–100%), and per-sector impact tilts that flow into every scanner ranking.",
  },

  oil_shock: {
    term: "OIL SHOCK Regime",
    category: "macro",
    short: "Crude prices spiking — pressures inflation, INR, and risk assets.",
    full: "Triggered by supply disruptions (Hormuz blockade, OPEC cuts, geopolitical events). Sectors that benefit: upstream oil & gas producers (ONGC, BPCL, Oil India). Sectors that suffer: aviation (fuel costs), automobile (demand), chemicals (feedstock costs), banks (yield rise tempers rate-cut hopes). The intensity of the tilt scales with severity × confidence.",
  },

  war_escalation: {
    term: "WAR ESCALATION Regime",
    category: "macro",
    short: "Active geopolitical conflict affecting risk assets.",
    full: "Defence stocks (HAL, BEL, BDL) rally on increased orderbook expectations. Energy and gold typically benefit from safe-haven flows. Aviation, tourism, and discretionary consumption suffer. India-specific war risks also pressure FII flows and the rupee. Starbhai amplifies the per-sector tilts when severity is 4 or 5.",
  },

  rate_hike: {
    term: "RATE HIKE Regime",
    category: "macro",
    short: "Central bank tightening — bond yields rise, rate-sensitive sectors feel pressure.",
    full: "RBI or Fed hawkishness. Banks initially benefit from higher net interest margins, but eventually loan growth slows. NBFCs and housing finance get hit hardest (funding cost rises, credit demand falls). IT services historically benefit from a stronger USD when the Fed hikes. Real estate and high-multiple growth stocks underperform.",
  },

  rate_cut: {
    term: "RATE CUT Regime",
    category: "macro",
    short: "Central bank easing — risk-on environment, growth stocks rally.",
    full: "Lower rates drive risk-on flows into equities. NBFCs, housing finance, real estate, and high-growth IT all benefit. Banks see net interest margins compress but loan growth picks up. Fixed-income holders lose. The trade is to rotate from defensives into rate-sensitives ahead of the cut, not after.",
  },

  policy_stimulus: {
    term: "POLICY STIMULUS Regime",
    category: "macro",
    short: "Government spending boost — infra, capital goods, defence benefit.",
    full: "Triggered by Union Budget announcements, PLI scheme expansions, infra capex push. Capital goods (L&T, Siemens), cement (UltraTech, Ambuja), infrastructure (NCC, IRB), and defence (HAL, BEL) typically benefit. Watch out for FII outflow risks if stimulus is debt-funded and pressures fiscal deficit.",
  },

  calm: {
    term: "CALM Regime",
    category: "macro",
    short: "No dominant macro theme — neutral environment, signals come from individual stocks.",
    full: "When there's no major geopolitical or policy event in the last 48h of headlines, the regime classifier returns CALM with severity 1. Sector tilts are zero. Buy Now scanner picks are driven purely by per-stock technicals and fundamentals. The macro banner stays hidden in this regime so the UI doesn't shout when there's nothing to shout about.",
  },

  macro_headwind: {
    term: "Macro Headwind",
    category: "macro",
    short: "Current regime is unfavourable for this sector — score is being penalised.",
    full: "Shown when the sector has a negative impact (-2 or worse) under the active regime. Example: during OIL SHOCK, aviation gets a -3 headwind because rising fuel costs compress airline margins. The penalty reduces the stock's Buy Now score, which can knock it out of the top 10 picks. For small-caps, the penalty is amplified 1.3× because small-caps are more macro-sensitive.",
  },

  macro_tailwind: {
    term: "Macro Tailwind",
    category: "macro",
    short: "Current regime is favourable for this sector — score is being boosted.",
    full: "Shown when the sector has a positive impact (+2 or better) under the active regime. Example: during WAR ESCALATION, defence gets a +3 tailwind. The boost increases the stock's Buy Now score and rank. For portfolio holdings, a tailwind on a HOLD-rated stock can promote it to ADD.",
  },

  // ══════════════════════════════════════════════════════════════════════
  // TRACK RECORD
  // ══════════════════════════════════════════════════════════════════════

  win_rate: {
    term: "Win Rate",
    category: "track",
    short: "Percentage of paper-trade picks that finished with a positive return.",
    full: "A win rate above 55% over a meaningful sample (50+ picks) is solid for a long-only momentum strategy. 60-65% is excellent. Above 70% is suspicious — usually means the sample is too small or biased toward stocks that always go up. Win rate alone doesn't tell you if the strategy is profitable; you also need average win size vs average loss size.",
  },

  beats_nifty: {
    term: "Beats Nifty Rate",
    category: "track",
    short: "% of picks that outperformed the Nifty 50 over the same holding period.",
    full: "The single most important metric on this tab. If Starbhai's picks beat the Nifty 60% of the time, the platform is generating real alpha (not just riding a bull market). 50% beats-Nifty rate is no better than buying the index. Below 50% means the platform is structurally underperforming and the signals need rework. Aim for ≥55% over 30+ days.",
  },

  alpha: {
    term: "Alpha",
    category: "track",
    short: "Excess return vs the Nifty benchmark over the same period.",
    full: "If a stock returned +8% in 14 days while the Nifty returned +3%, the alpha is +5%. Positive alpha = the pick outperformed the index. Negative alpha = the pick underperformed even if it went up. Average alpha across all picks is the cleanest measure of whether Starbhai adds value above just buying an index fund.",
  },

  forward_return: {
    term: "Forward Return",
    category: "track",
    short: "% change from snapshot price (when Starbhai picked it) to current price.",
    full: "Calculated as (current price ÷ snapshot price - 1) × 100. Positive = the pick worked. Negative = the pick lost money. Days held shows how long it's been since the snapshot. Returns become statistically meaningful after ~7 days for momentum picks and ~30 days for fundamental picks.",
  },

  // ══════════════════════════════════════════════════════════════════════
  // PORTFOLIO ACTIONS
  // ══════════════════════════════════════════════════════════════════════

  cut_loss: {
    term: "CUT LOSS",
    category: "portfolio",
    short: "Position is broken — exit and redeploy capital elsewhere.",
    full: "Triggered when P&L is below -25% AND the combined score is weak (no recovery catalyst). Three severity tiers: Tier 1 (>-40% loss) is unconditional regardless of signals. Tier 2 (>-30% loss) is CUT LOSS unless signals are strongly bullish. Tier 3 (>-25% loss) is CUT LOSS if score is weak or fundamentals are expensive. Cutting losses is the hardest discipline in investing — but holding broken stocks in hope of recovery is how analysts blow up.",
  },

  trim: {
    term: "TRIM",
    category: "portfolio",
    short: "Position is over-concentrated — reduce to a manageable size.",
    full: "Triggered when a single stock exceeds 15% of your invested capital. Concentration is the #1 risk in retail portfolios. A single bad earnings call can wipe out months of gains. Trim back to 10-12% to free up capital and reduce single-stock risk. If you're in profit, trimming also locks in gains.",
  },

  strong_add: {
    term: "STRONG ADD",
    category: "portfolio",
    short: "Textbook average-down setup — fundamentals deeply undervalued + technicals confirming.",
    full: "Triggered when you're down 10%+ on a stock that Starbhai now rates as DEEP_VALUE with combined score 70+. Means the market has handed you a discount on a quality company. Add aggressively (within position limits) to lower your average cost. Rare — typically 0-2 holdings at any time.",
  },

  add: {
    term: "ADD",
    category: "portfolio",
    short: "Average-down opportunity — down from entry but thesis intact.",
    full: "Triggered when you're down 5%+ on a stock with combined score 60+ and fundamentals rated DEEP_VALUE or QUALITY_GROWTH. Less aggressive than STRONG ADD — adds smaller increments to existing positions where the thesis is still intact. Good for systematically lowering cost basis on long-term holdings.",
  },

  book_profit: {
    term: "BOOK PROFIT",
    category: "portfolio",
    short: "Up significantly with momentum cooling — lock in gains while you can.",
    full: "Triggered when you're up 50%+ and the combined score is fading (under 65). Sell 30-50% of the position to lock in gains while letting the rest run. The hardest psychological move in investing — most analysts hold winners too long and end up giving back gains. Booking partial profit on big winners is the cleanest way to compound returns over years.",
  },

  recovery_math: {
    term: "Recovery Math",
    category: "portfolio",
    short: "% upside needed for a losing position to break even.",
    full: "If you're down 30%, you need a +43% gain to break even (because you're recovering from a smaller base). Down 50% requires +100%. Down 70% requires +233%. The math punishes deep losses asymmetrically — which is why cutting losses early matters so much. Includes a heuristic recovery probability based on 52-week range position and drawdown magnitude.",
  },

  position_weight: {
    term: "Position Weight",
    category: "portfolio",
    short: "What % of your invested capital this single stock represents.",
    full: "Above 15% is concentration risk (TRIM territory). 10-15% is acceptable for high-conviction holdings. 5-10% is the typical sweet spot for diversified portfolios. Below 2% probably isn't worth tracking — either size up or close it. Tracked using your invested value (not current value), so market moves don't artificially shift the weights.",
  },

  health_score: {
    term: "Portfolio Health Score",
    category: "portfolio",
    short: "Aggregate score 0–100 reflecting overall portfolio quality and risk.",
    full: "Built from 7 components: Quality (avg holding score), Diversification (sector spread), Concentration penalty, Loss ratio penalty, Valuation penalty (overvalued count), Profit ratio bonus, and Macro Exposure. Above 80 = HEALTHY. 65-79 = GOOD. 50-64 = NEEDS_ATTENTION. Below 50 = AT_RISK. Most retail portfolios land in the NEEDS_ATTENTION band — concentration and overvaluation are the usual culprits.",
  },

  macro_exposure: {
    term: "Macro Exposure",
    category: "portfolio",
    short: "Weight-averaged macro tilt across all your holdings (-10 to +10).",
    full: "Tells you whether your portfolio is positioned WITH the current macro regime or AGAINST it. Positive = your sector mix benefits from the current regime (tailwind). Negative = your sectors are fighting the regime (headwind). A portfolio at -8 during OIL_SHOCK is heavily exposed to aviation, autos, and chemicals — sectors that suffer when crude spikes. Use this as an early-warning rebalancing signal.",
  },

  // ══════════════════════════════════════════════════════════════════════
  // SWS PICKS — metrics, pillars, verdicts (v3 scoring engine)
  // ══════════════════════════════════════════════════════════════════════

  snowflake_score: {
    term: "Snowflake Score",
    category: "fundamental",
    short: "Simply Wall Street's 6-pillar 0–30 visual rating — the 'shape' of the snowflake.",
    full: "Aggregates Value, Future, Past, Health, Dividend, and Past-vs-Industry into a single 0–30 score (each pillar 0–6, except Position-vs-Industry which adds variation). 22+ is the high-quality band. The shape matters as much as the score: a 20 with all pillars at 3-4 is a balanced compounder, while a 20 with Health=6 + Future=0 is a cash cow with no growth runway. Always look at the pillar breakdown alongside the headline number.",
  },

  v4_composite_score: {
    term: "Composite Score",
    category: "fundamental",
    short: "Starbhai's 0–100 score: 76 pillars + 12 fair-value + 12 momentum − 15 safety overlay.",
    full: "Built from three blocks. Pillars (76 points): Health 22 · Future 20 · Valuation 18 · Past 16 — a deliberate quality-value tilt (cheap AND a proven track record); the dividend pillar is dropped because yield doesn't predict total return. Fair value (12 points): a coverage-renormalised composite of analyst-upside (with a guard against single-analyst-max inflation) + price-to-earnings vs the industry, instead of a single bucketed upside. Momentum (12 points): 1Y / 3M / 1M price trend. A safety overlay (−15 points) then penalises NSE ASM/GSM flags, declining revenue, and value-trap structure. Verdicts use ABSOLUTE cutoffs: ≥ 59 = TOP_PICK, ≥ 47 = STRONG, ≥ 37 = ACCEPTABLE, ≥ 28 = WATCH, < 28 = AVOID — a stock's label depends only on its own number, not where the rest of the universe sits.",
  },

  analyst_fair_value: {
    term: "Fair Value (Analyst Consensus)",
    category: "fundamental",
    short: "Median sell-side price target aggregated by SWS — what the Street thinks the stock is worth.",
    full: "Pulled live from SWS's AnalystConsensus block, which aggregates target prices from covering brokerages. Treat it as a sentiment indicator, not gospel — analyst targets cluster, lag price moves, and reflect 12-month views, not entry timing. A 20%+ upside to FV with strong Snowflake = genuine valuation gap. A 50%+ upside on a battered stock with falling earnings = the targets haven't caught down yet. Always cross-check FV against the SWS DCF if available.",
  },

  upside_pct: {
    term: "Upside %",
    category: "fundamental",
    short: "(Fair Value − Current Price) ÷ Current Price — room to run before consensus says 'fair'.",
    full: "Direct math: if Px=₹100 and FV=₹130, upside is +30%. Positive = trading at a discount to consensus FV. Negative = trading above consensus FV (fully-valued or richer). For DEEP VALUE picks, look for ≥ 20% with confirming Snowflake. For QUALITY GROWTH, ≥ 10% is enough — you're paying for compounding, not a re-rating. Negative upside on a high-quality compounder isn't necessarily a sell; it just means no margin of safety on the entry.",
  },

  valuation_pillar: {
    term: "Valuation Pillar (SWS)",
    category: "fundamental",
    short: "0–6 score: how cheap the stock is vs DCF, peers, and analyst targets.",
    full: "Built from Price-to-DCF (heaviest weight), peer P/E ratio, and discount to analyst FV. 5–6 = clearly cheap; 3–4 = fair; 0–2 = expensive. The Deep Value section requires ≥ 4 paired with ≥ 20% upside. Use this for the 'how cheap' question — pair it with the Health pillar to avoid value traps (cheap-and-broken).",
  },

  future_growth_pillar: {
    term: "Future Growth Pillar (SWS)",
    category: "fundamental",
    short: "0–6 score: expected forward earnings + revenue growth vs market and sector.",
    full: "Driven by analyst estimates of 1Y / 3Y forward earnings growth, normalised against the broader market. 5–6 = top-decile growth runway (Future-pillar leaders are usually IT, specialty chems, new-economy names). 3–4 = above market. 0–2 = no growth or shrinkage expected. Quality Growth section requires ≥ 4. Pair with Past pillar — strong Future + weak Past means the growth story is unproven.",
  },

  health_pillar: {
    term: "Financial Health Pillar (SWS)",
    category: "fundamental",
    short: "0–6 score: balance-sheet strength — debt, cash cover, interest cover.",
    full: "Captures debt-to-equity, debt-to-EBITDA, interest coverage ratio, and short-term liquidity. 5–6 = fortress balance sheet (net cash or trivial leverage). 3–4 = manageable debt with comfortable interest cover. 0–2 = leverage that can become a problem in a downturn. Quality Growth section requires ≥ 5 — for a long-term hold, the balance sheet must survive the next cycle, not just this quarter.",
  },

  dividend_pillar: {
    term: "Dividend Pillar (SWS)",
    category: "fundamental",
    short: "0–6 score: yield + payout sustainability + dividend track record.",
    full: "Combines current yield, payout ratio (lower is more sustainable), and history of stable or growing payouts. 5–6 = aristocrat-grade (consistent payer, payout < 70%, yield ≥ 1.5%). 3–4 = pays dividends but either yield is small or coverage is thin. 0–2 = no meaningful dividend. The Dividend Aristocrats section requires ≥ 5 + payout < 70% — high yield with payout > 90% is usually a yield trap (next dividend cut is a matter of when, not if).",
  },

  nse_surveillance: {
    term: "NSE Surveillance Flag",
    category: "fundamental",
    short: "ASM / GSM / TT placement on NSE — a regulatory speed-bump signalling unusual activity.",
    full: "ASM (Additional Surveillance Measure) and GSM (Graded Surveillance Measure) are NSE's mechanisms to slow trading in stocks showing unusual price/volume patterns or weak fundamentals. ASM Stage 1–4 escalates from price-band tightening to 100% margin and trade-to-trade settlement. GSM Stage 1–6 escalates similarly with stricter constraints. TT (Trade-to-Trade) requires every trade to settle by delivery — no intraday squaring. A surveillance flag isn't a verdict, but it's a flag worth respecting: SEBI/NSE saw enough to act. The v3 safety overlay applies up to −15 points based on stage.",
  },

  last_quarter_result: {
    term: "Last Quarter Result · BEAT / MISS / INLINE",
    category: "fundamental",
    short: "How the most recent quarter's reported EPS landed against the consensus estimate.",
    full: "BEAT = reported EPS at least 2% above consensus estimate. MISS = at least 2% below. INLINE = within ±2%. Sourced from Yahoo Finance earningsHistory and refreshed as part of every SWS pipeline run. A confirmed BEAT going into the next earnings window contributes +3 to the v2/v3 catalyst bonus when next earnings are within 30 days; INLINE and MISS contribute zero. The badge is hidden when the company has no earnings history (recent IPO), when EPS estimate or actual is missing for the latest quarter, or when the most recently reported quarter is older than 180 days (annual reporters or stale Yahoo coverage). Treat the badge as context, not a directive — a beat-after-beat-after-miss pattern is a different signal than a single beat.",
  },

  v3_top_pick: {
    term: "TOP PICK",
    category: "verdict",
    short: "Composite ≥ 59 — top-decile fundamentals + clean safety profile.",
    full: "The highest tier. Strong on at least 3 of the 4 SWS pillars (Health/Future/Valuation/Past) AND clean on safety (no ASM/GSM, no value-trap structure). Roughly the top ~8% of the scored universe. Suitable as core holdings — but TOP_PICK doesn't override valuation: if upside-to-FV is negative, treat it as a high-quality compounder at full price, not a fresh entry.",
  },

  v3_strong: {
    term: "STRONG",
    category: "verdict",
    short: "Composite 47–58 — solid quality, minor blemish on one dimension.",
    full: "Either fundamentals are strong but the safety overlay shaved a few points (low-stage surveillance, value-trap brake) or fundamentals are very strong on 2 pillars but average on the others. Good initiation candidates with normal position sizing. Roughly the next 15–20% of the universe after TOP_PICK.",
  },

  v3_acceptable: {
    term: "ACCEPTABLE",
    category: "verdict",
    short: "Composite 37–46 — middle of the pack, no clear edge.",
    full: "Neither cheap nor expensive, neither high-growth nor declining. The bulk of the universe lands here. For Acceptable stocks, the entry decision should be driven by sector view and technicals, not the composite score — the score is just saying 'no fundamental red flags, no green flags either'. Smaller starter positions only.",
  },

  v3_watch: {
    term: "WATCH",
    category: "verdict",
    short: "Composite 28–36 — one or more weak signals; not actionable today.",
    full: "Either fundamentals are below average on multiple pillars, or the safety overlay has docked points. WATCH means 'don't initiate, but worth monitoring' — sometimes a turnaround starts here before it shows up in the headline score. Existing holdings should be reviewed: if the deterioration is structural, trim; if cyclical, hold with a stop.",
  },

  v3_avoid: {
    term: "AVOID",
    category: "verdict",
    short: "Composite < 28 — bottom-quartile fundamentals + meaningful safety risk.",
    full: "Combination of weak pillars (low Health or Future), bearish momentum, and active safety penalties (ASM/GSM placement, value-trap structure). The AVOID list exists explicitly to keep these out of buy categories — high downside, limited upside, regulatory friction. Existing positions should be reviewed for exit on next strength.",
  },

  // ══════════════════════════════════════════════════════════════════════
  // SWS PICKS — section criteria
  // ══════════════════════════════════════════════════════════════════════

  section_top_ranked_30: {
    term: "Top 30 — Multi-Factor Score",
    category: "verdict",
    short: "The 30 highest composite scores in the universe (mcap ≥ ₹500cr).",
    full: "Pure ranking — the top 30 by composite score across the entire scanned universe, gated to ≥ 50% data coverage on every input (no thin-data inflations) and market cap ≥ ₹500cr (no micro-caps where the underlying SWS data is sparse). This is the section to start every session with — the universe-wide best of class.",
  },

  section_best_to_buy_now: {
    term: "Best Stocks to Buy Now",
    category: "verdict",
    short: "Top by composite score with no major risks + Snowflake ≥ 18/30.",
    full: "Tighter cut than Top-30 — adds a Snowflake floor (18/30 = solid pillar coverage) and explicitly excludes any stock with a major risk flag (high payout, declining revenue, ASM/GSM stage 3+). The Top-30 may include 'great score but watch the leverage' names; this list aims for 'safe to initiate today'. Use this for fresh capital deployment.",
  },

  section_deep_value: {
    term: "Deep Value (section)",
    category: "verdict",
    short: "TOP_PICK + Valuation pillar ≥ 4/6 + AnalystConsensus upside ≥ 20%.",
    full: "Stocks that are both high-quality (TOP_PICK on v3) AND visibly cheap (Valuation pillar 4+ and at least 20% upside to consensus FV). The combination is the point — cheap-only without quality is the value-trap zone. Typical hold period 12–24 months while the multiple re-rates. Smaller bucket than Quality Growth because the dual filter is strict.",
  },

	  section_growing_sector_value: {
	    term: "Growing Sector Value Stocks",
	    category: "verdict",
	    short: "HIGH-confidence FV upside ≥ 25%, positive sector context, and SWS Future Growth ≥ 4/6.",
	    full: "This experimental section cross-checks stock-level SWS valuation and forward runway against the platform's Sector Outlook. A stock needs market cap ≥ ₹500cr, V4 score ≥47, HIGH-confidence fair value data, at least 25% upside to SWS AnalystConsensus FV, SWS Future Growth ≥ 4/6, and a mapped sector whose 3-12m outlook is TAILWIND or STRONG_TAILWIND with non-low confidence. If no strict Future Growth ≥ 4/6 candidates pass, a clearly labelled ≥ 3/6 fallback can appear. When Sector Outlook is stale or generated under a different macro regime, the section can show a clearly labelled current-macro fallback from positive macro sector impacts only; stale Sector Outlook tailwind badges are not reused. The 30%+ discount badge is informational only; it does not boost ranking.",
	  },

  section_quality_growth: {
    term: "Quality Growth (section)",
    category: "verdict",
    short: "TOP_PICK or STRONG + Health ≥ 5/6 + Future-Growth ≥ 4/6.",
    full: "Compounders: balance-sheet fortress (Health ≥ 5) plus a clear forward growth runway (Future-Growth ≥ 4). Pays a premium to enter and isn't the cheapest section, but the durability is the trade. The Health gate is what keeps this list from drifting into highly-leveraged 'growth' names that crack in downturns. Hold periods often multi-year.",
  },

  section_midterm: {
    term: "Midterm Picks (3–12 months)",
    category: "verdict",
    short: "ACCEPTABLE+ + positive 1Y or 3M momentum + upside ≥ 15% + Future-Growth ≥ 3.",
    full: "Trend-following bucket: stocks that already have momentum on their side (positive 1Y or 3M return) AND remaining upside (≥ 15% to consensus FV) AND a credible growth story (Future-Growth ≥ 3). Lower quality bar than Quality Growth (ACCEPTABLE+ instead of STRONG+) because the trade is shorter — you're riding momentum, not betting on a multi-year compounder.",
  },

  section_dividend_aristocrats: {
    term: "Dividend Aristocrats (section)",
    category: "verdict",
    short: "Dividend pillar ≥ 5/6 + payout < 70% + trailing yield ≥ 1.5%.",
    full: "Sustainability-first dividend list: high pillar score (5+ means consistent payer with reasonable yield) AND payout under 70% (room to absorb a bad year without cutting) AND trailing yield ≥ 1.5% (otherwise the dividend isn't material to total return). The payout gate is critical — yield-screen lists without it are full of stocks one bad quarter away from a cut.",
  },

  section_smallcap_gems: {
    term: "Smallcap/Midcap Hidden Gems",
    category: "verdict",
    short: "Mcap < ₹50,000cr + Snowflake ≥ 22/30 + AnalystConsensus upside ≥ 15%.",
    full: "Smaller-cap quality: market cap below the large-cap threshold AND a high Snowflake (22+/30 = strong on 4+ pillars) AND visible upside (≥ 15% to consensus). The Snowflake gate is what separates this from a generic 'small-cap' screen — most small-caps have weak Health or Future pillars; the few that score 22+ are the genuine compounders that simply haven't been discovered yet. Sized smaller than large-cap holdings due to liquidity and volatility.",
  },

  section_insider_buying: {
    term: "Insider Buying",
    category: "verdict",
    short: "Material insider/MD buy in last 90 days. (Field not yet captured.)",
    full: "Tracks recent open-market purchases by promoters, MDs, or other insiders — historically one of the strongest single-factor signals for forward returns. Insiders selling can mean anything (diversification, taxes), but insiders BUYING almost always means they expect the price to be higher. Section is currently empty pending insider-transaction capture in the deep-scrape pipeline.",
  },

  section_upcoming_earnings: {
    term: "Upcoming Earnings (next 75 days)",
    category: "verdict",
    short: "Stocks with results due in the next 75 days, sorted by date.",
    full: "Catalyst calendar: every stock with an earnings date in the next ~75 days, sorted by proximity. Earnings are the single biggest scheduled price-mover for a stock — a beat on a high-quality name is often a 5–10% gap up; a miss on a richly-valued name is often a 10–20% gap down. Use this section to (a) avoid initiating on names reporting tomorrow, and (b) spot pre-results setups on high-conviction holdings.",
  },

  // ══════════════════════════════════════════════════════════════════════
  // PORTFOLIO RISK METRICS — added for the V2 analyzer UI
  // ══════════════════════════════════════════════════════════════════════

  beta_metric: {
    term: "Beta · Market Sensitivity",
    category: "portfolio",
    short: "How much your stock or book moves vs the market — 1.0 = moves 1-for-1 with Nifty.",
    full: "Beta measures how strongly a stock or portfolio moves with the broader market (Nifty 50 here). Beta of 1.0 means the position moves in lockstep with the index. Beta of 1.4 means a 10% Nifty drop typically pulls the position down ~14%; beta of 0.7 means it only falls ~7%. Defensive sectors (FMCG, Pharma) often run below 1.0; cyclicals (NBFCs, Metals, Real Estate) above 1.2. Use weighted-portfolio beta to size your exposure to broad market shocks — it's the single best predictor of how a -20% Nifty event would translate to your book.",
  },

  volatility: {
    term: "Volatility · Annualised Standard Deviation",
    category: "portfolio",
    short: "How wide the swings are — higher = bumpier ride. Annualised so it's comparable across stocks.",
    full: "Annualised volatility takes the standard deviation of daily returns and scales it to a yearly number (×√252). Nifty 50 typically runs 15–20% annualised; a single midcap can run 35–50%; a smallcap 50%+. Volatility is direction-agnostic — it tells you the SIZE of typical moves, not which way. Higher vol means a bigger range of plausible outcomes over any given holding period. Pairs with beta: a stock can be high-vol but low-beta if its swings aren't correlated with the index.",
  },

  sharpe: {
    term: "Sharpe Ratio",
    category: "portfolio",
    short: "Return earned per unit of risk taken. Above 1 is good, above 2 is excellent.",
    full: "Sharpe ratio is (return − risk-free rate) / volatility. Indian markets typically use the 10y G-Sec yield (~6.5%) as the risk-free baseline. A Sharpe of 0.5 is mediocre; 1.0 is solid; above 1.5 is rare and usually means the metric is computed over a regime-favourable window. Negative Sharpe means the portfolio underperformed the risk-free rate per unit of risk taken — you'd have been better off in fixed income. Always check the sample window — Sharpe can flip dramatically across bull and bear cycles.",
  },

  var95: {
    term: "Value-at-Risk (95% daily)",
    category: "portfolio",
    short: "The loss you'd expect on a typical bad day — once every 20 trading days, the daily drop is bigger than this.",
    full: "Historical VaR at 95% confidence is the 5th-percentile daily return — the loss you'd see (or worse) on roughly one trading day in twenty. A VaR95 of −2.5% means most days you lose less, but one day in twenty you lose ≥2.5%. VaR is NOT a worst-case — by definition, the other 5% of days are worse, sometimes much worse (the 'tail'). For tail risk, look at Expected Shortfall (CVaR) or stress-test scenarios. VaR is most useful as a sanity check on day-to-day exposure: if your VaR is bigger than you can stomach, the position is too large.",
  },

  max_drawdown: {
    term: "Max Drawdown",
    category: "portfolio",
    short: "The worst peak-to-trough fall over the last year. Tells you how deep the worst dip got.",
    full: "Max drawdown is the largest cumulative drop from any peak to a subsequent trough over the measurement window. It captures the WORST stretch of pain you'd have lived through if you held the full period. Indian midcaps typically show max drawdowns of 25–40% even in 'normal' years; Nifty 50 sees 15–25%. Plan to live through at least max drawdown again — historical data is conservative on tail risk because samples are limited. If your psychological tolerance is below max-DD, the position is too big.",
  },

  pairwise_correlation: {
    term: "Pairwise Correlation",
    category: "portfolio",
    short: "How together your stocks move. 1 = lockstep (no diversification). 0 = independent.",
    full: "Average pairwise correlation across all stocks in the portfolio. Correlation of 1.0 means every name moves together — diversification is illusory, you effectively own one bet. 0.0 means stocks move independently. Indian large-caps typically show correlations of 0.5–0.7 because they share Nifty exposure. Below 0.3 is genuinely diversified; above 0.7 is concentration risk hiding inside a multi-stock book. Note: correlations spike toward 1.0 in panics — diversification is most valuable in calm markets, least valuable in crises.",
  },

  // ══════════════════════════════════════════════════════════════════════
  // RISK LAB — verdict overrides + quality verdicts + veto markers
  // ══════════════════════════════════════════════════════════════════════
  // The Risk Lab is an EXPERIMENTAL overlay viewer. It does NOT change
  // production picks; it shows what an alternate scoring approach would
  // say. Read every entry below as "research hypothesis," not "verdict."

  quality_hold: {
    term: "Quality Hold",
    category: "verdict",
    short: "Lab override: this TOP_PICK has 3+ quality red flags totalling ≥ 7 points of penalty.",
    full: "The Quality Lens flips a production TOP_PICK to QUALITY_HOLD when it finds three or more independent quality red flags AND those flags sum to a ≥ 7-point penalty. Treat it as 'do more homework before trusting the production score,' not 'sell now.' The Risk Lab is experimental and its hit-rate isn't validated yet — false positives are possible. Click the chips in the row to see which specific flags fired.",
  },

  macro_hold: {
    term: "Macro Hold",
    category: "verdict",
    short: "Lab override: regime severity is extreme AND the stock's sector takes a heavy hit.",
    full: "The Macro Lens flips a production TOP_PICK to MACRO_HOLD when the current macro regime is at severity ≥ 4 AND the stock's sector impact is ≤ −3. Used during regimes like OIL_SHOCK or CURRENCY_WEAKNESS where a sector-wide drag overwhelms stock-specific positives. Experimental — read as 'macro headwind is severe enough that the production thesis may not hold,' not as a sell signal.",
  },

  risk_hold: {
    term: "Risk Hold",
    category: "verdict",
    short: "Lab override: BOTH macro and quality vetoes fire on the same TOP_PICK.",
    full: "Appears on the Combined view when a stock triggers both the Macro Veto AND the Quality Veto — the production score has both regime risk AND fundamental quality concerns. The strongest disagreement the lab can register. Still experimental — the canonical KEC case (−11% surprise miss on a TOP_PICK that scored 80) is the one validated win so far.",
  },

  quality_high: {
    term: "Quality Verdict — HIGH",
    category: "verdict",
    short: "Zero quality red flags fired on this stock.",
    full: "The Quality Lens scans SWS risks[] and news[] for five categories of red flags (consecutive earnings miss, imputed scoring, weak coverage ratios, counter-thesis triggers, sector overlays). HIGH means none fired. This does NOT mean the stock is a buy — production scoring may still rate it low. It means the LAB has no quality-side objection to whatever production decided.",
  },

  quality_medium: {
    term: "Quality Verdict — MEDIUM",
    category: "verdict",
    short: "1–2 quality flags fired. Worth a glance, not a HOLD.",
    full: "MEDIUM means the Quality Lens found one or two red flags but the penalty wasn't heavy enough to trigger a veto. Check the chip list to see which fired — a single 'imputation_inflation' flag is mild noise; a 'consecutive_miss' alone is more concerning. Use this as a data point alongside the production score, not as a sell signal.",
  },

  quality_low: {
    term: "Quality Verdict — LOW",
    category: "verdict",
    short: "3+ quality flags fired. Material concerns regardless of veto status.",
    full: "LOW means three or more quality flags hit on the same stock. The veto only fires if the penalty is also ≥ 7 points AND the original verdict was TOP_PICK, but LOW alone is a signal the lab is uneasy. Read the chips. Persistent LOW on a position you're sized into deserves a closer look — even if the production score is high.",
  },

  quality_insufficient_data: {
    term: "Quality Verdict — INSUFFICIENT_DATA",
    category: "verdict",
    short: "No SWS risks[] AND no news[] to evaluate. Lab can't form a quality view.",
    full: "Means the SWS deep brief had no risk items and no news items, so the Quality Lens has nothing to read. Common for less-covered small caps. Doesn't mean the stock is safe; it means the lab can't help. Fall back to the production score or your own research.",
  },

  macro_veto: {
    term: "Macro Veto",
    category: "verdict",
    short: "TOP_PICK demoted because the current macro regime is severe AND the sector takes a hit.",
    full: "Fires only on TOP_PICKs. Conditions: macro regime severity ≥ 4 (extreme) AND the stock's sector impact under that regime ≤ −3 (heavy headwind). When both hit, the adjusted verdict becomes MACRO_HOLD and a red MACRO VETO chip appears. The lab is saying 'the production thesis was built on calmer conditions than we have now.' Still experimental — does not affect production picks.",
  },

  quality_veto: {
    term: "Quality Veto",
    category: "verdict",
    short: "TOP_PICK demoted because 3+ red flags fired AND the score penalty is ≥ 7 points.",
    full: "Fires only on TOP_PICKs. The Quality Lens needs to find three or more independent quality red flags (consecutive miss, imputed scoring, weak coverage, counter-thesis, sector overlay) AND those flags must sum to at least a 7-point penalty. When both conditions hit, the adjusted verdict becomes QUALITY_HOLD. Read as 'lab disagrees with the production TOP_PICK rating' — not as a sell. The canonical win is KEC (May 2026) where the lab would have caught a −11% surprise miss production rated as BEAT.",
  },

  // ══════════════════════════════════════════════════════════════════════
  // RISK LAB — quality flag categories (the chips in Reason / Flags column)
  // ══════════════════════════════════════════════════════════════════════

  flag_consecutive_miss: {
    term: "Flag · Consecutive Miss",
    category: "fundamental",
    short: "Detected via SWS news that this company missed earnings in a recent prior quarter.",
    full: "Parses SWS news[] looking for headlines reporting an earnings miss in the recent past (typically the last 1–2 quarters). Detected misses are a strong signal that consensus estimates are running ahead of operational reality. One miss can be noise; back-to-back misses usually mean estimate cuts are coming. Severity weighting reflects how recent the miss is.",
  },

  flag_imputation_inflation: {
    term: "Flag · Imputation Inflation",
    category: "fundamental",
    short: "Composite score relies on imputed (filled-in) values, not real measurements.",
    full: "When SWS doesn't have an analyst Fair Value or sufficient price history, the composite score backfills from peer data where possible, or neutral assumptions otherwise. The score isn't 'wrong' — it's just less anchored to stock-specific data. Stocks heavily reliant on imputed components may be coasting on defaults rather than measured upside.",
  },

  flag_fv_imputed: {
    term: "Flag · Fair Value Imputed",
    category: "fundamental",
    short: "No SWS analyst Fair Value available — upside component was imputed.",
    full: "Specific case of imputation_inflation. The fair-value upside portion of the score was filled from an industry-average FV composite when covered peers existed, or a neutral default otherwise, because no analyst FV was published for this name. Common for thinly-covered stocks. Means: the upside number is an assumption, not an estimate.",
  },

  flag_momentum_imputed: {
    term: "Flag · Momentum Imputed",
    category: "fundamental",
    short: "Sparse price history — momentum percentiles imputed at neutral.",
    full: "When a stock doesn't have enough trading history to compute reliable momentum percentiles (e.g., recent listings), the momentum component is imputed at neutral. The composite score isn't anchored on real price action. Doesn't mean the business is bad; it means the technical side of the score is guessed.",
  },

  flag_cash_flow_weakness: {
    term: "Flag · Cash Flow Weakness",
    category: "fundamental",
    short: "SWS risks[] flagged weak or insufficient free cash flow.",
    full: "Pulled from the company's SWS risk list. Means free cash flow is not comfortably covering capex, dividends, or debt service. A single quarter is noise; persistent weakness over multiple periods is the real concern. Cross-check against the cash-flow statement before acting.",
  },

  flag_interest_coverage: {
    term: "Flag · Interest Coverage",
    category: "fundamental",
    short: "SWS risks[] flagged weak interest payment coverage — debt-serviceability risk.",
    full: "Interest coverage ratio (EBIT / interest expense) below comfort thresholds means the company can struggle to pay debt costs from operations. Below 1.5× is concerning, below 1.0× is acute. Particularly serious in rising-rate environments — refinancing risk compounds the problem. Look at the debt schedule alongside this flag.",
  },

  flag_margin_pressure: {
    term: "Flag · Margin Pressure",
    category: "fundamental",
    short: "SWS risks[] or counter-thesis flagged compressing margins.",
    full: "Either the SWS risk list explicitly names margin compression, or the picks counter-thesis specifies margin contraction as a falsification trigger. Margin pressure can come from input-cost inflation, pricing power loss, or product-mix shift. Check whether the pressure is industry-wide (defensible) or company-specific (more alarming).",
  },

  flag_earnings_miss_trigger: {
    term: "Flag · Earnings Miss Trigger",
    category: "fundamental",
    short: "Counter-thesis explicitly names 'next quarterly miss' as a falsification event.",
    full: "Parsed from the picks counter_thesis. Means the original investment thesis explicitly listed a future earnings miss as a condition that would invalidate the call. With the lab having flagged this, the upcoming result becomes a high-stakes data point — a miss is meaningfully bearish, a beat meaningfully bullish.",
  },

  flag_india_risk_trigger: {
    term: "Flag · India Risk Trigger",
    category: "fundamental",
    short: "Counter-thesis or SWS data flags India-specific macro / regulatory risk.",
    full: "Covers India-specific risks: ASM/GSM surveillance categorisation, promoter pledge above thresholds, rupee depreciation exposure, regulatory action on a sector (pharma USFDA, finance NBFC, etc.). Each is a known historical bear catalyst for Indian equities. Severity depends on which specific sub-risk fired.",
  },

  flag_sector_overlay: {
    term: "Flag · Sector Overlay",
    category: "fundamental",
    short: "Sector-specific risk pattern matched (insurance, pharma, auto, etc.).",
    full: "Each sector has known failure modes — insurance has solvency ratios, pharma has FDA letters, auto has inventory cycles, banks have NPA flags. The sector overlay applies a sector-aware filter on top of generic quality signals. Lowest-severity individual flag type; matters when stacked with others.",
  },

  // ══════════════════════════════════════════════════════════════════════
  // RISK LAB — lens names + score columns
  // ══════════════════════════════════════════════════════════════════════

  lens_quality: {
    term: "Quality Lens",
    category: "portfolio",
    short: "Shows stocks with earnings-quality red flags (the KEC-class trap detector).",
    full: "Filters the table to stocks where the Quality Lens fired at least one red flag (or vetoed the production TOP_PICK). Sorted by worst quality_score_delta first. This is the lens the KEC case (May 2026 −11% surprise miss) would have caught — the lab's strongest validated use case so far.",
  },

  lens_macro: {
    term: "Macro Lens",
    category: "portfolio",
    short: "Shows stocks impacted by the current macro regime (oil, currency, rates, etc.).",
    full: "Filters the table to stocks whose macro_score_delta is non-zero under the current regime — i.e. the regime overlay would adjust their score. Sorted by worst macro_score_delta first. Useful during named regimes like OIL_SHOCK or CURRENCY_WEAKNESS; often shows zero matches during CALM.",
  },

  lens_combined: {
    term: "Combined View",
    category: "portfolio",
    short: "Stocks flagged by EITHER the Macro or the Quality lens — the union view.",
    full: "Shows any stock with non-zero macro delta OR at least one quality flag. Sorted by the sum of both deltas (worst first). Use this when you want a single view of every position the lab has any opinion on. The widest filter — typically the largest row count on the tab.",
  },

  lens_thesis: {
    term: "Macro Thesis",
    category: "portfolio",
    short: "A scenario sub-view explaining the current regime and four likely paths forward.",
    full: "Switches from the stock-by-stock table to a thesis viewer: regime explanation, four scenario branches (continue / escalate / de-escalate / new shock) with probability and expected sector winners/losers, position-sizing cap, and upcoming catalysts. SEBI Reg 16 caveats apply — this is research, not advice.",
  },

  col_orig_score: {
    term: "Original Score",
    category: "portfolio",
    short: "The production SWS composite score (V4, 0–100).",
    full: "Production's own number, before any lab adjustments. 0–40 = weak, 40–60 = fair, 60–80 = strong, 80–100 = exceptional. Built from fundamentals, fair-value upside, momentum, and quality pillars. The Risk Lab's deltas adjust THIS number to test alternate scoring approaches.",
  },

  col_macro_delta: {
    term: "Macro Δ (Delta)",
    category: "macro",
    short: "Score adjustment from the macro regime overlay. Range −5 to +5.",
    full: "How much the Macro Lens would add or subtract from the original score under the current regime. Negative = headwind, positive = tailwind. Magnitude depends on regime severity, the stock's sector exposure, and regime confidence. A delta of −2.5 means 'subtract 2.5 points from production's score.' This is a SOFT discount; the hard veto only fires at severity ≥ 4 with sector impact ≤ −3.",
  },

  col_quality_delta: {
    term: "Quality Δ (Delta)",
    category: "macro",
    short: "Score adjustment from quality red flags. Range −10 to 0 (penalty only).",
    full: "Sum of severities for every quality flag that fired on this stock, capped at −10. A delta of −9 means 'subtract 9 points from production's score' — a 65-rated TOP_PICK becomes a 56-rated stock under the lab's view. The cap exists to prevent a stack of small flags from flipping a score by an unrealistic amount.",
  },

  col_combined_delta: {
    term: "Combined Δ (Delta)",
    category: "macro",
    short: "Sum of the Macro Δ and Quality Δ for the same stock. Range roughly −15 to +5.",
    full: "Macro Δ + Quality Δ — used on the Combined view to rank stocks by total lab disagreement with production. Most negative numbers at the top = strongest lab objections to production's score.",
  },

  col_adjusted: {
    term: "Adjusted Verdict",
    category: "portfolio",
    short: "Production's verdict after the lab's adjustments. May flip to a HOLD state.",
    full: "Starts as the production verdict (TOP_PICK / STRONG / ACCEPTABLE / WATCH / AVOID). Flips to QUALITY_HOLD, MACRO_HOLD, or RISK_HOLD when a veto fires. Hover the verdict text for details on each state. Remember: this is the LAB's verdict, not production's.",
  },

  col_reason_flags: {
    term: "Reason / Flags",
    category: "portfolio",
    short: "Chips showing which specific lab signals fired on this stock.",
    full: "Each chip is one quality flag, sector-delta, or veto marker. Colors track severity: red = high, amber = medium, green = positive. Hover any chip for its definition. If you see four+ chips on a single row, the lab has multiple independent concerns — open the SWS deep brief and read carefully.",
  },

  // ══════════════════════════════════════════════════════════════════════
  // RISK LAB — banner statistics
  // ══════════════════════════════════════════════════════════════════════

  lab_total_stocks: {
    term: "Total Stocks (Risk Lab)",
    category: "portfolio",
    short: "Total unique tickers the lab evaluated this run, across all picks sections.",
    full: "Deduplicated count of every ticker that flowed through the lab orchestrator. Different from the picks tab's count — the lab includes both TOP_PICKs and the WATCH / AVOID tail so it can measure relative lab-vs-production drift across the full universe.",
  },

  lab_macro_flagged: {
    term: "Macro Flagged",
    category: "portfolio",
    short: "Stocks where the current macro regime would adjust the score (non-zero macro_score_delta).",
    full: "Count of stocks whose sector exposure under the current regime produces any non-zero adjustment. Excludes stocks the regime overlay doesn't touch. Usually zero during CALM regimes; can be 100s during named regimes like OIL_SHOCK.",
  },

  lab_macro_vetoed: {
    term: "Macro Vetoed",
    category: "portfolio",
    short: "Stocks where the Macro Veto fired (TOP_PICK demoted to MACRO_HOLD).",
    full: "Subset of macro_flagged: only those TOP_PICKs that hit both veto conditions (regime severity ≥ 4 AND sector impact ≤ −3). A non-zero number here means the lab is actively pushing back on production's top calls under the current regime.",
  },

  lab_quality_flagged: {
    term: "Quality Flagged",
    category: "portfolio",
    short: "Stocks with at least one quality red flag fired.",
    full: "Count of stocks where the Quality Lens detected one or more red flags. This is the population the Quality lens shows — typically the largest filter set on the tab. Each flag is independently triggered, so a high count doesn't mean every stock is bad; it means every stock has at least one data-quality or fundamentals concern worth scanning.",
  },

  lab_quality_vetoed: {
    term: "Quality Vetoed",
    category: "portfolio",
    short: "Stocks where the Quality Veto fired (TOP_PICK demoted to QUALITY_HOLD).",
    full: "Subset of quality_flagged: only TOP_PICKs with 3+ flags AND ≥ 7-point penalty. Small number — usually a handful even when quality_flagged is in the hundreds. The most severe lab disagreement with production's top-tier calls.",
  },

  lab_low_quality: {
    term: "Low Quality",
    category: "portfolio",
    short: "Stocks where quality_verdict = LOW (3+ quality flags, regardless of veto status).",
    full: "Independent of veto: any stock that crossed the 3+ flag threshold gets LOW. Includes vetoed TOP_PICKs and any other verdict with the same flag count. A stock can be quality_verdict=LOW without being vetoed (if it wasn't a TOP_PICK or the penalty was under 7).",
  },

  // ══════════════════════════════════════════════════════════════════════
  // RISK LAB — regime metadata + Macro Thesis fields
  // ══════════════════════════════════════════════════════════════════════

  regime_severity: {
    term: "Regime Severity",
    category: "macro",
    short: "1–5 scale measuring how disruptive the current regime is. 4+ triggers macro vetoes.",
    full: "Severity 1 = calm / negligible impact, 2 = mild, 3 = noticeable sector rotation, 4 = significant disruption (vetoes start firing), 5 = crisis-level. Combined with regime confidence, this drives how strongly the Macro Lens adjusts scores. Set by the regime classifier from headline-tier news (Business Standard, Economic Times, Reuters, FT).",
  },

  regime_confidence: {
    term: "Regime Confidence",
    category: "macro",
    short: "0–1 scale: how certain the classifier is about the current regime label.",
    full: "Below 60% (shown in amber) means the classifier is uncertain — could be early in a regime shift, conflicting signals, or low news volume. The Macro Lens scales its adjustments by confidence, so a high-confidence regime gets full effect; a low-confidence one is softened. If you see persistent low confidence, treat the regime label itself with skepticism.",
  },

  regime_days_in_state: {
    term: "Days in State",
    category: "macro",
    short: "How long the current regime has been continuously classified the same way.",
    full: "Regime persistence. Day 1 of a new regime is the riskiest read — the classifier may flip back. Day 10+ in the same state means the regime is well-established. Used as one input to the scenario probabilities in the Macro Thesis: longer days-in-state weakens 'continue' and strengthens 'de-escalate' scenarios.",
  },

  thesis_branch_continue: {
    term: "Thesis Branch — Continue",
    category: "macro",
    short: "Scenario: the current regime persists at its current severity for the duration window.",
    full: "Base case scenario — the regime label and severity stay where they are. Probability typically high (40–60%) in well-established regimes, lower in fresh transitions. Beneficiaries and losers in this branch are the sectors that have outperformed / underperformed in historical analogs of the same regime.",
  },

  thesis_branch_escalate: {
    term: "Thesis Branch — Escalate",
    category: "macro",
    short: "Scenario: the current regime worsens (higher severity or wider impact).",
    full: "Tail-risk scenario. For an OIL_SHOCK regime, escalation means higher oil prices; for CURRENCY_WEAKNESS, deeper INR depreciation. Probability is typically moderate (15–25%) — escalations happen, but not on most days. Beneficiaries here are usually defensive sectors; losers are the regime's primary victims.",
  },

  thesis_branch_de_escalate: {
    term: "Thesis Branch — De-escalate",
    category: "macro",
    short: "Scenario: the regime fades back toward CALM at the duration window's end.",
    full: "The 'this passes' scenario. Probability scales with days-in-state — longer persistence makes de-escalation more likely. Beneficiaries are typically the sectors that got hit during the regime (mean reversion); losers are the defensives that ran during the stress.",
  },

  thesis_branch_new_shock: {
    term: "Thesis Branch — New Shock",
    category: "macro",
    short: "Scenario: a different regime entirely takes over before the duration window ends.",
    full: "Tail scenario — something the classifier didn't anticipate hits the market. Probability is typically lowest (5–15%) because by definition we can't predict what we don't see. Beneficiaries and losers here are template-based (no analog data) — read them as 'directional guesses,' not 'evidence-backed.'",
  },

  thesis_probability: {
    term: "Thesis Branch Probability",
    category: "macro",
    short: "% likelihood the branch fires within its duration window. Branches sum to ~100%.",
    full: "Computed from a base probability (rule-based) times a modulator that uses regime severity, days-in-state, and analog count. Probabilities across the four branches should sum to roughly 100% (small rounding tolerance). High-confidence regimes have sharper distributions (one dominant branch); low-confidence regimes spread probability more evenly.",
  },

  thesis_beneficiaries: {
    term: "Beneficiaries (▲)",
    category: "macro",
    short: "Sectors and pure-play stocks expected to OUTPERFORM under this scenario.",
    full: "When the branch fires, these are the names with positive expected returns. Source = 'analog' means median + IQR are from historical regime matches; source = 'template' means there's no analog data and the call is rule-based (lower confidence). Stocks listed under each sector are pure plays — concentrated exposure to that sector's regime sensitivity.",
  },

  thesis_losers: {
    term: "Losers (▼)",
    category: "macro",
    short: "Sectors and pure-play stocks expected to UNDERPERFORM under this scenario.",
    full: "When the branch fires, these are the names with negative expected returns. Same source classification as beneficiaries. Use this list defensively — if your portfolio is concentrated in a sector flagged as a loser in the high-probability branch, the lab is suggesting risk reduction (not a sell mandate).",
  },

  thesis_position_cap: {
    term: "Position-Sizing Cap (SEBI Reg 16)",
    category: "portfolio",
    short: "Max % of your portfolio you should commit to any single macro thesis.",
    full: "Typically 10%. The cap exists because thesis-driven positioning is concentrated by design — if you're going to act on the lab's view, do so across multiple theses, not by betting the book on one regime call. SEBI Reg 16 compliance for the research surface: diversify, don't concentrate.",
  },

  thesis_sebi_reg16: {
    term: "SEBI Reg 16 Caveats",
    category: "portfolio",
    short: "Mandatory research-disclosure caveats listed for the Macro Thesis sub-view.",
    full: "The Risk Lab is research, not SEBI-registered investment advice. Reg 16 caveats appear alongside any directional thesis: assumptions, limitations, data-source provenance, position-sizing constraints. Read them — they're the difference between 'thesis-aware investing' and 'blindly chasing a narrative.'",
  },

  thesis_upcoming_catalysts: {
    term: "Upcoming Catalysts",
    category: "macro",
    short: "Known events in the next 30 days that could move the current regime.",
    full: "Pulled from the events calendar: earnings, RBI policy, SEBI announcements, ECB / Fed decisions, etc. Each catalyst is color-coded by urgency (red ≤ 7 days, amber ≤ 14 days, blue > 14 days). The list isn't predictive — it's a 'don't forget these are coming' reminder. Use it to time portfolio reviews and avoid getting caught flat-footed.",
  },

  // ══════════════════════════════════════════════════════════════════════
  // SECTOR OUTLOOK
  // ══════════════════════════════════════════════════════════════════════

  sector_outlook_label: {
    term: "Sector Outlook",
    category: "macro",
    short: "Directional call for the sector: Tailwind, Headwind, or Neutral (with Strong variants).",
    full: "Derived from the composite score — Strong Tailwind / Tailwind lean positive, Strong Headwind / Headwind lean negative, Neutral has no clear edge. It blends the bottom-up news signal with the top-down macro regime, and a sector only earns a 'Strong' label when both agree. Sector-level only; never a buy/sell call on any single stock.",
  },

  sector_outlook_confidence: {
    term: "Outlook Confidence",
    category: "macro",
    short: "How much to trust this sector's outlook — Low, Medium, or High.",
    full: "High requires a strong same-direction signal with broad participation (breadth) plus at least ~8 news items in the 90-day window. When bottom-up news and the top-down macro regime point opposite ways the sector is flagged DIVERGENT and confidence drops to Low. Medium is the default in between. Treat Low-confidence rows as noise, not signal.",
  },

  sector_composite: {
    term: "Composite Score",
    category: "macro",
    short: "The headline cross-check score for the sector, on a −1 to +1 scale.",
    full: "Composite is the average of the bottom-up news signal and the top-down macro impact. Positive means both lenses lean constructive; negative means both lean cautious. Because it's an average, a strong bottom-up read can be cancelled by a hostile macro regime (and vice-versa) — that disagreement is exactly what the confidence column flags as DIVERGENT.",
  },

  sector_bottom_up: {
    term: "Bottom-up Signal",
    category: "macro",
    short: "News-driven read on the sector from SWS deep briefs, scaled −1 to +1.",
    full: "Built from company news classified into themes (Earnings Move, M&A, Capacity/Capex, etc.), weighted by market cap and blended across 30/90/365-day windows — shorter windows dominate the 3–12m horizon, longer windows the 12–24m. It answers 'what is actually happening to companies in this sector right now?' independent of the macro overlay.",
  },

  sector_top_down: {
    term: "Top-down Signal",
    category: "macro",
    short: "How the current macro regime tilts this sector, scaled −1 to +1.",
    full: "Taken from the active macro regime's per-sector impact (a −3 to +3 tilt) and normalized to the −1 to +1 range. A RATE_HIKE regime, for example, pushes banks up and rate-sensitive sectors down. This is the pure macro lens — it ignores company news and asks only 'does the prevailing regime help or hurt this sector?'",
  },

  sector_breadth: {
    term: "Breadth",
    category: "macro",
    short: "Share of the sector's stocks actually carrying a news signal in the last 90 days.",
    full: "A participation check. A sector can look strong on one mega-cap's news, so breadth measures how many distinct tickers contribute — and each single issuer is capped at 15% of the total so one giant can't manufacture broad-looking breadth. Low breadth with a high composite means a narrow signal; high breadth means a genuinely sector-wide move.",
  },

  sector_news_90d: {
    term: "News (90d)",
    category: "macro",
    short: "Count of classified SWS news items for the sector in the trailing 90 days.",
    full: "The raw evidence volume behind the bottom-up signal, after de-duplication and a confidence floor. More items mean a better-supported read; a handful means the signal is thin and should be treated with caution — below ~8 items the confidence column is capped at Medium.",
  },

  sector_top_themes: {
    term: "Top Themes",
    category: "track",
    short: "The two highest-weighted news themes driving this sector's signal.",
    full: "Every news item is classified into a theme (Earnings Move, M&A, Capacity/Capex, Regulatory, Management, etc.); the two with the largest share of weighted signal are shown with their percentage. They tell you why the sector is moving — 'Earnings Move 15%, Capacity/Capex 4%' means the read is mostly earnings-driven with a smaller capex thread.",
  },

  sector_tailwind: {
    term: "Tailwind Sectors",
    category: "macro",
    short: "Count of sectors leaning positive (Tailwind or Strong Tailwind) in the active horizon.",
    full: "Tally of sectors whose composite and outlook lean constructive — bottom-up news and the macro regime both supportive. It's a quick breadth-of-market read: many tailwind sectors suggest a broad risk-on backdrop, only a couple suggests a narrow, selective market. Reflects the horizon you've selected (3–12m vs 12–24m).",
  },

  sector_headwind: {
    term: "Headwind Sectors",
    category: "macro",
    short: "Count of sectors leaning negative (Headwind or Strong Headwind) in the active horizon.",
    full: "Tally of sectors where the signals lean cautious. A rising headwind count alongside a high-severity macro regime is the defensive cue — it's where the lab flags elevated risk at the sector level. Sector-level context only, not a mandate to sell any specific name.",
  },

  sector_neutral: {
    term: "Neutral / Divergent Sectors",
    category: "macro",
    short: "Count of sectors with no clear lean, or where bottom-up and top-down disagree.",
    full: "Two cases land here: genuinely balanced sectors near a zero composite, and DIVERGENT sectors where company news and the macro regime point opposite ways. Divergence isn't a verdict — it's a 'wait for confirmation' flag, and it caps that sector's confidence at Low.",
  },

  // ══════════════════════════════════════════════════════════════════════
  // 5x LAB (MULTIBAGGER)
  // ══════════════════════════════════════════════════════════════════════

  mb_current_value: {
    term: "Current Value",
    category: "portfolio",
    short: "Live INR value of the ₹1L paper-trading book behind the 5x model.",
    full: "The 5x Lab tracks a hypothetical ₹1,00,000 starting book. This is its current marked value; the percentage shows the gain (or loss) from the ₹1L start. It's a paper-trade for studying the strategy — no real capital is deployed.",
  },

  mb_target_net: {
    term: "Target (net)",
    category: "portfolio",
    short: "The 5× net goal — ₹5L on a ₹1L start — over roughly 12 months.",
    full: "'Net' means after taxes and trading costs. The 5x framing is the target the strategy is built around, not a forecast: a portfolio 5x in a year is a top-few-percent outcome. The honest base case is far lower — see the pre-mortem in Strategy & reasoning before reading anything into this number.",
  },

  mb_gross_required: {
    term: "Gross Required",
    category: "portfolio",
    short: "Gross P&L needed to net 5× after taxes and churn — roughly 6× gross.",
    full: "Netting 5× isn't the same as making 5× gross. Short-term capital gains tax (~17% with cess) plus round-trip brokerage on an actively churned book mean you need closer to ~6× of gross profit to keep 5× net. This line is a reminder that turnover is expensive and the tax drag is real.",
  },

  mb_universe_scored: {
    term: "Universe Scored",
    category: "portfolio",
    short: "How many stocks were scored in this run — the denominator for the pipeline.",
    full: "The total count of stocks that passed data checks and went through the 12-factor multibagger scorer. It frames how selective the pipeline is — '8 of 487 cleared the 5X bar' is a far stronger filter than '8 of 40'.",
  },

  mb_score: {
    term: "Multibagger Score",
    category: "verdict",
    short: "Composite 0–100 score from 12 weighted factors minus risk penalties.",
    full: "Combines earnings inflection, SWS future-growth and valuation pillars, fair-value upside, market-cap headroom, sector tailwind, price momentum, liquidity, balance-sheet health, forward growth, and a thematic story bonus — then subtracts penalties for surveillance flags, thin data, and recent earnings-miss streaks. Higher means more of the multibagger fingerprint, but it's a screen, not a promise.",
  },

  mb_verdict: {
    term: "Verdict",
    category: "verdict",
    short: "Score band: 5X_CANDIDATE, HIGH_CONVICTION, WATCH, PASS, or HARD_REJECT.",
    full: "5X_CANDIDATE (score ≥70) is the top tier; HIGH_CONVICTION (55–69) is a strong core holding; WATCH (40–54) needs a better catalyst or entry; PASS (<40) is below the bar. HARD_REJECT overrides the score entirely — the stock failed a non-negotiable gate (promoter pledge, illiquidity, GSM surveillance, audit flag, insufficient data, or a balance-sheet-health floor).",
  },

  mb_bull_case: {
    term: "Bull Case",
    category: "verdict",
    short: "The factors that scored highest for this pick — why it's on the list.",
    full: "The top positive drivers behind the composite score, in plain language: earnings-inflection turnaround, a strong SWS future-growth pillar, fair-value upside, small-cap headroom, and the like. It's the constructive half of the thesis — read it alongside the bear case, never on its own.",
  },

  mb_bear_case: {
    term: "Bear Case",
    category: "verdict",
    short: "Stock-specific vulnerabilities plus the baseline concentration risk.",
    full: "Where this pick can break: gate-adjacent risks, sector exhaustion, an inflection that may be a one-off, weak momentum, health flags, or a thin margin of safety. Every pick also carries the baseline caveat that a concentrated small-cap position can draw down 40%+ even when the thesis is intact. This is the pre-mortem at the single-stock level.",
  },

  mb_target_multiple: {
    term: "Target Multiple",
    category: "verdict",
    short: "The modeled return band for this verdict over ~12 months.",
    full: "Roughly 5–10× for a 5X_CANDIDATE and 3–5× for a HIGH_CONVICTION name, with WATCH/PASS below the actionable bar. These are modeled ranges conditional on a favorable regime and the thesis playing out — emphatically not promises, and most picks will land well short. The number exists to size conviction, not to set expectations.",
  },
};
