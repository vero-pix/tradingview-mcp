#!/bin/bash
# Acompañamiento de salida (trailing por EMA9) para un LONG ya abierto.
# Te aguanta en el trade mientras el precio siga sobre la EMA9, y suena "SAL"
# cuando el precio cierra bajo la EMA9 (momentum agotado) o toca el stop duro.
#
# Uso: ./scripts/trailing_exit.sh <precio_entrada> [stop_duro]
#   ej: ./scripts/trailing_exit.sh 1643.5 1636
#
# Pensado para correr en background. Avisa por notificación macOS con sonido.

cd "$(dirname "$0")/.." || exit 1
ENTRY="${1:?Falta precio de entrada}"
STOP="${2:-0}"              # stop duro opcional (salida por riesgo)
INTERVAL="${3:-6}"
below=0                      # lecturas consecutivas bajo EMA9
maxPnL=0

for i in $(seq 1 400); do
  VAL=$(node src/cli/index.js ohlcv 2>/dev/null | node scripts/calc_indicators.js)
  P=$(echo "$VAL" | cut -d'|' -f1); E9=$(echo "$VAL" | cut -d'|' -f2)
  if [ "$P" = "0" ] || [ -z "$P" ]; then echo "[$i] sin datos"; sleep "$INTERVAL"; continue; fi

  PNL=$(node -e "console.log(($P-$ENTRY).toFixed(2))")
  maxPnL=$(node -e "console.log(Math.max($maxPnL,$PNL).toFixed(2))")

  # ¿salida por stop duro?
  if [ "$STOP" != "0" ]; then
    HIT=$(node -e "console.log($P<=$STOP?1:0)")
    if [ "$HIT" = "1" ]; then
      "$(dirname "$0")/notify.sh" "SAL · STOP · Vero" "ETH tocó tu stop $STOP (precio $P, PnL $PNL). SAL para cortar." "Basso"
      echo "[$i] === STOP DURO TOCADO (PnL $PNL) ==="; break
    fi
  fi

  # ¿precio bajo EMA9? (confirmar 2 lecturas = momentum agotado)
  UNDER=$(node -e "console.log($P < $E9 ? 1 : 0)")
  if [ "$UNDER" = "1" ]; then
    below=$((below+1))
    echo "[$i] precio=$P EMA9=$E9 PnL=$PNL  ⚠️ bajo EMA9 ($below/2)"
    if [ "$below" -ge 2 ]; then
      "$(dirname "$0")/notify.sh" "SAL AHORA · Vero" "ETH cerró bajo EMA9 (precio $P, PnL $PNL, máx fue $maxPnL). Momentum agotado: SAL." "Hero"
      echo "[$i] === SALIDA: bajo EMA9 confirmado (PnL $PNL, máx $maxPnL) ==="; break
    fi
  else
    below=0
    echo "[$i] precio=$P EMA9=$E9 PnL=$PNL  🟢 AGUANTA (sobre EMA9, máx $maxPnL)"
  fi
  sleep "$INTERVAL"
done
