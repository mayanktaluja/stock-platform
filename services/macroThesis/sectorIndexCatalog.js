// Catalog of Nifty sector indices used by the macro-thesis module (PR B1.1).
//
// Each entry maps:
//   key:      the canonical identifier used throughout services/macroThesis
//   label:    human-readable display name
//   sector:   the SWS / picks-latest sector bucket this index represents
//             (used to bridge analog returns ←→ stock-level scoring)
//   yahoo:    the Yahoo Finance symbol used by refresh-sector-indices.mjs
//   regimes:  regime keywords this sector is materially exposed to
//             (used by sectorBeneficiaryRanker for offensive thesis cards)
//
// The Yahoo symbols here are the public spot indices. Some sectors have
// no clean Yahoo equivalent (e.g. Defence is a thematic basket NSE
// publishes but Yahoo doesn't mirror cleanly) — those map to the closest
// proxy + a note in the `proxy` field.

export const SECTOR_INDEX_CATALOG = Object.freeze([
  { key: "NIFTY_IT",          label: "Nifty IT",                sector: "Software",         yahoo: "^CNXIT" },
  { key: "NIFTY_AUTO",        label: "Nifty Auto",              sector: "Automobiles",      yahoo: "^CNXAUTO" },
  { key: "NIFTY_REALTY",      label: "Nifty Realty",            sector: "Real Estate",      yahoo: "^CNXREALTY" },
  { key: "NIFTY_BANK",        label: "Nifty Bank",              sector: "Banks",            yahoo: "^NSEBANK" },
  { key: "NIFTY_PHARMA",      label: "Nifty Pharma",            sector: "Pharmaceuticals",  yahoo: "^CNXPHARMA" },
  { key: "NIFTY_ENERGY",      label: "Nifty Energy",            sector: "Energy",           yahoo: "^CNXENERGY" },
  { key: "NIFTY_METAL",       label: "Nifty Metal",             sector: "Metals & Mining",  yahoo: "^CNXMETAL" },
  { key: "NIFTY_FMCG",        label: "Nifty FMCG",              sector: "Consumer Staples", yahoo: "^CNXFMCG" },
  { key: "NIFTY_MEDIA",       label: "Nifty Media",             sector: "Media",            yahoo: "^CNXMEDIA" },
  { key: "NIFTY_PSU_BANK",    label: "Nifty PSU Bank",          sector: "PSU Banks",        yahoo: "^CNXPSUBANK" },
  { key: "NIFTY_PVT_BANK",    label: "Nifty Private Bank",      sector: "Private Banks",    yahoo: "^NIFTYPVTBANK" },
  { key: "NIFTY_HEALTHCARE",  label: "Nifty Healthcare",        sector: "Healthcare",       yahoo: "^CNXHEALTH" },
  { key: "NIFTY_INFRA",       label: "Nifty Infrastructure",    sector: "Capital Goods",    yahoo: "^CNXINFRA" },
  { key: "NIFTY_CPSE",        label: "Nifty CPSE",              sector: "PSU",              yahoo: "^CPSE" },
  { key: "NIFTY_50",          label: "Nifty 50 (broad market)", sector: "ALL",              yahoo: "^NSEI" },
]);

export const SECTOR_KEYS = SECTOR_INDEX_CATALOG.map((s) => s.key);

export function getSectorEntry(key) {
  return SECTOR_INDEX_CATALOG.find((s) => s.key === key) || null;
}

export function getEntryForSectorName(sectorName) {
  if (!sectorName) return null;
  const norm = String(sectorName).toLowerCase();
  return (
    SECTOR_INDEX_CATALOG.find((s) => s.sector.toLowerCase() === norm) ||
    SECTOR_INDEX_CATALOG.find((s) => s.sector.toLowerCase().includes(norm) || norm.includes(s.sector.toLowerCase())) ||
    null
  );
}

export default { SECTOR_INDEX_CATALOG, SECTOR_KEYS, getSectorEntry, getEntryForSectorName };
