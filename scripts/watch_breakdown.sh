#!/bin/bash
# Watcher de QUIEBRE A LA BAJA — avisa si ETH pierde un nivel hacia abajo.
# Vero está FLAT; sirve para saber si sigue cayendo (no buscar long) o si frena.
# Precio: Binance.
#
#   LEVEL   nivel a vigilar (default 1730)
#
# Uso:  LEVEL=1730 ./scripts/watch_breakdown.sh

NODE="$HOME/.local/share/fnm/aliases/default/bin/node"
[ -x "$NODE" ] || NODE="$(command -v node)"
DIR="$HOME/Trading/tradingview-mcp"; cd "$DIR" || exit 1
LEVEL="${LEVEL:-1730}"

state="above"   # above -> broken ; re-arma si recupera bien arriba
SLEEP=6

echo "$(date '+%H:%M:%S') watcher QUIEBRE-BAJA arrancado: nivel=$LEVEL (fuente: Binance)"

while true; do
  P=$(BINANCE_INTERVAL=1m BINANCE_LIMIT=50 "$NODE" scripts/ohlcv_binance.js 2>/dev/null | "$NODE" -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const b=JSON.parse(s).bars;console.log(b[b.length-1].close)}catch(e){console.log('')}})")
  if [ -z "$P" ]; then echo "$(date '+%H:%M:%S') sin datos"; sleep "$SLEEP"; continue; fi

  BROKEN=$("$NODE" -e "console.log($P<=$LEVEL?1:0)")
  RECOV=$("$NODE"  -e "console.log($P>=$LEVEL+2?1:0)")

  if [ "$BROKEN" = "1" ] && [ "$state" = "above" ]; then
    echo "$(date '+%H:%M:%S') QUIEBRE-BAJA $P"
    ./scripts/notify.sh "ETH rompió $LEVEL ↓" "ETH $P bajo $LEVEL. Sigue cayendo — NO busques long, espera que frene y rebote." "Basso"
    state="broken"
  elif [ "$RECOV" = "1" ] && [ "$state" = "broken" ]; then
    echo "$(date '+%H:%M:%S') recuperó $P (re-armado)"
    state="above"
  else
    echo "$(date '+%H:%M:%S') $P state=$state"
  fi

  sleep "$SLEEP"
done
