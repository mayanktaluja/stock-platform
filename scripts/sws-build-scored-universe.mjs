#!/usr/bin/env node
// One-shot backfill for data/sws/sws-scored-universe.json — the slim index
// that powers global picks-tab search across the full ~5,439-stock SWS
// universe. Run ONCE after this feature lands so the file exists without
// waiting for the next ~2-day refresh; thereafter runFullScoring() in
// sws-scoring.mjs writes it as a side effect of every refresh.
//
// Usage:  node scripts/sws-build-scored-universe.mjs
import { runFullScoring } from "./sws-scoring.mjs";

const out = runFullScoring();
console.log(`Scored ${out.scored_count} stocks (${out.failed_count} failed). sws-scored-universe.json refreshed.`);
