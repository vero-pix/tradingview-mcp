#!/usr/bin/env node
// =============================================================================
// backtest_aplus_short.cjs — ¿Tiene EDGE el patrón A+ pero A LA BAJA (short)?
//
// Espejo exacto de backtest_aplus.cjs, con la MISMA calibración recalibrada del
// detector (2026-07-02) pero INVERTIDA para operar corto:
//   - Tendencia BAJISTA (EMA9 < EMA21)
//   - Pullback (rebote técnico) al EMA9 DESDE ABAJO
//   - Rechazo con momentum a la baja (mom5 <= -0.6×ATR)
//   - RSI 30-50 (banda espejo de la 50-70 del long)
//   - Stop ARRIBA (2×ATR), Target ABAJO (2×ATR). SHORT SIEMPRE LLEVA STOP.
// Descuenta el spread real de Capital. Filtro de humo: ¿vale la pena o es trampa?
//
// Uso:
//   node scripts/backtest_aplus_short.cjs                 # ETH, ~3000 velas 1m
//   node scripts/backtest_aplus_short.cjs --symbol BTCUSDT --bars 20000
// =============================================================================

const argv = process.argv.slice(2);
function flag(n, d) { const i = argv.indexOf(n); return i !== -1 ? argv[i + 1] : d; }
const SYMBOL = flag("--symbol", "ETHUSDT");
const NBARS  = Number(flag("--bars", "3000"));
const SPREAD = flag("--spread", null) != null ? Number(flag("--spread", null)) : (SYMBOL.startsWith("BTC") ? 50 : 1.75);
const ATR_MULT = 2;
// Umbrales RECALIBRADOS del detector (2026-07-02), espejo para short.
const TREND_ATR = 0.25, PULLBACK_ATR = 0.5, MOM5_ATR = 0.6;
const ER1_MIN = 0.30, ER5_MIN = 0.25, VOLR_MIN = 1.0;
const RSI_LO = 30, RSI_HI = 50;                       // banda espejo (long usa 50-70)
const LIQ_MIN = SYMBOL.startsWith("BTC") ? 8 : 50;

const HOSTS = ["api.binance.com", "data-api.binance.vision", "api1.binance.com"];

// ---- indicadores (mismas fórmulas que calc_indicators.js) ----
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

(async () => {
    console.log(`\nBacktest A+ SHORT · ${SYMBOL} · pidiendo ${NBARS} velas 1m...`);
    const bars = await fetchKlines();
    if (bars.length < 300) { console.error("Pocas velas (" + bars.length + ")"); process.exit(1); }
    const closes = bars.map(b => b.close);
    const dias = ((bars[bars.length - 1].time - bars[0].time) / 86400000).toFixed(1);
    console.log(`Velas: ${bars.length} (~${dias} días). Spread: $${SPREAD}. Stop/Target: ${ATR_MULT}×ATR. Dirección: SHORT.\n`);

    const trades = [];
    let pb = 0, cooldownUntil = 0;
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

        // filtros de contexto INVERTIDOS: tendencia bajista, ER limpio
        if (VA < LIQ_MIN)                { pb = 0; continue; }
        if (ER < ER1_MIN)                { pb = 0; continue; }
        if ((E21 - E9) < TREND_ATR * AT) { pb = 0; continue; }   // EMA9 < EMA21 (bajista)
        if (ER5 < ER5_MIN)               { pb = 0; continue; }
        if ((E9 - P) <= PULLBACK_ATR * AT) pb = 1;               // rebote al EMA9 desde abajo
        // rechazo: precio vuelve bajo EMA9, cayendo con momentum, RSI en banda espejo
        const REB = pb === 1 && M2 <= -1.0 && P <= E9 && R >= RSI_LO && R <= RSI_HI && M5 <= -MOM5_ATR * AT && VR >= VOLR_MIN;

        if (REB && i >= cooldownUntil && AT > 0) {
            const entry = bars[i + 1].open;
            const stop = entry + ATR_MULT * AT, target = entry - ATR_MULT * AT;   // stop ARRIBA, target ABAJO
            let out = null, res = null;
            for (let j = i + 1; j < bars.length; j++) {
                if (bars[j].high >= stop)  { out = stop;   res = "stop";   break; }
                if (bars[j].low <= target) { out = target; res = "target"; break; }
            }
            if (out != null) { trades.push({ res, pnl: (entry - out) - SPREAD }); cooldownUntil = i + 6; pb = 0; }
        }
    }

    // ---- métricas ----
    const n = trades.length;
    if (!n) { console.log("0 señales SHORT en el período. (Sin setups bajistas limpios, o filtros estrictos.)\n"); return; }
    const wins = trades.filter(t => t.pnl > 0), losses = trades.filter(t => t.pnl <= 0);
    const net = trades.reduce((s, t) => s + t.pnl, 0);
    const grossW = wins.reduce((s, t) => s + t.pnl, 0), grossL = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
    const pf = grossL > 0 ? grossW / grossL : Infinity;
    const wr = Math.round(100 * wins.length / n);
    const avgW = wins.length ? grossW / wins.length : 0, avgL = losses.length ? grossL / losses.length : 0;
    const porDia = (n / Number(dias)).toFixed(2);

    console.log(`════ RESULTADO SHORT ════`);
    console.log(`Señales:    ${n}   (~${porDia}/día)`);
    console.log(`Win rate:   ${wr}%   (${wins.length} ganan / ${losses.length} pierden)`);
    console.log(`Neto/unidad: ${net >= 0 ? "+" : ""}$${net.toFixed(2)}   (ya con spread descontado)`);
    console.log(`Profit factor: ${pf === Infinity ? "∞" : pf.toFixed(2)}   ${pf >= 1.3 ? "✅ hay edge" : pf >= 1.0 ? "⚠️ marginal" : "❌ pierde"}`);
    console.log(`Ganada prom: +$${avgW.toFixed(2)}   ·   Perdida prom: -$${avgL.toFixed(2)}\n`);
    console.log(pf >= 1.3
        ? "🟢 El patrón SHORT muestra edge en este período. Ojo: pasado ≠ futuro, pero vale seguir explorando."
        : pf >= 1.0
        ? "🟡 SHORT marginal — el spread se come casi todo. No convence todavía."
        : "🔴 A la baja el patrón NO gana con el spread. Mejor saberlo ahora que con plata. Cripto rema al alza.");
    console.log(`\n(Referencia: el A+ LONG recalibrado da PF ~2,57 en ~20 días. Compara.)`);
})();
