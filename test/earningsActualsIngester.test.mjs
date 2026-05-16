// PR 1 — services/earnings/actualsIngester.js unit tests.
//
// Covers the four pure surfaces of the actuals ingester:
//   - parseFiscalQuarter   : "Q4 FY26" → calendar quarter-end
//   - classifyEarningsTitle: SWS brief title → BEAT/INLINE/MISS
//   - extractActualVerdictFromSwsNews : news[] → verdict, window-gated
//   - fetchActualFromYahoo : earningsHistory → verdict, quarter-keyed
//   - selectResolvableKeys : dedup (symbol,event) across snapshots
//
// fetchActualFromYahoo is exercised with an injected mock `yf` client
// so the suite never touches the network.

import assert from "node:assert/strict";
import {
  parseFiscalQuarter,
  classifyEarningsTitle,
  isEarningsResultBrief,
  extractActualVerdictFromSwsNews,
  fetchActualFromYahoo,
  selectResolvableKeys,
  resolveActualForEvent,
  appendSourceConflictRow,
  buildSourceConflictRow,
  SOURCE_CONFLICT_LOG_MAX,
} from "../services/earnings/actualsIngester.js";

let ok = 0, fail = 0;
const tests = [];
function it(name, fn) { tests.push({ name, fn }); }

/* ───────────────────── parseFiscalQuarter ───────────────────────── */

console.log("[1] parseFiscalQuarter");
it("Q4 FY26 → ends 2026-03-31", () => {
  assert.deepEqual(parseFiscalQuarter("Q4 FY26"), { quarter: 4, fy: 2026, quarterEndIso: "2026-03-31" });
});
it("Q1 FY26 → ends 2025-06-30", () => {
  assert.equal(parseFiscalQuarter("Q1 FY26").quarterEndIso, "2025-06-30");
});
it("Q2 FY26 → ends 2025-09-30", () => {
  assert.equal(parseFiscalQuarter("Q2 FY26").quarterEndIso, "2025-09-30");
});
it("Q3 FY26 → ends 2025-12-31", () => {
  assert.equal(parseFiscalQuarter("Q3 FY26").quarterEndIso, "2025-12-31");
});
it("lower-case + 4-digit FY tolerated", () => {
  assert.equal(parseFiscalQuarter("q4 fy2026").quarterEndIso, "2026-03-31");
});
it("garbage → null", () => {
  assert.equal(parseFiscalQuarter("not a quarter"), null);
  assert.equal(parseFiscalQuarter(null), null);
  assert.equal(parseFiscalQuarter(""), null);
});

/* ──────────────────── classifyEarningsTitle ─────────────────────── */

console.log("[2] classifyEarningsTitle — canonical SWS brief patterns");
const TITLE_CASES = [
  ["Full year 2026 earnings: EPS exceeds analyst expectations", "BEAT"],
  ["Q4 2026 earnings: EPS misses analyst expectations", "MISS"],
  ["Q2 2026 earnings: EPS in line with analyst expectations", "INLINE"],
  // The canonical mixed quarter — revenue up, EPS down → INLINE.
  ["Full year 2026 earnings: Revenues exceed analysts expectations while EPS lags behind", "INLINE"],
  ["Q1 2027 earnings: Revenues and EPS exceed expectations", "BEAT"],
  ["Q3 2026 earnings: EPS beats while revenue misses", "INLINE"],
  ["Q2 2026 earnings: Revenues miss analyst expectations", "MISS"],
  // Not an earnings-result brief at all.
  ["RELIANCE: Green Energy Agreements Will Support Future Earnings", null],
  ["Now 20% undervalued after recent price drop", null],
];
for (const [title, expected] of TITLE_CASES) {
  it(`"${title.slice(0, 56)}..." → ${expected}`, () => {
    assert.equal(classifyEarningsTitle(title), expected);
  });
}

console.log("[3] isEarningsResultBrief");
it("type:brief + period-shaped title → true", () => {
  assert.equal(
    isEarningsResultBrief({ type: "brief", title: "Q4 2026 earnings: EPS exceeds analyst expectations" }),
    true,
  );
});
it("type:article → false even if title mentions earnings", () => {
  assert.equal(
    isEarningsResultBrief({ type: "article", title: "Q4 2026 earnings: EPS exceeds analyst expectations" }),
    false,
  );
});
it("narrative-update → false", () => {
  assert.equal(
    isEarningsResultBrief({ type: "narrative-update", title: "RELIANCE: Will Support Future Earnings" }),
    false,
  );
});

/* ─────────────── extractActualVerdictFromSwsNews ─────────────────── */

console.log("[4] extractActualVerdictFromSwsNews — window gating");
it("brief inside the Q4 FY26 window → resolves BEAT", () => {
  const news = [
    { type: "brief", date: "2026-04-26T22:54:28.000Z", title: "Full year 2026 earnings: EPS exceeds analyst expectations" },
  ];
  const r = extractActualVerdictFromSwsNews(news, "Q4 FY26");
  assert.ok(r);
  assert.equal(r.actual_verdict, "BEAT");
  assert.equal(r.actual_source, "sws_news");
  assert.match(r.actual_evidence, /2026-04-26/);
});
it("adjacent-quarter brief is rejected (out of window)", () => {
  // A Q3 FY26 result brief dated mid-Jan is ~75d BEFORE the Q4 FY26
  // quarter-end (2026-03-31) — outside the [-5d, +80d] window.
  const news = [
    { type: "brief", date: "2026-01-15T10:00:00.000Z", title: "Q3 2026 earnings: EPS misses analyst expectations" },
  ];
  assert.equal(extractActualVerdictFromSwsNews(news, "Q4 FY26"), null);
});
it("most-recent matching brief wins (restatement-friendly)", () => {
  const news = [
    { type: "brief", date: "2026-04-20T10:00:00.000Z", title: "Full year 2026 earnings: EPS misses analyst expectations" },
    { type: "brief", date: "2026-05-02T10:00:00.000Z", title: "Full year 2026 earnings: EPS exceeds analyst expectations" },
  ];
  assert.equal(extractActualVerdictFromSwsNews(news, "Q4 FY26").actual_verdict, "BEAT");
});
it("empty / missing news → null", () => {
  assert.equal(extractActualVerdictFromSwsNews([], "Q4 FY26"), null);
  assert.equal(extractActualVerdictFromSwsNews(null, "Q4 FY26"), null);
});
it("non-brief items ignored even if in window", () => {
  const news = [
    { type: "article", date: "2026-04-26T10:00:00.000Z", title: "Q4 2026 earnings: EPS exceeds analyst expectations" },
  ];
  assert.equal(extractActualVerdictFromSwsNews(news, "Q4 FY26"), null);
});

/* ───────────────────── fetchActualFromYahoo ──────────────────────── */

console.log("[5] fetchActualFromYahoo — quarter keying (mocked client)");

// Builds a mock yahoo-finance2 client. `history` is the earningsHistory
// rows; `quotes` is the chart payload (optional).
function mockYf({ history = [], quotes = null } = {}) {
  return {
    async quoteSummary() {
      return { earningsHistory: { history } };
    },
    async chart() {
      return { quotes: quotes || [] };
    },
  };
}

it("Yahoo row at the Indian quarter-end → resolves", async () => {
  const yf = mockYf({
    history: [
      { quarter: new Date("2026-03-31"), epsActual: 12, epsEstimate: 10, surprisePercent: 0.2 },
    ],
  });
  const r = await fetchActualFromYahoo("RELIANCE", "Q4 FY26", "2026-04-24", { yf });
  assert.ok(r);
  assert.equal(r.actual_verdict, "BEAT");
  assert.equal(r.actual_source, "yahoo");
});

it("US-calendar-quarter row (Dec 31) is rejected for Indian Q4 FY26", async () => {
  // The adversarial-review failure mode: Yahoo "4Q2025" = Oct-Dec.
  // That row's quarter-end (2025-12-31) is 90d off the Indian Q4 FY26
  // end (2026-03-31) — outside the ±45d tolerance, so it must NOT
  // silently mis-key.
  const yf = mockYf({
    history: [
      { quarter: new Date("2025-12-31"), epsActual: 5, epsEstimate: 10, surprisePercent: -0.5 },
    ],
  });
  assert.equal(await fetchActualFromYahoo("INFY", "Q4 FY26", "2026-04-24", { yf }), null);
});

it("IST/EST date skew within tolerance still matches", async () => {
  // A Yahoo quarter date a few days off the exact 2026-03-31 boundary
  // (timezone rounding) is still inside ±45d → matches.
  const yf = mockYf({
    history: [
      { quarter: new Date("2026-03-28"), epsActual: 9, epsEstimate: 10, surprisePercent: -0.1 },
    ],
  });
  const r = await fetchActualFromYahoo("TCS", "Q4 FY26", "2026-04-24", { yf });
  assert.ok(r);
  assert.equal(r.actual_verdict, "MISS");
});

it("no earningsHistory rows → null", async () => {
  assert.equal(await fetchActualFromYahoo("OBSCURE", "Q4 FY26", "2026-04-24", { yf: mockYf() }), null);
});

it("T+1 close + open-gap extracted from chart when available", async () => {
  const yf = mockYf({
    history: [{ quarter: new Date("2026-03-31"), epsActual: 12, epsEstimate: 10, surprisePercent: 0.2 }],
    quotes: [
      { date: new Date("2026-04-24"), open: 100, close: 102 },
      { date: new Date("2026-04-25"), open: 108, close: 110 }, // T+1
    ],
  });
  const r = await fetchActualFromYahoo("RELIANCE", "Q4 FY26", "2026-04-24", { yf });
  assert.equal(r.actual_t1_close_inr, 110);
  // gap = (108 - 102) / 102 * 100 ≈ 5.88%
  assert.ok(Math.abs(r.actual_t1_open_gap_pct - 5.882) < 0.01);
});

/* ───────────────────── selectResolvableKeys ─────────────────────── */

console.log("[6] selectResolvableKeys — dedup across snapshots");

// Same event archived into three daily snapshots — must dedup to ONE
// key whose `files` lists all three.
const TRIPLE_SNAPSHOT = [
  {
    filename: "2026-05-09.json", today_iso: "2026-05-09",
    predictions: [{ symbol: "AARTISURF", event_iso_date: "2026-05-12", fiscal_quarter: "Q4 FY26", actual_verdict: null }],
  },
  {
    filename: "2026-05-13.json", today_iso: "2026-05-13",
    predictions: [{ symbol: "AARTISURF", event_iso_date: "2026-05-12", fiscal_quarter: "Q4 FY26", actual_verdict: null }],
  },
  {
    filename: "2026-05-14.json", today_iso: "2026-05-14",
    predictions: [{ symbol: "AARTISURF", event_iso_date: "2026-05-12", fiscal_quarter: "Q4 FY26", actual_verdict: null }],
  },
];

it("one event in 3 snapshots → 1 key, files lists all 3", () => {
  const keys = selectResolvableKeys(TRIPLE_SNAPSHOT, { todayIso: "2026-05-14" });
  assert.equal(keys.length, 1);
  assert.equal(keys[0].symbol, "AARTISURF");
  assert.equal(keys[0].files.length, 3);
});

it("future events (event_iso_date >= today) are excluded", () => {
  const hist = [{
    filename: "2026-05-14.json", today_iso: "2026-05-14",
    predictions: [
      { symbol: "PAST", event_iso_date: "2026-05-12", fiscal_quarter: "Q4 FY26", actual_verdict: null },
      { symbol: "FUTURE", event_iso_date: "2026-05-20", fiscal_quarter: "Q4 FY26", actual_verdict: null },
    ],
  }];
  const keys = selectResolvableKeys(hist, { todayIso: "2026-05-14" });
  assert.deepEqual(keys.map((k) => k.symbol), ["PAST"]);
});

it("already-resolved events skipped by default, included with reResolve", () => {
  const hist = [{
    filename: "2026-05-14.json", today_iso: "2026-05-14",
    predictions: [
      { symbol: "DONE", event_iso_date: "2026-05-10", fiscal_quarter: "Q4 FY26", actual_verdict: "BEAT" },
    ],
  }];
  assert.equal(selectResolvableKeys(hist, { todayIso: "2026-05-14" }).length, 0);
  assert.equal(selectResolvableKeys(hist, { todayIso: "2026-05-14", reResolve: true }).length, 1);
});

it("--symbol filter restricts to one ticker", () => {
  const hist = [{
    filename: "2026-05-14.json", today_iso: "2026-05-14",
    predictions: [
      { symbol: "AAA", event_iso_date: "2026-05-10", fiscal_quarter: "Q4 FY26", actual_verdict: null },
      { symbol: "BBB", event_iso_date: "2026-05-10", fiscal_quarter: "Q4 FY26", actual_verdict: null },
    ],
  }];
  const keys = selectResolvableKeys(hist, { todayIso: "2026-05-14", symbol: "bbb" });
  assert.deepEqual(keys.map((k) => k.symbol), ["BBB"]);
});

it("--since-days lookback excludes old events", () => {
  const hist = [{
    filename: "2026-05-14.json", today_iso: "2026-05-14",
    predictions: [
      { symbol: "RECENT", event_iso_date: "2026-05-01", fiscal_quarter: "Q4 FY26", actual_verdict: null },
      { symbol: "OLD", event_iso_date: "2026-01-01", fiscal_quarter: "Q3 FY26", actual_verdict: null },
    ],
  }];
  const keys = selectResolvableKeys(hist, { todayIso: "2026-05-14", sinceDays: 30 });
  assert.deepEqual(keys.map((k) => k.symbol), ["RECENT"]);
});

/* ─────────────── P2.6 source-disagreement log ───────────────────── */

console.log("[7] resolveActualForEvent — source-disagreement log");

// Mock Yahoo client returning a fixed verdict row.
function yahooReturningVerdict(verdict) {
  const epsActual = verdict === "BEAT" ? 12 : verdict === "MISS" ? 8 : 10;
  return {
    async quoteSummary() {
      return {
        earningsHistory: {
          history: [
            { quarter: new Date("2026-03-31"), epsActual, epsEstimate: 10, surprisePercent: (epsActual - 10) / 10 },
          ],
        },
      };
    },
    async chart() { return { quotes: [] }; },
  };
}

it("SWS+Yahoo AGREE → no conflict logged", async () => {
  const conflicts = [];
  const swsNews = [
    { type: "brief", date: "2026-04-26T22:54:28.000Z", title: "Full year 2026 earnings: EPS exceeds analyst expectations" },
  ];
  const r = await resolveActualForEvent({
    symbol: "RELIANCE",
    fiscalQuarter: "Q4 FY26",
    eventIsoDate: "2026-04-24",
    swsNews,
    opts: { yf: yahooReturningVerdict("BEAT"), onSourceConflict: (row) => conflicts.push(row) },
  });
  assert.equal(r.actual_verdict, "BEAT");
  assert.equal(r.actual_source, "sws_news");
  assert.equal(conflicts.length, 0, JSON.stringify(conflicts));
});

it("SWS+Yahoo DISAGREE → conflict logged, SWS verdict still chosen", async () => {
  const conflicts = [];
  // SWS says BEAT; Yahoo says MISS.
  const swsNews = [
    { type: "brief", date: "2026-04-26T22:54:28.000Z", title: "Full year 2026 earnings: EPS exceeds analyst expectations" },
  ];
  const r = await resolveActualForEvent({
    symbol: "INFY",
    fiscalQuarter: "Q4 FY26",
    eventIsoDate: "2026-04-24",
    swsNews,
    opts: { yf: yahooReturningVerdict("MISS"), onSourceConflict: (row) => conflicts.push(row) },
  });
  // SWS still wins — no logic change.
  assert.equal(r.actual_verdict, "BEAT");
  assert.equal(r.actual_source, "sws_news");
  // One conflict row, with both verdicts captured.
  assert.equal(conflicts.length, 1);
  const row = conflicts[0];
  assert.equal(row.symbol, "INFY");
  assert.equal(row.event_iso_date, "2026-04-24");
  assert.equal(row.sws_verdict, "BEAT");
  assert.equal(row.yahoo_verdict, "MISS");
  assert.equal(row.chosen_source, "sws_news");
  assert.equal(row.chosen_verdict, "BEAT");
  assert.ok(row.logged_at);
  assert.ok(row.sws_value); // evidence string
  assert.ok(row.yahoo_value);
});

it("SWS resolves but Yahoo has no row → no conflict (nothing to compare)", async () => {
  const conflicts = [];
  const swsNews = [
    { type: "brief", date: "2026-04-26T22:54:28.000Z", title: "Full year 2026 earnings: EPS exceeds analyst expectations" },
  ];
  // Yahoo returns no earningsHistory rows — comparison can't run.
  const emptyYf = {
    async quoteSummary() { return { earningsHistory: { history: [] } }; },
    async chart() { return { quotes: [] }; },
  };
  const r = await resolveActualForEvent({
    symbol: "TCS",
    fiscalQuarter: "Q4 FY26",
    eventIsoDate: "2026-04-24",
    swsNews,
    opts: { yf: emptyYf, onSourceConflict: (row) => conflicts.push(row) },
  });
  assert.equal(r.actual_verdict, "BEAT");
  assert.equal(conflicts.length, 0);
});

it("logSourceConflicts:false disables the comparison entirely", async () => {
  const conflicts = [];
  const swsNews = [
    { type: "brief", date: "2026-04-26T22:54:28.000Z", title: "Full year 2026 earnings: EPS exceeds analyst expectations" },
  ];
  // Even though Yahoo would disagree, no conflict is logged.
  const r = await resolveActualForEvent({
    symbol: "WIPRO",
    fiscalQuarter: "Q4 FY26",
    eventIsoDate: "2026-04-24",
    swsNews,
    opts: {
      yf: yahooReturningVerdict("MISS"),
      onSourceConflict: (row) => conflicts.push(row),
      logSourceConflicts: false,
    },
  });
  assert.equal(r.actual_verdict, "BEAT");
  assert.equal(conflicts.length, 0);
});

console.log("[8] appendSourceConflictRow — cap behaviour");

it("appendSourceConflictRow appends a row to an empty array", () => {
  const row = buildSourceConflictRow({
    symbol: "X", eventIsoDate: "2026-04-24",
    sws: { actual_verdict: "BEAT", actual_evidence: "sws-ev" },
    yahoo: { actual_verdict: "MISS", actual_evidence: "y-ev" },
    chosenSource: "sws_news", chosenVerdict: "BEAT", loggedAtIso: "2026-05-15T00:00:00Z",
  });
  const out = appendSourceConflictRow([], row);
  assert.equal(out.length, 1);
  assert.equal(out[0].symbol, "X");
});

it("appendSourceConflictRow caps at SOURCE_CONFLICT_LOG_MAX (oldest dropped)", () => {
  const existing = Array.from({ length: SOURCE_CONFLICT_LOG_MAX }, (_, i) => ({
    symbol: `OLD${i}`, event_iso_date: "2026-01-01", logged_at: "2026-01-01T00:00:00Z",
  }));
  const newRow = { symbol: "NEW", event_iso_date: "2026-05-15", logged_at: "2026-05-15T00:00:00Z" };
  const out = appendSourceConflictRow(existing, newRow);
  assert.equal(out.length, SOURCE_CONFLICT_LOG_MAX);
  // Newest is preserved at the tail; oldest (OLD0) is dropped.
  assert.equal(out[out.length - 1].symbol, "NEW");
  assert.equal(out[0].symbol, "OLD1");
});

it("appendSourceConflictRow tolerates a non-array `existing` (defensive)", () => {
  const row = { symbol: "X", event_iso_date: "2026-04-24", logged_at: "2026-05-15T00:00:00Z" };
  const out = appendSourceConflictRow(null, row);
  assert.equal(out.length, 1);
  assert.equal(out[0].symbol, "X");
});

/* ─────────────────────────── runner ─────────────────────────────── */

(async () => {
  for (const t of tests) {
    try {
      await t.fn();
      console.log("  ✓", t.name);
      ok += 1;
    } catch (e) {
      console.log("  ✗", t.name, "\n   ", e && e.message);
      fail += 1;
    }
  }
  console.log(`\n=== ${ok} passed, ${fail} failed ===`);
  if (fail) process.exit(1);
})();
