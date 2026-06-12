#!/bin/bash
# Genera el reporte diario y lo manda por Telegram.
# Pensado para correr vía launchd (23:00 cierre y 08:00 mañana).

# node de fnm (ruta estable para launchd; el de fnm es efímero)
NODE="$HOME/.local/share/fnm/aliases/default/bin/node"
[ -x "$NODE" ] || NODE="$(command -v node)"

DIR="$HOME/Trading/tradingview-mcp"
cd "$DIR" || exit 1

# prefijo según hora (cierre vs mañana)
HOUR=$(date +%H)
if [ "$HOUR" -lt 12 ]; then PREFIJO="☀️ Buenos días Vero — repaso de ayer:"; else PREFIJO="🌙 Cierre del día, Vero:"; fi

REPORTE=$("$NODE" scripts/reporte_diario.js 2>/dev/null)
TEXTO="${PREFIJO}
${REPORTE}"

ENV_FILE="$HOME/Trading/.env.telegram"
if [ -f "$ENV_FILE" ]; then
  TOKEN=$(grep TELEGRAM_BOT_TOKEN "$ENV_FILE" | cut -d'=' -f2)
  CHAT=$(grep TELEGRAM_CHAT_ID "$ENV_FILE" | cut -d'=' -f2)
  curl -s "https://api.telegram.org/bot${TOKEN}/sendMessage" \
    -d "chat_id=${CHAT}" \
    --data-urlencode "text=${TEXTO}" >/dev/null 2>&1
fi

# también deja copia local con fecha
echo "$TEXTO" > "$HOME/Trading/reporte_$(date +%Y%m%d_%H%M).txt"
