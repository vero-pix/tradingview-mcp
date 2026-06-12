#!/bin/bash
# Notificador unificado: manda una alerta a macOS (sonido) Y a Telegram (celular).
# Uso: ./scripts/notify.sh "<titulo>" "<mensaje>" [sonido]
#   sonido: Hero (señal buena, default), Basso (problema), Glass (info)

TITLE="${1:?Falta título}"
MSG="${2:?Falta mensaje}"
SOUND="${3:-Hero}"

# 1) Notificación macOS con sonido
osascript -e "display notification \"$MSG\" with title \"$TITLE\" sound name \"$SOUND\"" 2>/dev/null

# 2) Telegram (si está configurado)
ENV_FILE="$HOME/Trading/.env.telegram"
if [ -f "$ENV_FILE" ]; then
  TOKEN=$(grep TELEGRAM_BOT_TOKEN "$ENV_FILE" | cut -d'=' -f2)
  CHAT=$(grep TELEGRAM_CHAT_ID "$ENV_FILE" | cut -d'=' -f2)
  if [ -n "$TOKEN" ] && [ -n "$CHAT" ]; then
    # emoji según sonido
    case "$SOUND" in
      Hero) EMO="🟢" ;;
      Basso) EMO="🔴" ;;
      *) EMO="ℹ️" ;;
    esac
    curl -s "https://api.telegram.org/bot${TOKEN}/sendMessage" \
      -d "chat_id=${CHAT}" \
      --data-urlencode "text=${EMO} <b>${TITLE}</b>%0A${MSG}" \
      -d "parse_mode=HTML" >/dev/null 2>&1
  fi
fi
