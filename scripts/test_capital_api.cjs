#!/usr/bin/env node
// =============================================================================
// test_capital_api.js — Prueba de conexión a la API de Capital.com
// Uso: node scripts/test_capital_api.js [--demo]
//
// Por defecto conecta a LIVE. Pasar --demo para usar la cuenta demo.
// Lee credenciales desde ~/Trading/.env.telegram
// =============================================================================

const https = require("https");
const fs    = require("fs");
const path  = require("path");

// -----------------------------------------------------------------------------
// Cargar credenciales desde .env.telegram
// -----------------------------------------------------------------------------
const envPath = path.join(process.env.HOME, "Trading", ".env.telegram");

/**
 * Lee un archivo .env y retorna un objeto con las variables como pares clave=valor.
 * @param {string} filePath - Ruta absoluta al archivo .env
 * @returns {Object} Variables de entorno parseadas
 */
function loadEnv(filePath) {
    const lines = fs.readFileSync(filePath, "utf8").split("\n");
    const env   = {};
    for (const line of lines) {
        // Ignorar comentarios y líneas vacías
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const [key, ...rest] = trimmed.split("=");
        if (key) env[key.trim()] = rest.join("=").trim();
    }
    return env;
}

const env = loadEnv(envPath);

// Configuración del entorno (demo o live)
const IS_DEMO    = process.argv.includes("--demo");
const BASE_URL   = IS_DEMO
    ? "demo-api-capital.backend-capital.com"
    : "api-capital.backend-capital.com";

const API_KEY    = env.CAPITAL_API_KEY;
const API_PASS   = env.CAPITAL_API_PASSWORD;
const API_EMAIL  = env.CAPITAL_EMAIL;

console.log(`\n🔌 Conectando a Capital.com ${IS_DEMO ? "DEMO" : "LIVE"}...`);
console.log(`   Host:  ${BASE_URL}`);
console.log(`   Email: ${API_EMAIL}`);
console.log(`   Key:   ${API_KEY ? API_KEY.slice(0, 4) + "****" : "NO ENCONTRADA"}\n`);

// -----------------------------------------------------------------------------
// Helper: hace una petición HTTPS y retorna promesa con la respuesta
// -----------------------------------------------------------------------------
/**
 * Realiza una petición HTTPS y retorna la respuesta como objeto JSON.
 * @param {Object} options - Opciones de https.request
 * @param {string|null} body - Cuerpo de la petición (JSON string o null)
 * @returns {Promise<{status: number, headers: Object, data: Object}>}
 */
function request(options, body = null) {
    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            let raw = "";
            res.on("data", (chunk) => (raw += chunk));
            res.on("end", () => {
                try {
                    resolve({
                        status:  res.statusCode,
                        headers: res.headers,
                        data:    JSON.parse(raw)
                    });
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
// Paso 1: Autenticación → obtener CST + X-SECURITY-TOKEN
// -----------------------------------------------------------------------------
async function main() {
    const loginBody = JSON.stringify({
        identifier:        API_EMAIL,
        password:          API_PASS,
        encryptedPassword: false   // Capital.com requiere esto explícito en texto plano
    });

    const loginRes = await request({
        hostname: BASE_URL,
        path:     "/api/v1/session",
        method:   "POST",
        headers: {
            "X-CAP-API-KEY":  API_KEY,
            "Content-Type":   "application/json",
            "Content-Length": Buffer.byteLength(loginBody)
        }
    }, loginBody);

    // Verificar autenticación exitosa
    if (loginRes.status !== 200) {
        console.error("❌ Error de autenticación:");
        console.error("   Status:", loginRes.status);
        console.error("   Respuesta:", JSON.stringify(loginRes.data, null, 2));
        process.exit(1);
    }

    const CST   = loginRes.headers["cst"];
    const TOKEN = loginRes.headers["x-security-token"];

    console.log("✅ Autenticación exitosa!");
    console.log(`   CST token:       ${CST ? CST.slice(0, 8) + "..." : "NO"}`);
    console.log(`   Security token:  ${TOKEN ? TOKEN.slice(0, 8) + "..." : "NO"}\n`);

    // -----------------------------------------------------------------------------
    // Paso 2: Obtener info de la cuenta
    // -----------------------------------------------------------------------------
    const accountRes = await request({
        hostname: BASE_URL,
        path:     "/api/v1/accounts",
        method:   "GET",
        headers: {
            "X-CAP-API-KEY":    API_KEY,
            "CST":              CST,
            "X-SECURITY-TOKEN": TOKEN
        }
    });

    if (accountRes.status === 200) {
        const accounts = accountRes.data.accounts || [];
        console.log("📊 Cuentas disponibles:");
        for (const acc of accounts) {
            console.log(`   [${acc.accountType}] ${acc.accountName} — Balance: ${acc.balance?.balance} ${acc.currency || ""}`);
        }
        console.log();
    }

    // -----------------------------------------------------------------------------
    // Paso 3: Buscar el instrumento ETH/USD en Capital
    // -----------------------------------------------------------------------------
    const searchRes = await request({
        hostname: BASE_URL,
        path:     "/api/v1/markets?searchTerm=ETHUSD",
        method:   "GET",
        headers: {
            "X-CAP-API-KEY":    API_KEY,
            "CST":              CST,
            "X-SECURITY-TOKEN": TOKEN
        }
    });

    if (searchRes.status === 200) {
        const markets = searchRes.data.markets || [];
        const eth     = markets.find(m => m.epic === "ETHUSD" || m.instrumentName?.includes("Ethereum"));
        if (eth) {
            console.log("🔷 ETH encontrado en Capital.com:");
            console.log(`   Epic:       ${eth.epic}`);
            console.log(`   Nombre:     ${eth.instrumentName}`);
            console.log(`   Bid/Offer:  ${eth.bid} / ${eth.offer}`);
            console.log(`   Spread:     $${(eth.offer - eth.bid).toFixed(2)}`);
        } else {
            console.log("⚠️  No se encontró ETHUSD directamente. Mercados disponibles:");
            markets.slice(0, 5).forEach(m => console.log(`   ${m.epic}: ${m.instrumentName}`));
        }
    }

    console.log("\n✅ Prueba completa. La API de Capital.com está operativa.\n");
}

// Ejecutar con manejo de errores
main().catch((err) => {
    console.error("❌ Error inesperado:", err.message);
    process.exit(1);
});
