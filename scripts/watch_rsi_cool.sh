#!/bin/bash
# Watcher de ENFRIAMIENTO para la próxima entrada A+ (scalping 1m).
# Vero acaba de tomar ganancia en sobrecompra (RSI ~70). Este watcher avisa
# UNA vez cuando el RSI enfría bajo 64 CON la tendencia todavía alcista, que es
# la antesala del setup A+ (después viene pullback a EMA9 + rebote con volumen,
# que ya vigila el detector principal cl.vero.detectoreth).
#
# Gatillo: RSI cruza de >=64 a <64  AND  EMA9>EMA21  AND  ER>=0.40  AND  liquidez.
# Es de un solo disparo por enfriamiento (detecta el CRUCE, no spamea).
#
# Uso:  ./scripts/watch_rsi_cool.sh        (corre en loop hasta que lo cortes)

NODE="$HOME/.local/share/fnm/aliases/default/bin/node"
[ -x "$NODE" ] || NODE="$(command -v node)"
DIR="$HOME/Trading/tradingview-mcp"
cd "$DIR" || exit 1

RSI_THRESH="${RSI_THRESH:-64}"   # umbral de enfriamiento
prev_hot=1                        # asumimos que arrancamos CALIENTE (RSI venía en 70)
cooldown=0                        # vueltas de silencio tras avisar (evita re-disparo)

echo "$(date '+%H:%M:%S') watcher RSI<$RSI_THRESH arrancado (esperando enfriamiento con tendencia intacta)"

while true; do
  VAL=$("$NODE" scripts/ohlcv_binance.js 2>/dev/null | "$NODE" scripts/calc_indicators.js)
  P=$(echo "$VAL"|cut -d'|' -f1);  E9=$(echo "$VAL"|cut -d'|' -f2); E21=$(echo "$VAL"|cut -d'|' -f3)
  R=$(echo "$VAL"|cut -d'|' -f4);  ER=$(echo "$VAL"|cut -d'|' -f7); VA=$(echo "$VAL"|cut -d'|' -f9)

  if [ "$P" = "0" ] || [ -z "$P" ]; then echo "$(date '+%H:%M:%S') sin datos"; sleep 6; continue; fi
  [ "$cooldown" -gt 0 ] && cooldown=$((cooldown-1))

  # ¿está caliente ahora? (RSI >= umbral)
  HOT=$("$NODE" -e "console.log($R>=$RSI_THRESH?1:0)")
  # ¿tendencia intacta y mercado vivo? (lo que hace que el enfriamiento valga la pena)
  TREND=$("$NODE" -e "console.log(($E9>$E21 && $ER>=0.40 && $VA>=50)?1:0)")

  if [ "$prev_hot" = "1" ] && [ "$HOT" = "0" ] && [ "$TREND" = "1" ] && [ "$cooldown" = "0" ]; then
    MSG="RSI enfrió a $R (bajo $RSI_THRESH) con tendencia viva (EMA9>EMA21, ER=$ER). Precio $P. Ojo al pullback a EMA9 (~$E9) + rebote con volumen para la entrada A+."
    echo "$(date '+%H:%M:%S') ALERTA: $MSG"
    ./scripts/notify.sh "ETH listo para vigilar" "$MSG" "Glass"
    cooldown=20   # ~2 min de silencio para no re-disparar en el mismo cruce
  else
    echo "$(date '+%H:%M:%S') RSI=$R hot=$HOT trend=$TREND (esperando)"
  fi

  prev_hot="$HOT"
  sleep 6
done
