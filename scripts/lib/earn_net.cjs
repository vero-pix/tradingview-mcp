// =============================================================================
// lib/earn_net.cjs — Red de seguridad Earn→Spot, compartida por TODO lo que VENDE.
//
// Binance puede auto-suscribir el ETH a Simple Earn / "Staking Pasivo". Ese ETH
// aparece FUERA del balance libre de Spot: una orden de venta (OCO del bracket, subida
// de stop del trailing, cierre de emergencia) NO puede usarlo hasta redimirlo.
//
// Esta lib nace de mover la ensureSpotEth que vivía DENTRO de binance_order.cjs, que
// no la podía compartir porque ese archivo es un CLI sin module.exports. La lógica es
// la MISMA (mismo log, mismo aviso de LOCKED); lo único nuevo es que ahora también la
// pueden usar el guard y el trailing, que antes vendían sin red.
//
// Contrato: NO tira nunca. Devuelve { ok, msg } y el llamador decide. Loguea cada
// redención en ~/Trading/earn_redenciones.jsonl. Si el ETH está en LOCKED (no
// redimible al instante) avisa por Telegram: ese es un bloqueo real que resuelve Vero.
//
// ⚠️ Requiere permiso "Simple Earn" en la API key. Sin él la llamada rebota -2015 y
// devolvemos ok:false CON el motivo — nunca fallar mudo.
// =============================================================================

const fs   = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const bn   = require("../binance_client.cjs");

const HOME = process.env.HOME;
const DIR  = path.join(HOME, "Trading", "tradingview-mcp");
const REDENCIONES_LOG = path.join(HOME, "Trading", "earn_redenciones.jsonl");
const REDEEM_BUFFER   = process.env.REDEEM_BUFFER_ETH != null ? Number(process.env.REDEEM_BUFFER_ETH) : 0;

const ts    = () => new Date().toISOString();
const sleep = ms => new Promise(r => setTimeout(r, ms));

function notify(title, msg, sound) {
    try { execFileSync("bash", [path.join(DIR, "scripts", "notify.sh"), title, msg, sound], { stdio: "ignore" }); }
    catch (e) {}
}

function logRedencion(obj) {
    try { fs.appendFileSync(REDENCIONES_LOG, JSON.stringify({ t: ts(), ...obj }) + "\n"); } catch (e) {}
}

// Cuánto hay en Earn para un activo, separado por tipo. Nunca tira: si no hay permiso
// o el endpoint falla devuelve ceros y el motivo, para que el llamador no se caiga.
async function earnTotals(asset) {
    let flexRows = [], lockedTotal = 0, err = null;
    try { flexRows = await bn.getFlexibleEarnPosition(asset); }
    catch (e) { err = e.message; }
    try { lockedTotal = (await bn.getLockedEarnPosition(asset)).reduce((s, r) => s + Number(r.amount || r.totalAmount || 0), 0); }
    catch (e) { /* locked suele no existir; lo común es flexible */ }
    const productos = (flexRows || []).filter(r => Number(r.totalAmount || 0) > 0)
                                      .sort((a, b) => Number(b.totalAmount) - Number(a.totalAmount));
    const flexTotal = productos.reduce((s, r) => s + Number(r.totalAmount || 0), 0);
    return { productos, flexTotal, lockedTotal, err };
}

// Garantiza `needed` unidades LIBRES de `asset` en Spot antes de vender.
// Devuelve { ok, msg, redimido }.
async function ensureSpotAsset(asset, needed) {
    let free;
    try { free = Number(((await bn.getBalances()).find(b => b.asset === asset) || {}).free || 0); }
    catch (e) { return { ok: false, msg: `no pude leer balance Spot ${asset} (${e.message})`, redimido: 0 }; }
    if (free >= needed - 1e-8) return { ok: true, msg: `${asset} libre ${free} ≥ ${needed.toFixed(6)} — sin redención`, redimido: 0 };

    const { productos, flexTotal, lockedTotal, err } = await earnTotals(asset);
    if (err && flexTotal === 0) {
        return { ok: false, msg: `red venta: no pude leer Flexible Earn ${asset} — ¿permiso "Simple Earn" en la key? (${err})`, redimido: 0 };
    }

    if (free + flexTotal < needed - 1e-8) {
        // El flexible no alcanza. Si hay ETH en LOCKED, ESE es el bloqueo real: no se
        // redime al instante y Vero tiene que resolverlo a mano en Binance.
        if (lockedTotal > 0) {
            const m = `🔒 ${asset} en Staking LOCKED (no redimible al instante): ${lockedTotal.toFixed(6)}. ` +
                      `Para vender falta ${(needed - free).toFixed(6)} y el flexible solo cubre ${flexTotal.toFixed(6)}. ` +
                      `Entra a Binance → Earn a redimir o esperar el desbloqueo — no lo puedo resolver solo.`;
            notify(`🔒 ${asset} atrapado en Staking — venta bloqueada`, m, "Basso");
            logRedencion({ tipo: "LOCKED_BLOQUEO", asset, needed, free, flexTotal, lockedTotal });
            return { ok: false, msg: m, redimido: 0 };
        }
        return { ok: false, msg: `${asset} libre ${free} + Flexible ${flexTotal.toFixed(6)} < ${needed.toFixed(6)}; no hay más para redimir`, redimido: 0 };
    }

    // Redimir de los productos flexibles hasta cubrir el faltante (+ buffer).
    let porRedimir = Math.min(flexTotal, (needed - free) + REDEEM_BUFFER);
    let redimido = 0;
    for (const p of productos) {
        if (porRedimir <= 1e-8) break;
        const amt = Math.min(Number(p.totalAmount), porRedimir);
        console.log(`${ts()} 🛟 redimiendo ${amt.toFixed(6)} ${asset} de Flexible Earn (${p.productId}) → Spot | libre ${free}, falta ${(needed - free).toFixed(6)}`);
        try {
            const res = await bn.redeemFlexibleEarn(p.productId, amt.toFixed(8));
            logRedencion({ tipo: "REDENCION", asset, monto: amt, productId: p.productId, needed, free, redeemId: res && res.redeemId });
            porRedimir -= amt; redimido += amt;
        } catch (e) {
            logRedencion({ tipo: "REDENCION_FALLIDA", asset, monto: amt, productId: p.productId, needed, error: e.message });
            return { ok: false, msg: `red venta: la redención de ${asset} falló — ¿permiso "Simple Earn"? (${e.message})`, redimido };
        }
    }

    // Confirmar acreditación (flexible es instantáneo; poll ≤ 10s por si acaso).
    for (let i = 0; i < 10; i++) {
        await sleep(1000);
        const b2 = Number(((await bn.getBalances()).find(b => b.asset === asset) || {}).free || 0);
        if (b2 >= needed - 1e-8) {
            console.log(`${ts()} 🛟 acreditado: ${asset} libre ahora ${b2}`);
            logRedencion({ tipo: "ACREDITADO", asset, libre: b2, needed, redimido });
            return { ok: true, msg: `redimidos ${redimido.toFixed(6)} ${asset} de Earn`, redimido };
        }
    }
    logRedencion({ tipo: "NO_ACREDITADO", asset, needed, redimido });
    return { ok: false, msg: `red venta: redención enviada pero el ${asset} no se acreditó en Spot a tiempo (>10s)`, redimido };
}

module.exports = { ensureSpotAsset, earnTotals, logRedencion, REDENCIONES_LOG };
