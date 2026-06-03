const NEGATIVE_RE = /\b(overvaluation|overvalued|target\s*(cut|trim|lower|reduc)|price\s*target\s*(cut|trim|lower|reduc)|downgrade|miss|margin\s*(pressure|squeeze|declin)|concern|debt|dilution|regulatory|investigation|pledge|loss|declin|underperform|weak|slowdown)\b/i;
const POSITIVE_RE = /\b(upgrade|target\s*(raise|rais|increase)|price\s*target\s*(raise|rais|increase)|beat|contract|order\s*win|award|profit\s*(up|rise|grow)|revenue\s*(up|rise|grow)|eps\s*(up|rise|grow)|opportunity|dividend|capacity\s*expansion)\b/i;
const MATERIAL_NEGATIVE_RE = /\b(overvaluation|overvalued|target\s*(cut|trim|lower|reduc)|price\s*target\s*(cut|trim|lower|reduc)|downgrade|miss|regulatory|investigation|pledge|margin\s*(pressure|squeeze|declin)|underperform)\b/i;

const MAX_NEWS_AGE_DAYS = 90;

function parseDate(value) {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function daysAgo(value, now) {
  const ms = parseDate(value);
  if (ms == null) return null;
  return Math.floor((now.getTime() - ms) / 86_400_000);
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function classifyEntry(entry) {
  const title = cleanText(entry?.title);
  const body = cleanText(entry?.body);
  const text = `${title} ${body}`;
  const negative = NEGATIVE_RE.test(text);
  const positive = POSITIVE_RE.test(text);
  const materialNegative = MATERIAL_NEGATIVE_RE.test(text);
  let signal = 0;
  if (negative && !positive) signal = -1;
  else if (positive && !negative) signal = 1;
  return {
    date: entry?.date || null,
    title,
    type: entry?.type || entry?.raw_subtype || null,
    source_url: entry?.source_url || null,
    signal,
    materialNegative,
    reason: materialNegative
      ? "material_negative"
      : signal < 0
        ? "negative"
        : signal > 0
          ? "positive"
          : negative && positive
            ? "mixed"
            : "neutral",
  };
}

export function extractSwsNewsSignals(news = [], { now = new Date() } = {}) {
  const rows = Array.isArray(news) ? news : [];
  const recent = [];
  for (const entry of rows) {
    const age = daysAgo(entry?.date, now);
    if (age != null && age > MAX_NEWS_AGE_DAYS) continue;
    recent.push({ ...classifyEntry(entry), recency_days: age });
  }

  const evidence = recent
    .filter((row) => row.signal !== 0 || row.materialNegative || row.reason === "mixed")
    .sort((a, b) => {
      const ad = a.recency_days == null ? 9999 : a.recency_days;
      const bd = b.recency_days == null ? 9999 : b.recency_days;
      return ad - bd;
    })
    .slice(0, 4);

  const negative = evidence.filter((row) => row.signal < 0 || row.materialNegative);
  const positive = evidence.filter((row) => row.signal > 0);
  const materialDisclosure = negative.some((row) => row.materialNegative);

  let signal = 0;
  let confidence_delta = 0;
  if (negative.length > 0 && positive.length === 0) {
    signal = -1;
    confidence_delta = materialDisclosure ? -2 : -1;
  } else if (positive.length > 0 && negative.length === 0) {
    signal = 1;
    confidence_delta = 1;
  }

  const blockedReasons = [];
  if (negative.length > 0) {
    blockedReasons.push(materialDisclosure
      ? "material negative SWS news requires manual review before adding exposure"
      : "negative SWS news reduces confidence");
  }
  if (positive.length > 0 && signal <= 0) {
    blockedReasons.push("mixed SWS news is noisy; do not use it as a standalone action trigger");
  }

  const recency = evidence
    .map((row) => row.recency_days)
    .filter((age) => Number.isFinite(age));

  return {
    available: rows.length > 0,
    signal,
    confidence_delta,
    evidence,
    recency_days: recency.length ? Math.min(...recency) : null,
    materialDisclosure,
    blockedReasons,
    summary: negative.length && positive.length
      ? "Mixed SWS news; treat as attention layer only."
      : negative.length
        ? "Negative SWS news; can veto adds or confirm an independently-supported reduction."
        : positive.length
          ? "Positive SWS news; supportive context only, not a standalone top-up trigger."
          : rows.length
            ? "No recent directional SWS news signal."
            : "No SWS news available.",
  };
}
