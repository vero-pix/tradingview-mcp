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
