#!/usr/bin/env node
// =============================================================================
// binance_guard.cjs — Guardián de posiciones Binance SPOT sin protección.
//
// Guardián de stop y take-profit en uno. Binance spot no
// tiene "posiciones": tener ETH libre SIN una orden OCO de venta = posición desnuda
// (comprada a mano en la app, sin stop ni take-profit). Este guardián la detecta y le
// pone un bracket OCO (stop + TP) en el bróker, que se ejecuta aunque todo esté apagado.
//
// Espeja la matemática del binance_order.cjs buy:
//   stop = entrada − máx(STOP_ATR×ATR, entrada×MIN_STOP_PCT%)
//   tp   = entrada + máx(TP_USD_MIN, TP_ATR×ATR)
// La entrada se estima con el promedio ponderado de las compras recientes que forman
// el ETH que hoy tienes libre.
//
// SOLO LONG. No abre, no promedia, no cierra: solo AGREGA protección a lo que ya existe.
//
// Uso:
//   node scripts/binance_guard.cjs           # dry-run: dice qué OCO pondría
//   node scripts/binance_guard.cjs --live &  # pone el OCO de verdad
//
// Env: STOP_ATR (×ATR, def 2), MIN_STOP_PCT (piso %, def 0.4), TP_ATR (×ATR, def 2),
//      TP_USD_MIN (piso $, def 5), INTERVAL (seg, def 15), SYMBOL (def ETHUSDT).
// =============================================================================

const { execFileSync } = require("child_process");
const fs   = require("fs");
const path = require("path");
const bn   = require("./binance_client.cjs");
const earn = require("./lib/earn_net.cjs");   // red Earn→Spot compartida (lado venta)

const HOME = process.env.HOME;
const DIR  = path.join(HOME, "Trading", "tradingview-mcp");
const NODE = (() => {
    const p = path.join(HOME, ".local/share/fnm/aliases/default/bin/node");
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch (e) { return process.execPath; }
})();
const DIARIO = path.join(HOME, "Trading", "diario_trades_binance.jsonl");

const argv = process.argv.slice(2);
const live = argv.includes("--live");
function flag(name, def = null) { const i = argv.indexOf(name); return i !== -1 ? argv[i + 1] : def; }
const SYMBOL = flag("--symbol", process.env.SYMBOL || "ETHUSDT");
const BASE   = SYMBOL.replace(/USDT$/, "");

const STOP_ATR     = process.env.STOP_ATR     != null ? Number(process.env.STOP_ATR)     : 2;
const MIN_STOP_PCT = process.env.MIN_STOP_PCT != null ? Number(process.env.MIN_STOP_PCT) : 0.4;
const TP_ATR       = process.env.TP_ATR       != null ? Number(process.env.TP_ATR)       : 2;
const TP_USD_MIN   = process.env.TP_USD_MIN   != null ? Number(process.env.TP_USD_MIN)   : 5;
const INTERVAL     = (process.env.INTERVAL ? Number(process.env.INTERVAL) : 15) * 1000;

function ts() { return new Date().toISOString().slice(11, 19); }
function notify(title, msg, sound) {
    try { execFileSync("bash", [path.join(DIR, "scripts", "notify.sh"), title, msg, sound], { stdio: "ignore" }); }
    catch (e) {}
}
function appendTrade(obj) { try { fs.appendFileSync(DIARIO, JSON.stringify(obj) + "\n"); } catch (e) {} }

// ¿Hay ETH escondido en Earn cuando el balance libre no da ni el mínimo? Este tick corre
// cada INTERVAL (15s) y consultar Earn son llamadas sapi FIRMADAS: preguntarlo en cada
// vuelta mientras Vero está flat sería quemar rate limit al pedo. Por eso va con throttle
// (EARN_CHECK_SEC, def 240s). Devuelve true solo si algo se redimió y vale la pena reintentar.
const EARN_CHECK_MS = (process.env.EARN_CHECK_SEC != null ? Number(process.env.EARN_CHECK_SEC) : 240) * 1000;
let ultimoChequeoEarn = 0;
async function rescatarDeEarn(rules) {
    const ahora = Date.now();
    if (ahora - ultimoChequeoEarn < EARN_CHECK_MS) return false;
    ultimoChequeoEarn = ahora;

    const { flexTotal, lockedTotal, err } = await earn.earnTotals(BASE);
    if (err && flexTotal === 0) { console.log(`${ts()} ⚠️ no pude leer Earn ${BASE} (${err})`); return false; }
    if (flexTotal + lockedTotal <= 0) return false;   // de verdad no hay posición

    // Hay ETH en Earn: si es flexible lo redimimos; si está LOCKED, ensureSpotAsset
    // avisa por Telegram (bloqueo real que Vero resuelve a mano en Binance).
    const objetivo = Math.max(flexTotal, rules.minQty);
    console.log(`${ts()} 🛟 ${BASE} fuera de Spot (flex ${flexTotal.toFixed(6)}, locked ${lockedTotal.toFixed(6)}) — posición escondida en Earn, la traigo`);
    if (!live) { console.log(`${ts()}   [dry-run] redimiría ${objetivo.toFixed(6)} ${BASE}`); return false; }
    const r = await earn.ensureSpotAsset(BASE, objetivo);
    if (!r.ok) { console.log(`${ts()}   ⚠ ${r.msg}`); return false; }
    return true;
}

// ATR(14) 1m del símbolo. Devuelve {precio, atr, rsi} o null.
function readIndicators(sym) {
    try {
        const out = execFileSync("bash", ["-c",
            `BINANCE_SYMBOL=${sym} BINANCE_INTERVAL=1m BINANCE_LIMIT=100 "${NODE}" scripts/ohlcv_binance.js | "${NODE}" scripts/calc_indicators.js`],
            { cwd: DIR, encoding: "utf8" }).trim();
        const f = out.split("|").map(Number);
        if (f.length < 10 || f[0] === 0) return null;
        return { precio: f[0], rsi: f[3], atr: f[9] };
    } catch (e) { return null; }
}

// Estima la entrada del ETH que hoy tienes libre: promedio ponderado de las compras
// más recientes hasta cubrir la cantidad (aprox; ignora sells intercalados).
async function estimarEntrada(sellQty) {
    const trades = await bn.getMyTrades(SYMBOL, 50);
    let acc = 0, cost = 0;
    for (let i = trades.length - 1; i >= 0 && acc < sellQty; i--) {
        const t = trades[i];
        if (!t.isBuyer) continue;
        const take = Math.min(Number(t.qty), sellQty - acc);
        acc += take; cost += take * Number(t.price);
    }
    return acc > 0 ? cost / acc : null;
}

// dedupe de avisos en dry-run / casos borde (no spamear)
const avisados = new Set();

async function tick() {
    const rules    = await bn.getSymbolRules(SYMBOL);
    const balances = await bn.getBalances();
    const base     = balances.find(b => b.asset === BASE);
    const freeBase = base ? Number(base.free) : 0;
    let   sellQty  = bn.roundStep(freeBase, rules.stepSize);

    // ¿hay ETH vendible sobre el mínimo del par?
    if (sellQty < rules.minQty) {
        // OJO: "sin ETH libre" NO es lo mismo que "sin posición". Si Binance auto-suscribió
        // el ETH a Simple Earn, la posición SIGUE EXISTIENDO pero desaparece del balance
        // libre — y este guardián la daba por inexistente y se iba, dejándola sin bracket
        // para siempre. Antes de rendirnos, miramos Earn y traemos lo que haya.
        const rescatado = await rescatarDeEarn(rules);
        if (!rescatado) { console.log(`${ts()} sin ${BASE} vendible (libre ${freeBase})`); avisados.clear(); return; }
        const b2 = (await bn.getBalances()).find(b => b.asset === BASE);
        sellQty  = bn.roundStep(b2 ? Number(b2.free) : 0, rules.stepSize);
        if (sellQty < rules.minQty) { avisados.clear(); return; }
        console.log(`${ts()} 🛟 ${BASE} rescatado de Earn: ahora hay ${sellQty} vendible — sigo y le pongo bracket`);
    }

    const open = await bn.getOpenOrders(SYMBOL);
    const sells = (open || []).filter(o => o.side === "SELL");
    const qtyEnOrdenes = sells.reduce((s, o) => s + Number(o.origQty), 0);

    // Si ya hay órdenes de venta que cubren (casi) todo el ETH libre → ya está protegido.
    if (qtyEnOrdenes >= sellQty * 0.99) { console.log(`${ts()} ✅ ${BASE} ya protegido (OCO/venta cubre ${qtyEnOrdenes})`); avisados.clear(); return; }

    // Posición DESNUDA detectada.
    const ind = readIndicators(SYMBOL);
    if (!ind) { console.log(`${ts()} ⚠️ sin indicadores (pipe Binance falló) — no calculo bracket este tick`); return; }
    const price = ind.precio;
    if (rules.minNotional && sellQty * price < rules.minNotional) {
        console.log(`${ts()} ${BASE} desnudo pero exposición ${(sellQty*price).toFixed(2)} < minNotional ${rules.minNotional} — el OCO no entraría, lo dejo`);
        return;
    }

    const entry = await estimarEntrada(sellQty) || price;
    const stopDist = Math.max(STOP_ATR * ind.atr, entry * MIN_STOP_PCT / 100);
    const tpDist   = Math.max(TP_USD_MIN, TP_ATR * ind.atr);
    let stop = +(entry - stopDist).toFixed(2);
    let tp   = +(entry + tpDist).toFixed(2);

    // Restricciones OCO SELL de Binance: TP (limit) DEBE ir sobre el precio; stop DEBE ir bajo el precio.
    if (tp <= price) {
        const k = "tp_pasado:" + Math.round(entry);
        if (!avisados.has(k)) { avisados.add(k);
            notify("🎯 Target ya alcanzado (Binance)", `${SYMBOL}: entrada ~${entry.toFixed(2)}, el TP ($${tp}) ya quedó bajo el precio ($${price.toFixed(2)}). Estás en ganancia — considera cerrar a mano.`, "Hero"); }
        console.log(`${ts()} tp $${tp} <= precio $${price.toFixed(2)} (ya pasó el target, no seteo OCO)`);
        return;
    }
    if (stop >= price) {
        const k = "stop_pasado:" + Math.round(entry);
        if (!avisados.has(k)) { avisados.add(k);
            notify("🔴 Sin stop y bajo tu nivel (Binance)", `${SYMBOL}: entrada ~${entry.toFixed(2)}, el precio ($${price.toFixed(2)}) ya está bajo donde iría tu stop ($${stop}). Posición desnuda en pérdida — decide tú: cerrar o aguantar.`, "Basso"); }
        console.log(`${ts()} stop $${stop} >= precio $${price.toFixed(2)} (ya bajo el stop, no auto-vendo — aviso)`);
        return;
    }

    if (!live) {
        const k = "dry:" + Math.round(entry) + ":" + sellQty;
        if (!avisados.has(k)) { avisados.add(k);
            notify("🛡️ Falta bracket (dry-run)", `${SYMBOL}: ${sellQty} ${BASE} desnudo (entrada ~${entry.toFixed(2)}). Pondría OCO stop $${stop} / TP $${tp}. Corre con --live para ponerlo.`, "Glass"); }
        console.log(`${ts()} DESNUDO ${sellQty} ${BASE} entrada~${entry.toFixed(2)} → pondría OCO stop $${stop} / tp $${tp} (atr ${ind.atr.toFixed(2)}) — dry-run`);
        return;
    }

    // LIVE: poner el OCO de venta.
    // Red Earn→Spot antes de vender: si el auto-subscribe se llevó parte del ETH entre
    // que lo contamos y ahora, el OCO rebotaría con -2010 (balance insuficiente) y la
    // posición quedaría desnuda otro tick más. Redimir primero.
    const redVenta = await earn.ensureSpotAsset(BASE, sellQty);
    if (!redVenta.ok) {
        console.log(`${ts()} ⚠ no pongo el OCO todavía: ${redVenta.msg}`);
        return;   // sin ETH disponible no hay orden que poner; reintenta el próximo tick
    }
    try {
        const oco = await bn.placeOcoSell(SYMBOL, sellQty, { tp, stop });
        console.log(`${ts()} ✅ OCO puesto — stop $${stop} / tp $${tp} (${sellQty} ${BASE}, entrada~${entry.toFixed(2)}, listId ${oco.orderListId})`);
        notify("🛡️ Protección puesta (Binance)", `${SYMBOL}: ${sellQty} ${BASE} entrada ~${entry.toFixed(2)} ahora con stop $${stop} y TP $${tp}. Se cierra solo, aunque apagues todo.`, "Glass");
        appendTrade({ guard: "binance", ocoListId: oco.orderListId, sym: SYMBOL, dir: "LONG",
            entryPx: +entry.toFixed(2), size: sellQty, openT: new Date().toISOString(), sl: stop, tp,
            entorno: bn.getConfig().testnet ? "testnet" : "real" });
    } catch (e) {
        const k = "err:" + Math.round(entry);
        if (!avisados.has(k)) { avisados.add(k);
            notify("⚠️ Binance: OCO falló", `${SYMBOL}: no pude poner el bracket (${e.message}). Pon stop a mano en la app.`, "Basso"); }
        console.log(`${ts()} err poniendo OCO: ${e.message}`);
    }
}

(async () => {
    console.log(`${ts()} Binance-guard ${live ? "LIVE (pone OCO solo)" : "dry-run"} — ${SYMBOL}, stop=entrada−máx(${STOP_ATR}×ATR, ${MIN_STOP_PCT}%), tp=entrada+máx($${TP_USD_MIN}, ${TP_ATR}×ATR), cada ${INTERVAL / 1000}s`);
    for (;;) {
        try { await tick(); }
        catch (e) { console.log(`${ts()} err: ${e.message}`); }
        await new Promise(r => setTimeout(r, INTERVAL));
    }
})();
