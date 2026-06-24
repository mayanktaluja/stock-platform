/**
 * Run with: node test/quietHours.test.mjs
 */

import assert from "node:assert/strict";
import { istHour, isQuietHoursIST, suppressNews } from "../services/alerts/quietHours.js";

// IST = UTC + 5:30.
assert.equal(istHour(new Date("2026-06-24T06:00:00Z")), 11); // 11:30 IST
assert.equal(istHour(new Date("2026-06-24T18:00:00Z")), 23); // 23:30 IST
assert.equal(istHour(new Date("2026-06-24T20:00:00Z")), 1); // 01:30 IST next day
assert.equal(istHour(new Date("2026-06-24T01:00:00Z")), 6); // 06:30 IST

// Quiet window 23:00–07:00 IST.
assert.equal(isQuietHoursIST(new Date("2026-06-24T18:00:00Z")), true); // 23:30 IST
assert.equal(isQuietHoursIST(new Date("2026-06-24T20:00:00Z")), true); // 01:30 IST
assert.equal(isQuietHoursIST(new Date("2026-06-24T00:30:00Z")), true); // 06:00 IST
assert.equal(isQuietHoursIST(new Date("2026-06-24T06:00:00Z")), false); // 11:30 IST — market hours
assert.equal(isQuietHoursIST(new Date("2026-06-24T09:00:00Z")), false); // 14:30 IST

// Routine NEWS is suppressed in quiet hours; breaking always passes.
assert.equal(suppressNews({ breaking: false, date: new Date("2026-06-24T20:00:00Z") }), true);
assert.equal(suppressNews({ breaking: true, date: new Date("2026-06-24T20:00:00Z") }), false);
assert.equal(suppressNews({ breaking: false, date: new Date("2026-06-24T06:00:00Z") }), false);

console.log("quietHours.test.mjs OK");
