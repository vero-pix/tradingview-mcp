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

const DIARIO = path.join(process.env.HOME, "Trading", "senales_aplus.jsonl");
const HOSTS = ["api.binance.com", "data-api.binance.vision", "api1.binance.com"];
const WR_ESPERADO = 80;          // del backtest 2026-07-02
const WR_ALERTA = 65;            // bajo esto (con muestra suficiente) → avisar
const MIN_MUESTRA = 8;           // señales resueltas mínimas para el veredicto
const SPREAD = { ETHUSDT: 1.75, BTCUSDT: 50 };
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
            const spread = SPREAD[s.symbol] ?? 1.75;
            s.pnl = +(((s.resultado === "target" ? s.tp : s.sl) - s.entry) - spread).toFixed(2);
            cambiado = true;
            console.log(`resuelta: ${s.fecha} ${s.epic} ${s.entry} → ${s.resultado === "target" ? "🎯 TARGET" : "🛑 STOP"} (pnl/u ${s.pnl >= 0 ? "+" : ""}$${s.pnl})`);
        }
    }
    if (cambiado) fs.writeFileSync(DIARIO, senales.map(s => JSON.stringify(s)).join("\n") + "\n");

    // ---- resumen (últimos 14 días) ----
    const hace14d = Date.now() - 14 * 86400000;
    const rec = senales.filter(s => s.ts >= hace14d);
    const res = rec.filter(s => s.resultado);
    const pend = rec.length - res.length;
    const wins = res.filter(s => s.resultado === "target").length;
    const wr = res.length ? Math.round(wins / res.length * 100) : null;
    const neto = res.reduce((a, s) => a + (s.pnl || 0), 0);

    console.log("\n════ SCORE A+ (últimos 14 días) ════");
    console.log(`Señales: ${rec.length} (${res.length} resueltas, ${pend} abiertas)`);
    if (wr != null) {
        console.log(`WR real: ${wr}% (esperado backtest: ${WR_ESPERADO}%) · Neto/u: ${neto >= 0 ? "+" : ""}$${neto.toFixed(2)}`);
    }

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

    let titulo = "Score A+ · Vero", msg, sonido = "Glass";
    if (!res.length) {
        msg = `📊 Score A+ (14d): ${rec.length} señales, ninguna resuelta aún. Sin datos para comparar con el backtest todavía.`;
    } else if (res.length < MIN_MUESTRA) {
        msg = `📊 Score A+ (14d): ${res.length} resueltas · WR ${wr}% · neto ${neto >= 0 ? "+" : ""}$${neto.toFixed(2)}/u. Muestra chica aún (mínimo ${MIN_MUESTRA} para veredicto). Esperado: WR ${WR_ESPERADO}%.`;
    } else if (wr < WR_ALERTA) {
        titulo = "⚠️ Edge degradado · A+";
        sonido = "Basso";
        msg = `🔴 El A+ real rinde BAJO lo esperado: WR ${wr}% vs ${WR_ESPERADO}% del backtest (${res.length} señales, 14d). Neto ${neto >= 0 ? "+" : ""}$${neto.toFixed(2)}/u. Sugerencia: correr el barrido con Claude y recalibrar JUNTAS. No aflojar a mano.`;
    } else {
        msg = `🟢 El A+ real rinde según lo esperado: WR ${wr}% (backtest: ${WR_ESPERADO}%), neto ${neto >= 0 ? "+" : ""}$${neto.toFixed(2)}/u en ${res.length} señales (14d). El edge sigue vivo.`;
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
