#!/usr/bin/env node
// =============================================================================
// telegram_confirm_bot.cjs — Bot de Telegram: avisos + comandos + mantenedor
//
// NOTIFICADOR PURO (sistema Binance-only): el bot avisa por Telegram y responde
// comandos de info (estado, btc, binance, zonas, casi, score…) y controla la
// AUTOCOMPRA automática de Binance vía el mantenedor
// (/auto · /pausar · /reanudar · /size → control/autoexec_control.json).
//
// La compra real la ejecuta `binance_autoexec.cjs` (automática). Este bot NO abre
// órdenes ni pide confirmación de compra.
//
// ⚠️ Seguridad: solo el chat de Vero puede mandar comandos.
//    Modos: --live = producción.
//
// Uso:
//   node scripts/telegram_confirm_bot.cjs --live &        # escucha y avisa
//
// =============================================================================

const fs   = require("fs");
const path = require("path");
const os   = require("os");
const { execSync, execFile } = require("child_process");
const binance = require("./binance_client.cjs");
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const HOME = process.env.HOME;
const DIR  = path.join(HOME, "Trading", "tradingview-mcp");
const NODE = (() => {
    const p = path.join(HOME, ".local/share/fnm/aliases/default/bin/node");
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch (e) { return process.execPath; }
})();

const argv = process.argv.slice(2);
const live = argv.includes("--live");
const demo = argv.includes("--demo");
const MODE = live ? "LIVE" : (demo ? "DEMO" : "DRY-RUN");

// -----------------------------------------------------------------------------
function loadEnv(filePath) {
    const env = {};
    for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
        const t = line.trim();
        if (!t || t.startsWith("#")) continue;
        const [k, ...r] = t.split("=");
        if (k) env[k.trim()] = r.join("=").trim();
    }
    return env;
}
const ENV   = loadEnv(path.join(HOME, "Trading", ".env.telegram"));
const TOKEN = ENV.TELEGRAM_BOT_TOKEN;
const CHAT  = ENV.TELEGRAM_CHAT_ID;
const API   = `https://api.telegram.org/bot${TOKEN}`;

// --- Mantenedor: control de la autocompra (compartido con binance_autoexec) ---
const CONTROL_FILE  = path.join(HOME, "Trading", "control", "autoexec_control.json");
const MANT_LOG      = path.join(HOME, "Trading", "logs", "vero_mantenedor.log");
const SIZE_CAP_HARD = 0.02;
function leerControlAuto() {
    try { return JSON.parse(fs.readFileSync(CONTROL_FILE, "utf8")); }
    catch (e) { return { enabled: true, auto_size: 0.005, max_size: SIZE_CAP_HARD }; }
}
function guardarControlAuto(patch) {
    const c = leerControlAuto();
    const n = Object.assign({}, c, patch, { updated_by: "vero", updated_at: new Date().toISOString() });
    fs.mkdirSync(path.dirname(CONTROL_FILE), { recursive: true });
    fs.writeFileSync(CONTROL_FILE, JSON.stringify(n, null, 2));
    try { fs.appendFileSync(MANT_LOG, `${new Date().toISOString()} ${JSON.stringify(patch)}\n`); } catch (e) {}
    return n;
}
async function panelMantenedor() {
    const c = leerControlAuto();
    let usdtLibre = "?", posEth = "0", comis = "\u2014";
    try {
        const bals = await binance.getBalances();
        usdtLibre = Number((bals.find(b => b.asset === "USDT") || { free: 0 }).free).toFixed(2);
        const eth = bals.find(b => b.asset === "ETH");
        posEth = eth ? Number(eth.locked || 0).toFixed(5) : "0";
        const tr = await binance.getMyTrades("ETHUSDT", 5);
        const ult = tr && tr.length ? tr[tr.length - 1] : null;
        comis = ult ? ult.commissionAsset : "\u2014";
    } catch (e) {}
    const on = c.enabled !== false;
    return `\u2699\ufe0f <b>Mantenedor autocompra</b>\n`
        + `Estado: ${on ? "\ud83d\udfe2 ACTIVA" : "\u23f8 PAUSADA"}\n`
        + `Size: <b>${c.auto_size} ETH</b> (tope ${c.max_size})\n`
        + `USDT libre (Spot): ${usdtLibre}\n`
        + `ETH en OCO abierto: ${posEth}\n`
        + `\u00daltima comisi\u00f3n: ${comis === "BNB" ? "\u2705 BNB (descuento activo)" : comis}`;
}
function botonesMantenedor() {
    return { inline_keyboard: [[
        { text: "\u23f8 Pausar",   callback_data: "mant:pausar" },
        { text: "\u25b6\ufe0f Reanudar", callback_data: "mant:reanudar" },
    ]] };
}

function ts() { return new Date().toISOString().slice(11, 19); }
async function tg(method, body) {
    const r = await fetch(`${API}/${method}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    return r.json();
}

// -----------------------------------------------------------------------------
// Comando "estado": lee el A+ de ETH en vivo (mismos datos y umbrales que el
// detector) y devuelve un resumen para el celular. NO dispara nada, solo informa.
// -----------------------------------------------------------------------------
function num(x, d = 2) { return Number(x).toFixed(d).replace(".", ","); }
function estadoAplus() {
    let v1, v5;
    try {
        v1 = execSync(`BINANCE_SYMBOL=ETHUSDT BINANCE_INTERVAL=1m BINANCE_LIMIT=100 "${NODE}" scripts/ohlcv_binance.js | "${NODE}" scripts/calc_indicators.js`, { cwd: DIR, shell: "/bin/bash" }).toString().trim().split("\n").pop();
        v5 = execSync(`BINANCE_SYMBOL=ETHUSDT BINANCE_INTERVAL=5m BINANCE_LIMIT=100 "${NODE}" scripts/ohlcv_binance.js | "${NODE}" scripts/calc_indicators.js`, { cwd: DIR, shell: "/bin/bash" }).toString().trim().split("\n").pop();
    } catch (e) { return "⚠️ No pude leer los datos ahora. Intenta de nuevo en unos segundos."; }
    const [P, E9, E21, R, M5, M2, ER, VR, VA, AT] = v1.split("|").map(Number);
    const ER5 = Number(v5.split("|")[6]);
    let verd;
    if (VA < 50)            verd = "🔕 Mercado muerto (sin liquidez) — nada que hacer.";
    else if (ER < 0.30)     verd = "🔕 Choppy — sin tendencia clara en 1m. Espera.";
    else if (E9 <= E21)     verd = "🔕 No es alcista (EMA9 bajo EMA21). Solo vamos LONG.";
    else if (ER5 < 0.25)    verd = "🟠 1m con rumbo, pero 5m sin fuerza (contexto débil). Aún no.";
    else {
        const falta = [];
        if (R < 50 || R > 70)     falta.push(R > 70 ? `que el RSI enfríe (${num(R,0)})` : `RSI bajo (${num(R,0)})`);
        if ((P - E9) > 0.5 * AT)  falta.push("un pullback al EMA9");
        if (VR < 1.0)             falta.push(`más volumen (volr ${num(VR)})`);
        if (M5 < 0.6 * AT)        falta.push("impulso del rebote");
        verd = falta.length === 0
            ? "🟢 ALINEADO — todo en su lugar. Si arma, te llega la alerta A+ y la autocompra la toma."
            : "🟡 Se está armando. Falta: " + falta.join(", ") + ".";
    }
    return `📊 <b>ETH $${num(P)}</b> (Binance)\n\n`
         + `RSI ${num(R,0)} · ER1 ${num(ER)} · ER5 ${num(ER5)}\n`
         + `EMA9 ${E9 > E21 ? "▲ sobre" : "▼ bajo"} EMA21 · volr ${num(VR)} · vol ${num(VA,0)}\n\n`
         + verd;
}

function fmt(n) { return (n >= 0 ? "+" : "") + Number(n).toFixed(2); }

// Lee la última línea de indicadores de un símbolo: [P,E9,E21,R,M5,M2,ER,VR,VA,AT]
function indicadores(symbol, interval = "1m") {
    const out = execSync(`BINANCE_SYMBOL=${symbol} BINANCE_INTERVAL=${interval} BINANCE_LIMIT=100 "${NODE}" scripts/ohlcv_binance.js | "${NODE}" scripts/calc_indicators.js`, { cwd: DIR, shell: "/bin/bash" }).toString().trim().split("\n").pop();
    return out.split("|").map(Number);
}

// Comando "btc": lectura de Bitcoin (informativo, no arma orden).
function estadoBTC() {
    try {
        const [P, E9, E21, R, M5, M2, ER, VR] = indicadores("BTCUSDT");
        const ER5 = indicadores("BTCUSDT", "5m")[6];
        return `📊 <b>BTC $${num(P, 1)}</b> (informativo)\n`
             + `RSI ${num(R, 0)} · ER1 ${num(ER)} · ER5 ${num(ER5)}\n`
             + `EMA9 ${E9 > E21 ? "▲ sobre" : "▼ bajo"} EMA21 · volr ${num(VR)}\n\n`
             + `ℹ️ BTC es informativo — no arma orden. Su edge es marginal y el spread se lo come.`;
    } catch (e) { return "⚠️ No pude leer BTC ahora."; }
}

// Comando "binance": posición spot en Binance (donde opera el auto), P&L, protección OCO
// y si la auto-ejecución está encendida.
async function estadoBinance() {
    try {
        const SYM = "ETHUSDT", B = "ETH";
        const [rules, balances, open, price] = await Promise.all([
            binance.getSymbolRules(SYM), binance.getBalances(), binance.getOpenOrders(SYM), binance.getPrice(SYM),
        ]);
        const eth  = balances.find(b => b.asset === B)      || { free: 0, locked: 0 };
        const usdt = balances.find(b => b.asset === "USDT") || { free: 0 };
        const qty  = Number(eth.free) + Number(eth.locked);
        const sells = (open || []).filter(o => o.side === "SELL");
        const stopO = sells.find(o => /STOP/.test(o.type));
        const tpO   = sells.find(o => /LIMIT/.test(o.type) && !/STOP/.test(o.type));

        let t = `🟡 <b>Binance (spot)</b>\nEfectivo: ${num(Number(usdt.free))} USDT\n`;
        if (qty < rules.minQty) {
            t += "Sin posición ETH abierta.";
        } else {
            let entry = null;
            try {
                const tr = await binance.getMyTrades(SYM, 50);
                let acc = 0, cost = 0;
                for (let i = tr.length - 1; i >= 0 && acc < qty; i--) {
                    if (!tr[i].isBuyer) continue;
                    const take = Math.min(Number(tr[i].qty), qty - acc);
                    acc += take; cost += take * Number(tr[i].price);
                }
                entry = acc > 0 ? cost / acc : null;
            } catch (e) {}
            const val = qty * price;
            t += `Posición: ${qty.toFixed(5)} ${B} (~$${val.toFixed(2)})\n`;
            if (entry != null) t += `Entrada ~${num(entry)} · precio ${num(price)}\n`;
            if (entry != null) t += `P&L: ${fmt((price - entry) * qty)} USD\n`;
            t += (stopO || tpO)
                ? `🛡️ Protegida: ${stopO ? "stop " + num(Number(stopO.stopPrice || stopO.price)) : "sin stop"}${tpO ? " / TP " + num(Number(tpO.price)) : ""}`
                : `🔴 DESNUDA (sin stop/TP) — el guardián se lo pone en segundos`;
            t += `\nTotal cuenta: ~$${(Number(usdt.free) + val).toFixed(2)}`;
        }
        try {
            const st = execSync("systemctl is-active vero-binanceautoexec", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
            t += `\n⚡ Auto-ejecución: ${st === "active" ? "ON" : "OFF"}`;
        } catch (e) {}
        return t;
    } catch (e) { return "⚠️ No pude leer Binance: " + e.message; }
}

// Comando "zonas": niveles S/R vigentes, relativos al precio actual.
function zonasStr() {
    try {
        const txt = fs.readFileSync(path.join(DIR, "scripts", "zonas.env"), "utf8");
        const m = txt.match(/ZONAS="([^"]+)"/);
        if (!m) return "No hay zonas configuradas.";
        const niveles = m[1].split(",").map(Number).sort((a, b) => b - a);
        const P = indicadores("ETHUSDT")[0];
        let t = `🗺️ <b>Zonas S/R ETH</b> (precio ${num(P)})`;
        for (const z of niveles) t += `\n${num(z)}  ${z > P ? "🔴 resist." : "🟢 soporte"}  (${z > P ? "+" : ""}${num(z - P)})`;
        if (niveles.every(z => z < P) || niveles.every(z => z > P)) t += `\n\n⚠️ Todas quedaron a un lado — quizás hay que refrescar las zonas.`;
        return t;
    } catch (e) { return "⚠️ No pude leer las zonas."; }
}

// -----------------------------------------------------------------------------
// Comandos de aprendizaje: score · casi · horas · recalibrar · salí · nota
// El modelo SE MIDE solo pero NO se recalibra solo (la decisión es de Vero+Claude).
// -----------------------------------------------------------------------------

// Hora de Chile en formato "YYYY-MM-DD HH:mm:ss" (sv-SE da ese orden ISO).
function ahoraChile() { return new Date().toLocaleString("sv-SE", { timeZone: "America/Santiago" }); }
function horaChile(tsMs) { return new Date(tsMs).toLocaleTimeString("es-CL", { timeZone: "America/Santiago", hour: "2-digit", minute: "2-digit" }); }
function escHtml(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

// Etiquetas legibles de qué filtro faltó (para "casi").
const FALTA_LBL = { mom5: "impulso", volr: "volumen", rsi: "RSI", pullback: "pullback", er: "tendencia 1m", er5: "contexto 5m" };

// Corre un script pesado en BACKGROUND (no congela el poll) y manda su salida a
// Telegram al terminar. `sliceDesde`: recorta el stdout desde esa marca (quita ruido).
function correrYMandar(label, cmd, args, sliceDesde) {
    execFile(cmd, args, { cwd: DIR, maxBuffer: 12 * 1024 * 1024 }, (err, stdout) => {
        let out = String(stdout || "");
        if (sliceDesde) { const i = out.indexOf(sliceDesde); if (i >= 0) out = out.slice(i); }
        out = out.trim();
        const texto = out ? `<pre>${escHtml(out.slice(0, 3500))}</pre>` : `⚠️ No pude generar ${label} ahora.`;
        console.log(`${ts()} 💬 ${label} → respondido${err ? " (con error)" : ""}`);
        tg("sendMessage", { chat_id: CHAT, text: texto, parse_mode: "HTML" }).catch(() => {});
    });
}

// Comando "casi": resumen de casi-señales de las últimas 24h (radar del detector).
// Filtra por `ts` epoch (inequívoco); muestra la hora en Chile.
function casiSenales() {
    try {
        const f = path.join(HOME, "Trading", "casi_senales.jsonl");
        if (!fs.existsSync(f)) return "🔭 Aún no hay registro de casi-señales.";
        const desde = Date.now() - 24 * 3600 * 1000;
        const rows = [];
        for (const l of fs.readFileSync(f, "utf8").trim().split("\n")) {
            try { const o = JSON.parse(l); if (o.ts >= desde) rows.push(o); } catch (e) {}
        }
        if (!rows.length) return "🔭 Sin casi-señales en 24h. Mercado sin setups cercanos.";
        const conteo = {};
        for (const r of rows) for (const x of (r.faltaron || [])) conteo[x] = (conteo[x] || 0) + 1;
        rows.sort((a, b) => b.ts - a.ts);
        const masCerca = rows.filter(r => (r.faltaron || []).length === 1)[0] || rows[0];
        const faltasTxt = Object.entries(conteo).sort((a, b) => b[1] - a[1])
            .map(([k, n]) => `${FALTA_LBL[k] || k} (${n})`).join(" · ");
        const faltoCerca = (masCerca.faltaron || []).map(x => FALTA_LBL[x] || x).join(", ") || "nada";
        return `🔭 <b>Casi-señales (24h): ${rows.length}</b>\n`
             + `La más cerca: ${horaChile(masCerca.ts)} ${String(masCerca.symbol).replace("USDT", "")} — faltó <b>${faltoCerca}</b>\n`
             + `Lo que falta más seguido: ${faltasTxt}\n\n`
             + `ℹ️ El gong suena solo cuando no falta NADA. Esto mide cuán cerca estuvo.`;
    } catch (e) { return "⚠️ No pude leer las casi-señales."; }
}

// Comando "salí 1794": registra una salida hecha a mano (para diario + score).
const DIARIO_MANUAL = path.join(HOME, "Trading", "diario_manual.jsonl");
function registrarSalida(textoOriginal) {
    const m = String(textoOriginal).match(/([0-9]+(?:[.,][0-9]+)?)/);
    if (!m) return "Escríbelo así: <b>salí 1794</b> (el precio al que saliste).";
    const precio = Number(m[1].replace(",", "."));
    fs.appendFileSync(DIARIO_MANUAL, JSON.stringify({ ts: Date.now(), fecha: ahoraChile(), tipo: "salida", precio }) + "\n");
    return `🔴 Salida registrada a <b>$${num(precio)}</b> · ${ahoraChile().slice(0, 16)}\nQueda en tu diario. 👍`;
}

// Comando "nota ...": guarda el porqué de un trade (data que enseña).
function registrarNota(textoOriginal) {
    const nota = String(textoOriginal).replace(/^\s*\/?nota\b\s*/i, "").trim();
    if (!nota) return "Escríbelo así: <b>nota perseguí el envión</b>.";
    fs.appendFileSync(DIARIO_MANUAL, JSON.stringify({ ts: Date.now(), fecha: ahoraChile(), tipo: "nota", texto: nota }) + "\n");
    return `📝 Nota guardada: “${escHtml(nota)}”`;
}

// -----------------------------------------------------------------------------
// Loop de escucha (long polling): comandos y mantenedor
// -----------------------------------------------------------------------------
let offset = 0;
const manejados = new Set();

async function poll() {
    const upd = await tg("getUpdates", { offset, timeout: 8, allowed_updates: ["callback_query", "message"] });
    if (!upd.ok) { console.log(`${ts()} getUpdates error`); await sleep(2000); return; }
    for (const u of upd.result || []) {
        offset = u.update_id + 1;

        // Comando de texto "estado" (solo el chat de Vero): responde la lectura del A+.
        if (u.message && u.message.text) {
            if (String(u.message.chat.id) !== String(CHAT)) continue;
            const t = u.message.text.trim().toLowerCase().replace(/^\//, "");
            let respuesta = null;
            if (t === "estado" || t === "status" || t === "eth")        respuesta = estadoAplus();
            else if (t === "btc" || t === "bitcoin")                    respuesta = estadoBTC();
            else if (t === "binance" || t === "bnb" || t === "bn")      respuesta = await estadoBinance();
            else if (t === "reporte" || t === "report")                respuesta = await estadoBinance();
            else if (t === "zonas" || t === "zona")                     respuesta = zonasStr();
            else if (t === "casi" || t === "cerca")                     respuesta = casiSenales();
            else if (t === "score" || t === "puntaje") {
                respuesta = "🎯 Midiendo el A+ real vs. el backtest…";
                correrYMandar("score", NODE, ["scripts/senales_score.cjs"], "════ SCORE");
            }
            else if (t === "horas" || t === "hora") {
                respuesta = "⏰ Corriendo el backtest por horas (~20s)…";
                correrYMandar("horas", NODE, ["scripts/backtest_horas.cjs"], "════ GLOBAL");
            }
            else if (t === "recalibrar" || t === "recalibra") {
                respuesta = "⚖️ Corriendo la revisión de la config… te llega el veredicto en ~1 min.";
                execFile("/bin/bash", ["scripts/recalibracion_semanal.sh"], { cwd: DIR, maxBuffer: 12 * 1024 * 1024 }, () => {});
            }
            else if (t === "auto" || t === "mantenedor" || t === "control") {
                const panel = await panelMantenedor();
                try { await tg("sendMessage", { chat_id: CHAT, text: panel, parse_mode: "HTML", reply_markup: botonesMantenedor() }); }
                catch (e) { console.log(`${ts()} err auto: ${e.message}`); }
                continue;
            }
            else if (t === "pausar" || t === "pause") {
                guardarControlAuto({ enabled: false });
                respuesta = "\u23f8 <b>Autocompra PAUSADA.</b> No se abren entradas NUEVAS.\n\u26a0\ufe0f Las posiciones abiertas siguen \u2014 su TP/OCO las maneja.";
            }
            else if (t === "reanudar" || t === "resume" || t === "activar") {
                const c = guardarControlAuto({ enabled: true });
                respuesta = `\u25b6\ufe0f <b>Autocompra ACTIVA.</b> size=${c.auto_size} ETH.`;
            }
            else if (t.startsWith("size ")) {
                const v = Number(t.split(/\s+/)[1].replace(",", "."));
                const c0 = leerControlAuto();
                const cap = Number(c0.max_size) > 0 ? c0.max_size : SIZE_CAP_HARD;
                if (!(v > 0))     respuesta = "\u26a0\ufe0f Size inv\u00e1lido. Ej: <b>size 0.003</b>";
                else if (v > cap) respuesta = `\u26d4 ${v} supera el tope duro ${cap} ETH. No lo cambio.`;
                else { const c = guardarControlAuto({ auto_size: v }); respuesta = `\u2705 Size = <b>${c.auto_size} ETH</b>. Aplica a la pr\u00f3xima entrada.`; }
            }
            else if (/^sal[ií]\b/.test(t))                              respuesta = registrarSalida(u.message.text);
            else if (/^nota\b/.test(t))                                 respuesta = registrarNota(u.message.text);
            else if (t === "ayuda" || t === "help" || t === "comandos")
                respuesta = "🤖 <b>Comandos</b>\n"
                    + "📊 <b>estado</b> · <b>btc</b> · <b>binance</b> · <b>reporte</b> (Binance) · <b>zonas</b>\n"
                    + "🎯 <b>score</b> — rinde vs backtest · 🔭 <b>casi</b> — casi-señales de hoy\n"
                    + "⏰ <b>horas</b> — mejores horas · ⚖️ <b>recalibrar</b> — revisa la config\n"
                    + "⚙️ <b>auto</b> — panel autocompra · <b>pausar</b> / <b>reanudar</b> / <b>size 0.003</b>\n"
                    + "🔴 <b>salí 1794</b> — registra una salida · 📝 <b>nota …</b> — deja el porqué";
            if (respuesta) {
                console.log(`${ts()} 💬 comando ${t}`);
                try { await tg("sendMessage", { chat_id: CHAT, text: respuesta, parse_mode: "HTML" }); }
                catch (e) { console.log(`${ts()} err ${t}: ${e.message}`); }
            }
            continue;
        }

        const cq = u.callback_query;
        if (!cq) continue;
        if (String(cq.message.chat.id) !== String(CHAT)) {
            await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "No autorizado" }); continue;
        }
        const [action, id] = String(cq.data).split(":");
        if (action === "mant") {
            const on = id === "reanudar";
            const c = guardarControlAuto({ enabled: on });
            await tg("answerCallbackQuery", { callback_query_id: cq.id, text: on ? "Reanudada \u25b6\ufe0f" : "Pausada \u23f8" });
            const panel = await panelMantenedor();
            try { await tg("editMessageText", { chat_id: CHAT, message_id: cq.message.message_id, text: panel, parse_mode: "HTML", reply_markup: botonesMantenedor() }); } catch (e) {}
            console.log(`${ts()} \u2699\ufe0f mantenedor -> ${on ? "ACTIVA" : "PAUSA"} (size ${c.auto_size})`);
            continue;
        }
        // Cualquier otro callback es de un mensaje viejo (la ruta de botones de
        // compra se retiró con el bróker viejo): se acusa recibo y nada más.
        if (manejados.has(id)) { await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Ya procesado" }); continue; }
        manejados.add(id);
        await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Botón retirado — la compra la maneja /auto" });
    }
}

(async () => {
    if (!TOKEN || !CHAT) { console.error("Faltan credenciales de Telegram"); process.exit(1); }
    console.log(`${ts()} bot arrancado · modo ${MODE}`);

    while (true) {
        try { await poll(); } catch (e) { console.log(`${ts()} err poll: ${e.message}`); await sleep(2000); }
    }
})();
