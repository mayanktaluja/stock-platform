import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const serverSource = fs.readFileSync(path.join(ROOT, "server.js"), "utf-8");

function extractFunction(name) {
  const marker = `function ${name}`;
  const start = serverSource.indexOf(marker);
  assert.notEqual(start, -1, `${name} must exist`);
  const nextFunction = serverSource.indexOf("\nfunction ", start + marker.length);
  const nextRoute = serverSource.indexOf('\napp.get("/api/sws-picks-summary"', start + marker.length);
  const endCandidates = [nextFunction, nextRoute].filter((n) => n > start);
  const end = Math.min(...endCandidates);
  assert.ok(Number.isFinite(end), `${name} body end must be discoverable`);
  return serverSource.slice(start, end);
}

function extractRoute(pathname) {
  const marker = `app.get("${pathname}"`;
  const start = serverSource.indexOf(marker);
  assert.notEqual(start, -1, `${pathname} route must exist`);
  const nextRoute = serverSource.indexOf('\napp.get("/api/sws-picks"', start + marker.length);
  assert.ok(nextRoute > start, `${pathname} route body end must be discoverable`);
  return serverSource.slice(start, nextRoute);
}

const summaryBuilder = extractFunction("buildSwsPicksSummaryPayload");
const summaryRoute = extractRoute("/api/sws-picks-summary");
const summarySource = `${summaryBuilder}\n${summaryRoute}`;

assert.match(summarySource, /await getSnapshotFvMapSafe/);
assert.match(summarySource, /applyPicksFvDriftGuard/);
assert.match(summarySource, /fv_drift_skipped:\s*false/);
assert.doesNotMatch(summarySource, /filterPicksWithDeepDataFailOpen|getStockByTicker/);
assert.match(summarySource, /scan_status_hint/);
assert.match(summarySource, /summary_view/);
assert.match(summarySource, /liftSwsSectionAudit/);
assert.match(summarySource, /stampSwsDecisionContracts/);

console.log("sws picks summary route applies bounded FV drift guard without deep filters");
