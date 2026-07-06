#!/usr/bin/env node
// =============================================================================
// telegram_confirm_bot.cjs — Bot de Telegram con botones ✅ Comprar / ❌ Paso
//
// Cuando el detector arma una señal A+ (escribe /tmp/vero_pending_order.json),
// el bot manda a Telegram un mensaje con dos botones. Vero toca ✅ desde el
// celular (dentro de la ventana de validez) y el bot ABRE la operación
// bracketeada reusando `capital_order.cjs buy` (stop + take-profit + guardrails).
//
// ⚠️ Seguridad: solo el chat de Vero puede confirmar.
//    Modos: sin flags = DRY-RUN (no opera). --demo = cuenta demo. --live = real.
//    Antes de ejecutar valida: ventana de tiempo + que el precio no se disparó.
//
// Uso:
//   node scripts/telegram_confirm_bot.cjs --test          # botones de prueba
//   node scripts/telegram_confirm_bot.cjs --demo &        # escucha, opera en demo
//   node scripts/telegram_confirm_bot.cjs --live &        # (real, con topes)
//
// Env: BOT_SIZE (default 0.3), BOT_WINDOW_MIN (default 5), MAX_CHASE_USD (default 2).
// =============================================================================

const fs   = require("fs");
const path = require("path");
const os   = require("os");
const { execFileSync, execSync } = require("child_process");
const capital = require("./capital_client.cjs");

const HOME = process.env.HOME;
const DIR  = path.join(HOME, "Trading", "tradingview-mcp");
// El detector escribe los pendings en /tmp (literal) — el bot los busca ahí mismo.
// Un archivo por instrumento: /tmp/vero_pending_<EPIC>.json (más el legacy _order).
const PENDING_DIR = "/tmp";
function pendingFiles() {
    try { return fs.readdirSync(PENDING_DIR)
        .filter(f => /^vero_pending_.+\.json$/.test(f))
        .map(f => path.join(PENDING_DIR, f)); } catch (e) { return []; }
}
const NODE = (() => {
    const p = path.join(HOME, ".local/share/fnm/aliases/default/bin/node");
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch (e) { return process.execPath; }
})();

const argv = process.argv.slice(2);
const test = argv.includes("--test");
const live = argv.includes("--live");
const demo = argv.includes("--demo");
const MODE = live ? "LIVE" : (demo ? "DEMO" : "DRY-RUN");

const SIZE       = process.env.BOT_SIZE       != null ? Number(process.env.BOT_SIZE)       : 0.3;
const WINDOW_MS  = (process.env.BOT_WINDOW_MIN != null ? Number(process.env.BOT_WINDOW_MIN) : 5) * 60000;
const MAX_CHASE  = process.env.MAX_CHASE_USD  != null ? Number(process.env.MAX_CHASE_USD)  : 2;
const EPIC       = process.env.EPIC || "ETHUSD";
// Exposición objetivo en USD (size × precio). Para ETH, 0.1 ≈ $160. Se usa para
// escalar el size en OTROS instrumentos (BTC 0.1 = $6000 sería enorme).
const NOTIONAL   = process.env.BOT_NOTIONAL_USD != null ? Number(process.env.BOT_NOTIONAL_USD) : 160;

// --- TOPES DUROS: hasta ahora `freno` solo AVISABA (sonido/Telegram) pero nada
// impedía que se abriera la orden igual. Acá el bloqueo es MECÁNICO: si se pasa
// el tope, el bot RECHAZA el ✅ antes de llamar a capital_order.cjs. Mismos
// valores por defecto que capital_freno.cjs, para que avisen y bloqueen igual.
const MAX_POS       = process.env.MAX_POS != null ? Number(process.env.MAX_POS) : 2;
const DAILY_MAX_LOSS = process.env.DAILY_MAX_LOSS != null ? Number(process.env.DAILY_MAX_LOSS) : 20;
const ACCOUNT_CB    = process.env.ACCOUNT || "USD 2";

// Devuelve null si puede operar, o un string con el motivo del bloqueo.
async function chequearTopesDuros() {
    try {
        await capital.selectAccount(ACCOUNT_CB, { demo: MODE === "DEMO" });
        const positions = await capital.getPositions({ demo: MODE === "DEMO" });
        if ((positions || []).length >= MAX_POS) {
            return `🔴 TOPE DURO: ya tienes ${positions.length} posiciones abiertas (máx ${MAX_POS}). No abro otra — cierra o espera antes de sumar riesgo.`;
        }
        const r = await capital.apiCall("GET", "/api/v1/history/transactions?lastPeriod=86400", { demo: MODE === "DEMO" });
        const tx = ((r.data && r.data.transactions) || []).filter(t => t.transactionType === "TRADE" && /clos/i.test(t.note || ""));
        const netHoy = tx.reduce((s, t) => s + Number(t.size), 0);
        if (netHoy <= -DAILY_MAX_LOSS) {
            return `🔴 TOPE DURO: pérdida del día ya en $${netHoy.toFixed(2)} (límite -$${DAILY_MAX_LOSS}). Se acabó operar por hoy — mañana con la cabeza fresca.`;
        }
        return null;
    } catch (e) {
        // si no se puede verificar, MEJOR bloquear que operar a ciegas
        return `⚠️ No pude verificar los topes (${e.message}) — por seguridad, no ejecuto. Reintenta o revisa a mano.`;
    }
}

// Tamaño por instrumento: BOT_SIZE_<EPIC> fija; ETHUSD usa SIZE; otros = notional/precio.
function sizeFor(epic, price, minDeal) {
    const ov = process.env["BOT_SIZE_" + epic];
    if (ov != null) return Number(ov);
    if (epic === "ETHUSD" || !price) return SIZE;
    let s = NOTIONAL / price;
    if (minDeal) s = Math.max(minDeal, Math.round(s / minDeal) * minDeal);
    return +s.toFixed(6);
}

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

function ts() { return new Date().toISOString().slice(11, 19); }
async function tg(method, body) {
    const r = await fetch(`${API}/${method}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    return r.json();
}
async function sendButtons(id, text) {
    return tg("sendMessage", { chat_id: CHAT, text, reply_markup: { inline_keyboard: [[
        { text: "✅ Comprar", callback_data: "buy:" + id },
        { text: "❌ Paso",    callback_data: "skip:" + id },
    ]]}});
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
    const capBuy = P + 1.75;   // ask Capital ≈ Binance + spread
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
            ? "🟢 ALINEADO — todo en su lugar. Si arma, te llega la señal con botones ✅/❌."
            : "🟡 Se está armando. Falta: " + falta.join(", ") + ".";
    }
    return `📊 <b>ETH $${num(P)}</b> (Binance)\n`
         + `En Capital comprar ≈ $${num(capBuy)}\n\n`
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

// Comando "posicion": ¿hay algo abierto en Capital y cómo va?
async function posicionCapital() {
    try {
        const { positions, pnl } = await capital.getEthPosition({ demo: false, epic: "ETHUSD", account: "USD 2" });
        if (!positions.length) return "📭 Sin posiciones abiertas en ETH (Capital).";
        return `📈 <b>${pnl.count} lote(s) ETH abiertos</b>\n`
             + `Entrada prom: ${pnl.weightedAvgEntry}\n`
             + `P&L: ${fmt(pnl.unrealizedPnl)} USD (${fmt(pnl.pnlPct)}%)\n`
             + `Bid ahora: ${pnl.bid}`
             + (pnl.count > 2 ? `\n\n⚠️ ${pnl.count} lotes — pasaste el máx sano (2). Cuidado con sobre-operar.` : "");
    } catch (e) { return "⚠️ No pude leer tu posición: " + e.message; }
}

// Comando "reporte": resumen del día (reusa capital_reporte.cjs).
function reporteDia() {
    try { return execSync(`"${NODE}" scripts/capital_reporte.cjs`, { cwd: DIR }).toString().trim(); }
    catch (e) { return "⚠️ No pude generar el reporte ahora."; }
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
// Ejecuta la compra reusando capital_order.cjs buy (todos los guardrails y el
// bracket real en precio Capital). Devuelve {ok, msg}.
// -----------------------------------------------------------------------------
function ejecutarCompra(epic, size) {
    const args = ["scripts/capital_order.cjs", "buy", "--size", String(size || SIZE), "--epic", epic || EPIC];
    if (MODE === "DEMO") args.push("--demo", "--live", "--yes");
    else if (MODE === "LIVE") args.push("--live", "--yes");
    // DRY-RUN: sin --live → capital_order imprime lo que haría, no opera
    try {
        const out = execFileSync(NODE, args, { cwd: DIR, encoding: "utf8" });
        const ok = /LONG ABIERTO|\[DRY-RUN\]/.test(out);
        const linea = out.split("\n").find(l => /LONG ABIERTO|RECHAZAD|\[DRY-RUN\]/i.test(l))
            || out.trim().split("\n").slice(-1)[0];
        return { ok, msg: (MODE === "DRY-RUN" ? "[DRY-RUN] " : "") + (linea || "sin salida").trim() };
    } catch (e) {
        const o = (e.stdout || "") + (e.stderr || e.message || "");
        return { ok: false, msg: "No se ejecutó: " + String(o).replace(/\s+/g, " ").trim().slice(0, 200) };
    }
}

// -----------------------------------------------------------------------------
// Estado de la señal pendiente
// -----------------------------------------------------------------------------
const pendings = new Map();    // id → {id, ts, entry, epic, msgId} (varias señales a la vez)
const enviados = new Set();    // ids ya mandados (no re-enviar)

// Revisa los archivos pending (uno por instrumento); si hay una señal NUEVA, manda botones.
async function revisarPending() {
    for (const file of pendingFiles()) {
        try { await procesarPending(JSON.parse(fs.readFileSync(file, "utf8"))); } catch (e) {}
    }
}
async function procesarPending(data) {
    if (!data || !data.id) return;
    if (enviados.has(data.id)) return;                       // ya la mandamos, no repetir
    // No mandar señales viejas (ej. pending que quedó de antes): solo dentro de la ventana
    const edad = Date.now() - (data.ts || 0);
    if (edad > WINDOW_MS) { enviados.add(data.id); return; }

    const entry = Number(data.entry);
    const epic  = data.epic || EPIC;
    const szDisplay = sizeFor(epic, entry, null);
    const stopHint = data.stop ? ` · stop ~${data.stop}` : "";
    const tpHint   = data.tp ? ` · objetivo ~${data.tp}` : "";
    const txt = `🟢 SEÑAL A+ · ${epic}\n`
        + `entrada ~${entry}${stopHint}${tpHint} · size ~${szDisplay}\n`
        + `Ventana: ${Math.round(WINDOW_MS / 60000)} min. ¿Confirmas la compra?`;
    const r = await sendButtons(data.id, txt);
    enviados.add(data.id);
    pendings.set(data.id, { id: data.id, ts: data.ts || Date.now(), entry, epic: data.epic || EPIC, msgId: r.result && r.result.message_id });
    console.log(`${ts()} 📨 señal ${data.id} enviada a Telegram (entrada ~${entry})`);
}

// -----------------------------------------------------------------------------
// Loop de escucha (long polling) + revisión de pending
// -----------------------------------------------------------------------------
let offset = 0;
const manejados = new Set();

async function poll() {
    const upd = await tg("getUpdates", { offset, timeout: 8, allowed_updates: ["callback_query", "message"] });
    if (!upd.ok) { console.log(`${ts()} getUpdates error`); await capital.sleep(2000); return; }
    for (const u of upd.result || []) {
        offset = u.update_id + 1;

        // Comando de texto "estado" (solo el chat de Vero): responde la lectura del A+.
        if (u.message && u.message.text) {
            if (String(u.message.chat.id) !== String(CHAT)) continue;
            const t = u.message.text.trim().toLowerCase().replace(/^\//, "");
            let respuesta = null;
            if (t === "estado" || t === "status" || t === "eth")        respuesta = estadoAplus();
            else if (t === "btc" || t === "bitcoin")                    respuesta = estadoBTC();
            else if (t === "posicion" || t === "posición" || t === "pos") respuesta = await posicionCapital();
            else if (t === "reporte" || t === "report")                respuesta = reporteDia();
            else if (t === "zonas" || t === "zona")                     respuesta = zonasStr();
            else if (t === "ayuda" || t === "help" || t === "comandos") respuesta = "🤖 Comandos: <b>estado</b> · <b>btc</b> · <b>posicion</b> · <b>reporte</b> · <b>zonas</b>";
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
        if (manejados.has(id)) { await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Ya procesado" }); continue; }
        manejados.add(id);

        if (action === "skip") {
            await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Cancelado ❌" });
            await tg("editMessageText", { chat_id: CHAT, message_id: cq.message.message_id, text: cq.message.text + "\n\n❌ CANCELADO por ti." });
            console.log(`${ts()} ❌ PASO (id ${id})`);
            pendings.delete(id);
            continue;
        }
        if (action !== "buy") continue;

        await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Verificando..." });
        console.log(`${ts()} ✅ COMPRAR (id ${id}) — modo ${MODE}`);

        // TOPES DUROS: se chequean ANTES de cualquier otra cosa, incluso antes de
        // mirar la ventana/precio. Si un tope está pasado, no se ejecuta — punto.
        if (!test && (MODE === "LIVE" || MODE === "DEMO")) {
            const bloqueo = await chequearTopesDuros();
            if (bloqueo) {
                await tg("editMessageText", { chat_id: CHAT, message_id: cq.message.message_id, text: cq.message.text + "\n\n" + bloqueo });
                console.log(`${ts()}   → BLOQUEADO por tope duro: ${bloqueo}`);
                pendings.delete(id);
                continue;
            }
        }

        const pend = pendings.get(id);
        let res;
        if (test) {
            res = ejecutarCompra(EPIC);   // en test igual ejecuta (dry-run si no hay --live)
        } else if (!pend) {
            res = { ok: false, msg: "Señal ya no está activa." };
        } else if (Date.now() - pend.ts > WINDOW_MS) {
            res = { ok: false, msg: `Caducó (pasaron más de ${Math.round(WINDOW_MS/60000)} min).` };
        } else {
            // no perseguir: el precio no debe haberse ido > MAX_CHASE sobre la entrada de la señal.
            // MAX_CHASE se escala al instrumento (BTC ~$60k no puede usar $2 fijo).
            try {
                const pending = pend;
                const mkt = await capital.getMarket(pending.epic, { demo: MODE === "DEMO" });
                const chaseLimit = Math.max(MAX_CHASE, pending.entry * 0.0013);   // ~0.13% del precio
                if (mkt.offer > pending.entry + chaseLimit) {
                    res = { ok: false, msg: `Ya se fue (${mkt.offer} > entrada+${chaseLimit.toFixed(2)}). No persigo.` };
                } else {
                    const sz = sizeFor(pending.epic, mkt.offer, mkt.minDealSize);
                    res = ejecutarCompra(pending.epic, sz);
                }
            } catch (e) { res = { ok: false, msg: "Error validando precio: " + e.message }; }
        }
        await tg("editMessageText", { chat_id: CHAT, message_id: cq.message.message_id,
            text: cq.message.text + "\n\n" + (res.ok ? "✅ " : "⚠️ ") + res.msg });
        console.log(`${ts()}   → ${res.msg}`);
        pendings.delete(id);
    }
}

(async () => {
    if (!TOKEN || !CHAT) { console.error("Faltan credenciales de Telegram"); process.exit(1); }
    console.log(`${ts()} bot de confirmación arrancado · modo ${MODE} · size ${SIZE} · ventana ${Math.round(WINDOW_MS/60000)}min${test ? " · TEST" : ""}`);

    if (test) {
        // señal de prueba: escribe un pending falso para ejercitar todo el flujo
        fs.writeFileSync(PENDING_FILE, JSON.stringify({ id: "test-" + Math.floor(Date.now()/1000), ts: Date.now(), epic: "ETHUSD", entry: 1600, stop: 1594, tp: 1608 }));
    }

    while (true) {
        try { await revisarPending(); } catch (e) { console.log(`${ts()} err pending: ${e.message}`); }
        try { await poll(); } catch (e) { console.log(`${ts()} err poll: ${e.message}`); await capital.sleep(2000); }
    }
})();
