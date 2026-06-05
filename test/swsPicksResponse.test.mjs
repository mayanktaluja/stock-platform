import test from "node:test";
import assert from "node:assert/strict";

import { filterPicksWithDeepDataFailOpen } from "../services/swsPicksResponse.js";

test("filterPicksWithDeepDataFailOpen keeps India section rows when deep lookup fails for the whole section", () => {
  const rows = [
    { ticker: "AAA", name: "AAA Ltd" },
    { ticker: "BBB", name: "BBB Ltd" },
  ];
  const counter = { count: 0, sample: [], failOpenSections: [] };

  const out = filterPicksWithDeepDataFailOpen(
    "top_ranked_30_v4",
    rows,
    () => null,
    counter,
  );

  assert.equal(out, rows);
  assert.equal(out.length, 2);
  assert.deepEqual(counter, {
    count: 2,
    sample: ["AAA", "BBB"],
    failOpenSections: ["top_ranked_30_v4"],
  });
});

test("filterPicksWithDeepDataFailOpen still removes isolated missing-deep rows when coverage is healthy", () => {
  const rows = [
    { ticker: "AAA", name: "AAA Ltd" },
    { ticker: "BBB", name: "BBB Ltd" },
  ];
  const counter = { count: 0, sample: [], failOpenSections: [] };

  const out = filterPicksWithDeepDataFailOpen(
    "quality_growth",
    rows,
    (ticker) => (ticker === "AAA" ? { ticker: "AAA" } : null),
    counter,
  );

  assert.deepEqual(out, [{ ticker: "AAA", name: "AAA Ltd" }]);
  assert.deepEqual(counter, {
    count: 1,
    sample: ["BBB"],
    failOpenSections: [],
  });
});
