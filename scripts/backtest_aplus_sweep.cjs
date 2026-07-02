#!/usr/bin/env node
// =============================================================================
// backtest_aplus_sweep.cjs — Barrido de calibración del A+.
//
// Baja los datos UNA vez y evalúa una grilla de combinaciones de filtros sobre
// los MISMOS datos, para hallar una versión que dispare 1-3 señales/día CON edge
// real (profit factor ≥ 1.3). Reutiliza las fórmulas y la simulación de trade de
// backtest_aplus.cjs (mismo stop/target 2×ATR, mismo spread de Capital).
//
// Uso:
//   node scripts/backtest_aplus_sweep.cjs                       # ETH, 5000 velas
//   node scripts/backtest_aplus_sweep.cjs --symbol BTCUSDT --bars 8000
//   node scripts/backtest_aplus_sweep.cjs --min-day 1 --max-day 4 --min-pf 1.3
//
// Ordena por profit factor los combos que caen en la ventana de frecuencia útil.
// =============================================================================

const argv = process.argv.slice(2);
function flag(n, d) { const i = argv.indexOf(n); return i !== -1 ? argv[i + 1] : d; }
const SYMBOL = flag("--symbol", "ETHUSDT");
const NBARS  = Number(flag("--bars", "5000"));
const SPREAD = flag("--spread", null) != null ? Number(flag("--spread", null)) : (SYMBOL.startsWith("BTC") ? 50 : 1.75);
const MIN_DAY = Number(flag("--min-day", "0.5"));   // mínimo señales/día para considerar el combo
const MAX_DAY = Number(flag("--max-day", "6"));     // máximo (más que esto = ruido / sobre-opera)
const MIN_PF  = Number(flag("--min-pf", "1.0"));    // mínimo profit factor para mostrar
const MIN_N   = Number(flag("--min-n", "12"));      // mínimo de trades (muestra chica = ruido, no fiarse)
const ATR_MULT = 2;
const LIQ_MIN = SYMBOL.startsWith("BTC") ? 8 : 50;
const HOSTS = ["api.binance.com", "data-api.binance.vision", "api1.binance.com"];

// ---- indicadores (idénticos a backtest_aplus.cjs / calc_indicators.js) ----
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
        for (const h of HOSTS) {
            try { const r = await fetch("https://" + h + url); if (r.ok) { data = await r.json(); break; } } catch (e) {}
        }
        if (!data || !data.length) break;
        const bars = data.map(k => ({ time: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] }));
        all = bars.concat(all);
        endTime = data[0][0] - 1;
        if (data.length < need) break;
    }
    return all;
}

// Precalcula por vela todo lo caro (indicadores), para que el barrido solo aplique umbrales.
function precompute(bars) {
    const closes = bars.map(b => b.close);
    const feat = new Array(bars.length).fill(null);
    for (let i = 100; i < bars.length - 1; i++) {
        const win = bars.slice(i - 99, i + 1);
        const wc = win.map(b => b.close), wv = win.map(b => b.volume);
        const P = wc[wc.length - 1], E9 = ema(wc, 9), E21 = ema(wc, 21), R = rsi(wc, 14);
        const M5 = wc[wc.length - 1] - wc[wc.length - 6], M2 = wc[wc.length - 1] - wc[wc.length - 3];
        const ER = erCalc(wc), AT = atrCalc(win);
        const prom = wv.reduce((a, v) => a + v, 0) / wv.length, ult3 = wv.slice(-3).reduce((a, v) => a + v, 0) / 3;
        const VR = prom > 0 ? ult3 / prom : 0, VA = ult3;
        const c5 = []; for (let k = i; k >= i - 70 && k >= 0; k -= 5) c5.unshift(closes[k]);
        const ER5 = c5.length >= 8 ? erCalc(c5, c5.length - 1) : 0;
        feat[i] = { P, E9, E21, R, M5, M2, ER, AT, VR, VA, ER5 };
    }
    return feat;
}

// Simula una configuración completa y devuelve métricas.
function evalConfig(bars, feat, cfg) {
    const trades = [];
    let pb = 0, cooldownUntil = 0;
    for (let i = 100; i < bars.length - 1; i++) {
        const f = feat[i]; if (!f) continue;
        if (f.VA < LIQ_MIN)                        { pb = 0; continue; }
        if (f.ER < cfg.er1)                        { pb = 0; continue; }
        if ((f.E9 - f.E21) < cfg.trendAtr * f.AT)  { pb = 0; continue; }
        if (f.ER5 < cfg.er5)                       { pb = 0; continue; }
        if ((f.P - f.E9) <= cfg.pullbackAtr * f.AT) pb = 1;
        const REB = pb === 1 && f.M2 >= 1.0 && f.P >= f.E9 &&
                    f.R >= cfg.rsiLo && f.R <= cfg.rsiHi &&
                    f.M5 >= cfg.mom5Atr * f.AT && f.VR >= cfg.volr;
        if (REB && i >= cooldownUntil && f.AT > 0) {
            const entry = bars[i + 1].open;
            const stop = entry - ATR_MULT * f.AT, target = entry + ATR_MULT * f.AT;
            let out = null, res = null;
            for (let j = i + 1; j < bars.length; j++) {
                if (bars[j].low <= stop)    { out = stop;   res = "stop";   break; }
                if (bars[j].high >= target) { out = target; res = "target"; break; }
            }
            if (out != null) { trades.push((out - entry) - SPREAD); cooldownUntil = i + 6; pb = 0; }
        }
    }
    const n = trades.length;
    if (!n) return { n: 0 };
    const wins = trades.filter(p => p > 0), losses = trades.filter(p => p <= 0);
    const net = trades.reduce((s, p) => s + p, 0);
    const grossW = wins.reduce((s, p) => s + p, 0), grossL = Math.abs(losses.reduce((s, p) => s + p, 0));
    const pf = grossL > 0 ? grossW / grossL : Infinity;
    return { n, wr: Math.round(wins.length / n * 100), net, pf };
}

(async () => {
    console.log(`\nBarrido A+ · ${SYMBOL} · pidiendo ${NBARS} velas 1m...`);
    const bars = await fetchKlines();
    if (bars.length < 300) { console.error("Pocas velas (" + bars.length + ")"); process.exit(1); }
    const dias = ((bars[bars.length - 1].time - bars[0].time) / 86400000) || 1;
    console.log(`Velas: ${bars.length} (~${dias.toFixed(1)} días). Spread: $${SPREAD}. Ventana útil: ${MIN_DAY}-${MAX_DAY} señales/día.`);
    console.log(`Precalculando indicadores...`);
    const feat = precompute(bars);

    // ---- modo pin: --pin "er1,er5,rsiLo,rsiHi,mom5,trend,pullback,volr" prueba una sola config en detalle ----
    const pin = flag("--pin", null);
    if (pin) {
        const [er1, er5, rsiLo, rsiHi, mom5Atr, trendAtr, pullbackAtr, volr] = pin.split(",").map(Number);
        const cfg = { er1, er5, rsiLo, rsiHi, mom5Atr, trendAtr, pullbackAtr, volr };
        const m = evalConfig(bars, feat, cfg);
        console.log(`\nPIN → ${pin}`);
        if (!m.n) { console.log("0 señales.\n"); return; }
        console.log(`  Señales: ${m.n}  (${(m.n / dias).toFixed(2)}/día)   WR: ${m.wr}%   Neto/u: ${m.net >= 0 ? "+" : ""}$${m.net.toFixed(1)}   PF: ${m.pf === Infinity ? "∞" : m.pf.toFixed(2)}\n`);
        return;
    }

    // ---- grilla ----
    const GRID = {
        er1:        [0.20, 0.25, 0.30, 0.34],
        er5:        [0.00, 0.25, 0.30],               // 0.00 = desactivar el filtro 5m
        rsiLo:      [40, 45, 50],
        rsiHi:      [62, 68, 74],
        mom5Atr:    [0.3, 0.6, 0.9],
        trendAtr:   [0.10, 0.15, 0.25],
        pullbackAtr:[0.5, 0.8],
        volr:       [0.8, 1.0, 1.2],
    };
    const keys = Object.keys(GRID);
    const combos = [];
    (function rec(idx, acc) {
        if (idx === keys.length) { combos.push({ ...acc }); return; }
        for (const v of GRID[keys[idx]]) rec(idx + 1, { ...acc, [keys[idx]]: v });
    })(0, {});
    console.log(`Evaluando ${combos.length} combinaciones...\n`);

    const rows = [];
    for (const cfg of combos) {
        const m = evalConfig(bars, feat, cfg);
        if (!m.n) continue;
        const perDay = m.n / dias;
        if (perDay < MIN_DAY || perDay > MAX_DAY) continue;
        if (m.n < MIN_N) continue;
        if (m.pf < MIN_PF) continue;
        rows.push({ cfg, perDay, ...m });
    }
    rows.sort((a, b) => (b.pf === Infinity ? 1e9 : b.pf) - (a.pf === Infinity ? 1e9 : a.pf));

    if (!rows.length) { console.log("Ningún combo cae en la ventana útil con PF ≥ " + MIN_PF + ". Aflojá --min-pf o ampliá la grilla.\n"); return; }

    console.log("Top 25 combos (ventana útil, ordenados por profit factor):\n");
    console.log("  PF    WR   /día  n   neto    | er1  er5  rsi     mom5 trnd volr");
    console.log("  ────  ───  ────  ──  ──────  | ───────────────────────────────");
    for (const r of rows.slice(0, 25)) {
        const c = r.cfg;
        const pf = r.pf === Infinity ? " ∞  " : r.pf.toFixed(2);
        console.log(
            `  ${pf.padStart(4)}  ${String(r.wr).padStart(2)}%  ${r.perDay.toFixed(1).padStart(4)}  ${String(r.n).padStart(2)}  ${(r.net >= 0 ? "+" : "") + r.net.toFixed(1)}`.padEnd(38) +
            `| ${c.er1.toFixed(2)} ${c.er5.toFixed(2)} ${c.rsiLo}-${c.rsiHi}  ${c.mom5Atr} ${c.trendAtr} ${c.volr}`
        );
    }
    console.log(`\n(${rows.length} combos pasaron el filtro de ${rows.length === 1 ? "" : "ventana+"}PF)\n`);
})();
