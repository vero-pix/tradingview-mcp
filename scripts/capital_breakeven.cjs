#!/usr/bin/env node
// =============================================================================
// capital_breakeven.cjs — Mueve el stop a BREAKEVEN cuando el trade va en verde
//
// Cuando una posición LONG llega a +N×R de ganancia (por defecto +1R = ganancia
// igual al riesgo inicial), sube el stop al precio de entrada. Desde ahí, ese
// trade YA NO PUEDE PERDER. Encaja con tu miedo al stop: no te saca temprano,
// solo te protege una vez que ya vas ganando.
//
// ⚠️ SOLO mueve el stop HACIA ARRIBA, nunca hacia abajo. Nunca abre ni cierra.
//    Por eso es una acción segura y no pide CONFIRMO en cada movida.
//
// Uso:
//   node scripts/capital_breakeven.cjs            # DRY-RUN: solo dice qué haría
//   node scripts/capital_breakeven.cjs --live     # mueve los stops de verdad
//
// Env: INTERVAL (seg, default 20), BREAKEVEN_AT_R (default 1.0),
//      LOCK_USD (default 0 = breakeven puro; >0 asegura una ganancia mínima),
//      ACCOUNT ("USD 2"), EPIC (ETHUSD), DEMO=1.
// =============================================================================

const { execFileSync } = require("child_process");
const path = require("path");
const capital = require("./capital_client.cjs");

const HOME = process.env.HOME;
const DIR  = path.join(HOME, "Trading", "tradingview-mcp");

const argv    = process.argv.slice(2);
const live    = argv.includes("--live");
const demo    = argv.includes("--demo");
const ACCOUNT = process.env.ACCOUNT || "USD 2";
const EPIC    = process.env.EPIC || "ETHUSD";
const INTERVAL = (process.env.INTERVAL ? Number(process.env.INTERVAL) : 20) * 1000;
const AT_R     = process.env.BREAKEVEN_AT_R != null ? Number(process.env.BREAKEVEN_AT_R) : 1.0;
const LOCK_USD = process.env.LOCK_USD != null ? Number(process.env.LOCK_USD) : 0;

function ts() { return new Date().toISOString().slice(11, 19); }
function fmt(n) { return (n >= 0 ? "+" : "") + Number(n).toFixed(2); }
function notify(title, msg, sound) {
    try { execFileSync("bash", [path.join(DIR, "scripts", "notify.sh"), title, msg, sound], { stdio: "ignore" }); }
    catch (e) {}
}

async function tick() {
    const positions = await capital.getPositions({ demo, epic: EPIC });
    if (!positions.length) { console.log(`${ts()} sin posiciones`); return; }

    for (const p of positions) {
        if (p.direction !== "BUY") continue;                 // solo LONG
        const { dealId, openLevel, stopLevel, bid } = p;
        if (stopLevel == null) { console.log(`${ts()} ${dealId} SIN STOP — no puedo calcular R (revisa)`); continue; }
        if (stopLevel >= openLevel) { console.log(`${ts()} ${dealId} ya en breakeven+ (stop ${stopLevel} ≥ entrada ${openLevel})`); continue; }

        const risk    = openLevel - stopLevel;               // riesgo inicial en precio
        const trigger = openLevel + risk * AT_R;             // +N×R sobre el bid
        const nuevoStop = +(openLevel + LOCK_USD).toFixed(2); // breakeven (o + lock)

        if (bid >= trigger) {
            if (nuevoStop <= stopLevel) { console.log(`${ts()} ${dealId} trigger ok pero nuevo stop no sube — skip`); continue; }
            console.log(`${ts()} ${dealId} +${AT_R}R alcanzado (bid ${bid} ≥ ${trigger.toFixed(2)}) → stop ${stopLevel} → ${nuevoStop}`);
            if (!live) { console.log(`${ts()}   [DRY-RUN] no se movió (agrega --live)`); continue; }
            try {
                const r = await capital.updatePosition(dealId, { stopLevel: nuevoStop, demo });
                if (r.ok) {
                    console.log(`${ts()}   ✅ stop movido a breakeven ${nuevoStop}`);
                    notify("🛡️ Stop a breakeven", `ETH ${dealId}: stop movido a ${nuevoStop} (entrada ${openLevel}). Este trade ya no puede perder.`, "Hero");
                } else {
                    console.log(`${ts()}   ${r.dealStatus}: ${r.reason || ""}`);
                }
            } catch (e) { console.log(`${ts()}   error: ${e.message}`); }
            await capital.sleep(200);
        } else {
            const falta = (trigger - bid).toFixed(2);
            console.log(`${ts()} ${dealId} bid ${bid}, faltan $${falta} para +${AT_R}R (entrada ${openLevel}, stop ${stopLevel})`);
        }
    }
}

(async () => {
    try { await capital.selectAccount(ACCOUNT, { demo }); }
    catch (e) { console.error("no pude seleccionar cuenta:", e.message); process.exit(1); }
    console.log(`${ts()} watcher BREAKEVEN arrancado: cuenta='${ACCOUNT}' epic=${EPIC} +${AT_R}R lock $${LOCK_USD} `
        + `interval=${INTERVAL / 1000}s modo=${live ? "LIVE (mueve stops)" : "DRY-RUN"}`);
    // loop
    while (true) {
        try { await tick(); } catch (e) { console.log(`${ts()} error tick: ${e.message}`); }
        await capital.sleep(INTERVAL);
    }
})();
