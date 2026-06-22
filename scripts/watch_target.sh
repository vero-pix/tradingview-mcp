#!/bin/bash
# Watcher de OBJETIVO (toma de ganancia) para las posiciones LONG de Vero.
# Avisa cuando ETH alcanza un nivel de salida al alza.
#
#   TARGET   nivel objetivo (default 1745)
#   MSG      texto extra del aviso
#
# Uso:  TARGET=1745 ./scripts/watch_target.sh

NODE="$HOME/.local/share/fnm/aliases/default/bin/node"
[ -x "$NODE" ] || NODE="$(command -v node)"
DIR="$HOME/Trading/tradingview-mcp"; cd "$DIR" || exit 1

TARGET="${TARGET:-1745}"             # nivel EN PRECIO CAPITAL.COM (lo que ve Vero)
OFFSET="${OFFSET:-3.0}"               # Binance - Capital (Binance va ~3 arriba)
MSG="${MSG:-Cierra al menos la mitad (las mas rojas). No le pidas que rompa la resistencia con volumen flojo.}"

state="below"   # below -> hit ; se re-arma si vuelve a caer bien abajo

echo "$(date '+%H:%M:%S') watcher OBJETIVO arrancado: target=$TARGET (precio Capital, offset $OFFSET)"

while true; do
  BP=$(BINANCE_INTERVAL=1m BINANCE_LIMIT=50 "$NODE" scripts/ohlcv_binance.js 2>/dev/null | "$NODE" -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const b=JSON.parse(s).bars;console.log(b[b.length-1].close)}catch(e){console.log('')}})")
  if [ -z "$BP" ]; then echo "$(date '+%H:%M:%S') sin datos"; sleep 6; continue; fi
  # convertir a precio Capital.com (lo que ve Vero en pantalla)
  P=$("$NODE" -e "console.log(($BP-$OFFSET).toFixed(2))")

  HIT=$("$NODE"   -e "console.log($P>=$TARGET?1:0)")
  RESET=$("$NODE" -e "console.log($P<=$TARGET-2?1:0)")

  if [ "$HIT" = "1" ] && [ "$state" = "below" ]; then
    echo "$(date '+%H:%M:%S') OBJETIVO TOCADO Capital=$P (Binance $BP)"
    ./scripts/notify.sh "ETH tocó $TARGET — TOMA GANANCIA" "Capital.com $P. $MSG" "Hero"
    state="hit"
  elif [ "$RESET" = "1" ] && [ "$state" = "hit" ]; then
    echo "$(date '+%H:%M:%S') volvió abajo Capital=$P (re-armado)"
    state="below"
  else
    echo "$(date '+%H:%M:%S') Capital=$P (Binance $BP) state=$state"
  fi

  sleep 6
done
