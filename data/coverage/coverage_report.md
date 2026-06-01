# Stock Universe Coverage Gap — SWS vs Indian Equity Ground Truth

Generated: 2026-06-01T20:02:08.804Z

## Headline

- **Ground truth (NSE+BSE deduped by ISIN):** 5259
- **SWS universe (data/sws/universe.json):** 5455
- **Matched:** 5151 (97.95%)
- **Missing from SWS:** 108
- **Groww-tradeable missing** (any market cap, any liquidity tier, excludes only NSE-suspended BZ): **106**

## Sources

- NSE EQ + BE + BZ master (EQUITY_L.csv): **2365**
- BSE active equity scrips (ListofScripData): **4842**
- Deduped by ISIN: **5259**
- Skipped: NSE Emerge SME and BSE SME segment (low-liquidity, not investment-grade for a long-only book)

## Match strategy

- nse_symbol: 2823
- name_exact: 13
- bse_code: 2074
- bse_code_prefixed: 236
- bse_symbol: 5

## Gap breakdown

### By market-cap bucket

| Bucket | Missing |
|---|---|
| nano | 68 |
| unknown | 38 |
| micro | 2 |

### By BSE liquidity tier

| Tier | Missing |
|---|---|
| low_liquidity | 72 |
| special | 21 |
| liquid | 6 |
| surveillance | 5 |
| sme | 3 |
| other | 1 |

### By exchange presence

| Where listed | Missing |
|---|---|
| NSE_only | 1 |
| BSE_only | 100 |
| Both | 7 |

## Groww-tradeable missing (top 50 by market cap)

Every Indian equity a retail investor can buy on Groww that we don't yet have an SWS deep-scrape for. Sorted by market cap descending.

| Name | NSE | BSE | ISIN | Mkt Cap | Tier |
|---|---|---|---|---|---|
| Modern Malleables Limited | — | MODMA (P) | INE834C01028 | ₹741 Cr | special |
| Visa Steel Limited | VISASTEEL | VISASTEEL (B) | INE286H01012 | ₹626 Cr | liquid |
| S&S Power Switchgears Limited | S&SPOWER | S&SPOWER (T) | INE902B01017 | ₹484 Cr | low_liquidity |
| Aplab Ltd. | — | APLAB (X) | INE273A01015 | ₹275 Cr | low_liquidity |
| Suraj Industries Limited. | — | SURJIND (X) | INE170U01011 | ₹241 Cr | low_liquidity |
| TIL Ltd. | — | 505196 (B) | IN9806C01016 | ₹200 Cr | liquid |
| Manas Properties Limited | — | MANAS (MT) | INE800W01019 | ₹162 Cr | sme |
| Ace Software Exports ltd. | — | ACESOFT (X) | INE849B01010 | ₹151 Cr | low_liquidity |
| ANIRIT VENTURES LIMITED | — | ANIRIT (XT) | INE161F01011 | ₹93 Cr | low_liquidity |
| GACM Technologies Limited | GATECH | GATECH (B) | INE224E01028 | ₹54 Cr | liquid |
| Prabha Energy Limited | — | PRABHAPP (B) | IN90I0M01014 | ₹53 Cr | liquid |
| Jain Irrigation Systems Limited | JISLDVREQS | JISLDVREQS (B) | IN9175A01010 | ₹48 Cr | liquid |
| KRISHIVAL FOODS LIMITED | — | KRISHPP (B) | IN90GGO01013 | ₹39 Cr | liquid |
| Yarn Syndicate Ltd. | — | YARNSYN (X) | INE564C01013 | ₹36 Cr | low_liquidity |
| Winro Commercial (India) Ltd. | — | WINROC (XT) | INE837E01019 | ₹31 Cr | low_liquidity |
| APEX CAPITAL AND FINANCE LIMITED | — | ACFL (XT) | INE758W01019 | ₹27 Cr | low_liquidity |
| ANNVRRIDHHI VENTURES LIMITED | — | ANVRDHI (XT) | INE075K01013 | ₹17 Cr | low_liquidity |
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

## Largest 30 missing (any tier)

Includes SME / surveillance / illiquid — not necessarily actionable, useful for awareness.

| Name | NSE | BSE | Mkt Cap | Group |
|---|---|---|---|---|
| Modern Malleables Limited | — | MODMA | ₹741 Cr | P |
| Visa Steel Limited | VISASTEEL | VISASTEEL | ₹626 Cr | B |
| S&S Power Switchgears Limited | S&SPOWER | S&SPOWER | ₹484 Cr | T |
| IL&FS Engineering and Construction Company Limited | IL&FSENGG | IL&FSENGG | ₹367 Cr | Z |
| Aplab Ltd. | — | APLAB | ₹275 Cr | X |
| Suraj Industries Limited. | — | SURJIND | ₹241 Cr | X |
| TIL Ltd. | — | 505196 | ₹200 Cr | B |
| Manas Properties Limited | — | MANAS | ₹162 Cr | MT |
| Ace Software Exports ltd. | — | ACESOFT | ₹151 Cr | X |
| ANIRIT VENTURES LIMITED | — | ANIRIT | ₹93 Cr | XT |
| IL&FS Transportation Networks Limited | IL&FSTRANS | IL&FSTRANS | ₹82 Cr | Z |
| GACM Technologies Limited | GATECH | GATECH | ₹54 Cr | B |
| Prabha Energy Limited | — | PRABHAPP | ₹53 Cr | B |
| Jain Irrigation Systems Limited | JISLDVREQS | JISLDVREQS | ₹48 Cr | B |
| KRISHIVAL FOODS LIMITED | — | KRISHPP | ₹39 Cr | B |
| Yarn Syndicate Ltd. | — | YARNSYN | ₹36 Cr | X |
| Winro Commercial (India) Ltd. | — | WINROC | ₹31 Cr | XT |
| APEX CAPITAL AND FINANCE LIMITED | — | ACFL | ₹27 Cr | XT |
| ANNVRRIDHHI VENTURES LIMITED | — | ANVRDHI | ₹17 Cr | XT |
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

## SWS-only stocks (in SWS universe but not in NSE/BSE master)

Total: **316** ({"NSE":100,"BSE":216})

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
5. The next 16:30 IST nightly fire (launchd) will deep-scrape the new entries automatically.