#!/bin/bash
# Watcher de QUIEBRE A LA BAJA — avisa si ETH pierde un nivel hacia abajo.
# Vero está FLAT; sirve para saber si sigue cayendo (no buscar long) o si frena.
#
#   LEVEL   nivel EN PRECIO CAPITAL.COM (lo que ve Vero)
#   OFFSET  Binance - Capital (default 3.0)
#
# Uso:  LEVEL=1730 ./scripts/watch_breakdown.sh

NODE="$HOME/.local/share/fnm/aliases/default/bin/node"
[ -x "$NODE" ] || NODE="$(command -v node)"
DIR="$HOME/Trading/tradingview-mcp"; cd "$DIR" || exit 1
LEVEL="${LEVEL:-1730}"
OFFSET="${OFFSET:-3.0}"

state="above"   # above -> broken ; re-arma si recupera bien arriba
echo "$(date '+%H:%M:%S') watcher QUIEBRE-BAJA arrancado: nivel=$LEVEL (precio Capital, offset $OFFSET)"

while true; do
  BP=$(BINANCE_INTERVAL=1m BINANCE_LIMIT=50 "$NODE" scripts/ohlcv_binance.js 2>/dev/null | "$NODE" -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const b=JSON.parse(s).bars;console.log(b[b.length-1].close)}catch(e){console.log('')}})")
  if [ -z "$BP" ]; then echo "$(date '+%H:%M:%S') sin datos"; sleep 6; continue; fi
  P=$("$NODE" -e "console.log(($BP-$OFFSET).toFixed(2))")

  BROKEN=$("$NODE" -e "console.log($P<=$LEVEL?1:0)")
  RECOV=$("$NODE"  -e "console.log($P>=$LEVEL+2?1:0)")

  if [ "$BROKEN" = "1" ] && [ "$state" = "above" ]; then
    echo "$(date '+%H:%M:%S') QUIEBRE-BAJA Capital=$P (Binance $BP)"
    ./scripts/notify.sh "ETH rompió $LEVEL ↓" "Capital.com $P bajo $LEVEL. Sigue cayendo — NO busques long, espera que frene y rebote." "Basso"
    state="broken"
  elif [ "$RECOV" = "1" ] && [ "$state" = "broken" ]; then
    echo "$(date '+%H:%M:%S') recuperó Capital=$P (re-armado)"
    state="above"
  else
    echo "$(date '+%H:%M:%S') Capital=$P (Binance $BP) state=$state"
  fi

  sleep 6
done
