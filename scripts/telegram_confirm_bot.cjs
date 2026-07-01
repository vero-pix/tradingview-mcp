#!/usr/bin/env node
// =============================================================================
// telegram_confirm_bot.cjs — Bot de Telegram con botones ✅ Comprar / ❌ Paso
//
// Cuando el detector arma una señal A+, este bot manda a Telegram un mensaje con
// dos botones. Vero toca ✅ desde el celular y el bot ABRE la operación bracketeada
// (stop + take-profit + tamaño chico). Toca ❌ y se cancela.
//
// ⚠️ Seguridad: solo el chat de Vero (TELEGRAM_CHAT_ID) puede confirmar.
//    Modos: sin flags = DRY-RUN (no opera, solo dice qué haría). --demo = cuenta
//    demo. --live = cuenta real. Empezamos SIEMPRE en demo/dry-run.
//
// Uso:
//   node scripts/telegram_confirm_bot.cjs --test          # manda botones de prueba
//   node scripts/telegram_confirm_bot.cjs --demo &        # escucha y opera en demo
//   node scripts/telegram_confirm_bot.cjs --live &        # (más adelante) real
//
// La señal a proponer se lee de /tmp/vero_pending_order.json (la escribe el
// detector). Formato: {epic, size, entry, stop, tp, ts}.
// =============================================================================

const fs   = require("fs");
const path = require("path");
const os   = require("os");
const capital = require("./capital_client.cjs");

const HOME = process.env.HOME;
const DIR  = path.join(HOME, "Trading", "tradingview-mcp");
const PENDING_FILE = path.join(os.tmpdir(), "vero_pending_order.json");

const argv = process.argv.slice(2);
const test = argv.includes("--test");
const live = argv.includes("--live");
const demo = argv.includes("--demo");
const MODE = live ? "LIVE" : (demo ? "DEMO" : "DRY-RUN");

// -----------------------------------------------------------------------------
// Credenciales de Telegram desde .env.telegram
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
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });
    return r.json();
}

// Manda el mensaje con botones para una señal (id = referencia única)
async function sendButtons(id, text) {
    return tg("sendMessage", {
        chat_id: CHAT,
        text,
        reply_markup: { inline_keyboard: [[
            { text: "✅ Comprar", callback_data: "buy:" + id },
            { text: "❌ Paso",    callback_data: "skip:" + id },
        ]]},
    });
}

// -----------------------------------------------------------------------------
// Ejecutar la compra al confirmar (según MODE)
// -----------------------------------------------------------------------------
async function ejecutarCompra(order) {
    if (MODE === "DRY-RUN") {
        return { ok: true, msg: `[DRY-RUN] habría abierto ${order.size} ${order.epic} @~${order.entry}, stop ${order.stop}, TP ${order.tp}` };
    }
    // Validar que el precio no se disparó (no perseguir)
    const useDemo = MODE === "DEMO";
    await capital.selectAccount("USD 2", { demo: useDemo });
    const mkt = await capital.getMarket(order.epic, { demo: useDemo });
    if (mkt.offer > order.entry + 2) {
        return { ok: false, msg: `Precio ya se fue (${mkt.offer} > entrada+$2). No persigo. Cancelado.` };
    }
    const r = await capital.openPosition({
        epic: order.epic, direction: "BUY", size: order.size,
        stopLevel: order.stop, profitLevel: order.tp, offer: mkt.offer, demo: useDemo,
    });
    if (r.ok) return { ok: true, msg: `✅ Abierto ${order.size} @ ${r.level}, stop ${order.stop}, TP ${order.tp} (dealId ${r.dealId})` };
    return { ok: false, msg: `Rechazado: ${r.reason || r.dealStatus}` };
}

// -----------------------------------------------------------------------------
// Loop de escucha (long polling)
// -----------------------------------------------------------------------------
let offset = 0;
const manejados = new Set();   // ids ya confirmados/cancelados (una sola vez)

async function poll() {
    const upd = await tg("getUpdates", { offset, timeout: 30, allowed_updates: ["callback_query"] });
    if (!upd.ok) { console.log(`${ts()} getUpdates error: ${JSON.stringify(upd).slice(0,120)}`); await capital.sleep(2000); return; }
    for (const u of upd.result || []) {
        offset = u.update_id + 1;
        const cq = u.callback_query;
        if (!cq) continue;
        // Seguridad: solo el chat de Vero
        if (String(cq.message.chat.id) !== String(CHAT)) {
            await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "No autorizado" });
            continue;
        }
        const [action, id] = String(cq.data).split(":");
        if (manejados.has(id)) {
            await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Ya procesado" });
            continue;
        }
        manejados.add(id);

        if (action === "skip") {
            await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Cancelado ❌" });
            await tg("editMessageText", { chat_id: CHAT, message_id: cq.message.message_id,
                text: cq.message.text + "\n\n❌ CANCELADO por ti." });
            console.log(`${ts()} ❌ PASO (id ${id})`);
            continue;
        }
        if (action === "buy") {
            await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Confirmado ✅ ejecutando..." });
            console.log(`${ts()} ✅ COMPRAR (id ${id}) — modo ${MODE}`);
            let order = null;
            if (test) {
                order = { epic: "ETHUSD", size: 0.01, entry: 1600, stop: 1594, tp: 1608 };
            } else {
                try { order = JSON.parse(fs.readFileSync(PENDING_FILE, "utf8")); } catch (e) {}
            }
            let res;
            if (!order) res = { ok: false, msg: "No había orden armada (pending vacío)." };
            else { try { res = await ejecutarCompra(order); } catch (e) { res = { ok: false, msg: "Error: " + e.message }; } }
            await tg("editMessageText", { chat_id: CHAT, message_id: cq.message.message_id,
                text: cq.message.text + "\n\n" + (res.ok ? "✅ " : "⚠️ ") + res.msg });
            console.log(`${ts()}   → ${res.msg}`);
        }
    }
}

(async () => {
    if (!TOKEN || !CHAT) { console.error("Faltan TELEGRAM_BOT_TOKEN/CHAT_ID en .env.telegram"); process.exit(1); }
    console.log(`${ts()} bot de confirmación arrancado · modo ${MODE}${test ? " · TEST" : ""}`);

    if (test) {
        const id = "test1";
        const r = await sendButtons(id, "🟢 PRUEBA · Señal A+ ETH\nentrada ~1600 · stop 1594 · objetivo 1608 · size 0.01\n\n¿Confirmas la compra?");
        console.log(`${ts()} mensaje de prueba enviado (${r.ok ? "ok" : JSON.stringify(r).slice(0,100)}). Toca ✅ o ❌ en Telegram...`);
    }

    while (true) {
        try { await poll(); } catch (e) { console.log(`${ts()} error poll: ${e.message}`); await capital.sleep(2000); }
    }
})();
