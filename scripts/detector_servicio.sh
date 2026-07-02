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

# --- Alertas de ZONAS (niveles S/R marcados en scripts/zonas.env) ---
# Avisan al ACERCARSE o ROMPER tus niveles, INDEPENDIENTE de la señal A+.
# Se relee zonas.env en cada vuelta, así editar el archivo aplica al toque.
ZONE_ALERTS="${ZONE_ALERTS:-1}"       # 1 = avisar al tocar zonas; 0 = desactivar
ZONE_THRESH="${ZONE_THRESH:-0.0015}"  # proximidad: 0.15% del precio (~$2.5 en ETH)
ZONES_STATE="{}"                       # estado previo por nivel (para detectar cruces)

# --- Multi-instrumento: configurable por env (default ETH). Para BTC:
#     BINANCE_SYMBOL=BTCUSDT EPIC=BTCUSD ZONAS_FILE=scripts/zonas_BTCUSD.env LIQ_MIN=8 ---
SYMBOL="${BINANCE_SYMBOL:-ETHUSDT}"          # símbolo Binance
EPIC="${EPIC:-ETHUSD}"                        # epic Capital (para el bot)
ZONAS_FILE="${ZONAS_FILE:-scripts/zonas.env}"
LIQ_MIN="${LIQ_MIN:-50}"                      # volumen absoluto mínimo (asset-específico)
# ADAPTATIVO al régimen: los umbrales se miden en MÚLTIPLOS DE ATR (la volatilidad
# real del momento). Así el listón sube solo en mercado volátil (para no picar en el
# ruido) y baja en mercado calmo. También unifica ETH y BTC (el ATR ya escala a cada
# uno). Los defaults reproducen la calibración de ETH a volatilidad típica.
TREND_ATR="${TREND_ATR:-0.25}"                # EMA9-EMA21 >= 0.25×ATR (tendencia sobre el ruido)
PULLBACK_ATR="${PULLBACK_ATR:-0.5}"           # P-EMA9 <= 0.5×ATR (pullback dentro del ruido)
MOM5_ATR="${MOM5_ATR:-1.1}"                   # mom5 >= 1.1×ATR (el rebote debe superar el ruido)

while true; do
  # Datos desde Binance (volumen REAL). El feed de Capital.com en TV no entrega
  # volumen (siempre 1); ver scripts/ohlcv_binance.js. Vero sigue OPERANDO en
  # Capital.com — solo la DETECCIÓN de la señal usa datos de Binance.
  VAL=$(BINANCE_SYMBOL="$SYMBOL" "$NODE" scripts/ohlcv_binance.js 2>/dev/null | "$NODE" scripts/calc_indicators.js)
  P=$(echo "$VAL"|cut -d'|' -f1); E9=$(echo "$VAL"|cut -d'|' -f2); E21=$(echo "$VAL"|cut -d'|' -f3)
  R=$(echo "$VAL"|cut -d'|' -f4); M5=$(echo "$VAL"|cut -d'|' -f5); M2=$(echo "$VAL"|cut -d'|' -f6); ER=$(echo "$VAL"|cut -d'|' -f7); VR=$(echo "$VAL"|cut -d'|' -f8); VA=$(echo "$VAL"|cut -d'|' -f9); AT=$(echo "$VAL"|cut -d'|' -f10)

  # RÉGIMEN del mercado según la volatilidad real (ATR% = ATR/precio). Los umbrales
  # ya se adaptan (van en múltiplos de ATR); esto es solo para MOSTRARLO.
  REGIMEN=$([ -n "$P" ] && [ "$P" != "0" ] && "$NODE" -e "const a=($AT/$P*100);console.log(a<0.07?'calmo':(a>0.14?'volátil':'normal'))" 2>/dev/null || echo "?")

  [ "$cooldown" -gt 0 ] && cooldown=$((cooldown-1))

  if [ "$P" = "0" ] || [ -z "$P" ]; then echo "$(date '+%H:%M:%S') sin datos"; sleep 6; continue; fi

  # --- ZONAS: avisa al ACERCARSE o ROMPER tus niveles. Corre SIEMPRE, antes
  #     de los filtros, así te enteras aunque el mercado esté choppy/muerto. ---
  if [ "$ZONE_ALERTS" = "1" ]; then
    ZONAS=$(grep -E '^export ZONAS=' "$ZONAS_FILE" 2>/dev/null | sed 's/.*="//; s/".*//')
    if [ -n "$ZONAS" ]; then
      ZRES=$(PRICE="$P" LEVELS="$ZONAS" PREV="$ZONES_STATE" THRESH="$ZONE_THRESH" "$NODE" scripts/level_alert.js 2>/dev/null)
      NEWZ=$(echo "$ZRES" | "$NODE" -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.stringify(JSON.parse(s).state))}catch(e){console.log('')}})")
      [ -n "$NEWZ" ] && ZONES_STATE="$NEWZ"
      echo "$ZRES" | "$NODE" -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{(JSON.parse(s).alerts||[]).forEach(a=>console.log(a))}catch(e){}})" | while IFS= read -r A; do
        [ -z "$A" ] && continue
        # ruptura al alza = verde (Hero), a la baja = rojo (Basso), proximidad = info (Glass)
        case "$A" in *ALZA*) SND=Hero;; *BAJA*) SND=Basso;; *) SND=Glass;; esac
        echo "$(date '+%H:%M:%S') ZONA: $A"
        ./scripts/notify.sh "Zona ETH" "$A" "$SND"
      done
    fi
  fi

  # FILTRO LIQUIDEZ: si el volumen absoluto es ridículo (<50), mercado muerto
  # sin liquidez (madrugada) -> movimientos fantasma, NO operar.
  LIQ=$("$NODE" -e "console.log($VA>=$LIQ_MIN?1:0)")
  if [ "$LIQ" = "0" ]; then echo "$(date '+%H:%M:%S') mercado muerto sin liquidez (vol=$VA)"; pb=0; sleep 6; continue; fi

  DIR_OK=$("$NODE" -e "console.log($ER>=0.40?1:0)")
  if [ "$DIR_OK" = "0" ]; then echo "$(date '+%H:%M:%S') choppy ER=$ER (régimen $REGIMEN, ATR=$AT)"; pb=0; sleep 6; continue; fi
  TREND=$("$NODE" -e "console.log(($E9-$E21)>=($TREND_ATR*$AT)?1:0)")
  if [ "$TREND" = "0" ]; then echo "$(date '+%H:%M:%S') EMAs planas ER=$ER"; pb=0; sleep 6; continue; fi
  # CONTEXTO 5m (igual que el indicador filtro 3): el marco de 5m también debe ser
  # tendencial (ER 5m >= 0.40). Solo se consulta acá, cuando el 1m ya viene bien.
  ER5=$(BINANCE_SYMBOL="$SYMBOL" BINANCE_INTERVAL=5m BINANCE_LIMIT=100 "$NODE" scripts/ohlcv_binance.js 2>/dev/null | "$NODE" scripts/calc_indicators.js | cut -d'|' -f7)
  CTX5=$("$NODE" -e "console.log(($ER5>=0.40)?1:0)")
  if [ "$CTX5" = "0" ]; then echo "$(date '+%H:%M:%S') contexto 5m débil (ER5=$ER5)"; pb=0; sleep 6; continue; fi
  NEAR=$("$NODE" -e "console.log(($P-$E9)<=($PULLBACK_ATR*$AT)?1:0)")
  [ "$NEAR" = "1" ] && pb=1
  # filtro de VOLUMEN: el rebote debe venir con volumen sobre lo normal (volr>=1.2)
  REB=$("$NODE" -e "console.log(($pb==1 && $M2>=1.0 && $P>=$E9 && $R>=50 && $R<=62 && $M5>=($MOM5_ATR*$AT) && $VR>=1.2)?1:0)")

  if [ "$REB" = "1" ] && [ "$cooldown" -eq 0 ]; then
    # Stop = entrada − 2×ATR (volatilidad real). Objetivo = entrada + 2×ATR (RR 1:1, scalp).
    SL=$("$NODE" -e "console.log(($P-2*$AT).toFixed(2))")
    TP=$("$NODE" -e "console.log(($P+2*$AT).toFixed(2))")
    RISK=$("$NODE" -e "console.log((2*$AT).toFixed(2))")
    # Precio máximo de entrada: si el precio sube >$2 sobre la señal, ya no conviene entrar
    # porque el ratio riesgo/beneficio se invierte (el target queda muy cerca y el stop lejos).
    MAX_ENTRY=$("$NODE" -e "console.log(($P+2).toFixed(2))")
    echo "$(date '+%H:%M:%S') >>> ENTRADA p=$P rsi=$R ER=$ER vol=$VR sl=$SL tp=$TP maxEntry=$MAX_ENTRY"
    ./scripts/notify.sh "SEÑAL LONG · $EPIC $P · Vero" "✅ ENTRADA $P | 🛑 STOP $SL | 🎯 OBJETIVO $TP (riesgo \$$RISK). Régimen: $REGIMEN. DIRECCIONAL (ER=$ER) + VOLUMEN ${VR}x, RSI $R. Confirma VWAP. Si pierde el STOP, SAL. NO promedies. ⏰ CADUCA si precio > \$$MAX_ENTRY (no perseguir)." "Hero"
    # Armar orden (opcional, default OFF): escribe la señal para el bot de Telegram,
    # que le manda a Vero los botones ✅/❌. Se activa con ARM_ORDER=1 en el entorno.
    # NO ejecuta nada acá: el bot ejecuta solo si Vero toca ✅. Precios traducidos a
    # Capital.com (Binance − offset ~3) para el chequeo de no-perseguir del bot.
    if [ "${ARM_ORDER:-0}" = "1" ]; then
      OFF="${OFFSET:-3.0}"
      SIG_TS=$(( $(date +%s) * 1000 ))
      CAP_ENTRY=$("$NODE" -e "console.log(($P-$OFF).toFixed(2))")
      CAP_SL=$("$NODE"    -e "console.log(($SL-$OFF).toFixed(2))")
      CAP_TP=$("$NODE"    -e "console.log(($TP-$OFF).toFixed(2))")
      printf '{"id":"sig%s","ts":%s,"epic":"%s","entry":%s,"stop":%s,"tp":%s}\n' \
        "$SIG_TS" "$SIG_TS" "$EPIC" "$CAP_ENTRY" "$CAP_SL" "$CAP_TP" > "/tmp/vero_pending_${EPIC}.json"
    fi
    cooldown=50   # ~5 min de silencio tras avisar
    pb=0
  else
    echo "$(date '+%H:%M:%S') p=$P rsi=$R ER=$ER pb=$pb cd=$cooldown"
  fi
  sleep 6
done
