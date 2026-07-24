#!/bin/bash
# Watcher de OBJETIVO (toma de ganancia) para las posiciones LONG de Vero.
# Avisa cuando ETH alcanza un nivel de salida al alza. Precio: Binance.
#
#   TARGET   nivel objetivo (default 1745)
#   MSG      texto extra del aviso
#
# Uso:  TARGET=1745 ./scripts/watch_target.sh

NODE="$HOME/.local/share/fnm/aliases/default/bin/node"
[ -x "$NODE" ] || NODE="$(command -v node)"
DIR="$HOME/Trading/tradingview-mcp"; cd "$DIR" || exit 1

TARGET="${TARGET:-1745}"
MSG="${MSG:-Cierra al menos la mitad (las mas rojas). No le pidas que rompa la resistencia con volumen flojo.}"

state="below"   # below -> hit ; se re-arma si vuelve a caer bien abajo
SLEEP=6

echo "$(date '+%H:%M:%S') watcher OBJETIVO arrancado: target=$TARGET (fuente: Binance)"

while true; do
  P=$(BINANCE_INTERVAL=1m BINANCE_LIMIT=50 "$NODE" scripts/ohlcv_binance.js 2>/dev/null | "$NODE" -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const b=JSON.parse(s).bars;console.log(b[b.length-1].close)}catch(e){console.log('')}})")
  if [ -z "$P" ]; then echo "$(date '+%H:%M:%S') sin datos"; sleep "$SLEEP"; continue; fi

  HIT=$("$NODE"   -e "console.log($P>=$TARGET?1:0)")
  RESET=$("$NODE" -e "console.log($P<=$TARGET-2?1:0)")

  if [ "$HIT" = "1" ] && [ "$state" = "below" ]; then
    echo "$(date '+%H:%M:%S') OBJETIVO TOCADO $P"
    ./scripts/notify.sh "ETH tocó $TARGET — TOMA GANANCIA" "ETH $P. $MSG" "Hero"
    state="hit"
  elif [ "$RESET" = "1" ] && [ "$state" = "hit" ]; then
    echo "$(date '+%H:%M:%S') volvió abajo $P (re-armado)"
    state="below"
  else
    echo "$(date '+%H:%M:%S') $P state=$state"
  fi

  sleep "$SLEEP"
done
