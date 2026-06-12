#!/usr/bin/env node
/**
 * One-time Gmail OAuth helper for the SWS alert sender.
 *
 * Usage:
 *   node scripts/gmail-oauth-local.mjs --env-file=/tmp/stock-platform-prod.env
 *
 * Default redirect URI is http://localhost:3000/api/auth/google/callback,
 * matching the local redirect URI documented in .env.example. The helper
 * starts a tiny local callback server, opens Google consent, and prints the
 * refresh-token env vars to copy into Vercel.
 */

import dotenv from "dotenv";
import http from "node:http";
import { spawn } from "node:child_process";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";

function argFlag(name) {
  return process.argv.includes(`--${name}`);
}

function argValue(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

const envFile = argValue("env-file");
if (envFile) dotenv.config({ path: envFile, quiet: true });

const clientId = process.env.GMAIL_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GMAIL_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET;
const port = Number(argValue("port") || process.env.GMAIL_OAUTH_LOCAL_PORT || 3000);
const callbackPath = argValue("callback-path") || process.env.GMAIL_OAUTH_CALLBACK_PATH || "/api/auth/google/callback";
const redirectUri = argValue("redirect-uri") || `http://localhost:${port}${callbackPath}`;
const sender = argValue("sender") || process.env.GMAIL_SENDER_EMAIL || "mtaluja11@gmail.com";

if (!clientId || !clientSecret) {
  console.error("[gmail-oauth] Missing GMAIL_CLIENT_ID/GMAIL_CLIENT_SECRET (or GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET fallback).");
  process.exit(1);
}

async function exchangeCode(code) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok || !json?.refresh_token) {
    throw new Error(JSON.stringify(json || text));
  }
  return json;
}

const codePromise = new Promise((resolve, reject) => {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", redirectUri);
      if (url.pathname !== callbackPath) {
        res.writeHead(404).end("Not found");
        return;
      }
      const error = url.searchParams.get("error");
      if (error) throw new Error(error);
      const code = url.searchParams.get("code");
      if (!code) throw new Error("No code in callback");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<h1>Gmail sender connected</h1><p>You can close this tab and return to Codex.</p>");
      server.close();
      resolve(code);
    } catch (err) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(err?.message || String(err));
      server.close();
      reject(err);
    }
  });
  server.on("error", reject);
  server.listen(port);
});

const params = new URLSearchParams({
  client_id: clientId,
  redirect_uri: redirectUri,
  response_type: "code",
  scope: GMAIL_SEND_SCOPE,
  access_type: "offline",
  prompt: "consent",
  include_granted_scopes: "true",
  login_hint: sender,
});
const authUrl = `${AUTH_URL}?${params.toString()}`;

console.log("\nOpen this URL and approve Gmail send access:\n");
console.log(authUrl);
console.log("\nWaiting for callback on", redirectUri, "\n");

if (!argFlag("no-open")) {
  try {
    const opener = spawn("open", [authUrl], { detached: true, stdio: "ignore" });
    opener.unref();
  } catch {}
}

const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for OAuth callback")), 5 * 60 * 1000));
const code = await Promise.race([codePromise, timeout]);
const token = await exchangeCode(code);

console.log("Approved. Add these to Vercel production env:\n");
console.log("SWS_MAIL_PROVIDER=gmail");
console.log(`GMAIL_CLIENT_ID=${clientId}`);
console.log("GMAIL_CLIENT_SECRET=<same value as your existing Google OAuth client secret>");
console.log(`GMAIL_REFRESH_TOKEN=${token.refresh_token}`);
console.log(`GMAIL_MAIL_FROM=Starbhai <${sender}>`);
console.log("SWS_INPUT_ALERT_GMAIL_DELAY_MS=750");
