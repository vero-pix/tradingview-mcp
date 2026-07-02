#!/usr/bin/env node
// =============================================================================
// capital_reporte.cjs — Reporte de trading LEÍDO DIRECTO de Capital.com (API)
//
// Reemplaza el reporte que dependía de bajar CSVs a mano. Lee los trades cerrados
// de Capital por la API, calcula stats (neto, win rate, mejor/peor, sobre-operar)
// y arma un reporte con una LECCIÓN para aprender. Se manda por Telegram/macOS.
//
// Uso:
//   node scripts/capital_reporte.cjs            # imprime el reporte
//   node scripts/capital_reporte.cjs --send     # además lo manda por Telegram
//   HORAS=24 node scripts/capital_reporte.cjs   # ventana (default 24h)
// =============================================================================

const { execFileSync } = require("child_process");
const path = require("path");
const capital = require("./capital_client.cjs");

const HOME = process.env.HOME;
const DIR  = path.join(HOME, "Trading", "tradingview-mcp");
const argv = process.argv.slice(2);
const SEND = argv.includes("--send");
const HORAS = process.env.HORAS != null ? Number(process.env.HORAS) : 24;
const ACCOUNT = process.env.ACCOUNT || "USD 2";

function fmt(n) { return (n >= 0 ? "+" : "") + Number(n).toFixed(2); }

function notify(title, msg, sound) {
    try { execFileSync("bash", [path.join(DIR, "scripts", "notify.sh"), title, msg, sound], { stdio: "ignore" }); }
    catch (e) {}
}

(async () => {
    try {
        await capital.selectAccount(ACCOUNT, { demo: false });
        const period = Math.min(HORAS * 3600, 86400);   // la API tope 24h
        const r = await capital.apiCall("GET", "/api/v1/history/transactions?lastPeriod=" + period, { demo: false });
        const tx = ((r.data && r.data.transactions) || [])
            .filter(t => t.transactionType === "TRADE" && /clos/i.test(t.note || ""))
            .map(t => ({ inst: t.instrumentName, pnl: Number(t.size), date: t.dateUtc || t.date }));

        const bal = (await capital.getAccounts({})).find(a => a.accountName === ACCOUNT);
        const balance = bal && bal.balance && bal.balance.balance;

        const n = tx.length;
        const wins = tx.filter(t => t.pnl > 0).length;
        const losses = tx.filter(t => t.pnl < 0).length;
        const net = tx.reduce((s, t) => s + t.pnl, 0);
        const wr = n ? Math.round(wins / n * 100) : 0;
        const best = n ? Math.max(...tx.map(t => t.pnl)) : 0;
        const worst = n ? Math.min(...tx.map(t => t.pnl)) : 0;
        // por instrumento
        const porInst = {};
        for (const t of tx) { porInst[t.inst] = (porInst[t.inst] || 0) + t.pnl; }

        // --- Lección según los datos ---
        let leccion;
        if (n === 0) {
            leccion = "😌 Cero trades en el período. A veces no operar ES la mejor jugada. Esperar el A+ verde no es perder tiempo.";
        } else if (n > 12) {
            leccion = `⚠️ ${n} trades — eso es SOBRE-OPERAR. Los mejores días son de 1-3 trades A+, no de 12. Menos es más.`;
        } else if (net < 0 && wr < 50) {
            leccion = "🔴 Día en rojo con win rate bajo. Suele ser por entrar apurada (perseguir/promediar) en vez de esperar el A+ verde. Un lote, con calma.";
        } else if (net < 0) {
            leccion = "🔴 Cerraste en rojo pero con buen win rate — quizás un trade grande se comió a los chicos. Cuida el tamaño.";
        } else if (n <= 3 && net >= 0) {
            leccion = "👏 Pocos trades y en verde — ESO es disciplina. Sigue así: esperar la buena, no cazar todas.";
        } else {
            leccion = "🟢 Día en verde. Bien. Recuerda: la constancia gana, no el día heroico.";
        }

        // --- Texto del reporte ---
        const lineas = [];
        lineas.push(`📊 Reporte de trading · últimas ${HORAS}h`);
        lineas.push(`Cuenta ${ACCOUNT}: $${balance}`);
        lineas.push("");
        if (n === 0) {
            lineas.push("Trades cerrados: 0 (no operaste)");
        } else {
            lineas.push(`Trades cerrados: ${n}  (✅ ${wins} / ❌ ${losses}, win rate ${wr}%)`);
            lineas.push(`Neto: ${fmt(net)} USD   ·   mejor ${fmt(best)}   ·   peor ${fmt(worst)}`);
            const inst = Object.entries(porInst).map(([k, v]) => `${k} ${fmt(v)}`).join("  ·  ");
            if (inst) lineas.push(`Por instrumento: ${inst}`);
        }
        lineas.push("");
        lineas.push(leccion);
        const texto = lineas.join("\n");

        console.log("\n" + texto + "\n");

        if (SEND) {
            const sound = net > 0 ? "Hero" : (net < 0 ? "Basso" : "Glass");
            notify("📊 Reporte de trading", texto, sound);
            console.log("(enviado por Telegram/macOS)");
        }
    } catch (err) {
        console.error("capital_reporte: " + err.message);
        process.exit(1);
    }
})();
