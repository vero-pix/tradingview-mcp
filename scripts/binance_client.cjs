// =============================================================================
// binance_client.cjs — Cliente REST de Binance Spot (LECTURA + ÓRDENES)
//
// Gemelo de capital_client.cjs pero para Binance. Firma cada request protegido
// con HMAC-SHA256 (API key + secret) y expone precio, balances, órdenes, OCO
// (stop + take-profit en UNA orden nativa) y trades cerrados.
//
// ⚠️ SEGURIDAD:
//   - Las llaves salen SOLO de ~/Trading/.env.binance (fuera del repo, gitignored).
//   - La llave de API debe crearse SIN permiso de retiro (solo "Spot Trading").
//   - Por defecto apunta al TESTNET (testnet.binance.vision) — dinero falso, sin
//     KYC. Para operar en real: BINANCE_TESTNET=0 en el .env, con llaves reales.
//
// Uso como módulo:
//   const bn = require("./binance_client.cjs");
//   await bn.getPrice("ETHUSDT");            // precio spot (no necesita llaves)
//   await bn.getBalances();                  // balances (firmado)
//   await bn.placeMarketBuy("ETHUSDT", 0.01);
//   await bn.placeOcoSell("ETHUSDT", 0.01, { tp: 2000, stop: 1950 });
//
// Env (.env.binance): BINANCE_API_KEY, BINANCE_SECRET, BINANCE_TESTNET (1/0).
// =============================================================================

const https  = require("https");
const crypto  = require("crypto");
const fs      = require("fs");
const path    = require("path");

const HOST_LIVE    = "api.binance.com";
const HOST_TESTNET = "testnet.binance.vision";
const RECV_WINDOW  = 5000;   // ms de tolerancia del reloj para requests firmados

// -----------------------------------------------------------------------------
// Credenciales desde ~/Trading/.env.binance (mismo parser que capital_client)
// -----------------------------------------------------------------------------
function loadEnv(filePath) {
    const env = {};
    let raw;
    try { raw = fs.readFileSync(filePath, "utf8"); } catch (e) { return env; }
    for (const line of raw.split("\n")) {
        const t = line.trim();
        if (!t || t.startsWith("#")) continue;
        const [key, ...rest] = t.split("=");
        if (key) env[key.trim()] = rest.join("=").trim();
    }
    return env;
}

function getConfig() {
    const envPath = path.join(process.env.HOME, "Trading", ".env.binance");
    const env = loadEnv(envPath);
    // Testnet por defecto (más seguro): solo va a real si BINANCE_TESTNET === "0".
    const testnet = env.BINANCE_TESTNET !== "0";
    return {
        host: testnet ? HOST_TESTNET : HOST_LIVE,
        testnet,
        apiKey: env.BINANCE_API_KEY || "",
        secret: env.BINANCE_SECRET || "",
    };
}

// -----------------------------------------------------------------------------
// Firma HMAC-SHA256 de un query string (el corazón de la seguridad de Binance)
// -----------------------------------------------------------------------------
function sign(queryString, secret) {
    return crypto.createHmac("sha256", secret).update(queryString).digest("hex");
}

// Serializa params a query string en orden de inserción (Binance no exige orden,
// pero la firma debe calcularse sobre EXACTAMENTE el mismo string que se envía).
function toQuery(params) {
    return Object.entries(params)
        .filter(([, v]) => v !== undefined && v !== null)
        .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
        .join("&");
}

// -----------------------------------------------------------------------------
// Helper HTTPS — retorna {status, data}
// -----------------------------------------------------------------------------
function request(options, body = null) {
    return new Promise((resolve, reject) => {
        const req = https.request(options, res => {
            let chunks = "";
            res.on("data", d => (chunks += d));
            res.on("end", () => {
                let data = null;
                try { data = chunks ? JSON.parse(chunks) : null; } catch (e) { data = chunks; }
                resolve({ status: res.statusCode, data });
            });
        });
        req.on("error", reject);
        if (body) req.write(body);
        req.end();
    });
}

// Llamada pública (sin firma): precio, exchangeInfo, klines...
async function publicCall(method, apiPath, params = {}) {
    const { host } = getConfig();
    const qs = toQuery(params);
    const p = qs ? `${apiPath}?${qs}` : apiPath;
    const { status, data } = await request({ host, path: p, method, headers: { "User-Agent": "vero-bot" } });
    if (status < 200 || status >= 300) throw new Error(`Binance ${apiPath} ${status}: ${JSON.stringify(data)}`);
    return data;
}

// Llamada firmada (protegida): balances, órdenes, trades...
async function signedCall(method, apiPath, params = {}) {
    const { host, apiKey, secret } = getConfig();
    if (!apiKey || !secret) throw new Error("Faltan llaves en ~/Trading/.env.binance (BINANCE_API_KEY / BINANCE_SECRET)");
    const full = { ...params, recvWindow: RECV_WINDOW, timestamp: Date.now() };
    const qs = toQuery(full);
    const signature = sign(qs, secret);
    const signedQs = `${qs}&signature=${signature}`;
    // GET/DELETE mandan todo en la URL; POST también lo acepta en la URL (así lo usamos).
    const { status, data } = await request({
        host, path: `${apiPath}?${signedQs}`, method,
        headers: { "X-MBX-APIKEY": apiKey, "User-Agent": "vero-bot" },
    });
    if (status < 200 || status >= 300) throw new Error(`Binance ${apiPath} ${status}: ${JSON.stringify(data)}`);
    return data;
}

// -----------------------------------------------------------------------------
// LECTURA
// -----------------------------------------------------------------------------
async function getPrice(symbol = "ETHUSDT") {
    const r = await publicCall("GET", "/api/v3/ticker/price", { symbol });
    return Number(r.price);
}

// Reglas del par: tamaño mínimo, paso de cantidad, notional mínimo. Se necesita
// para redondear la cantidad y no que la orden rebote por "LOT_SIZE".
async function getSymbolRules(symbol = "ETHUSDT") {
    const r = await publicCall("GET", "/api/v3/exchangeInfo", { symbol });
    const s = r.symbols && r.symbols[0];
    if (!s) throw new Error(`Par ${symbol} no encontrado`);
    const f = t => s.filters.find(x => x.filterType === t) || {};
    const lot = f("LOT_SIZE"), notion = f("NOTIONAL");
    return {
        stepSize: Number(lot.stepSize || 0),
        minQty:   Number(lot.minQty || 0),
        tickSize: Number(f("PRICE_FILTER").tickSize || 0),
        minNotional: Number(notion.minNotional || 0),
    };
}

async function getBalances() {
    const acc = await signedCall("GET", "/api/v3/account");
    return (acc.balances || []).filter(b => Number(b.free) > 0 || Number(b.locked) > 0);
}

async function getOpenOrders(symbol) {
    return signedCall("GET", "/api/v3/openOrders", symbol ? { symbol } : {});
}

async function getMyTrades(symbol = "ETHUSDT", limit = 50) {
    return signedCall("GET", "/api/v3/myTrades", { symbol, limit });
}

// -----------------------------------------------------------------------------
// ÓRDENES
// -----------------------------------------------------------------------------
// Redondea una cantidad al stepSize del par (hacia abajo, para no pasarse).
function roundStep(qty, step) {
    if (!step) return qty;
    const factor = Math.round(1 / step);
    return Math.floor(qty * factor) / factor;
}

// Redondea un PRECIO al tickSize del par (al múltiplo más cercano). Binance rechaza
// precios con más precisión que el tick ("too much precision"). El toFixed(8) limpia
// el ruido de coma flotante que deja la multiplicación.
function roundTick(price, tick) {
    if (!tick) return price;
    return Number((Math.round(price / tick) * tick).toFixed(8));
}

async function placeMarketBuy(symbol, quantity) {
    return signedCall("POST", "/api/v3/order", {
        symbol, side: "BUY", type: "MARKET", quantity,
    });
}

// OCO de venta: stop-loss + take-profit en UNA orden nativa. Cuando toca uno, el
// otro se cancela solo. Reemplaza a tener stopguard + tpguard vigilando 24/7.
//   tp   = precio objetivo (limit de arriba)
//   stop = precio de stop (se dispara la venta si el precio cae ahí)
async function placeOcoSell(symbol, quantity, { tp, stop, stopLimit }) {
    const rules = await getSymbolRules(symbol);
    const tick = rules.tickSize || 0.01;
    // stopLimit un pelín bajo el stop para asegurar el fill al gatillarse.
    // TODOS los precios se redondean al tick o Binance rechaza por "too much precision".
    const sl = stopLimit != null ? stopLimit : stop - tick * 5;
    return signedCall("POST", "/api/v3/order/oco", {
        symbol, side: "SELL", quantity,
        price: roundTick(tp, tick),          // take-profit (limit)
        stopPrice: roundTick(stop, tick),    // gatillo del stop
        stopLimitPrice: roundTick(sl, tick), // limit del stop una vez gatillado
        stopLimitTimeInForce: "GTC",
    });
}

async function cancelOrder(symbol, orderId) {
    return signedCall("DELETE", "/api/v3/order", { symbol, orderId });
}

// Ping firmado: confirma que las llaves son válidas y el reloj está sincronizado.
async function testAuth() {
    const acc = await signedCall("GET", "/api/v3/account");
    return { ok: true, canTrade: acc.canTrade, tipo: acc.accountType };
}

// -----------------------------------------------------------------------------
// SIMPLE EARN (Flexible) — para la red de seguridad de auto-redención.
// El USDT parqueado en Flexible Earn (aparece como LDUSDT en el balance Spot) NO
// se puede gastar en una orden hasta redimirlo a Spot. Estas dos funciones lo
// consultan y lo redimen. ⚠️ Requieren que la API key tenga el permiso "Simple
// Earn" habilitado; si no, la llamada firmada rebota con -2015 (permiso) y el
// llamador debe MOSTRAR el error, no fallar mudo. Solo existen en real (api.binance.com),
// no en testnet.
// -----------------------------------------------------------------------------
async function getFlexibleEarnPosition(asset = "USDT") {
    // GET /sapi/v1/simple-earn/flexible/position — posición flexible por activo.
    // Devuelve filas con { asset, productId, totalAmount (redimible), ... }.
    const r = await signedCall("GET", "/sapi/v1/simple-earn/flexible/position", { asset, size: 100 });
    return (r && r.rows) || [];
}

async function redeemFlexibleEarn(productId, amount) {
    // POST /sapi/v1/simple-earn/flexible/redeem — redime a Spot (destAccount SPOT).
    // Flexible acredita al instante. Devuelve { redeemId, success }.
    return signedCall("POST", "/sapi/v1/simple-earn/flexible/redeem", {
        productId, amount, destAccount: "SPOT",
    });
}

module.exports = {
    getConfig, sign, toQuery, roundStep, roundTick,
    getPrice, getSymbolRules, getBalances, getOpenOrders, getMyTrades,
    placeMarketBuy, placeOcoSell, cancelOrder, testAuth,
    getFlexibleEarnPosition, redeemFlexibleEarn,
    publicCall, signedCall,
};
