import test from "node:test";
import assert from "node:assert/strict";
import {
  resolvePegDisplay,
  netIncomeCagrPct,
  growwProfitToHistory,
  PEG_DISPLAY_CAP,
  PEG_MIN_PE,
} from "../services/valuation/pegDisplay.js";

// JSLL net-income history (newest-first), from data/sws/deep/JSLL.json.
const JSLL_NI = [
  { year: 2026, netIncome: 2218508000 },
  { year: 2025, netIncome: 1185803500 },
  { year: 2024, netIncome: 767324000 },
  { year: 2023, netIncome: 441559000 },
  { year: 2022, netIncome: 112324000 },
];

test("netIncomeCagrPct: JSLL 2022->2026 CAGR is a large positive", () => {
  const cagr = netIncomeCagrPct(JSLL_NI);
  assert.ok(cagr > 90 && cagr < 130, `expected ~111%, got ${cagr}`);
});

test("netIncomeCagrPct: needs >=3 points", () => {
  assert.equal(netIncomeCagrPct([{ netIncome: 10 }, { netIncome: 5 }]), null);
  assert.equal(netIncomeCagrPct(null), null);
  assert.equal(netIncomeCagrPct([]), null);
});

test("netIncomeCagrPct: null when an endpoint is <= 0 (sign flip is meaningless)", () => {
  assert.equal(netIncomeCagrPct([{ netIncome: 100 }, { netIncome: 50 }, { netIncome: -10 }]), null);
  assert.equal(netIncomeCagrPct([{ netIncome: -100 }, { netIncome: 50 }, { netIncome: 30 }]), null);
});

test("netIncomeCagrPct: shrinking-but-positive earnings yields a negative CAGR", () => {
  const cagr = netIncomeCagrPct([{ netIncome: 50 }, { netIncome: 75 }, { netIncome: 100 }]);
  assert.ok(cagr < 0, `expected negative, got ${cagr}`);
});

test("resolve: no Groww coverage -> row omitted (value null)", () => {
  const r = resolvePegDisplay({ growwPeg: null, pe: 30, yoyEarningsGrowthPct: 20 });
  assert.deepEqual(r, { peg: null, basis: null, value: null });
});

test("resolve: positive Groww peg passes through unchanged (Refinitiv basis)", () => {
  const r = resolvePegDisplay({ growwPeg: 1.9224, pe: 32.69, netIncomeHistory: JSLL_NI });
  assert.equal(r.basis, "refinitiv");
  assert.equal(r.value, "1.92");
});

test("resolve: JSLL false-NM case — negative Groww peg recomputes to a low positive PEG", () => {
  // Production state: Groww peg flipped negative though JSLL grows fast.
  const r = resolvePegDisplay({ growwPeg: -5.3, pe: 32.3, netIncomeHistory: JSLL_NI });
  assert.equal(r.basis, "computed");
  const v = Number(r.value);
  assert.ok(v > 0 && v < 1, `expected sub-1 PEG, got ${r.value}`);
});

test("resolve: POWERGRID-style false-NM — negative peg but modest positive growth", () => {
  const pgNi = [
    { netIncome: 15245 },
    { netIncome: 16144 },
    { netIncome: 15171 },
    { netIncome: 17353 },
    { netIncome: 11674 },
  ];
  const r = resolvePegDisplay({ growwPeg: -58.25, pe: 16.77, netIncomeHistory: pgNi });
  assert.equal(r.basis, "computed");
  const v = Number(r.value);
  assert.ok(v > 1 && v < 5, `expected a low-single-digit PEG, got ${r.value}`);
});

test("resolve: falls back to trailing YoY when no usable net-income history", () => {
  const r = resolvePegDisplay({ growwPeg: -3, pe: 40, netIncomeHistory: null, yoyEarningsGrowthPct: 20 });
  assert.equal(r.basis, "computed");
  assert.equal(r.value, "2.00");
});

test("resolve: genuine Not-meaningful — negative peg AND shrinking earnings", () => {
  const shrinking = [{ netIncome: 50 }, { netIncome: 80 }, { netIncome: 100 }];
  const r = resolvePegDisplay({ growwPeg: -4, pe: 30, netIncomeHistory: shrinking, yoyEarningsGrowthPct: -12 });
  assert.equal(r.basis, "not_meaningful");
  assert.equal(r.value, "Not meaningful");
});

test("resolve: genuine Not-meaningful — negative peg, no growth data at all", () => {
  const r = resolvePegDisplay({ growwPeg: -2, pe: 25, netIncomeHistory: null, yoyEarningsGrowthPct: null });
  assert.equal(r.basis, "not_meaningful");
  assert.equal(r.value, "Not meaningful");
});

test("resolve: near-zero growth can't manufacture a huge PEG (cap enforced)", () => {
  // pe 40 / 0.5% growth = 80 > cap -> not meaningful, not a fake bargain-looking number.
  const r = resolvePegDisplay({ growwPeg: -1, pe: 40, yoyEarningsGrowthPct: 0.5 });
  assert.equal(r.basis, "not_meaningful");
  assert.ok(80 > PEG_DISPLAY_CAP);
});

test("resolve: computed PEG right at the cap is still shown", () => {
  // pe 40 / 2% = 20 == cap -> shown.
  const r = resolvePegDisplay({ growwPeg: -1, pe: 40, yoyEarningsGrowthPct: 2 });
  assert.equal(r.basis, "computed");
  assert.equal(r.value, "20.00");
});

test("netIncomeCagrPct: uses actual year span across gaps, not point count", () => {
  // 2018 -> 2023 (span 5) with a missing middle year; 100 -> 200.
  const rows = [
    { year: 2023, netIncome: 200 },
    { year: 2022, netIncome: 170 },
    { year: 2020, netIncome: 130 },
    { year: 2018, netIncome: 100 },
  ];
  const cagr = netIncomeCagrPct(rows);
  const expected = (Math.pow(200 / 100, 1 / 5) - 1) * 100; // 5-year span, not 3
  assert.ok(Math.abs(cagr - expected) < 1e-6, `expected ${expected}, got ${cagr}`);
});

test("growwProfitToHistory: {year: profit} map -> newest-first rows", () => {
  const h = growwProfitToHistory({ 2022: 11.19, 2023: 33.52, 2024: 50 });
  assert.equal(h[0].year, 2024);
  assert.equal(h[h.length - 1].year, 2022);
  assert.equal(growwProfitToHistory(null), null);
  assert.equal(growwProfitToHistory({}), null);
});

test("resolve: rescues via Groww profit series when fiscal history is absent", () => {
  // The 379-stock class: deep fiscal.yearly_history has no netIncome, but
  // Groww's yearly profit series does — recompute off that.
  const growwProfit = { 2020: 322.17, 2021: 162.38, 2022: 271.97, 2023: 451.02, 2024: 583.42 }; // 3MINDIA
  const r = resolvePegDisplay({ growwPeg: -3.71, pe: 68.24, netIncomeHistory: null, growwProfit });
  assert.equal(r.basis, "computed");
  const v = Number(r.value);
  assert.ok(v > 2 && v < 7, `expected mid-single-digit PEG, got ${r.value}`);
});

test("resolve: fiscal history wins over Groww profit series when both present", () => {
  const r = resolvePegDisplay({
    growwPeg: -1,
    pe: 30,
    netIncomeHistory: JSLL_NI,             // ~111% CAGR -> PEG ~0.27
    growwProfit: { 2022: 100, 2023: 105 }, // only 2 pts, unusable anyway
  });
  assert.equal(r.basis, "computed");
  assert.ok(Number(r.value) < 0.5);
});

test("resolve: sub-floor P/E is not rescued — garbage low P/E -> Not meaningful", () => {
  // RELINFRA-style: pe 0.73 / big growth would fake a 0.03 PEG. Floor blocks it.
  const r = resolvePegDisplay({ growwPeg: -0.1, pe: 0.73, yoyEarningsGrowthPct: 25 });
  assert.equal(r.basis, "not_meaningful");
  assert.ok(PEG_MIN_PE >= 3);
});

test("resolve: P/E just below the floor -> Not meaningful; at the floor -> computed", () => {
  const below = resolvePegDisplay({ growwPeg: -1, pe: PEG_MIN_PE - 0.01, yoyEarningsGrowthPct: 20 });
  assert.equal(below.basis, "not_meaningful");
  const at = resolvePegDisplay({ growwPeg: -1, pe: PEG_MIN_PE, yoyEarningsGrowthPct: 20 });
  assert.equal(at.basis, "computed");
});

test("resolve: legit deep-value P/E (IOC/BPCL ~4-5) still resolves through the floor", () => {
  const ioc = resolvePegDisplay({ growwPeg: -0.19, pe: 4.42, yoyEarningsGrowthPct: 149.3 });
  assert.equal(ioc.basis, "computed");
  const bpcl = resolvePegDisplay({ growwPeg: -0.12, pe: 4.84, yoyEarningsGrowthPct: 49.1 });
  assert.equal(bpcl.basis, "computed");
});

test("resolve: negative CAGR is NOT rescued by a spiky positive YoY (conservative)", () => {
  // Multi-year earnings shrank (CAGR<0); a one-off positive YoY must not
  // manufacture an attractive PEG for a structurally declining company.
  const shrinking = [{ netIncome: 60 }, { netIncome: 90 }, { netIncome: 120 }];
  const r = resolvePegDisplay({ growwPeg: -3, pe: 30, netIncomeHistory: shrinking, yoyEarningsGrowthPct: 40 });
  assert.equal(r.basis, "not_meaningful");
});
