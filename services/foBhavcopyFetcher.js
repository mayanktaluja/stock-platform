/**
 * F&O Bhavcopy fetcher — probes NSE archives, unpacks the ZIP, returns CSV.
 *
 * Primary URL (UDiFF format, current since Feb-2024):
 *   https://nsearchives.nseindia.com/content/fo/BhavCopy_NSE_FO_0_0_0_YYYYMMDD_F_0000.csv.zip
 *
 * Fallback (legacy, kept only for backfill of older dates):
 *   https://archives.nseindia.com/content/historical/DERIVATIVES/YYYY/MMM/fo<DDMMM YYYY>bhav.csv.zip
 *
 * The primary serves cookie-less from datacenter IPs (verified on Vercel),
 * so we do NOT need the cookie dance for this endpoint. The legacy host
 * appears dead as of 2026-05; kept in the chain for historical replays only.
 */

import { inflateRawSync } from "node:zlib";

const NSE_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export class BhavcopyNotPublished extends Error {
  constructor(date) {
    super(`F&O bhavcopy not yet published for ${date}`);
    this.code = "BHAVCOPY_NOT_PUBLISHED";
    this.date = date;
  }
}

export class BhavcopyBlocked extends Error {
  constructor(date, status) {
    super(`F&O bhavcopy fetch blocked (HTTP ${status}) for ${date}`);
    this.code = "BHAVCOPY_BLOCKED";
    this.date = date;
    this.status = status;
  }
}

const MONTHS = [
  "JAN",
  "FEB",
  "MAR",
  "APR",
  "MAY",
  "JUN",
  "JUL",
  "AUG",
  "SEP",
  "OCT",
  "NOV",
  "DEC",
];

function pad2(n) {
  return String(n).padStart(2, "0");
}

/**
 * Build the candidate URL list for a given trading date (Date or "YYYY-MM-DD").
 * Returns urls in priority order (primary first).
 */
export function buildBhavcopyUrls(date) {
  const d = date instanceof Date ? date : new Date(`${date}T00:00:00Z`);
  const yyyy = d.getUTCFullYear();
  const mm = pad2(d.getUTCMonth() + 1);
  const dd = pad2(d.getUTCDate());
  const monShort = MONTHS[d.getUTCMonth()];

  return [
    {
      label: "udiff-primary",
      url: `https://nsearchives.nseindia.com/content/fo/BhavCopy_NSE_FO_0_0_0_${yyyy}${mm}${dd}_F_0000.csv.zip`,
    },
    {
      label: "legacy",
      url: `https://archives.nseindia.com/content/historical/DERIVATIVES/${yyyy}/${monShort}/fo${dd}${monShort}${yyyy}bhav.csv.zip`,
    },
  ];
}

async function fetchWithTimeout(url, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      headers: {
        "User-Agent": NSE_UA,
        Accept: "application/zip, application/octet-stream, */*",
        Referer: "https://www.nseindia.com/all-reports-derivatives",
      },
      signal: controller.signal,
      redirect: "follow",
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Single-file deflate ZIP reader. NSE bhavcopy ZIPs always contain exactly
 * one CSV entry compressed with method=8 (deflate). We read the local file
 * header and inflate the raw deflate payload — no full PKZIP parser needed.
 */
function unzipSingleEntry(zipBuf) {
  const buf = Buffer.isBuffer(zipBuf) ? zipBuf : Buffer.from(zipBuf);
  // Local file header signature: 0x04034b50 (little-endian)
  if (buf.readUInt32LE(0) !== 0x04034b50) {
    throw new Error("not a ZIP file (missing local file header signature)");
  }
  const compressionMethod = buf.readUInt16LE(8);
  const compressedSize = buf.readUInt32LE(18);
  const filenameLen = buf.readUInt16LE(26);
  const extraLen = buf.readUInt16LE(28);
  const dataStart = 30 + filenameLen + extraLen;
  const compressed = buf.subarray(dataStart, dataStart + compressedSize);

  if (compressionMethod === 0) return compressed; // stored, no compression
  if (compressionMethod === 8) return inflateRawSync(compressed);
  throw new Error(`unsupported ZIP compression method ${compressionMethod}`);
}

/**
 * Fetch bhavcopy for a date and return the CSV string.
 *
 * Throws:
 *   BhavcopyNotPublished — every URL returned 404 (run too early or non-trading day).
 *   BhavcopyBlocked      — got 403/Cloudflare/etc on the primary URL.
 *   Error                — every URL erred for some other reason.
 */
export async function fetchBhavcopy(date) {
  const urls = buildBhavcopyUrls(date);
  const errors = [];
  let allFourOhFours = true;
  let blockedStatus = null;

  for (const { label, url } of urls) {
    try {
      const res = await fetchWithTimeout(url);
      if (res.status === 404) {
        errors.push({ label, status: 404 });
        continue;
      }
      if ([401, 403, 412].includes(res.status)) {
        // NSE Cloudflare/edge block. Stop probing further URLs, surface
        // distinct error so the orchestrator can wait and retry.
        allFourOhFours = false;
        blockedStatus = res.status;
        errors.push({ label, status: res.status });
        continue;
      }
      if (!res.ok) {
        allFourOhFours = false;
        errors.push({ label, status: res.status });
        continue;
      }

      const ab = await res.arrayBuffer();
      const buf = Buffer.from(ab);

      // Sanity: NSE sometimes serves an HTML error page wrapped in 200.
      if (buf.length < 100 || buf.readUInt32LE(0) !== 0x04034b50) {
        allFourOhFours = false;
        errors.push({ label, status: 200, reason: "not-a-zip" });
        continue;
      }

      const csvBuf = unzipSingleEntry(buf);
      const csv = csvBuf.toString("utf8");

      // Sanity: bhavcopy CSVs always start with the TradDt header column.
      if (!csv.startsWith("TradDt")) {
        allFourOhFours = false;
        errors.push({ label, status: 200, reason: "bad-csv-header" });
        continue;
      }

      return { csv, urlUsed: url, label, contentLength: buf.length };
    } catch (err) {
      allFourOhFours = false;
      errors.push({ label, error: err.message });
    }
  }

  const dateStr =
    date instanceof Date ? date.toISOString().slice(0, 10) : String(date);

  if (allFourOhFours) throw new BhavcopyNotPublished(dateStr);
  if (blockedStatus) throw new BhavcopyBlocked(dateStr, blockedStatus);
  throw new Error(
    `F&O bhavcopy fetch failed for ${dateStr}: ${JSON.stringify(errors)}`,
  );
}
