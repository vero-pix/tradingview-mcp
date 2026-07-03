#!/usr/bin/env node
// =============================================================================
// continuacion_monitor.cjs — Señal de CONTINUACIÓN (informativa, NO arma orden)
//
// Dos usos, con candado anti-chasing:
//   1. AGUANTAR EL GANADOR: si estás dentro y la tendencia sigue viva, te dice que
//      no cortes temprano; si entra en sobrecompra, te recuerda tomar ganancia (regla #3);
//      si la tendencia se apaga, te avisa que el envión se acabó.
//   2. PREPARAR LA PRÓXIMA: si estás flat y hay tendencia limpia SIN pullback, te da UN
//      aviso ("prepárate, espera el pullback, NO persigas") — una vez por tramo.
//
// Candado: si estás FLAT y el precio está en sobrecompra (subiendo fuerte), se queda
// CALLADO — no te tienta a perseguir un envión. Nunca dice "compra": las entradas son
// del detector A+ con su pullback. Esto solo informa el estado de la tendencia.
//
// NO toca posiciones ni arma órdenes. Solo alerta en TRANSICIONES de estado.
//
// Uso:  node scripts/continuacion_monitor.cjs
// Env:  SYMBOL (default ETHUSDT), EPIC (default ETHUSD), INTERVAL (seg, default 30),
//       ER_MIN (0.30), RSI_LO (55), RSI_HI (72), RSI_OB (73), ACCOUNT ("USD 2"), DEMO=1.
// =============================================================================

const { execFileSync } = require("child_process");
const path = require("path");
const capital = require("./capital_client.cjs");

const HOME = process.env.HOME;
const DIR  = path.join(HOME, "Trading", "tradingview-mcp");
const NODE = process.execPath;

const demo = process.argv.includes("--demo");
const SYMBOL   = process.env.SYMBOL || "ETHUSDT";
const EPIC     = process.env.EPIC || "ETHUSD";
const ACCOUNT  = process.env.ACCOUNT || "USD 2";
const INTERVAL = (process.env.INTERVAL ? Number(process.env.INTERVAL) : 30) * 1000;
const ER_MIN = Number(process.env.ER_MIN || 0.30);
const RSI_LO = Number(process.env.RSI_LO || 55);
const RSI_HI = Number(process.env.RSI_HI || 72);
const RSI_OB = Number(process.env.RSI_OB || 73);

function ts() { return new Date().toISOString().slice(11, 19); }
function notify(title, msg, sound) {
    try { execFileSync("bash", [path.join(DIR, "scripts", "notify.sh"), title, msg, sound], { stdio: "ignore" }); }
    catch (e) {}
}

// Lee indicadores 1m: precio|ema9|ema21|rsi|mom5|mom2|er|volr|volabs|atr
function leerIndicadores() {
    const out = execFileSync("bash", ["-lc",
        `BINANCE_SYMBOL="${SYMBOL}" BINANCE_INTERVAL=1m BINANCE_LIMIT=100 "${NODE}" scripts/ohlcv_binance.js | "${NODE}" scripts/calc_indicators.js`],
        { cwd: DIR, encoding: "utf8" }).trim().split("\n").pop();
    const [p, e9, e21, rsi, mom5, mom2, er, volr, volabs, atr] = out.split("|").map(Number);
    return { p, e9, e21, rsi, mom5, mom2, er, volr, volabs, atr };
}

// Estado de la tendencia: DEAD | ALIVE | OB (overbought)
function estadoTendencia(x) {
    const trending = x.er >= ER_MIN && x.e9 > x.e21 && x.p > x.e9;
    if (!trending) return "DEAD";
    if (x.rsi >= RSI_OB) return "OB";
    if (x.rsi >= RSI_LO && x.rsi <= RSI_HI) return "ALIVE";
    return "DEAD"; // trending pero RSI fuera de la banda sana (ej. <55) = no es continuación clara
}

let lastState = null;

async function tick() {
    const x = leerIndicadores();
    if (!x.p) { console.log(`${ts()} sin datos`); return; }
    const estado = estadoTendencia(x);

    // ¿tiene long abierto en este epic?
    let enPosicion = false;
    try {
        await capital.selectAccount(ACCOUNT, { demo });
        const pos = await capital.getPositions({ demo, epic: EPIC });
        enPosicion = pos.some(p => p.direction === "BUY");
    } catch (e) { /* si la API falla, seguimos con enPosicion=false */ }

    const info = `ER=${x.er.toFixed(2)} RSI=${x.rsi.toFixed(0)} p=${x.p} ${enPosicion ? "DENTRO" : "flat"}`;

    // Solo avisamos en TRANSICIÓN de estado (no spamear).
    if (estado === lastState) { console.log(`${ts()} ${estado} (sin cambio) ${info}`); return; }
    console.log(`${ts()} >>> transición ${lastState}→${estado} ${info}`);
    const prev = lastState;
    lastState = estado;

    if (enPosicion) {
        if (estado === "ALIVE")
            notify("🟢 Continuación · aguanta el long", `ETH sigue en tendencia (ER ${x.er.toFixed(2)}, RSI ${x.rsi.toFixed(0)} — no sobrecomprado). No cortes la ganancia temprano. Sal cuando RSI toque 75-80.`, "Glass");
        else if (estado === "OB")
            notify("🎯 Sobrecompra · toma ganancia", `ETH RSI ${x.rsi.toFixed(0)} (sobrecompra). Regla de oro #3: TOMA LA GANANCIA acá, no le pidas más al trade. Confirma VWAP.`, "Hero");
        else if (estado === "DEAD" && (prev === "ALIVE" || prev === "OB"))
            notify("⚠️ Tendencia apagada", `El envión de ETH que te llevaba se acabó (ER ${x.er.toFixed(2)}, choppy). Si estás en verde, evalúa cerrar — no lo devuelvas.`, "Basso");
    } else {
        // FLAT: solo el heads-up de "prepárate" al entrar en ALIVE. En OB → SILENCIO (anti-FOMO).
        if (estado === "ALIVE")
            notify("📈 Tendencia viva · prepárate (NO es entrada)", `ETH en tendencia limpia arriba, pero SIN pullback (precio estirado sobre el EMA9). NO es entrada — espera el pullback al EMA9 para la A+. Prepárate, NO persigas el envión.`, "Purr");
        // estado OB o DEAD estando flat → no molestamos.
    }
}

(async () => {
    console.log(`${ts()} monitor de continuación activo — ${SYMBOL}/${EPIC}, ER≥${ER_MIN}, RSI viva ${RSI_LO}-${RSI_HI}, sobrecompra ≥${RSI_OB}, cada ${INTERVAL / 1000}s`);
    for (;;) {
        try { await tick(); }
        catch (e) { console.log(`${ts()} err: ${e.message}`); }
        await new Promise(r => setTimeout(r, INTERVAL));
    }
})();
