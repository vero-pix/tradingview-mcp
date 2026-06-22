#!/bin/bash
# Watcher de STOP para las posiciones LONG abiertas de Vero.
# Vigila el precio de ETH (Binance, spot ~= Capital.com) y avisa cuando se acerca
# o pierde el nivel de stop, por si el bróker no ejecuta bien el SL.
#
#   STOP_LEVEL   nivel del stop (default 1737.5)
#   WARN_BUFFER  cuánto antes avisar (default 0.8 -> avisa al tocar ~1738.3)
#
# Uso:  STOP_LEVEL=1737.5 ./scripts/watch_stop.sh

NODE="$HOME/.local/share/fnm/aliases/default/bin/node"
[ -x "$NODE" ] || NODE="$(command -v node)"
DIR="$HOME/Trading/tradingview-mcp"; cd "$DIR" || exit 1

STOP_LEVEL="${STOP_LEVEL:-1737.5}"   # nivel EN PRECIO CAPITAL.COM (lo que ve Vero)
WARN_BUFFER="${WARN_BUFFER:-0.8}"
OFFSET="${OFFSET:-3.0}"               # Binance - Capital (Binance va ~3 arriba)
WARN_LEVEL=$("$NODE" -e "console.log(($STOP_LEVEL+$WARN_BUFFER).toFixed(2))")

state="ok"   # ok -> warn -> broken ; se re-arma al recuperar

echo "$(date '+%H:%M:%S') watcher STOP arrancado: stop=$STOP_LEVEL aviso=$WARN_LEVEL (precio Capital, offset $OFFSET)"

while true; do
  BP=$(BINANCE_INTERVAL=1m BINANCE_LIMIT=50 "$NODE" scripts/ohlcv_binance.js 2>/dev/null | "$NODE" -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const b=JSON.parse(s).bars;console.log(b[b.length-1].close)}catch(e){console.log('')}})")
  if [ -z "$BP" ]; then echo "$(date '+%H:%M:%S') sin datos"; sleep 6; continue; fi
  # convertir a precio Capital.com (lo que ve Vero en pantalla)
  P=$("$NODE" -e "console.log(($BP-$OFFSET).toFixed(2))")

  BROKEN=$("$NODE" -e "console.log($P<=$STOP_LEVEL?1:0)")
  NEAR=$("$NODE"   -e "console.log($P<=$WARN_LEVEL?1:0)")
  RECOV=$("$NODE"  -e "console.log($P>=$WARN_LEVEL+1?1:0)")

  if [ "$BROKEN" = "1" ] && [ "$state" != "broken" ]; then
    echo "$(date '+%H:%M:%S') STOP ROTO Capital=$P (Binance $BP)"
    ./scripts/notify.sh "ETH ROMPIÓ TU STOP" "Capital.com $P bajo $STOP_LEVEL. Si el broker no ejecutó el SL, CIERRA MANUAL las posiciones ahora." "Basso"
    state="broken"
  elif [ "$NEAR" = "1" ] && [ "$state" = "ok" ]; then
    echo "$(date '+%H:%M:%S') CERCA Capital=$P (Binance $BP)"
    ./scripts/notify.sh "ETH cerca de tu stop" "Capital.com $P, acercándose a $STOP_LEVEL. Ten lista la salida." "Glass"
    state="warn"
  elif [ "$RECOV" = "1" ] && [ "$state" != "ok" ]; then
    echo "$(date '+%H:%M:%S') recuperó Capital=$P (re-armado)"
    state="ok"
  else
    echo "$(date '+%H:%M:%S') Capital=$P (Binance $BP) state=$state"
  fi

  sleep 6
done
