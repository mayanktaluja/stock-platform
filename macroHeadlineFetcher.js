/**
 * Macro Headline Fetcher — RSS aggregation for the macro regime classifier.
 *
 * Extracted from server.js so both the in-process refresh (server-side cron
 * during local dev) and the standalone refresh script (scripts/refresh-macro-
 * regime.mjs, fired by sws-nightly.sh) share identical fetch + dedupe + tier-
 * coverage logic. Divergence between the two paths is how this class of bug
 * starts — see PR #195 for the equivalent fundamentals cleanup.
 *
 * Why local `fetchWithTimeout` / `fetchWithRetry` (rather than importing from
 * server.js): server.js imports this module, so the reverse import would be
 * circular. The helpers are short and self-contained — duplicating ~40 lines
 * is preferable to a third utility module just to break the cycle.
 */

import { setTimeout as delay } from "node:timers/promises";

// ─── Local fetch utilities (no circular dep with server.js) ───

async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } catch (err) {
    if (err.name === "AbortError") {
      const e = new Error(`Timeout after ${timeoutMs}ms`);
      e.code = "TIMEOUT";
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchWithRetry(url, options = {}, cfg = {}) {
  const { retries = 2, timeoutMs = 8000, backoffMs = 400 } = cfg;
  let attempt = 0;
  let lastErr = null;
  while (attempt <= retries) {
    try {
      const res = await fetchWithTimeout(url, options, timeoutMs);
      if (res.status === 404 || (res.status >= 400 && res.status < 500 && res.status !== 429)) {
        return res;
      }
      if (res.ok) return res;
      lastErr = new Error(`HTTP ${res.status}`);
      lastErr.code = "HTTP_" + res.status;
    } catch (err) {
      lastErr = err;
    }
    attempt++;
    if (attempt <= retries) {
      await delay(backoffMs * Math.pow(2, attempt - 1));
    }
  }
  if (lastErr) console.error(`fetchWithRetry gave up on ${url.slice(0, 80)}:`, lastErr.message);
  return null;
}

// ─── RSS parsing ───

export function safeDateParse(str) {
  if (!str) return null;
  try {
    const d = new Date(str);
    return isNaN(d.getTime()) ? null : d.toISOString();
  } catch { return null; }
}

export function parseRSS(xml, defaultSource) {
  if (!xml) return [];
  const articles = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const title = (block.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/)?.[1] || "").trim();
    const link = (block.match(/<link>([\s\S]*?)<\/link>/)?.[1] || "").trim();
    const pubDate = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] || "").trim();
    const source = (block.match(/<source[^>]*>([\s\S]*?)<\/source>/)?.[1] || "").trim();
    const desc = (block.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/)?.[1] || "").trim();

    if (title) {
      articles.push({
        title: title.replace(/<!\[CDATA\[|\]\]>/g, "").trim(),
        link: link || null,
        publishedAt: safeDateParse(pubDate),
        publisher: source || defaultSource,
        description: desc ? desc.replace(/<[^>]*>/g, "").slice(0, 200) : null,
      });
    }
  }
  return articles;
}

// ─── Macro source registry ───

/**
 * Trusted news sources we aggregate into the macro regime classifier.
 *
 * Sources are organised into TIER GROUPS (regulator / wire / indian) and
 * within each group split into PRIMARY and FALLBACK sources. fetchMacroHeadlines
 * runs in two passes: primaries first, then fallbacks ONLY if a tier-group's
 * primaries didn't meet the coverage target. This means that when Vercel's US
 * IPs get blocked by Reuters IN / Bloomberg Quint / RBI (a known issue), the
 * system automatically reaches for Reuters Business / AP Biz / FT Markets for
 * wires, PIB / MoSPI for regulators, and Hindu BusinessLine / Financial Express
 * for Indian dailies — without wasting requests in the common case.
 *
 * Tier A+ = official regulator/central bank (most authoritative)
 * Tier A  = global wire service (fast + credible on geopolitics)
 * Tier B  = Indian financial daily (high coverage, some noise)
 *
 * Group coverage target: ≥1 A+, ≥1 A, ≥2 B. If any group is short after
 * Pass 1, its fallbacks are fetched in Pass 2.
 */
export const TRUSTED_MACRO_SOURCES = [
  // ─── Tier A+: Regulators ──────────────────────────────────────
  { name: "RBI Press",         url: "https://www.rbi.org.in/Scripts/Bs_viewRSS.aspx?Id=Press",                                   tier: "A+", group: "regulator", primary: true  },
  { name: "SEBI Press",        url: "https://www.sebi.gov.in/sebirss.xml",                                                       tier: "A+", group: "regulator", primary: true  },
  { name: "PIB Economy",       url: "https://pib.gov.in/RssMain.aspx?ModId=8&Lang=1",                                            tier: "A+", group: "regulator", primary: false },
  { name: "MoSPI",             url: "https://mospi.gov.in/rss.xml",                                                              tier: "A+", group: "regulator", primary: false },

  // ─── Tier A: Global wires ─────────────────────────────────────
  { name: "Reuters India",     url: "https://feeds.reuters.com/reuters/INtopNews",                                               tier: "A",  group: "wire",      primary: true  },
  { name: "Bloomberg Quint",   url: "https://www.bqprime.com/feed",                                                              tier: "A",  group: "wire",      primary: true  },
  { name: "Reuters Business",  url: "https://feeds.reuters.com/reuters/businessNews",                                            tier: "A",  group: "wire",      primary: false },
  { name: "AP Business",       url: "https://rsshub.app/apnews/topics/apf-business",                                             tier: "A",  group: "wire",      primary: false },
  { name: "FT Markets",        url: "https://www.ft.com/markets?format=rss",                                                     tier: "A",  group: "wire",      primary: false },

  // ─── Tier B: Indian financial dailies ─────────────────────────
  { name: "Moneycontrol",      url: "https://www.moneycontrol.com/rss/MCtopnews.xml",                                            tier: "B",  group: "indian",    primary: true  },
  { name: "Business Standard", url: "https://www.business-standard.com/rss/markets-106.rss",                                     tier: "B",  group: "indian",    primary: true  },
  { name: "Economic Times",    url: "https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms",                      tier: "B",  group: "indian",    primary: true  },
  { name: "LiveMint",          url: "https://www.livemint.com/rss/markets",                                                      tier: "B",  group: "indian",    primary: true  },
  { name: "Hindu BusinessLine",url: "https://www.thehindubusinessline.com/markets/feeder/default.rss",                            tier: "B",  group: "indian",    primary: false },
  { name: "Financial Express", url: "https://www.financialexpress.com/market/feed/",                                             tier: "B",  group: "indian",    primary: false },
];

export const MACRO_COVERAGE_TARGET = { "A+": 1, "A": 1, "B": 2 };

const RSS_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
  "Accept": "application/rss+xml, application/xml, text/xml, */*",
};

// Per-source failure counter for observability. Exposed via /api/macro/debug.
export const macroSourceFailures = new Map();

export function bumpSourceFailure(name) {
  const count = (macroSourceFailures.get(name) || 0) + 1;
  macroSourceFailures.set(name, count);
  if (count === 3) {
    console.warn(`[MACRO] ⚠ Source "${name}" failed 3 times in a row. It may be blocked or down.`);
  }
}

/**
 * Fetch headlines from a single RSS source. Returns an array of headline
 * objects (empty array on any failure — never throws). Tracks failure
 * counters so chronic broken feeds bubble up in /api/macro/debug.
 */
async function fetchFromSource(src, cutoff) {
  try {
    const res = await fetchWithRetry(
      src.url,
      { headers: RSS_HEADERS },
      { retries: 1, timeoutMs: 8000 }
    );
    if (!res || !res.ok) {
      bumpSourceFailure(src.name);
      return { src, headlines: [], ok: false };
    }
    const xml = await res.text();
    const articles = parseRSS(xml, src.name);
    macroSourceFailures.set(src.name, 0); // success → reset
    const headlines = articles
      .map((a) => ({
        title: a.title,
        source: src.name,
        sourceTier: src.tier,
        group: src.group,
        publishedAt: a.publishedAt,
        url: a.link,
      }))
      .filter((h) => {
        if (!h.publishedAt) return true;
        const ts = new Date(h.publishedAt).getTime();
        return Number.isFinite(ts) && ts >= cutoff;
      });
    return { src, headlines, ok: headlines.length > 0 };
  } catch (err) {
    bumpSourceFailure(src.name);
    return { src, headlines: [], ok: false };
  }
}

/**
 * Fetch macro headlines from trusted sources using a two-pass strategy:
 *
 *   Pass 1 — fetch all PRIMARY sources in parallel.
 *   Check coverage per tier-group against MACRO_COVERAGE_TARGET.
 *   Pass 2 — for any tier-group that fell short, fetch that group's
 *            FALLBACK sources in parallel.
 *
 * This keeps steady-state cost low (primaries are the best feeds) while
 * automatically recovering on Vercel where Reuters IN / Bloomberg Quint /
 * RBI Press are blocked. Returns an object with headlines + sourceHealth
 * metadata so /api/macro/debug can expose exactly which feeds worked and
 * which fallbacks took over.
 *
 * Never throws — on total failure returns { headlines: [], ... } with a
 * fully populated sourceHealth map so the UI can surface the problem.
 */
export async function fetchMacroHeadlines({ hours = 48 } = {}) {
  const cutoff = Date.now() - hours * 3600 * 1000;
  const sourceHealth = {}; // name → "ok" | "ok-fallback" | "blocked" | "empty"
  const tierCoverage = { "A+": 0, "A": 0, "B": 0 };
  const fallbacksUsed = [];
  const allHeadlines = [];

  // ─── Pass 1: primaries ───
  const primaries = TRUSTED_MACRO_SOURCES.filter((s) => s.primary);
  const pass1 = await Promise.all(primaries.map((s) => fetchFromSource(s, cutoff)));

  for (const r of pass1) {
    if (r.ok) {
      sourceHealth[r.src.name] = "ok";
      tierCoverage[r.src.tier] = (tierCoverage[r.src.tier] || 0) + 1;
      allHeadlines.push(...r.headlines);
    } else {
      sourceHealth[r.src.name] = "blocked";
    }
  }

  // ─── Pass 2: fallbacks, only for tier-groups that fell short ───
  const shortGroups = new Set();
  for (const tier of Object.keys(MACRO_COVERAGE_TARGET)) {
    if (tierCoverage[tier] < MACRO_COVERAGE_TARGET[tier]) {
      shortGroups.add(tier);
    }
  }

  if (shortGroups.size > 0) {
    const fallbackCandidates = TRUSTED_MACRO_SOURCES.filter(
      (s) => !s.primary && shortGroups.has(s.tier)
    );
    if (fallbackCandidates.length > 0) {
      console.log(
        `[MACRO] Pass 1 short on tiers [${[...shortGroups].join(",")}] — ` +
        `trying ${fallbackCandidates.length} fallback source(s)`
      );
      const pass2 = await Promise.all(
        fallbackCandidates.map((s) => fetchFromSource(s, cutoff))
      );
      for (const r of pass2) {
        if (r.ok) {
          sourceHealth[r.src.name] = "ok-fallback";
          tierCoverage[r.src.tier] = (tierCoverage[r.src.tier] || 0) + 1;
          allHeadlines.push(...r.headlines);
          fallbacksUsed.push(r.src.name);
        } else {
          sourceHealth[r.src.name] = "blocked";
        }
      }
    }
  }

  // Mark any source we didn't touch as "skipped" so the debug view is complete
  for (const src of TRUSTED_MACRO_SOURCES) {
    if (!(src.name in sourceHealth)) sourceHealth[src.name] = "skipped";
  }

  // ─── Dedupe by normalized title prefix, sort newest first, cap at 60 ───
  const seen = new Set();
  const unique = [];
  for (const h of allHeadlines) {
    if (!h.title) continue;
    const key = h.title.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(h);
  }
  unique.sort((a, b) => {
    const da = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
    const db = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
    return db - da;
  });
  const top = unique.slice(0, 60);

  const okSources = Object.values(sourceHealth).filter((v) => v === "ok" || v === "ok-fallback").length;
  const fbStr = fallbacksUsed.length > 0 ? ` fallbacks-used=${fallbacksUsed.join(",")}` : "";
  console.log(
    `[MACRO] headlines=${top.length} sources=ok(${okSources}/${TRUSTED_MACRO_SOURCES.length}) ` +
    `tierCoverage={A+:${tierCoverage["A+"]},A:${tierCoverage["A"]},B:${tierCoverage["B"]}}${fbStr}`
  );

  Object.defineProperty(top, "meta", {
    value: { sourceHealth, tierCoverage, fallbacksUsed, okSources, totalSources: TRUSTED_MACRO_SOURCES.length },
    enumerable: false,
  });
  return top;
}
