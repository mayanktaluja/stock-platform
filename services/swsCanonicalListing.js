// Canonical-listing resolution for dual-listed Indian companies.
//
// SWS data is COMPANY-level, but an Indian company listed on both NSE and BSE gets
// one deep brief per LISTING. scripts/sws-scoring.mjs enumerates data/sws/deep/*.json
// off disk and treats one file as one stock, so both briefs get scored and both
// compete for leaderboard slots. On 2026-07-30 that put 618 companies on disk twice
// (661 redundant briefs), 333 duplicate rows across 9 of 14 picks sections, and wasted
// 4 of the 30 headline Top-30 slots — Shanti Gold, WPIL, Yatharth and Manorama each
// appeared as both an NSE row and a BSE_<code> row with different prices and scores.
//
// The duplicate is not merely cosmetic: the BSE_<code> row's detail modal is broken.
// server.js:8443 validates the ticker against /^[A-Z0-9&\-]+$/, which rejects the
// underscore, so /api/sws-stock/BSE_544459 400s and the card falls through to a
// live-only path that queries the nonexistent Yahoo symbol "BSE_544459.NS".
//
// The universe builder already solved this once — the slug-keyed Pass 3 dedup plus
// preferEntry() in scripts/sws-universe-from-sitemap.mjs — but that lives only in the
// universe-building path, and the scorer never reads universe.json. This module is the
// shared resolver so the two paths can agree.
//
// INDIA ONLY. Do NOT wire this into the US pipeline. US briefs legitimately share a
// slug across genuinely distinct share classes: BRK.A (nyse-brk.a) and BRK.B
// (nasdaq-brk.b) both carry the slug "berkshire-hathaway" but are different
// instruments at different prices. Collapsing them would be a real bug, not a fix.

// Exchange preference as an ordered table rather than a boolean, so adding a third
// venue is a config change. NSE wins: it is the more liquid primary listing, its
// ticker survives server.js's validation, Groww P/E resolution rejects BSE_ tickers
// outright, and gated/app.js's normalizeTickerKey strips .NS/.BO but not a BSE_
// prefix — so a BSE_ winner would blank the verdict pill on every Watchlist and
// Analyzer row.
const EXCHANGE_PRIORITY = { NSE: 1, BSE: 2 };
const UNKNOWN_EXCHANGE_RANK = 99;

// Derived/temporary series that must never outrank their parent line:
//   • partly-paid rights series — UPLPP1, FUSIONPP, SEPCPP, NGILPP1, CALSOFTPP,
//     SOLARAPP1, ATLPP, SSFLPP, KRISHPP, INFIBPP, LLOYDPP, GVPTECHPP
//   • differential-voting-rights lines — GATECHDVR, FELDVR, and JISLDVREQS (which
//     ends "EQS", so an anchored /DVR$/ would miss it — the substring is deliberate)
// EQUIPPP ("Equippp Social Impact Technologies") matches the PP pattern but is a real
// company name, not a series. It is safe: it has no NSE sibling, and rule 1 decides
// any NSE-vs-BSE pair before rule 3 is ever reached, so this rule only arbitrates
// same-exchange pairs.
const PARTLY_PAID_RE = /PP\d*$/;
const DVR_RE = /DVR/;

// Extract the SWS company slug from a stock URL. Market-agnostic by construction:
// take the last path segment and strip a trailing "-shares".
//   India: .../nse-shantigold/shanti-gold-international-shares → shanti-gold-international
//   US:    .../nyse-brk.a/berkshire-hathaway                   → berkshire-hathaway
// Verified against all 6,178 live India briefs: 0 unparseable, 618 duplicate groups.
export function companySlugFromSwsUrl(swsUrl) {
  if (!swsUrl || typeof swsUrl !== "string") return null;
  // Parse as a real URL rather than string-splitting. A bare string like "not a url"
  // has no "/" at all, so a naive split().pop() would hand back the whole string as a
  // "slug" — a non-null key that could collapse two unrelated rows together. Garbage
  // in must yield null so the caller takes the unique fail-open key instead.
  let pathname;
  try { pathname = new URL(swsUrl).pathname; } catch { return null; }
  const segments = pathname.split("/").filter(Boolean);
  // Need at least <exchange-shortid>/<company-slug>; anything shorter is not a stock URL.
  if (segments.length < 2) return null;
  const slug = segments.pop().replace(/-shares?$/, "").trim().toLowerCase();
  return slug || null;
}

// Exchange is re-derived from the URL rather than trusted from a field: a scored row
// carries no `exchange` key (that lives on universe.json entries, not deep briefs).
export function exchangeFromSwsUrl(swsUrl) {
  if (!swsUrl || typeof swsUrl !== "string") return null;
  const m = swsUrl.match(/\/(nse|bse)-[^/]+\//i);
  return m ? m[1].toUpperCase() : null;
}

// Identity key for a scored row, plus whether we had to fall back.
//
// The fallback is deliberately FAIL-OPEN: an unparseable URL yields a key unique to
// this row, so the row survives as its own company. A parse regression must degrade
// to today's behaviour (a duplicate ships) and never to a silently dropped stock.
//
// `rowIndex` is folded into the fallback because deep-brief tickers are NOT unique:
// MM.json and M&M.json both carry ticker "M&M". Keying the fallback on ticker alone
// would let two unparseable rows collide and collapse into one silent drop — the
// exact failure the fail-open design exists to prevent.
export function companyKeyFromRow(row, rowIndex = 0) {
  const slug = companySlugFromSwsUrl(row?.sws_url);
  if (slug) return { key: slug, viaFallback: false };
  return { key: `__row:${rowIndex}:${row?.ticker ?? ""}`, viaFallback: true };
}

function exchangeRank(row) {
  const ex = exchangeFromSwsUrl(row?.sws_url);
  return EXCHANGE_PRIORITY[ex] ?? UNKNOWN_EXCHANGE_RANK;
}

// plain symbol < BSE_<code> < bare numeric code. Decides the 42 three-member groups
// such as wpil → { WPIL, BSE_505872, 505872 }.
function tickerShapeRank(row) {
  const t = String(row?.ticker ?? "");
  if (/^\d+$/.test(t)) return 2;
  if (/^BSE_/i.test(t)) return 1;
  return 0;
}

function derivedSeriesRank(row) {
  const t = String(row?.ticker ?? "");
  return PARTLY_PAID_RE.test(t) || DVR_RE.test(t) ? 1 : 0;
}

function indicesCount(row) {
  return Array.isArray(row?.indices) ? row.indices.length : 0;
}

function parsedAtMs(row) {
  const v = Date.parse(row?.parsed_at ?? "");
  return Number.isFinite(v) ? v : -Infinity;
}

// Total order over two listings of the same company. Lower sorts first = wins.
//
// RULE ORDER IS LOAD-BEARING. Freshness is LAST, not first. On live data the BSE
// sibling is the fresher brief in ~509 of 511 NSE/BSE pairs, which reads like a
// mandate to prefer BSE — but that is an artifact of scrape ORDER, not data quality:
// the restored NSE rows were appended at the tail of universe.json after the
// 2026-07-23 truncation and so get scraped last. Letting recency decide identity
// would make the canonical ticker flip on any night the scrape order changes, which
// cascades into entry-timing state resets, watchlist/holdings joins, and a spurious
// close+reopen pair in the paper-trade ledger on every flip.
//
// Rule 5 (codepoint ticker order) is what makes the result deterministic, and it must
// sit ABOVE freshness. It is also correct on the ampersand-normalisation artifacts,
// because "&" (0x26) sorts before "-" (0x2D): M&M > M-M, GVT&D > GVT-D,
// IL&FSENGG > IL-FSENGG, SURANAT&P > SURANAT-P, GMRP&UI > GMRP-UI — in every case
// recovering the real NSE symbol. It uses codepoint comparison, NOT localeCompare:
// ICU collation treats both characters as punctuation and gives no such guarantee.
export function compareListingPreference(a, b) {
  const byExchange = exchangeRank(a) - exchangeRank(b);
  if (byExchange !== 0) return byExchange;

  const byShape = tickerShapeRank(a) - tickerShapeRank(b);
  if (byShape !== 0) return byShape;

  const bySeries = derivedSeriesRank(a) - derivedSeriesRank(b);
  if (bySeries !== 0) return bySeries;

  const byIndices = indicesCount(b) - indicesCount(a);   // richer first
  if (byIndices !== 0) return byIndices;

  const ta = String(a?.ticker ?? "");
  const tb = String(b?.ticker ?? "");
  if (ta !== tb) return ta < tb ? -1 : 1;                // codepoint, deterministic

  const byFresh = parsedAtMs(b) - parsedAtMs(a);         // last resort only
  if (byFresh !== 0) return byFresh;

  return 0;
}

// Collapse rows so each company appears once.
//
// Returns the surviving rows in their ORIGINAL relative order (the caller sorts and
// sections afterwards; re-ordering here would silently change leaderboard ranking),
// plus the audit trail.
//
// The winner is annotated with `also_listed_as` and `sibling_freshness_at` so a
// collapsed company is diagnosable from the shipped artifact rather than invisible.
export function dedupeByCompany(rows) {
  const groups = new Map();
  let fallbackCount = 0;

  rows.forEach((row, i) => {
    const { key, viaFallback } = companyKeyFromRow(row, i);
    if (viaFallback) fallbackCount++;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ row, i });
  });

  const winnerIndex = new Set();
  const collapsedBy = {};
  let collapsedCount = 0;

  for (const [, members] of groups) {
    if (members.length === 1) { winnerIndex.add(members[0].i); continue; }
    const sorted = members.slice().sort((x, y) => compareListingPreference(x.row, y.row));
    const winner = sorted[0];
    const losers = sorted.slice(1);
    winnerIndex.add(winner.i);
    collapsedCount += losers.length;

    const aliases = [];
    let newestSibling = null;
    for (const l of losers) {
      const lt = l.row?.ticker;
      // Guard against a self-map: MM.json and M&M.json share the ticker "M&M", so a
      // loser can carry the winner's own ticker. Recording that would make the winner
      // its own alias and corrupt any consumer keyed on collapsedBy.
      if (lt && lt !== winner.row?.ticker) {
        aliases.push(lt);
        collapsedBy[lt] = winner.row.ticker;
      }
      const p = l.row?.parsed_at;
      if (p && (!newestSibling || p > newestSibling)) newestSibling = p;
    }
    if (aliases.length) {
      winner.row.also_listed_as = aliases;
      if (newestSibling) winner.row.sibling_freshness_at = newestSibling;
    }
  }

  const kept = rows.filter((_, i) => winnerIndex.has(i));

  // A winner older than its collapsed sibling means we kept the canonical ticker but
  // the staler data. Self-correcting once the loser leaves universe.json and the
  // scraper stops splitting its nightly budget across two rows of one company — but
  // counted so the cost is a visible number rather than unobserved silence.
  let staleVsSibling = 0;
  for (const row of kept) {
    if (row.sibling_freshness_at && row.parsed_at && row.sibling_freshness_at > row.parsed_at) staleVsSibling++;
  }

  return {
    kept,
    collapsed_count: collapsedCount,
    collapsed_by: collapsedBy,
    company_count: groups.size,
    fallback_count: fallbackCount,
    stale_vs_sibling_count: staleVsSibling,
  };
}
