#!/usr/bin/env node
// =============================================================================
// benchmark_aplus.cjs — ¿El A+ le gana a lo TONTO? Compara, con fees de Binance:
//   1) A+        (los mismos filtros del detector)
//   2) Random    (misma cantidad de trades, entradas al azar, mismo stop/target)
//   3) Buy&Hold  (comprar al inicio, vender al final)
// Todo en $/unidad (por 1 ETH) sobre la misma ventana, descontando ~0.2% round-trip.
//
// Uso: node scripts/benchmark_aplus.cjs [--bars 20000] [--fee 0.002] [--seeds 300]
// =============================================================================

const argv = process.argv.slice(2);
function flag(n, d) { const i = argv.indexOf(n); return i !== -1 ? argv[i + 1] : d; }
const SYMBOL = flag("--symbol", "ETHUSDT");
const NBARS  = Number(flag("--bars", "20000"));
const FEE    = Number(flag("--fee", "0.002"));   // 0.2% round-trip (0.1%/lado)
const SEEDS  = Number(flag("--seeds", "300"));
const ATR_MULT = 2, TREND_ATR = 0.25, PULLBACK_ATR = 0.5, MOM5_ATR = 0.6;
const LIQ_MIN = SYMBOL.startsWith("BTC") ? 8 : 50;
const HOSTS = ["api.binance.com", "data-api.binance.vision", "api1.binance.com"];

function ema(v, p) { const k = 2 / (p + 1); let e = v.slice(0, p).reduce((a, b) => a + b, 0) / p; for (let i = p; i < v.length; i++) e = v[i] * k + e * (1 - k); return e; }
function rsi(c, p = 14) { let g = 0, l = 0; for (let i = 1; i <= p; i++) { const d = c[i] - c[i - 1]; if (d >= 0) g += d; else l -= d; } let aG = g / p, aL = l / p; for (let i = p + 1; i < c.length; i++) { const d = c[i] - c[i - 1]; aG = (aG * (p - 1) + (d > 0 ? d : 0)) / p; aL = (aL * (p - 1) + (d < 0 ? -d : 0)) / p; } if (aL === 0) return 100; return 100 - 100 / (1 + aG / aL); }
function erCalc(c, N = 14) { const seg = c.slice(-N - 1); const neto = Math.abs(seg[seg.length - 1] - seg[0]); let ru = 0; for (let k = 1; k < seg.length; k++) ru += Math.abs(seg[k] - seg[k - 1]); return ru > 0 ? neto / ru : 0; }
function atrCalc(bars) { if (bars.length < 16) return 0; const tr = bars.map((b, i) => i === 0 ? b.high - b.low : Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close))); let a = tr.slice(1, 15).reduce((s, v) => s + v, 0) / 14; for (let i = 15; i < tr.length; i++) a = (a * 13 + tr[i]) / 14; return a; }

async function fetchKlines() {
    let all = [], endTime = null;
    while (all.length < NBARS) {
        const need = Math.min(1000, NBARS - all.length);
        let url = `/api/v3/klines?symbol=${SYMBOL}&interval=1m&limit=${need}`;
        if (endTime) url += `&endTime=${endTime}`;
        let data = null;
        for (const h of HOSTS) { try { const r = await fetch("https://" + h + url); if (r.ok) { data = await r.json(); break; } } catch (e) {} }
        if (!data || !data.length) break;
        all = data.map(k => ({ time: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] })).concat(all);
        endTime = data[0][0] - 1;
        if (data.length < need) break;
    }
    return all;
}

// simula un trade LONG desde la vela i: entra en open[i+1], sale en stop/target 2×ATR. $/unidad neto.
function simTrade(bars, i, atr) {
    const entry = bars[i + 1].open;
    const stop = entry - ATR_MULT * atr, target = entry + ATR_MULT * atr;
    for (let j = i + 1; j < bars.length; j++) {
        if (bars[j].low <= stop)    return (stop - entry) - entry * FEE;
        if (bars[j].high >= target) return (target - entry) - entry * FEE;
    }
    return (bars[bars.length - 1].close - entry) - entry * FEE; // no cerró: marca a mercado
}

(async () => {
    console.log(`\nBenchmark A+ · ${SYMBOL} · pidiendo ${NBARS} velas 1m...`);
    const bars = await fetchKlines();
    if (bars.length < 500) { console.error("Pocas velas (" + bars.length + ")"); process.exit(1); }
    const closes = bars.map(b => b.close);
    const dias = ((bars[bars.length - 1].time - bars[0].time) / 86400000).toFixed(1);
    console.log(`Velas: ${bars.length} (~${dias} días). Costo asumido: ${(FEE * 100).toFixed(2)}% round-trip (fees Binance).\n`);

    // ---- 1) A+ ----
    const aplus = []; const aplusIdx = [];
    let pb = 0, cd = 0;
    const atrCache = [];
    for (let i = 100; i < bars.length - 1; i++) {
        const win = bars.slice(i - 99, i + 1);
        const wc = win.map(b => b.close), wv = win.map(b => b.volume);
        const P = wc[wc.length - 1], E9 = ema(wc, 9), E21 = ema(wc, 21), R = rsi(wc, 14);
        const M5 = wc[wc.length - 1] - wc[wc.length - 6], M2 = wc[wc.length - 1] - wc[wc.length - 3];
        const ER = erCalc(wc), AT = atrCalc(win);
        atrCache[i] = AT;
        const prom = wv.reduce((a, v) => a + v, 0) / wv.length, ult3 = wv.slice(-3).reduce((a, v) => a + v, 0) / 3;
        const VR = prom > 0 ? ult3 / prom : 0, VA = ult3;
        const c5 = []; for (let k = i; k >= i - 70 && k >= 0; k -= 5) c5.unshift(closes[k]);
        const ER5 = c5.length >= 8 ? erCalc(c5, c5.length - 1) : 0;
        if (VA < LIQ_MIN) { pb = 0; continue; }
        if (ER < 0.30) { pb = 0; continue; }
        if ((E9 - E21) < TREND_ATR * AT) { pb = 0; continue; }
        if (ER5 < 0.25) { pb = 0; continue; }
        if ((P - E9) <= PULLBACK_ATR * AT) pb = 1;
        const REB = pb === 1 && M2 >= 1.0 && P >= E9 && R >= 50 && R <= 70 && M5 >= MOM5_ATR * AT && VR >= 1.0;
        if (REB && i >= cd && AT > 0) { const pnl = simTrade(bars, i, AT); aplus.push(pnl); aplusIdx.push({ er: ER, atrp: AT / P * 100, pnl }); cd = i + 6; pb = 0; }
    }
    const n = aplus.length;
    const netA = aplus.reduce((s, v) => s + v, 0);
    const wrA = n ? Math.round(aplus.filter(v => v > 0).length / n * 100) : 0;

    // ---- 2) Random (misma cantidad n, entradas al azar con ATR válido) ----
    const valid = [];
    for (let i = 100; i < bars.length - 1; i++) if (atrCache[i] > 0) valid.push(i);
    let randNets = [];
    for (let s = 0; s < SEEDS && n > 0; s++) {
        let net = 0;
        for (let t = 0; t < n; t++) {
            const i = valid[Math.floor(Math.random() * valid.length)];
            net += simTrade(bars, i, atrCache[i]);
        }
        randNets.push(net);
    }
    randNets.sort((a, b) => a - b);
    const randMed = n ? randNets[Math.floor(SEEDS / 2)] : 0;
    const randP10 = n ? randNets[Math.floor(SEEDS * 0.1)] : 0;
    const randP90 = n ? randNets[Math.floor(SEEDS * 0.9)] : 0;
    const beatRandom = n ? Math.round(randNets.filter(x => netA > x).length / SEEDS * 100) : 0;

    // ---- 3) Buy & Hold (1 unidad, todo el período) ----
    const bh = (closes[closes.length - 1] - closes[0]) - closes[0] * FEE;

    console.log("════════ BENCHMARK (neto $/unidad, con fees) ════════");
    console.log(`A+:         ${netA >= 0 ? "+" : ""}$${netA.toFixed(2)}   (${n} trades, WR ${wrA}%)`);
    console.log(`Random:     mediana ${randMed >= 0 ? "+" : ""}$${randMed.toFixed(2)}   (rango P10..P90: $${randP10.toFixed(2)}..$${randP90.toFixed(2)}, ${n} trades × ${SEEDS} simulaciones)`);
    console.log(`Buy & Hold: ${bh >= 0 ? "+" : ""}$${bh.toFixed(2)}   (comprar al inicio, vender al final)`);
    console.log("");
    console.log(`El A+ le ganó al ${beatRandom}% de las ${SEEDS} corridas aleatorias.`);
    console.log(beatRandom >= 90 ? "🟢 El A+ supera claramente al azar — hay estructura real, no suerte."
        : beatRandom >= 65 ? "🟡 El A+ le gana al azar, pero no de forma abrumadora. Edge fino."
        : "🔴 El A+ NO supera al azar de forma convincente — el 'edge' puede ser ruido/suerte.");
    console.log(`\n──────── FILTRO DE RÉGIMEN (¿ayuda operar solo en tendencia fuerte?) ────────`);
    for (const cut of [0.30, 0.40, 0.50, 0.60]) {
        const sub = aplusIdx.filter(t => t.er >= cut);
        if (!sub.length) { console.log(`ER ≥ ${cut.toFixed(2)}:  0 trades`); continue; }
        const net = sub.reduce((s, t) => s + t.pnl, 0);
        const wr = Math.round(sub.filter(t => t.pnl > 0).length / sub.length * 100);
        console.log(`ER ≥ ${cut.toFixed(2)}:  ${sub.length} trades · WR ${wr}% · neto ${net >= 0 ? "+" : ""}$${net.toFixed(2)}`);
    }
    console.log(`\n⚠️ Ventana corta (${n} trades) = MUY ruidoso al subdividir. Direccional, no conclusión.\n`);
})();
