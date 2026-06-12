#!/usr/bin/env node
// Trae OHLCV de Binance (con VOLUMEN REAL) para el detector de entradas.
// Motivo: el chart de Capital.com (CAPITALCOM:ETHUSD) es un feed de CFD que NO
// entrega volumen en TradingView (siempre devuelve 1). El precio ETH spot es
// prácticamente idéntico entre Capital.com y Binance, así que detectamos la
// señal con datos de Binance y Vero sigue OPERANDO en Capital.com.
//
// Salida: mismo formato que `tv ohlcv` -> {bars:[{time,open,high,low,close,volume}]}
// para que scripts/calc_indicators.js lo consuma sin cambios.
//
// ROBUSTEZ: reintenta hasta 3 veces ante caídas de red/timeout. Si TODO falla,
// imprime {"bars":[]} (el detector lo trata como "sin datos" y reintenta en el
// próximo ciclo) — NUNCA datos parciales o engañosos.
//
// Config por env: BINANCE_SYMBOL (ETHUSDT), BINANCE_INTERVAL (1m), BINANCE_LIMIT (100)

const SYMBOL = process.env.BINANCE_SYMBOL || 'ETHUSDT';
const INTERVAL = process.env.BINANCE_INTERVAL || '1m';
const LIMIT = process.env.BINANCE_LIMIT || '100';
// Hosts alternativos: si api.binance.com está bloqueado/caído, probar los espejos.
const HOSTS = ['api.binance.com', 'api-gcp.binance.com', 'api1.binance.com', 'data-api.binance.vision'];
const PATH = `/api/v3/klines?symbol=${SYMBOL}&interval=${INTERVAL}&limit=${LIMIT}`;

async function fetchOnce(host) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 6000);
  try {
    const r = await fetch(`https://${host}${PATH}`, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const rows = await r.json();
    if (!Array.isArray(rows) || rows.length < 30) throw new Error('respuesta inválida o insuficiente');
    // kline Binance: [openTime, open, high, low, close, volume, closeTime, ...]
    const bars = rows.map(k => ({
      time: Math.floor(k[0] / 1000),
      open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5],
    }));
    // sanidad: el volumen debe ser real (no el placeholder 1 de Capital.com)
    const totalVol = bars.reduce((a, b) => a + b.volume, 0);
    if (!(totalVol > bars.length)) throw new Error('volumen sospechoso (placeholder?)');
    return bars;
  } finally {
    clearTimeout(t);
  }
}

(async () => {
  // 2 vueltas por cada host alternativo antes de rendirse
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const host of HOSTS) {
      try {
        const bars = await fetchOnce(host);
        console.log(JSON.stringify({ bars, source: 'binance', host, symbol: SYMBOL, interval: INTERVAL }));
        return;
      } catch { /* probar siguiente host */ }
    }
  }
  console.log('{"bars":[]}'); // todo falló -> detector reintenta el próximo ciclo
})();
