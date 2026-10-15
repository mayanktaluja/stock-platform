// scripts/refresh-macro-regime.mjs — env-flag regression test.
//
// Verifies the two branches around `MACRO_ALLOW_HEURISTIC_ONLY` when both
// GROQ_API_KEY and GEMINI_API_KEY are absent:
//   (1) flag unset           → exit 9 (strict; refuses to downgrade)
//   (2) flag = "1"           → does NOT exit 9 (proceeds past the env check)
//
// We spawn the actual script with a stripped env so the .env file the
// script auto-loads from the repo doesn't leak keys into the test.
//
// Both runs pass --dry-run and (2) is killed the moment it prints the
// opt-in line. It used to be killed on a fixed 1.5s timer, but a heuristic-
// only refresh on a fast network takes ~1.5s end to end (measured 1.53s,
// 1.57s; 9.9s when a feed times out) — so it intermittently finished first
// and rewrote the REAL data/macroRegime.json, its history and
// data/macro-headlines/ in the working tree on every `npm test` / pre-push.

import { spawn } from "node:child_process";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCRIPT = path.join(__dirname, "..", "scripts", "refresh-macro-regime.mjs");

// .env loading in the script uses `override: false`, so a real env var
// wins over the file. Set both keys to empty strings to force the
// "no LLM keys" branch even if the repo's .env has real keys.
const STRIPPED_ENV = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  GROQ_API_KEY: "",
  GEMINI_API_KEY: "",
};

let ok = 0, fail = 0;
function it(name, fn) {
  return fn()
    .then(() => { console.log("  ✓", name); ok += 1; })
    .catch((e) => { console.log("  ✗", name, "\n   ", e && e.message); fail += 1; });
}

function runScript(env, killAfterMs = null, killOn = null) {
  return new Promise((resolve) => {
    const child = spawn("node", [SCRIPT, "--dry-run"], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", killed = false;
    const onData = () => {
      if (killOn && !killed && killOn.test(stdout + stderr)) { killed = true; child.kill("SIGTERM"); }
    };
    child.stdout.on("data", (d) => { stdout += d.toString(); onData(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); onData(); });
    let killer = null;
    if (killAfterMs) {
      killer = setTimeout(() => { killed = true; child.kill("SIGTERM"); }, killAfterMs);
    }
    child.on("exit", (code, signal) => {
      if (killer) clearTimeout(killer);
      resolve({ code, signal, stdout, stderr, killed });
    });
  });
}

console.log("[1] strict mode — no keys, no flag");
await it("exits 9 within 2s", async () => {
  const r = await runScript({ ...STRIPPED_ENV }, 5000);
  assert.equal(r.code, 9, `expected exit 9, got code=${r.code} signal=${r.signal}`);
  assert.match(
    r.stderr,
    /no GROQ_API_KEY and no GEMINI_API_KEY in env — refusing to run/,
    `expected strict-refusal message in stderr, got: ${r.stderr.slice(0, 200)}`
  );
});

console.log("[2] heuristic-only opt-in — no keys, flag = 1");
await it("does NOT exit 9 (proceeds past env check)", async () => {
  const r = await runScript(
    { ...STRIPPED_ENV, MACRO_ALLOW_HEURISTIC_ONLY: "1" },
    15000, // backstop only; the opt-in line kills it long before any fetch returns
    /MACRO_ALLOW_HEURISTIC_ONLY=1 — running keyword-only heuristic/,
  );
  // Killed as soon as the opt-in line appears, so the exit is SIGTERM (or 0
  // under --dry-run if it somehow finished). The key assertion: not exit 9.
  assert.notEqual(r.code, 9, `should not exit 9; got code=${r.code} signal=${r.signal} stderr=${r.stderr.slice(0, 200)}`);
  assert.match(
    r.stderr + r.stdout,
    /MACRO_ALLOW_HEURISTIC_ONLY=1 — running keyword-only heuristic/,
    `expected heuristic-only opt-in message, got: stdout=${r.stdout.slice(0, 200)} stderr=${r.stderr.slice(0, 200)}`
  );
});

console.log("");
console.log(`Tests passed: ${ok}, failed: ${fail}`);
process.exit(fail > 0 ? 1 : 0);
