#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const SRC_ROOT = path.join(ROOT, "gated");
const OUT_ROOT = path.join(ROOT, "public", "assets", "gated");

const ALLOWLIST = [
  "utils/formatIndianNumber.js",
  "glossary.js",
  "app.js",
  "swsV2Render.js",
  "earnings.js",
  "riskLab.js",
  "multibaggerLab.js",
  "sectorOutlook.js",
  "keyboard.js",
];

const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH |)?PRIVATE KEY-----/,
  /\b(?:api[_-]?key|secret|token|password)\b\s*[:=]\s*["'][A-Za-z0-9_\-./+=]{24,}["']/i,
  /\b(?:GROQ|OPENAI|ANTHROPIC|GEMINI|GOOGLE|VERCEL|KV)_[A-Z0-9_]*(?:KEY|SECRET|TOKEN)\b\s*[:=]\s*["'][^"']{8,}["']/,
];

function assertNoLikelySecrets(rel, source) {
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(source)) {
      throw new Error(`${rel} matches likely hardcoded secret pattern ${pattern}`);
    }
  }
}

function copyOne(rel) {
  const src = path.join(SRC_ROOT, rel);
  const out = path.join(OUT_ROOT, rel);
  if (!fs.existsSync(src)) throw new Error(`missing allowlisted asset ${rel}`);
  const source = fs.readFileSync(src, "utf-8");
  assertNoLikelySecrets(rel, source);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.copyFileSync(src, out);
}

fs.rmSync(OUT_ROOT, { recursive: true, force: true });
for (const rel of ALLOWLIST) copyOne(rel);
console.log(`[assets] published ${ALLOWLIST.length} gated client assets to ${path.relative(ROOT, OUT_ROOT)}`);
