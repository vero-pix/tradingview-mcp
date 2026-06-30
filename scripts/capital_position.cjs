#!/usr/bin/env node
// =============================================================================
// capital_position.cjs — Posición abierta de Vero + P&L REAL (cuenta USD 2)
//
// Lee la(s) posición(es) abierta(s) de ETH en Capital.com y calcula el P&L no
// realizado con el bid real (lo que cobraría Vero al cerrar un long).
//
// Uso:
//   node scripts/capital_position.cjs [--demo] [--epic ETHUSD] [--account "USD 2"]
//   node scripts/capital_position.cjs --json     → objeto PositionSummary
//   node scripts/capital_position.cjs --notify    → avisa por notify.sh si cruza umbral
//
// Umbrales (env, opcionales): PNL_ALERT_USD, PNL_ALERT_PCT.
//   Con --notify avisa si unrealizedPnl ≤ −PNL_ALERT_USD (pérdida) o ≥ +PNL_ALERT_USD
//   (ganancia), y/o |pnlPct| ≥ PNL_ALERT_PCT.
//
// ⚠️ El endpoint /positions tiene rate limit estricto (~0,1 req/s). Correr puntual,
//    NO en bucle apretado. El watcher watch_pnl.sh lo llama cada 30s.
// =============================================================================

const { execFileSync } = require("child_process");
const path    = require("path");
const capital = require("./capital_client.cjs");

const args    = process.argv.slice(2);
const demo    = args.includes("--demo");
const json    = args.includes("--json");
const notify  = args.includes("--notify");
const ei      = args.indexOf("--epic");
const epic    = ei !== -1 ? args[ei + 1] : "ETHUSD";
const ai      = args.indexOf("--account");
const account = ai !== -1 ? args[ai + 1] : "USD 2";

function fmt(n) { return (n >= 0 ? "+" : "") + n.toFixed(2); }

function sendNotify(title, msg, sound) {
    try {
        const script = path.join(__dirname, "notify.sh");
        execFileSync("bash", [script, title, msg, sound], { stdio: "ignore" });
    } catch (e) { /* notify es best-effort */ }
}

(async () => {
    try {
        const { positions, pnl } = await capital.getEthPosition({ demo, epic, account });

        if (!pnl) {
            if (json) console.log(JSON.stringify({ positions: [], pnl: null }));
            else console.log("Sin posiciones abiertas en " + epic + " (cuenta " + account + ").");
            process.exit(0);
        }

        if (json) {
            console.log(JSON.stringify({ account, epic, ...pnl }));
        } else {
            const arrow = pnl.unrealizedPnl >= 0 ? "🟢" : "🔴";
            console.log(`${arrow} ${epic} · cuenta ${account}`);
            console.log(`   Lotes:           ${pnl.count} (size total ${pnl.totalSize})`);
            console.log(`   Entrada prom.:   ${pnl.weightedAvgEntry}`);
            console.log(`   Bid actual:      ${pnl.bid}   (offer ${pnl.offer})`);
            console.log(`   P&L:             ${fmt(pnl.unrealizedPnl)} ${pnl.currency}  (${fmt(pnl.pnlPct)}%)`);
            console.log(`   Por unidad:      ${fmt(pnl.pnlPerUnit)}`);
        }

        if (notify) {
            const alertUsd = process.env.PNL_ALERT_USD != null ? Number(process.env.PNL_ALERT_USD) : null;
            const alertPct = process.env.PNL_ALERT_PCT != null ? Number(process.env.PNL_ALERT_PCT) : null;
            const hitUsd = alertUsd != null && Math.abs(pnl.unrealizedPnl) >= alertUsd;
            const hitPct = alertPct != null && Math.abs(pnl.pnlPct) >= alertPct;
            if (hitUsd || hitPct) {
                const green = pnl.unrealizedPnl >= 0;
                const title = green ? "🟢 ETH P&L +" + fmt(pnl.unrealizedPnl) : "🔴 ETH P&L " + fmt(pnl.unrealizedPnl);
                const msg = `${epic} ${account}: ${fmt(pnl.unrealizedPnl)} ${pnl.currency} (${fmt(pnl.pnlPct)}%). `
                    + `Entrada ${pnl.weightedAvgEntry}, bid ${pnl.bid}, ${pnl.count} lotes.`;
                sendNotify(title, msg, green ? "Hero" : "Basso");
            }
        }
    } catch (err) {
        process.stderr.write("capital_position: " + err.message + "\n");
        process.exit(1);
    }
})();
