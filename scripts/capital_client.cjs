// =============================================================================
// capital_client.cjs — Cliente reutilizable de la API REST de Capital.com (LECTURA)
//
// Centraliza autenticación con CACHÉ DE SESIÓN, request HTTPS y funciones de
// lectura (precio, posiciones, P&L). Pensado para que los CLIs y watchers lo
// requieran sin re-autenticar en cada llamada.
//
// ⚠️ La cuenta de Vero se bloqueó por demasiados POST /session fallidos. Por eso:
//   - Los tokens (CST + X-SECURITY-TOKEN) se cachean en /tmp/capital_session.json.
//   - Solo se hace login si NO hay caché o si una llamada protegida da 401.
//   - El re-login tras un 401 ocurre UNA sola vez; nunca dentro de un bucle.
//   - Si Capital responde "locked/too-many-requests", se aborta sin reintentar.
//
// Credenciales: SOLO desde ~/Trading/.env.telegram. Nunca se loguean completas.
// =============================================================================

const https = require("https");
const fs    = require("fs");
const path  = require("path");

// -----------------------------------------------------------------------------
// Hosts y rutas
// -----------------------------------------------------------------------------
const HOST_LIVE = "api-capital.backend-capital.com";
const HOST_DEMO = "demo-api-capital.backend-capital.com";
const SESSION_FILE = process.env.CAPITAL_SESSION_FILE
    || path.join(require("os").tmpdir(), "capital_session.json");

// -----------------------------------------------------------------------------
// Carga de credenciales desde .env.telegram (mismo parser que test_capital_api.cjs)
// -----------------------------------------------------------------------------
/**
 * Lee un archivo .env y retorna un objeto con las variables como pares clave=valor.
 * @param {string} filePath
 * @returns {Object}
 */
function loadEnv(filePath) {
    const lines = fs.readFileSync(filePath, "utf8").split("\n");
    const env   = {};
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const [key, ...rest] = trimmed.split("=");
        if (key) env[key.trim()] = rest.join("=").trim();
    }
    return env;
}

/**
 * Devuelve config del entorno solicitado (live por defecto).
 * @param {{demo?: boolean}} opts
 */
function getConfig({ demo = false } = {}) {
    const envPath = path.join(process.env.HOME, "Trading", ".env.telegram");
    const env = loadEnv(envPath);
    const host = demo ? HOST_DEMO : HOST_LIVE;
    return {
        host,
        apiKey:   env.CAPITAL_API_KEY,
        email:    env.CAPITAL_EMAIL,
        password: env.CAPITAL_API_PASSWORD,
    };
}

// -----------------------------------------------------------------------------
// Helper HTTPS — retorna {status, headers, data}
// -----------------------------------------------------------------------------
function request(options, body = null) {
    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            let raw = "";
            res.on("data", (chunk) => (raw += chunk));
            res.on("end", () => {
                try {
                    resolve({ status: res.statusCode, headers: res.headers, data: JSON.parse(raw) });
                } catch (e) {
                    resolve({ status: res.statusCode, headers: res.headers, data: raw });
                }
            });
        });
        req.on("error", reject);
        if (body) req.write(body);
        req.end();
    });
}

// -----------------------------------------------------------------------------
// Caché de sesión en disco (/tmp). Guarda host para no mezclar live/demo.
// -----------------------------------------------------------------------------
function loadSession(host) {
    try {
        const s = JSON.parse(fs.readFileSync(SESSION_FILE, "utf8"));
        if (s && s.host === host && s.cst && s.securityToken) return s;
    } catch (e) { /* sin caché o ilegible */ }
    return null;
}

function saveSession({ cst, securityToken, host, accountId }) {
    const payload = JSON.stringify({ cst, securityToken, host, accountId, createdAt: Date.now() });
    fs.writeFileSync(SESSION_FILE, payload, { mode: 0o600 });
    try { fs.chmodSync(SESSION_FILE, 0o600); } catch (e) {}
}

function clearSession() {
    try { fs.unlinkSync(SESSION_FILE); } catch (e) {}
}

// Detecta respuestas de bloqueo/rate-limit para NO reintentar (re-bloquearía la cuenta).
function isLockError(res) {
    const code = res && res.data && res.data.errorCode ? String(res.data.errorCode) : "";
    return res.status === 429
        || /too-?many|locked|lock\.|temporarily/i.test(code);
}

// -----------------------------------------------------------------------------
// Autenticación — usa caché salvo force; un único POST /session cuando hace falta.
// -----------------------------------------------------------------------------
/**
 * @param {{demo?: boolean, force?: boolean}} opts
 * @returns {Promise<{cst, securityToken, host, accountId}>}
 */
async function authenticate({ demo = false, force = false } = {}) {
    const cfg = getConfig({ demo });
    if (!cfg.apiKey || !cfg.email || !cfg.password) {
        throw new Error("Faltan credenciales CAPITAL_* en ~/Trading/.env.telegram");
    }

    if (!force) {
        const cached = loadSession(cfg.host);
        if (cached) return cached;
    }

    const loginBody = JSON.stringify({
        identifier:        cfg.email,
        password:          cfg.password,
        encryptedPassword: false,
    });
    const res = await request({
        hostname: cfg.host,
        path:     "/api/v1/session",
        method:   "POST",
        headers: {
            "X-CAP-API-KEY":  cfg.apiKey,
            "Content-Type":   "application/json",
            "Content-Length": Buffer.byteLength(loginBody),
        },
    }, loginBody);

    if (res.status !== 200) {
        if (isLockError(res)) {
            throw new Error("Capital.com rechazó el login (posible bloqueo / rate limit). "
                + "Espera unos minutos antes de reintentar. errorCode="
                + (res.data && res.data.errorCode));
        }
        throw new Error("Login Capital.com falló (status " + res.status + "): "
            + JSON.stringify(res.data));
    }

    const session = {
        cst:           res.headers["cst"],
        securityToken: res.headers["x-security-token"],
        host:          cfg.host,
        accountId:     res.data && res.data.currentAccountId,
    };
    saveSession(session);
    return session;
}

// -----------------------------------------------------------------------------
// apiCall — llamada protegida con caché + retry-401 (una vez)
// -----------------------------------------------------------------------------
/**
 * @param {string} method  GET/POST/PUT...
 * @param {string} apiPath ej. "/api/v1/markets/ETHUSD"
 * @param {{demo?: boolean, body?: any, _retried?: boolean}} opts
 */
async function apiCall(method, apiPath, { demo = false, body = null, _retried = false } = {}) {
    const session = await authenticate({ demo });
    const bodyStr = body ? JSON.stringify(body) : null;
    const headers = {
        "X-CAP-API-KEY":    getConfig({ demo }).apiKey,
        "CST":              session.cst,
        "X-SECURITY-TOKEN": session.securityToken,
    };
    if (bodyStr) {
        headers["Content-Type"]   = "application/json";
        headers["Content-Length"] = Buffer.byteLength(bodyStr);
    }
    const res = await request({ hostname: session.host, path: apiPath, method, headers }, bodyStr);

    // Token expirado por inactividad → re-login UNA vez y reintentar.
    if (res.status === 401 && !_retried) {
        clearSession();
        await authenticate({ demo, force: true });
        return apiCall(method, apiPath, { demo, body, _retried: true });
    }
    if (res.status === 401) {
        throw new Error("401 tras re-login en " + apiPath + " — credenciales o cuenta bloqueada.");
    }
    return res;
}

// -----------------------------------------------------------------------------
// Cuentas — fijar la cuenta activa por nombre (ej. "USD 2")
// -----------------------------------------------------------------------------
async function getAccounts({ demo = false } = {}) {
    const res = await apiCall("GET", "/api/v1/accounts", { demo });
    if (res.status !== 200) throw new Error("GET /accounts falló: " + res.status);
    return (res.data && res.data.accounts) || [];
}

/**
 * Fija la cuenta activa. Busca por nombre; si no, deja la actual.
 * @param {string} accountName ej. "USD 2"
 * @param {{demo?: boolean}} opts
 * @returns {Promise<Object|null>} la cuenta seleccionada
 */
async function selectAccount(accountName, { demo = false } = {}) {
    const accounts = await getAccounts({ demo });
    const target = accounts.find(a => a.accountName === accountName);
    if (!target) return null;
    if (!target.preferred) {
        // Cambiar cuenta activa de la sesión.
        const res = await apiCall("PUT", "/api/v1/session", { demo, body: { accountId: target.accountId } });
        if (res.status !== 200) throw new Error("PUT /session (cambio de cuenta) falló: " + res.status);
        // Persistir el accountId activo en la caché.
        const s = loadSession(getConfig({ demo }).host);
        if (s) saveSession({ ...s, accountId: target.accountId });
    }
    return target;
}

// -----------------------------------------------------------------------------
// Precio — snapshot bid/offer/spread de un epic
// -----------------------------------------------------------------------------
/**
 * @param {string} epic ej. "ETHUSD"
 * @param {{demo?: boolean}} opts
 * @returns {Promise<{epic, instrumentName, bid, offer, spread, updateTime, marketStatus}>}
 */
async function getMarket(epic = "ETHUSD", { demo = false } = {}) {
    let res = await apiCall("GET", "/api/v1/markets/" + encodeURIComponent(epic), { demo });

    // Fallback: si el epic directo no existe, buscar por término.
    if (res.status === 404) {
        const s = await apiCall("GET", "/api/v1/markets?searchTerm=" + encodeURIComponent(epic), { demo });
        const m = (s.data && s.data.markets || []).find(
            x => x.epic === epic || (x.instrumentName || "").includes("Ethereum"));
        if (!m) throw new Error("No se encontró el mercado " + epic);
        return {
            epic: m.epic, instrumentName: m.instrumentName,
            bid: m.bid, offer: m.offer, spread: +(m.offer - m.bid).toFixed(4),
            updateTime: m.updateTime, marketStatus: m.marketStatus,
        };
    }
    if (res.status !== 200) throw new Error("GET /markets/" + epic + " falló: " + res.status);

    const inst  = res.data.instrument   || {};
    const snap  = res.data.snapshot     || {};
    const rules = res.data.dealingRules || {};
    return {
        epic:           inst.epic || epic,
        instrumentName: inst.name,
        bid:            snap.bid,
        offer:          snap.offer,
        spread:         (snap.offer != null && snap.bid != null)
                            ? +(snap.offer - snap.bid).toFixed(4) : null,
        updateTime:     snap.updateTime,
        marketStatus:   snap.marketStatus,
        lotSize:        inst.lotSize,
        minDealSize:    rules.minDealSize && rules.minDealSize.value,
    };
}

async function getPrice(epic = "ETHUSD", opts = {}) {
    const m = await getMarket(epic, opts);
    return { bid: m.bid, offer: m.offer, spread: m.spread };
}

// -----------------------------------------------------------------------------
// Posiciones — normalizadas
// -----------------------------------------------------------------------------
/**
 * @param {{demo?: boolean, epic?: string|null}} opts
 * @returns {Promise<Array<{dealId, epic, direction, size, openLevel, contractSize, currency, bid, offer}>>}
 */
async function getPositions({ demo = false, epic = null } = {}) {
    const res = await apiCall("GET", "/api/v1/positions", { demo });
    if (res.status !== 200) throw new Error("GET /positions falló: " + res.status);
    const items = (res.data && res.data.positions) || [];
    const norm = items.map(it => {
        const p = it.position || {};
        const m = it.market   || {};
        return {
            dealId:       p.dealId,
            epic:         m.epic,
            direction:    p.direction,                       // BUY = long, SELL = short
            size:         Number(p.size),
            openLevel:    Number(p.level != null ? p.level : p.openLevel),
            contractSize: Number(p.contractSize != null ? p.contractSize : 1),
            currency:     p.currency,
            stopLevel:    p.stopLevel != null ? Number(p.stopLevel) : null,
            limitLevel:   p.limitLevel != null ? Number(p.limitLevel) : (p.profitLevel != null ? Number(p.profitLevel) : null),
            bid:          m.bid,
            offer:        m.offer,
        };
    });
    return epic ? norm.filter(p => p.epic === epic) : norm;
}

// -----------------------------------------------------------------------------
// P&L — agrega lotes del mismo lado y valora al precio de cierre correcto
//   LONG (BUY):  se cierra en bid  → pnl = (bid   − entrada) × size × contractSize
//   SHORT (SELL): se cierra en offer → pnl = (entrada − offer) × size × contractSize
// -----------------------------------------------------------------------------
/**
 * @param {Array} positions  posiciones normalizadas (mismo epic)
 * @param {{bid:number, offer:number}} snapshot
 */
function computePnL(positions, snapshot) {
    if (!positions.length) return null;
    const bid = snapshot.bid, offer = snapshot.offer;

    const sides = new Set(positions.map(p => p.direction));
    const side = sides.size > 1 ? "MIXED" : positions[0].direction;

    let totalSize = 0, weightedEntryNum = 0, unrealizedPnl = 0;
    for (const p of positions) {
        totalSize        += p.size;
        weightedEntryNum += p.openLevel * p.size;
        const close = p.direction === "BUY" ? bid : offer;
        const dir   = p.direction === "BUY" ? 1 : -1;
        unrealizedPnl += dir * (close - p.openLevel) * p.size * p.contractSize;
    }
    const weightedAvgEntry = weightedEntryNum / totalSize;
    const refClose = side === "SELL" ? offer : bid;
    const pnlPerUnit = side === "SELL" ? (weightedAvgEntry - refClose) : (refClose - weightedAvgEntry);

    return {
        side,
        count:            positions.length,
        totalSize:        +totalSize.toFixed(4),
        weightedAvgEntry: +weightedAvgEntry.toFixed(2),
        bid, offer,
        unrealizedPnl:    +unrealizedPnl.toFixed(2),
        pnlPerUnit:       +pnlPerUnit.toFixed(2),
        pnlPct:           +((pnlPerUnit / weightedAvgEntry) * 100).toFixed(2),
        currency:         positions[0].currency || "USD",
    };
}

/**
 * Atajo: selecciona cuenta, lee posiciones del epic y calcula P&L.
 * @param {{demo?: boolean, epic?: string, account?: string}} opts
 */
async function getEthPosition({ demo = false, epic = "ETHUSD", account = "USD 2" } = {}) {
    if (account) await selectAccount(account, { demo });
    const positions = await getPositions({ demo, epic });
    if (!positions.length) return { positions: [], pnl: null };
    // Usar el bid/offer que ya viene en cada posición (ahorra un request a /markets).
    const snapshot = { bid: positions[0].bid, offer: positions[0].offer };
    const pnl = computePnL(positions, snapshot);
    return { positions, pnl };
}

// =============================================================================
// ÓRDENES (escritura) — abrir / confirmar / cerrar
//
// ⚠️ Plata real. Esta capa es solo TRANSPORTE: valida lo básico, envía y confirma.
//    Los guardrails de negocio (confirmación, anti-promedio, dry-run, registro en
//    el diario, notificaciones) viven en el CLI capital_order.cjs, no aquí.
//
// Flujo Capital.com (asíncrono):
//   POST /positions → {dealReference}  →  GET /confirms/{dealReference} → dealId/level
// El dealReference NO garantiza ejecución; SIEMPRE hay que confirmar.
// =============================================================================

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Validación dura, última línea de defensa (independiente del CLI).
 * Solo se soporta LONG (BUY) — Vero opera solo long.
 * STOP SIEMPRE obligatorio. Stop debajo del precio, target (si hay) encima.
 */
function validateLongOrder({ offer, size, stopLevel, profitLevel, direction = "BUY" }) {
    if (direction !== "BUY") {
        throw new Error("Solo se permite direction BUY (Vero opera solo LONG).");
    }
    if (!(Number(size) > 0) || !isFinite(Number(size))) {
        throw new Error("size inválido: " + size);
    }
    if (stopLevel == null || !isFinite(Number(stopLevel))) {
        throw new Error("REGLA STOP SIEMPRE: no se permite abrir sin stopLevel.");
    }
    if (!(Number(stopLevel) < Number(offer))) {
        throw new Error("stopLevel (" + stopLevel + ") debe ir POR DEBAJO del precio ask ("
            + offer + ") para un LONG.");
    }
    if (profitLevel != null && !(Number(profitLevel) > Number(offer))) {
        throw new Error("profitLevel (" + profitLevel + ") debe ir POR ENCIMA del precio ask ("
            + offer + ") para un LONG.");
    }
}

/**
 * Consulta el resultado real de una orden asíncrona.
 * Reintenta si el confirm aún no está disponible; nunca asume ACCEPTED.
 * @returns {{dealStatus, dealId, level, reason, affectedDeals, raw}}
 */
async function confirmDeal(dealReference, { demo = false } = {}) {
    for (let attempt = 0; attempt < 3; attempt++) {
        const res = await apiCall("GET", "/api/v1/confirms/" + encodeURIComponent(dealReference), { demo });
        if (res.status === 200 && res.data) {
            const d = res.data;
            return {
                dealStatus:    d.dealStatus,            // ACCEPTED / REJECTED
                dealId:        d.dealId,
                level:         d.level,
                reason:        d.reason,
                affectedDeals: d.affectedDeals || [],
                raw:           d,
            };
        }
        if (res.status === 404) { await sleep(300); continue; }   // aún no disponible
        throw new Error("GET /confirms falló: " + res.status + " " + JSON.stringify(res.data));
    }
    return { dealStatus: "UNKNOWN", dealId: null, level: null,
             reason: "confirm no disponible tras reintentos", affectedDeals: [], raw: null };
}

/**
 * Abre una posición LONG. Valida → POST /positions → confirma.
 * @returns {{ok, dealReference, dealStatus, dealId, level, reason, raw}}
 */
async function openPosition({ epic = "ETHUSD", direction = "BUY", size, stopLevel,
                              profitLevel = null, offer, guaranteedStop = false, demo = false } = {}) {
    // Validación dura. El llamador debe pasar el offer real (precio ask) para
    // verificar que stop va por debajo y target por encima.
    if (offer == null || !isFinite(Number(offer))) {
        throw new Error("openPosition: falta el offer (precio ask) para validar la orden.");
    }
    validateLongOrder({ offer, size, stopLevel, profitLevel, direction });

    const body = { epic, direction, size: Number(size), stopLevel: Number(stopLevel), guaranteedStop };
    if (profitLevel != null) body.profitLevel = Number(profitLevel);

    const res = await apiCall("POST", "/api/v1/positions", { demo, body });
    if (isLockError(res)) {
        throw new Error("Apertura rechazada por rate limit/bloqueo. errorCode="
            + (res.data && res.data.errorCode));
    }
    if (res.status !== 200 || !res.data || !res.data.dealReference) {
        throw new Error("POST /positions falló (status " + res.status + "): " + JSON.stringify(res.data));
    }
    const dealReference = res.data.dealReference;
    await sleep(250);                          // dar tiempo al confirm
    const conf = await confirmDeal(dealReference, { demo });
    return {
        ok:            conf.dealStatus === "ACCEPTED",
        dealReference,
        dealStatus:    conf.dealStatus,
        dealId:        conf.dealId,
        level:         conf.level,
        reason:        conf.reason,
        raw:           conf.raw,
    };
}

/**
 * Cierra una posición por su dealId (NO dealReference). Cierre total.
 * @returns {{ok, dealReference, dealStatus, dealId, level, reason, raw}}
 */
async function closePosition(dealId, { demo = false } = {}) {
    if (!dealId || typeof dealId !== "string") {
        throw new Error("falta dealId válido (no usar dealReference para cerrar).");
    }
    const res = await apiCall("DELETE", "/api/v1/positions/" + encodeURIComponent(dealId), { demo });
    if (isLockError(res)) {
        throw new Error("Cierre rechazado por rate limit/bloqueo. errorCode="
            + (res.data && res.data.errorCode));
    }
    if (res.status !== 200 || !res.data || !res.data.dealReference) {
        throw new Error("DELETE /positions falló (status " + res.status + "): " + JSON.stringify(res.data));
    }
    const dealReference = res.data.dealReference;
    await sleep(250);
    const conf = await confirmDeal(dealReference, { demo });
    return {
        ok:            conf.dealStatus === "ACCEPTED",
        dealReference,
        dealStatus:    conf.dealStatus,
        dealId:        conf.dealId || dealId,
        level:         conf.level,
        reason:        conf.reason,
        raw:           conf.raw,
    };
}

/**
 * Modifica el stop/target de una posición abierta (PUT → confirma).
 * ⚠️ GOTCHA Capital (descubierto 2026-07-02 en real): el PUT REEMPLAZA el bracket
 * completo — mandar solo stopLevel BORRA el take profit (y viceversa). Por eso,
 * si falta uno de los dos niveles, se lee la posición y se PRESERVA el vigente.
 * @returns {{ok, dealStatus, reason, dealId}}
 */
async function updatePosition(dealId, { stopLevel = null, profitLevel = null, demo = false } = {}) {
    if (!dealId || typeof dealId !== "string") {
        throw new Error("updatePosition: falta dealId válido.");
    }
    const body = {};
    if (stopLevel   != null) body.stopLevel   = Number(stopLevel);
    if (profitLevel != null) body.profitLevel = Number(profitLevel);
    if (!Object.keys(body).length) throw new Error("updatePosition: nada que cambiar.");

    // preserva el nivel que no viene, para que ningún watcher desarme el bracket
    if (body.stopLevel == null || body.profitLevel == null) {
        try {
            const posiciones = await getPositions({ demo });
            const p = posiciones.find(x => x.dealId === dealId);
            if (p) {
                if (body.stopLevel == null && p.stopLevel != null) body.stopLevel = Number(p.stopLevel);
                if (body.profitLevel == null && p.limitLevel != null) body.profitLevel = Number(p.limitLevel);
            }
        } catch (e) { /* si no se pudo leer, sigue con lo pedido (peor caso = comportamiento anterior) */ }
    }

    const res = await apiCall("PUT", "/api/v1/positions/" + encodeURIComponent(dealId), { demo, body });
    if (isLockError(res)) {
        throw new Error("Modificación rechazada por rate limit/bloqueo.");
    }
    if (res.status !== 200 || !res.data || !res.data.dealReference) {
        throw new Error("PUT /positions falló (status " + res.status + "): " + JSON.stringify(res.data));
    }
    await sleep(250);
    const conf = await confirmDeal(res.data.dealReference, { demo });
    return { ok: conf.dealStatus === "ACCEPTED", dealStatus: conf.dealStatus, reason: conf.reason, dealId };
}

module.exports = {
    HOST_LIVE, HOST_DEMO, SESSION_FILE,
    loadEnv, getConfig, request, sleep,
    loadSession, saveSession, clearSession,
    authenticate, apiCall,
    getAccounts, selectAccount,
    getMarket, getPrice,
    getPositions, computePnL, getEthPosition,
    validateLongOrder, openPosition, confirmDeal, closePosition, updatePosition,
};
