import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log("✓", name);
  } catch (err) {
    fail++;
    console.log("✗", name, "→", err.message);
  }
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "region-dal-canonical-"));
process.env.SWS_REPO_ROOT_OVERRIDE = root;

writeJson(path.join(root, "data/sws-kr/sws-scored-universe.json"), {
  stocks: [{ ticker: "0001a0.KQ", name: "Deokyang Energen Corporation", sector: "Materials" }],
});
writeJson(path.join(root, "data/sws-kr/deep/0001a0.KQ.json"), {
  ticker: "0001a0.KQ",
  name: "Deokyang Energen Corporation",
});
writeJson(path.join(root, "data/sws-tw/sws-scored-universe.json"), {
  stocks: [{ ticker: "8349a.TWO", name: "Hengtong", sector: "Technology" }],
});
writeJson(path.join(root, "data/sws-tw/deep/8349a.TWO.json"), {
  ticker: "8349a.TWO",
  name: "Hengtong",
});

const { makeRegionPicksDal } = await import("../services/regionPicksDal.js");

const kr = makeRegionPicksDal("kr");
const tw = makeRegionPicksDal("tw");

check("KR resolver preserves canonical lower-case ticker", () => {
  assert.equal(kr.resolveCanonicalTicker("0001A0.KQ"), "0001a0.KQ");
});

check("KR deep lookup accepts uppercase user input but reads canonical file", () => {
  assert.equal(kr.getStockByTicker("0001A0.KQ")?.ticker, "0001a0.KQ");
});

check("TW resolver preserves canonical lower-case ticker", () => {
  assert.equal(tw.resolveCanonicalTicker("8349A.TWO"), "8349a.TWO");
});

check("TW deep lookup accepts uppercase user input but reads canonical file", () => {
  assert.equal(tw.getStockByTicker("8349A.TWO")?.ticker, "8349a.TWO");
});

if (fail) {
  console.error(`\n${fail} region canonical test(s) failed`);
  process.exit(1);
}
console.log(`\n${pass} region canonical tests passed`);
