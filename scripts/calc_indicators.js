#!/usr/bin/env node
// Lee las velas OHLCV del bridge (por stdin) y calcula RSI(14), EMA(9), EMA(21)
// localmente, sin depender de la leyenda intermitente de TradingView.
// Uso: node src/cli/index.js ohlcv | node scripts/calc_indicators.js

function ema(values, period) {
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period; // SMA inicial
  for (let i = period; i < values.length; i++) prev = values[i] * k + prev * (1 - k);
  return prev;
}

function rsiWilder(closes, period = 14) {
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  let avgG = gain / period, avgL = loss / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgG = (avgG * (period - 1) + (d > 0 ? d : 0)) / period;
    avgL = (avgL * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  if (avgL === 0) return 100;
  const rs = avgG / avgL;
  return 100 - 100 / (1 + rs);
}

let s = "";
process.stdin.on("data", d => (s += d)).on("end", () => {
  try {
    const j = JSON.parse(s);
    const bars = j.bars || [];
    const allCloses = bars.map(b => b.close).filter(x => typeof x === "number");
    if (allCloses.length < 30) { console.log("0|0|0|0"); return; }
    // precio actual = ultima vela (en formacion). Indicadores = solo velas CERRADAS
    // (descarta la ultima) para que RSI/EMA no salten con cada tick.
    const price = allCloses[allCloses.length - 1];
    const closed = allCloses.slice(0, -1);
    const e9 = ema(closed, 9);
    const e21 = ema(closed, 21);
    const r = rsiWilder(closed, 14);
    // momentum real de precio: cuánto subió/bajó en las últimas N velas cerradas
    const mom5 = closed[closed.length - 1] - closed[closed.length - 6];
    const mom2 = closed[closed.length - 1] - closed[closed.length - 3];
    // Efficiency Ratio (Kaufman) sobre 14 velas: detecta choppy vs direccional.
    //   neto = |cambio total|;  ruido = suma de cambios absolutos vela a vela.
    //   ER cerca de 1 = tendencia limpia;  ER cerca de 0 = sierra (choppy).
    const N = 14;
    const seg = closed.slice(-N - 1);
    const neto = Math.abs(seg[seg.length - 1] - seg[0]);
    let ruido = 0;
    for (let k = 1; k < seg.length; k++) ruido += Math.abs(seg[k] - seg[k - 1]);
    const er = ruido > 0 ? neto / ruido : 0;
    // Ratio de volumen: prom. de las últimas 3 velas CERRADAS vs prom. de todas.
    //   volr > 1.2 = volumen sobre lo normal (compradores empujando / convicción).
    const allVols = bars.map(b => b.volume).filter(v => typeof v === "number");
    const closedVols = allVols.slice(0, -1); // descarta la vela en formación
    const promTodos = closedVols.reduce((a, v) => a + v, 0) / (closedVols.length || 1);
    const ult3 = closedVols.slice(-3);
    const promUlt3 = ult3.reduce((a, v) => a + v, 0) / (ult3.length || 1);
    const volr = promTodos > 0 ? promUlt3 / promTodos : 0;
    // volumen ABSOLUTO reciente (prom últimas 3 cerradas): detecta mercado muerto
    //   sin liquidez (madrugada, vol=1). Bajo umbral => movimientos fantasma, no operar.
    const volabs = promUlt3;
    // formato: precio|ema9|ema21|rsi|mom5|mom2|er|volr|volabs
    console.log([price, e9, e21, r, mom5, mom2, er, volr, volabs].map(x => x.toFixed(2)).join("|"));
  } catch (e) {
    console.log("0|0|0|0");
  }
});
