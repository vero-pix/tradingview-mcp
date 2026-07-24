#!/usr/bin/env node
// =============================================================================
// detectar_zonas.cjs — Propone niveles de soporte/resistencia automáticamente
//
// Mira los máximos y mínimos "pivote" (swing highs/lows) del precio reciente de
// Binance, los agrupa en niveles, y propone una línea ZONAS para zonas.env.
// Por defecto SOLO propone (no escribe); con --write actualiza zonas.env dejando
// un backup. Tú revisas y ajustas antes de confiar en ellas.
//
// Nota: los niveles salen en precio BINANCE (igual que zonas.env), que es el
// mismo precio en que se opera.
//
// Uso:
//   node scripts/detectar_zonas.cjs                 # propone (no escribe)
//   node scripts/detectar_zonas.cjs --write         # actualiza zonas.env (con backup)
//   node scripts/detectar_zonas.cjs --tf 15m --limit 300 --window 4 --tol 0.25
// =============================================================================

const { execFileSync } = require("child_process");
const fs   = require("fs");
const path = require("path");

const HOME = process.env.HOME;
const DIR  = path.join(HOME, "Trading", "tradingview-mcp");
const ZONAS_FILE = path.join(DIR, "scripts", "zonas.env");
const NODE = (() => {
    const p = path.join(HOME, ".local/share/fnm/aliases/default/bin/node");
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch (e) { return process.execPath; }
})();

const argv  = process.argv.slice(2);
const write = argv.includes("--write");
function flag(name, def) { const i = argv.indexOf(name); return i !== -1 ? argv[i + 1] : def; }
const TF     = flag("--tf", "15m");
const LIMIT  = Number(flag("--limit", "300"));
const WINDOW = Number(flag("--window", "4"));      // velas a cada lado para un pivote
const TOL    = Number(flag("--tol", "0.25")) / 100; // tolerancia de agrupación (%)
const NRES   = Number(flag("--res", "3"));          // nº de resistencias a proponer
const NSUP   = Number(flag("--sup", "3"));          // nº de soportes a proponer
const SYMBOL = flag("--symbol", "ETHUSDT");         // símbolo Binance (BTCUSDT para BTC)
const OUT    = flag("--out", ZONAS_FILE);           // archivo de salida (default zonas.env)

function fetchBars() {
    const out = execFileSync("bash", ["-c",
        `BINANCE_SYMBOL=${SYMBOL} BINANCE_INTERVAL=${TF} BINANCE_LIMIT=${LIMIT} "${NODE}" scripts/ohlcv_binance.js`],
        { cwd: DIR, encoding: "utf8" });
    const bars = JSON.parse(out).bars || [];
    if (bars.length < WINDOW * 2 + 5) throw new Error("pocas velas de Binance (" + bars.length + ")");
    return bars;
}

// Pivotes: high[i] es máximo local si es >= a sus vecinos; low[i] mínimo local si <=.
function pivots(bars, w) {
    const highs = [], lows = [];
    for (let i = w; i < bars.length - w; i++) {
        let isH = true, isL = true;
        for (let j = i - w; j <= i + w; j++) {
            if (bars[j].high > bars[i].high) isH = false;
            if (bars[j].low  < bars[i].low)  isL = false;
        }
        if (isH) highs.push(bars[i].high);
        if (isL) lows.push(bars[i].low);
    }
    return { highs, lows };
}

// Agrupa niveles cercanos (dentro de TOL) en clusters; cada uno guarda cuántos
// toques tuvo (= fuerza del nivel).
function cluster(levels) {
    const sorted = levels.slice().sort((a, b) => a - b);
    const out = [];
    for (const p of sorted) {
        const last = out[out.length - 1];
        if (last && Math.abs(p - last.avg) / last.avg <= TOL) {
            last.sum += p; last.n++; last.avg = last.sum / last.n;
        } else {
            out.push({ sum: p, n: 1, avg: p });
        }
    }
    return out.map(c => ({ price: +c.avg.toFixed(1), touches: c.n }));
}

// Elige los N niveles más FUERTES (más toques), desempatando por cercanía al precio.
function pick(clusters, price, n, side) {
    const filt = clusters.filter(c => side === "res" ? c.price > price : c.price < price);
    filt.sort((a, b) => b.touches - a.touches || Math.abs(a.price - price) - Math.abs(b.price - price));
    return filt.slice(0, n).sort((a, b) => b.price - a.price);
}

function main() {
    const bars = fetchBars();
    const price = bars[bars.length - 1].close;
    const { highs, lows } = pivots(bars, WINDOW);
    const res = pick(cluster(highs), price, NRES, "res");
    const sup = pick(cluster(lows),  price, NSUP, "sup");

    const all = [...res, ...sup].sort((a, b) => b.price - a.price);
    if (!all.length) { console.error("No se detectaron niveles."); process.exit(1); }

    console.log(`\nPrecio actual (Binance ${TF}): ${price.toFixed(1)}`);
    console.log("Niveles detectados (fuerza = nº de toques):\n");
    console.log("  nivel     tipo          toques   dist");
    for (const c of all) {
        const tipo = c.price > price ? "resistencia" : "soporte    ";
        const dist = (c.price - price >= 0 ? "+" : "") + (c.price - price).toFixed(1);
        console.log(`  ${String(c.price).padStart(8)}  ${tipo}   ${String(c.touches).padStart(4)}    ${dist.padStart(7)}`);
    }
    const csv = all.map(c => c.price.toFixed(1)).join(",");
    console.log(`\nZONAS propuesta:\n  export ZONAS="${csv}"\n`);

    if (!write) {
        console.log("(solo propuesta — agrega --write para actualizar zonas.env con backup)\n");
        return;
    }

    // Backup + escritura
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-T:]/g, "").slice(0, 12);
    const backup = OUT + `.backup_${stamp}`;
    try { fs.copyFileSync(OUT, backup); } catch (e) {}
    const nowStr = new Date().toISOString().slice(0, 10);
    const lines = [
        `# Zonas ${SYMBOL} — autodetectadas ${nowStr} (Binance ${TF}, precio ~${price.toFixed(0)})`,
        `# Generado por scripts/detectar_zonas.cjs. REVISA antes de confiar — ajusta a mano si hace falta.`,
        `# Backup del anterior: ${path.basename(backup)}`,
        "",
    ];
    for (const c of all) {
        const tipo = c.price > price ? "resistencia" : "soporte";
        lines.push(`#   ${c.price.toFixed(1)}  ${tipo} (${c.touches} toques)`);
    }
    lines.push("", `export ZONAS="${csv}"`, "");
    fs.writeFileSync(OUT, lines.join("\n"));
    console.log(`✅ ${path.basename(OUT)} actualizado. Backup: ${path.basename(backup)}\n`);
}

try { main(); } catch (e) { console.error("detectar_zonas: " + e.message); process.exit(1); }
