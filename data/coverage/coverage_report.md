# Stock Universe Coverage Gap — SWS vs Indian Equity Ground Truth

Generated: 2026-05-13T01:10:53.933Z

## Headline

- **Ground truth (NSE+BSE deduped by ISIN):** 5259
- **SWS universe (data/sws/universe.json):** 5518
- **Matched:** 5163 (98.17%)
- **Missing from SWS:** 96
- **Groww-tradeable missing** (any market cap, any liquidity tier, excludes only NSE-suspended BZ): **96**

## Sources

- NSE EQ + BE + BZ master (EQUITY_L.csv): **2365**
- BSE active equity scrips (ListofScripData): **4842**
- Deduped by ISIN: **5259**
- Skipped: NSE Emerge SME and BSE SME segment (low-liquidity, not investment-grade for a long-only book)

## Match strategy

- nse_symbol: 2806
- bse_code: 2119
- bse_code_prefixed: 233
- name_exact: 5

## Gap breakdown

### By market-cap bucket

| Bucket | Missing |
|---|---|
| nano | 56 |
| unknown | 38 |
| micro | 2 |

### By BSE liquidity tier

| Tier | Missing |
|---|---|
| low_liquidity | 66 |
| special | 21 |
| sme | 4 |
| surveillance | 3 |
| other | 1 |
| liquid | 1 |

### By exchange presence

| Where listed | Missing |
|---|---|
| NSE_only | 1 |
| BSE_only | 94 |
| Both | 1 |

## Groww-tradeable missing (top 50 by market cap)

Every Indian equity a retail investor can buy on Groww that we don't yet have an SWS deep-scrape for. Sorted by market cap descending.

| Name | NSE | BSE | ISIN | Mkt Cap | Tier |
|---|---|---|---|---|---|
| Pervasive Commodities Limited | — | PERVASIVE (XT) | INE443P01038 | ₹1.1k Cr | low_liquidity |
| Modern Malleables Limited | — | MODMA (P) | INE834C01028 | ₹741 Cr | special |
| TIL Ltd. | — | 505196 (B) | IN9806C01016 | ₹200 Cr | liquid |
| Manas Properties Limited | — | MANAS (MT) | INE800W01019 | ₹162 Cr | sme |
| Winro Commercial (India) Ltd. | — | WINROC (XT) | INE837E01019 | ₹31 Cr | low_liquidity |
| APEX CAPITAL AND FINANCE LIMITED | — | ACFL (XT) | INE758W01019 | ₹27 Cr | low_liquidity |
| Amrapali Fincap Limited | — | AMRAFIN (MT) | INE990S01016 | ₹17 Cr | sme |
| Velox Shipping and Logistics Limited | — | VELOX (XT) | INE092P01017 | ₹14 Cr | low_liquidity |
| Prabhu Steel Industries Ltd. | — | ZPRBHSTE (XT) | INE821R01015 | ₹13 Cr | low_liquidity |
| Surya India Limited | — | SURYAINDIA (X) | INE446E01019 | ₹13 Cr | low_liquidity |
| HARIYANA VENTURES LIMITED | — | HVL (ZP) | INE219D01012 | ₹12 Cr | surveillance |
| Pyxis Finvest Limited | — | PYXISFIN (MT) | INE883L01018 | ₹11 Cr | sme |
| Modern Shares and Stockbrokers Ltd. | — | MODRNSH (X) | INE370A01019 | ₹10 Cr | low_liquidity |
| Premier Limited | PREMIER | PREMIER (T) | INE342A01018 | ₹9 Cr | low_liquidity |
| Chadha Papers Ltd. | — | CHADPAP (X) | INE669W01018 | ₹9 Cr | low_liquidity |
| Tashi India Ltd. | — | TASHIND (XT) | INE552H01017 | ₹9 Cr | low_liquidity |
| SRI AMARNATH FINANCE LIMITED | — | AMARNATH (X) | INE985Q01010 | ₹8 Cr | low_liquidity |
| Kabra Commercial Limited | — | KCL (XT) | INE926E01010 | ₹8 Cr | low_liquidity |
| Sophia Traexpo Limited | — | STRAEXPO (XT) | INE268X01017 | ₹6 Cr | low_liquidity |
| Pet Plastics Ltd. | — | PETPLST (XT) | INE704F01018 | ₹6 Cr | low_liquidity |
| Multiplus Holdings Ltd. | — | MULTIIN (XT) | INE886E01016 | ₹6 Cr | low_liquidity |
| SIDH AUTOMOBILES LIMITED | — | SIDH (XT) | INE403L01015 | ₹4 Cr | low_liquidity |
| Frontline Financial Services Ltd. | — | FRONTFN (XT) | INE776R01011 | ₹3 Cr | low_liquidity |
| SVA India Ltd | — | SVAINDIA (P) | INE763K01014 | ₹3 Cr | special |
| Indo Gulf Industries  Ltd. | — | IGLFXPL-B (P) | INE684U01011 | ₹2 Cr | special |
| Anand Projects Ltd | — | ANANDPROJ (XT) | INE134R01013 | ₹2 Cr | low_liquidity |
| Hindusthan Udyog Ltd | — | ZHINUDYP (XT) | INE582K01018 | ₹2 Cr | low_liquidity |
| Sagar Systech Ltd. | — | SAGARSYST (XT) | INE771Z01015 | ₹2 Cr | low_liquidity |
| Advance Multitech Ltd. | — | ADVMULT (XT) | INE875S01019 | ₹2 Cr | low_liquidity |
| Midland Polymers Ltd. | — | MIDPOLY (XT) | INE046M01036 | ₹2 Cr | low_liquidity |
| Kedia Construction Co. Ltd. | — | KEDIACN (XT) | INE511J01027 | ₹1 Cr | low_liquidity |
| Sheraton Properties & Finance Ltd. | — | ZSHERAPR (P) | INE495M01019 | ₹1 Cr | special |
| Valley Magnesite Company Limited | — | VALLEY (X) | INE834E01016 | ₹1 Cr | low_liquidity |
| Uniworth Securities Limited | — | UNIWSEC (XT) | INE728J01019 | ₹1 Cr | low_liquidity |
| Esquire Money Guarantees Ltd | — | ESQRMON (XT) | INE0HMN01013 | ₹1 Cr | low_liquidity |
| HIND COMMERCE LIMITED | — | HCLTD (X) | INE691J01019 | ₹1 Cr | low_liquidity |
| P. B. Films Limited | — | PBFL (MT) | INE212Q01019 | ₹1 Cr | sme |
| Speedage Commercials Ltd. | — | ZSPEEDCO (P) | INE497M01015 | ₹1 Cr | special |
| Twin Roses Trades & Agencies Ltd. | — | TWIROST (XT) | INE436U01016 | ₹1 Cr | low_liquidity |
| Satyam Silk Mills Ltd | — | ZSATYASL (XT) | INE07MC01015 | ₹1 Cr | low_liquidity |
| Alna Trading & Exports Ltd. | — | ALNATRD (P) | INE07I701011 | ₹1 Cr | special |
| Ridhi Synthetics Ltd. | — | RIDHISYN (XT) | INE07LK01010 | ₹0 Cr | low_liquidity |
| Triochem Products Ltd. | — | TRIPR (XT) | INE331E01013 | ₹0 Cr | low_liquidity |
| Shikhar Leasing and Trading Ltd. | — | SHIKHARLETR (XT) | INE02BV01019 | ₹0 Cr | low_liquidity |
| Sunrise Industrial Traders Ltd. | — | SUNRINV (XT) | INE371U01015 | ₹0 Cr | low_liquidity |
| Oseaspre Consultants Ltd. | — | OSEASPR (XT) | INE880P01015 | ₹0 Cr | low_liquidity |
| Nirbhay Colours India Limited | — | NIRBHAYIND (Z) | INE218T01010 | ₹0 Cr | surveillance |
| Coromandel Agro Products & Oils Ltd | — | CORAGRO (P) | INE495D01018 | ₹0 Cr | special |
| Jeet Machine Tools Ltd. | — | ZJEETMAC (XT) | INE987E01012 | ₹0 Cr | low_liquidity |
| Kusam Electrical Industies Ltd. | — | KUSUMEL (XT) | INE175Q01018 | ₹0 Cr | low_liquidity |

## Largest 30 missing (any tier)

Includes SME / surveillance / illiquid — not necessarily actionable, useful for awareness.

| Name | NSE | BSE | Mkt Cap | Group |
|---|---|---|---|---|
| Pervasive Commodities Limited | — | PERVASIVE | ₹1.1k Cr | XT |
| Modern Malleables Limited | — | MODMA | ₹741 Cr | P |
| TIL Ltd. | — | 505196 | ₹200 Cr | B |
| Manas Properties Limited | — | MANAS | ₹162 Cr | MT |
| Winro Commercial (India) Ltd. | — | WINROC | ₹31 Cr | XT |
| APEX CAPITAL AND FINANCE LIMITED | — | ACFL | ₹27 Cr | XT |
| Amrapali Fincap Limited | — | AMRAFIN | ₹17 Cr | MT |
| Velox Shipping and Logistics Limited | — | VELOX | ₹14 Cr | XT |
| Prabhu Steel Industries Ltd. | — | ZPRBHSTE | ₹13 Cr | XT |
| Surya India Limited | — | SURYAINDIA | ₹13 Cr | X |
| HARIYANA VENTURES LIMITED | — | HVL | ₹12 Cr | ZP |
| Pyxis Finvest Limited | — | PYXISFIN | ₹11 Cr | MT |
| Modern Shares and Stockbrokers Ltd. | — | MODRNSH | ₹10 Cr | X |
| Premier Limited | PREMIER | PREMIER | ₹9 Cr | T |
| Chadha Papers Ltd. | — | CHADPAP | ₹9 Cr | X |
| Tashi India Ltd. | — | TASHIND | ₹9 Cr | XT |
| SRI AMARNATH FINANCE LIMITED | — | AMARNATH | ₹8 Cr | X |
| Kabra Commercial Limited | — | KCL | ₹8 Cr | XT |
| Sophia Traexpo Limited | — | STRAEXPO | ₹6 Cr | XT |
| Pet Plastics Ltd. | — | PETPLST | ₹6 Cr | XT |
| Multiplus Holdings Ltd. | — | MULTIIN | ₹6 Cr | XT |
| SIDH AUTOMOBILES LIMITED | — | SIDH | ₹4 Cr | XT |
| Frontline Financial Services Ltd. | — | FRONTFN | ₹3 Cr | XT |
| SVA India Ltd | — | SVAINDIA | ₹3 Cr | P |
| Indo Gulf Industries  Ltd. | — | IGLFXPL-B | ₹2 Cr | P |
| Anand Projects Ltd | — | ANANDPROJ | ₹2 Cr | XT |
| Hindusthan Udyog Ltd | — | ZHINUDYP | ₹2 Cr | XT |
| Sagar Systech Ltd. | — | SAGARSYST | ₹2 Cr | XT |
| Advance Multitech Ltd. | — | ADVMULT | ₹2 Cr | XT |
| Midland Polymers Ltd. | — | MIDPOLY | ₹2 Cr | XT |

## SWS-only stocks (in SWS universe but not in NSE/BSE master)

Total: **320** ({"NSE":107,"BSE":213})

These are stocks SWS scraped from its sitemap but that don't appear in the current NSE EQUITY_L or BSE active-equity master. Three buckets dominate:

- **NSE Emerge SME** — small-cap listings on the SME platform (separate from main board, not in EQUITY_L). Recognisable by names like *3rd Rock Multimedia, Aakaar Medical Technologies*.
- **BSE-only delisted / suspended** — old scrips SWS still has pages for. Recognisable by 6-digit BSE codes pointing to dormant names (*Harig Crankshafts, JCT, Kanel Industries*).
- **Recent IPOs / spin-offs** — listed after the master CSV snapshot.

Sample (first 15 BSE-only extras with names):

| BSE Code | Name |
|---|---|
| 500178 | Harig Crankshafts |
| 500223 | JCT |
| 500236 | Kanel Industries |
| 500248 | Krishna Filament Industries |
| 500358 | Rama Petrochemicals |
| 500399 | Steelco Gujarat |
| 501144 | Peoples Investments |
| 501261 | Lord's Mark Industries |
| 502133 | Hemadri Cements |
| 502271 | Raasi Refractories |
| 503659 | SW Investments |
| 504346 | Rrp Semiconductor |
| 504397 | Ganesh Holdings |
| 504961 | Tayo Rolls |
| 505100 | India Radiators |


## What to do next

1. **Review `data/coverage/groww_missing_candidates.json`** — every Groww-tradeable equity not yet in our SWS universe.
2. Run `node scripts/sws-probe-availability.mjs` to filter the candidates against SWS's Asia sitemap (which stocks SWS actually has a page for).
3. Run `node scripts/sws-build-delta.mjs` to build the merge-ready `data/coverage/sws_universe_delta.json`.
4. Run `node scripts/sws-build-universe.mjs --merge --from-stdin < data/coverage/sws_universe_delta.json` to add them.
5. The next 02:00 / 16:30 IST nightly fire (launchd) will deep-scrape the new entries automatically.