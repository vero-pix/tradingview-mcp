// =============================================================================
// binance_order.cjs — Enviar / cerrar órdenes en Binance Spot (CON GUARDRAILS)
//
// Órdenes en Binance Spot. Diferencia clave con un CFD: el
// bracket (stop + take-profit) se pone con UNA orden OCO nativa apenas se compra,
// así el bróker sostiene ambos desde el segundo 1 (no hace falta stopguard/tpguard
// vigilando). Solo LONG (compra ETH, vende con OCO).
//
// ⚠️ Por defecto DRY-RUN (no envía) y TESTNET (dinero falso). Envía de verdad con
//    --live; opera en real solo si BINANCE_TESTNET=0 en ~/Trading/.env.binance.
//
// Uso:
//   node scripts/binance_order.cjs status
//   node scripts/binance_order.cjs buy --size 0.01 [--stop X] [--target Y] [--live] [--yes]
//   node scripts/binance_order.cjs close [--live] [--yes]     # vende todo el ETH a mercado
//
// Guardrails: stop SIEMPRE (OCO), dry-run default, MAX_SIZE (fat-finger),
//   MAX_POS (brackets abiertos), DAILY_MAX_LOSS (corta el día en rojo).
// =============================================================================

const { execFileSync } = require("child_process");
const readline = require("readline");
const fs   = require("fs");
const path = require("path");
const bn   = require("./binance_client.cjs");

const HOME = process.env.HOME;
const DIR  = path.join(HOME, "Trading", "tradingview-mcp");
const NODE = (() => {
    const p = path.join(HOME, ".local/share/fnm/aliases/default/bin/node");
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch (e) { return process.execPath; }
})();
const DIARIO = path.join(HOME, "Trading", "diario_trades_binance.jsonl");

const MAX_SIZE        = process.env.MAX_SIZE        != null ? Number(process.env.MAX_SIZE)        : 0.5;
const ATR_MULT        = process.env.ATR_MULT        != null ? Number(process.env.ATR_MULT)        : 2;
const MIN_STOP_PCT    = process.env.MIN_STOP_PCT    != null ? Number(process.env.MIN_STOP_PCT)    : 0.4;
const MAX_POS         = process.env.MAX_POS         != null ? Number(process.env.MAX_POS)         : 2;
const DAILY_MAX_LOSS  = process.env.DAILY_MAX_LOSS  != null ? Number(process.env.DAILY_MAX_LOSS)  : 20;

const argv   = process.argv.slice(2);
const cmd    = argv[0];
const live   = argv.includes("--live");
const yes    = argv.includes("--yes");
function flag(name, def = null) { const i = argv.indexOf(name); return i !== -1 ? argv[i + 1] : def; }
const SYMBOL = flag("--symbol", "ETHUSDT");
const BASE   = SYMBOL.replace(/USDT$/, "");   // ETHUSDT → ETH

function fmt(n) { return (n >= 0 ? "+" : "") + Number(n).toFixed(2); }
function red(s) { return "\x1b[31m" + s + "\x1b[0m"; }
function grn(s) { return "\x1b[32m" + s + "\x1b[0m"; }
function ylw(s) { return "\x1b[33m" + s + "\x1b[0m"; }
function die(msg) { process.stderr.write(red("⛔ " + msg) + "\n"); process.exit(1); }

function notify(title, msg, sound) {
    try { execFileSync("bash", [path.join(DIR, "scripts", "notify.sh"), title, msg, sound], { stdio: "ignore" }); }
    catch (e) {}
}

// Indicadores en vivo (Binance): precio|ema9|ema21|rsi|mom5|mom2|er|volr|volabs|atr
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

function askConfirm(promptTxt) {
    return new Promise(resolve => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(promptTxt, ans => { rl.close(); resolve(ans.trim() === "CONFIRMO"); });
    });
}
function appendTrade(obj) { fs.appendFileSync(DIARIO, JSON.stringify(obj) + "\n"); }

const REDEEM_BUFFER_ETH = process.env.REDEEM_BUFFER_ETH != null ? Number(process.env.REDEEM_BUFFER_ETH) : 0;
const REDENCIONES_LOG   = path.join(HOME, "Trading", "earn_redenciones.jsonl");
const ts    = () => new Date().toISOString();
const sleep = ms => new Promise(r => setTimeout(r, ms));
function logRedencion(obj) {
    try { fs.appendFileSync(REDENCIONES_LOG, JSON.stringify({ t: ts(), ...obj }) + "\n"); } catch (e) {}
}

// Red de seguridad Earn→Spot para la VENTA (gemela de ensureSpotUsdt del lado compra).
// Binance puede auto-suscribir el ETH a Simple Earn / "Staking Pasivo". Antes de que
// el OCO o un close necesiten vender, esto garantiza ETH LIBRE en Spot: si falta y hay
// ETH en FLEXIBLE Earn lo redime (acredita al instante). Si el ETH está en LOCKED (no
// redimible), avisa por Telegram — ese sí es un bloqueo real que Vero resuelve a mano.
// Devuelve { ok, msg } y NO tira: el llamador decide. Loguea cada redención.
async function ensureSpotEth(needed) {
    let free;
    try { free = Number(((await bn.getBalances()).find(b => b.asset === BASE) || {}).free || 0); }
    catch (e) { return { ok: false, msg: `no pude leer balance Spot ${BASE} (${e.message})` }; }
    if (free >= needed - 1e-8) return { ok: true, msg: `${BASE} libre ${free} ≥ ${needed.toFixed(6)} — sin redención` };

    let flex;
    try { flex = await bn.getFlexibleEarnPosition(BASE); }
    catch (e) { return { ok: false, msg: `red venta: no pude leer Flexible Earn ${BASE} — ¿permiso "Simple Earn" en la key? (${e.message})` }; }
    const productos = flex.filter(r => Number(r.totalAmount || 0) > 0)
                          .sort((a, b) => Number(b.totalAmount) - Number(a.totalAmount));
    const flexTotal = productos.reduce((s, r) => s + Number(r.totalAmount || 0), 0);

    if (free + flexTotal < needed - 1e-8) {
        // el flexible no alcanza → ¿hay ETH atrapado en LOCKED? eso es el bloqueo real
        let lockedTotal = 0;
        try { lockedTotal = (await bn.getLockedEarnPosition(BASE)).reduce((s, r) => s + Number(r.amount || r.totalAmount || 0), 0); }
        catch (e) { /* sin permiso/endpoint: seguimos, lo común es flexible */ }
        if (lockedTotal > 0) {
            const m = `🔒 ETH en Staking LOCKED (no redimible al instante): ${lockedTotal.toFixed(6)} ${BASE}. Para vender falta ${(needed - free).toFixed(6)} y el flexible solo cubre ${flexTotal.toFixed(6)}. Entra a Binance → Earn a redimir/esperar el desbloqueo — no lo puedo resolver solo.`;
            notify("🔒 ETH atrapado en Staking — venta bloqueada", m, "Basso");
            logRedencion({ tipo: "LOCKED_BLOQUEO", asset: BASE, needed, free, flexTotal, lockedTotal });
            return { ok: false, msg: m };
        }
        return { ok: false, msg: `${BASE} libre ${free} + Flexible ${flexTotal.toFixed(6)} < ${needed.toFixed(6)}; no hay más para redimir` };
    }

    // redimir de los productos flexibles hasta cubrir el faltante (+ buffer)
    let porRedimir = Math.min(flexTotal, (needed - free) + REDEEM_BUFFER_ETH);
    for (const p of productos) {
        if (porRedimir <= 1e-8) break;
        const amt = Math.min(Number(p.totalAmount), porRedimir);
        console.log(`${ts()} 🛟 redimiendo ${amt.toFixed(6)} ${BASE} de Flexible Earn (${p.productId}) → Spot | libre ${free}, falta ${(needed - free).toFixed(6)}`);
        try {
            const res = await bn.redeemFlexibleEarn(p.productId, amt.toFixed(8));
            logRedencion({ tipo: "REDENCION", asset: BASE, monto: amt, productId: p.productId, needed, redeemId: res && res.redeemId });
            porRedimir -= amt;
        } catch (e) {
            return { ok: false, msg: `red venta: la redención de ${BASE} falló — ¿permiso "Simple Earn"? (${e.message})` };
        }
    }
    // confirmar acreditación (flexible es instantáneo; poll ≤ 10s por si acaso)
    for (let i = 0; i < 10; i++) {
        await sleep(1000);
        const b2 = Number(((await bn.getBalances()).find(b => b.asset === BASE) || {}).free || 0);
        if (b2 >= needed - 1e-8) { console.log(`${ts()} 🛟 acreditado: ${BASE} libre ahora ${b2}`); return { ok: true, msg: `redimidos ${BASE} de Earn` }; }
    }
    return { ok: false, msg: `red venta: redención enviada pero el ${BASE} no se acreditó en Spot a tiempo (>10s)` };
}

// ¿Cuántos brackets (posiciones) hay abiertos? = nº de listas OCO distintas abiertas.
async function contarPosiciones() {
    const open = await bn.getOpenOrders(SYMBOL);
    const listas = new Set((open || []).map(o => o.orderListId).filter(id => id != null && id !== -1));
    // órdenes sueltas (orderListId -1) también cuentan como 1 c/u
    const sueltas = (open || []).filter(o => o.orderListId === -1).length;
    return listas.size + sueltas;
}

// P&L realizado del día (aprox): flujo neto en USDT de los trades de hoy menos comisiones.
// Sirve como cortacircuitos de pérdida diaria, no como contabilidad exacta.
async function pnlHoyAprox() {
    const trades = await bn.getMyTrades(SYMBOL, 200);
    const inicioDia = new Date(); inicioDia.setHours(0, 0, 0, 0);
    let neto = 0;
    for (const t of (trades || [])) {
        if (t.time < inicioDia.getTime()) continue;
        const quote = Number(t.quoteQty);
        neto += (t.isBuyer ? -quote : quote);
        // comisión: si es en USDT descuéntala directo (aprox; si es en BNB/ETH se ignora)
        if (t.commissionAsset === "USDT") neto -= Number(t.commission);
    }
    return neto;
}

// Chequeo de TOPES DUROS (mecánico). Devuelve null si puede operar, o el motivo.
async function chequearTopes() {
    try {
        const nPos = await contarPosiciones();
        if (nPos >= MAX_POS) return `🔴 TOPE DURO: ya hay ${nPos} bracket(s) abierto(s) (máx ${MAX_POS}). No abro otro.`;
        const pnl = await pnlHoyAprox();
        if (pnl <= -DAILY_MAX_LOSS) return `🔴 TOPE DURO: pérdida del día ~$${pnl.toFixed(2)} (límite -$${DAILY_MAX_LOSS}). Se acabó por hoy.`;
        return null;
    } catch (e) {
        return `⚠️ No pude verificar los topes (${e.message}) — por seguridad, no ejecuto.`;
    }
}

// =============================================================================
// buy — compra a mercado + OCO (stop + take-profit) en una sola jugada
// =============================================================================
async function cmdBuy() {
    const size = Number(flag("--size"));
    if (!(size > 0)) die("Falta --size válido (> 0).");
    if (size > MAX_SIZE) die(`size ${size} > MAX_SIZE ${MAX_SIZE} — bloqueado (anti fat-finger).`);

    const { testnet } = bn.getConfig();
    const rules = await bn.getSymbolRules(SYMBOL);
    const qty = bn.roundStep(size, rules.stepSize);
    if (qty < rules.minQty) die(`size ${qty} < mínimo del par ${rules.minQty}.`);

    const price = await bn.getPrice(SYMBOL);
    if (rules.minNotional && qty * price < rules.minNotional) {
        die(`Exposición ${(qty * price).toFixed(2)} USDT < mínimo del par ${rules.minNotional}. Sube --size.`);
    }

    // stop y target
    const ind = readIndicators(SYMBOL);
    let stop   = flag("--stop")   != null ? Number(flag("--stop"))   : null;
    let target = flag("--target") != null ? Number(flag("--target")) : null;
    let stopNota = "manual", tgtNota = "manual";
    if (stop == null) {
        if (!ind) die("No pude derivar el ATR (pipe Binance falló) y no diste --stop. NO se abre sin stop.");
        const minStop = price * MIN_STOP_PCT / 100;
        const dist = Math.max(ATR_MULT * ind.atr, minStop);
        stopNota = ATR_MULT * ind.atr >= minStop ? `${ATR_MULT}×ATR` : `piso ${MIN_STOP_PCT}%`;
        stop = +(price - dist).toFixed(2);
    }
    if (target == null) {
        target = +(price + (price - stop)).toFixed(2);   // RR 1:1 (piso)
        tgtNota = "RR 1:1";
    }

    const riesgo   = (price - stop) * qty;
    const ganancia = (target - price) * qty;
    const rsi = ind ? ind.rsi : null;

    const warns = [];
    if (rsi != null && rsi > 70) warns.push(`RSI ${rsi.toFixed(1)} > 70 (caliente).`);
    if (target - price < (price - stop) - 0.01) warns.push("RR pobre: el target está más cerca que el stop.");

    const modo = !live ? "DRY-RUN (simulado)" : (testnet ? ylw("LIVE · TESTNET (falso)") : red("LIVE · PLATA REAL"));
    console.log("\n══════ CONFIRMAR ORDEN LONG · " + SYMBOL + " ══════");
    console.log(`  Entorno:   ${modo}`);
    console.log(`  Precio:    ${price}`);
    console.log(`  Cantidad:  ${qty} ${BASE}   (~$${(qty * price).toFixed(2)})`);
    console.log(`  Stop:      ${stop}   (${stopNota}, −$${(price - stop).toFixed(2)}, riesgo ${fmt(-Math.abs(riesgo))})`);
    console.log(`  Target:    ${target}   (${tgtNota}, ganancia ${fmt(ganancia)})`);
    console.log(`  RSI:       ${rsi != null ? rsi.toFixed(1) : "?"}`);
    for (const w of warns) console.log("  " + ylw("⚠ " + w));
    console.log("  ────────────────────────────────────────");

    if (!live) {
        console.log("  " + grn("[DRY-RUN] no se envió nada.") + " Plan: MARKET BUY " + qty + " → OCO SELL (tp " + target + " / stop " + stop + ")");
        console.log("  (para enviar de verdad agrega --live)\n");
        return;
    }

    // TOPES DUROS (defensa en profundidad: además del bot)
    const bloqueo = await chequearTopes();
    if (bloqueo) die(bloqueo);

    if (!yes) {
        const ok = await askConfirm("  Escribe CONFIRMO para enviar (cualquier otra cosa aborta): ");
        if (!ok) die("Abortado (no se escribió CONFIRMO).");
    }

    // 1) compra a mercado
    let buyRes;
    try { buyRes = await bn.placeMarketBuy(SYMBOL, qty); }
    catch (e) { die("Error en la compra a mercado: " + e.message); }
    const fillQty = Number(buyRes.executedQty || qty);
    const fillPx  = buyRes.fills && buyRes.fills.length
        ? buyRes.fills.reduce((s, f) => s + Number(f.price) * Number(f.qty), 0) / buyRes.fills.reduce((s, f) => s + Number(f.qty), 0)
        : price;
    console.log(grn(`\n✅ COMPRA ${fillQty} ${BASE} @ ~${fillPx.toFixed(2)} (orderId ${buyRes.orderId})`));

    // 2) OCO de venta (stop + take-profit). Binance cobra la comisión de la compra
    // EN ETH (si no pagas con BNB), así que el balance real queda por debajo de
    // fillQty → si vendes fillQty exacto, el OCO falla con "insufficient balance".
    // Se descuenta la comisión cobrada en el asset base y se redondea hacia abajo.
    let comBase = 0;
    if (buyRes.fills) for (const f of buyRes.fills) {
        if (f.commissionAsset === BASE) comBase += Number(f.commission || 0);
    }
    const sellQty = bn.roundStep(fillQty - comBase, rules.stepSize);
    // red de seguridad venta: si el auto-subscribe se llevó el ETH recién comprado,
    // redímelo antes de armar el OCO (si no, el OCO rebota con -2010)
    const guardVenta = await ensureSpotEth(sellQty);
    if (!guardVenta.ok) console.log(ylw("  ⚠ " + guardVenta.msg));
    let oco;
    try { oco = await bn.placeOcoSell(SYMBOL, sellQty, { tp: target, stop }); }
    catch (e) {
        notify("⚠️ Binance: bracket falló", `Compraste ${fillQty} ${BASE} pero el OCO no entró: ${e.message}. Pon stop a mano.`, "Basso");
        die("¡OJO! La compra entró pero el OCO (stop/tp) NO. Revisa Binance y pon el stop a mano. Motivo: " + e.message);
    }
    console.log(grn(`✅ BRACKET OCO puesto — stop ${stop} / target ${target} (listId ${oco.orderListId})\n`));

    appendTrade({ orderId: buyRes.orderId, ocoListId: oco.orderListId, sym: SYMBOL, dir: "LONG",
        entryPx: +fillPx.toFixed(2), size: fillQty, openT: new Date().toISOString(), sl: stop, tp: target,
        entorno: testnet ? "testnet" : "real" });
    notify(`🟢 LONG ${SYMBOL}`, `${fillQty} ${BASE} @ ${fillPx.toFixed(2)}, stop ${stop}, target ${target}`, "Hero");
}

// =============================================================================
// close — vende todo el ETH a mercado (cancela OCO abiertos primero)
// =============================================================================
async function cmdClose() {
    const { testnet } = bn.getConfig();
    const rules = await bn.getSymbolRules(SYMBOL);
    const balances = await bn.getBalances();
    const eth = balances.find(b => b.asset === BASE);
    const libre = eth ? Number(eth.free) : 0;
    const qty = bn.roundStep(libre, rules.stepSize);

    const open = await bn.getOpenOrders(SYMBOL);
    console.log("\n══════ CERRAR " + SYMBOL + " ══════");
    console.log(`  ${BASE} libre: ${libre}  ·  órdenes abiertas: ${(open || []).length}`);
    const modo = !live ? "DRY-RUN (simulado)" : (testnet ? ylw("TESTNET") : red("LIVE · PLATA REAL"));
    console.log(`  Modo: ${modo}`);
    if (qty < rules.minQty) { console.log("  (nada vendible: ETH libre bajo el mínimo)\n"); if (!(open || []).length) return; }
    console.log("  ────────────────────────────────────────");

    if (!live) { console.log("  " + grn("[DRY-RUN]") + " cancelaría los OCO y vendería " + qty + " " + BASE + " a mercado.\n"); return; }
    if (!yes) {
        const ok = await askConfirm("  Escribe CONFIRMO para cerrar (cualquier otra cosa aborta): ");
        if (!ok) die("Abortado.");
    }

    // 1) cancelar OCO/órdenes abiertas para liberar el ETH bloqueado
    for (const o of (open || [])) {
        try { await bn.cancelOrder(SYMBOL, o.orderId); } catch (e) { /* puede que ya se haya cancelado en cascada */ }
    }
    // 1.5) traer el ETH de Earn a Spot si el auto-subscribe lo movió (flexible = instantáneo)
    try {
        const flexTotal = (await bn.getFlexibleEarnPosition(BASE)).reduce((s, r) => s + Number(r.totalAmount || 0), 0);
        if (flexTotal > 0) {
            const freeNow = Number(((await bn.getBalances()).find(b => b.asset === BASE) || {}).free || 0);
            const g = await ensureSpotEth(freeNow + flexTotal);   // redime TODO lo que esté en Earn
            if (!g.ok) console.log(ylw("  ⚠ red venta: " + g.msg));
        }
    } catch (e) { console.log(ylw("  ⚠ no pude revisar Earn ETH antes de cerrar: " + e.message)); }
    // 2) vender a mercado el ETH libre (re-lee balance por si el cancel liberó locked)
    const bal2 = (await bn.getBalances()).find(b => b.asset === BASE);
    const q2 = bn.roundStep(bal2 ? Number(bal2.free) : 0, rules.stepSize);
    if (q2 < rules.minQty) { console.log(grn("\n  ✅ OCO cancelados. No hay ETH sobre el mínimo para vender.\n")); return; }
    let sell;
    try { sell = await bn.signedCall("POST", "/api/v3/order", { symbol: SYMBOL, side: "SELL", type: "MARKET", quantity: q2 }); }
    catch (e) { die("Error vendiendo a mercado: " + e.message); }
    const px = sell.fills && sell.fills.length
        ? sell.fills.reduce((s, f) => s + Number(f.price) * Number(f.qty), 0) / sell.fills.reduce((s, f) => s + Number(f.qty), 0)
        : null;
    console.log(grn(`\n  ✅ VENDIDO ${q2} ${BASE}${px ? " @ ~" + px.toFixed(2) : ""} (orderId ${sell.orderId})\n`));
    notify(`🔵 ${SYMBOL} cerrado`, `Vendido ${q2} ${BASE}${px ? " @ " + px.toFixed(2) : ""}`, "Hero");
}

// =============================================================================
// status — balances + órdenes abiertas + tope del día
// =============================================================================
async function cmdStatus() {
    const { testnet } = bn.getConfig();
    console.log("\nBinance " + (testnet ? "TESTNET" : "REAL") + " · " + SYMBOL);
    const balances = await bn.getBalances();
    if (!balances.length) console.log("  (sin saldos)");
    for (const b of balances) console.log(`  ${b.asset}: libre ${b.free}  bloqueado ${b.locked}`);
    const open = await bn.getOpenOrders(SYMBOL);
    console.log(`  Órdenes abiertas en ${SYMBOL}: ${(open || []).length}`);
    for (const o of (open || [])) console.log(`   - ${o.type} ${o.side} qty ${o.origQty} @ ${o.price || o.stopPrice} (listId ${o.orderListId})`);
    try {
        const nPos = await contarPosiciones(), pnl = await pnlHoyAprox();
        console.log(`  Brackets: ${nPos}/${MAX_POS}  ·  P&L hoy (aprox): ${fmt(pnl)} USDT  ·  tope diario: -$${DAILY_MAX_LOSS}`);
    } catch (e) {}
    console.log("");
}

// =============================================================================
(async () => {
    try {
        if (cmd === "buy")         await cmdBuy();
        else if (cmd === "close")  await cmdClose();
        else if (cmd === "status") await cmdStatus();
        else {
            console.log("Comandos: status | buy --size N [--stop X --target Y] | close");
            console.log("Sin --live todo es DRY-RUN. TESTNET por defecto (ver .env.binance).");
            process.exit(cmd ? 1 : 0);
        }
    } catch (err) { die(err.message); }
})();
