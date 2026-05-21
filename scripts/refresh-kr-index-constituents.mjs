/**
 * Refresh data/sws-kr/kr-index-constituents.json — the membership lists behind
 * the Korea Picks universe dropdown (KOSPI 200 / KOSDAQ 150 / KRX 300 / KOSPI all).
 *
 * Mirrors scripts/refresh-us-index-constituents.mjs: runs LOCALLY and commits the
 * JSON (the server only READS the committed file). Korea index pages in English
 * are sparse, so each index is fetched independently with a count sanity-gate and
 * an EMPTY fallback — an index with no usable source ships [] and its dropdown
 * option degrades gracefully (disabled), exactly like the NSE/US pattern.
 *
 * KOSPI 200 sources cleanly from Wikipedia. KOSDAQ 150 / KRX 300 are best-effort
 * (commonly empty here); KOSPI(all) has no clean English source — wire a local KRX
 * OpenAPI feed if you need those populated. Codes are bare 6-digit (005930); the
 * server's KR normaliser strips the .KS/.KQ suffix from pick rows before matching.
 *
 * Run: node scripts/refresh-kr-index-constituents.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = path.join(__dirname, "..", "data", "sws-kr", "kr-index-constituents.json");
const UA = "Mozilla/5.0 (compatible; starbhai-index-refresh/1.0)";

async function fetchText(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

// KRX codes are 6 digits. Scope to the constituents/components <table> so we
// don't sweep up unrelated 6-digit numbers (dates, index values) on the page.
function extractKrCodes(html) {
  let scope = html;
  const i = html.indexOf('id="constituents"');
  if (i >= 0) {
    scope = html.slice(i);
    const end = scope.indexOf("</table>");
    if (end >= 0) scope = scope.slice(0, end);
  }
  return [...new Set([...scope.matchAll(/>(\d{6})</g)].map((m) => m[1]))];
}

// { key, fetch: async () => string[], min, max }. min/max gate against a garbled
// fetch (an error page parses to ~0 codes; a layout change to thousands).
const SOURCES = [
  {
    key: "kospi200", min: 180, max: 210,
    fetch: async () => extractKrCodes(await fetchText("https://en.wikipedia.org/wiki/KOSPI_200")),
  },
  {
    key: "kosdaq150", min: 130, max: 170,
    fetch: async () => extractKrCodes(await fetchText("https://en.wikipedia.org/wiki/KOSDAQ_150")),
  },
  {
    key: "krx300", min: 280, max: 320,
    fetch: async () => extractKrCodes(await fetchText("https://en.wikipedia.org/wiki/KRX_300")),
  },
  {
    key: "kospi", min: 600, max: 1100,
    fetch: async () => { throw new Error("no clean English source — populate from a local KRX feed"); },
  },
];

async function main() {
  const result = { fetched_at: new Date().toISOString(), source: "wikipedia (KOSPI 200 etc.)", counts: {} };
  const prev = fs.existsSync(OUT_PATH) ? JSON.parse(fs.readFileSync(OUT_PATH, "utf-8")) : {};
  for (const src of SOURCES) {
    try {
      const list = await src.fetch();
      if (list.length < src.min || list.length > src.max) {
        throw new Error(`implausible count ${list.length} (want ${src.min}-${src.max})`);
      }
      result[src.key] = list.sort();
      result.counts[src.key] = list.length;
      console.log(`[kr-index] ${src.key}: ${list.length}`);
    } catch (err) {
      const fallback = Array.isArray(prev[src.key]) ? prev[src.key] : [];
      result[src.key] = fallback;
      result.counts[src.key] = fallback.length;
      console.warn(`[kr-index] ${src.key} FAILED (${err.message}) → kept ${fallback.length} prior`);
    }
  }
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  const tmp = `${OUT_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(result, null, 2));
  fs.renameSync(tmp, OUT_PATH);
  console.log(`[kr-index] wrote ${OUT_PATH}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
