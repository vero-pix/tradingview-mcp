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

    const inst = res.data.instrument || {};
    const snap = res.data.snapshot   || {};
    return {
        epic:           inst.epic || epic,
        instrumentName: inst.name,
        bid:            snap.bid,
        offer:          snap.offer,
        spread:         (snap.offer != null && snap.bid != null)
                            ? +(snap.offer - snap.bid).toFixed(4) : null,
        updateTime:     snap.updateTime,
        marketStatus:   snap.marketStatus,
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

module.exports = {
    HOST_LIVE, HOST_DEMO, SESSION_FILE,
    loadEnv, getConfig, request,
    loadSession, saveSession, clearSession,
    authenticate, apiCall,
    getAccounts, selectAccount,
    getMarket, getPrice,
    getPositions, computePnL, getEthPosition,
};
