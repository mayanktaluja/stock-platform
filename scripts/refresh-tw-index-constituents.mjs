/**
 * Refresh data/sws-tw/tw-index-constituents.json — the membership lists behind
 * the Taiwan Picks universe dropdown (Taiwan 50 / Taiwan Mid-Cap 100 / TPEx 50 /
 * TWSE all).
 *
 * Same local-run + commit + empty-fallback contract as the US/KR refreshers (the
 * server only READS the committed file). Taiwan index constituent lists are NOT
 * available from a stable English source, so this ships the scaffolding + count
 * gates and each index falls back to EMPTY ([]) — the dropdown option degrades to
 * disabled, exactly like the NSE/US pattern. Wire a TWSE/TPEx OpenAPI feed (or an
 * 0050/0051-style ETF holdings file) locally to populate them, then commit.
 *
 * Codes are bare 4-digit (2330); the server's TW normaliser strips the
 * .TW/.TWO suffix from pick rows before matching.
 *
 * Run: node scripts/refresh-tw-index-constituents.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = path.join(__dirname, "..", "data", "sws-tw", "tw-index-constituents.json");
const UA = "Mozilla/5.0 (compatible; starbhai-index-refresh/1.0)";

async function fetchText(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

// TWSE/TPEx codes are 4 digits. Scope to a constituents/components <table> when
// a source is wired so we don't sweep up unrelated 4-digit numbers.
function extractTwCodes(html) {
  let scope = html;
  const i = html.indexOf('id="constituents"');
  if (i >= 0) {
    scope = html.slice(i);
    const end = scope.indexOf("</table>");
    if (end >= 0) scope = scope.slice(0, end);
  }
  return [...new Set([...scope.matchAll(/>(\d{4})</g)].map((m) => m[1]))];
}

// { key, fetch, min, max }. No stable English source today → each currently
// throws and ships [] (option disabled). Replace the fetch bodies with a TWSE/
// TPEx feed locally to populate; the count gate guards a garbled response.
const SOURCES = [
  {
    key: "taiwan50", min: 45, max: 55,
    fetch: async () => extractTwCodes(await fetchText("https://en.wikipedia.org/wiki/FTSE_TWSE_Taiwan_50_Index")),
  },
  {
    key: "taiwanMidcap100", min: 90, max: 110,
    fetch: async () => { throw new Error("no clean English source — wire a TWSE feed"); },
  },
  {
    key: "tpex50", min: 45, max: 55,
    fetch: async () => { throw new Error("no clean English source — wire a TPEx feed"); },
  },
  {
    key: "twse", min: 800, max: 1200,
    fetch: async () => { throw new Error("no clean English source — wire a TWSE feed"); },
  },
];

async function main() {
  const result = { fetched_at: new Date().toISOString(), source: "twse/tpex (wire locally)", counts: {} };
  const prev = fs.existsSync(OUT_PATH) ? JSON.parse(fs.readFileSync(OUT_PATH, "utf-8")) : {};
  for (const src of SOURCES) {
    try {
      const list = await src.fetch();
      if (list.length < src.min || list.length > src.max) {
        throw new Error(`implausible count ${list.length} (want ${src.min}-${src.max})`);
      }
      result[src.key] = list.sort();
      result.counts[src.key] = list.length;
      console.log(`[tw-index] ${src.key}: ${list.length}`);
    } catch (err) {
      const fallback = Array.isArray(prev[src.key]) ? prev[src.key] : [];
      result[src.key] = fallback;
      result.counts[src.key] = fallback.length;
      console.warn(`[tw-index] ${src.key} FAILED (${err.message}) → kept ${fallback.length} prior`);
    }
  }
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  const tmp = `${OUT_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(result, null, 2));
  fs.renameSync(tmp, OUT_PATH);
  console.log(`[tw-index] wrote ${OUT_PATH}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
