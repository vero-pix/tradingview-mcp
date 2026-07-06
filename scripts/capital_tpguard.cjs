#!/usr/bin/env node
// =============================================================================
// capital_tpguard.cjs — Guardián de TAKE-PROFIT: le pone TP a posiciones que no tienen
//
// El gemelo del stopguard, pero para la ganancia. Vigila tus longs y, si alguno tiene
// stop pero NO tiene take-profit (típico cuando abres a mano en la app), le pone un TP
// en el bróker = entrada + 2×ATR (con piso de $5, que cubre el spread). Como es un
// bracket del bróker, se ejecuta aunque el Mac esté dormido.
//
// Simétrico al stopguard: en --live lo pone solo (agregar un TP no añade riesgo a la baja).
// Manda stop+TP juntos para no desarmar el bracket (updatePosition ya preserva el nivel
// que no viene, pero acá lo mandamos explícito por seguridad).
//
// NO abre ni promedia. Solo le agrega TP a lo que ya está abierto y protegido con stop.
//
// Uso:
//   node scripts/capital_tpguard.cjs             # dry-run: dice qué TP pondría
//   node scripts/capital_tpguard.cjs --live &    # pone el TP de verdad
//
// Env: TP_ATR (×ATR, default 2), TP_USD_MIN (piso $, default 5), INTERVAL (seg, default 15),
//      ACCOUNT ("USD 2"), EPIC (default: TODAS), DEMO=1.
// =============================================================================

const { execFileSync } = require("child_process");
const path = require("path");
const capital = require("./capital_client.cjs");

const HOME = process.env.HOME;
const DIR  = path.join(HOME, "Trading", "tradingview-mcp");
const NODE = process.execPath;

const argv = process.argv.slice(2);
const live = argv.includes("--live");
const demo = argv.includes("--demo");
const ACCOUNT  = process.env.ACCOUNT || "USD 2";
const EPIC     = process.env.EPIC || null;
const INTERVAL = (process.env.INTERVAL ? Number(process.env.INTERVAL) : 15) * 1000;
const TP_ATR     = process.env.TP_ATR != null ? Number(process.env.TP_ATR) : 2;
const TP_USD_MIN = process.env.TP_USD_MIN != null ? Number(process.env.TP_USD_MIN) : 5;

function ts() { return new Date().toISOString().slice(11, 19); }
function notify(title, msg, sound) {
    try { execFileSync("bash", [path.join(DIR, "scripts", "notify.sh"), title, msg, sound], { stdio: "ignore" }); }
    catch (e) {}
}

// ATR(14) 1m del símbolo Binance del epic (ETHUSD→ETHUSDT, BTCUSD→BTCUSDT)
function atrDe(epic) {
    const symbol = epic.replace(/USD$/, "USDT");
    const out = execFileSync("bash", ["-lc",
        `BINANCE_SYMBOL="${symbol}" BINANCE_INTERVAL=1m BINANCE_LIMIT=100 "${NODE}" scripts/ohlcv_binance.js | "${NODE}" scripts/calc_indicators.js`],
        { cwd: DIR, encoding: "utf8" }).trim().split("\n").pop();
    return Number(out.split("|")[9]); // atr = campo 10
}

// dealIds ya avisados en dry-run (para no spamear)
const avisados = new Set();

async function tick() {
    await capital.selectAccount(ACCOUNT, { demo });
    const positions = await capital.getPositions({ demo, epic: EPIC });
    const longs = positions.filter(p => p.direction === "BUY");
    if (!longs.length) { console.log(`${ts()} sin longs`); avisados.clear(); return; }

    // objetivo: longs CON stop pero SIN take-profit
    const sinTP = longs.filter(p => p.stopLevel != null && p.limitLevel == null);
    const naked = longs.filter(p => p.stopLevel == null);
    if (naked.length) console.log(`${ts()} ${naked.length} long(s) sin stop → los deja al stopguard (primero el stop)`);
    if (!sinTP.length) { console.log(`${ts()} ✅ ${longs.length} long(s), todas con TP (o sin stop aún)`); return; }

    for (const p of sinTP) {
        const atr = atrDe(p.epic);
        const dist = Math.max(TP_USD_MIN, TP_ATR * atr);
        const tp = Number((p.openLevel + dist).toFixed(2));
        const offer = p.offer != null ? Number(p.offer) : null;

        // el TP de un long debe ir POR ENCIMA del precio actual
        if (offer != null && tp <= offer) {
            const key = "pasado:" + p.dealId;
            if (!avisados.has(key)) {
                avisados.add(key);
                notify("🎯 Target ya alcanzado", `${p.epic}: el TP calculado ($${tp}) ya quedó bajo el precio ($${offer}). El trade ya está en/ sobre tu objetivo — considera cerrar a mano.`, "Hero");
            }
            console.log(`${ts()} ${p.epic}: tp $${tp} <= precio $${offer} (ya pasó el target, no seteo)`);
            continue;
        }

        if (!live) {
            const key = "dry:" + p.dealId;
            if (!avisados.has(key)) {
                avisados.add(key);
                notify("🎯 Falta TP (dry-run)", `${p.epic} entrada ${p.openLevel} sin take-profit. Pondría TP en $${tp} (entrada + máx($${TP_USD_MIN}, ${TP_ATR}×ATR ${atr.toFixed(2)})). Corre con --live para setearlo.`, "Glass");
            }
            console.log(`${ts()} ${p.epic}: pondría TP $${tp} (dist $${dist.toFixed(2)}, atr ${atr.toFixed(2)}) — dry-run`);
            continue;
        }

        try {
            // manda stop+TP juntos (no desarmar el bracket)
            const r = await capital.updatePosition(p.dealId, { stopLevel: p.stopLevel, profitLevel: tp, demo });
            if (r.ok) {
                console.log(`${ts()} ✅ TP puesto en $${tp} (${p.epic}, entrada ${p.openLevel}, atr ${atr.toFixed(2)})`);
                notify("🎯 Take-profit puesto", `${p.epic}: TP automático en $${tp} (entrada ${p.openLevel}, +$${dist.toFixed(2)}). Stop preservado en ${p.stopLevel}. Se cierra solo al llegar, aunque duermas.`, "Glass");
            } else {
                console.log(`${ts()} ⚠️ no aceptado (${r.dealStatus} ${r.reason || ""}) ${p.epic}`);
            }
        } catch (e) {
            console.log(`${ts()} err seteando TP ${p.epic}: ${e.message}`);
        }
    }
}

(async () => {
    console.log(`${ts()} TP-guard ${live ? "LIVE" : "dry-run"} — cuenta ${ACCOUNT}, TP = entrada + máx($${TP_USD_MIN}, ${TP_ATR}×ATR), cada ${INTERVAL / 1000}s`);
    for (;;) {
        try { await tick(); }
        catch (e) { console.log(`${ts()} err: ${e.message}`); }
        await new Promise(r => setTimeout(r, INTERVAL));
    }
})();
