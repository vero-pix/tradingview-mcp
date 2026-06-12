#!/bin/bash
# Detector de entrada PERMANENTE (servicio launchd). Vigila ETH 24/7 y avisa
# por Telegram + macOS cuando hay una entrada A+ (5 filtros). Corre indefinido.
#
# Filtros: anti-choppy (ER>=0.40) + tendencia (EMA9>EMA21) + pullback a EMA9
#          + rebote con momentum + RSI 50-64. (El VWAP lo confirma Vero en pantalla.)

NODE="$HOME/.local/share/fnm/aliases/default/bin/node"
[ -x "$NODE" ] || NODE="$(command -v node)"
DIR="$HOME/Trading/tradingview-mcp"
cd "$DIR" || exit 1

pb=0
cooldown=0   # lecturas restantes de silencio tras una alerta (evita spam)

while true; do
  # Datos desde Binance (volumen REAL). El feed de Capital.com en TV no entrega
  # volumen (siempre 1); ver scripts/ohlcv_binance.js. Vero sigue OPERANDO en
  # Capital.com — solo la DETECCIÓN de la señal usa datos de Binance.
  VAL=$("$NODE" scripts/ohlcv_binance.js 2>/dev/null | "$NODE" scripts/calc_indicators.js)
  P=$(echo "$VAL"|cut -d'|' -f1); E9=$(echo "$VAL"|cut -d'|' -f2); E21=$(echo "$VAL"|cut -d'|' -f3)
  R=$(echo "$VAL"|cut -d'|' -f4); M5=$(echo "$VAL"|cut -d'|' -f5); M2=$(echo "$VAL"|cut -d'|' -f6); ER=$(echo "$VAL"|cut -d'|' -f7); VR=$(echo "$VAL"|cut -d'|' -f8); VA=$(echo "$VAL"|cut -d'|' -f9)

  [ "$cooldown" -gt 0 ] && cooldown=$((cooldown-1))

  if [ "$P" = "0" ] || [ -z "$P" ]; then echo "$(date '+%H:%M:%S') sin datos"; sleep 6; continue; fi

  # FILTRO LIQUIDEZ: si el volumen absoluto es ridículo (<50), mercado muerto
  # sin liquidez (madrugada) -> movimientos fantasma, NO operar.
  LIQ=$("$NODE" -e "console.log($VA>=50?1:0)")
  if [ "$LIQ" = "0" ]; then echo "$(date '+%H:%M:%S') mercado muerto sin liquidez (vol=$VA)"; pb=0; sleep 6; continue; fi

  DIR_OK=$("$NODE" -e "console.log($ER>=0.40?1:0)")
  if [ "$DIR_OK" = "0" ]; then echo "$(date '+%H:%M:%S') choppy ER=$ER"; pb=0; sleep 6; continue; fi
  TREND=$("$NODE" -e "console.log(($E9-$E21)>=0.4?1:0)")
  if [ "$TREND" = "0" ]; then echo "$(date '+%H:%M:%S') EMAs planas ER=$ER"; pb=0; sleep 6; continue; fi
  NEAR=$("$NODE" -e "console.log(($P-$E9)<=0.8?1:0)")
  [ "$NEAR" = "1" ] && pb=1
  # filtro de VOLUMEN: el rebote debe venir con volumen sobre lo normal (volr>=1.2)
  REB=$("$NODE" -e "console.log(($pb==1 && $M2>=1.0 && $P>=$E9 && $R>=50 && $R<=64 && $M5>=1.0 && $VR>=1.2)?1:0)")

  if [ "$REB" = "1" ] && [ "$cooldown" -eq 0 ]; then
    echo "$(date '+%H:%M:%S') >>> ENTRADA p=$P rsi=$R ER=$ER vol=$VR"
    ./scripts/notify.sh "SEÑAL LONG · confirma VWAP · Vero" "ETH $P: DIRECCIONAL (ER=$ER) + VOLUMEN fuerte (${VR}x), rebote desde EMA9, RSI $R. CONFIRMA que esté SOBRE tu VWAP. NO promedies." "Hero"
    cooldown=50   # ~5 min de silencio tras avisar
    pb=0
  else
    echo "$(date '+%H:%M:%S') p=$P rsi=$R ER=$ER pb=$pb cd=$cooldown"
  fi
  sleep 6
done
