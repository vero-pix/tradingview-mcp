#!/usr/bin/env node
// =============================================================================
// capital_price.cjs — Precio REAL de Capital.com (bid/offer/spread)
//
// Reemplaza la estimación "Binance − OFFSET": lee el precio que de verdad ve
// Vero en su bróker, con el spread real del momento.
//
// Uso:
//   node scripts/capital_price.cjs [EPIC] [--demo] [--json] [--field bid|offer|spread]
//   node scripts/capital_price.cjs                 → "bid|offer|spread"
//   node scripts/capital_price.cjs --field bid     → solo el bid (para los watchers)
//   node scripts/capital_price.cjs --json          → {"epic","bid","offer","spread"}
//
// En error: no imprime nada y sale con código ≠ 0 (los watchers ya manejan "sin datos").
// =============================================================================

const capital = require("./capital_client.cjs");

const args  = process.argv.slice(2);
const demo  = args.includes("--demo");
const json  = args.includes("--json");
const fi    = args.indexOf("--field");
const field = fi !== -1 ? args[fi + 1] : null;
// Primer argumento posicional que no sea flag ni valor de --field = epic.
const epic  = args.find((a, i) =>
    !a.startsWith("--") && !(fi !== -1 && i === fi + 1)) || "ETHUSD";

(async () => {
    try {
        const m = await capital.getMarket(epic, { demo });
        if (m.bid == null || m.offer == null) {
            process.exit(1);
        }
        if (field) {
            const v = m[field];
            if (v == null) process.exit(1);
            console.log(typeof v === "number" ? v : String(v));
        } else if (json) {
            console.log(JSON.stringify({ epic: m.epic, bid: m.bid, offer: m.offer, spread: m.spread }));
        } else {
            console.log(`${m.bid}|${m.offer}|${m.spread}`);
        }
    } catch (err) {
        process.stderr.write("capital_price: " + err.message + "\n");
        process.exit(1);
    }
})();
