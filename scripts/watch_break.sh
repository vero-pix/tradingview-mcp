#!/bin/bash
# Vigía de ruptura de un nivel: avisa por Telegram+macOS cuando una vela de 1m
# CIERRA por encima (o debajo) de un nivel — ruptura confirmada, no un wick.
# Uso: LEVEL=1690 DIR=above MAX_MIN=90 ./scripts/watch_break.sh
#   DIR: above (rompe al alza) | below (rompe a la baja)
# Sale apenas avisa, o tras MAX_MIN minutos sin ruptura (timeout).

NODE="$HOME/.local/share/fnm/aliases/default/bin/node"
[ -x "$NODE" ] || NODE="$(command -v node)"
cd "$HOME/Trading/tradingview-mcp" || exit 1

LEVEL="${LEVEL:?Falta LEVEL}"
DIR="${DIR:-above}"
MAX_MIN="${MAX_MIN:-90}"
deadline=$(( $(date +%s) + MAX_MIN*60 ))

echo "$(date '+%H:%M:%S') [vigía] esperando ruptura $DIR de $LEVEL (timeout ${MAX_MIN}min)"

while [ "$(date +%s)" -lt "$deadline" ]; do
  # última vela 1m CERRADA: close y volumen vs promedio
  RES=$(BINANCE_INTERVAL=1m BINANCE_LIMIT=30 "$NODE" scripts/ohlcv_binance.js 2>/dev/null | "$NODE" -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      try{
        const b=(JSON.parse(s).bars||[]); if(b.length<5){console.log("err");return;}
        const closed=b[b.length-2];                  // última CERRADA (la -1 está en formación)
        const vols=b.slice(0,-1).map(x=>x.volume);
        const prom=vols.reduce((a,v)=>a+v,0)/vols.length;
        const ratio=(closed.volume/prom).toFixed(1);
        console.log(closed.close.toFixed(2)+"|"+ratio);
      }catch(e){console.log("err")}
    });')
  CLOSE=$(echo "$RES"|cut -d'|' -f1); VR=$(echo "$RES"|cut -d'|' -f2)

  if [ "$CLOSE" != "err" ] && [ -n "$CLOSE" ]; then
    if [ "$DIR" = "above" ]; then
      HIT=$("$NODE" -e "console.log($CLOSE>$LEVEL?1:0)")
    else
      HIT=$("$NODE" -e "console.log($CLOSE<$LEVEL?1:0)")
    fi
    if [ "$HIT" = "1" ]; then
      FUERZA=$("$NODE" -e "console.log($VR>=1.2?'con VOLUMEN fuerte ('+$VR+'x)':'volumen flojo ('+$VR+'x)')")
      echo "$(date '+%H:%M:%S') >>> HIT $LEVEL close=$CLOSE vr=$VR"
      if [ "$DIR" = "above" ]; then
        ./scripts/notify.sh "🚀 RUPTURA $LEVEL ↑ · Vero" "ETH cerró en $CLOSE, rompió $LEVEL $FUERZA. Este era tu gatillo. Confirma VWAP y decide. NO promedies." "Hero"
      else
        ./scripts/notify.sh "📉 PULLBACK a $LEVEL · Vero" "ETH bajó a $CLOSE (zona de re-entrada). NO compres el toque — espera el REBOTE con momentum y que tu detector dé la señal A+. Soporte fuerte: 1710-1716." "Glass"
      fi
      exit 0
    fi
    echo "$(date '+%H:%M:%S') [vigía] close=$CLOSE (aún $DIR=$LEVEL sin romper) vr=${VR}x"
  fi
  sleep 20
done

echo "$(date '+%H:%M:%S') [vigía] timeout sin ruptura"
./scripts/notify.sh "⏱️ Vigía 1690 · sin ruptura" "Pasaron ${MAX_MIN}min y ETH no rompió 1690 con cierre de 1m. Sigue enroscado. Avísame si quieres seguir vigilando." "Glass"
