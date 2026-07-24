#!/bin/bash
# Watcher de STOP para las posiciones LONG abiertas de Vero.
# Vigila el precio de ETH en Binance (el mismo donde se opera) y avisa cuando se
# acerca o pierde el nivel de stop, por si el bróker no ejecuta bien el SL.
#
#   STOP_LEVEL   nivel del stop (default 1737.5)
#   WARN_BUFFER  cuánto antes avisar (default 0.8 -> avisa al tocar ~1738.3)
#
# Uso:  STOP_LEVEL=1737.5 ./scripts/watch_stop.sh

NODE="$HOME/.local/share/fnm/aliases/default/bin/node"
[ -x "$NODE" ] || NODE="$(command -v node)"
DIR="$HOME/Trading/tradingview-mcp"; cd "$DIR" || exit 1

STOP_LEVEL="${STOP_LEVEL:-1737.5}"   # nivel en precio Binance
WARN_BUFFER="${WARN_BUFFER:-0.8}"
WARN_LEVEL=$("$NODE" -e "console.log(($STOP_LEVEL+$WARN_BUFFER).toFixed(2))")

state="ok"   # ok -> warn -> broken ; se re-arma al recuperar
SLEEP=6

echo "$(date '+%H:%M:%S') watcher STOP arrancado: stop=$STOP_LEVEL aviso=$WARN_LEVEL (fuente: Binance)"

while true; do
  P=$(BINANCE_INTERVAL=1m BINANCE_LIMIT=50 "$NODE" scripts/ohlcv_binance.js 2>/dev/null | "$NODE" -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const b=JSON.parse(s).bars;console.log(b[b.length-1].close)}catch(e){console.log('')}})")
  if [ -z "$P" ]; then echo "$(date '+%H:%M:%S') sin datos"; sleep "$SLEEP"; continue; fi

  BROKEN=$("$NODE" -e "console.log($P<=$STOP_LEVEL?1:0)")
  NEAR=$("$NODE"   -e "console.log($P<=$WARN_LEVEL?1:0)")
  RECOV=$("$NODE"  -e "console.log($P>=$WARN_LEVEL+1?1:0)")

  if [ "$BROKEN" = "1" ] && [ "$state" != "broken" ]; then
    echo "$(date '+%H:%M:%S') STOP ROTO $P"
    ./scripts/notify.sh "ETH ROMPIÓ TU STOP" "ETH $P bajo $STOP_LEVEL. Si el bróker no ejecutó el SL, CIERRA MANUAL las posiciones ahora." "Basso"
    state="broken"
  elif [ "$NEAR" = "1" ] && [ "$state" = "ok" ]; then
    echo "$(date '+%H:%M:%S') CERCA $P"
    ./scripts/notify.sh "ETH cerca de tu stop" "ETH $P, acercándose a $STOP_LEVEL. Ten lista la salida." "Glass"
    state="warn"
  elif [ "$RECOV" = "1" ] && [ "$state" != "ok" ]; then
    echo "$(date '+%H:%M:%S') recuperó $P (re-armado)"
    state="ok"
  else
    echo "$(date '+%H:%M:%S') $P state=$state"
  fi

  sleep "$SLEEP"
done
