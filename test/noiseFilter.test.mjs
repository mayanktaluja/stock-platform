/**
 * Run with: node test/noiseFilter.test.mjs
 */

import assert from "node:assert/strict";
import { compileNoiseGate, matchNoise } from "../services/alerts/noiseFilter.js";

const g = compileNoiseGate(["earthquake", "tsunami", "magnitude", "quake", "seismic", "hurricane warning"]);

// Disaster spam → muted.
assert.equal(matchNoise("Earthquake magnitude 6.54 hits near Japan's Honshu coast", g), true);
assert.equal(matchNoise("No tsunami alert declared after Japan quake: NHK", g), true);
assert.equal(matchNoise("U.S. tsunami warning system: no alert, advisory, watch", g), true);
assert.equal(matchNoise("Hurricane Warning issued for Florida coast", g), true);
// Plurals/inflections via leading-boundary stem match.
assert.equal(matchNoise("Multiple earthquakes reported", g), true);
assert.equal(matchNoise("seismic activity detected", g), true);

// Market news → NOT muted.
assert.equal(matchNoise("RBI issues final forex risk framework for banks", g), false);
assert.equal(matchNoise("Nifty closes at lifetime high; Reliance up 3%", g), false);
assert.equal(matchNoise("Fed hikes rates by 25 bps", g), false);
// "quake" standalone only — does NOT fire on unrelated words.
assert.equal(matchNoise("a remarkable quarter for earnings", g), false);

// Empty gate / empty text.
assert.equal(matchNoise("earthquake", compileNoiseGate([])), false);
assert.equal(matchNoise("", g), false);

console.log("noiseFilter.test.mjs OK");
