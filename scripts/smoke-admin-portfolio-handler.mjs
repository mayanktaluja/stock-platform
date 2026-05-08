/**
 * Replicates the /api/admin/users + /api/admin/users/:sub/portfolio.xlsx
 * handler bodies against the on-disk storage we just wrote, to prove the
 * admin Users tab will see hasPortfolio=true and the XLSX endpoint will
 * stream a real workbook (instead of 404 "empty-portfolio").
 *
 * The admin route handlers themselves require AUTH_ENABLED, which we
 * can't flip on in dev without configuring OAuth — so we exercise the
 * storage code path the handlers use, end-to-end.
 */

import { existsSync, readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SUB = "_local_dev";

const { getPortfolioStorage } = await import(path.join(ROOT, "portfolioStorage.js"));

console.log("\n== smoke-admin-portfolio-handler ==\n");

if (!existsSync(path.join(ROOT, "portfolios.json"))) {
  console.error("✗ run smoke-admin-portfolio.mjs first to seed portfolios.json");
  process.exit(1);
}

// 1. Mimic /api/admin/users hasPortfolio annotation logic
const portfolioStore = getPortfolioStorage();
const p = await portfolioStore.read(SUB);
const hasPortfolio = !!(p && ((p.stocks && p.stocks.length) || (p.mutualFunds && p.mutualFunds.length)));
console.log(`/api/admin/users → user "${SUB}" hasPortfolio = ${hasPortfolio}`);
if (!hasPortfolio) {
  console.error(`✗ admin Users tab would show "—" instead of XLSX download link`);
  process.exit(1);
}
console.log(`✓ admin Users tab will show XLSX download link`);

// 2. Mimic /api/admin/users/:sub/portfolio.xlsx body
const portfolio = await portfolioStore.read(SUB);
const hasStocks = portfolio.stocks && portfolio.stocks.length;
const hasMFs = portfolio.mutualFunds && portfolio.mutualFunds.length;
if (!hasStocks && !hasMFs) {
  console.error(`✗ XLSX endpoint would 404 with empty-portfolio`);
  process.exit(1);
}
console.log(`✓ XLSX endpoint can read portfolio (stocks=${portfolio.stocks?.length || 0}, mfs=${portfolio.mutualFunds?.length || 0})`);

const xlsxMod = await import("xlsx");
const xlsx = xlsxMod.default || xlsxMod;
const wb = xlsx.utils.book_new();
if (hasStocks) xlsx.utils.book_append_sheet(wb, xlsx.utils.json_to_sheet(portfolio.stocks), "Stocks");
if (hasMFs) xlsx.utils.book_append_sheet(wb, xlsx.utils.json_to_sheet(portfolio.mutualFunds), "Mutual Funds");
const buf = xlsx.write(wb, { type: "buffer", bookType: "xlsx" });
console.log(`✓ XLSX builds (${buf.length} bytes, sheets=${wb.SheetNames.join(",")})`);

// Confirm the filename slug logic the handler uses doesn't throw on a synthetic
// user shape (mirrors line 2971 of server.js).
const target = { email: "test@example.com", name: "Test User", sub: SUB };
const slug = String(target.email || target.name || target.sub)
  .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "user";
const date = new Date().toISOString().slice(0, 10);
const filename = `portfolio-${slug}-${date}.xlsx`;
console.log(`✓ Content-Disposition filename: ${filename}`);

console.log("\n== smoke-admin-portfolio-handler: PASS ==\n");
