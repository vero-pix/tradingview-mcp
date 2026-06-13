#!/usr/bin/env node
// Checker one-shot del modelo BOS 1h en ETH (la config que SÍ sobrevive el
// spread: 1h, SL=ATR×5, TP=RR2, filtro EMA200). Mira SOLO la última vela
// CERRADA y reporta si gatilló una entrada.
//
// Salida (stdout, una línea):
//   none|<barTime>                         -> sin señal en la última vela cerrada
//   LONG|<barTime>|<entry>|<sl>|<tp>|<rsi> -> entrada larga
//   SHORT|<barTime>|<entry>|<sl>|<tp>|<rsi>
//   err|<motivo>                           -> sin datos / fallo de red
//
// Config por env: ATR_MULT(5), RR(2), EMA(200), ATR(14), PIVOT(5)

const ATR_MULT = +(process.env.ATR_MULT || 5);
const RR       = +(process.env.RR     || 2);
const EMA_LEN  = +(process.env.EMA    || 200);
const ATR_LEN  = +(process.env.ATR    || 14);
const PIVOT    = +(process.env.PIVOT  || 5);
const SYMBOL   = process.env.SYMBOL   || 'ETHUSDT';
const HOSTS = ['api.binance.com','api-gcp.binance.com','data-api.binance.vision'];

async function fetchBars() {
  const path = `/api/v3/klines?symbol=${SYMBOL}&interval=1h&limit=500`;
  for (const host of HOSTS) {
    try {
      const r = await fetch(`https://${host}${path}`);
      if (!r.ok) continue;
      const rows = await r.json();
      if (Array.isArray(rows) && rows.length > EMA_LEN + 30)
        return rows.map(k => ({ time: Math.floor(k[0]/1000), high:+k[2], low:+k[3], close:+k[4] }));
    } catch { /* siguiente host */ }
  }
  return null;
}

function emaSeries(v, p) {
  const k = 2/(p+1); const out = new Array(v.length).fill(null);
  if (v.length < p) return out;
  let prev = v.slice(0,p).reduce((a,b)=>a+b,0)/p; out[p-1]=prev;
  for (let i=p;i<v.length;i++){ prev=v[i]*k+prev*(1-k); out[i]=prev; } return out;
}
function atrSeries(b, p) {
  const tr=b.map((x,i)=>i===0?x.high-x.low:Math.max(x.high-x.low,Math.abs(x.high-b[i-1].close),Math.abs(x.low-b[i-1].close)));
  const out=new Array(b.length).fill(null); if(b.length<=p) return out;
  let prev=tr.slice(1,p+1).reduce((a,c)=>a+c,0)/p; out[p]=prev;
  for(let i=p+1;i<b.length;i++){ prev=(prev*(p-1)+tr[i])/p; out[i]=prev; } return out;
}
function rsiWilder(c, p=14){
  if(c.length<p+1) return 50;
  let g=0,l=0; for(let i=1;i<=p;i++){const d=c[i]-c[i-1]; if(d>=0)g+=d; else l-=d;}
  let aG=g/p,aL=l/p;
  for(let i=p+1;i<c.length;i++){const d=c[i]-c[i-1]; aG=(aG*(p-1)+(d>0?d:0))/p; aL=(aL*(p-1)+(d<0?-d:0))/p;}
  if(aL===0) return 100; return 100-100/(1+aG/aL);
}

(async () => {
  const bars = await fetchBars();
  if (!bars) { console.log('err|sin datos'); return; }
  const closes = bars.map(b=>b.close);
  const ema = emaSeries(closes, EMA_LEN);
  const atr = atrSeries(bars, ATR_LEN);

  // recorrer manteniendo swings; la última vela CERRADA es length-2 (la -1 está en formación)
  const last = bars.length - 2;
  let swingHigh=null, swingLow=null;
  for (let i=PIVOT; i<=last; i++){
    const c = i-PIVOT;
    if (c>=PIVOT){
      let H=true,L=true;
      for(let j=1;j<=PIVOT;j++){ if(bars[c].high<=bars[c-j].high||bars[c].high<=bars[c+j].high)H=false; if(bars[c].low>=bars[c-j].low||bars[c].low>=bars[c+j].low)L=false; }
      if(H) swingHigh=bars[c].high;
      if(L) swingLow=bars[c].low;
    }
  }
  const i = last;
  const t = bars[i].time;
  if (i<EMA_LEN || ema[i]==null || atr[i]==null) { console.log('none|'+t); return; }

  const bosUp = swingHigh!=null && bars[i].close>swingHigh && bars[i-1].close<=swingHigh && bars[i].close>ema[i];
  const bosDn = swingLow!=null  && bars[i].close<swingLow  && bars[i-1].close>=swingLow  && bars[i].close<ema[i];
  const slDist = atr[i]*ATR_MULT;
  const rsi = rsiWilder(closes.slice(0,i+1), 14).toFixed(0);
  const f = x => x.toFixed(2);

  if (bosUp && slDist>0)
    console.log(`LONG|${t}|${f(bars[i].close)}|${f(bars[i].close-slDist)}|${f(bars[i].close+slDist*RR)}|${rsi}`);
  else if (bosDn && slDist>0)
    console.log(`SHORT|${t}|${f(bars[i].close)}|${f(bars[i].close+slDist)}|${f(bars[i].close-slDist*RR)}|${rsi}`);
  else
    console.log('none|'+t);
})();
