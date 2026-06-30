#!/usr/bin/env node
// =============================================================================
// capital_order.cjs — Enviar / cerrar órdenes en Capital.com (CON GUARDRAILS)
//
// ⚠️ PLATA REAL. Principio: el sistema NUNCA dispara solo. Arma la orden, muestra
//    el blanco, y Vero confirma escribiendo CONFIRMO. Por defecto es DRY-RUN
//    (simulado): solo envía de verdad con --live.
//
// Uso:
//   node scripts/capital_order.cjs status
//   node scripts/capital_order.cjs buy --size 0.1 [--stop X] [--target Y] [--live] [--yes] [--force-promedio]
//   node scripts/capital_order.cjs close --deal <dealId> [--live] [--yes]
//   node scripts/capital_order.cjs close --all [--live] [--yes]
//
// Flags: --demo (cuenta demo), --live (envía real; sin él = dry-run), --yes
//        (salta el prompt), --account "USD 2", --epic ETHUSD.
//
// Guardrails: confirmación CONFIRMO, stop SIEMPRE, dry-run default, MAX_SIZE duro,
//   anti-promedio-a-la-baja (bloquea, override --force-promedio), warns RSI>62 y
//   cerca de resistencia, rate limit, manejo de REJECTED. Registra en diario_trades.jsonl.
// =============================================================================

const { execFileSync } = require("child_process");
const readline = require("readline");
const fs   = require("fs");
const path = require("path");
const os   = require("os");
const capital = require("./capital_client.cjs");

const HOME = process.env.HOME;
const DIR  = path.join(HOME, "Trading", "tradingview-mcp");
const NODE = (() => {
    const p = path.join(HOME, ".local/share/fnm/aliases/default/bin/node");
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch (e) { return process.execPath; }
})();
const DIARIO    = path.join(HOME, "Trading", "diario_trades.jsonl");
const ORDER_LOCK = path.join(os.tmpdir(), "capital_last_order.json");

const MAX_SIZE      = process.env.MAX_SIZE      != null ? Number(process.env.MAX_SIZE)      : 0.5;
const RESIST_BUFFER = process.env.RESIST_BUFFER != null ? Number(process.env.RESIST_BUFFER) : 3;
const ATR_MULT      = process.env.ATR_MULT      != null ? Number(process.env.ATR_MULT)      : 2;

// ---- args ----
const argv    = process.argv.slice(2);
const cmd     = argv[0];
const demo    = argv.includes("--demo");
const live    = argv.includes("--live");
const yes     = argv.includes("--yes");
const forcePromedio = argv.includes("--force-promedio");
function flag(name, def = null) { const i = argv.indexOf(name); return i !== -1 ? argv[i + 1] : def; }
const account = flag("--account", "USD 2");
const epic    = flag("--epic", "ETHUSD");

function fmt(n) { return (n >= 0 ? "+" : "") + Number(n).toFixed(2); }
function red(s)  { return "\x1b[31m" + s + "\x1b[0m"; }
function grn(s)  { return "\x1b[32m" + s + "\x1b[0m"; }
function ylw(s)  { return "\x1b[33m" + s + "\x1b[0m"; }
function die(msg) { process.stderr.write(red("⛔ " + msg) + "\n"); process.exit(1); }

function notify(title, msg, sound) {
    try { execFileSync("bash", [path.join(DIR, "scripts", "notify.sh"), title, msg, sound], { stdio: "ignore" }); }
    catch (e) {}
}

// Lee indicadores en vivo (Binance): precio|ema9|ema21|rsi|mom5|mom2|er|volr|volabs|atr
function readIndicators() {
    try {
        const out = execFileSync("bash", ["-c",
            `BINANCE_INTERVAL=1m BINANCE_LIMIT=100 "${NODE}" scripts/ohlcv_binance.js | "${NODE}" scripts/calc_indicators.js`],
            { cwd: DIR, encoding: "utf8" }).trim();
        const f = out.split("|").map(Number);
        if (f.length < 10 || f[0] === 0) return null;
        return { precio: f[0], rsi: f[3], atr: f[9] };
    } catch (e) { return null; }
}

// Resistencia más cercana por encima del precio (de zonas.env)
function nearestResistance(price) {
    try {
        const txt = fs.readFileSync(path.join(DIR, "scripts", "zonas.env"), "utf8");
        const m = txt.match(/^export ZONAS="([^"]+)"/m);
        if (!m) return null;
        const above = m[1].split(",").map(Number).filter(x => x > price).sort((a, b) => a - b);
        return above.length ? above[0] : null;
    } catch (e) { return null; }
}

function askConfirm(promptTxt) {
    return new Promise(resolve => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(promptTxt, ans => { rl.close(); resolve(ans.trim() === "CONFIRMO"); });
    });
}

async function rateLimitGate() {
    try {
        const last = JSON.parse(fs.readFileSync(ORDER_LOCK, "utf8")).t;
        const dt = Date.now() - last;
        if (dt < 200) await capital.sleep(200 - dt);
    } catch (e) {}
}
function stampOrder() {
    try { fs.writeFileSync(ORDER_LOCK, JSON.stringify({ t: Date.now() })); } catch (e) {}
}

function appendTrade(obj) {
    fs.appendFileSync(DIARIO, JSON.stringify(obj) + "\n");
}
// Reescribe la fila de apertura (por id) agregando datos de cierre.
function closeTrade(dealId, patch) {
    let lines = [];
    try { lines = fs.readFileSync(DIARIO, "utf8").split("\n").filter(Boolean); } catch (e) {}
    let found = false;
    const out = lines.map(l => {
        try { const o = JSON.parse(l); if (o.id === dealId) { found = true; return JSON.stringify({ ...o, ...patch }); } } catch (e) {}
        return l;
    });
    if (!found) out.push(JSON.stringify({ id: dealId, sym: "ETH/USD", dir: "LONG", ...patch }));
    fs.writeFileSync(DIARIO, out.join("\n") + "\n");
}
function nowISO() {
    // formato compatible con el diario: "YYYY-MM-DD HH:MM:SS +00:00"
    return new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, " +00:00");
}

// =============================================================================
// buy
// =============================================================================
async function cmdBuy() {
    const size = Number(flag("--size"));
    if (!(size > 0)) die("Falta --size válido (> 0).");
    if (size > MAX_SIZE) die(`size ${size} > MAX_SIZE ${MAX_SIZE} — bloqueado (red anti fat-finger). `
        + `Subí MAX_SIZE a propósito si de verdad querés más.`);

    await capital.selectAccount(account, { demo });
    const mkt = await capital.getMarket(epic, { demo });
    if (mkt.marketStatus && mkt.marketStatus !== "TRADEABLE") die("Mercado no operable: " + mkt.marketStatus);
    const offer = mkt.offer, bid = mkt.bid;
    if (offer == null) die("No pude leer el precio ask de Capital.");
    if (mkt.minDealSize != null && size < mkt.minDealSize) die(`size ${size} < mínimo del instrumento ${mkt.minDealSize}.`);

    // Stop/target: de flags o derivados de ATR
    const ind = readIndicators();
    let stop   = flag("--stop")   != null ? Number(flag("--stop"))   : null;
    let target = flag("--target") != null ? Number(flag("--target")) : null;
    if (stop == null) {
        if (!ind) die("No pude derivar el ATR (pipe Binance falló) y no diste --stop. "
            + "NO se abre sin stop. Pasá --stop <precio>.");
        stop = +(offer - ATR_MULT * ind.atr).toFixed(2);
    }
    if (target == null && ind) target = +(offer + ATR_MULT * ind.atr).toFixed(2);

    const contractSize = 1; // ETH cripto: 1; el size ya está en unidades
    const riesgoUSD   = (offer - stop) * size * contractSize;
    const gananciaUSD = target != null ? (target - offer) * size * contractSize : null;
    const res = nearestResistance(offer);
    const rsi = ind ? ind.rsi : null;

    // ---- guardrails ----
    const warns = [];
    // anti-promedio (ABORT con override)
    const { pnl } = await capital.getEthPosition({ demo, epic, account });
    if (pnl && pnl.side === "BUY" && offer < pnl.weightedAvgEntry && !forcePromedio) {
        die(`PROMEDIAR A LA BAJA: ya tenés un long a ${pnl.weightedAvgEntry} y querés entrar a ${offer}. `
            + `Es tu regla de oro PROHIBIDA. Si de verdad lo querés, agregá --force-promedio.`);
    }
    if (pnl && pnl.side === "BUY" && offer < pnl.weightedAvgEntry && forcePromedio) {
        warns.push(`PROMEDIO A LA BAJA forzado (entrada prom ${pnl.weightedAvgEntry} > ${offer}).`);
    }
    if (rsi != null && rsi > 62) warns.push(`RSI ${rsi.toFixed(1)} > 62 (caliente, podés quedar pillada).`);
    if (res != null && (res - offer) < RESIST_BUFFER) warns.push(`A $${(res - offer).toFixed(2)} de la resistencia ${res} (< $${RESIST_BUFFER}).`);
    if (target != null && (target - offer) < (offer - stop)) warns.push(`RR pobre: el target está más cerca que el stop.`);

    // ---- resumen ----
    const modo = !live ? "DRY-RUN (simulado)" : (demo ? "DEMO" : red("LIVE · PLATA REAL"));
    console.log("\n══════ CONFIRMAR ORDEN LONG · " + epic + " ══════");
    console.log(`  Cuenta:        ${account}   (${modo})`);
    console.log(`  Precio ask:    ${offer}   (bid ${bid}, spread ${mkt.spread})`);
    console.log(`  Size:          ${size}`);
    console.log(`  Stop:          ${stop}   (riesgo ${fmt(-Math.abs(riesgoUSD))} USD)`);
    console.log(`  Target:        ${target != null ? target + "   (ganancia " + fmt(gananciaUSD) + " USD)" : "(sin target)"}`);
    console.log(`  Resistencia +: ${res != null ? res + "  (a $" + (res - offer).toFixed(2) + ")" : "ninguna arriba"}`);
    console.log(`  RSI:           ${rsi != null ? rsi.toFixed(1) : "?"}`);
    for (const w of warns) console.log("  " + ylw("⚠ " + w));
    console.log("  ────────────────────────────────────────");

    const body = { epic, direction: "BUY", size, stopLevel: stop, guaranteedStop: false };
    if (target != null) body.profitLevel = target;

    if (!live) {
        console.log("  " + grn("[DRY-RUN] no se envió nada.") + " Body que se mandaría:");
        console.log("  " + JSON.stringify(body));
        console.log("  (para enviar de verdad agregá --live)\n");
        return;
    }

    if (!yes) {
        const ok = await askConfirm("  Escribí CONFIRMO para enviar (cualquier otra cosa aborta): ");
        if (!ok) die("Abortado por el usuario (no se escribió CONFIRMO).");
    }

    await rateLimitGate();
    let r;
    try { r = await capital.openPosition({ epic, direction: "BUY", size, stopLevel: stop, profitLevel: target, offer, demo }); }
    catch (e) { die("Error al enviar la orden: " + e.message); }
    stampOrder();

    if (r.ok) {
        console.log(grn(`\n✅ LONG ABIERTO — dealId ${r.dealId} a ${r.level}\n`));
        appendTrade({ id: r.dealId, sym: "ETH/USD", dir: "LONG", entryPx: r.level,
            openT: nowISO(), tag: "auto_con_stop", sl: stop, tp: target });
        notify("🟢 LONG abierto ETH", `${size} @ ${r.level}, stop ${stop}` + (target ? `, target ${target}` : ""), "Hero");
    } else if (r.dealStatus === "REJECTED") {
        notify("🔴 Orden RECHAZADA", `ETH: ${r.reason}`, "Basso");
        die("Orden RECHAZADA por Capital. Motivo: " + (r.reason || "desconocido") + " (no se reintenta).");
    } else {
        die("Estado " + r.dealStatus + " — REVISÁ LA APP de Capital antes de operar de nuevo. " + (r.reason || ""));
    }
}

// =============================================================================
// close
// =============================================================================
async function cmdClose() {
    const dealId = flag("--deal");
    const all    = argv.includes("--all");
    if (!dealId && !all) die("Usá --deal <dealId> o --all.");

    await capital.selectAccount(account, { demo });
    const { positions, pnl } = await capital.getEthPosition({ demo, epic, account });
    if (!positions.length) { console.log("Sin posiciones abiertas en " + epic + "."); return; }

    const targets = all ? positions : positions.filter(p => p.dealId === dealId);
    if (!targets.length) die("No encontré una posición con dealId " + dealId + ". Corré `status` para ver los IDs.");

    console.log("\n══════ CERRAR POSICIÓN" + (all ? "ES" : "") + " · " + epic + " ══════");
    if (pnl) console.log(`  P&L actual: ${fmt(pnl.unrealizedPnl)} USD (${fmt(pnl.pnlPct)}%), entrada ${pnl.weightedAvgEntry}, bid ${pnl.bid}`);
    for (const t of targets) console.log(`  - dealId ${t.dealId}  size ${t.size}  entrada ${t.openLevel}`);
    const modo = !live ? "DRY-RUN (simulado)" : (demo ? "DEMO" : red("LIVE · PLATA REAL"));
    console.log(`  Modo: ${modo}`);
    console.log("  ────────────────────────────────────────");

    if (!live) { console.log("  " + grn("[DRY-RUN] no se cerró nada.") + " (agregá --live para cerrar de verdad)\n"); return; }
    if (!yes) {
        const ok = await askConfirm("  Escribí CONFIRMO para cerrar (cualquier otra cosa aborta): ");
        if (!ok) die("Abortado por el usuario.");
    }

    for (const t of targets) {
        await rateLimitGate();
        let r;
        try { r = await capital.closePosition(t.dealId, { demo }); }
        catch (e) { console.log(red("  error cerrando " + t.dealId + ": " + e.message)); continue; }
        stampOrder();
        if (r.ok) {
            const exitPx = r.level != null ? r.level : pnl && pnl.bid;
            const rpl = +((exitPx - t.openLevel) * t.size * t.contractSize).toFixed(2);
            console.log(grn(`  ✅ cerrado ${t.dealId} a ${exitPx} (rpl ${fmt(rpl)})`));
            closeTrade(t.dealId, { exitPx, rpl, swap: 0, net: rpl, closeT: nowISO() });
            notify("🔵 ETH cerrado", `dealId ${t.dealId} a ${exitPx}, rpl ${fmt(rpl)}`, rpl >= 0 ? "Hero" : "Basso");
        } else {
            console.log(red(`  ${r.dealStatus} ${t.dealId}: ${r.reason || ""} — revisá la app`));
        }
        await capital.sleep(150);
    }
    console.log("");
}

// =============================================================================
// status
// =============================================================================
async function cmdStatus() {
    const { positions, pnl } = await capital.getEthPosition({ demo, epic, account });
    if (!positions.length) { console.log("Sin posiciones abiertas en " + epic + " (cuenta " + account + ")."); return; }
    console.log("\nPosiciones abiertas · " + epic + " · cuenta " + account + ":");
    for (const p of positions) console.log(`  dealId ${p.dealId}  ${p.direction}  size ${p.size}  entrada ${p.openLevel}`);
    if (pnl) console.log(`\n  Total: ${pnl.count} lotes, size ${pnl.totalSize}, entrada prom ${pnl.weightedAvgEntry}, `
        + `P&L ${fmt(pnl.unrealizedPnl)} USD (${fmt(pnl.pnlPct)}%)\n`);
}

// =============================================================================
(async () => {
    try {
        if (cmd === "buy")         await cmdBuy();
        else if (cmd === "close")  await cmdClose();
        else if (cmd === "status") await cmdStatus();
        else {
            console.log("Comandos: status | buy --size N [...] | close --deal <id>|--all");
            console.log("Sin --live todo es DRY-RUN (simulado). Ver cabecera del archivo.");
            process.exit(cmd ? 1 : 0);
        }
    } catch (err) {
        die(err.message);
    }
})();
