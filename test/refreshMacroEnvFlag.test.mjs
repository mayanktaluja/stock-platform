// scripts/refresh-macro-regime.mjs — env-flag regression test.
//
// Verifies the two branches around `MACRO_ALLOW_HEURISTIC_ONLY` when both
// GROQ_API_KEY and GEMINI_API_KEY are absent:
//   (1) flag unset           → exit 9 (strict; refuses to downgrade)
//   (2) flag = "1"           → does NOT exit 9 within 1.5s (proceeds past
//                              the env check into the network fetch; we
//                              kill the process before it makes RSS calls)
//
// We spawn the actual script with a stripped env so the .env file the
// script auto-loads from the repo doesn't leak keys into the test.

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

function runScript(env, killAfterMs = null) {
  return new Promise((resolve) => {
    const child = spawn("node", [SCRIPT], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", killed = false;
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
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
await it("does NOT exit 9 within 1.5s (proceeds past env check)", async () => {
  const r = await runScript(
    { ...STRIPPED_ENV, MACRO_ALLOW_HEURISTIC_ONLY: "1" },
    1500
  );
  // The script proceeds past the env check and starts fetching RSS. We
  // kill it before the network call completes, so the exit code is
  // typically null (signal=SIGTERM) or 1 (interrupted main()). The key
  // assertion: it did NOT exit 9 immediately.
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
