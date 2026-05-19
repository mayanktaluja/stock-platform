/**
 * Sector Outlook — read-side facade for the API route.
 *
 * Mirrors the riskLabPicksService pattern at server.js:4287-4310 —
 * server endpoint calls into here and gets either the JSON payload
 * or a clear { message, stale } shape so the UI can show a banner.
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
export const OUTLOOK_LATEST_PATH = path.join(ROOT, "data", "sectorOutlook", "outlook-latest.json");
export const STALE_HOURS = 36;

export function loadLatestOutlook(p = OUTLOOK_LATEST_PATH) {
  if (!fs.existsSync(p)) {
    return {
      ok: false,
      stale: true,
      message: "Sector Outlook has never been generated. Run scripts/refresh-sector-outlook.mjs.",
    };
  }
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    return {
      ok: false,
      stale: true,
      message: `Sector Outlook file is malformed: ${e.message}`,
    };
  }
  const generatedAt = doc.generated_at ? new Date(doc.generated_at).getTime() : 0;
  const ageHours = (Date.now() - generatedAt) / (3600 * 1000);
  const stale = !Number.isFinite(generatedAt) || ageHours > STALE_HOURS;
  return {
    ok: true,
    stale,
    age_hours: ageHours,
    doc,
  };
}

export default {
  loadLatestOutlook,
  OUTLOOK_LATEST_PATH,
  STALE_HOURS,
};
