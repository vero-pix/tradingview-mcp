#!/usr/bin/env node
// =============================================================================
// capital_breakeven.cjs — Guardián de salidas: breakeven + TRAILING por escalones
//
// El "stop móvil" de Vero. Vigila las posiciones LONG y va subiendo el stop a
// medida que el trade gana, por escalones de R (R = riesgo inicial de la posición):
//
//   +1R de ganancia → stop a la ENTRADA   (breakeven: ya no puede perder)
//   +2R            → stop asegura +1R    (ya ganaste, pase lo que pase)
//   +3R            → stop asegura +2R    ... la escalera sigue
//
// ⚠️ SOLO mueve el stop HACIA ARRIBA, nunca hacia abajo. NUNCA abre ni cierra.
//    No te saca del trade: la salida en sobrecompra sigue siendo de Vero.
//    Complementa al stopguard (que pone el stop inicial a posiciones naked).
//
// El riesgo inicial (R) se memoriza por posición en ~/Trading/.riesgo_inicial.json
// la primera vez que se ve la posición (cuando el stop aún está bajo la entrada),
// porque al subir el stop se pierde la referencia del riesgo original.
//
// Uso:
//   node scripts/capital_breakeven.cjs            # DRY-RUN: solo dice qué haría
//   node scripts/capital_breakeven.cjs --live     # mueve los stops de verdad
//
// Env: INTERVAL (seg, default 20), BREAKEVEN_AT_R (default 1.0),
//      LOCK_USD (default 0 = escalón puro; >0 asegura ese extra por escalón),
//      ACCOUNT ("USD 2"), EPIC (vacío = TODOS los instrumentos), DEMO=1.
// =============================================================================

const fs = require("fs");
const { execFileSync } = require("child_process");
const path = require("path");
const capital = require("./capital_client.cjs");

const HOME = process.env.HOME;
const DIR  = path.join(HOME, "Trading", "tradingview-mcp");
const STATE_FILE = path.join(HOME, "Trading", ".riesgo_inicial.json");

const argv    = process.argv.slice(2);
const live    = argv.includes("--live");
const demo    = argv.includes("--demo");
const ACCOUNT = process.env.ACCOUNT || "USD 2";
const EPIC    = process.env.EPIC || "";              // vacío = todos
const INTERVAL = (process.env.INTERVAL ? Number(process.env.INTERVAL) : 20) * 1000;
const AT_R     = process.env.BREAKEVEN_AT_R != null ? Number(process.env.BREAKEVEN_AT_R) : 1.0;
const LOCK_USD = process.env.LOCK_USD != null ? Number(process.env.LOCK_USD) : 0;

function ts() { return new Date().toISOString().slice(11, 19); }
function notify(title, msg, sound) {
    try { execFileSync("bash", [path.join(DIR, "scripts", "notify.sh"), title, msg, sound], { stdio: "ignore" }); }
    catch (e) {}
}
function loadState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch (e) { return {}; } }
function saveState(s) { try { fs.writeFileSync(STATE_FILE, JSON.stringify(s)); } catch (e) {} }

async function tick() {
    const all = await capital.getPositions({ demo });
    const positions = all.filter(p => p.direction === "BUY" && (!EPIC || p.epic === EPIC));
    const state = loadState();

    // limpia el riesgo memorizado de posiciones ya cerradas
    for (const id of Object.keys(state)) {
        if (!all.find(p => p.dealId === id)) delete state[id];
    }

    if (!positions.length) { console.log(`${ts()} sin posiciones`); saveState(state); return; }

    for (const p of positions) {
        const { dealId, epic, openLevel, stopLevel, bid } = p;
        if (stopLevel == null) { console.log(`${ts()} ${epic} ${dealId.slice(-8)} sin stop (eso lo cubre el stopguard) — espero`); continue; }

        // memoriza el riesgo inicial la primera vez (stop todavía bajo la entrada)
        if (!state[dealId] && stopLevel < openLevel) state[dealId] = +(openLevel - stopLevel).toFixed(2);
        const risk = state[dealId];
        if (!risk) { console.log(`${ts()} ${epic} ${dealId.slice(-8)} riesgo inicial desconocido (nació con stop sobre la entrada) — no traileo`); continue; }

        const gananciaR = (bid - openLevel) / risk;
        const escalones = Math.floor(gananciaR);          // +1R→asegura 0R, +2R→+1R, ...
        if (escalones < AT_R) {
            const falta = (openLevel + risk * AT_R - bid).toFixed(2);
            console.log(`${ts()} ${epic} ${dealId.slice(-8)} bid ${bid}, faltan $${falta} para +${AT_R}R (entrada ${openLevel}, R=$${risk})`);
            continue;
        }

        const nuevoStop = +(openLevel + (escalones - 1) * risk + LOCK_USD).toFixed(2);
        if (nuevoStop <= stopLevel) { console.log(`${ts()} ${epic} ${dealId.slice(-8)} escalón +${escalones}R ya asegurado (stop ${stopLevel})`); continue; }

        const aseguradoR = escalones - 1;
        console.log(`${ts()} ${epic} ${dealId.slice(-8)} +${escalones}R alcanzado (bid ${bid}) → stop ${stopLevel} → ${nuevoStop} (asegura ${aseguradoR > 0 ? "+" + aseguradoR + "R" : "breakeven"})`);
        if (!live) { console.log(`${ts()}   [DRY-RUN] no se movió (agrega --live)`); continue; }
        try {
            const r = await capital.updatePosition(dealId, { stopLevel: nuevoStop, demo });
            if (r.ok) {
                console.log(`${ts()}   ✅ stop subido a ${nuevoStop}`);
                notify(aseguradoR > 0 ? "📈 Ganancia asegurada" : "🛡️ Stop a breakeven",
                    aseguradoR > 0
                        ? `${epic}: el trade llegó a +${escalones}R → stop subido a ${nuevoStop}. Ya tienes +${aseguradoR}R asegurado pase lo que pase. La salida en sobrecompra sigue siendo tuya.`
                        : `${epic}: stop movido a tu entrada (${nuevoStop}). Este trade ya no puede perder.`,
                    "Hero");
            } else {
                console.log(`${ts()}   ${r.dealStatus}: ${r.reason || ""}`);
            }
        } catch (e) { console.log(`${ts()}   error: ${e.message}`); }
        await capital.sleep(200);
    }
    saveState(state);
}

(async () => {
    try { await capital.selectAccount(ACCOUNT, { demo }); }
    catch (e) { console.error("no pude seleccionar cuenta:", e.message); process.exit(1); }
    console.log(`${ts()} guardián de salidas arrancado: cuenta='${ACCOUNT}' epic=${EPIC || "TODOS"} escalón +${AT_R}R lock $${LOCK_USD} `
        + `interval=${INTERVAL / 1000}s modo=${live ? "LIVE (mueve stops)" : "DRY-RUN"}`);
    while (true) {
        try { await tick(); } catch (e) { console.log(`${ts()} error tick: ${e.message}`); }
        await capital.sleep(INTERVAL);
    }
})();
