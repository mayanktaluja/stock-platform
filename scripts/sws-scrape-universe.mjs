#!/usr/bin/env node
// SWS India universe scraper — manages all 25 sectors × 4 market-cap = 100 page queue.
//
// CLI:
//   node scripts/sws-scrape-universe.mjs --status        print progress
//   node scripts/sws-scrape-universe.mjs --next          print next URL to scrape
//   node scripts/sws-scrape-universe.mjs --record <sector> <mcap> < stocks.json
//                                                         save extracted stocks, mark page done
//   node scripts/sws-scrape-universe.mjs --reset          wipe progress (start over)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT  = path.resolve(__dirname, "..");
const DATA_DIR   = path.join(REPO_ROOT, "data/sws");
const OUT_PATH   = path.join(DATA_DIR, "universe_scraped.json");
const PROG_PATH  = path.join(DATA_DIR, "scrape-universe-progress.json");

const SECTORS = [
  "automobiles","banks","capital-goods","commercial-services","consumer-durables",
  "consumer-retailing","consumer-services","diversified-financials","energy",
  "food-beverage-tobacco","healthcare","household","insurance","materials","media",
  "pharmaceuticals-biotech","real-estate","real-estate-management-and-development",
  "retail","semiconductors","software","tech","telecom","transportation","utilities"
];
const MCAPS = ["market-cap-large","market-cap-mid","market-cap-small","market-cap-micro"];

// All 100 pages in order: large-cap sectors first (highest value), then mid, small, micro
export const ALL_PAGES = MCAPS.flatMap(mcap => SECTORS.map(sector => ({ sector, mcap })));

export function pageKey(sector, mcap) { return `${sector}/${mcap}`; }
export function pageUrl(sector, mcap) {
  return `https://simplywall.st/stocks/in/${sector}/${mcap}`;
}

function loadProgress() {
  if (!fs.existsSync(PROG_PATH)) return { done: [], stocks: [] };
  try { return JSON.parse(fs.readFileSync(PROG_PATH, "utf-8")); }
  catch { return { done: [], stocks: [] }; }
}

function saveProgress(prog) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = PROG_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(prog, null, 2));
  fs.renameSync(tmp, PROG_PATH);
}

function saveScraped(stocks) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = OUT_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(stocks, null, 2));
  fs.renameSync(tmp, OUT_PATH);
}

async function recordPage(sector, mcap) {
  const raw = await new Promise((res, rej) => {
    let d = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", c => d += c);
    process.stdin.on("end", () => res(d));
    process.stdin.on("error", rej);
  });

  let incoming;
  try { incoming = JSON.parse(raw); }
  catch (e) { console.error("stdin is not valid JSON:", e.message); process.exit(1); }

  const prog = loadProgress();
  const key = pageKey(sector, mcap);

  // Dedupe by sws_url
  const seenUrls = new Set(prog.stocks.map(s => s.sws_url));
  let added = 0;
  for (const s of incoming) {
    if (!s.sws_url || seenUrls.has(s.sws_url)) continue;
    prog.stocks.push(s);
    seenUrls.add(s.sws_url);
    added++;
  }

  if (!prog.done.includes(key)) prog.done.push(key);
  saveProgress(prog);
  saveScraped(prog.stocks);

  const remaining = ALL_PAGES.filter(p => !prog.done.includes(pageKey(p.sector, p.mcap)));
  console.log(`✓ ${key}: +${added} new stocks (total: ${prog.stocks.length}, remaining pages: ${remaining.length})`);
  if (remaining.length === 0) {
    console.log("All 100 pages done. universe_scraped.json ready.");
    console.log("Next: node scripts/sws-merge-universe.mjs --dry-run");
  } else {
    console.log(`Next page: ${pageUrl(remaining[0].sector, remaining[0].mcap)}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (cmd === "--reset") {
    if (fs.existsSync(PROG_PATH)) fs.unlinkSync(PROG_PATH);
    if (fs.existsSync(OUT_PATH))   fs.unlinkSync(OUT_PATH);
    console.log("Reset complete.");
    return;
  }

  if (cmd === "--record") {
    const sector = args[1], mcap = args[2];
    if (!sector || !mcap) { console.error("Usage: --record <sector> <mcap>"); process.exit(1); }
    await recordPage(sector, mcap);
    return;
  }

  if (cmd === "--mark-done") {
    const sector = args[1], mcap = args[2];
    if (!sector || !mcap) { console.error("Usage: --mark-done <sector> <mcap>"); process.exit(1); }
    const prog = loadProgress();
    const key = pageKey(sector, mcap);
    if (!prog.done.includes(key)) prog.done.push(key);
    saveProgress(prog);
    console.log(`Marked done: ${key}`);
    return;
  }

  const prog = loadProgress();
  const done = new Set(prog.done);
  const remaining = ALL_PAGES.filter(p => !done.has(pageKey(p.sector, p.mcap)));

  if (cmd === "--next") {
    if (remaining.length === 0) { console.log("ALL_DONE"); return; }
    const next = remaining[0];
    console.log(pageUrl(next.sector, next.mcap));
    return;
  }

  // Default: --status
  console.log(`Pages done:      ${prog.done.length} / ${ALL_PAGES.length}`);
  console.log(`Stocks collected: ${prog.stocks.length}`);
  if (remaining.length > 0) {
    console.log(`Next page:       ${pageUrl(remaining[0].sector, remaining[0].mcap)}`);
    console.log(`Remaining pages: ${remaining.length}`);
    console.log(`\nFirst 10 remaining:`);
    remaining.slice(0, 10).forEach(p => console.log(`  ${pageUrl(p.sector, p.mcap)}`));
  } else {
    console.log("All pages done!");
  }
}

main().catch(e => { console.error(e); process.exit(1); });
