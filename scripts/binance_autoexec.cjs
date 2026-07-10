#!/usr/bin/env node
// =============================================================================
// binance_autoexec.cjs — Auto-ejecución de la señal A+ en Binance spot (SIN tap).
//
// Vigila ~/Trading/senales_aplus.jsonl (el detector escribe una línea por cada A+).
// Cuando aparece una A+ NUEVA de ETH dentro de la ventana, abre SOLA la orden en Binance
// reusando `binance_order.cjs buy` — que ya trae el bracket OCO nativo + los topes duros
// (freno: MAX_POS, DAILY_MAX_LOSS, MAX_SIZE). Sin confirmación humana. SOLO LONG.
//
// La red de seguridad NO se toca: el freno vive dentro de binance_order.cjs y bloquea
// igual. Este script solo reemplaza el "tap ✅" por un disparo automático.
//
// ⚠️ Dry-run por defecto (binance_order imprime el plan, no envía). --live => real.
//
// Uso:
//   node scripts/binance_autoexec.cjs            # dry-run
//   node scripts/binance_autoexec.cjs --live &   # real (abre solo)
//
// Env: AUTO_SIZE (def 0.005), WINDOW_MIN (def 5), SYMBOL (def ETHUSDT),
//      EPIC_MATCH (def ETHUSD), INTERVAL (seg, def 5),
//      SENALES_FILE / STATE_FILE (override para pruebas).
// =============================================================================

const { execFileSync } = require("child_process");
const fs   = require("fs");
const path = require("path");
const bn   = require("./binance_client.cjs");

const HOME    = process.env.HOME;
const DIR     = path.join(HOME, "Trading", "tradingview-mcp");
const SENALES = process.env.SENALES_FILE || path.join(HOME, "Trading", "senales_aplus.jsonl");
const STATE   = process.env.STATE_FILE   || path.join(HOME, "Trading", ".autoexec_last.json");
const NODE    = process.execPath;

const argv = process.argv.slice(2);
const live = argv.includes("--live");
const AUTO_SIZE  = process.env.AUTO_SIZE != null ? Number(process.env.AUTO_SIZE) : 0.005;
const WINDOW_MS  = (process.env.WINDOW_MIN ? Number(process.env.WINDOW_MIN) : 5) * 60000;
const SYMBOL     = process.env.SYMBOL || "ETHUSDT";
const EPIC_MATCH = process.env.EPIC_MATCH || "ETHUSD";
const INTERVAL   = (process.env.INTERVAL ? Number(process.env.INTERVAL) : 5) * 1000;
// Red de seguridad Earn→Spot: colchón sobre el nocional (slippage) y extra a redimir.
const SLIPPAGE   = 1.005;  // +0.5% sobre el nocional para cubrir slippage del market buy
const REDEEM_BUFFER = process.env.REDEEM_BUFFER != null ? Number(process.env.REDEEM_BUFFER) : 0.5; // USDT extra a redimir

function ts() { return new Date().toISOString().slice(11, 19); }
function notify(t, m, s) { try { execFileSync("bash", [path.join(DIR, "scripts", "notify.sh"), t, m, s], { stdio: "ignore" }); } catch (e) {} }

function lastProcessed() { try { return JSON.parse(fs.readFileSync(STATE, "utf8")).ts || 0; } catch (e) { return 0; } }
function setProcessed(t) { try { fs.writeFileSync(STATE, JSON.stringify({ ts: t })); } catch (e) {} }

function ultimaSenal() {
    let txt; try { txt = fs.readFileSync(SENALES, "utf8"); } catch (e) { return null; }
    const lines = txt.trim().split("\n").filter(Boolean);
    if (!lines.length) return null;
    try { return JSON.parse(lines[lines.length - 1]); } catch (e) { return null; }
}

// al arrancar: la última señal existente queda marcada como ya-vista (no disparar viejas)
(function initBaseline() {
    if (lastProcessed() === 0) {
        const s = ultimaSenal();
        setProcessed(s && s.ts ? s.ts : Date.now());
        console.log(`${ts()} baseline: última señal vista = ${s && s.ts ? s.ts : "(ninguna)"}`);
    }
})();

// Red de seguridad contra el auto-subscribe de Earn: ANTES de comprar, revisa que
// el USDT LIBRE en Spot cubra el nocional de la orden. Si no, y hay USDT en Flexible
// Earn (LDUSDT), redime a Spot lo que falta y espera la acreditación (flexible es
// instantáneo). En dry-run NO redime: solo loguea lo que haría. Devuelve
// { ok, msg }: si ok=false, NO se debe comprar (se muestra el motivo, sin fallar mudo).
async function ensureSpotUsdt() {
    let price, balances;
    try {
        [price, balances] = await Promise.all([bn.getPrice(SYMBOL), bn.getBalances()]);
    } catch (e) {
        return { ok: false, msg: `red de seguridad: no pude leer precio/balance (${e.message})` };
    }
    const needed = AUTO_SIZE * price * SLIPPAGE;
    const freeUsdt = Number((balances.find(b => b.asset === "USDT") || {}).free || 0);
    if (freeUsdt >= needed) {
        return { ok: true, msg: `USDT libre ${freeUsdt.toFixed(2)} ≥ nocional ${needed.toFixed(2)} — sin redención` };
    }
    const shortfall = needed - freeUsdt;

    // ¿Hay USDT en Flexible Earn? (requiere permiso Simple Earn en la key)
    let pos;
    try {
        pos = await bn.getFlexibleEarnPosition("USDT");
    } catch (e) {
        // p.ej. -2015 = la key no tiene permiso Simple Earn → mostrar, no fallar mudo
        return { ok: false, msg: `red de seguridad: no pude leer Flexible Earn — ¿la key de ejecución tiene permiso "Simple Earn"? (${e.message})` };
    }
    const earnTotal = pos.reduce((s, r) => s + Number(r.totalAmount || 0), 0);
    const product = pos.find(r => Number(r.totalAmount) > 0);
    if (!earnTotal || !product) {
        return { ok: false, msg: `USDT libre ${freeUsdt.toFixed(2)} < nocional ${needed.toFixed(2)} y no hay USDT en Flexible Earn para redimir` };
    }
    if (freeUsdt + earnTotal < needed) {
        return { ok: false, msg: `fondos insuficientes: libre ${freeUsdt.toFixed(2)} + Earn ${earnTotal.toFixed(2)} < nocional ${needed.toFixed(2)}` };
    }

    const redeemAmt = Math.min(earnTotal, shortfall + REDEEM_BUFFER);
    const amountStr = redeemAmt.toFixed(8);

    if (!live) {
        console.log(`${ts()} 🛟 [dry-run] redimiría ${redeemAmt.toFixed(2)} USDT de Flexible Earn (${product.productId}) → Spot | libre ${freeUsdt.toFixed(2)}, falta ${shortfall.toFixed(2)}, en Earn ${earnTotal.toFixed(2)}`);
        return { ok: true, msg: `dry-run: sin redención real` };
    }

    console.log(`${ts()} 🛟 redimiendo ${redeemAmt.toFixed(2)} USDT de Flexible Earn (${product.productId}) → Spot | libre ${freeUsdt.toFixed(2)} < nocional ${needed.toFixed(2)}`);
    try {
        const res = await bn.redeemFlexibleEarn(product.productId, amountStr);
        console.log(`${ts()} 🛟 redención enviada: ${JSON.stringify(res)}`);
        notify("🛟 Redención Earn→Spot", `${redeemAmt.toFixed(2)} USDT redimidos para cubrir la compra ${SYMBOL}.`, "Glass");
    } catch (e) {
        return { ok: false, msg: `red de seguridad: la redención de Earn falló — ¿permiso "Simple Earn" en la key? (${e.message})` };
    }

    // Flexible acredita al instante, pero confirmamos antes de comprar (poll ≤ 10s).
    const t0 = Date.now();
    while (Date.now() - t0 < 10000) {
        await new Promise(r => setTimeout(r, 1000));
        let bal2;
        try { bal2 = await bn.getBalances(); } catch (e) { continue; }
        const f2 = Number((bal2.find(b => b.asset === "USDT") || {}).free || 0);
        if (f2 >= needed) {
            console.log(`${ts()} 🛟 acreditado: USDT libre ahora ${f2.toFixed(2)} ≥ nocional ${needed.toFixed(2)}`);
            return { ok: true, msg: `redimidos ${redeemAmt.toFixed(2)} USDT de Earn` };
        }
    }
    return { ok: false, msg: `red de seguridad: redención enviada pero el USDT no se acreditó en Spot a tiempo (>10s)` };
}

function ejecutar(sig) {
    const args = ["scripts/binance_order.cjs", "buy", "--size", String(AUTO_SIZE), "--symbol", SYMBOL];
    if (sig.sl) args.push("--stop", String(sig.sl));
    if (sig.tp) args.push("--target", String(sig.tp));
    if (live) args.push("--live", "--yes");
    try {
        return { ok: true, out: execFileSync(NODE, args, { cwd: DIR, encoding: "utf8" }) };
    } catch (e) {
        return { ok: false, out: (e.stdout || "") + (e.stderr || e.message || "") };
    }
}

function resumen(out) {
    return out.replace(/\x1b\[[0-9;]*m/g, "").split("\n")
        .filter(l => /COMPRA|BRACKET|DRY-RUN|TOPE|⛔|OCO|error|Error|Abortado|insufficient|mínimo/i.test(l))
        .join(" | ").slice(0, 300);
}

async function tick() {
    const sig = ultimaSenal();
    if (!sig || !sig.ts) return;
    if (sig.ts <= lastProcessed()) return;                       // ya procesada / vieja

    const esEth = (sig.symbol === SYMBOL) || (sig.epic || "").includes(EPIC_MATCH.replace(/USDT?$/, ""));
    setProcessed(sig.ts);                                        // marca vista pase lo que pase (anti doble-disparo)
    if (!esEth) { console.log(`${ts()} señal ${sig.epic || sig.symbol} no es ${SYMBOL} — ignoro`); return; }

    const edadMs = Date.now() - sig.ts;
    if (edadMs > WINDOW_MS) {
        console.log(`${ts()} A+ ${sig.ts} vieja (${(edadMs / 60000).toFixed(1)}min > ventana ${WINDOW_MS / 60000}) — no ejecuto`);
        return;
    }

    console.log(`${ts()} 🎯 A+ NUEVA ${SYMBOL} entry~${sig.entry} sl ${sig.sl} tp ${sig.tp} → ejecutando (${live ? "LIVE" : "dry-run"})`);

    // Red de seguridad: asegura USDT libre en Spot (redime de Earn si hace falta)
    // ANTES de comprar. Si no se puede cubrir, no compra y muestra el motivo.
    const guard = await ensureSpotUsdt();
    console.log(`${ts()} 🛟 ${guard.msg}`);
    if (!guard.ok) {
        notify("⚠️ Auto-ejecución NO entró", `${SYMBOL}: ${guard.msg}`, "Basso");
        return;
    }

    const r = ejecutar(sig);
    const linea = resumen(r.out) || (r.ok ? "ejecutado" : "sin salida");
    if (r.ok) {
        console.log(`${ts()} ✅ ${linea}`);
        notify("⚡ Auto-ejecución A+ (Binance)", `${SYMBOL} size ${AUTO_SIZE} · entrada ~${sig.entry}. ${linea}`, "Hero");
    } else {
        console.log(`${ts()} ⚠️ no ejecutó: ${linea}`);
        notify("⚠️ Auto-ejecución NO entró", `${SYMBOL}: ${linea}`, "Basso");
    }
}

(async () => {
    console.log(`${ts()} Binance auto-exec ${live ? "LIVE (abre solo)" : "dry-run"} — ${SYMBOL} size ${AUTO_SIZE}, ventana ${WINDOW_MS / 60000}min, cada ${INTERVAL / 1000}s`);
    for (;;) {
        try { await tick(); }
        catch (e) { console.log(`${ts()} err: ${e.message}`); }
        await new Promise(r => setTimeout(r, INTERVAL));
    }
})();
