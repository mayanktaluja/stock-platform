#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractAllUpcomingDividends } from "../services/dividends/swsDividendsExtractor.js";
import {
  addDaysIso,
  buildPreservedDividendPayload,
  extractAwaitingDividendsFromDeepDir,
  extractAwaitingDividendsFromNseAnnouncements,
  extractBseActionDividendRows,
  extractGrowwDividendRows,
  extractNseActionDividendRows,
  mergeAwaitingDividendRows,
  mergeConfirmedDividendRows,
  normalizeSwsConfirmedRows,
  todayIstIso,
} from "../services/dividends/dividendPipeline.js";
import { nseGet } from "../nse.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DEEP_DIR = process.env.SWS_DIVIDENDS_DEEP_DIR || path.join(ROOT, "data", "sws", "deep");
const OUT_PATH = process.env.SWS_DIVIDENDS_OUT_PATH || path.join(ROOT, "data", "catalysts", "dividends-upcoming.json");
const GROWW_PATH = process.env.SWS_DIVIDENDS_GROWW_CACHE || path.join(ROOT, "data", "sws", "groww-stock-latest.json");
const NSE_ANN_PATH = process.env.SWS_DIVIDENDS_NSE_ANNOUNCEMENTS || path.join(ROOT, "data", "catalysts", "nse-announcements-rolling.json");
const WINDOW_DAYS = Number(process.env.SWS_DIVIDENDS_WINDOW_DAYS || 30);
const GROWW_MAX_AGE_DAYS = Number(process.env.SWS_DIVIDENDS_GROWW_MAX_AGE_DAYS || 3);

function writeAtomic(target, payload) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
  fs.renameSync(tmp, target);
}

function readJsonSafe(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function toNseParam(iso) {
  const [yyyy, mm, dd] = String(iso || "").split("-");
  return yyyy && mm && dd ? `${dd}-${mm}-${yyyy}` : "";
}

function toBseParam(iso) {
  return String(iso || "").replace(/-/g, "");
}

async function fetchNseActions({ fromIso, toIso }) {
  if (process.env.SWS_DIVIDENDS_SKIP_LIVE_ACTIONS === "1") return null;
  const path = `/api/corporates-corporateActions?index=equities&from_date=${toNseParam(fromIso)}&to_date=${toNseParam(toIso)}`;
  try {
    const data = await nseGet(path, "https://www.nseindia.com/companies-listing/corporate-filings-actions");
    return Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : null;
  } catch (err) {
    console.warn(`[dividends] NSE actions fetch failed: ${err.message}`);
    return null;
  }
}

async function fetchBseActions({ fromIso, toIso }) {
  if (process.env.SWS_DIVIDENDS_SKIP_LIVE_ACTIONS === "1") return null;
  const url =
    `https://api.bseindia.com/BseIndiaAPI/api/DefaultData/w?Fdate=${toBseParam(fromIso)}` +
    `&Purposecode=P9&TDate=${toBseParam(toIso)}&ddlcategorys=E&ddlindustrys=&scripcode=&segment=Equity&strSearch=S`;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        Accept: "application/json,text/plain,*/*",
        Referer: "https://www.bseindia.com/corporates/corporate_act.aspx",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return Array.isArray(data) ? data : null;
  } catch (err) {
    console.warn(`[dividends] BSE actions fetch failed: ${err.message}`);
    return null;
  }
}

async function main() {
  const today = todayIstIso();
  const toIso = addDaysIso(today, WINDOW_DAYS);
  console.log(`[dividends] building upcoming dividends (today=${today}, to=${toIso})...`);

  if (!fs.existsSync(DEEP_DIR)) {
    console.error(`[dividends] deep dir missing: ${DEEP_DIR}`);
    process.exitCode = 75;
    return;
  }

  const growwCache = readJsonSafe(GROWW_PATH);
  const groww = extractGrowwDividendRows(growwCache, {
    todayIso: today,
    maxAgeDays: GROWW_MAX_AGE_DAYS,
  });
  groww.rows = groww.rows.filter((r) => r.ex_date <= toIso);
  console.log(
    `[dividends] Groww confirmed rows=${groww.rows.length} ` +
    `(usable=${groww.status.usable}, age_days=${groww.status.age_days ?? "?"})`,
  );

  const [nseRaw, bseRaw] = await Promise.all([
    fetchNseActions({ fromIso: today, toIso }),
    fetchBseActions({ fromIso: today, toIso }),
  ]);
  const nseRows = extractNseActionDividendRows(nseRaw || [], { todayIso: today });
  const bseRows = extractBseActionDividendRows(bseRaw || [], { todayIso: today });
  const nseRowsWindow = nseRows.filter((r) => r.ex_date <= toIso);
  const bseRowsWindow = bseRows.filter((r) => r.ex_date <= toIso);
  console.log(`[dividends] NSE confirmed rows=${nseRowsWindow.length}; BSE confirmed rows=${bseRowsWindow.length}`);

  const swsRows = normalizeSwsConfirmedRows(
    extractAllUpcomingDividends({ deepDir: DEEP_DIR, todayIso: today }),
    { todayIso: today },
  ).filter((r) => r.ex_date <= toIso);
  console.log(`[dividends] SWS confirmed fallback rows=${swsRows.length}`);

  const dividends = mergeConfirmedDividendRows(
    [...groww.rows, ...nseRowsWindow, ...bseRowsWindow, ...swsRows],
    { growwUsable: groww.status.usable },
  );
  console.log(`[dividends] merged confirmed rows=${dividends.length}`);

  const nseAnnouncements = readJsonSafe(NSE_ANN_PATH)?.announcements || [];
  const awaiting = mergeAwaitingDividendRows([
    ...extractAwaitingDividendsFromDeepDir(DEEP_DIR, { todayIso: today }),
    ...extractAwaitingDividendsFromNseAnnouncements(nseAnnouncements),
  ], dividends);
  console.log(`[dividends] awaiting ex-date rows=${awaiting.length}`);

  const sourceCounts = {
    groww_events: groww.rows.length,
    nse_actions: nseRowsWindow.length,
    bse_actions: bseRowsWindow.length,
    sws_news_confirmed: swsRows.length,
    awaiting_ex_date: awaiting.length,
    nse_live_fetch_ok: Array.isArray(nseRaw),
    bse_live_fetch_ok: Array.isArray(bseRaw),
  };

  if (dividends.length === 0 || (groww.status.usable && groww.rows.length === 0)) {
    const prior = readJsonSafe(OUT_PATH);
    const preserved = buildPreservedDividendPayload(prior, {
      reason: dividends.length === 0 ? "zero-confirmed-dividends" : "zero-groww-dividends",
      attemptedCounts: sourceCounts,
      todayIso: today,
    });
    if (preserved) {
      writeAtomic(OUT_PATH, preserved);
      console.warn(`[dividends] suspicious output — preserved prior non-empty cache at ${OUT_PATH}`);
      process.exitCode = 2;
      return;
    }
    console.error(`[dividends] suspicious output and no prior non-empty cache to preserve`);
    process.exitCode = 75;
    return;
  }

  const payload = {
    schema_version: "dividends-upcoming-v2",
    built_at: new Date().toISOString(),
    today_iso: today,
    window_days: WINDOW_DAYS,
    source_counts: sourceCounts,
    groww_status: groww.status,
    dividend_count: dividends.length,
    dividends,
    awaiting_ex_date_count: awaiting.length,
    awaiting_ex_date: awaiting,
  };

  writeAtomic(OUT_PATH, payload);
  console.log(`[dividends] wrote ${OUT_PATH}`);
  process.exitCode = 0;
}

try {
  await main();
} catch (err) {
  console.error(`[dividends] FATAL:`, err.stack || err.message);
  process.exitCode = 1;
}
