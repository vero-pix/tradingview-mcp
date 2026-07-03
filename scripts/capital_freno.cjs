#!/usr/bin/env node
// =============================================================================
// capital_freno.cjs — Freno anti-sobre-operar: te grita la matemática EN EL MOMENTO
//
// No puede bloquear tus clicks en la app de Capital. Lo que SÍ puede: leer tus
// posiciones cada pocos segundos y, apenas detecta el patrón que te cuesta plata,
// avisarte fuerte (Telegram + sonido) con la matemática cruda. Es el espejo que la
// vez de las 8 posiciones te hizo cerrar 8/8: ver el número, no la emoción.
//
// NO cierra nada ni pone stops (eso lo hacen stopguard + trailing). Solo ALERTA.
// Ataca los 4 patrones de tu historial:
//   1. Demasiadas posiciones      (el modelo dice UNA entrada A+)
//   2. Promediar a la baja         (regla de oro #2: duplica el riesgo ciego)
//   3. Riesgo total > tu cuenta    (arriesgar más de lo que tienes)
//   4. Instrumento no cubierto     (ORO/lo-que-sea: sin señal, sin backtest, sin zonas)
//
// Uso:
//   node scripts/capital_freno.cjs            # loop de alerta (no toca nada)
//
// Env: MAX_POS (default 2), MAX_RISK_PCT (% del balance, default 15),
//      COVERED (default "ETHUSD,BTCUSD"), INTERVAL (seg, default 12),
//      ACCOUNT ("USD 2"), DEMO=1.
// =============================================================================

const { execFileSync } = require("child_process");
const path = require("path");
const capital = require("./capital_client.cjs");

const HOME = process.env.HOME;
const DIR  = path.join(HOME, "Trading", "tradingview-mcp");

const argv = process.argv.slice(2);
const demo = argv.includes("--demo");
const ACCOUNT  = process.env.ACCOUNT || "USD 2";
const INTERVAL = (process.env.INTERVAL ? Number(process.env.INTERVAL) : 12) * 1000;
const MAX_POS  = process.env.MAX_POS != null ? Number(process.env.MAX_POS) : 2;
const MAX_RISK_PCT = process.env.MAX_RISK_PCT != null ? Number(process.env.MAX_RISK_PCT) : 15;
const COVERED  = (process.env.COVERED || "ETHUSD,BTCUSD").split(",").map(s => s.trim().toUpperCase());

function ts() { return new Date().toISOString().slice(11, 19); }
function notify(title, msg, sound) {
    try { execFileSync("bash", [path.join(DIR, "scripts", "notify.sh"), title, msg, sound], { stdio: "ignore" }); }
    catch (e) {}
}

// Firma de la última situación avisada: solo re-alertamos si CAMBIA o EMPEORA,
// para no spamear cada 12s con la misma foto.
let lastKey = null;

async function tick() {
    // Balance de la cuenta (para medir riesgo como % de lo que tienes).
    const accs = await capital.getAccounts({ demo });
    const acc  = accs.find(a => a.accountName === ACCOUNT);
    const balance = (acc && acc.balance && acc.balance.balance) || 0;

    await capital.selectAccount(ACCOUNT, { demo });
    const pos = await capital.getPositions({ demo });

    if (!pos.length) { console.log(`${ts()} flat — nada que vigilar`); lastKey = null; return; }

    // ---- calcular los 4 patrones ----
    const count = pos.length;

    // 2. promediar: 2+ LONG del mismo epic
    const longsByEpic = {};
    for (const p of pos) {
        if (p.direction !== "BUY") continue;
        const e = (p.epic || "?").toUpperCase();
        (longsByEpic[e] = longsByEpic[e] || []).push(p);
    }
    const promediando = Object.entries(longsByEpic).filter(([, ps]) => ps.length >= 2);

    // 3. riesgo total en stops (posiciones sin stop las cubre el stopguard; las contamos aparte)
    let riesgo = 0, naked = 0;
    for (const p of pos) {
        if (p.stopLevel == null) { naked++; continue; }
        const r = Math.abs(p.openLevel - p.stopLevel) * p.size * (p.contractSize || 1);
        if (p.direction === "BUY") riesgo += r;
    }
    const riskPct = balance > 0 ? (riesgo / balance) * 100 : 0;

    // 4. instrumentos no cubiertos por el sistema (el caso ORO)
    const uncovered = [...new Set(pos.map(p => (p.epic || "?").toUpperCase()))].filter(e => !COVERED.includes(e));

    // ---- construir alarmas activas ----
    const alarmas = [];
    if (count > MAX_POS)
        alarmas.push(`🔴 ${count} posiciones abiertas (máx sano: ${MAX_POS}). El modelo dice UNA entrada A+. Cada extra es sobre-operar — así bajaste de $66 a $17. PARA de abrir.`);
    for (const [e, ps] of promediando)
        alarmas.push(`🔴 Promediando ${e}: ${ps.length} longs encimados. Regla de oro #2: NO promediar. Sin criterio, abrir más no arregla un trade en contra — lo dobla.`);
    if (riskPct > MAX_RISK_PCT)
        alarmas.push(`🔴 Riesgo en stops $${riesgo.toFixed(2)} = ${riskPct.toFixed(0)}% de tu cuenta ($${balance}). Un trade no debería arriesgar tanto. Cierra lo de más.`);
    if (uncovered.length)
        alarmas.push(`🔴 ${uncovered.join(", ")} NO está en tu sistema. Sin señal A+, sin backtest, sin zonas: es apostar a ciegas. Ciérralo.`);

    if (!alarmas.length) {
        const nk = naked ? ` (${naked} sin stop — el stopguard las protege)` : "";
        console.log(`${ts()} ✅ ${count} posición(es), sin patrón de sobre-operar${nk}`);
        lastKey = null;
        return;
    }

    // firma: nº alarmas + count + epics + bucket de riesgo. Re-alerta si cambia o empeora.
    const key = `${alarmas.length}|${count}|${Object.keys(longsByEpic).sort().join(",")}|${Math.round(riskPct / 5)}`;
    if (key === lastKey) { console.log(`${ts()} (misma situación, ya avisada) ${alarmas.length} alarma(s)`); return; }
    lastKey = key;

    // escalar el sonido según cuántas alarmas juntas (más alarmas = más fuerte)
    const sound = alarmas.length >= 3 ? "Funk" : alarmas.length === 2 ? "Sosumi" : "Basso";
    const titulo = `🛑 FRENO · ${alarmas.length} señal(es) de sobre-operar`;
    const cuerpo = alarmas.join("\n") + `\n\nRespira. Cierra lo que no sea UNA entrada A+ limpia. No hay revenge trade que valga.`;
    console.log(`${ts()} >>> ${alarmas.length} ALARMA(S): ${count} pos, riesgo ${riskPct.toFixed(0)}%, uncovered=[${uncovered.join(",")}]`);
    notify(titulo, cuerpo, sound);
}

(async () => {
    console.log(`${ts()} freno anti-sobre-operar activo — cuenta ${ACCOUNT}, máx ${MAX_POS} pos, máx riesgo ${MAX_RISK_PCT}%, cubre [${COVERED.join(",")}], cada ${INTERVAL / 1000}s`);
    for (;;) {
        try { await tick(); }
        catch (e) { console.log(`${ts()} err: ${e.message}`); }
        await new Promise(r => setTimeout(r, INTERVAL));
    }
})();
