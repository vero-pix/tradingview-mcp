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
const { execFileSync } = require("child_process");
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
// Ejecuta la compra reusando capital_order.cjs buy (todos los guardrails y el
// bracket real en precio Capital). Devuelve {ok, msg}.
// -----------------------------------------------------------------------------
function ejecutarCompra(epic) {
    const args = ["scripts/capital_order.cjs", "buy", "--size", String(SIZE), "--epic", epic || EPIC];
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
    const stopHint = data.stop ? ` · stop ~${data.stop}` : "";
    const tpHint   = data.tp ? ` · objetivo ~${data.tp}` : "";
    const txt = `🟢 SEÑAL A+ · ${data.epic || EPIC}\n`
        + `entrada ~${entry}${stopHint}${tpHint} · size ${SIZE}\n`
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
    const upd = await tg("getUpdates", { offset, timeout: 8, allowed_updates: ["callback_query"] });
    if (!upd.ok) { console.log(`${ts()} getUpdates error`); await capital.sleep(2000); return; }
    for (const u of upd.result || []) {
        offset = u.update_id + 1;
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
                    res = ejecutarCompra(pending.epic);
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
