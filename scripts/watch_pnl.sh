#!/bin/bash
# Watcher de P&L REAL — vigila la posición abierta de Vero vía la API de Capital.com
# y avisa por Telegram/macOS cuando el P&L cruza un umbral de ganancia o pérdida.
#
# A diferencia de los watchers de precio, este lee la POSICIÓN real (entrada, size,
# bid) directo del bróker, así el P&L es exacto y no estimado.
#
#   PNL_ALERT_USD   avisa si |P&L| ≥ este monto en USD (ej. ganancia objetivo / pérdida límite)
#   PNL_ALERT_PCT   avisa si |P&L %| ≥ este porcentaje
#   ACCOUNT         cuenta de Capital (default "USD 2")
#   EPIC            instrumento (default ETHUSD)
#   INTERVAL        segundos entre lecturas (default 30 — /positions tiene rate limit ~0,1 req/s)
#   DEMO=1          usar cuenta demo
#
# Uso:  PNL_ALERT_USD=20 ./scripts/watch_pnl.sh
#       (avisa cuando la posición gane o pierda $20)

NODE="$HOME/.local/share/fnm/aliases/default/bin/node"
[ -x "$NODE" ] || NODE="$(command -v node)"
DIR="$HOME/Trading/tradingview-mcp"; cd "$DIR" || exit 1

ACCOUNT="${ACCOUNT:-USD 2}"
EPIC="${EPIC:-ETHUSD}"
INTERVAL="${INTERVAL:-30}"
[ "${DEMO:-0}" = "1" ] && DEMO_FLAG="--demo" || DEMO_FLAG=""

# Estado para no repetir la misma alerta: "armed" hasta avisar, luego espera
# que el P&L vuelva dentro de banda para re-armarse.
armed=1

echo "$(date '+%H:%M:%S') watcher P&L arrancado: cuenta='$ACCOUNT' epic=$EPIC interval=${INTERVAL}s"
echo "$(date '+%H:%M:%S')   umbrales: USD=${PNL_ALERT_USD:-(sin)} PCT=${PNL_ALERT_PCT:-(sin)}"

while true; do
  JSON=$("$NODE" scripts/capital_position.cjs $DEMO_FLAG --epic "$EPIC" --account "$ACCOUNT" --json 2>/dev/null)
  if [ -z "$JSON" ]; then echo "$(date '+%H:%M:%S') sin datos (API)"; sleep "$INTERVAL"; continue; fi

  # Extraer campos con node (JSON robusto)
  read PNL PCT ENTRY BID COUNT < <("$NODE" -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      try{const o=JSON.parse(s);
        if(o.pnl===null||o.unrealizedPnl===undefined){console.log("NONE 0 0 0 0");}
        else{console.log([o.unrealizedPnl,o.pnlPct,o.weightedAvgEntry,o.bid,o.count].join(" "));}
      }catch(e){console.log("ERR 0 0 0 0");}
    });' <<< "$JSON")

  if [ "$PNL" = "NONE" ]; then echo "$(date '+%H:%M:%S') sin posición abierta"; armed=1; sleep "$INTERVAL"; continue; fi
  if [ "$PNL" = "ERR" ];  then echo "$(date '+%H:%M:%S') JSON inválido"; sleep "$INTERVAL"; continue; fi

  # ¿Cruza algún umbral?
  HIT=$("$NODE" -e "
    const pnl=Math.abs($PNL), pct=Math.abs($PCT);
    const u=process.env.PNL_ALERT_USD, p=process.env.PNL_ALERT_PCT;
    let hit=false;
    if(u!=null && u!=='' && pnl>=Number(u)) hit=true;
    if(p!=null && p!=='' && pct>=Number(p)) hit=true;
    console.log(hit?1:0);
  ")

  if [ "$HIT" = "1" ] && [ "$armed" = "1" ]; then
    SIGN=$("$NODE" -e "console.log($PNL>=0?'GANANDO':'PERDIENDO')")
    SOUND=$("$NODE" -e "console.log($PNL>=0?'Hero':'Basso')")
    echo "$(date '+%H:%M:%S') ALERTA P&L=$PNL ($PCT%) $SIGN"
    ./scripts/notify.sh "ETH P&L: $PNL USD ($PCT%)" \
      "$SIGN — entrada $ENTRY, bid $BID, $COUNT lotes. Cuenta $ACCOUNT." "$SOUND"
    armed=0
  elif [ "$HIT" = "0" ] && [ "$armed" = "0" ]; then
    echo "$(date '+%H:%M:%S') P&L=$PNL ($PCT%) — dentro de banda (re-armado)"
    armed=1
  else
    echo "$(date '+%H:%M:%S') P&L=$PNL ($PCT%) entrada=$ENTRY bid=$BID armed=$armed"
  fi

  sleep "$INTERVAL"
done
