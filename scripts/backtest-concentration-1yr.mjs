#!/usr/bin/env node
/**
 * Concentration Analysis — 5 Years, All Pick Counts
 * Runs Top 1, 2, 3, 5, 10 for all 5 categories over 60 months (Apr 2025 – Mar 2026)
 */
import YahooFinance from "yahoo-finance2";
import { analyzeStock, midTermAnalysis } from "../analysis.js";
import { scoreFundamentals, loadFundamentalsFromDisk, getFundamentals } from "../fundamentals.js";
import { getNifty100 } from "../stockList.js";

const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });
const STARTING = 200000;
const CONCURRENCY = 6;
const HIST_START = "2024-04-01";
const HIST_END = "2026-04-16";

function toDateStr(d) { return typeof d === "string" ? d.slice(0,10) : d.toISOString().slice(0,10); }
function addTD(ds, n) { let d=new Date(ds),c=0; while(c<n){d.setDate(d.getDate()+1);if(d.getDay()!==0&&d.getDay()!==6)c++;} return toDateStr(d); }
function addMo(ds, m) { const d=new Date(ds); d.setMonth(d.getMonth()+m); return toDateStr(d); }
function sliceUp(bars,ds) { const dt=new Date(ds); return bars.filter(b=>b.date<=dt); }
function sliceAf(bars,ds) { const dt=new Date(ds); return bars.filter(b=>b.date>dt); }
function dma200(bars) { if(bars.length<200) return null; return bars.slice(-200).reduce((s,b)=>s+b.close,0)/200; }
function mkQuote(bars,sym) {
  const l=bars[bars.length-1]; return { symbol:sym, regularMarketPrice:l.close,
    regularMarketPreviousClose:bars.length>=2?bars[bars.length-2].close:l.close,
    regularMarketDayHigh:l.high,regularMarketDayLow:l.low,regularMarketVolume:l.volume,regularMarketOpen:l.open,
    fiftyTwoWeekHigh:Math.max(...bars.slice(-252).map(d=>d.high)),
    fiftyTwoWeekLow:Math.min(...bars.slice(-252).map(d=>d.low))};
}

// Trade tracking with 2-close SL + trailing
function track(fw,ep,tgt,sl,maxD) {
  const mx=new Date(maxD);mx.setHours(23,59,59);let slC=0,hc=ep;
  const ae=sl?(ep-sl)/4:0,td=ae*3;
  for(const b of fw){if(b.date>mx)break;if(b.close>hc)hc=b.close;const tl=hc-td;const esl=sl?Math.max(sl,tl):null;
    if(esl&&b.close<esl){slC++;if(slC>=2)return{ep:b.close,ed:b.date,r:"SL"};}else slC=0;
    if(td>0&&sl&&tl>sl&&b.close<tl)return{ep:b.close,ed:b.date,r:"TRAIL"};
    if(tgt&&b.high>=tgt)return{ep:tgt,ed:b.date,r:"TGT"};}
  const v=fw.filter(b=>b.date<=mx);if(v.length>0)return{ep:v[v.length-1].close,ed:v[v.length-1].date,r:"EXP"};
  return{ep,ed:mx,r:"ND"};
}
function trackIntra(fw,ep,tgt,sl,dir) {
  const nb=fw[0];if(!nb)return{ep,ed:new Date(),r:"ND"};
  if(dir==="LONG"){if(sl&&nb.low<=sl)return{ep:sl,ed:nb.date,r:"SL"};if(tgt&&nb.high>=tgt)return{ep:tgt,ed:nb.date,r:"TGT"};}
  else{if(sl&&nb.high>=sl)return{ep:sl,ed:nb.date,r:"SL"};if(tgt&&nb.low<=tgt)return{ep:tgt,ed:nb.date,r:"TGT"};}
  return{ep:nb.close,ed:nb.date,r:"EXP"};
}

// Scanners — return ALL candidates sorted, caller slices to N
function scanDV(stocks,hist,ds) {
  const c=[];for(const s of stocks){const fb=hist.get(s.symbol);if(!fb)continue;const bu=sliceUp(fb,ds);if(bu.length<50)continue;
    const q=mkQuote(bu,s.symbol);const a=analyzeStock(bu,q);if(!a||a.score==null)continue;const d2=dma200(bu);
    const sn=getFundamentals(s.symbol);if(!sn)continue;const fr=scoreFundamentals(sn,d2);if(!fr||fr.verdict!=="DEEP_VALUE")continue;
    const ep=q.regularMarketPrice;const w52h=q.fiftyTwoWeekHigh;const w52l=q.fiftyTwoWeekLow;
    let sl=Math.max(d2&&d2<ep?d2:ep*0.8,w52l&&w52l<ep?w52l:ep*0.8,ep*0.8);if(sl>=ep)sl=ep*0.8;
    const pe=sn.pe,spe=fr.breakdown?.sectorPeUsed,rg=fr.breakdown?.revenueGrowthValue;
    let tgt;if(pe&&spe&&pe>0&&spe>0&&pe<spe&&(spe/pe)>=1.1)tgt=ep*Math.min(spe/pe,1.4);
    else if(w52h&&w52h>ep){const gi=rg!=null&&rg>0?ep*(1+rg):0;tgt=Math.max(w52h,gi);}
    else if(rg!=null&&rg>0)tgt=ep*(1+rg);else tgt=ep*1.15;
    c.push({sym:s.symbol,nm:s.name,sec:s.sector,ep,sl,tgt,score:fr.score,cat:"DV",maxD:addMo(ds,3),fw:sliceAf(fb,ds)});}
  c.sort((a,b)=>b.score-a.score);return c;
}
function scanQG(stocks,hist,ds) {
  const c=[];for(const s of stocks){const fb=hist.get(s.symbol);if(!fb)continue;const bu=sliceUp(fb,ds);if(bu.length<50)continue;
    const q=mkQuote(bu,s.symbol);const a=analyzeStock(bu,q);if(!a||a.score==null)continue;const d2=dma200(bu);
    const sn=getFundamentals(s.symbol);if(!sn)continue;const fr=scoreFundamentals(sn,d2);if(!fr||fr.verdict!=="QUALITY_GROWTH")continue;
    const ep=q.regularMarketPrice;const w52h=q.fiftyTwoWeekHigh;const w52l=q.fiftyTwoWeekLow;
    let sl=Math.max(d2&&d2<ep?d2:ep*0.8,w52l&&w52l<ep?w52l:ep*0.8,ep*0.8);if(sl>=ep)sl=ep*0.8;
    const pe=sn.pe,spe=fr.breakdown?.sectorPeUsed,rg=fr.breakdown?.revenueGrowthValue;
    let tgt;if(pe&&spe&&pe>0&&spe>0&&pe<spe&&(spe/pe)>=1.1)tgt=ep*Math.min(spe/pe,1.4);
    else if(w52h&&w52h>ep){const gi=rg!=null&&rg>0?ep*(1+rg):0;tgt=Math.max(w52h,gi);}
    else if(rg!=null&&rg>0)tgt=ep*(1+rg);else tgt=ep*1.15;
    c.push({sym:s.symbol,nm:s.name,sec:s.sector,ep,sl,tgt,score:fr.score,cat:"QG",maxD:addMo(ds,3),fw:sliceAf(fb,ds)});}
  c.sort((a,b)=>b.score-a.score);return c;
}
function scanBN(stocks,hist,ds) {
  const EX=new Set(["Banking","Tourism","Cement","Chemicals"]);const c=[];
  for(const s of stocks){const fb=hist.get(s.symbol);if(!fb)continue;const bu=sliceUp(fb,ds);if(bu.length<50)continue;
    const q=mkQuote(bu,s.symbol);const a=analyzeStock(bu,q);if(!a||a.score==null)continue;const d2=dma200(bu);
    const sn=getFundamentals(s.symbol);if(!sn)continue;const fr=scoreFundamentals(sn,d2);
    if(!fr||(fr.verdict!=="DEEP_VALUE"&&fr.verdict!=="QUALITY_GROWTH"))continue;
    if(EX.has(s.sector))continue;const cb=a.score*0.5+fr.score*0.5;if(cb<65)continue;
    const ep=q.regularMarketPrice;const atr=a.indicators?.atr?parseFloat(a.indicators.atr):null;
    const sl=atr?ep-atr*4:ep*0.85;const tgt=atr?ep+atr*5:ep*1.15;
    const ss=cb+(fr.verdict==="QUALITY_GROWTH"?5:0);
    c.push({sym:s.symbol,nm:s.name,sec:s.sector,ep,sl,tgt,score:ss,cat:"BN",maxD:addMo(ds,3),fw:sliceAf(fb,ds)});}
  c.sort((a,b)=>b.score-a.score);return c;
}
function scanMT(stocks,hist,ds) {
  const c=[];for(const s of stocks){const fb=hist.get(s.symbol);if(!fb)continue;const bu=sliceUp(fb,ds);if(bu.length<50)continue;
    const q=mkQuote(bu,s.symbol);const a=analyzeStock(bu,q);if(!a||a.score==null)continue;
    const cls=bu.map(b=>b.close);const mt=midTermAnalysis(a,q,cls);if(mt.score<58)continue;
    const ep=q.regularMarketPrice;
    c.push({sym:s.symbol,nm:s.name,sec:s.sector,ep,sl:mt.stopLoss,tgt:mt.target,score:mt.score,cat:"MT",maxD:addTD(ds,20),fw:sliceAf(fb,ds)});}
  c.sort((a,b)=>b.score-a.score);return c;
}
function scanID(stocks,hist,ds) {
  const c=[];for(const s of stocks){const fb=hist.get(s.symbol);if(!fb)continue;const bu=sliceUp(fb,ds);if(bu.length<50)continue;
    const q=mkQuote(bu,s.symbol);const a=analyzeStock(bu,q);if(!a||a.score==null||a.intradayScore<50)continue;
    const ts=a.score;let dir;if(ts>=55)dir="LONG";else if(ts<=45)dir="SHORT";else continue;
    const ep=q.regularMarketPrice;const atr=a.indicators?.atr?parseFloat(a.indicators.atr):null;if(!atr)continue;
    let sl,tgt;if(dir==="LONG"){sl=ep-atr*1.5;tgt=ep+atr*2;}else{sl=ep+atr*1.5;tgt=ep-atr*2;}
    c.push({sym:s.symbol,nm:s.name,sec:s.sector,ep,sl,tgt,score:a.intradayScore,cat:"ID",dir,fw:sliceAf(fb,ds)});}
  c.sort((a,b)=>b.score-a.score);return c;
}

// Run one category with one pick count over all scan dates
function runSim(scanFn, stocks, hist, scanDates, pickCount) {
  let cap = STARTING; let wins=0,total=0;
  for(const sd of scanDates) {
    const cands = scanFn(stocks, hist, sd.date);
    const picks = cands.slice(0, pickCount);
    if(picks.length===0)continue;
    const per = cap / picks.length;
    let returned = 0;
    for(const p of picks) {
      const shares = per / p.ep;
      let exit;
      if(p.cat==="ID") exit = trackIntra(p.fw, p.ep, p.tgt, p.sl, p.dir);
      else exit = track(p.fw, p.ep, p.tgt, p.sl, p.maxD);
      returned += shares * exit.ep;
      total++;if(exit.ep > p.ep) wins++;
    }
    cap = returned;
  }
  const ret = ((cap - STARTING) / STARTING * 100);
  const wr = total > 0 ? (wins/total*100) : 0;
  return { final: cap, ret, wr, total };
}

// Scan date generator
function genDates(sy,sm,ey,em) {
  const d=[];const fd={0:3,1:2,2:2,3:4,4:3,5:2,6:1,7:1,8:1,9:1,10:3,11:1};
  const mn=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  for(let y=sy;y<=ey;y++){const s=y===sy?sm:0;const e=y===ey?em:11;
    for(let m=s;m<=e;m++)d.push({label:`${mn[m]} ${y}`,date:`${y}-${String(m+1).padStart(2,"0")}-${String(fd[m]).padStart(2,"0")}`});}
  return d;
}

// Data fetch
async function fetchAll(syms) {
  const d=new Map();let cur=0,ok=0,fl=0;
  async function w(){while(true){const i=cur++;if(i>=syms.length)return;try{
    const r=await yf.chart(syms[i],{period1:HIST_START,period2:HIST_END,interval:"1d"});
    const b=(r?.quotes||[]).filter(q=>q.close!=null).map(q=>({date:new Date(q.date),open:q.open,high:q.high,low:q.low,close:q.close,volume:q.volume}));
    if(b.length>=50){d.set(syms[i],b);ok++;}else fl++;}catch{fl++;}
    if((ok+fl)%20===0)console.log(`  ${ok+fl}/${syms.length}`);}}
  await Promise.all(Array.from({length:CONCURRENCY},()=>w()));
  console.log(`  Done: ${ok} OK, ${fl} failed\n`);return d;
}

async function main() {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║  Concentration Analysis — 1 Year × 5 Categories       ║");
  console.log("║  Top 1, 2, 3, 5, 10 picks (Apr 2025 – Mar 2026)        ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  loadFundamentalsFromDisk();
  const stocks = getNifty100();
  console.log(`Universe: ${stocks.length} stocks\nFetching 6+ years of data...`);
  const allSyms = [...stocks.map(s=>s.symbol), "^NSEI"];
  const hist = await fetchAll(allSyms);
  const niftyBars = hist.get("^NSEI"); hist.delete("^NSEI");

  const scanDates = genDates(2025,3,2026,2); // Apr 2025 – Mar 2026
  console.log(`Scan dates: ${scanDates.length} months\n`);

  // Nifty benchmark
  const nStart = niftyBars.find(b=>b.date>=new Date("2025-04-01"))?.close;
  const nEnd = niftyBars[niftyBars.length-1]?.close;
  const niftyRet = ((nEnd-nStart)/nStart*100);
  const niftyVal = STARTING * (nEnd/nStart);

  const PICKS = [1, 2, 3, 5, 10];
  const CATS = [
    { name: "Quality Growth", fn: scanQG },
    { name: "Mid-Term", fn: scanMT },
    { name: "Buy Now", fn: scanBN },
    { name: "Deep Value", fn: scanDV },
    { name: "Intraday", fn: scanID },
  ];

  console.log("Running simulations...\n");

  // Results grid
  const grid = {};
  for (const cat of CATS) {
    grid[cat.name] = {};
    for (const n of PICKS) {
      process.stdout.write(`  ${cat.name} Top ${n}...`);
      const r = runSim(cat.fn, stocks, hist, scanDates, n);
      grid[cat.name][n] = r;
      console.log(` ₹${(r.final/100000).toFixed(2)}L (${r.ret>=0?"+":""}${r.ret.toFixed(1)}%) WR=${r.wr.toFixed(0)}%`);
    }
  }

  // Print results
  console.log(`\n${"═".repeat(90)}`);
  console.log("  1-YEAR CONCENTRATION TABLE (₹2L starting capital, Apr 2025 – Mar 2026)");
  console.log("═".repeat(90));
  console.log(`\n  Nifty 50 Buy & Hold: ₹${(niftyVal/100000).toFixed(2)}L (${niftyRet>=0?"+":""}${niftyRet.toFixed(1)}%)\n`);

  // Header
  const hdr = "  " + "Category".padEnd(20) + PICKS.map(n=>`Top ${n}`.padStart(18)).join("") + "  Nifty".padStart(14);
  console.log(hdr);
  console.log("  " + "─".repeat(hdr.length - 2));

  for (const cat of CATS) {
    let line = "  " + cat.name.padEnd(20);
    for (const n of PICKS) {
      const r = grid[cat.name][n];
      const val = `₹${(r.final/100000).toFixed(2)}L`;
      const pct = `(${r.ret>=0?"+":""}${r.ret.toFixed(0)}%)`;
      line += `${val} ${pct}`.padStart(18);
    }
    line += `₹${(niftyVal/100000).toFixed(2)}L`.padStart(14);
    console.log(line);
  }

  // Win rate table
  console.log(`\n  Win Rates:`);
  console.log("  " + "Category".padEnd(20) + PICKS.map(n=>`Top ${n}`.padStart(10)).join(""));
  console.log("  " + "─".repeat(70));
  for (const cat of CATS) {
    let line = "  " + cat.name.padEnd(20);
    for (const n of PICKS) line += `${grid[cat.name][n].wr.toFixed(0)}%`.padStart(10);
    console.log(line);
  }

  // Best combination finder
  console.log(`\n  Beat Nifty? (₹${(niftyVal/100000).toFixed(2)}L = +${niftyRet.toFixed(0)}%):`);
  const winners = [];
  for (const cat of CATS) {
    for (const n of PICKS) {
      const r = grid[cat.name][n];
      if (r.final > niftyVal) winners.push({ cat: cat.name, n, final: r.final, ret: r.ret, alpha: r.ret - niftyRet });
    }
  }
  winners.sort((a,b) => b.final - a.final);
  if (winners.length === 0) console.log("  None beat Nifty over 5 years.");
  else {
    for (const w of winners) {
      console.log(`  ✅ ${w.cat} Top ${w.n}: ₹${(w.final/100000).toFixed(2)}L (+${w.ret.toFixed(0)}%) Alpha: +${w.alpha.toFixed(0)}pp`);
    }
  }

  console.log(`\n${"═".repeat(90)}\n`);
}

main().catch(e=>{console.error("FATAL:",e);process.exit(1);});
