/**
 * NSE REG_IND surveillance CSV fetcher — the cookie-less fallback for the
 * `/api/reportASM` + `/api/reportGSM` JSON endpoints.
 *
 * NSE publishes a daily SEBI-standardised consolidated surveillance file that
 * carries the cautionary indicators (ASM long-term / short-term stage, GSM
 * stage, ESM, ...) for every scrip, one row per security:
 *
 *   https://nsearchives.nseindia.com/content/cm/REG_IND<DDMMYY>.csv
 *
 * nsearchives is the same static, cookie-less host the repo already fetches
 * reliably for index constituents and F&O bhavcopies, so when the JSON report
 * endpoints break (as they did 2026-07-09) this path keeps surveillance data
 * flowing. It runs from any IP — no cookie dance.
 *
 * Everything here is pure fetch + parse and NEVER throws to the caller. The
 * column headers are matched by regex (not fixed positions) because NSE has
 * historically drifted the exact header text; `parseRegIndCsv` returns the
 * matched column map so a diagnostic can surface drift.
 */

const NSE_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const REGIND_BASE = "https://nsearchives.nseindia.com/content/cm";

function pad2(n) {
  return String(n).padStart(2, "0");
}

/**
 * The IST calendar date for a given instant, as {y, m, d} (numbers). NSE
 * stamps the file name in Asia/Kolkata, so we must not use UTC — near
 * midnight UTC the day would be off by one.
 */
function istDateParts(dateInput) {
  const d = dateInput instanceof Date ? dateInput : new Date(dateInput);
  // en-CA yields YYYY-MM-DD; timeZone shifts the wall clock to IST.
  const iso = d.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const [y, m, day] = iso.split("-").map((s) => Number(s));
  return { y, m, d: day, iso };
}

/**
 * Build the REG_IND URL for a date. NSE uses DDMMYY (2-digit year).
 *   2026-04-20 → REG_IND200426.csv
 * Accepts a Date, an ISO "YYYY-MM-DD" string, or an {y,m,d} parts object.
 */
export function buildRegIndUrl(date) {
  let y;
  let m;
  let d;
  if (date && typeof date === "object" && !(date instanceof Date) && "y" in date) {
    ({ y, m, d } = date);
  } else {
    const parts = istDateParts(date instanceof Date ? date : new Date(`${date}T00:00:00+05:30`));
    ({ y, m, d } = parts);
  }
  const yy = pad2(y % 100);
  return `${REGIND_BASE}/REG_IND${pad2(d)}${pad2(m)}${yy}.csv`;
}

function subtractDaysIst(parts, n) {
  // Anchor at IST noon so ±n days never crosses a DST-free but UTC-adjacent
  // boundary incorrectly, then re-read the IST calendar date.
  const anchor = new Date(`${parts.iso}T12:00:00+05:30`);
  anchor.setUTCDate(anchor.getUTCDate() - n);
  return istDateParts(anchor);
}

async function fetchWithTimeout(url, fetchImpl, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, {
      headers: {
        "User-Agent": NSE_UA,
        Accept: "text/csv,text/plain,*/*",
        Referer: "https://www.nseindia.com/reports/asm",
      },
      signal: controller.signal,
      redirect: "follow",
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch the most recent available REG_IND CSV, walking back from today up to
 * `maxLookbackDays` calendar days to skip weekends/holidays (NSE doesn't
 * publish a file on non-trading days). Never throws.
 *
 * → { ok: true, csv, dateUsed: "YYYY-MM-DD", url, attempts }
 * → { ok: false, attempts, error }
 *   attempts: [{ date, url, status?, reason }]  — reason ∈
 *     "ok" | "not-published" (404/HTML) | "blocked" (401/403/412) |
 *     "http" | "network"
 */
export async function fetchRegIndCsv({ now = new Date(), maxLookbackDays = 6, fetchImpl = fetch } = {}) {
  const attempts = [];
  let blockedSeen = null;
  const today = istDateParts(now);

  for (let i = 0; i <= maxLookbackDays; i++) {
    const parts = i === 0 ? today : subtractDaysIst(today, i);
    const url = buildRegIndUrl(parts);
    try {
      const res = await fetchWithTimeout(url, fetchImpl);
      if (res.ok) {
        const csv = await res.text();
        // A 200 that's actually an HTML error/interstitial page is not data.
        if (csv && csv.trim().startsWith("<")) {
          attempts.push({ date: parts.iso, url, status: res.status, reason: "not-published" });
          continue;
        }
        attempts.push({ date: parts.iso, url, status: res.status, reason: "ok" });
        return { ok: true, csv, dateUsed: parts.iso, url, attempts };
      }
      if ([401, 403, 412].includes(res.status)) {
        blockedSeen = res.status;
        attempts.push({ date: parts.iso, url, status: res.status, reason: "blocked" });
        continue;
      }
      attempts.push({
        date: parts.iso,
        url,
        status: res.status,
        reason: res.status === 404 ? "not-published" : "http",
      });
    } catch (err) {
      attempts.push({ date: parts.iso, url, reason: "network", error: err.message });
    }
  }

  const error = blockedSeen
    ? `REG_IND blocked (HTTP ${blockedSeen}) across ${attempts.length} day(s)`
    : `REG_IND not available across ${attempts.length} day(s) back from ${today.iso}`;
  return { ok: false, attempts, error };
}

// ─────────────────────── CSV parsing ───────────────────────

/**
 * Minimal quote-aware CSV line splitter. Security names in REG_IND contain
 * commas ("XYZ LTD, THE"), so a naive split on "," corrupts the row.
 */
function splitCsvLine(line) {
  const out = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += ch;
    } else if (ch === '"') {
      inQ = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

// Sentinel values that mean "not flagged" in an indicator column.
const NOT_FLAGGED = new Set(["", "-", "0", "NA", "N.A.", "N.A", "NIL", "NO", "FALSE"]);

function isFlagged(raw) {
  if (raw == null) return false;
  const s = String(raw).trim().toUpperCase();
  return !NOT_FLAGGED.has(s);
}

/**
 * Detect which columns carry which indicator, from the header row. Returns
 * an index map; -1 for anything not present. Header text is matched by regex
 * so drift ("ASM Long Term Stage" vs "LT ASM" vs "ASM_LT") still resolves.
 */
function detectColumns(header) {
  const lower = header.map((h) => h.toLowerCase());
  const find = (pred) => lower.findIndex(pred);

  const symbol = find((h) => /^\s*symbol\s*$/.test(h)) >= 0
    ? find((h) => /^\s*symbol\s*$/.test(h))
    : find((h) => /symbol/.test(h));
  const series = find((h) => /series/.test(h));
  const gsm = find((h) => /gsm/.test(h));
  const asmLong = find((h) => /asm/.test(h) && /(long|\blt\b|_lt|-lt)/.test(h));
  const asmShort = find((h) => /asm/.test(h) && /(short|\bst\b|_st|-st)/.test(h));
  // A single combined ASM column with no long/short split → treat as longterm.
  const asmPlain = (asmLong < 0 && asmShort < 0)
    ? find((h) => /asm/.test(h))
    : -1;

  return { symbol, series, gsm, asmLong, asmShort, asmPlain };
}

/**
 * Parse a REG_IND CSV into normalised records. Header-driven and defensive:
 * an unrecognised/absent Symbol column, or a body that isn't CSV, yields
 * zero records + an error string (the caller treats 0 records as a failed
 * strategy).
 *
 * → { records: [{ symbol, series, gsmStage, asmLtStage, asmStStage }], header, columns, error? }
 *   Stage fields are the raw cell text (caller normalises via normalizeStage);
 *   they are only present when the cell is flagged.
 */
export function parseRegIndCsv(csvText) {
  const text = String(csvText || "");
  if (text.trim().startsWith("<")) {
    return { records: [], header: [], columns: null, error: "body is HTML, not CSV" };
  }
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) {
    return { records: [], header: [], columns: null, error: "fewer than 2 non-empty lines" };
  }
  const header = splitCsvLine(lines[0]);
  const columns = detectColumns(header);
  if (columns.symbol < 0) {
    return { records: [], header, columns, error: "no Symbol column detected" };
  }

  const cell = (cols, idx) => (idx >= 0 && idx < cols.length ? cols[idx] : "");
  const records = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]);
    const symbol = cell(cols, columns.symbol);
    if (!symbol) continue;

    const gsmRaw = cell(cols, columns.gsm);
    const asmLtRaw = columns.asmLong >= 0 ? cell(cols, columns.asmLong) : cell(cols, columns.asmPlain);
    const asmStRaw = cell(cols, columns.asmShort);

    records.push({
      symbol,
      series: cell(cols, columns.series) || null,
      gsmStage: isFlagged(gsmRaw) ? gsmRaw.trim() : null,
      asmLtStage: isFlagged(asmLtRaw) ? asmLtRaw.trim() : null,
      asmStStage: isFlagged(asmStRaw) ? asmStRaw.trim() : null,
    });
  }
  return { records, header, columns };
}
