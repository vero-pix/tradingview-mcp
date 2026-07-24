#!/bin/bash
# Watcher de GIRO AL ALZA — aviso temprano de que ETH deja de caer y empieza a
# rebotar, para que Vero esté lista ANTES de que el detector A+ marque la entrada.
# NO es señal de compra: es "ponte atenta, se está dando vuelta".
#
# Gatillo (desde estado caído): RSI cruza arriba de 50  AND  precio sobre EMA9
#   AND  momentum corto positivo (mom2>0). Un solo disparo; re-arma si recae.
#
#
# El gatillo depende de RSI/EMA/momentum, calculados desde el OHLCV de Binance.
#
# Uso:  ./scripts/watch_turnup.sh

NODE="$HOME/.local/share/fnm/aliases/default/bin/node"
[ -x "$NODE" ] || NODE="$(command -v node)"
DIR="$HOME/Trading/tradingview-mcp"; cd "$DIR" || exit 1

armed=1   # 1 = listo para avisar el giro ; 0 = ya avisó, espera recaída
echo "$(date '+%H:%M:%S') watcher GIRO arrancado (esperando RSI>50 + precio>EMA9 + mom2>0)"

while true; do
  VAL=$(BINANCE_INTERVAL=1m BINANCE_LIMIT=100 "$NODE" scripts/ohlcv_binance.js 2>/dev/null | "$NODE" scripts/calc_indicators.js 2>/dev/null)
  P=$(echo "$VAL"|cut -d'|' -f1); E9=$(echo "$VAL"|cut -d'|' -f2); R=$(echo "$VAL"|cut -d'|' -f4); M2=$(echo "$VAL"|cut -d'|' -f6); ER=$(echo "$VAL"|cut -d'|' -f7)
  if [ -z "$P" ] || [ "$P" = "0" ]; then echo "$(date '+%H:%M:%S') sin datos"; sleep 8; continue; fi

  TURN=$("$NODE"   -e "console.log(($R>50 && $P>$E9 && $M2>0)?1:0)")
  RESET=$("$NODE"  -e "console.log($R<42?1:0)")

  if [ "$TURN" = "1" ] && [ "$armed" = "1" ]; then
    echo "$(date '+%H:%M:%S') GIRO AL ALZA $P RSI=$R"
    ./scripts/notify.sh "ETH dando vuelta ↑" "ETH $P — RSI $R, recuperó EMA9 con momentum. Ponte atenta: si se confirma pullback+volumen, el detector A+ marca la entrada. NO entres al pico." "Glass"
    armed=0
  elif [ "$RESET" = "1" ] && [ "$armed" = "0" ]; then
    echo "$(date '+%H:%M:%S') recayó (RSI=$R) — re-armado"
    armed=1
  else
    echo "$(date '+%H:%M:%S') $P RSI=$R mom2=$M2 ER=$ER armed=$armed"
  fi

  sleep 8
done
