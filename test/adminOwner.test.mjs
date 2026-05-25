/**
 * Tests for the hard-coded owner/admin identity in userStorage.js.
 *
 * Run with: node test/adminOwner.test.mjs
 */

import { computeIsAdmin } from "../userStorage.js";

let pass = 0;
let fail = 0;
function assert(name, cond, got) {
  if (cond) {
    pass++;
    console.log("  ✓", name);
  } else {
    fail++;
    console.log("  ✗", name, "→ got", JSON.stringify(got));
  }
}

const ORIG_ADMIN_EMAILS = process.env.ADMIN_EMAILS;

console.log("\nadminOwner — computeIsAdmin");

process.env.ADMIN_EMAILS = "mtaluja11@gmail.com, co@example.com";

assert("hard-coded owner email passes", computeIsAdmin("mtaluja11@gmail.com") === true);
assert("case-insensitive match", computeIsAdmin("MTALUJA11@GMAIL.COM") === true);
assert("whitespace-tolerant owner email passes", computeIsAdmin("  mtaluja11@gmail.com  ") === true);
assert("ADMIN_EMAILS does not grant admin", computeIsAdmin("co@example.com") === false);
assert("old misspelled owner email fails", computeIsAdmin("mthaluja11@gmail.com") === false);
assert("non-owner fails", computeIsAdmin("random@x.com") === false);
assert("empty email fails", computeIsAdmin("") === false);
assert("null email fails", computeIsAdmin(null) === false);
assert("undefined email fails", computeIsAdmin(undefined) === false);

console.log("\nadminOwner — computeIsAdmin ignores env mutation");

process.env.ADMIN_EMAILS = "";
assert("empty ADMIN_EMAILS does not revoke the owner", computeIsAdmin("mtaluja11@gmail.com") === true);
process.env.ADMIN_EMAILS = "co@example.com";
assert("mutated ADMIN_EMAILS still does not grant co-admin", computeIsAdmin("co@example.com") === false);

if (ORIG_ADMIN_EMAILS === undefined) delete process.env.ADMIN_EMAILS;
else process.env.ADMIN_EMAILS = ORIG_ADMIN_EMAILS;

console.log(`\nResult: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
