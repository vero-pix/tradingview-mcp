#!/bin/bash
# Detector SWING de ETH en 1h (servicio launchd). Vigila 24/7 y avisa por
# Telegram + macOS cuando se forma una entrada BOS con la config que SÍ
# sobrevive el spread (1h, SL=ATR×5, TP=RR2, filtro EMA200).
#
# Es de BAJA FRECUENCIA: ~1 entrada cada 2-3 días. Complemento del scalping,
# no lo reemplaza. Backtest (360d, spread 0.09%): PF ~1.6, ~14%/año.
#
# Chequea cada 120s pero solo avisa UNA vez por vela (dedup por barTime).

NODE="$HOME/.local/share/fnm/aliases/default/bin/node"
[ -x "$NODE" ] || NODE="$(command -v node)"
DIR="$HOME/Trading/tradingview-mcp"
cd "$DIR" || exit 1

export ATR_MULT="${ATR_MULT:-5}"   # SL = ATR × 5
export RR="${RR:-2}"               # TP = 2× el riesgo
LAST_BAR=""                         # barTime de la última señal avisada (anti-dup)

echo "$(date '+%F %H:%M:%S') [eth1h] iniciado — modelo swing BOS 1h (ATR×$ATR_MULT, RR$RR)"

while true; do
  OUT=$("$NODE" scripts/bos_signal_1h.js 2>/dev/null)
  DIR_S=$(echo "$OUT" | cut -d'|' -f1)
  BAR=$(echo "$OUT"   | cut -d'|' -f2)

  case "$DIR_S" in
    LONG|SHORT)
      if [ "$BAR" != "$LAST_BAR" ]; then
        ENTRY=$(echo "$OUT"|cut -d'|' -f3); SL=$(echo "$OUT"|cut -d'|' -f4)
        TP=$(echo "$OUT"|cut -d'|' -f5);    RSI=$(echo "$OUT"|cut -d'|' -f6)
        if [ "$DIR_S" = "LONG" ]; then SND=Hero; FL="🟢 LONG"; else SND=Basso; FL="🔴 SHORT"; fi
        echo "$(date '+%F %H:%M:%S') >>> SEÑAL 1h $DIR_S entry=$ENTRY sl=$SL tp=$TP rsi=$RSI"
        ./scripts/notify.sh "Swing ETH 1h · $FL" "Entrada $ENTRY · SL $SL · TP $TP · RSI $RSI. Modelo de SWING (baja frecuencia, CON stop). Distinto a tu scalping." "$SND"
        LAST_BAR="$BAR"
      fi
      ;;
    err)
      echo "$(date '+%F %H:%M:%S') [eth1h] sin datos, reintento"
      ;;
    *)
      echo "$(date '+%F %H:%M:%S') [eth1h] sin señal (vela $BAR)"
      ;;
  esac
  sleep 120
done
