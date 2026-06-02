/**
 * Prod-like auth smoke for lab read APIs.
 *
 * Verifies retired sleeve APIs stay behind auth for anonymous users and return
 * 404 for signed-in users, while the active 5x Lab APIs remain signed-in read
 * surfaces. The test starts server.js with AUTH_ENABLED=true and signs a
 * non-admin session cookie using the same HMAC format as the app.
 *
 * Run with: node test/labRoutesSignedIn.test.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";

const ROOT = process.cwd();
const USERS_PATH = path.join(ROOT, "users.json");
const PORT = 4127;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const SUB = "signed-in-lab-reader";

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

function signSession(sub) {
  const payload = Buffer.from(`sess:${JSON.stringify({ sub, ts: Date.now() })}`, "utf8").toString("base64url");
  const sig = createHmac("sha256", SECRET).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

async function waitForServer(child) {
  let out = "";
  child.stdout.on("data", (d) => { out += String(d); });
  child.stderr.on("data", (d) => { out += String(d); });
  const started = Date.now();
  while (Date.now() - started < 20_000) {
    if (out.includes(`http://localhost:${PORT}`)) return;
    if (child.exitCode !== null) throw new Error(`server exited early:\n${out}`);
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`server did not start:\n${out}`);
}

const priorUsers = fs.existsSync(USERS_PATH) ? fs.readFileSync(USERS_PATH, "utf8") : null;
const userRecord = {
  [SUB]: {
    sub: SUB,
    email: "signed-in-reader@example.com",
    name: "Signed In Reader",
    picture: "",
    isAdmin: false,
  },
};

let child;
try {
  fs.writeFileSync(USERS_PATH, JSON.stringify(userRecord, null, 2));
  child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(PORT),
      STARBHAI_SESSION_SECRET: SECRET,
      GOOGLE_CLIENT_ID: "test-client",
      GOOGLE_CLIENT_SECRET: "test-secret",
      GOOGLE_OAUTH_REDIRECT_URI: `${BASE}/api/auth/google/callback`,
      KV_REST_API_URL: "",
      KV_REST_API_TOKEN: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForServer(child);

  const cookie = `starbhai_session=${signSession(SUB)}`;
  const signedIn = { headers: { cookie, accept: "application/json" } };

  const retiredRoutes = [
    "/api/compounder/latest",
    "/api/compounder/paper-trades",
    "/api/earnings-edge/latest",
    "/api/earnings-edge/paper-trades",
  ];

  console.log("\nlabRoutesSignedIn — retired sleeve APIs stay auth-gated for anonymous users");
  for (const route of retiredRoutes) {
    const res = await fetch(`${BASE}${route}`, { headers: { accept: "application/json" } });
    const body = await res.json().catch(() => ({}));
    assert(`${route} returns 401 for anonymous users`, res.status === 401 && body.error === "unauthenticated", { status: res.status, body });
  }

  console.log("\nlabRoutesSignedIn — retired sleeve APIs are gone for signed-in users");
  for (const route of retiredRoutes) {
    const res = await fetch(`${BASE}${route}`, signedIn);
    assert(`${route} returns 404 for signed-in non-admin`, res.status === 404, { status: res.status });
  }

  console.log("\nlabRoutesSignedIn — signed-in non-admin users can still read active 5x Lab APIs");
  for (const route of [
    "/api/multibagger/overview",
    "/api/multibagger/candidates?verdict=HIGH_CONVICTION&limit=3",
    "/api/multibagger/portfolio",
  ]) {
    const res = await fetch(`${BASE}${route}`, signedIn);
    const body = await res.json().catch(() => ({}));
    assert(`${route} returns 200 for signed-in non-admin`, res.status === 200, { status: res.status, body });
  }
} finally {
  if (child && child.exitCode === null) child.kill("SIGTERM");
  if (priorUsers === null) {
    try { fs.unlinkSync(USERS_PATH); } catch {}
  } else {
    fs.writeFileSync(USERS_PATH, priorUsers);
  }
}

console.log(`\nResult: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
