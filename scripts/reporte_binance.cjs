#!/usr/bin/env node
// =============================================================================
// reporte_binance.cjs — Reporte diario ETH leído de BINANCE.
//
// Lee myTrades de Binance (ETH-only, casado FIFO): la cuenta donde se opera de verdad.
//
// FUENTE ÚNICA: el MISMO lib/realized-pnl.cjs que usan senales_score.cjs (la alerta)
// y VQL. Mismo FIFO, misma ventana (WINDOW_DAYS), mismas fees a USD → los tres dan
// EXACTAMENTE el mismo número. No duplica lógica de cálculo a propósito.
//
// Uso:  node scripts/reporte_binance.cjs          # imprime el texto del reporte
// =============================================================================

const bn     = require("./binance_client.cjs");
const pnlLib = require("./lib/realized-pnl.cjs");

const SYMBOL = process.env.SYMBOL || "ETHUSDT";
const BASE   = SYMBOL.replace(/USDT$/, "");
const HOSTS  = ["api.binance.com", "data-api.binance.vision", "api1.binance.com"];

// Mapa de precios spot: valoriza a USD las comisiones pagadas en BNB (el caso de Vero).
async function fetchPreciosSpot() {
    for (const h of HOSTS) {
        try {
            const r = await fetch(`https://${h}/api/v3/ticker/price`);
            if (r.ok) {
                const arr = await r.json();
                const m = {};
                for (const it of arr) m[it.symbol] = Number(it.price);
                return m;
            }
        } catch (e) {}
    }
    return {};
}

const money = n => (n < 0 ? "-" : "+") + "$" + Math.abs(Number(n)).toFixed(2);

// Texto del veredicto (mismo semáforo que la alerta: banda muerta + t-stat).
function leerVeredicto(V) {
    switch (V.estado) {
        case "verde":          return "🟢 En verde en la ventana.";
        case "rojo":           return "🔴 Pérdida estadísticamente distinta de cero — no es ruido.";
        case "gris_breakeven": return "⚪️ Breakeven: el neto está dentro de la banda muerta.";
        case "gris_ruido":     return "⚪️ Negativo pero indistinguible de ruido todavía.";
        default:               return `⚪️ Muestra corta (${V.n}/${V.minTrades} trades) — sin veredicto aún.`;
    }
}

(async () => {
    let fills;
    try { fills = await bn.getMyTrades(SYMBOL, 1000); }
    catch (e) { console.log(`📊 Reporte ETH · Binance\n\n(No pude leer myTrades de Binance ahora: ${e.message})`); return; }

    const prices = await fetchPreciosSpot();
    const { closed: all, openQty } = pnlLib.deriveClosedTrades(fills || [], prices);

    // Ventana canónica (14d) — la MISMA que la alerta y VQL.
    const win = pnlLib.filterByWindow(all, { windowDays: pnlLib.WINDOW_DAYS });
    const S = pnlLib.summarize(win);
    const V = pnlLib.edgeVerdict(win);

    // Actividad de las últimas 24h (lo que pasó "ayer", que es de lo que habla el reporte).
    const dia = pnlLib.filterByWindow(all, { windowDays: 1 });
    const D = pnlLib.summarize(dia);

    const L = [];
    L.push(`📊 Reporte ${BASE} · Binance (ventana ${pnlLib.WINDOW_DAYS}d)`);
    L.push("");

    if (!D.nTrades) {
        L.push("Últimas 24h: 0 trades cerrados (no operaste).");
    } else {
        L.push(`Últimas 24h: ${D.nTrades} trade(s) cerrados · neto ${money(D.netAcum)}` +
               (D.nTrades ? ` · WR ${Math.round(D.winRate * 100)}%` : ""));
    }
    L.push("");

    if (!S.nTrades) {
        L.push(`Ventana ${pnlLib.WINDOW_DAYS}d: sin trades cerrados todavía.`);
    } else {
        L.push(`Ventana ${pnlLib.WINDOW_DAYS}d — trades REALES cerrados:`);
        L.push(`• Trades: ${S.nTrades} · WR ${Math.round(S.winRate * 100)}% (${S.wins} ganados)`);
        L.push(`• Bruto: ${money(S.grossAcum)}`);
        L.push(`• Fees: -$${S.feeTotalUsd.toFixed(2)}${S.feePaidInBnb ? " (pagadas en BNB)" : ""}`);
        L.push(`• NETO: ${money(S.netAcum)}`);
        L.push("");
        L.push(leerVeredicto(V));
    }

    // Estado de cuenta: lo que de verdad hay disponible ahora.
    try {
        const bal  = await bn.getBalances();
        const arr  = Array.isArray(bal) ? bal : (bal.balances || []);
        const get  = a => { const b = arr.find(x => x.asset === a); return b ? Number(b.free) : 0; };
        const usdt = get("USDT");
        L.push("");
        L.push(`Cuenta: $${usdt.toFixed(2)} USDT libres` +
               (openQty > 1e-8 ? ` · posición ${BASE} abierta: ${openQty.toFixed(6)}` : ` · sin posición ${BASE} abierta`));
    } catch (e) { /* el reporte vale igual sin el saldo */ }

    console.log(L.join("\n"));
})().catch(e => { console.log(`📊 Reporte ${BASE} · Binance\n\n(Error generando el reporte: ${e.message})`); });
