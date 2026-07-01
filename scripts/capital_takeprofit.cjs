#!/usr/bin/env node
// =============================================================================
// capital_takeprofit.cjs — Cierra la posición cuando el P&L llega a un objetivo USD
//
// Vigila el P&L no realizado y, al alcanzar +N USD de ganancia, CIERRA la(s)
// posición(es) automáticamente. Pensado para tomar ganancia sin estar mirando.
//
// ⚠️ Con --live CIERRA de verdad, sin pedir CONFIRMO (es lo que se pidió: cerrar
//    al llegar al objetivo). Solo CIERRA, nunca abre. Sin --live = dry-run.
//
// Uso:
//   node scripts/capital_takeprofit.cjs --usd 4 --live
//   INTERVAL=12 node scripts/capital_takeprofit.cjs --usd 4 --live &
//
// Env: INTERVAL (seg, default 15), ACCOUNT ("USD 2"), EPIC (ETHUSD), DEMO=1.
// =============================================================================

const { execFileSync } = require("child_process");
const path = require("path");
const capital = require("./capital_client.cjs");

const HOME = process.env.HOME;
const DIR  = path.join(HOME, "Trading", "tradingview-mcp");

const argv = process.argv.slice(2);
const live = argv.includes("--live");
const demo = argv.includes("--demo");
function flag(name, def) { const i = argv.indexOf(name); return i !== -1 ? argv[i + 1] : def; }
const USD      = Number(flag("--usd", process.env.TP_USD || "4"));
const INTERVAL = (process.env.INTERVAL ? Number(process.env.INTERVAL) : 15) * 1000;
const ACCOUNT  = process.env.ACCOUNT || "USD 2";
const EPIC     = process.env.EPIC || "ETHUSD";

function ts() { return new Date().toISOString().slice(11, 19); }
function fmt(n) { return (n >= 0 ? "+" : "") + Number(n).toFixed(2); }
function notify(title, msg, sound) {
    try { execFileSync("bash", [path.join(DIR, "scripts", "notify.sh"), title, msg, sound], { stdio: "ignore" }); }
    catch (e) {}
}

async function run() {
    await capital.selectAccount(ACCOUNT, { demo });
    console.log(`${ts()} take-profit arrancado: objetivo +$${USD} · cuenta '${ACCOUNT}' · epic ${EPIC} · `
        + `interval ${INTERVAL / 1000}s · modo ${live ? "LIVE (cierra de verdad)" : "DRY-RUN"}`);

    while (true) {
        let positions;
        try { positions = await capital.getPositions({ demo, epic: EPIC }); }
        catch (e) { console.log(`${ts()} error leyendo posición: ${e.message}`); await capital.sleep(INTERVAL); continue; }

        if (!positions.length) { console.log(`${ts()} sin posición abierta — fin.`); return; }

        const snap = { bid: positions[0].bid, offer: positions[0].offer };
        const pnl = capital.computePnL(positions, snap);
        console.log(`${ts()} P&L ${fmt(pnl.unrealizedPnl)} USD (${fmt(pnl.pnlPct)}%), bid ${pnl.bid}, faltan $${(USD - pnl.unrealizedPnl).toFixed(2)}`);

        if (pnl.unrealizedPnl >= USD) {
            console.log(`${ts()} 🎯 OBJETIVO +$${USD} ALCANZADO (P&L ${fmt(pnl.unrealizedPnl)}) → cerrando ${positions.length} lote(s)`);
            if (!live) { console.log(`${ts()}   [DRY-RUN] no se cerró (agrega --live)`); return; }
            let realizado = 0, cerrados = 0;
            for (const p of positions) {
                try {
                    const r = await capital.closePosition(p.dealId, { demo });
                    if (r.ok) {
                        const exitPx = r.level != null ? r.level : snap.bid;
                        realizado += (exitPx - p.openLevel) * p.size * p.contractSize;
                        cerrados++;
                        console.log(`${ts()}   ✅ cerrado ${p.dealId} a ${exitPx}`);
                    } else {
                        console.log(`${ts()}   ${r.dealStatus} ${p.dealId}: ${r.reason || ""}`);
                    }
                } catch (e) { console.log(`${ts()}   error cerrando ${p.dealId}: ${e.message}`); }
                await capital.sleep(200);
            }
            notify(`🎯 ETH cerrado en ganancia`, `Take-profit +$${USD}: cerrados ${cerrados} lote(s), realizado ~${fmt(realizado)} USD.`, "Hero");
            return;
        }
        await capital.sleep(INTERVAL);
    }
}

run().catch(e => { console.error("take-profit error:", e.message); process.exit(1); });
