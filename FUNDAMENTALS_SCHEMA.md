# Fundamentals Snapshot Schema

Reference for every field produced by the fundamentals pipeline. Lives at
the repo root so Phase 2 scorer work and anyone debugging data issues has
a single place to check units, sources, and coverage expectations.

**Pipeline:** `refresh-fundamentals.mjs` (NSE base) → `enrich-fundamentals.mjs`
(Yahoo overlay) → `fundamentals.json` / Vercel KV. The canonical list of
Yahoo-sourced field names is exported as `ENRICHED_FIELDS` from
[enrichFundamentals.js](enrichFundamentals.js) — keep that array and this
doc in sync when adding a field.

**Format conventions:**
- Ratios expressed as decimals (0.08 = 8%), unless noted otherwise.
- Currency values in INR at the company's reporting scale (usually crore).
- `null` = not reported by the source. Scorers must tolerate null per
  SEBI Reg 15(2) — we do not fabricate missing inputs.

---

## Core identity & market data (NSE scraper)

Source: `refresh-fundamentals.mjs` via `nse.js`. Refreshed weekly (or on
manual run). No transformation — pass-through from NSE quote-equity API.

| Field             | Unit        | Notes |
|-------------------|-------------|-------|
| `symbol`          | string      | e.g. `"RELIANCE.NS"`. Canonical lookup key. |
| `name`            | string      | Company name. |
| `sector`          | string      | NSE industry taxonomy. |
| `industry`        | string      | Sub-sector. |
| `macro`           | string      | Top-level classification (e.g. Financial Services). |
| `isin`            | string      | 12-char ISIN. Bridge to BSE scripcode for Phase 2 governance fetch. |
| `pe`              | ratio       | Trailing P/E as NSE publishes. |
| `sectorPe`        | ratio       | Peer-sector P/E reference. |
| `price`           | INR         | Last traded price. |
| `previousClose`   | INR         |  |
| `faceValue`       | INR         | Typically 1, 2, 5, or 10. |
| `issuedSize`      | shares      | Total outstanding. |
| `marketCap`       | INR         | Derived: `price × issuedSize`. |
| `week52High/Low`  | INR         | With accompanying `*Date` ISO strings. |
| `vwap`            | INR         | NSE-reported VWAP. |
| `upperCircuit`    | INR         | Daily circuit filter. |
| `lowerCircuit`    | INR         |  |

---

## V1 enriched fields (live in production scorer)

Source: Yahoo `quoteSummary` → modules `financialData` + `defaultKeyStatistics`.
Refresh cadence: weekly cron (Sunday pre-market). These are the fields the
current scorer (`fundamentals.js` v1.2-apr2026) reads.

| Field              | Unit  | Yahoo source              | Notes |
|--------------------|-------|---------------------------|-------|
| `roe`              | ratio | `financialData.returnOnEquity` with trailingEps/bookValue fallback | ~75% of NSE smallcaps need fallback. |
| `debtToEquity`     | ratio | `financialData.debtToEquity / 100` | Yahoo reports in percent; we divide. Banks: null. |
| `profitMargin`     | ratio | `financialData.profitMargins` |  |
| `revenueGrowthYoY` | ratio | `financialData.revenueGrowth` | Latest reported YoY. |

---

## Phase 1.1 additions (V2 scorer inputs, V1-ignored)

Source: Yahoo `quoteSummary` modules `financialData`, `defaultKeyStatistics`,
`summaryDetail`. Added to support Simply Wall St-style pillar scoring.
All optional — V1 scorer ignores them.

### Future pillar

| Field                 | Unit    | Yahoo source                                      | Coverage | Notes |
|-----------------------|---------|---------------------------------------------------|----------|-------|
| `forwardEps`          | INR/sh  | `defaultKeyStatistics.forwardEps`                 | 95%+     | Analyst consensus next FY. |
| `trailingEps`         | INR/sh  | `defaultKeyStatistics.trailingEps`                | 99%+     |  |
| `pegRatio`            | ratio   | `defaultKeyStatistics.pegRatio`                   | ~80%     | Thin on smallcaps. |
| `earningsGrowthYoY`   | ratio   | `financialData.earningsGrowth`                    | 95%+     | Latest reported. |
| `forwardEpsGrowth`    | ratio   | Derived: `(forwardEps − trailingEps) / trailingEps` | ~90%   | Nulled when trailingEps ≤ 0 (sign-flip). |
| `analystCoverage`     | count   | `financialData.numberOfAnalystOpinions`           | 95%+     | **Honesty flag** — gate trust in forward fields by coverage ≥ 5. |

### Value supplements

| Field                | Unit  | Yahoo source                                  | Coverage | Notes |
|----------------------|-------|-----------------------------------------------|----------|-------|
| `priceToBook`        | ratio | `defaultKeyStatistics.priceToBook`            | 99%+     | Essential for BFSI valuation. |
| `enterpriseToEbitda` | ratio | `defaultKeyStatistics.enterpriseToEbitda`     | ~80%     | Null for banks (no EBITDA line). |

### Dividend pillar

| Field                | Unit  | Yahoo source                                    | Coverage | Notes |
|----------------------|-------|-------------------------------------------------|----------|-------|
| `dividendYield`      | ratio | `summaryDetail.dividendYield`                   | 99%+     | Zero for non-payers, not null. |
| `payoutRatio`        | ratio | `summaryDetail.payoutRatio`                     | 95%+     | div / net income. |
| `fiveYearAvgDivYield`| percent (!) | `summaryDetail.fiveYearAvgDividendYield`  | 95%+     | **Percent, not ratio** — Yahoo schema inconsistency. Scorer must `/100` or compare in matching unit. |

### Health/Quality supplements (from quoteSummary)

| Field             | Unit  | Yahoo source                       | Coverage | Notes |
|-------------------|-------|------------------------------------|----------|-------|
| `ebitda`          | INR   | `financialData.ebitda`             | ~80%     | Null for banks. |
| `totalDebt`       | INR   | `financialData.totalDebt`          | 99%+     |  |
| `totalCash`       | INR   | `financialData.totalCash`          | 99%+     | For net-debt calc. |
| `operatingMargins`| ratio | `financialData.operatingMargins`   | 99%+     | OPEX efficiency. |
| `grossMargins`    | ratio | `financialData.grossMargins`       | 99%+     | 0.00 for banks (no gross-margin concept). |

---

## Phase 1.2 additions (Health pillar core)

Source: Yahoo `fundamentalsTimeSeries` endpoint (`module: "all"`, `type: "annual"`).
This is the **replacement** for `balanceSheetHistory` / `cashflowStatementHistory`
which Yahoo gutted in Nov 2024 — `yahoo-finance2` itself warns to use this
endpoint. Adds ~500ms per stock; at concurrency=4 the full universe
(112 stocks) takes ~17s, inside the 60s cron budget.

| Field                | Unit  | TimeSeries source                                    | Coverage | Notes |
|----------------------|-------|------------------------------------------------------|----------|-------|
| `currentRatio`       | ratio | `currentAssets / currentLiabilities` (annual)        | 90%      | **Null for banks** — they don't report current assets/liabilities. |
| `interestCoverage`   | ratio | `EBIT / abs(interestExpense)` (annual)               | 90%      | **Meaningless for banks** (interest expense IS the core business cost). Scorer must skip for BFSI. |
| `ocfToNetIncome`     | ratio | `operatingCashFlow / netIncome` (annual)             | 98%+     | <0.7 across consecutive years is the classic earnings-quality red flag. |
| `freeCashFlow`       | INR   | `freeCashFlow` (annual)                              | 98%+     | Raw FCF, for DCF in Phase 2. |
| `reportingPeriodEnd` | date  | `date` of latest annual period                       | 98%+     | ISO date `YYYY-MM-DD`. Flags stale filings — e.g. >18 months old means the company has missed filing. |

---

## Metadata fields (set by enrichSnapshot)

| Field              | Unit    | Notes |
|--------------------|---------|-------|
| `enrichedAt`       | ISO ts  | When the Yahoo overlay was last run. |
| `enrichmentSource` | string  | Currently `"yahoo-finance2"`. |
| `scoredAt`         | ISO ts  | Set by `scoreFundamentals()` per-call, not persisted. |
| `scorerVersion`    | string  | e.g. `"v1.2-apr2026"`. Enables A-B compare vs shadow V2. |

---

## Phase 2 planned additions (not yet in schema)

Out of scope for Phase 1 — documented here so field names stay consistent
when implementation lands.

- **Governance pillar** (from `governance.js`, stubbed): `promoterHolding`,
  `promoterPledge`, `pledgeOfTotal`, `fiiHolding`, `diiHolding`,
  `retailHolding`, `rptAsPctRevenue`, `promoterHoldingQoQDelta`,
  `pledgeQoQDelta`. Source: BSE XBRL quarterly filings.
- **Sector classification for tier-adaptive scoring**: `sectorTier` ∈
  `{large, mid, small, micro}` via AMFI + `sectorKind` ∈
  `{bfsi, it, manufacturing, utility, ...}` so the scorer can skip
  inapplicable pillars (e.g. EBITDA for banks).
- **Historical stability windows**: 3-year and 5-year stdev of ROE and
  revenue growth. Requires pulling multi-year `fundamentalsTimeSeries`
  and summarising — deferred to avoid bloating the weekly cron.
