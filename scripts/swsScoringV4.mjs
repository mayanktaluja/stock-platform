// Script-side entry for the V4 score. Single source of truth lives in
// services/swsScoringV4.js; this thin re-export lets the 4 scoring scripts
// (sws-scoring.mjs + the US/region forks) import it without a second mirror to
// hand-sync. No cross-dir import cycle: services/swsScoringV4.js only reaches
// down into services/swsScoring.js + ../surveillance.js, never back into scripts/.
export * from "../services/swsScoringV4.js";
