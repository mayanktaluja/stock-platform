import {
  parseEnglishDate,
  extractDividendFromNewsBody,
  extractDividendsFromDeep,
} from "../services/dividends/swsDividendsExtractor.js";

let pass = 0, fail = 0;
function assert(name, cond, got) {
  if (cond) { console.log(`✓ ${name}`); pass++; }
  else { console.log(`✗ ${name} — got: ${JSON.stringify(got)}`); fail++; }
}

// ──── parseEnglishDate ────
{
  assert("parseEnglishDate: 'July 17, 2026' → '2026-07-17'", parseEnglishDate("July 17, 2026") === "2026-07-17", parseEnglishDate("July 17, 2026"));
  assert("parseEnglishDate: 'June 22, 2026' (handles full month)", parseEnglishDate("June 22, 2026") === "2026-06-22", parseEnglishDate("June 22, 2026"));
  assert("parseEnglishDate: 'August 14, 2026' (handles single-digit day)", parseEnglishDate("August 14, 2026") === "2026-08-14");
  assert("parseEnglishDate: 'Jul 8, 2026' (handles abbreviation + 1-digit day)", parseEnglishDate("Jul 8, 2026") === "2026-07-08", parseEnglishDate("Jul 8, 2026"));
  assert("parseEnglishDate: comma optional", parseEnglishDate("June 22 2026") === "2026-06-22");
  assert("parseEnglishDate: garbage rejected", parseEnglishDate("not a date") === null);
  assert("parseEnglishDate: empty rejected", parseEnglishDate("") === null);
  assert("parseEnglishDate: null rejected", parseEnglishDate(null) === null);
}

// ──── extractDividendFromNewsBody — the 5 verbatim sample bodies from Task #0 probe ────
{
  const walchand = "Walchand PeopleFirst Limited announced Annual dividend of INR 1.0000 per share payable on August 29, 2026, ex-date on July 17, 2026 and record date on July 17, 2026.";
  const r1 = extractDividendFromNewsBody(walchand);
  assert("walchand: dps = 1.0", r1?.dps === 1.0, r1);
  assert("walchand: ex_date = 2026-07-17", r1?.ex_date === "2026-07-17", r1);
  assert("walchand: record_date = 2026-07-17", r1?.record_date === "2026-07-17", r1);
  assert("walchand: pay_date = 2026-08-29", r1?.pay_date === "2026-08-29", r1);
  assert("walchand: dividend_type = annual", r1?.dividend_type === "annual", r1);

  const panasonic = "Panasonic Carbon India Co. Limited announced Annual dividend of INR 12.0000 per share payable on July 29, 2026, ex-date on June 22, 2026 and record date on June 22, 2026.";
  const r2 = extractDividendFromNewsBody(panasonic);
  assert("panasonic: dps = 12.0", r2?.dps === 12.0, r2);
  assert("panasonic: ex_date = 2026-06-22", r2?.ex_date === "2026-06-22", r2);

  const cravatex = "Cravatex Limited announced Annual dividend of INR 13.0000 per share payable on August 30, 2026, ex-date on July 24, 2026 and record date on July 24, 2026.";
  const r3 = extractDividendFromNewsBody(cravatex);
  assert("cravatex: ex_date = 2026-07-24", r3?.ex_date === "2026-07-24", r3);
  assert("cravatex: dps = 13.0", r3?.dps === 13.0, r3);

  const morarka = "Morarka Finance Limited announced Annual dividend of INR 1.5000 per share payable on August 14, 2026, ex-date on July 08, 2026 and record date on July 08, 2026.";
  const r4 = extractDividendFromNewsBody(morarka);
  assert("morarka: ex_date = 2026-07-08 (handles '08' with leading zero)", r4?.ex_date === "2026-07-08", r4);
  assert("morarka: dps = 1.5", r4?.dps === 1.5, r4);

  const solitaire = "Solitaire Machine Tools Limited announced Annual dividend of INR 1.5000 per share payable on July 27, 2026, ex-date on June 19, 2026 and record date on June 20, 2026.";
  const r5 = extractDividendFromNewsBody(solitaire);
  assert("solitaire: ex_date = 2026-06-19", r5?.ex_date === "2026-06-19", r5);
  assert("solitaire: record_date = 2026-06-20 (differs from ex_date)", r5?.record_date === "2026-06-20", r5);
}

// ──── Negative coverage: non-dividend / unparseable bodies ────
{
  const r1 = extractDividendFromNewsBody("X Ltd announced a buyback of 1,000,000 shares.");
  assert("buyback body returns null", r1 === null, r1);

  const r2 = extractDividendFromNewsBody("X Ltd will consider a dividend on May 25.");
  assert("intent-only body (no INR amount) returns null", r2 === null, r2);

  const r3 = extractDividendFromNewsBody("");
  assert("empty body returns null", r3 === null);

  const r4 = extractDividendFromNewsBody(null);
  assert("null body returns null", r4 === null);

  const r5 = extractDividendFromNewsBody("X Ltd announced Annual dividend of INR 0 per share, ex-date on July 17, 2026.");
  assert("zero-amount dividend returns null", r5 === null, r5);
}

// ──── extractDividendsFromDeep — filters to future ex-dates, normalises symbol ────
{
  const deep = {
    ticker: "TESTCO",
    news: [
      {
        type: "event",
        keyDevTypeId: "45",
        title: "Testco announces Annual dividend",
        body: "Testco Limited announced Annual dividend of INR 2.50 per share payable on July 29, 2026, ex-date on July 01, 2026 and record date on July 01, 2026.",
        date: "2026-05-19T00:00:00.000Z",
      },
      {
        type: "event",
        keyDevTypeId: "45",
        title: "Past dividend already paid",
        body: "Testco Limited announced Annual dividend of INR 1.50 per share payable on January 15, 2026, ex-date on January 02, 2026 and record date on January 02, 2026.",
        date: "2025-12-20T00:00:00.000Z",
      },
    ],
  };
  const out = extractDividendsFromDeep(deep, { todayIso: "2026-05-19" });
  assert("deep extractor: only future ex-date row kept (1 of 2)", out.length === 1, out);
  assert("deep extractor: row.symbol = TESTCO (upper)", out[0]?.symbol === "TESTCO", out[0]);
  assert("deep extractor: row.ex_date = 2026-07-01", out[0]?.ex_date === "2026-07-01", out[0]);
  assert("deep extractor: row.source = sws-news", out[0]?.source === "sws-news", out[0]);
}

// ──── isDividendNewsEntry alternates: title/body match without keyDevTypeId ────
{
  const deep = {
    ticker: "ALTCO",
    news: [
      {
        type: "event",
        keyDevTypeId: null,
        title: "ALTCO announces interim dividend",
        body: "ALTCO Limited announced Interim dividend of INR 3.0 per share payable on July 1, 2027, ex-date on June 1, 2027 and record date on June 1, 2027.",
        date: "2026-05-15T00:00:00.000Z",
      },
    ],
  };
  const out = extractDividendsFromDeep(deep, { todayIso: "2026-05-19" });
  assert("alt-keyDev: dividend in title still extracted", out.length === 1, out);
  assert("alt-keyDev: dividend_type = interim", out[0]?.dividend_type === "interim", out[0]);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
