#!/usr/bin/env node
/**
 * Recovery sender for SWS portfolio input alerts.
 *
 * Dry-run by default:
 *   node scripts/sws-input-alerts-recovery-send.mjs --env-file=/tmp/stock-platform-prod.env
 *
 * Live send:
 *   node scripts/sws-input-alerts-recovery-send.mjs --env-file=/tmp/stock-platform-prod.env --live
 *
 * Optional targeted test:
 *   node scripts/sws-input-alerts-recovery-send.mjs --env-file=/tmp/stock-platform-prod.env --only-email=mtaluja11@gmail.com --live
 */

import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getUserStorage } from "../userStorage.js";
import { getAnalyzerStorage } from "../analyzerStorage.js";
import { getPortfolioStorage } from "../portfolioStorage.js";
import { getSwsInputAlertLedgerStorage } from "../swsInputAlertLedgerStorage.js";
import {
  buildPortfolioSwsInputAlerts,
  buildSwsInputAlertEmail,
  loadMarketWideSwsInputChanges,
  normalizeSwsInputAlertPrefs,
} from "../services/swsPortfolioInputAlerts.js";
import { mailProvider, sendMail, validateBulkMailerConfig } from "../services/resendMailer.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const ALERT_ARTIFACT = path.join(ROOT, "data", "sws", "alerts", "fundamental-changes-latest.json");
const APP_URL = "https://starbhai-stock-platform.vercel.app/";

function argFlag(name) {
  return process.argv.includes(`--${name}`);
}

function argValue(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const envFile = argValue("env-file");
if (envFile) dotenv.config({ path: envFile, quiet: true });

const live = argFlag("live");
const onlyEmail = String(argValue("only-email") || "").trim().toLowerCase();
const dryRun = !live;
const provider = mailProvider();
const delayMs = provider === "gmail" ? Math.max(0, Number(process.env.SWS_INPUT_ALERT_GMAIL_DELAY_MS || 750) || 0) : 0;

if (live) {
  const preflight = validateBulkMailerConfig();
  if (!preflight.ok) {
    console.error(JSON.stringify({ ok: false, error: preflight.reason }, null, 2));
    process.exit(1);
  }
}

const market = loadMarketWideSwsInputChanges(ALERT_ARTIFACT);
const userStore = getUserStorage();
const users = await userStore.list();
const analyzerStore = getAnalyzerStorage();
const portfolioStore = getPortfolioStorage();
const ledger = getSwsInputAlertLedgerStorage();

const counts = {
  eligible: 0,
  sent: 0,
  failed: 0,
  deduped: 0,
  dry_run: 0,
  no_holdings: 0,
  no_alerts: 0,
  skipped: 0,
};
const results = [];

for (const user of users) {
  const email = String(user?.email || "").trim().toLowerCase();
  if (onlyEmail && email !== onlyEmail) continue;

  const prefs = normalizeSwsInputAlertPrefs(user?.notificationPrefs?.swsInputAlerts || {});
  if (!prefs.email) {
    counts.skipped++;
    continue;
  }

  let portfolio = null;
  try {
    portfolio = await buildPortfolioSwsInputAlerts(user.sub, market, { analyzerStore, portfolioStore });
    if (!portfolio.holdings_count) {
      counts.no_holdings++;
      continue;
    }
    if (!portfolio.alerts.length) {
      counts.no_alerts++;
      continue;
    }
    if (!portfolio.run_id || !portfolio.digest) {
      counts.failed++;
      results.push({ email, sub: user.sub, ok: false, failed: true, reason: "missing_dedupe_key" });
      continue;
    }

    counts.eligible++;
    const alreadySent = await ledger.hasEvent(user.sub, {
      type: "EMAIL_SENT",
      run_id: portfolio.run_id,
      digest: portfolio.digest,
    }) || (typeof ledger.hasEmailSentForRun === "function" && await ledger.hasEmailSentForRun(user.sub, portfolio.run_id));
    if (alreadySent) {
      counts.deduped++;
      results.push({ email, sub: user.sub, skipped: true, reason: "deduped", tickers: portfolio.alerts.map((a) => a.ticker) });
      continue;
    }

    const emailBody = buildSwsInputAlertEmail({
      alerts: portfolio.alerts,
      runId: portfolio.run_id,
      generatedAt: portfolio.generated_at,
      appUrl: APP_URL,
    });
    const sendResult = await sendMail({ to: email, ...emailBody }, { dryRun });

    if (sendResult.ok && !sendResult.skipped && live) {
      await ledger.appendEvents(user.sub, [{
        type: "EMAIL_SENT",
        run_id: portfolio.run_id,
        digest: portfolio.digest,
        alert_count: portfolio.alerts.length,
        email,
        provider: sendResult.provider || provider,
        message_id: sendResult.id || null,
        resend_id: sendResult.id || null,
      }]);
      counts.sent++;
    } else if (dryRun || sendResult.dry_run) {
      counts.dry_run++;
    } else {
      counts.failed++;
      await ledger.appendEvents(user.sub, [{
        type: "EMAIL_FAILED",
        run_id: portfolio.run_id,
        digest: portfolio.digest,
        alert_count: portfolio.alerts.length,
        email,
        provider: sendResult.provider || provider,
        status: sendResult.status || null,
        reason: sendResult.reason || "send_failed",
        error: sendResult.error || null,
        message_id: sendResult.id || null,
        resend_id: sendResult.id || null,
      }]);
    }

    results.push({
      email,
      sub: user.sub,
      ok: sendResult.ok,
      sent: sendResult.ok && !sendResult.skipped && live,
      dry_run: dryRun || !!sendResult.dry_run,
      skipped: !!sendResult.skipped,
      failed: !sendResult.ok,
      provider: sendResult.provider || provider,
      status: sendResult.status || null,
      reason: sendResult.reason || null,
      error: sendResult.error || null,
      alert_count: portfolio.alerts.length,
      tickers: portfolio.alerts.map((a) => a.ticker),
      id: sendResult.id || null,
    });
    if (live && provider === "gmail" && delayMs > 0) await sleep(delayMs);
  } catch (err) {
    counts.failed++;
    results.push({
      email,
      sub: user?.sub || null,
      ok: false,
      failed: true,
      reason: "exception",
      error: err?.message || String(err),
      alert_count: portfolio?.alerts?.length || 0,
    });
  }
}

const output = {
  ok: counts.failed === 0,
  live,
  dry_run: dryRun,
  provider,
  run_id: market.run_id,
  generated_at: market.generated_at,
  counts,
  results,
};

console.log(JSON.stringify(output, null, 2));
if (live && counts.failed > 0) process.exit(1);
