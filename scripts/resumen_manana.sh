#!/bin/bash
# resumen_manana.sh — Resumen de la noche para Vero, por Telegram (corre en el servidor).
# Junta: auto-ejecución Binance de la noche, posición Binance+Capital, P&L, y shadow vs real.
# Lo dispara un systemd timer a las 09:00 Chile. Se lee todo desde el servidor (tiene las llaves).

cd "$HOME/Trading/tradingview-mcp" || exit 1
NODE="$(command -v node)"
HOY=$(date '+%Y-%m-%d')

# --- Binance: posición + órdenes + P&L (parsea binance_order.cjs status) ---
BN=$("$NODE" scripts/binance_order.cjs status 2>/dev/null)
BN_ETH=$(echo "$BN"    | grep -E "^\s*ETH:"  | sed -E 's/.*libre ([0-9.]+).*bloqueado ([0-9.]+)/libre \1 · bloq \2/')
BN_USDT=$(echo "$BN"   | grep -E "^\s*USDT:" | sed -E 's/.*libre ([0-9.]+).*/\1/')
BN_ORD=$(echo "$BN"    | grep -E "Órdenes abiertas" | sed -E 's/.*: ([0-9]+)/\1/')
BN_PNL=$(echo "$BN"    | grep -E "P&L hoy"   | sed -E 's/.*P&L hoy \(aprox\): ([^·]+)·.*/\1/')
if echo "$BN" | grep -q "STOP_LOSS"; then BN_PROT="🛡️ protegida (OCO)"; else
  if [ "${BN_ORD:-0}" = "0" ]; then BN_PROT="flat / sin órdenes"; else BN_PROT="⚠️ revisar"; fi
fi

# --- Auto-ejecución de la noche (últimas ejecuciones registradas hoy) ---
AUTO=$(grep -c "A+ NUEVA" /tmp/vero_binanceautoexec.log 2>/dev/null || echo 0)
AUTO_HOY=$(grep "A+ NUEVA" /tmp/vero_binanceautoexec.log 2>/dev/null | tail -3 | sed -E 's/^([0-9:]+).*entry~([0-9.]+).*/\1 entry \2/' | tr '\n' ' ')

# --- Capital: posiciones ---
CAP=$("$NODE" -e '
const c=require("./scripts/capital_client.cjs");
(async()=>{try{await c.selectAccount("USD 2",{});const p=await c.getPositions({});console.log(p.length+" posición(es)")}catch(e){console.log("no pude leer ("+e.message.slice(0,40)+")")}})();
' 2>/dev/null)

# --- Shadow vs real: conteo de señales ---
REAL_N=$([ -f "$HOME/Trading/senales_aplus.jsonl" ] && wc -l < "$HOME/Trading/senales_aplus.jsonl" || echo 0)
SHAD_N=$([ -f "$HOME/Trading/senales_aplus_shadow.jsonl" ] && wc -l < "$HOME/Trading/senales_aplus_shadow.jsonl" || echo 0)

MSG="☀️ <b>Resumen de la noche</b> ($HOY)
━━━━━━━━━━━━━━
🟡 <b>Binance</b>: $BN_PROT
   ETH: ${BN_ETH:-—} · USDT: ${BN_USDT:-—}
   Órdenes: ${BN_ORD:-0} · P&L hoy:${BN_PNL:-—}
⚡ Auto-ejecución: ${AUTO:-0} A+ disparadas (histórico)
   Últimas: ${AUTO_HOY:-ninguna}
🔷 <b>Capital</b>: $CAP
━━━━━━━━━━━━━━
🧪 <b>Shadow-test</b>: real $REAL_N señales · sombra $SHAD_N
   (comparar a los ~7 días para el veredicto)
━━━━━━━━━━━━━━
Manda <b>binance</b> o <b>reporte</b> para el detalle."

bash scripts/notify.sh "Resumen de la noche · Vero" "$MSG" "Glass"
