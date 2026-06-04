import fs from "node:fs";
import path from "node:path";

const MONTHS_SHORT = {
  Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
  Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12",
};

function pad2(n) {
  return n < 10 ? `0${n}` : `${n}`;
}

export function todayIstIso(nowMs = Date.now()) {
  return new Date(nowMs + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}

export function addDaysIso(iso, days) {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function normalizeSymbol(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().toUpperCase();
  if (!s) return null;
  return s.replace(/\.(NS|BO|BSE)$/i, "");
}

export function parseMarketDate(raw) {
  if (!raw || typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s || s === "-") return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  const dmyDash = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (dmyDash && MONTHS_SHORT[dmyDash[2]]) {
    return `${dmyDash[3]}-${MONTHS_SHORT[dmyDash[2]]}-${pad2(Number(dmyDash[1]))}`;
  }

  const dmySpace = s.match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/);
  if (dmySpace && MONTHS_SHORT[dmySpace[2]]) {
    return `${dmySpace[3]}-${MONTHS_SHORT[dmySpace[2]]}-${pad2(Number(dmySpace[1]))}`;
  }

  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}

export function parseDividendAmount(raw, { sumAll = false } = {}) {
  if (raw == null) return null;
  const text = String(raw);
  const matches = [...text.matchAll(/(?:₹|Rs\.?|INR)\s*[-.:]*\s*(\d+(?:\.\d+)?)/gi)]
    .map((m) => Number(m[1]))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (matches.length === 0) return null;
  const value = sumAll ? matches.reduce((a, b) => a + b, 0) : matches[0];
  return Number(value.toFixed(4));
}

function dividendTypeFromText(raw) {
  const text = String(raw || "").toLowerCase();
  if (/special/.test(text)) return "special";
  if (/interim/.test(text)) return "interim";
  if (/final/.test(text)) return "final";
  return "annual";
}

function rowKey(row) {
  return `${row.symbol}|${row.ex_date}`;
}

function compactText(raw, max = 240) {
  if (!raw) return null;
  const text = String(raw).replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function readJsonSafe(file) {
  try {
    if (!file || !fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function growwCacheStatus(cache, { nowMs = Date.now(), maxAgeDays = 3 } = {}) {
  const fetchedAt = cache?.fetched_at || null;
  const fetchedMs = Date.parse(fetchedAt || "");
  const ageDays = Number.isFinite(fetchedMs)
    ? Math.round(((nowMs - fetchedMs) / 86_400_000) * 100) / 100
    : null;
  const usable = Number.isFinite(ageDays) && ageDays <= maxAgeDays;
  return {
    fetched_at: fetchedAt,
    age_days: ageDays,
    max_age_days: maxAgeDays,
    usable,
    reason: usable ? null : fetchedAt ? "stale" : "missing",
  };
}

export function extractGrowwDividendRows(cache, { todayIso, maxAgeDays = 3, nowMs = Date.now() } = {}) {
  const today = todayIso || todayIstIso(nowMs);
  const status = growwCacheStatus(cache, { nowMs, maxAgeDays });
  if (!cache?.by_ticker || !status.usable) return { rows: [], status };

  const seen = new Map();
  for (const [ticker, entry] of Object.entries(cache.by_ticker || {})) {
    const symbol = normalizeSymbol(entry?.nseScriptCode || ticker);
    if (!symbol) continue;
    for (const ev of entry?.events || []) {
      if (String(ev?.type || ev?.title || "").toUpperCase() !== "DIVIDEND") continue;
      const exDate = parseMarketDate(ev.ex_date || ev.primary_date);
      if (!exDate || exDate < today) continue;
      const dps = parseDividendAmount(ev.value);
      if (!Number.isFinite(dps) || dps <= 0) continue;
      const row = {
        symbol,
        ex_date: exDate,
        record_date: parseMarketDate(ev.record_date),
        pay_date: null,
        dps,
        dividend_type: dividendTypeFromText(ev.title || ev.value),
        announced_at_iso: parseMarketDate(ev.announcement_date),
        source: "groww-events",
        source_priority: 1,
        source_detail: compactText(ev.value || ev.title),
      };
      const key = `${row.symbol}|${row.ex_date}|${row.dps}|${row.record_date || ""}`;
      if (!seen.has(key)) seen.set(key, row);
    }
  }
  return {
    rows: [...seen.values()].sort(compareDividendRows),
    status,
  };
}

export function extractNseActionDividendRows(rawRows, { todayIso } = {}) {
  const today = todayIso || todayIstIso();
  const out = [];
  for (const r of rawRows || []) {
    if (!/dividend/i.test(r?.subject || "")) continue;
    const symbol = normalizeSymbol(r.symbol);
    const exDate = parseMarketDate(r.exDate);
    if (!symbol || !exDate || exDate < today) continue;
    const dps = parseDividendAmount(r.subject, { sumAll: true });
    if (!Number.isFinite(dps) || dps <= 0) continue;
    out.push({
      symbol,
      ex_date: exDate,
      record_date: parseMarketDate(r.recDate),
      pay_date: null,
      dps,
      dividend_type: dividendTypeFromText(r.subject),
      announced_at_iso: parseMarketDate(r.caBroadcastDate),
      source: "nse-actions",
      source_priority: 2,
      source_detail: compactText(r.subject),
    });
  }
  return dedupeSameSourceRows(out);
}

export function extractBseActionDividendRows(rawRows, { todayIso } = {}) {
  const today = todayIso || todayIstIso();
  const out = [];
  for (const r of rawRows || []) {
    const shortName = String(r?.short_name || "");
    if (!/dividend/i.test(r?.Purpose || "") || shortName.includes("#")) continue;
    const symbol = normalizeSymbol(shortName);
    const exDate = parseMarketDate(r.Ex_date);
    if (!symbol || !exDate || exDate < today) continue;
    const dps = parseDividendAmount(r.Purpose, { sumAll: true });
    if (!Number.isFinite(dps) || dps <= 0) continue;
    out.push({
      symbol,
      ex_date: exDate,
      record_date: parseMarketDate(r.RD_Date),
      pay_date: parseMarketDate(r.payment_date),
      dps,
      dividend_type: dividendTypeFromText(r.Purpose),
      announced_at_iso: null,
      source: "bse-actions",
      source_priority: 3,
      source_detail: compactText(r.Purpose),
    });
  }
  return dedupeSameSourceRows(out);
}

export function normalizeSwsConfirmedRows(rows, { todayIso } = {}) {
  const today = todayIso || todayIstIso();
  return (rows || [])
    .map((r) => ({
      ...r,
      symbol: normalizeSymbol(r.symbol),
      ex_date: parseMarketDate(r.ex_date),
      record_date: parseMarketDate(r.record_date),
      pay_date: parseMarketDate(r.pay_date),
      source: r.source || "sws-news",
      source_priority: 4,
    }))
    .filter((r) => r.symbol && r.ex_date && r.ex_date >= today && Number(r.dps) > 0)
    .sort(compareDividendRows);
}

function dedupeSameSourceRows(rows) {
  const grouped = new Map();
  for (const row of rows || []) {
    const key = `${row.source}|${row.symbol}|${row.ex_date}`;
    const bucket = grouped.get(key) || [];
    bucket.push(row);
    grouped.set(key, bucket);
  }

  const out = [];
  for (const bucket of grouped.values()) {
    if (bucket.length === 1) {
      out.push(bucket[0]);
      continue;
    }
    const first = bucket[0];
    const uniqueParts = new Map();
    for (const r of bucket) {
      uniqueParts.set(`${r.dps}|${r.source_detail || ""}`, r);
    }
    const parts = [...uniqueParts.values()];
    out.push({
      ...first,
      dps: Number(parts.reduce((sum, r) => sum + Number(r.dps || 0), 0).toFixed(4)),
      dividend_type: parts.some((r) => r.dividend_type === "special") ? "special" : first.dividend_type,
      source_detail: parts.map((r) => r.source_detail).filter(Boolean).join(" + "),
    });
  }
  return out.sort(compareDividendRows);
}

export function mergeConfirmedDividendRows(sourceRows, { growwUsable = true } = {}) {
  const priority = growwUsable
    ? ["groww-events", "nse-actions", "bse-actions", "sws-news"]
    : ["nse-actions", "bse-actions", "sws-news"];
  const rank = new Map(priority.map((source, i) => [source, i]));
  const sorted = (sourceRows || [])
    .filter((r) => r?.symbol && r?.ex_date && rank.has(r.source))
    .slice()
    .sort((a, b) => {
      const ra = rank.get(a.source) ?? 99;
      const rb = rank.get(b.source) ?? 99;
      if (ra !== rb) return ra - rb;
      return compareDividendRows(a, b);
    });

  const seen = new Map();
  for (const r of sorted) {
    const key = rowKey(r);
    if (!seen.has(key)) seen.set(key, { ...r, sources: [r.source] });
    else {
      const prior = seen.get(key);
      prior.sources = [...new Set([...(prior.sources || []), r.source])];
    }
  }
  return [...seen.values()].sort(compareDividendRows);
}

export function extractAwaitingDividendsFromDeepDir(deepDir, { todayIso } = {}) {
  if (!deepDir || !fs.existsSync(deepDir)) return [];
  const out = [];
  for (const filename of fs.readdirSync(deepDir).filter((f) => f.endsWith(".json"))) {
    const deep = readJsonSafe(path.join(deepDir, filename));
    if (!deep) continue;
    out.push(...extractAwaitingDividendsFromDeep(deep, {
      fallbackSymbol: path.basename(filename, ".json"),
      todayIso,
    }));
  }
  return dedupeAwaitingRows(out);
}

export function extractAwaitingDividendsFromDeep(deep, { fallbackSymbol } = {}) {
  const symbol = normalizeSymbol(deep?.overview?.ticker || deep?.ticker || deep?.symbol || fallbackSymbol);
  if (!symbol) return [];
  const news = Array.isArray(deep?.news) ? deep.news : Array.isArray(deep?.overview?.news) ? deep.overview.news : [];
  const out = [];
  for (const n of news) {
    const text = `${n?.title || ""} ${n?.body || ""}`;
    if (!/dividend/i.test(text)) continue;
    if (/ex[\s-]*date/i.test(text)) continue;
    if (!/(recommend|recommended|declared|approved|subject to.*shareholder|agm)/i.test(text)) continue;
    const dps = parseDividendAmount(n?.body || n?.title);
    if (!Number.isFinite(dps) || dps <= 0) continue;
    out.push({
      symbol,
      announced_at_iso: parseMarketDate(n?.date) || null,
      dps,
      dividend_type: dividendTypeFromText(text),
      status: "awaiting_ex_date",
      awaiting_type: /consider/i.test(text) && !/recommend|declared|approved/i.test(text) ? "board_review" : "recommended",
      source: "sws-news",
      source_detail: compactText(n?.title || n?.body),
    });
  }
  return out;
}

export function extractAwaitingDividendsFromNseAnnouncements(announcements) {
  const out = [];
  for (const a of announcements || []) {
    const text = a?.subject || "";
    if (!/dividend/i.test(text)) continue;
    if (/ex[\s-]*date|record\s+date/i.test(text)) continue;
    if (/if any/i.test(text)) continue;
    if (!/(recommend|recommended|declared|approved|to consider|consideration)/i.test(text)) continue;
    const dps = parseDividendAmount(text);
    if (!Number.isFinite(dps) || dps <= 0) continue;
    const symbol = normalizeSymbol(a.symbol);
    if (!symbol) continue;
    out.push({
      symbol,
      announced_at_iso: a.announced_at_iso || null,
      dps,
      dividend_type: dividendTypeFromText(text),
      status: "awaiting_ex_date",
      awaiting_type: /to consider|consideration/i.test(text) && !/recommend|declared|approved/i.test(text)
        ? "board_review"
        : "recommended",
      source: "nse-announcements",
      source_detail: compactText(text),
    });
  }
  return dedupeAwaitingRows(out);
}

export function mergeAwaitingDividendRows(rows, confirmedRows) {
  const confirmedSymbols = new Set((confirmedRows || []).map((r) => normalizeSymbol(r.symbol)).filter(Boolean));
  return dedupeAwaitingRows((rows || []).filter((r) => !confirmedSymbols.has(normalizeSymbol(r.symbol))));
}

function dedupeAwaitingRows(rows) {
  const seen = new Map();
  for (const r of rows || []) {
    const sym = normalizeSymbol(r.symbol);
    if (!sym) continue;
    const key = `${sym}|${r.dps ?? ""}`;
    const prior = seen.get(key);
    const row = { ...r, symbol: sym };
    if (!prior || String(row.announced_at_iso || "") > String(prior.announced_at_iso || "")) {
      seen.set(key, row);
    }
  }
  return [...seen.values()].sort((a, b) => {
    const da = a.announced_at_iso || "9999-12-31";
    const db = b.announced_at_iso || "9999-12-31";
    if (da !== db) return da < db ? 1 : -1;
    return a.symbol.localeCompare(b.symbol);
  });
}

export function compareDividendRows(a, b) {
  if (a.ex_date !== b.ex_date) return a.ex_date < b.ex_date ? -1 : 1;
  return String(a.symbol || "").localeCompare(String(b.symbol || ""));
}

export function buildPreservedDividendPayload(prior, { reason, attemptedCounts, todayIso } = {}) {
  if (!prior || !Array.isArray(prior.dividends) || prior.dividends.length === 0) return null;
  return {
    ...prior,
    preserved_from_prior: true,
    preserved_at: new Date().toISOString(),
    today_iso: todayIso || prior.today_iso || todayIstIso(),
    preservation: {
      reason,
      attempted_counts: attemptedCounts || null,
      prior_built_at: prior.built_at || null,
      prior_dividend_count: prior.dividends.length,
    },
  };
}
