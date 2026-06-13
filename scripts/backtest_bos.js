#!/usr/bin/env node
// Backtest del modelo BOS (Break of Structure) sobre datos REALES de Binance.
// Misma lógica que pine/bos_ny_multi.pine para validar si sirve en ETH antes de
// operarlo. Por defecto SIN filtro de sesión (ETH es 24/7).
//
// Uso:
//   node scripts/backtest_bos.js                  # ETH 5m, 30 días, 24/7
//   SYMBOL=ETHUSDT TF=5m DAYS=30 RR=1 node scripts/backtest_bos.js
//   SYMBOL=ETHUSDT RR=1.5 ATR_MULT=1.5 node scripts/backtest_bos.js
//   SESSION=ny node scripts/backtest_bos.js       # con filtro sesión NY
//
// Parámetros (env): SYMBOL, TF, DAYS, PIVOT(5), EMA(200), ATR(14),
//   ATR_MULT(1.5), RR(1.0), RISK_PCT(1), CAPITAL(10000), SESSION(off|ny)

const SYMBOL   = process.env.SYMBOL   || 'ETHUSDT';
const TF       = process.env.TF       || '5m';
const DAYS     = +(process.env.DAYS   || 30);
const PIVOT    = +(process.env.PIVOT  || 5);
const EMA_LEN  = +(process.env.EMA    || 200);
const ATR_LEN  = +(process.env.ATR    || 14);
const ATR_MULT = +(process.env.ATR_MULT || 1.5);
const RR       = +(process.env.RR     || 1.0);
const RISK_PCT = +(process.env.RISK_PCT || 1);
const CAPITAL  = +(process.env.CAPITAL || 10000);
const SESSION  = (process.env.SESSION || 'off').toLowerCase(); // 'off' | 'ny'
const COST_PCT = +(process.env.COST_PCT || 0); // costo ida+vuelta como % del notional (spread+comisión)

const TF_MIN = { '1m':1,'3m':3,'5m':5,'15m':15,'30m':30,'1h':60,'4h':240 }[TF] || 5;
const HOSTS = ['api.binance.com','api-gcp.binance.com','data-api.binance.vision'];

async function klines(startTime, endTime) {
  const path = `/api/v3/klines?symbol=${SYMBOL}&interval=${TF}&limit=1000&startTime=${startTime}&endTime=${endTime}`;
  for (const host of HOSTS) {
    try {
      const r = await fetch(`https://${host}${path}`);
      if (!r.ok) continue;
      const rows = await r.json();
      if (Array.isArray(rows) && rows.length) return rows;
    } catch { /* siguiente host */ }
  }
  return [];
}

// Trae DAYS días paginando de 1000 en 1000 hacia atrás
async function fetchHistory() {
  const now = Date.now();
  const from = now - DAYS * 24 * 3600 * 1000;
  const stepMs = 1000 * TF_MIN * 60 * 1000; // 1000 velas por request
  let cursor = from;
  const all = [];
  while (cursor < now) {
    const rows = await klines(cursor, Math.min(cursor + stepMs, now));
    if (!rows.length) { cursor += stepMs; continue; }
    for (const k of rows) all.push({ time: Math.floor(k[0]/1000), open:+k[1], high:+k[2], low:+k[3], close:+k[4], volume:+k[5] });
    cursor = rows[rows.length-1][0] + 1;
  }
  // dedup por time
  const seen = new Set(); const out = [];
  for (const b of all) { if (!seen.has(b.time)) { seen.add(b.time); out.push(b); } }
  out.sort((a,b)=>a.time-b.time);
  return out;
}

function emaSeries(values, period) {
  const k = 2/(period+1); const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  let prev = values.slice(0,period).reduce((a,b)=>a+b,0)/period;
  out[period-1] = prev;
  for (let i=period;i<values.length;i++){ prev = values[i]*k + prev*(1-k); out[i]=prev; }
  return out;
}

function atrSeries(bars, period) {
  const tr = bars.map((b,i)=> i===0 ? b.high-b.low : Math.max(b.high-b.low, Math.abs(b.high-bars[i-1].close), Math.abs(b.low-bars[i-1].close)));
  const out = new Array(bars.length).fill(null);
  if (bars.length <= period) return out;
  let prev = tr.slice(1,period+1).reduce((a,b)=>a+b,0)/period;
  out[period] = prev;
  for (let i=period+1;i<bars.length;i++){ prev = (prev*(period-1)+tr[i])/period; out[i]=prev; }
  return out;
}

function nyHour(unix) {
  const parts = new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'numeric',minute:'numeric',hour12:false}).formatToParts(new Date(unix*1000));
  const H=+parts.find(p=>p.type==='hour').value, M=+parts.find(p=>p.type==='minute').value;
  return H + M/60;
}
function nyDay(unix) {
  return new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York'}).format(new Date(unix*1000));
}

(async () => {
  const bars = await fetchHistory();
  if (bars.length < EMA_LEN + 50) { console.log('Pocas velas:', bars.length); return; }
  const closes = bars.map(b=>b.close);
  const ema = emaSeries(closes, EMA_LEN);
  const atr = atrSeries(bars, ATR_LEN);

  let swingHigh=null, swingLow=null;
  let pos=null; // {dir, entry, sl, tp, qty, entryTime}
  let equity=CAPITAL; let tradesToday=0; let curDay='';
  const trades=[];
  const MAX_DAY = 2;

  for (let i=PIVOT; i<bars.length; i++){
    // confirmar pivote formado en c = i-PIVOT
    const c = i-PIVOT;
    if (c>=PIVOT) {
      let isH=true,isL=true;
      for(let j=1;j<=PIVOT;j++){ if(bars[c].high<=bars[c-j].high||bars[c].high<=bars[c+j].high)isH=false; if(bars[c].low>=bars[c-j].low||bars[c].low>=bars[c+j].low)isL=false; }
      if(isH) swingHigh=bars[c].high;
      if(isL) swingLow=bars[c].low;
    }
    if (i<EMA_LEN || ema[i]==null || atr[i]==null) continue;

    const day = nyDay(bars[i].time);
    if (day!==curDay){ curDay=day; tradesToday=0; }
    const h = nyHour(bars[i].time);
    const inSession = SESSION==='ny' ? (h>=9.75 && h<16) : true;

    // gestión de posición abierta: SL/TP intrabar
    if (pos){
      let exitPx=null, reason=null;
      if (pos.dir===1){ if (bars[i].low<=pos.sl){exitPx=pos.sl;reason='SL';} else if (bars[i].high>=pos.tp){exitPx=pos.tp;reason='TP';} }
      else            { if (bars[i].high>=pos.sl){exitPx=pos.sl;reason='SL';} else if (bars[i].low<=pos.tp){exitPx=pos.tp;reason='TP';} }
      // cierre fin de sesión NY (solo modo ny)
      if (!exitPx && SESSION==='ny' && h>=16){ exitPx=bars[i].close; reason='EOD'; }
      if (exitPx){
        const gross = pos.dir===1 ? (exitPx-pos.entry)*pos.qty : (pos.entry-exitPx)*pos.qty;
        // costo ida+vuelta: COST_PCT% sobre el notional de entrada y de salida
        const cost = COST_PCT>0 ? (pos.entry*pos.qty + exitPx*pos.qty) * COST_PCT/100 : 0;
        const pl = gross - cost;
        equity += pl;
        trades.push({dir:pos.dir, entry:pos.entry, exit:exitPx, pl, reason, t:new Date(pos.entryTime*1000).toISOString().slice(0,16)});
        pos=null;
      }
    }

    // nuevas entradas (solo si plano y dentro de límites)
    if (!pos && inSession && tradesToday<MAX_DAY){
      const bosUp = swingHigh!=null && bars[i].close>swingHigh && bars[i-1].close<=swingHigh && bars[i].close>ema[i];
      const bosDn = swingLow!=null  && bars[i].close<swingLow  && bars[i-1].close>=swingLow  && bars[i].close<ema[i];
      const slDist = atr[i]*ATR_MULT;
      if (bosUp && slDist>0){
        const qty = (equity*RISK_PCT/100)/slDist;
        pos={dir:1, entry:bars[i].close, sl:bars[i].close-slDist, tp:bars[i].close+slDist*RR, qty, entryTime:bars[i].time};
        tradesToday++; swingHigh=null;
      } else if (bosDn && slDist>0){
        const qty = (equity*RISK_PCT/100)/slDist;
        pos={dir:-1, entry:bars[i].close, sl:bars[i].close+slDist, tp:bars[i].close-slDist*RR, qty, entryTime:bars[i].time};
        tradesToday++; swingLow=null;
      }
    }
  }

  // estadísticas
  const n=trades.length;
  const wins=trades.filter(t=>t.pl>0), losses=trades.filter(t=>t.pl<=0);
  const grossW=wins.reduce((a,t)=>a+t.pl,0), grossL=Math.abs(losses.reduce((a,t)=>a+t.pl,0));
  const pf = grossL>0 ? grossW/grossL : (grossW>0?Infinity:0);
  const net = equity-CAPITAL;
  const longs=trades.filter(t=>t.dir===1).length, shorts=n-longs;

  console.log(`\n=== BACKTEST BOS · ${SYMBOL} ${TF} · ${DAYS}d · sesión:${SESSION.toUpperCase()} · RR ${RR} · SL ${ATR_MULT}xATR ===`);
  console.log(`velas: ${bars.length}  (${new Date(bars[0].time*1000).toISOString().slice(0,10)} → ${new Date(bars[bars.length-1].time*1000).toISOString().slice(0,10)})`);
  console.log(`trades: ${n}  (long ${longs} / short ${shorts})`);
  console.log(`win rate: ${n? (100*wins.length/n).toFixed(1):0}%   (${wins.length}W / ${losses.length}L)`);
  console.log(`profit factor: ${pf===Infinity?'∞':pf.toFixed(2)}`);
  console.log(`resultado neto: ${net>=0?'+':''}${net.toFixed(2)} USD  (${(100*net/CAPITAL).toFixed(1)}% sobre ${CAPITAL})`);
  console.log(`capital final: ${equity.toFixed(2)} USD`);
  if (n) {
    const avgW = wins.length? grossW/wins.length:0, avgL = losses.length? grossL/losses.length:0;
    console.log(`avg ganadora: +${avgW.toFixed(2)}  ·  avg perdedora: -${avgL.toFixed(2)}  ·  expectativa/trade: ${(net/n).toFixed(2)}`);
    console.log(`últimos trades:`); trades.slice(-5).forEach(t=>console.log(`  ${t.dir===1?'LONG ':'SHORT'} ${t.t}  →${t.reason}  ${t.pl>=0?'+':''}${t.pl.toFixed(2)}`));
  }
})();
