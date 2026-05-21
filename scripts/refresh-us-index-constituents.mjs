/**
 * Refresh data/sws-us/us-index-constituents.json — the membership lists behind
 * the US Picks universe dropdown (S&P 500 / NASDAQ-100 / Russell 2000 / Dow 30).
 *
 * Mirrors scripts/refresh-nse-index-constituents.mjs: runs LOCALLY and commits
 * the JSON (Vercel datacenter IPs are unreliable against these sources — same
 * constraint as the NSE list; the server only ever READS the committed file).
 *
 * Each index is fetched independently with a count sanity-gate; on fetch/parse
 * failure (or an implausible count) that index is written EMPTY so the dropdown
 * option degrades gracefully (disabled) rather than the whole refresh failing.
 *
 * Run: node scripts/refresh-us-index-constituents.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = path.join(__dirname, "..", "data", "sws-us", "us-index-constituents.json");
const UA = "Mozilla/5.0 (compatible; starbhai-index-refresh/1.0)";

async function fetchText(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

// Wikipedia symbol cells on these pages link the ticker to its exchange quote
// page via <a class="external text" ...>TICKER</a>. Pull those, scoped to the
// constituents/components <table> so we don't sweep up unrelated external links.
function extractWikiSymbols(html, { tableMarker } = {}) {
  let scope = html;
  if (tableMarker) {
    const i = html.indexOf(tableMarker);
    if (i >= 0) scope = html.slice(i);
    const end = scope.indexOf("</table>");
    if (end >= 0) scope = scope.slice(0, end);
  }
  const out = new Set();
  // S&P 500 / Dow 30: ticker is an external-text link to the exchange quote page.
  const reLink = /<a [^>]*class="external text"[^>]*>([A-Z][A-Z.\-]{0,6})<\/a>/g;
  let m;
  while ((m = reLink.exec(scope))) out.add(m[1].trim().toUpperCase());
  // Nasdaq-100: ticker is a plain first-column cell — <tr> <td>ADBE</td> <td>…
  const reCell = /<tr>\s*<td>\s*([A-Z][A-Z.\-]{0,6})\s*<\/td>/g;
  while ((m = reCell.exec(scope))) out.add(m[1].trim().toUpperCase());
  return [...out];
}

// Each source returns { key, fetch: async () => string[], min, max }.
const SOURCES = [
  {
    key: "sp500",
    min: 480, max: 520,
    fetch: async () => {
      const html = await fetchText("https://en.wikipedia.org/wiki/List_of_S%26P_500_companies");
      return extractWikiSymbols(html, { tableMarker: 'id="constituents"' });
    },
  },
  {
    key: "nasdaq100",
    min: 90, max: 110,
    fetch: async () => {
      const html = await fetchText("https://en.wikipedia.org/wiki/Nasdaq-100");
      return extractWikiSymbols(html, { tableMarker: 'id="constituents"' });
    },
  },
  {
    key: "dow30",
    min: 28, max: 32,
    fetch: async () => {
      const html = await fetchText("https://en.wikipedia.org/wiki/Dow_Jones_Industrial_Average");
      return extractWikiSymbols(html, { tableMarker: 'id="constituents"' });
    },
  },
  {
    key: "russell2000",
    min: 1500, max: 2100,
    fetch: async () => {
      // iShares IWM holdings CSV (the de-facto Russell 2000 proxy). Column 1 = Ticker.
      const url =
        "https://www.ishares.com/us/products/239710/ishares-russell-2000-etf/1467271812596.ajax?fileType=csv&fileName=IWM_holdings&dataType=fund";
      const csv = await fetchText(url);
      const out = new Set();
      for (const line of csv.split(/\r?\n/)) {
        const m = line.match(/^"?([A-Z][A-Z.\-]{0,6})"?,/);
        if (m && m[1] !== "Ticker") out.add(m[1].toUpperCase());
      }
      return [...out];
    },
  },
];

async function main() {
  const result = { fetched_at: new Date().toISOString(), source: "wikipedia + ishares (IWM)", counts: {} };
  const prev = fs.existsSync(OUT_PATH) ? JSON.parse(fs.readFileSync(OUT_PATH, "utf-8")) : {};
  for (const src of SOURCES) {
    try {
      const list = await src.fetch();
      if (list.length < src.min || list.length > src.max) {
        throw new Error(`implausible count ${list.length} (want ${src.min}-${src.max})`);
      }
      result[src.key] = list.sort();
      result.counts[src.key] = list.length;
      console.log(`[us-index] ${src.key}: ${list.length}`);
    } catch (err) {
      // Keep the previous good list if we have one; else empty (option disabled).
      const fallback = Array.isArray(prev[src.key]) ? prev[src.key] : [];
      result[src.key] = fallback;
      result.counts[src.key] = fallback.length;
      console.warn(`[us-index] ${src.key} FAILED (${err.message}) → kept ${fallback.length} prior`);
    }
  }
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  const tmp = `${OUT_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(result, null, 2));
  fs.renameSync(tmp, OUT_PATH);
  console.log(`[us-index] wrote ${OUT_PATH}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
