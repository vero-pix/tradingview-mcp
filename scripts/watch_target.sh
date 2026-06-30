#!/bin/bash
# Watcher de OBJETIVO (toma de ganancia) para las posiciones LONG de Vero.
# Avisa cuando ETH alcanza un nivel de salida al alza.
#
#   TARGET   nivel objetivo (default 1745)
#   MSG      texto extra del aviso
#   USE_CAPITAL  =1 usa el BID REAL de Capital.com (API); el OFFSET deja de aplicarse.
#
# Uso:  TARGET=1745 ./scripts/watch_target.sh
#       USE_CAPITAL=1 TARGET=1580 ./scripts/watch_target.sh   # precio real del bróker

NODE="$HOME/.local/share/fnm/aliases/default/bin/node"
[ -x "$NODE" ] || NODE="$(command -v node)"
DIR="$HOME/Trading/tradingview-mcp"; cd "$DIR" || exit 1

TARGET="${TARGET:-1745}"             # nivel EN PRECIO CAPITAL.COM (lo que ve Vero)
OFFSET="${OFFSET:-3.0}"               # Binance - Capital (Binance va ~3 arriba)
MSG="${MSG:-Cierra al menos la mitad (las mas rojas). No le pidas que rompa la resistencia con volumen flojo.}"

state="below"   # below -> hit ; se re-arma si vuelve a caer bien abajo

USE_CAPITAL="${USE_CAPITAL:-0}"
SLEEP=6
[ "$USE_CAPITAL" = "1" ] && SLEEP=8
SRC=$([ "$USE_CAPITAL" = "1" ] && echo "Capital API (bid real)" || echo "Binance-offset $OFFSET")

echo "$(date '+%H:%M:%S') watcher OBJETIVO arrancado: target=$TARGET (fuente: $SRC)"

while true; do
  if [ "$USE_CAPITAL" = "1" ]; then
    P=$("$NODE" scripts/capital_price.cjs ETHUSD --field bid 2>/dev/null); BP="$P"
  else
    BP=$(BINANCE_INTERVAL=1m BINANCE_LIMIT=50 "$NODE" scripts/ohlcv_binance.js 2>/dev/null | "$NODE" -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const b=JSON.parse(s).bars;console.log(b[b.length-1].close)}catch(e){console.log('')}})")
    P=$([ -n "$BP" ] && "$NODE" -e "console.log(($BP-$OFFSET).toFixed(2))")
  fi
  if [ -z "$P" ]; then echo "$(date '+%H:%M:%S') sin datos"; sleep "$SLEEP"; continue; fi

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

  sleep "$SLEEP"
done
