#!/usr/bin/env node
// =============================================================================
// senales_score.cjs — ¿El A+ en vivo rinde lo que prometió el backtest?
//
// Lee el diario de señales (~/Trading/senales_aplus.jsonl, lo escribe el detector
// al disparar cada A+), resuelve cada señal pendiente contra las velas REALES de
// Binance (¿tocó primero el TP o el SL?), y guarda el resultado. Con --reporte
// manda el resumen a Telegram/macOS comparando el win rate real vs el esperado.
//
// Esperado del backtest (calibración 2026-07-02, ETH): WR ~80%, ~0,7 señales/día.
// Umbral de alerta: WR real < 65% con ≥8 señales resueltas → "recalibremos".
//
// Uso:
//   node scripts/senales_score.cjs             # resuelve pendientes, imprime tabla
//   node scripts/senales_score.cjs --reporte   # además manda resumen a Telegram
//
// Filosofía: el sistema SE MIDE solo pero NO SE RECALIBRA solo — la decisión de
// cambiar umbrales es de Vero+Claude, con el barrido en la mano.
// =============================================================================

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const bn = require("./binance_client.cjs");   // fuente ÚNICA del veredicto: fills reales
// FUENTE ÚNICA del PnL realizado — el MISMO módulo que lee VQL (lib/pnl/realized-pnl.cjs).
// Misma ventana (WINDOW_DAYS) y mismo cálculo FIFO → Telegram y VQL dan idéntico.
const pnlLib = require("./lib/realized-pnl.cjs");

const DIARIO = path.join(process.env.HOME, "Trading", "senales_aplus.jsonl");
const HOSTS = ["api.binance.com", "data-api.binance.vision", "api1.binance.com"];
const WR_ESPERADO = 80;          // del backtest 2026-07-02 (dato SECUNDARIO, ya no gatilla)
const MIN_TRADES = 20;           // muestra mínima: 20 trades reales CERRADOS (cantidad, NO días)
// Banda muerta del semáforo (override por env; default = del módulo compartido).
const DEADBAND_USD = process.env.DEADBAND_USD != null ? Number(process.env.DEADBAND_USD) : pnlLib.DEFAULT_DEADBAND_USD;
const T_CRIT       = process.env.T_CRIT       != null ? Number(process.env.T_CRIT)       : pnlLib.DEFAULT_T_CRIT;
// Costo de operar: comisión REAL de Binance spot, PORCENTUAL sobre el nocional.
// Medida en la cuenta de Vero: 0,0742 % por lado = el tier con descuento BNB (0,075 %),
// o sea ~0,15 % round-trip. Antes acá había un spread FIJO en dólares
// ({ ETHUSDT: 1.75, BTCUSDT: 50 }) heredado del CFD de Capital.com: no escalaba con el
// precio y, en BTC, inflaba el pnl/u hasta tapar por completo al de ETH.
const FEE_RATE = process.env.BINANCE_FEE_RATE != null ? Number(process.env.BINANCE_FEE_RATE) : 0.00075;
const REPORTE = process.argv.includes("--reporte");

async function klinesDesde(symbol, tsMs) {
    // Velas 1m desde la señal hasta ahora (máx ~32h en 2 páginas; suficiente para scalp)
    let bars = [], start = tsMs;
    for (let page = 0; page < 2; page++) {
        let data = null;
        const url = `/api/v3/klines?symbol=${symbol}&interval=1m&startTime=${start}&limit=1000`;
        for (const h of HOSTS) {
            try { const r = await fetch("https://" + h + url); if (r.ok) { data = await r.json(); break; } } catch (e) {}
        }
        if (!data || !data.length) break;
        bars = bars.concat(data.map(k => ({ time: k[0], high: +k[2], low: +k[3] })));
        if (data.length < 1000) break;
        start = data[data.length - 1][0] + 60000;
    }
    return bars;
}

// Precios spot de TODO el exchange (endpoint público, sin firma) para valorizar
// comisiones a USD — MISMO método que VQL (feeToUsd con el mapa de precios). Ante
// fallo devuelve {} (la fee no-USDT cae a 0, neutro).
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

// Rendimiento REAL desde myTrades — delega TODO el cálculo al módulo compartido
// (pnlLib): FIFO idéntico, ventana WINDOW_DAYS idéntica, fees a USD idénticas. Así
// este reporte y la vista de VQL dan los MISMOS números. Devuelve { error } si no
// pudo leer los fills. El neto es USDT REALES: perder acá es perder plata de verdad.
async function rendimientoRealBinance(symbol) {
    let fills;
    try { fills = await bn.getMyTrades(symbol, 1000); }
    catch (e) { return { error: e.message }; }
    const prices = await fetchPreciosSpot();
    const { closed: all } = pnlLib.deriveClosedTrades(fills || [], prices);
    const closed = pnlLib.filterByWindow(all, { windowDays: pnlLib.WINDOW_DAYS });
    const summary = pnlLib.summarize(closed);
    const verdict = pnlLib.edgeVerdict(closed, { minTrades: MIN_TRADES, deadbandUsd: DEADBAND_USD, tCrit: T_CRIT });
    return { closed, summary, verdict };
}

(async () => {
    if (!fs.existsSync(DIARIO)) { console.log("Sin diario de señales todavía (0 señales disparadas)."); if (REPORTE) notify("Score A+ · Vero", "Aún no hay señales A+ registradas para evaluar. (El diario se llena solo con cada aviso del detector.)", "Glass"); return; }
    const lineas = fs.readFileSync(DIARIO, "utf8").split("\n").filter(Boolean);
    const senales = lineas.map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);

    let cambiado = false;
    for (const s of senales) {
        if (s.resultado) continue;                       // ya resuelta
        const bars = await klinesDesde(s.symbol, s.ts + 60000);  // desde la vela siguiente
        for (const b of bars) {
            if (b.low <= s.sl)  { s.resultado = "stop";   s.resuelto_ts = b.time; break; }
            if (b.high >= s.tp) { s.resultado = "target"; s.resuelto_ts = b.time; break; }
        }
        if (s.resultado) {
            // Comisión de entrada + de salida, ambas sobre el nocional de UNA unidad.
            const salida = s.resultado === "target" ? s.tp : s.sl;
            const costo  = FEE_RATE * (s.entry + salida);
            s.pnl = +((salida - s.entry) - costo).toFixed(2);
            cambiado = true;
            console.log(`resuelta: ${s.fecha} ${s.epic} ${s.entry} → ${s.resultado === "target" ? "🎯 TARGET" : "🛑 STOP"} (pnl/u ${s.pnl >= 0 ? "+" : ""}$${s.pnl})`);
        }
    }
    if (cambiado) fs.writeFileSync(DIARIO, senales.map(s => JSON.stringify(s)).join("\n") + "\n");

    // ---- veredicto: SOLO trades reales CERRADOS en Binance (ETH-only) ----
    // (el diario simulado de arriba se mantiene para otros consumidores; el semáforo
    //  del reporte YA NO sale de ahí — sale de myTrades casado FIFO)
    const fmt = n => (n < 0 ? "-" : "+") + "$" + Math.abs(Number(n)).toFixed(2);
    const real = await rendimientoRealBinance("ETHUSDT");
    // atajos legibles derivados del módulo compartido
    const S = real.summary, V = real.verdict;
    const cerrados = S ? S.nTrades : 0;
    const neto     = S ? S.netAcum : 0;
    const wr       = S && S.nTrades ? Math.round(S.winRate * 100) : null;

    console.log(`\n════ SCORE A+ ETH — trades REALES cerrados en Binance (${pnlLib.WINDOW_DAYS}d) ════`);
    if (real.error)     console.log(`No pude leer Binance: ${real.error}`);
    else if (!cerrados) console.log("0 trades cerrados en Binance todavía.");
    else console.log(`Neto realizado: ${fmt(neto)} · cerrados: ${cerrados}/${MIN_TRADES} · WR ${wr}% · t=${V.tStat.toFixed(2)} · veredicto ${V.estado}`);

    // ---- radar de casi-señales: qué tan cerca estuvo el mercado del A+ (24h) ----
    const CASI = path.join(process.env.HOME, "Trading", "casi_senales.jsonl");
    let casiMsg = "";
    if (fs.existsSync(CASI)) {
        const todas = fs.readFileSync(CASI, "utf8").split("\n").filter(Boolean)
            .map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
        // poda a 14 días (el radar escribe cada ~6s cuando hay casi-señal sostenida)
        const corte = Date.now() - 14 * 86400000;
        const vivas = todas.filter(c => c.ts >= corte);
        if (vivas.length !== todas.length) fs.writeFileSync(CASI, vivas.length ? vivas.map(c => JSON.stringify(c)).join("\n") + "\n" : "");
        const hoy = vivas.filter(c => c.ts >= Date.now() - 24 * 3600000);
        if (hoy.length) {
            // agrupa por minuto+símbolo para no contar el mismo momento 10 veces
            const porMin = new Map();
            for (const c of hoy) {
                const k = c.fecha + "|" + c.symbol;
                const prev = porMin.get(k);
                if (!prev || c.faltaron.length < prev.faltaron.length) porMin.set(k, c);
            }
            const top = [...porMin.values()].sort((a, b) => a.faltaron.length - b.faltaron.length)[0];
            casiMsg = `\n🔭 Casi-señales (24h): ${porMin.size} momento(s). El más cercano: ${top.fecha.slice(11)} ${top.symbol} — faltó solo ${top.faltaron.join(" y ")}. El sistema está mirando; el gong suena cuando no falte NADA.`;
        } else {
            casiMsg = "\n🔭 Sin casi-señales en 24h: el mercado anduvo lejos del setup. El silencio es correcto, no es que el sistema duerma.";
        }
    }

    // Semáforo con BANDA MUERTA (viene del módulo compartido, edgeVerdict):
    //  gris_muestra   <20 cerrados            → sin veredicto
    //  gris_breakeven |neto| ≤ banda muerta   → breakeven, NO es perder plata
    //  gris_ruido     neto<0 pero no signif.  → ruido, tampoco rojo
    //  rojo           neto<-banda Y t≤-Tcrit  → edge degradado DE VERDAD
    //  verde          neto>banda              → edge vivo (con chequeo de enfriamiento)
    let titulo = "Score A+ · Vero", msg, sonido = "Glass";
    const now = Date.now(), mitad = now - 7 * 86400000;
    const tExit = c => new Date(c.exitTime).getTime();
    const netoRec  = real.closed ? real.closed.filter(c => tExit(c) >= mitad).reduce((a, c) => a + c.netPnl, 0) : 0;
    const netoPrev = real.closed ? real.closed.filter(c => tExit(c) <  mitad).reduce((a, c) => a + c.netPnl, 0) : 0;
    const cola = cerrados
        ? `Neto realizado ETH ${fmt(neto)} en ${cerrados} trades cerrados (${pnlLib.WINDOW_DAYS}d) · WR ${wr}% (secundario, backtest ${WR_ESPERADO}%).`
        : "";
    const banda = `banda muerta ±${fmt(DEADBAND_USD).replace("+", "")}`;

    if (real.error) {
        msg = `📊 Score A+ ETH: no pude leer los trades de Binance (${real.error}). Sin veredicto — reviso llaves/red y reintento.`;
    } else if (V.estado === "gris_muestra") {
        msg = cerrados
            ? `📊 Score A+ ETH (${pnlLib.WINDOW_DAYS}d): ${cola} Muestra en formación (${cerrados}/${MIN_TRADES} trades cerrados reales) — sin veredicto de edge todavía. El semáforo se prende recién a los ${MIN_TRADES}.`
            : `📊 Score A+ ETH (${pnlLib.WINDOW_DAYS}d): 0 trades cerrados en Binance todavía. Muestra en formación (0/${MIN_TRADES}) — sin veredicto de edge.`;
    } else if (V.estado === "gris_breakeven") {
        msg = `⚪ Edge ETH en BREAKEVEN (${banda}): ${cola} ${fmt(neto)} en ${cerrados} trades es ~cero, NO es perder plata. Sin alarma.`;
    } else if (V.estado === "gris_ruido") {
        msg = `⚪ Edge ETH levemente negativo pero dentro del RUIDO (t=${V.tStat.toFixed(2)}, no distinguible de cero): ${cola} Aún no es señal de degradación. Sin alarma.`;
    } else if (V.estado === "rojo") {
        titulo = "⚠️ Edge degradado · A+ ETH";
        sonido = "Basso";
        msg = `🔴 Edge ETH en rojo DE VERDAD: neto ${fmt(neto)} fuera de la ${banda} Y estadísticamente negativo (t=${V.tStat.toFixed(2)} ≤ -${T_CRIT}). ${cola} Correr el barrido con Claude y recalibrar JUNTAS — no aflojar a mano.`;
    } else if (netoRec < 0 && netoPrev > 0) {
        titulo = "🟡 Edge enfriándose · A+ ETH";
        msg = `🟡 Edge ETH aún en verde (${cola}) pero enfriándose: últimos 7d ${fmt(netoRec)} vs 7d previos ${fmt(netoPrev)}. Sin alarma, ojo nomás.`;
    } else {
        msg = `🟢 Edge ETH vivo: ${cola} WR bajo el backtest NO es perder plata si el neto es positivo.`;
    }
    msg += casiMsg;
    console.log("\n" + msg + "\n");
    if (REPORTE) notify(titulo, msg, sonido);
})();

function notify(titulo, msg, sonido) {
    try {
        execFileSync(path.join(__dirname, "notify.sh"), [titulo, msg, sonido], { cwd: path.join(__dirname, "..") });
    } catch (e) { console.error("notify falló:", e.message); }
}
