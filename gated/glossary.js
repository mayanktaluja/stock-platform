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

  v3_composite_score: {
    term: "Composite Score (v3)",
    category: "fundamental",
    short: "Starbhai's 0–100 score: 74 fundamentals + 14 momentum − 15 safety overlay.",
    full: "Built from three blocks. Fundamentals (74 points): SWS pillars + DCF discount + ROE/leverage guardrails. Momentum (14 points): 1Y / 3M / 1M price trend, RSI position. Safety overlay (−15 points): NSE ASM/GSM penalty, declining-revenue penalty, payout-ratio penalty for unsustainable dividends. Score ≥ 60 = TOP_PICK, ≥ 45 = STRONG, ≥ 30 = ACCEPTABLE, ≥ 22 = WATCH, < 22 = AVOID. The safety overlay is what makes v3 different from a pure quality screener — it actively penalises stocks where the headline metrics look good but the structure is fragile.",
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
    term: "TOP PICK (v3)",
    category: "verdict",
    short: "Composite ≥ 60 — top-decile fundamentals + clean safety profile.",
    full: "The highest v3 tier. Strong on at least 3 of the 4 SWS pillars (Value/Future/Health/Dividend) AND clean on safety (no ASM/GSM, no payout > 100%, no declining revenue trend). These are the ~5–8% of the universe that pass every gate. Suitable as core holdings — but TOP_PICK doesn't override valuation: if upside-to-FV is negative, treat it as a high-quality compounder at full price, not a fresh entry.",
  },

  v3_strong: {
    term: "STRONG (v3)",
    category: "verdict",
    short: "Composite 45–59 — solid quality, minor blemish on one dimension.",
    full: "Either fundamentals are strong but safety overlay shaved a few points (low-stage surveillance, slightly elevated payout) or fundamentals are very strong on 2 pillars but average on the others. Good initiation candidates with normal position sizing. Roughly the next 15–20% of the universe after TOP_PICK.",
  },

  v3_acceptable: {
    term: "ACCEPTABLE (v3)",
    category: "verdict",
    short: "Composite 30–44 — middle of the pack, no clear edge.",
    full: "Neither cheap nor expensive, neither high-growth nor declining. The bulk of the universe lands here. For Acceptable stocks, the entry decision should be driven by sector view and technicals, not the v3 score — the score is just saying 'no fundamental red flags, no green flags either'. Smaller starter positions only.",
  },

  v3_watch: {
    term: "WATCH (v3)",
    category: "verdict",
    short: "Composite 22–29 — one or more weak signals; not actionable today.",
    full: "Either fundamentals are below average on multiple pillars, or the safety overlay has docked points. WATCH means 'don't initiate, but worth monitoring' — sometimes a turnaround starts here before it shows up in the headline score. Existing holdings should be reviewed: if the deterioration is structural, trim; if cyclical, hold with a stop.",
  },

  v3_avoid: {
    term: "AVOID (v3)",
    category: "verdict",
    short: "Composite < 22 — bottom-quartile fundamentals + meaningful safety risk.",
    full: "Combination of weak pillars (low Health or Future), bearish momentum, and active safety penalties (ASM/GSM placement, declining revenue, unsustainable payout). The v3 AVOID list exists explicitly to keep these out of buy categories — high downside, limited upside, regulatory friction. Existing positions should be reviewed for exit on next strength.",
  },

  // ══════════════════════════════════════════════════════════════════════
  // SWS PICKS — section criteria
  // ══════════════════════════════════════════════════════════════════════

  section_top_ranked_30: {
    term: "Top 30 — Multi-Factor Score",
    category: "verdict",
    short: "The 30 highest v3 composite scores in the universe (mcap ≥ ₹500cr).",
    full: "Pure ranking — the top 30 by v3 composite score across the entire scanned universe, gated to ≥ 50% data coverage on every input (no thin-data inflations) and market cap ≥ ₹500cr (no micro-caps where the underlying SWS data is sparse). This is the section to start every session with — the universe-wide best of class.",
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
    term: "Upcoming Earnings (next 30 days)",
    category: "verdict",
    short: "Stocks with results due in the next 30 days, sorted by date.",
    full: "Catalyst calendar: every stock with an earnings date in the next month, sorted by proximity. Earnings are the single biggest scheduled price-mover for a stock — a beat on a high-quality name is often a 5–10% gap up; a miss on a richly-valued name is often a 10–20% gap down. Use this section to (a) avoid initiating on names reporting tomorrow, and (b) spot pre-results setups on high-conviction holdings.",
  },

  section_avoid: {
    term: "Avoid List",
    category: "verdict",
    short: "v3 AVOID verdict — composite < 22, bottom-quartile fundamentals + risk overlay.",
    full: "The mirror image of TOP_PICK: weak pillars + active safety penalties (ASM/GSM, declining revenue, unsustainable payout, etc.). Listed not as a 'short these' signal — Indian shorting is restricted to F&O and carries its own risks — but as a 'don't be the bag-holder' list. Cross-check against your portfolio every refresh; if any of your holdings appear here, it's worth a fundamental re-examination.",
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
};
