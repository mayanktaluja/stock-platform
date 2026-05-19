import {
  THEME_LABELS,
  VALID_THEMES,
  CLASSIFIER_VERSION,
  THEME_TIME_WEIGHT,
  canonicalizeTheme,
  MIN_CONFIDENCE,
  MIN_TOP2_GAP,
  VALID_SIGNS,
  VALID_INTENSITIES,
} from "../services/sectorOutlook/themeTaxonomy.js";

let _failed = 0;
function assert(name, cond, got) {
  if (cond) {
    console.log(`  ok: ${name}`);
  } else {
    console.log(`  FAIL: ${name}${got !== undefined ? ` — got ${JSON.stringify(got)}` : ""}`);
    _failed += 1;
  }
}

console.log("sectorOutlookTaxonomy: canonical labels");
{
  assert("8 themes defined", THEME_LABELS.length === 8, THEME_LABELS.length);
  assert("THEME_LABELS frozen", Object.isFrozen(THEME_LABELS));
  for (const t of THEME_LABELS) {
    assert(`VALID_THEMES contains ${t}`, VALID_THEMES.has(t));
    assert(`THEME_TIME_WEIGHT has ${t}`, THEME_TIME_WEIGHT[t] != null);
  }
  assert("CLASSIFIER_VERSION pinned", CLASSIFIER_VERSION === "sector-theme-v1", CLASSIFIER_VERSION);
}

console.log("sectorOutlookTaxonomy: canonicalizeTheme exact-match round-trip");
{
  for (const t of THEME_LABELS) {
    assert(`canonicalizeTheme(${t}) === ${t}`, canonicalizeTheme(t) === t);
  }
}

console.log("sectorOutlookTaxonomy: canonicalizeTheme casing + spacing");
{
  assert("lowercase canonical", canonicalizeTheme("capacity_capex") === "CAPACITY_CAPEX");
  assert("space-separated", canonicalizeTheme("capacity capex") === "CAPACITY_CAPEX");
  assert("hyphen-separated", canonicalizeTheme("capacity-capex") === "CAPACITY_CAPEX");
  assert("mixed case", canonicalizeTheme("Capacity_Capex") === "CAPACITY_CAPEX");
  assert("trailing spaces", canonicalizeTheme("  ORDER_WINS  ") === "ORDER_WINS");
}

console.log("sectorOutlookTaxonomy: canonicalizeTheme alias map");
{
  assert("'m&a' → M_AND_A", canonicalizeTheme("m&a") === "M_AND_A");
  assert("'m and a' → M_AND_A", canonicalizeTheme("m and a") === "M_AND_A");
  assert("'acquisition' → M_AND_A", canonicalizeTheme("acquisition") === "M_AND_A");
  assert("'merger' → M_AND_A", canonicalizeTheme("merger") === "M_AND_A");
  assert("'demerger' → M_AND_A", canonicalizeTheme("demerger") === "M_AND_A");
  assert("'jv' → M_AND_A", canonicalizeTheme("jv") === "M_AND_A");
  assert("'capex' → CAPACITY_CAPEX", canonicalizeTheme("capex") === "CAPACITY_CAPEX");
  assert("'expansion' → CAPACITY_CAPEX", canonicalizeTheme("expansion") === "CAPACITY_CAPEX");
  assert("'plant' → CAPACITY_CAPEX", canonicalizeTheme("plant") === "CAPACITY_CAPEX");
  assert("'order book' → ORDER_WINS", canonicalizeTheme("order book") === "ORDER_WINS");
  assert("'orders' → ORDER_WINS", canonicalizeTheme("orders") === "ORDER_WINS");
  assert("'contract' → ORDER_WINS", canonicalizeTheme("contract") === "ORDER_WINS");
  assert("'tariff' → REGULATORY_EVENT", canonicalizeTheme("tariff") === "REGULATORY_EVENT");
  assert("'subsidy' → REGULATORY_EVENT", canonicalizeTheme("subsidy") === "REGULATORY_EVENT");
  assert("'ban' → REGULATORY_EVENT", canonicalizeTheme("ban") === "REGULATORY_EVENT");
  assert("'margin' → MARGIN_MOVE", canonicalizeTheme("margin") === "MARGIN_MOVE");
  assert("'margin_expansion' → MARGIN_MOVE", canonicalizeTheme("margin_expansion") === "MARGIN_MOVE");
  assert("'beat' → EARNINGS_MOVE", canonicalizeTheme("beat") === "EARNINGS_MOVE");
  assert("'miss' → EARNINGS_MOVE", canonicalizeTheme("miss") === "EARNINGS_MOVE");
  assert("'results' → EARNINGS_MOVE", canonicalizeTheme("results") === "EARNINGS_MOVE");
  assert("'geopolitical' → STRATEGIC_GEOPOLITICAL", canonicalizeTheme("geopolitical") === "STRATEGIC_GEOPOLITICAL");
  assert("'trade' → STRATEGIC_GEOPOLITICAL", canonicalizeTheme("trade") === "STRATEGIC_GEOPOLITICAL");
  assert("'sanctions' → STRATEGIC_GEOPOLITICAL", canonicalizeTheme("sanctions") === "STRATEGIC_GEOPOLITICAL");
  assert("'currency' → STRATEGIC_GEOPOLITICAL", canonicalizeTheme("currency") === "STRATEGIC_GEOPOLITICAL");
}

console.log("sectorOutlookTaxonomy: canonicalizeTheme defaults to NEUTRAL");
{
  assert("null → NEUTRAL", canonicalizeTheme(null) === "NEUTRAL");
  assert("undefined → NEUTRAL", canonicalizeTheme(undefined) === "NEUTRAL");
  assert("empty string → NEUTRAL", canonicalizeTheme("") === "NEUTRAL");
  assert("whitespace → NEUTRAL", canonicalizeTheme("   ") === "NEUTRAL");
  assert("garbage → NEUTRAL", canonicalizeTheme("xyzqwerty") === "NEUTRAL");
  assert("number → NEUTRAL", canonicalizeTheme(42) === "NEUTRAL");
  assert("'unknown' → NEUTRAL", canonicalizeTheme("unknown") === "NEUTRAL");
  assert("'n/a' → NEUTRAL", canonicalizeTheme("n/a") === "NEUTRAL");
  assert("'none' → NEUTRAL", canonicalizeTheme("none") === "NEUTRAL");
}

console.log("sectorOutlookTaxonomy: THEME_TIME_WEIGHT shape");
{
  for (const t of THEME_LABELS) {
    const w = THEME_TIME_WEIGHT[t];
    assert(`${t}.short is number`, typeof w.short === "number");
    assert(`${t}.medium is number`, typeof w.medium === "number");
    assert(`${t}.long is number`, typeof w.long === "number");
    assert(`${t}.short in [0,1]`, w.short >= 0 && w.short <= 1, w.short);
    assert(`${t}.medium in [0,1]`, w.medium >= 0 && w.medium <= 1, w.medium);
    assert(`${t}.long in [0,1]`, w.long >= 0 && w.long <= 1, w.long);
  }
  // NEUTRAL has zero weight everywhere — drops out of all aggregations
  assert("NEUTRAL.short = 0", THEME_TIME_WEIGHT.NEUTRAL.short === 0);
  assert("NEUTRAL.medium = 0", THEME_TIME_WEIGHT.NEUTRAL.medium === 0);
  assert("NEUTRAL.long = 0", THEME_TIME_WEIGHT.NEUTRAL.long === 0);
  // Structural themes weight long > short
  assert(
    "CAPACITY_CAPEX.long > CAPACITY_CAPEX.short",
    THEME_TIME_WEIGHT.CAPACITY_CAPEX.long > THEME_TIME_WEIGHT.CAPACITY_CAPEX.short,
  );
  assert(
    "STRATEGIC_GEOPOLITICAL.long > STRATEGIC_GEOPOLITICAL.short",
    THEME_TIME_WEIGHT.STRATEGIC_GEOPOLITICAL.long > THEME_TIME_WEIGHT.STRATEGIC_GEOPOLITICAL.short,
  );
  // Short-cycle themes weight short > long
  assert(
    "EARNINGS_MOVE.short > EARNINGS_MOVE.long",
    THEME_TIME_WEIGHT.EARNINGS_MOVE.short > THEME_TIME_WEIGHT.EARNINGS_MOVE.long,
  );
  assert(
    "MARGIN_MOVE.short > MARGIN_MOVE.long",
    THEME_TIME_WEIGHT.MARGIN_MOVE.short > THEME_TIME_WEIGHT.MARGIN_MOVE.long,
  );
}

console.log("sectorOutlookTaxonomy: thresholds + valid sets");
{
  assert("MIN_CONFIDENCE = 0.55", MIN_CONFIDENCE === 0.55);
  assert("MIN_TOP2_GAP = 0.15", MIN_TOP2_GAP === 0.15);
  assert("VALID_SIGNS = [-1,0,1]", JSON.stringify(VALID_SIGNS) === "[-1,0,1]");
  assert("VALID_INTENSITIES = [1,2,3]", JSON.stringify(VALID_INTENSITIES) === "[1,2,3]");
}

if (_failed > 0) {
  console.log(`\nsectorOutlookTaxonomy: ${_failed} failures`);
  process.exit(1);
}
console.log("\nsectorOutlookTaxonomy: all tests passed");
