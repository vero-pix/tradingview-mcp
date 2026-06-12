// Detecta proximidad y cruces de precio contra niveles horizontales.
// Entrada por env: PRICE (num), LEVELS (coma-sep), PREV (json estado previo), THRESH (frac, def 0.0015)
// Salida: JSON { state, alerts: [] } por stdout.
const price = parseFloat(process.env.PRICE);
const levels = (process.env.LEVELS || '').split(',').map(s => parseFloat(s)).filter(n => !isNaN(n));
const thresh = parseFloat(process.env.THRESH || '0.0015');
let prev = {};
try { prev = JSON.parse(process.env.PREV || '{}'); } catch (e) { prev = {}; }

const state = {};
const alerts = [];

for (const lvl of levels) {
  const key = lvl.toFixed(2);
  const side = price >= lvl ? 'above' : 'below';
  const near = Math.abs(price - lvl) / price < thresh;
  const p = prev[key] || {};

  // Cruce: cambió de lado respecto al estado previo conocido
  if (p.side && p.side !== side) {
    alerts.push(`🔔 RUPTURA ${key}: precio ${price.toFixed(2)} cruzó ${side === 'above' ? 'al ALZA ↑' : 'a la BAJA ↓'}`);
  } else if (near && !p.near) {
    // Acercamiento nuevo (no estaba cerca antes)
    const d = (price - lvl).toFixed(2);
    alerts.push(`👀 CERCA de ${key}: precio ${price.toFixed(2)} (${d > 0 ? '+' : ''}${d})`);
  }
  state[key] = { side, near };
}

process.stdout.write(JSON.stringify({ state, alerts }));
