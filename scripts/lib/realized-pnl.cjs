// =============================================================================
// realized-pnl.cjs — FUENTE ÚNICA del PnL realizado desde myTrades de Binance.
//
// CommonJS a propósito: lo consumen DOS runtimes distintos —
//   • VQL (Next/TS) lo importa en lib/historial/service.ts
//   • el script del server (tradingview-mcp/scripts/senales_score.cjs) lo `require`
// Como corren en máquinas distintas, el server lleva una COPIA IDÉNTICA en
// tradingview-mcp/scripts/lib/realized-pnl.cjs. Editá ESTE archivo (el canónico en
// VQL) y copiá el resultado al twin del server. No dupliques la lógica: ambos leen
// las mismas funciones, con la MISMA ventana y el MISMO cálculo, para que den idéntico.
//
// Sin dependencias ni fetch: el llamador entrega los fills crudos (myTrades), un
// mapa de precios spot (para valorizar comisiones a USD) y "ahora". Determinista.
// =============================================================================

const STABLES = new Set(["USDT", "USDC", "BUSD", "FDUSD", "TUSD", "DAI"]);
const EPS = 1e-12;

// Ventana canónica del veredicto de edge. La comparten Telegram y VQL para que
// el neto/trades/WR sean idénticos. Cambiala acá y se mueve en los dos.
const WINDOW_DAYS = 14;

// Banda muerta del semáforo (fix banda muerta): entre ±DEADBAND_USD el neto es
// "breakeven" (gris), nunca rojo. Y para gritar ROJO se exige además que el neto
// sea estadísticamente distinto de cero (t de una muestra ≤ -T_CRIT). Así "-$0,02
// en 21 trades" queda gris, no "perdiste plata".
const DEFAULT_DEADBAND_USD = 0.5;   // margen económico mínimo para considerar pérdida
const DEFAULT_T_CRIT = 1.64;        // ~95% una cola: "distinto de cero" por abajo
const DEFAULT_MIN_TRADES = 20;      // muestra mínima (cantidad, no calendario)

// Valoriza una comisión a USD. Stablecoin = 1:1; el resto con {ASSET}USDT del mapa
// de precios. Sin precio conocido -> 0 (neutro, no rompe el neto).
function feeToUsd(amount, asset, prices) {
  if (amount <= 0) return 0;
  if (STABLES.has(asset)) return amount;
  const px = (prices && prices[`${asset}USDT`]) || 0;
  return amount * px;
}

// Casa compras con ventas por FIFO. Cada VENTA (fill) produce un trade cerrado,
// con entrada = promedio ponderado de las compras que consumió. Las comisiones
// (compra prorrateada + venta) se acumulan por moneda y se valorizan a USD.
// Devuelve { closed (más reciente primero), openQty }.
function deriveClosedTrades(raw, prices) {
  const trades = [...(raw || [])].sort((a, b) => a.time - b.time);
  const lots = [];
  const closed = [];

  for (const tr of trades) {
    if (tr.isBuyer) {
      lots.push({
        qty: tr.qty,
        px: tr.price,
        time: tr.time,
        feeNativePerUnit: tr.qty > EPS ? tr.commission / tr.qty : 0,
        feeAsset: tr.commissionAsset,
      });
      continue;
    }

    // VENTA: casa contra los lotes de compra más antiguos.
    let remaining = tr.qty;
    const sellFeePerUnit = tr.qty > EPS ? tr.commission / tr.qty : 0;
    const feeNativeByAsset = {};
    let matchedQty = 0;
    let costSum = 0; // Σ px*qty de las compras casadas
    let earliestTime = tr.time;

    const addFee = (asset, amount) => {
      if (amount <= 0 || !asset) return;
      feeNativeByAsset[asset] = (feeNativeByAsset[asset] || 0) + amount;
    };

    while (remaining > EPS && lots.length > 0) {
      const lot = lots[0];
      const q = Math.min(remaining, lot.qty);
      matchedQty += q;
      costSum += q * lot.px;
      addFee(lot.feeAsset, q * lot.feeNativePerUnit);
      earliestTime = Math.min(earliestTime, lot.time);
      lot.qty -= q;
      remaining -= q;
      if (lot.qty <= EPS) lots.shift();
    }

    // Venta sin compra previa en la ventana de myTrades: no se puede casar.
    if (matchedQty <= EPS) continue;

    // Comisión de la venta, prorrateada a lo efectivamente casado.
    addFee(tr.commissionAsset, matchedQty * sellFeePerUnit);

    const feeAssets = Object.keys(feeNativeByAsset);
    const commissionUsd = feeAssets.reduce(
      (s, a) => s + feeToUsd(feeNativeByAsset[a], a, prices),
      0,
    );
    const entryPx = costSum / matchedQty;
    const exitPx = tr.price;
    const grossPnl = (exitPx - entryPx) * matchedQty;

    closed.push({
      symbol: tr.symbol,
      side: "LONG",
      entryTime: new Date(earliestTime).toISOString(),
      exitTime: new Date(tr.time).toISOString(),
      entryPx,
      exitPx,
      size: matchedQty,
      grossPnl,
      commissionUsd,
      commissionNative: feeAssets.length === 1 ? feeNativeByAsset[feeAssets[0]] : null,
      commissionAsset: feeAssets.length === 1 ? feeAssets[0] : "mixto",
      feePaidInBnb: feeAssets.includes("BNB"),
      netPnl: grossPnl - commissionUsd,
    });
  }

  const openQty = lots.reduce((s, l) => s + l.qty, 0);
  return { closed: closed.reverse(), openQty }; // más reciente primero
}

// Filtra los trades cerrados a una ventana por TIEMPO DE SALIDA (la venta que cerró).
// windowDays por defecto = WINDOW_DAYS. now por defecto = Date.now() del llamador.
function filterByWindow(closed, opts) {
  const windowDays = (opts && opts.windowDays != null) ? opts.windowDays : WINDOW_DAYS;
  const now = (opts && opts.now != null) ? opts.now : Date.now();
  const cut = now - windowDays * 86400000;
  return (closed || []).filter((c) => new Date(c.exitTime).getTime() >= cut);
}

function summarize(closed) {
  const list = closed || [];
  const wins = list.filter((c) => c.netPnl > 0).length;
  const netAcum = list.reduce((s, c) => s + c.netPnl, 0);
  const grossAcum = list.reduce((s, c) => s + c.grossPnl, 0);
  const feeTotalUsd = list.reduce((s, c) => s + c.commissionUsd, 0);
  return {
    nTrades: list.length,
    wins,
    winRate: list.length > 0 ? wins / list.length : 0,
    grossAcum,
    netAcum,
    feeTotalUsd,
    feePaidInBnb: list.some((c) => c.feePaidInBnb),
  };
}

// Estadística de una muestra para la banda muerta: media, error estándar y el
// t-stat (media / SE). t muy negativo = pérdida distinguible de cero.
function edgeStats(closed) {
  const list = closed || [];
  const n = list.length;
  const net = list.reduce((s, c) => s + c.netPnl, 0);
  const wins = list.filter((c) => c.netPnl > 0).length;
  const mean = n > 0 ? net / n : 0;
  const variance = n > 1
    ? list.reduce((s, c) => s + (c.netPnl - mean) ** 2, 0) / (n - 1)
    : 0;
  const se = n > 0 ? Math.sqrt(variance / n) : 0;
  const tStat = se > 0 ? mean / se : 0;
  return { n, net, wins, winRate: n > 0 ? wins / n : null, mean, se, tStat };
}

// Veredicto del semáforo con BANDA MUERTA. estados:
//   "gris_muestra"    → menos de minTrades cerrados: sin veredicto
//   "gris_breakeven"  → |net| ≤ deadbandUsd: breakeven, NO es perder plata
//   "gris_ruido"      → net < 0 pero NO distinguible de cero (t > -tCrit): ruido
//   "rojo"            → net < -deadband Y estadísticamente negativo (t ≤ -tCrit)
//   "verde"           → net > deadband
// ROJO exige LAS DOS cosas: margen económico y significancia estadística.
function edgeVerdict(closed, opts) {
  const o = opts || {};
  const minTrades = o.minTrades != null ? o.minTrades : DEFAULT_MIN_TRADES;
  const deadbandUsd = o.deadbandUsd != null ? o.deadbandUsd : DEFAULT_DEADBAND_USD;
  const tCrit = o.tCrit != null ? o.tCrit : DEFAULT_T_CRIT;
  const s = edgeStats(closed);

  let estado;
  if (s.n < minTrades) estado = "gris_muestra";
  else if (Math.abs(s.net) <= deadbandUsd) estado = "gris_breakeven";
  else if (s.net > 0) estado = "verde";
  else if (s.tStat <= -tCrit) estado = "rojo";
  else estado = "gris_ruido";

  return { estado, ...s, minTrades, deadbandUsd, tCrit };
}

module.exports = {
  STABLES,
  EPS,
  WINDOW_DAYS,
  DEFAULT_DEADBAND_USD,
  DEFAULT_T_CRIT,
  DEFAULT_MIN_TRADES,
  feeToUsd,
  deriveClosedTrades,
  filterByWindow,
  summarize,
  edgeStats,
  edgeVerdict,
};
