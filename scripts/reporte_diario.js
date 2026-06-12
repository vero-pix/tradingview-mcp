#!/usr/bin/env node
// Genera el reporte diario de trading de Vero a partir del CSV más reciente de
// Capital.com en ~/Downloads (leveraged_trades_history_DD.MM.YYYY.csv).
// Imprime el texto del reporte a stdout (lo manda por Telegram el wrapper .sh).
//
// Detecta: métricas, errores/patrones (promediar, sin stop, fat-fingers) y tips.

import fs from "fs";
import os from "os";
import path from "path";

const DL = path.join(os.homedir(), "Downloads");

function findLatestCsv() {
  const files = fs.readdirSync(DL)
    .filter(f => /^leveraged_trades_history_\d{2}\.\d{2}\.\d{4}\.csv$/.test(f))
    .map(f => ({ f, t: fs.statSync(path.join(DL, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return files.length ? path.join(DL, files[0].f) : null;
}

function parseLine(l) {
  return (l.match(/("([^"]*)"|[^,]*)/g) || []).filter((_, i) => i % 2 === 0)
    .map(s => s.replace(/^"|"$/g, ""));
}

function main() {
  const csv = findLatestCsv();
  if (!csv) { console.log("📊 Reporte: no encontré CSV de trades en Descargas. Descarga el historial de Capital.com para el próximo reporte."); return; }

  const lines = fs.readFileSync(csv, "utf8").trim().split("\n");
  const hdr = lines[0].split(",");
  const ix = n => hdr.indexOf(n);
  const iStatus = ix("Status"), iRpl = ix("rpl"), iQty = ix("Quantity"),
        iPrice = ix("Price"), iSym = ix("Instrument Symbol"), iSL = ix("Stop Loss"),
        iTime = ix("Timestamp (UTC)"), iType = ix("Execution Type");

  const closed = [], opened = [];
  for (let i = 1; i < lines.length; i++) {
    const f = parseLine(lines[i]);
    const row = { st: f[iStatus], rpl: parseFloat(f[iRpl] || "0"), qty: f[iQty],
                  px: parseFloat(f[iPrice]), sym: f[iSym], sl: f[iSL], time: f[iTime] };
    if (row.st === "CLOSED") closed.push(row);
    else if (row.st === "OPENED") opened.push(row);
  }

  if (!closed.length) { console.log("📊 Reporte del día: sin operaciones cerradas registradas."); return; }

  // separar fat-fingers (instrumento != ETH/USD)
  const ethClosed = closed.filter(t => t.sym === "ETH/USD");
  const fatFingers = closed.filter(t => t.sym !== "ETH/USD");

  const net = ethClosed.reduce((a, t) => a + t.rpl, 0);
  const wins = ethClosed.filter(t => t.rpl > 0);
  const losses = ethClosed.filter(t => t.rpl < 0);
  const sumW = wins.reduce((a, t) => a + t.rpl, 0);
  const sumL = losses.reduce((a, t) => a + t.rpl, 0);
  const best = Math.max(...ethClosed.map(t => t.rpl));
  const worst = Math.min(...ethClosed.map(t => t.rpl));
  const wr = Math.round(wins.length / ethClosed.length * 100);
  const avgW = wins.length ? sumW / wins.length : 0;
  const avgL = losses.length ? sumL / losses.length : 0;

  const fecha = (ethClosed[0].time || "").slice(0, 10);
  const L = [];
  L.push(`📊 REPORTE DE TRADING — ${fecha}`);
  L.push("");
  L.push("— MÉTRICAS —");
  L.push(`Resultado neto: ${net >= 0 ? "+" : ""}${net.toFixed(2)} USD ${net >= 0 ? "🟢" : "🔴"}`);
  L.push(`Trades: ${ethClosed.length} (${wins.length}✓ / ${losses.length}✗) · Win rate: ${wr}%`);
  L.push(`Ganancias: +${sumW.toFixed(2)} · Pérdidas: ${sumL.toFixed(2)}`);
  L.push(`Mejor: +${best.toFixed(2)} · Peor: ${worst.toFixed(2)}`);
  L.push(`Prom. ganador: +${avgW.toFixed(2)} · Prom. perdedor: ${avgL.toFixed(2)}`);

  // — PATRONES / ERRORES —
  const flags = [];
  // sin stop loss
  const sinSL = ethClosed.filter(t => !t.sl || t.sl === "").length;
  if (sinSL === ethClosed.length) flags.push("⚠️ Operaste SIN stop loss en todos los trades (riesgo alto sin red).");
  // pérdidas más grandes que ganancias
  if (avgW > 0 && Math.abs(avgL) > avgW * 1.3) flags.push(`⚠️ Tus pérdidas promedio (${avgL.toFixed(2)}) son más grandes que tus ganancias (${avgW.toFixed(2)}). El sistema sano es al revés.`);
  // promediar: 3+ aperturas en ventana corta
  if (opened.length >= 3) {
    const times = opened.map(o => new Date(o.time).getTime()).sort((a, b) => a - b);
    let cluster = 1, maxCluster = 1;
    for (let i = 1; i < times.length; i++) {
      if (times[i] - times[i - 1] < 5 * 60 * 1000) cluster++; else cluster = 1;
      maxCluster = Math.max(maxCluster, cluster);
    }
    if (maxCluster >= 3) flags.push(`⚠️ Abriste ${maxCluster} posiciones en <5 min (promediaste). Ojo: promediar sin stop es lo que más te ha costado.`);
  }
  // fat fingers
  if (fatFingers.length) flags.push(`🤓 ${fatFingers.length} trade(s) en otro instrumento (¿fat-finger?) — no cuentan a tus stats de ETH.`);

  L.push("");
  L.push("— PATRONES / ERRORES —");
  if (flags.length) flags.forEach(f => L.push(f)); else L.push("✅ Sin patrones de riesgo detectados hoy. ¡Bien!");

  // — TIPS —
  L.push("");
  L.push("— APRENDIZAJE —");
  if (net < 0 && Math.abs(sumL) > sumW) L.push("Hoy las pérdidas se comieron las ganancias. Revisa: ¿entraste contra el VWAP? ¿promediaste?");
  if (wr >= 60 && net > 0) L.push("Buen win rate y verde — operaste con método. Sigue así.");
  L.push("Regla de oro: nunca promediar contra el VWAP sin stop.");
  L.push("Mejor esperar el pullback que perseguir el techo.");

  L.push("");
  L.push("💬 El refinamiento del sistema lo vemos en el chat con Claude. Abre la sesión y dime \"reporte\".");

  console.log(L.join("\n"));
}

try { main(); } catch (e) { console.log("📊 Reporte: error generando (" + e.message + ")"); }
