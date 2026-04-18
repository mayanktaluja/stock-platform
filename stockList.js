// Flat stock universe with index tagging.
//
// Each entry: { symbol, name, sector, indices: string[] }
// Index tags: "NIFTY50", "NIFTY_NEXT_50", "NIFTY100" (derived), "MIDCAP"
//
// This replaces the old NIFTY_50 + POPULAR_MIDCAPS split. Scans filter via
// getStocksByIndex("NIFTY50") or getAllStocks().

const ALL_STOCKS = [
  // ========== NIFTY 50 ==========
  { symbol: "RELIANCE.NS", name: "Reliance Industries", sector: "Energy", indices: ["NIFTY50"] },
  { symbol: "TCS.NS", name: "Tata Consultancy Services", sector: "IT", indices: ["NIFTY50"] },
  { symbol: "HDFCBANK.NS", name: "HDFC Bank", sector: "Banking", indices: ["NIFTY50"] },
  { symbol: "INFY.NS", name: "Infosys", sector: "IT", indices: ["NIFTY50"] },
  { symbol: "ICICIBANK.NS", name: "ICICI Bank", sector: "Banking", indices: ["NIFTY50"] },
  { symbol: "HINDUNILVR.NS", name: "Hindustan Unilever", sector: "FMCG", indices: ["NIFTY50"] },
  { symbol: "ITC.NS", name: "ITC", sector: "FMCG", indices: ["NIFTY50"] },
  { symbol: "SBIN.NS", name: "State Bank of India", sector: "Banking", indices: ["NIFTY50"] },
  { symbol: "BHARTIARTL.NS", name: "Bharti Airtel", sector: "Telecom", indices: ["NIFTY50"] },
  { symbol: "KOTAKBANK.NS", name: "Kotak Mahindra Bank", sector: "Banking", indices: ["NIFTY50"] },
  { symbol: "LT.NS", name: "Larsen & Toubro", sector: "Infrastructure", indices: ["NIFTY50"] },
  { symbol: "AXISBANK.NS", name: "Axis Bank", sector: "Banking", indices: ["NIFTY50"] },
  { symbol: "WIPRO.NS", name: "Wipro", sector: "IT", indices: ["NIFTY50"] },
  { symbol: "ASIANPAINT.NS", name: "Asian Paints", sector: "Consumer", indices: ["NIFTY50"] },
  { symbol: "MARUTI.NS", name: "Maruti Suzuki", sector: "Auto", indices: ["NIFTY50"] },
  { symbol: "HCLTECH.NS", name: "HCL Technologies", sector: "IT", indices: ["NIFTY50"] },
  { symbol: "TITAN.NS", name: "Titan Company", sector: "Consumer", indices: ["NIFTY50"] },
  { symbol: "SUNPHARMA.NS", name: "Sun Pharma", sector: "Pharma", indices: ["NIFTY50"] },
  { symbol: "BAJFINANCE.NS", name: "Bajaj Finance", sector: "Finance", indices: ["NIFTY50"] },
  { symbol: "ULTRACEMCO.NS", name: "UltraTech Cement", sector: "Cement", indices: ["NIFTY50"] },
  { symbol: "NESTLEIND.NS", name: "Nestle India", sector: "FMCG", indices: ["NIFTY50"] },
  { symbol: "TATAMOTORS.NS", name: "Tata Motors", sector: "Auto", indices: ["NIFTY50"] },
  { symbol: "NTPC.NS", name: "NTPC", sector: "Power", indices: ["NIFTY50"] },
  { symbol: "POWERGRID.NS", name: "Power Grid Corp", sector: "Power", indices: ["NIFTY50"] },
  { symbol: "M&M.NS", name: "Mahindra & Mahindra", sector: "Auto", indices: ["NIFTY50"] },
  { symbol: "TATASTEEL.NS", name: "Tata Steel", sector: "Metals", indices: ["NIFTY50"] },
  { symbol: "ONGC.NS", name: "ONGC", sector: "Energy", indices: ["NIFTY50"] },
  { symbol: "JSWSTEEL.NS", name: "JSW Steel", sector: "Metals", indices: ["NIFTY50"] },
  { symbol: "ADANIENT.NS", name: "Adani Enterprises", sector: "Diversified", indices: ["NIFTY50"] },
  { symbol: "ADANIPORTS.NS", name: "Adani Ports", sector: "Infrastructure", indices: ["NIFTY50"] },
  { symbol: "COALINDIA.NS", name: "Coal India", sector: "Mining", indices: ["NIFTY50"] },
  { symbol: "BPCL.NS", name: "BPCL", sector: "Energy", indices: ["NIFTY50"] },
  { symbol: "GRASIM.NS", name: "Grasim Industries", sector: "Diversified", indices: ["NIFTY50"] },
  { symbol: "TECHM.NS", name: "Tech Mahindra", sector: "IT", indices: ["NIFTY50"] },
  { symbol: "INDUSINDBK.NS", name: "IndusInd Bank", sector: "Banking", indices: ["NIFTY50"] },
  { symbol: "HINDALCO.NS", name: "Hindalco", sector: "Metals", indices: ["NIFTY50"] },
  { symbol: "DRREDDY.NS", name: "Dr Reddy's Labs", sector: "Pharma", indices: ["NIFTY50"] },
  { symbol: "CIPLA.NS", name: "Cipla", sector: "Pharma", indices: ["NIFTY50"] },
  { symbol: "DIVISLAB.NS", name: "Divi's Laboratories", sector: "Pharma", indices: ["NIFTY50"] },
  { symbol: "EICHERMOT.NS", name: "Eicher Motors", sector: "Auto", indices: ["NIFTY50"] },
  { symbol: "BAJAJFINSV.NS", name: "Bajaj Finserv", sector: "Finance", indices: ["NIFTY50"] },
  { symbol: "BRITANNIA.NS", name: "Britannia Industries", sector: "FMCG", indices: ["NIFTY50"] },
  { symbol: "HEROMOTOCO.NS", name: "Hero MotoCorp", sector: "Auto", indices: ["NIFTY50"] },
  { symbol: "APOLLOHOSP.NS", name: "Apollo Hospitals", sector: "Healthcare", indices: ["NIFTY50"] },
  { symbol: "SBILIFE.NS", name: "SBI Life Insurance", sector: "Insurance", indices: ["NIFTY50"] },
  { symbol: "HDFCLIFE.NS", name: "HDFC Life Insurance", sector: "Insurance", indices: ["NIFTY50"] },
  { symbol: "TATACONSUM.NS", name: "Tata Consumer Products", sector: "FMCG", indices: ["NIFTY50"] },
  { symbol: "BAJAJ-AUTO.NS", name: "Bajaj Auto", sector: "Auto", indices: ["NIFTY50"] },
  { symbol: "UPL.NS", name: "UPL", sector: "Chemicals", indices: ["NIFTY50"] },
  { symbol: "SHRIRAMFIN.NS", name: "Shriram Finance", sector: "Finance", indices: ["NIFTY50"] },

  // ========== NIFTY NEXT 50 ==========
  { symbol: "LICI.NS", name: "Life Insurance Corp", sector: "Insurance", indices: ["NIFTY_NEXT_50"] },
  { symbol: "DMART.NS", name: "Avenue Supermarts (DMart)", sector: "Retail", indices: ["NIFTY_NEXT_50"] },
  { symbol: "PIDILITIND.NS", name: "Pidilite Industries", sector: "Chemicals", indices: ["NIFTY_NEXT_50"] },
  { symbol: "SIEMENS.NS", name: "Siemens India", sector: "Capital Goods", indices: ["NIFTY_NEXT_50"] },
  { symbol: "ABB.NS", name: "ABB India", sector: "Capital Goods", indices: ["NIFTY_NEXT_50"] },
  { symbol: "BOSCHLTD.NS", name: "Bosch Ltd", sector: "Auto Components", indices: ["NIFTY_NEXT_50"] },
  { symbol: "HAVELLS.NS", name: "Havells India", sector: "Consumer Durables", indices: ["NIFTY_NEXT_50"] },
  { symbol: "GODREJCP.NS", name: "Godrej Consumer Products", sector: "FMCG", indices: ["NIFTY_NEXT_50"] },
  { symbol: "DABUR.NS", name: "Dabur India", sector: "FMCG", indices: ["NIFTY_NEXT_50"] },
  { symbol: "MARICO.NS", name: "Marico", sector: "FMCG", indices: ["NIFTY_NEXT_50"] },
  { symbol: "ICICIGI.NS", name: "ICICI Lombard General Insurance", sector: "Insurance", indices: ["NIFTY_NEXT_50"] },
  { symbol: "ICICIPRULI.NS", name: "ICICI Prudential Life", sector: "Insurance", indices: ["NIFTY_NEXT_50"] },
  { symbol: "LODHA.NS", name: "Macrotech Developers (Lodha)", sector: "Real Estate", indices: ["NIFTY_NEXT_50"] },
  { symbol: "CHOLAFIN.NS", name: "Cholamandalam Investment", sector: "Finance", indices: ["NIFTY_NEXT_50"] },
  { symbol: "JINDALSTEL.NS", name: "Jindal Steel & Power", sector: "Metals", indices: ["NIFTY_NEXT_50"] },
  { symbol: "VEDL.NS", name: "Vedanta", sector: "Mining", indices: ["NIFTY_NEXT_50"] },
  { symbol: "LTIM.NS", name: "LTIMindtree", sector: "IT", indices: ["NIFTY_NEXT_50"] },
  { symbol: "MPHASIS.NS", name: "Mphasis", sector: "IT", indices: ["NIFTY_NEXT_50"] },
  { symbol: "OFSS.NS", name: "Oracle Financial Services", sector: "IT", indices: ["NIFTY_NEXT_50"] },
  { symbol: "TATAPOWER.NS", name: "Tata Power", sector: "Power", indices: ["NIFTY_NEXT_50"] },
  { symbol: "TORNTPHARM.NS", name: "Torrent Pharma", sector: "Pharma", indices: ["NIFTY_NEXT_50"] },
  { symbol: "ZYDUSLIFE.NS", name: "Zydus Lifesciences", sector: "Pharma", indices: ["NIFTY_NEXT_50"] },
  { symbol: "LUPIN.NS", name: "Lupin", sector: "Pharma", indices: ["NIFTY_NEXT_50"] },
  { symbol: "APOLLOTYRE.NS", name: "Apollo Tyres", sector: "Auto Components", indices: ["NIFTY_NEXT_50"] },
  { symbol: "TVSMOTOR.NS", name: "TVS Motor", sector: "Auto", indices: ["NIFTY_NEXT_50"] },
  { symbol: "BAJAJHLDNG.NS", name: "Bajaj Holdings", sector: "Finance", indices: ["NIFTY_NEXT_50"] },
  { symbol: "IOC.NS", name: "Indian Oil Corp", sector: "Energy", indices: ["NIFTY_NEXT_50"] },
  { symbol: "HINDPETRO.NS", name: "Hindustan Petroleum", sector: "Energy", indices: ["NIFTY_NEXT_50"] },
  { symbol: "GAIL.NS", name: "GAIL India", sector: "Energy", indices: ["NIFTY_NEXT_50"] },
  { symbol: "HAL.NS", name: "Hindustan Aeronautics", sector: "Defence", indices: ["NIFTY_NEXT_50"] },
  { symbol: "BEL.NS", name: "Bharat Electronics", sector: "Defence", indices: ["NIFTY_NEXT_50"] },
  { symbol: "IRCTC.NS", name: "IRCTC", sector: "Tourism", indices: ["NIFTY_NEXT_50"] },
  { symbol: "TRENT.NS", name: "Trent", sector: "Retail", indices: ["NIFTY_NEXT_50"] },
  { symbol: "INDIGO.NS", name: "InterGlobe Aviation (IndiGo)", sector: "Airlines", indices: ["NIFTY_NEXT_50"] },
  { symbol: "ADANIGREEN.NS", name: "Adani Green Energy", sector: "Renewable Energy", indices: ["NIFTY_NEXT_50"] },
  { symbol: "ADANIPOWER.NS", name: "Adani Power", sector: "Power", indices: ["NIFTY_NEXT_50"] },
  { symbol: "AMBUJACEM.NS", name: "Ambuja Cements", sector: "Cement", indices: ["NIFTY_NEXT_50"] },
  { symbol: "ACC.NS", name: "ACC", sector: "Cement", indices: ["NIFTY_NEXT_50"] },
  { symbol: "BANKBARODA.NS", name: "Bank of Baroda", sector: "Banking", indices: ["NIFTY_NEXT_50"] },
  { symbol: "PNB.NS", name: "Punjab National Bank", sector: "Banking", indices: ["NIFTY_NEXT_50"] },
  { symbol: "CANBK.NS", name: "Canara Bank", sector: "Banking", indices: ["NIFTY_NEXT_50"] },
  { symbol: "UNIONBANK.NS", name: "Union Bank of India", sector: "Banking", indices: ["NIFTY_NEXT_50"] },
  { symbol: "INDHOTEL.NS", name: "Indian Hotels (Taj)", sector: "Hospitality", indices: ["NIFTY_NEXT_50"] },
  { symbol: "DLF.NS", name: "DLF", sector: "Real Estate", indices: ["NIFTY_NEXT_50"] },
  { symbol: "NAUKRI.NS", name: "Info Edge (Naukri)", sector: "Internet", indices: ["NIFTY_NEXT_50"] },
  { symbol: "PFC.NS", name: "Power Finance Corp", sector: "Finance", indices: ["NIFTY_NEXT_50"] },
  { symbol: "RECLTD.NS", name: "REC Limited", sector: "Finance", indices: ["NIFTY_NEXT_50"] },
  { symbol: "IRFC.NS", name: "IRFC", sector: "Finance", indices: ["NIFTY_NEXT_50"] },
  { symbol: "CGPOWER.NS", name: "CG Power & Industrial", sector: "Capital Goods", indices: ["NIFTY_NEXT_50"] },
  { symbol: "JSWENERGY.NS", name: "JSW Energy", sector: "Power", indices: ["NIFTY_NEXT_50"] },

  // ========== POPULAR MIDCAPS / MICROCAPS ==========
  { symbol: "ZOMATO.NS", name: "Zomato", sector: "Internet", indices: ["MIDCAP"] },
  { symbol: "PAYTM.NS", name: "Paytm (One97)", sector: "Fintech", indices: ["MIDCAP"] },
  { symbol: "NYKAA.NS", name: "Nykaa (FSN E-Comm)", sector: "E-Commerce", indices: ["MIDCAP"] },
  { symbol: "POLYCAB.NS", name: "Polycab India", sector: "Electricals", indices: ["MIDCAP"] },
  { symbol: "PIIND.NS", name: "PI Industries", sector: "Chemicals", indices: ["MIDCAP"] },
  { symbol: "MUTHOOTFIN.NS", name: "Muthoot Finance", sector: "Finance", indices: ["MIDCAP"] },
  { symbol: "JUBLFOOD.NS", name: "Jubilant FoodWorks", sector: "QSR", indices: ["MIDCAP"] },
  { symbol: "DIXON.NS", name: "Dixon Technologies", sector: "Electronics", indices: ["MIDCAP"] },
  { symbol: "PERSISTENT.NS", name: "Persistent Systems", sector: "IT", indices: ["MIDCAP"] },
  { symbol: "COFORGE.NS", name: "Coforge", sector: "IT", indices: ["MIDCAP"] },
  { symbol: "TATAELXSI.NS", name: "Tata Elxsi", sector: "IT", indices: ["MIDCAP"] },
  { symbol: "FEDERALBNK.NS", name: "Federal Bank", sector: "Banking", indices: ["MIDCAP"] },
  { symbol: "IDFCFIRSTB.NS", name: "IDFC First Bank", sector: "Banking", indices: ["MIDCAP"] },
  { symbol: "SAIL.NS", name: "SAIL", sector: "Metals", indices: ["MIDCAP"] },
  { symbol: "NHPC.NS", name: "NHPC", sector: "Power", indices: ["MIDCAP"] },
  { symbol: "JIOFIN.NS", name: "Jio Financial Services", sector: "Finance", indices: ["MIDCAP"] },
];

// Deduplicate defensively (in case of accidental duplicates)
const uniqueMap = new Map();
for (const s of ALL_STOCKS) {
  if (!uniqueMap.has(s.symbol)) uniqueMap.set(s.symbol, s);
}
const DEDUPED = Array.from(uniqueMap.values());

// Build index-specific slices
function getStocksByIndex(indexTag) {
  return DEDUPED.filter((s) => s.indices.includes(indexTag));
}

function getAllStocks() {
  return DEDUPED;
}

// Nifty 100 = Nifty 50 + Nifty Next 50
function getNifty100() {
  return DEDUPED.filter((s) => s.indices.includes("NIFTY50") || s.indices.includes("NIFTY_NEXT_50"));
}

// Validate list — returns issues found. Called at server startup.
function validateStockList() {
  const issues = { duplicates: [], invalid: [] };
  const seen = new Set();
  const validPattern = /^[A-Z0-9&-]+\.(NS|BO)$/;

  for (const s of ALL_STOCKS) {
    if (seen.has(s.symbol)) issues.duplicates.push(s.symbol);
    seen.add(s.symbol);
    if (!validPattern.test(s.symbol)) {
      issues.invalid.push(s.symbol);
    }
  }
  return issues;
}

// Back-compat named exports for anything still importing old names
const NIFTY_50 = DEDUPED.filter((s) => s.indices.includes("NIFTY50"));
const NIFTY_NEXT_50 = DEDUPED.filter((s) => s.indices.includes("NIFTY_NEXT_50"));
const POPULAR_MIDCAPS = DEDUPED.filter((s) => s.indices.includes("MIDCAP"));

export {
  NIFTY_50,
  NIFTY_NEXT_50,
  POPULAR_MIDCAPS,
  DEDUPED as ALL_STOCKS,
  getStocksByIndex,
  getAllStocks,
  getNifty100,
  validateStockList,
};
