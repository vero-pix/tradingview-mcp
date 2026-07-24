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
// "Estar dentro" se lee de BINANCE SPOT: tener saldo del activo base sobre el mínimo
// vendible = posición abierta (spot no tiene "posiciones" como el CFD).
//
// Uso:  node scripts/continuacion_monitor.cjs
// Env:  SYMBOL (default ETHUSDT), INTERVAL (seg, default 30),
//       ER_MIN (0.30), RSI_LO (55), RSI_HI (72), RSI_OB (73).
// =============================================================================

const { execFileSync } = require("child_process");
const path = require("path");
const bn = require("./binance_client.cjs");

const HOME = process.env.HOME;
const DIR  = path.join(HOME, "Trading", "tradingview-mcp");
const NODE = process.execPath;

const SYMBOL   = process.env.SYMBOL || "ETHUSDT";
const BASE     = process.env.BASE || SYMBOL.replace(/USDT$/, "");
const INTERVAL = (process.env.INTERVAL ? Number(process.env.INTERVAL) : 30) * 1000;
const ER_MIN = Number(process.env.ER_MIN || 0.30);
const RSI_LO = Number(process.env.RSI_LO || 55);
const RSI_HI = Number(process.env.RSI_HI || 72);
const RSI_OB = Number(process.env.RSI_OB || 73);

// --- Anti-flapping (evita spam por oscilación de estado en el borde) ---
// Histéresis: para SALIR de un estado el umbral es más exigente que para ENTRAR.
const ER_EXIT   = Number(process.env.ER_EXIT   || 0.05);  // sale de tendencia solo si ER < ER_MIN-0.05
const RSI_EXIT  = Number(process.env.RSI_EXIT  || 3);     // margen de RSI para salir de OB / banda viva
// Confirmación: el estado debe sostenerse N lecturas consecutivas antes de avisar.
const CONFIRM_N = Number(process.env.CONFIRM_N || 3);
// Cooldown por tipo de aviso: no se repite el mismo aviso antes de COOLDOWN_MIN.
const COOLDOWN_MS = Number(process.env.COOLDOWN_MIN || 25) * 60 * 1000;

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

// Estado de la tendencia: DEAD | ALIVE | OB (overbought).
// Con HISTÉRESIS: los umbrales de salida son más exigentes que los de entrada,
// según el estado ya confirmado (`prev`), para que no oscile en el borde.
function estadoTendencia(x, prev) {
    const wasTrending = prev === "ALIVE" || prev === "OB";
    // Entrar en tendencia con ER>=ER_MIN; salir solo si ER<ER_MIN-ER_EXIT.
    const erThresh = wasTrending ? ER_MIN - ER_EXIT : ER_MIN;
    const trending = x.er >= erThresh && x.e9 > x.e21 && x.p > x.e9;
    if (!trending) return "DEAD";

    // Sobrecompra con histéresis: se ENTRA a OB con RSI>=RSI_OB; se VUELVE a ALIVE
    // solo si RSI cae bajo RSI_OB-RSI_EXIT (si no, sigue OB).
    if (prev === "OB") {
        if (x.rsi >= RSI_OB - RSI_EXIT) return "OB";
    } else if (x.rsi >= RSI_OB) {
        return "OB";
    }

    // Banda viva: se ENTRA con RSI>=RSI_LO; estando ALIVE se MANTIENE hasta que
    // RSI cae bajo RSI_LO-RSI_EXIT (borde inferior con histéresis). El tramo
    // RSI_HI..RSI_OB se pliega a ALIVE (antes era un hueco DEAD que hacía flapping).
    const loThresh = prev === "ALIVE" ? RSI_LO - RSI_EXIT : RSI_LO;
    if (x.rsi >= loThresh) return "ALIVE";
    return "DEAD"; // trending pero RSI muy bajo = no es continuación clara
}

let lastState = null;      // estado CONFIRMADO (base de las transiciones)
let candidate = null;      // estado candidato en observación
let candidateCount = 0;    // lecturas consecutivas del candidato
const lastAlertTs = {};    // ts del último aviso, por tipo (cooldown anti-repetición)

// ¿ya se avisó este TIPO dentro del cooldown? (true = hay que callarse)
// Si nunca se avisó (sin marca) NO está en cooldown — el primer aviso siempre pasa.
function enCooldown(type, now) {
    const last = lastAlertTs[type];
    if (!last) return false;
    return now - last < COOLDOWN_MS;
}

// Núcleo PURO y testeable: aplica histéresis + confirmación + cooldown y devuelve
// la lista de avisos que DEBEN mandarse ahora (vacía si no toca). No hace I/O:
// muta el estado del módulo (lastState/candidate/lastAlertTs) y retorna intents.
// `now` se inyecta para poder simular el paso del tiempo en las pruebas.
function decide(x, enPosicion, now = Date.now()) {
    const estado = estadoTendencia(x, lastState);
    const info = `ER=${x.er.toFixed(2)} RSI=${x.rsi.toFixed(0)} p=${x.p} ${enPosicion ? "DENTRO" : "flat"}`;

    // CONFIRMACIÓN: el estado debe sostenerse CONFIRM_N lecturas seguidas antes de
    // considerarlo un cambio real (filtra el ruido de una sola lectura en el borde).
    if (estado === candidate) candidateCount++;
    else { candidate = estado; candidateCount = 1; }
    if (candidateCount < CONFIRM_N) {
        return { estado, alerts: [], log: `${estado} (confirmando ${candidateCount}/${CONFIRM_N}) ${info}` };
    }

    // Solo en TRANSICIÓN de estado confirmado (no spamear).
    if (estado === lastState) return { estado, alerts: [], log: `${estado} (sin cambio) ${info}` };
    const prev = lastState;
    lastState = estado;

    // Candidatos a aviso según posición/estado.
    const intents = [];
    if (enPosicion) {
        if (estado === "ALIVE")
            intents.push({ type: "aguanta", title: "🟢 Continuación · aguanta el long", msg: `ETH sigue en tendencia (ER ${x.er.toFixed(2)}, RSI ${x.rsi.toFixed(0)} — no sobrecomprado). No cortes la ganancia temprano. Sal cuando RSI toque 75-80.`, sound: "Glass" });
        else if (estado === "OB")
            intents.push({ type: "toma-ganancia", title: "🎯 Sobrecompra · toma ganancia", msg: `ETH RSI ${x.rsi.toFixed(0)} (sobrecompra). Regla de oro #3: TOMA LA GANANCIA acá, no le pidas más al trade. Confirma VWAP.`, sound: "Hero" });
        else if (estado === "DEAD" && (prev === "ALIVE" || prev === "OB"))
            intents.push({ type: "apagada", title: "⚠️ Tendencia apagada", msg: `El envión de ETH que te llevaba se acabó (ER ${x.er.toFixed(2)}, choppy). Si estás en verde, evalúa cerrar — no lo devuelvas.`, sound: "Basso" });
    } else if (estado === "ALIVE") {
        // FLAT: solo el heads-up de "prepárate" al entrar en ALIVE. OB/DEAD flat → silencio (anti-FOMO).
        intents.push({ type: "preparate", title: "📈 Tendencia viva · prepárate (NO es entrada)", msg: `ETH en tendencia limpia arriba, pero SIN pullback (precio estirado sobre el EMA9). NO es entrada — espera el pullback al EMA9 para la A+. Prepárate, NO persigas el envión.`, sound: "Purr" });
    }

    // COOLDOWN por tipo: descarta el aviso si el mismo tipo se mandó hace poco.
    const alerts = [];
    for (const it of intents) {
        if (enCooldown(it.type, now)) { it.suppressed = true; continue; }
        lastAlertTs[it.type] = now;
        alerts.push(it);
    }
    return { estado, alerts, log: `>>> transición ${prev}→${estado} ${info}`, suppressed: intents.filter(i => i.suppressed).map(i => i.type) };
}

// Reinicia el estado (para pruebas).
function _reset() { lastState = null; candidate = null; candidateCount = 0; for (const k of Object.keys(lastAlertTs)) delete lastAlertTs[k]; }

async function tick() {
    const x = leerIndicadores();
    if (!x.p) { console.log(`${ts()} sin datos`); return; }

    // ¿está dentro? En spot = tener saldo de BASE sobre el mínimo vendible.
    let enPosicion = false;
    try {
        const rules = await bn.getSymbolRules(SYMBOL);
        const bal   = (await bn.getBalances()).find(b => b.asset === BASE);
        const qty   = bal ? Number(bal.free) + Number(bal.locked || 0) : 0;
        enPosicion  = qty >= Number(rules.minQty || rules.stepSize || 0);
    } catch (e) { /* si la API falla, seguimos con enPosicion=false */ }

    const { alerts, log, suppressed } = decide(x, enPosicion);
    console.log(`${ts()} ${log}`);
    if (suppressed && suppressed.length) console.log(`${ts()}   (cooldown, no reenvío: ${suppressed.join(", ")})`);
    for (const a of alerts) notify(a.title, a.msg, a.sound);
}

module.exports = { estadoTendencia, decide, _reset,
    constants: { ER_MIN, ER_EXIT, RSI_LO, RSI_HI, RSI_OB, RSI_EXIT, CONFIRM_N, COOLDOWN_MS } };

if (require.main === module) {
    (async () => {
        console.log(`${ts()} monitor de continuación activo — ${SYMBOL}, ER≥${ER_MIN} (salida ${ (ER_MIN - ER_EXIT).toFixed(2) }), RSI viva ${RSI_LO}-${RSI_HI}, sobrecompra ≥${RSI_OB}, confirmación ${CONFIRM_N} lecturas, cooldown ${COOLDOWN_MS / 60000}min, cada ${INTERVAL / 1000}s`);
        for (;;) {
            try { await tick(); }
            catch (e) { console.log(`${ts()} err: ${e.message}`); }
            await new Promise(r => setTimeout(r, INTERVAL));
        }
    })();
}
