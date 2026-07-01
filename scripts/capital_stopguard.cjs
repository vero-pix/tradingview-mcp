#!/usr/bin/env node
// =============================================================================
// capital_stopguard.cjs — Guardián de STOP: detecta posiciones sin stop y protege
//
// Vigila tus posiciones abiertas. Si encuentra un LONG SIN stopLevel (desnudo,
// como cuando abres a mano en la app), te avisa fuerte y —en modo --live— le pone
// un stop protector automáticamente. Ataca directo tu mayor riesgo: quedar sin stop.
//
// ⚠️ Poner un stop SOLO reduce riesgo (nunca lo sube), así que en --live lo hace
//    sin pedir CONFIRMO. Sin --live = solo alerta (tú lo pones).
//
// Uso:
//   node scripts/capital_stopguard.cjs            # solo alerta si hay algo desnudo
//   node scripts/capital_stopguard.cjs --live &   # protege automáticamente
//
// Env: STOPGUARD_PCT (% bajo la entrada, default 0.6), STOPGUARD_USD (override en $),
//      INTERVAL (seg, default 15), ACCOUNT ("USD 2"), EPIC (default: TODOS), DEMO=1.
// =============================================================================

const { execFileSync } = require("child_process");
const path = require("path");
const capital = require("./capital_client.cjs");

const HOME = process.env.HOME;
const DIR  = path.join(HOME, "Trading", "tradingview-mcp");

const argv = process.argv.slice(2);
const live = argv.includes("--live");
const demo = argv.includes("--demo");
const ACCOUNT  = process.env.ACCOUNT || "USD 2";
const EPIC     = process.env.EPIC || null;                       // null = todas las posiciones
const INTERVAL = (process.env.INTERVAL ? Number(process.env.INTERVAL) : 15) * 1000;
const PCT      = process.env.STOPGUARD_PCT != null ? Number(process.env.STOPGUARD_PCT) : 0.6;
const USD      = process.env.STOPGUARD_USD != null ? Number(process.env.STOPGUARD_USD) : null;

function ts() { return new Date().toISOString().slice(11, 19); }
function notify(title, msg, sound) {
    try { execFileSync("bash", [path.join(DIR, "scripts", "notify.sh"), title, msg, sound], { stdio: "ignore" }); }
    catch (e) {}
}

// dealIds ya avisados en modo alerta (para no spamear cada vuelta)
const avisados = new Set();

async function tick() {
    const positions = await capital.getPositions({ demo, epic: EPIC });
    const longs = positions.filter(p => p.direction === "BUY");
    const naked = longs.filter(p => p.stopLevel == null);

    // limpiar avisados que ya no existen o ya tienen stop
    for (const id of Array.from(avisados)) {
        if (!naked.find(p => p.dealId === id)) avisados.delete(id);
    }

    if (!longs.length) { console.log(`${ts()} sin posiciones`); return; }
    if (!naked.length) { console.log(`${ts()} ✅ ${longs.length} posición(es), todas con stop`); return; }

    for (const p of naked) {
        // Stop protector: por debajo del precio actual (min entre entrada y bid) menos la distancia.
        const dist = USD != null ? USD : +(p.openLevel * PCT / 100).toFixed(2);
        const ref  = Math.min(p.openLevel, p.bid);
        const stop = +(ref - dist).toFixed(2);
        const riesgo = ((p.openLevel - stop) * p.size * p.contractSize).toFixed(2);

        if (!live) {
            if (!avisados.has(p.dealId)) {
                console.log(`${ts()} 🔴 SIN STOP: ${p.dealId} entrada ${p.openLevel} size ${p.size} → sugerido stop ${stop}`);
                notify("🔴 Posición SIN STOP", `${p.epic} entrada ${p.openLevel}, size ${p.size}. Ponle un stop (sugerido ${stop}, riesgo ~$${riesgo}) o corre el guardián con --live.`, "Basso");
                avisados.add(p.dealId);
            } else {
                console.log(`${ts()} sin stop ${p.dealId} (ya avisado)`);
            }
        } else {
            console.log(`${ts()} 🔴 SIN STOP: ${p.dealId} → poniendo stop protector ${stop}`);
            try {
                const r = await capital.updatePosition(p.dealId, { stopLevel: stop, demo });
                if (r.ok) {
                    console.log(`${ts()}   ✅ stop puesto en ${stop} (riesgo ~$${riesgo})`);
                    notify("🛡️ Stop protector puesto", `${p.epic} ${p.dealId}: stop automático en ${stop} (entrada ${p.openLevel}, riesgo ~$${riesgo}).`, "Glass");
                } else {
                    console.log(`${ts()}   ${r.dealStatus}: ${r.reason || ""}`);
                    notify("⚠️ No pude poner el stop", `${p.epic} ${p.dealId}: ${r.reason || r.dealStatus}. Ponlo a mano.`, "Basso");
                }
            } catch (e) { console.log(`${ts()}   error: ${e.message}`); }
            await capital.sleep(250);
        }
    }
}

(async () => {
    try { await capital.selectAccount(ACCOUNT, { demo }); }
    catch (e) { console.error("no pude seleccionar cuenta:", e.message); process.exit(1); }
    console.log(`${ts()} guardián de STOP arrancado: cuenta='${ACCOUNT}' epic=${EPIC || "TODAS"} `
        + `stop=${USD != null ? "$" + USD : PCT + "%"} interval=${INTERVAL / 1000}s `
        + `modo=${live ? "LIVE (pone stop solo)" : "ALERTA (solo avisa)"}`);
    while (true) {
        try { await tick(); } catch (e) { console.log(`${ts()} error tick: ${e.message}`); }
        await capital.sleep(INTERVAL);
    }
})();
