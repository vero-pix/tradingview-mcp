#!/usr/bin/env node
// =============================================================================
// backtest_horas.cjs — ¿A qué HORA del día rinde mejor el A+ de Vero?
//
// Misma simulación que backtest_aplus.cjs pero con la CALIBRACIÓN VIGENTE del
// detector (2026-07-02: ER1>=0.30, ER5>=0.25, RSI 50-70, volr>=1.0, mom5 0.6xATR)
// y agrupando cada trade por su hora de entrada en HORA DE CHILE. Responde:
// "¿en qué bloques horarios concentra las ganancias / pérdidas el sistema?"
//
// Uso:
//   node scripts/backtest_horas.cjs                  # ETH, ~20 días de velas 1m
//   node scripts/backtest_horas.cjs --bars 43200     # ~30 días
//
// ⚠️ Pasado ≠ futuro. Con pocas señales por hora, leer BLOQUES (madrugada/mañana/
//    tarde/noche), no horas sueltas: una hora con 2 trades no es estadística.
// =============================================================================

const argv = process.argv.slice(2);
function flag(n, d) { const i = argv.indexOf(n); return i !== -1 ? argv[i + 1] : d; }
const SYMBOL = flag("--symbol", "ETHUSDT");
const NBARS  = Number(flag("--bars", "28800"));                 // ~20 días
const SPREAD = flag("--spread", null) != null ? Number(flag("--spread", null)) : (SYMBOL.startsWith("BTC") ? 50 : 1.75);
const ATR_MULT = 2;
// Calibración VIGENTE del detector (detector_servicio.sh, backtest_aplus_sweep 2026-07-02)
const TREND_ATR = 0.25, PULLBACK_ATR = 0.5, MOM5_ATR = 0.6;
const ER1_MIN = 0.30, ER5_MIN = 0.25, RSI_LO = 50, RSI_HI = 70, VOLR_MIN = 1.0;
const LIQ_MIN = SYMBOL.startsWith("BTC") ? 8 : 50;
const TZ = "America/Santiago";

const HOSTS = ["api.binance.com", "data-api.binance.vision", "api1.binance.com"];

// ---- indicadores (mismas fórmulas que calc_indicators.js / backtest_aplus.cjs) ----
function ema(v, p) { const k = 2 / (p + 1); let e = v.slice(0, p).reduce((a, b) => a + b, 0) / p; for (let i = p; i < v.length; i++) e = v[i] * k + e * (1 - k); return e; }
function rsi(c, p = 14) { let g = 0, l = 0; for (let i = 1; i <= p; i++) { const d = c[i] - c[i - 1]; if (d >= 0) g += d; else l -= d; } let aG = g / p, aL = l / p; for (let i = p + 1; i < c.length; i++) { const d = c[i] - c[i - 1]; aG = (aG * (p - 1) + (d > 0 ? d : 0)) / p; aL = (aL * (p - 1) + (d < 0 ? -d : 0)) / p; } if (aL === 0) return 100; return 100 - 100 / (1 + aG / aL); }
function erCalc(c, N = 14) { const seg = c.slice(-N - 1); const neto = Math.abs(seg[seg.length - 1] - seg[0]); let ru = 0; for (let k = 1; k < seg.length; k++) ru += Math.abs(seg[k] - seg[k - 1]); return ru > 0 ? neto / ru : 0; }
function atrCalc(bars) { if (bars.length < 16) return 0; const tr = bars.map((b, i) => i === 0 ? b.high - b.low : Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close))); let a = tr.slice(1, 15).reduce((s, v) => s + v, 0) / 14; for (let i = 15; i < tr.length; i++) a = (a * 13 + tr[i]) / 14; return a; }

function horaChile(ms) { return Number(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", hour12: false }).format(new Date(ms))); }

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

(async () => {
    console.log(`\nBacktest por HORA · ${SYMBOL} · pidiendo ${NBARS} velas 1m (calibración vigente)...`);
    const bars = await fetchKlines();
    if (bars.length < 300) { console.error("Pocas velas (" + bars.length + ")"); process.exit(1); }
    const closes = bars.map(b => b.close);
    const dias = ((bars[bars.length - 1].time - bars[0].time) / 86400000).toFixed(1);
    console.log(`Velas: ${bars.length} (~${dias} días). Spread: $${SPREAD}. Hora local: Chile (${TZ}).\n`);

    const trades = [];
    let pb = 0, cooldownUntil = 0;                        // máquina de estados = detector
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

        if (VA < LIQ_MIN)                { pb = 0; continue; }
        if (ER < ER1_MIN)                { pb = 0; continue; }
        if ((E9 - E21) < TREND_ATR * AT) { pb = 0; continue; }
        if (ER5 < ER5_MIN)               { pb = 0; continue; }
        if ((P - E9) <= PULLBACK_ATR * AT) pb = 1;
        const REB = pb === 1 && M2 >= 1.0 && P >= E9 && R >= RSI_LO && R <= RSI_HI && M5 >= MOM5_ATR * AT && VR >= VOLR_MIN;

        if (REB && i >= cooldownUntil && AT > 0) {
            const entry = bars[i + 1].open;
            const stop = entry - ATR_MULT * AT, target = entry + ATR_MULT * AT;
            let out = null, res = null;
            for (let j = i + 1; j < bars.length; j++) {
                if (bars[j].low <= stop)   { out = stop;   res = "stop";   break; }
                if (bars[j].high >= target){ out = target; res = "target"; break; }
            }
            if (out != null) {
                trades.push({ res, pnl: (out - entry) - SPREAD, hora: horaChile(bars[i + 1].time) });
                cooldownUntil = i + 6; pb = 0;
            }
        }
    }

    const n = trades.length;
    if (!n) { console.log("0 señales A+ en el período.\n"); return; }

    // ---- global ----
    const wins = trades.filter(t => t.pnl > 0);
    const net = trades.reduce((s, t) => s + t.pnl, 0);
    console.log(`════ GLOBAL ════  ${n} señales (~${(n / (dias || 1)).toFixed(2)}/día) · WR ${Math.round(wins.length / n * 100)}% · neto ${net >= 0 ? "+" : ""}$${net.toFixed(2)}\n`);

    // ---- por hora ----
    console.log("hora  señales  WR      neto     barra");
    for (let h = 0; h < 24; h++) {
        const th = trades.filter(t => t.hora === h);
        if (!th.length) continue;
        const w = th.filter(t => t.pnl > 0).length;
        const nh = th.reduce((s, t) => s + t.pnl, 0);
        const bar = (nh >= 0 ? "█".repeat(Math.min(30, Math.round(nh / 2))) : "▒".repeat(Math.min(30, Math.round(-nh / 2))));
        console.log(`${String(h).padStart(2, "0")}:00  ${String(th.length).padStart(4)}   ${String(Math.round(w / th.length * 100)).padStart(3)}%  ${(nh >= 0 ? "+" : "") + "$" + nh.toFixed(2).padStart(7)}  ${nh >= 0 ? "🟢" : "🔴"} ${bar}`);
    }

    // ---- por bloque (lo estadísticamente legible) ----
    const bloques = [
        ["Madrugada (00-07)", t => t.hora >= 0 && t.hora <= 7],
        ["Mañana    (08-12)", t => t.hora >= 8 && t.hora <= 12],
        ["Tarde     (13-17)", t => t.hora >= 13 && t.hora <= 17],
        ["Noche     (18-23)", t => t.hora >= 18 && t.hora <= 23],
    ];
    console.log("\n════ POR BLOQUE (hora de Chile) ════");
    for (const [nombre, f] of bloques) {
        const tb = trades.filter(f);
        if (!tb.length) { console.log(`${nombre}: sin señales`); continue; }
        const w = tb.filter(t => t.pnl > 0).length;
        const nb = tb.reduce((s, t) => s + t.pnl, 0);
        const gw = tb.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
        const gl = Math.abs(tb.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
        const pf = gl > 0 ? (gw / gl).toFixed(2) : "∞";
        console.log(`${nombre}: ${tb.length} señales · WR ${Math.round(w / tb.length * 100)}% · neto ${nb >= 0 ? "+" : ""}$${nb.toFixed(2)} · PF ${pf} ${nb >= 0 ? "🟢" : "🔴"}`);
    }
    console.log("");
})();
