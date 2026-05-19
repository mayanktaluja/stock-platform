import fs from "node:fs";
import path from "node:path";

const MONTHS = {
  january: 1, jan: 1,
  february: 2, feb: 2,
  march: 3, mar: 3,
  april: 4, apr: 4,
  may: 5,
  june: 6, jun: 6,
  july: 7, jul: 7,
  august: 8, aug: 8,
  september: 9, sept: 9, sep: 9,
  october: 10, oct: 10,
  november: 11, nov: 11,
  december: 12, dec: 12,
};

function pad2(n) {
  return n < 10 ? `0${n}` : `${n}`;
}

export function parseEnglishDate(s) {
  if (!s || typeof s !== "string") return null;
  const m = s.match(/([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/);
  if (!m) return null;
  const month = MONTHS[m[1].toLowerCase()];
  if (!month) return null;
  const day = Number(m[2]);
  const year = Number(m[3]);
  if (!Number.isFinite(day) || !Number.isFinite(year) || day < 1 || day > 31) return null;
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

const DIVIDEND_KEYDEV_TYPES = new Set(["45", "46", "47"]);

function isDividendNewsEntry(news) {
  if (!news || typeof news !== "object") return false;
  if (news.keyDevTypeId && DIVIDEND_KEYDEV_TYPES.has(String(news.keyDevTypeId))) return true;
  const text = `${news.title || ""} ${news.body || ""}`;
  return /announces?\s+[A-Za-z]*\s*dividend/i.test(text);
}

export function extractDividendFromNewsBody(body) {
  if (!body || typeof body !== "string") return null;
  const dps = body.match(/of\s+INR\s+(\d+(?:\.\d+)?)\s+per\s+share/i);
  const ex = body.match(/ex[\s-]*date\s+on\s+([A-Za-z]+\s+\d{1,2},?\s+\d{4})/i);
  const rec = body.match(/record\s+date\s+on\s+([A-Za-z]+\s+\d{1,2},?\s+\d{4})/i);
  const pay = body.match(/payable\s+on\s+([A-Za-z]+\s+\d{1,2},?\s+\d{4})/i);
  const type = body.match(/announced\s+([A-Za-z]+)\s+dividend/i);

  const exDate = ex ? parseEnglishDate(ex[1]) : null;
  if (!exDate) return null;

  const dpsValue = dps ? Number(dps[1]) : null;
  if (!Number.isFinite(dpsValue) || dpsValue <= 0) return null;

  return {
    dps: dpsValue,
    ex_date: exDate,
    record_date: rec ? parseEnglishDate(rec[1]) : null,
    pay_date: pay ? parseEnglishDate(pay[1]) : null,
    dividend_type: type ? type[1].toLowerCase() : "annual",
  };
}

function tickerFromFilename(filename) {
  return path.basename(filename, ".json");
}

function readDeepFile(filepath) {
  try {
    return JSON.parse(fs.readFileSync(filepath, "utf8"));
  } catch {
    return null;
  }
}

function symbolFromDeep(deep, fallback) {
  if (!deep) return fallback;
  return (
    deep.overview?.ticker ||
    deep.ticker ||
    deep.symbol ||
    fallback ||
    null
  );
}

function todayIstIso() {
  const ist = new Date(Date.now() + 5.5 * 3600 * 1000);
  return ist.toISOString().slice(0, 10);
}

export function extractDividendsFromDeep(deep, { todayIso, filename } = {}) {
  const today = todayIso || todayIstIso();
  const news = Array.isArray(deep?.news) ? deep.news : Array.isArray(deep?.overview?.news) ? deep.overview.news : null;
  if (!news) return [];
  const symbol = symbolFromDeep(deep, filename ? tickerFromFilename(filename) : null);
  if (!symbol) return [];

  const out = [];
  for (const n of news) {
    if (!isDividendNewsEntry(n)) continue;
    const parsed = extractDividendFromNewsBody(n.body);
    if (!parsed) continue;
    if (parsed.ex_date < today) continue;
    out.push({
      symbol: String(symbol).toUpperCase(),
      ex_date: parsed.ex_date,
      record_date: parsed.record_date,
      pay_date: parsed.pay_date,
      dps: parsed.dps,
      dividend_type: parsed.dividend_type,
      announced_at_iso: n.date ? String(n.date).slice(0, 10) : null,
      key_dev_type_id: n.keyDevTypeId ? String(n.keyDevTypeId) : null,
      source: "sws-news",
    });
  }
  return out;
}

export function extractAllUpcomingDividends({ deepDir, todayIso } = {}) {
  const dir = deepDir;
  if (!dir || !fs.existsSync(dir)) return [];
  const today = todayIso || todayIstIso();

  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  const all = [];
  for (const f of files) {
    const deep = readDeepFile(path.join(dir, f));
    if (!deep) continue;
    const rows = extractDividendsFromDeep(deep, { todayIso: today, filename: f });
    for (const r of rows) all.push(r);
  }

  const seen = new Map();
  for (const r of all) {
    const key = `${r.symbol}|${r.ex_date}`;
    const prior = seen.get(key);
    if (!prior) {
      seen.set(key, r);
      continue;
    }
    const priorAnn = prior.announced_at_iso || "";
    const newAnn = r.announced_at_iso || "";
    if (newAnn > priorAnn) seen.set(key, r);
  }

  return [...seen.values()].sort((a, b) => {
    if (a.ex_date !== b.ex_date) return a.ex_date < b.ex_date ? -1 : 1;
    return a.symbol.localeCompare(b.symbol);
  });
}
