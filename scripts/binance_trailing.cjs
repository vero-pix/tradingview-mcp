#!/usr/bin/env node
// =============================================================================
// binance_trailing.cjs — Stop dinámico (trailing) para posiciones Binance SPOT.
//
// Gemelo de capital_breakeven.cjs, adaptado a Binance. Vigila la posición LONG con
// bracket OCO y va SUBIENDO el stop a medida que el trade gana, por escalones de R
// (R = riesgo inicial = entrada − stop inicial):
//
//   +1R de ganancia → stop a la ENTRADA   (breakeven: ya no puede perder)
//   +2R            → stop asegura +1R
//   +3R            → stop asegura +2R ...
//
// Como Binance spot no deja "mover" el stop de un OCO, lo hace CANCELANDO el OCO y
// re-poniéndolo con el stop más alto (mismo TP, misma cantidad). Ventana sin protección
// de ~200ms entre cancelar y re-poner (aceptable).
//
// ⚠️ SOLO sube el stop, NUNCA lo baja. NUNCA abre ni cierra. Solo aprieta el riesgo.
//    Complementa al binance_guard (que pone el OCO inicial a posiciones desnudas).
//
// Uso:  node scripts/binance_trailing.cjs [--live]
// Env: INTERVAL (seg, def 20), BREAKEVEN_AT_R (def 1.0), LOCK_USD (def 0), SYMBOL (def ETHUSDT).
// =============================================================================

const fs   = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const bn   = require("./binance_client.cjs");

const HOME  = process.env.HOME;
const DIR   = path.join(HOME, "Trading", "tradingview-mcp");
const STATE = path.join(HOME, "Trading", ".binance_riesgo.json");

const argv = process.argv.slice(2);
const live = argv.includes("--live");
function flag(n, d) { const i = argv.indexOf(n); return i !== -1 ? argv[i + 1] : d; }
const SYMBOL   = flag("--symbol", process.env.SYMBOL || "ETHUSDT");
const INTERVAL = (process.env.INTERVAL ? Number(process.env.INTERVAL) : 20) * 1000;
const AT_R     = process.env.BREAKEVEN_AT_R != null ? Number(process.env.BREAKEVEN_AT_R) : 1.0;
const LOCK_USD = process.env.LOCK_USD != null ? Number(process.env.LOCK_USD) : 0;

function ts() { return new Date().toISOString().slice(11, 19); }
function notify(t, m, s) { try { execFileSync("bash", [path.join(DIR, "scripts", "notify.sh"), t, m, s], { stdio: "ignore" }); } catch (e) {} }
function loadState() { try { return JSON.parse(fs.readFileSync(STATE, "utf8")); } catch (e) { return {}; } }
function saveState(s) { try { fs.writeFileSync(STATE, JSON.stringify(s)); } catch (e) {} }

async function estimarEntrada(qty) {
    const tr = await bn.getMyTrades(SYMBOL, 50);
    let acc = 0, cost = 0;
    for (let i = tr.length - 1; i >= 0 && acc < qty; i--) {
        if (!tr[i].isBuyer) continue;
        const take = Math.min(Number(tr[i].qty), qty - acc);
        acc += take; cost += take * Number(tr[i].price);
    }
    return acc > 0 ? cost / acc : null;
}

async function tick() {
    const rules = await bn.getSymbolRules(SYMBOL);
    const open  = await bn.getOpenOrders(SYMBOL);
    const sells = (open || []).filter(o => o.side === "SELL");
    const stopO = sells.find(o => /STOP/.test(o.type));
    const tpO   = sells.find(o => /LIMIT/.test(o.type) && !/STOP/.test(o.type));

    // necesita un OCO completo (stop + TP) para trailear
    if (!stopO || !tpO) { console.log(`${ts()} sin OCO completo que trailear (lo inicial lo pone el guard)`); return; }

    const qty      = Number(stopO.origQty);
    const currStop = Number(stopO.stopPrice || stopO.price);
    const tp       = Number(tpO.price);
    const price    = await bn.getPrice(SYMBOL);
    const entry    = await estimarEntrada(qty);
    if (!entry) { console.log(`${ts()} no pude estimar entrada — espero`); return; }

    const state = loadState();
    const key = String(Math.round(entry));
    // memoriza R la primera vez que se ve el OCO con el stop bajo la entrada
    if (!state[key] && currStop < entry) { state[key] = +(entry - currStop).toFixed(2); saveState(state); }
    const R = state[key];
    if (!R) { console.log(`${ts()} R inicial desconocido (stop nació sobre la entrada) — no traileo`); return; }

    const gananciaR = (price - entry) / R;
    const escalones = Math.floor(gananciaR);
    if (escalones < AT_R) {
        console.log(`${ts()} precio ${price.toFixed(2)}, faltan $${(entry + R * AT_R - price).toFixed(2)} para +${AT_R}R (entrada ${entry.toFixed(2)}, R=$${R})`);
        return;
    }

    const nuevoStop = +(entry + (escalones - 1) * R + LOCK_USD).toFixed(2);
    if (nuevoStop <= currStop) { console.log(`${ts()} +${escalones}R ya asegurado (stop ${currStop})`); return; }
    if (nuevoStop >= price)    { console.log(`${ts()} nuevo stop ${nuevoStop} >= precio ${price.toFixed(2)} — no válido, espero`); return; }

    const aseguradoR = escalones - 1;
    console.log(`${ts()} +${escalones}R (precio ${price.toFixed(2)}) → subir stop ${currStop} → ${nuevoStop} (asegura ${aseguradoR > 0 ? "+" + aseguradoR + "R" : "breakeven"})`);
    if (!live) { console.log(`${ts()}   [DRY-RUN] no se movió (agrega --live)`); return; }

    try {
        // 1) cancela el OCO viejo (cancelar una pata cancela la lista completa)
        await bn.cancelOrder(SYMBOL, stopO.orderId);
        // 2) re-lee el ETH libre y re-pone el OCO con el stop más alto (mismo TP)
        const bal = (await bn.getBalances()).find(b => b.asset === SYMBOL.replace(/USDT$/, ""));
        const q = bn.roundStep(bal ? Number(bal.free) : qty, rules.stepSize);
        const oco = await bn.placeOcoSell(SYMBOL, q, { tp, stop: nuevoStop });
        console.log(`${ts()}   ✅ stop subido a ${nuevoStop} (nuevo listId ${oco.orderListId})`);
        notify(aseguradoR > 0 ? "📈 Ganancia asegurada (Binance)" : "🛡️ Stop a breakeven (Binance)",
            aseguradoR > 0
                ? `${SYMBOL}: +${escalones}R → stop subido a $${nuevoStop}. Tienes +${aseguradoR}R asegurado pase lo que pase. TP sigue en $${tp}.`
                : `${SYMBOL}: stop movido a tu entrada ($${nuevoStop}). Este trade ya no puede perder.`,
            "Hero");
    } catch (e) {
        console.log(`${ts()}   error moviendo stop: ${e.message}`);
        notify("⚠️ Binance: trailing falló", `${SYMBOL}: no pude subir el stop (${e.message}). El OCO viejo pudo quedar cancelado — revisa que la posición tenga bracket.`, "Basso");
    }
}

(async () => {
    console.log(`${ts()} Binance-trailing ${live ? "LIVE (mueve stops)" : "dry-run"} — ${SYMBOL}, breakeven +${AT_R}R, lock $${LOCK_USD}, cada ${INTERVAL / 1000}s`);
    for (;;) {
        try { await tick(); }
        catch (e) { console.log(`${ts()} err: ${e.message}`); }
        await new Promise(r => setTimeout(r, INTERVAL));
    }
})();
