#!/bin/bash
# Detector de entrada PERMANENTE (servicio launchd). Vigila ETH 24/7 y avisa
# por Telegram + macOS cuando hay una entrada A+ (5 filtros). Corre indefinido.
#
# Filtros: anti-choppy (ER>=0.30 en 1m y >=0.25 en 5m) + tendencia (EMA9>EMA21)
#          + pullback a EMA9 + rebote con momentum + RSI 50-70. (El VWAP lo confirma
#          Vero en pantalla.) Calibrado con backtest_aplus_sweep.cjs el 2026-07-02.

NODE="$HOME/.local/share/fnm/aliases/default/bin/node"
[ -x "$NODE" ] || NODE="$(command -v node)"
DIR="$HOME/Trading/tradingview-mcp"
cd "$DIR" || exit 1

pb=0
cooldown=0   # lecturas restantes de silencio tras una alerta A+ (evita spam)
PREAVISO="${PREAVISO:-1}"  # 1 = mandar pre-aviso suave cuando falta SOLO el gatillo del rebote

# --- Anti-flapping del pre-aviso ("Se está armando") ---
# DEDUP por clave gruesa (símbolo+estado, SIN el precio) + cooldown por tiempo real.
# Así, si solo cambia el precio del texto NO se considera un cambio de estado y no
# se reenvía; el mismo aviso no se repite antes de COOLDOWN_MIN.
COOLDOWN_MIN="${COOLDOWN_MIN:-25}"
COOLDOWN_SEC=$((COOLDOWN_MIN * 60))
last_pre_key=""   # última clave gruesa avisada (ej. "BTCUSDT:gatillo")
last_pre_ts=0     # epoch (s) del último pre-aviso

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
MOM5_ATR="${MOM5_ATR:-0.6}"                   # mom5 >= 0.6×ATR (rebote con momentum, SIN perseguir el envión — ver calibración 2026-07-02)
# Filtros de calidad, calibrados por instrumento (defaults = ETH, ver backtest_aplus_sweep.cjs 2026-07-02).
# BTC los sobreescribe en su plist (ER5=0, RSI_HI=74) porque su edge vive en otra zona.
ER1_MIN="${ER1_MIN:-0.30}"                    # ER 1m mínimo (PISO DURO: bajo 0.30 el edge se muere)
ER5_MIN="${ER5_MIN:-0.25}"                    # ER 5m mínimo (0 = desactiva el filtro de contexto 5m)
RSI_HI="${RSI_HI:-70}"                        # techo de RSI de entrada (banda de rebote; sobre esto = perseguir)
VOLR_MIN="${VOLR_MIN:-1.0}"                   # volr mínimo del rebote (volumen sobre lo normal)
# --- Knobs para SHADOW-TEST (defaults = comportamiento idéntico al real) ---
RSI_LO="${RSI_LO:-50}"                         # piso de RSI de entrada (default 50)
SIG_FILE="${SIG_FILE:-$HOME/Trading/senales_aplus.jsonl}"   # dónde registrar señales A+
CASI_FILE="${CASI_FILE:-$HOME/Trading/casi_senales.jsonl}"  # dónde registrar casi-señales
SILENT="${SILENT:-0}"                          # 1 = shadow: NO manda alertas Telegram/macOS
notify_maybe() { [ "${SILENT:-0}" = "1" ] || ./scripts/notify.sh "$@"; }

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
        notify_maybe "Zona ETH" "$A" "$SND"
      done
    fi
  fi

  # FRANJA MADRUGADA: el backtest (2026-07-05) mostró que 00-07 Chile fue la franja
  # floja (WR 50%). Vero decidió operar A+ 24/7, así que el filtro está DESCARTADO
  # por defecto (MADRUGADA_MODE=off). Se puede reactivar con MADRUGADA_MODE=block
  # (no arma señal 00-07) o =warn (arma pero con etiqueta de aviso). Default: off.
  MADRUGADA_MODE="${MADRUGADA_MODE:-off}"
  MADRUGADA_TAG=""
  if [ "$MADRUGADA_MODE" != "off" ]; then
    HORA_CL=$(TZ="America/Santiago" date '+%H')
    if [ "$HORA_CL" -ge 0 ] 2>/dev/null && [ "$HORA_CL" -le 7 ]; then
      if [ "$MADRUGADA_MODE" = "block" ]; then
        echo "$(date '+%H:%M:%S') madrugada (${HORA_CL}h Chile) — señal bloqueada, solo radar"; pb=0; sleep 6; continue
      fi
      MADRUGADA_TAG=" ⚠️ MADRUGADA (franja histórica floja WR 50%)"
    fi
  fi

  # FILTRO LIQUIDEZ: si el volumen absoluto es ridículo (<50), mercado muerto
  # sin liquidez (madrugada) -> movimientos fantasma, NO operar.
  LIQ=$("$NODE" -e "console.log($VA>=$LIQ_MIN?1:0)")
  if [ "$LIQ" = "0" ]; then echo "$(date '+%H:%M:%S') mercado muerto sin liquidez (vol=$VA)"; pb=0; sleep 6; continue; fi

  DIR_OK=$("$NODE" -e "console.log($ER>=$ER1_MIN?1:0)")
  if [ "$DIR_OK" = "0" ]; then echo "$(date '+%H:%M:%S') choppy ER=$ER (régimen $REGIMEN, ATR=$AT)"; pb=0; sleep 6; continue; fi
  TREND=$("$NODE" -e "console.log(($E9-$E21)>=($TREND_ATR*$AT)?1:0)")
  if [ "$TREND" = "0" ]; then echo "$(date '+%H:%M:%S') EMAs planas ER=$ER"; pb=0; sleep 6; continue; fi
  # CONTEXTO 5m (igual que el indicador filtro 3): el marco de 5m también debe ser
  # tendencial (ER 5m >= 0.25). Solo se consulta acá, cuando el 1m ya viene bien.
  ER5=$(BINANCE_SYMBOL="$SYMBOL" BINANCE_INTERVAL=5m BINANCE_LIMIT=100 "$NODE" scripts/ohlcv_binance.js 2>/dev/null | "$NODE" scripts/calc_indicators.js | cut -d'|' -f7)
  CTX5=$("$NODE" -e "console.log(($ER5_MIN<=0 || $ER5>=$ER5_MIN)?1:0)")
  if [ "$CTX5" = "0" ]; then echo "$(date '+%H:%M:%S') contexto 5m débil (ER5=$ER5)"; pb=0; sleep 6; continue; fi
  NEAR=$("$NODE" -e "console.log(($P-$E9)<=($PULLBACK_ATR*$AT)?1:0)")
  [ "$NEAR" = "1" ] && pb=1
  # filtro de VOLUMEN: el rebote debe venir con volumen sobre lo normal (volr>=1.0)
  REB=$("$NODE" -e "console.log(($pb==1 && $M2>=1.0 && $P>=$E9 && $R>=$RSI_LO && $R<=$RSI_HI && $M5>=($MOM5_ATR*$AT) && $VR>=$VOLR_MIN)?1:0)")

  if [ "$REB" = "1" ] && [ "$cooldown" -eq 0 ]; then
    # Stop = entrada − 2×ATR (volatilidad real). Objetivo = entrada + 2×ATR (RR 1:1, scalp).
    SL=$("$NODE" -e "console.log(($P-2*$AT).toFixed(2))")
    TP=$("$NODE" -e "console.log(($P+2*$AT).toFixed(2))")
    RISK=$("$NODE" -e "console.log((2*$AT).toFixed(2))")
    # Precio máximo de entrada: si el precio sube >$2 sobre la señal, ya no conviene entrar
    # porque el ratio riesgo/beneficio se invierte (el target queda muy cerca y el stop lejos).
    MAX_ENTRY=$("$NODE" -e "console.log(($P+2).toFixed(2))")
    echo "$(date '+%H:%M:%S') >>> ENTRADA p=$P rsi=$R ER=$ER vol=$VR sl=$SL tp=$TP maxEntry=$MAX_ENTRY"
    notify_maybe "SEÑAL LONG · $EPIC $P · Vero" "✅ ENTRADA $P | 🛑 STOP $SL | 🎯 OBJETIVO $TP (riesgo \$$RISK). Régimen: $REGIMEN. DIRECCIONAL (ER=$ER) + VOLUMEN ${VR}x, RSI $R. Confirma VWAP. Si pierde el STOP, SAL. NO promedies. ⏰ CADUCA si precio > \$$MAX_ENTRY (no perseguir)." "Hero"
    # Diario de señales (para el score vs backtest): una línea JSON por señal disparada.
    # Lo evalúa scripts/senales_score.cjs (¿tocó el TP o el SL primero?) y compara el
    # win rate REAL contra el esperado del backtest. NO afecta la operación.
    printf '{"ts":%s,"fecha":"%s","symbol":"%s","epic":"%s","entry":%s,"sl":%s,"tp":%s,"atr":%s,"rsi":%s,"er":%s,"volr":%s,"regimen":"%s"}\n' \
      "$(( $(date +%s) * 1000 ))" "$(date '+%Y-%m-%d %H:%M:%S')" "$SYMBOL" "$EPIC" "$P" "$SL" "$TP" "$AT" "$R" "$ER" "$VR" "$REGIMEN" \
      >> "$SIG_FILE"
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
    # Radar de casi-señales: si el contexto ya pasó (liquidez/ER/tendencia/5m) y al
    # rebote le faltaron 1-2 condiciones, deja registro. NO avisa ni suena — solo mide,
    # para que el reporte diario cuente "qué tan cerca estuvo" (y para detectar si los
    # filtros quedaron muy apretados). Lo lee scripts/senales_score.cjs.
    if [ "$cooldown" -eq 0 ]; then
      NM=$("$NODE" -e "
        const fal = [];
        if ($pb != 1) fal.push('pullback');
        if ($M2 < 1.0) fal.push('mom2');
        if ($P < $E9) fal.push('sobre-EMA9');
        if ($R < 50 || $R > $RSI_HI) fal.push('rsi');
        if ($M5 < ($MOM5_ATR * $AT)) fal.push('mom5');
        if ($VR < $VOLR_MIN) fal.push('volr');
        if (fal.length >= 1 && fal.length <= 2)
          console.log(JSON.stringify({ ts: Date.now(), fecha: '$(date '+%Y-%m-%d %H:%M')', symbol: '$SYMBOL', faltaron: fal, p: $P, rsi: $R, er: $ER, volr: $VR }));
      " 2>/dev/null)
      [ -n "$NM" ] && echo "$NM" >> "$CASI_FILE"

      # PRE-AVISO (heads-up suave, 🟡): el contexto ya pasó (liquidez/ER/tendencia/5m)
      # y el setup está estructurado (hubo pullback) — falta SOLO el gatillo: que el
      # precio vuelva sobre EMA9 con impulso, o que el RSI entre en banda. NO arma
      # orden, sonido distinto al A+ (Ping vs Hero). Excluye a propósito pullback/volr/
      # mom5 como gatillo: si falta uno de esos, NO hay setup todavía (es ruido).
      if [ "$PREAVISO" = "1" ]; then
        # El node emite "CLAVE<TAB>MENSAJE": la CLAVE es el gatillo que falta
        # (rsi-hot / rsi-low / gatillo), SIN el precio — es el "estado" del aviso.
        PRE_RAW=$("$NODE" -e "
          const fal=[];
          if ($pb!=1) fal.push('pullback');
          if ($M2<1.0) fal.push('mom2');
          if ($P<$E9) fal.push('sobre-EMA9');
          if ($R<50||$R>$RSI_HI) fal.push('rsi');
          if ($M5<($MOM5_ATR*$AT)) fal.push('mom5');
          if ($VR<$VOLR_MIN) fal.push('volr');
          const trig=['mom2','sobre-EMA9','rsi'];
          if(fal.length===1 && trig.includes(fal[0])){
            let key, msg;
            if(fal[0]==='rsi'){
              if($R>$RSI_HI){ key='rsi-hot'; msg='RSI caliente '+($R).toFixed(0)+' — espera que enfríe bajo $RSI_HI, NO persigas'; }
              else { key='rsi-low'; msg='RSI bajo 50 ('+($R).toFixed(0)+') — aún sin fuerza para el rebote'; }
            } else { key='gatillo'; msg='falta el gatillo: que vuelva sobre EMA9 con impulso. Todo lo demás alineado — atenta a la pantalla.'; }
            console.log(key + '\t' + msg);
          }
        " 2>/dev/null)
        if [ -n "$PRE_RAW" ]; then
          PRE_KEY="$SYMBOL:$(printf '%s' "$PRE_RAW" | cut -f1)"
          PRE=$(printf '%s' "$PRE_RAW" | cut -f2-)
          NOW=$(date +%s)
          # DEDUP: misma clave gruesa dentro del cooldown → NO reenviar (aunque el
          # precio del texto cambie). Una clave DISTINTA sí avisa al toque.
          if [ "$PRE_KEY" = "$last_pre_key" ] && [ "$((NOW - last_pre_ts))" -lt "$COOLDOWN_SEC" ]; then
            echo "$(date '+%H:%M:%S') ~ pre-aviso $PRE_KEY en cooldown ($(( (COOLDOWN_SEC - (NOW - last_pre_ts)) / 60 ))min) — no reenvío"
          else
            echo "$(date '+%H:%M:%S') ~ PRE-AVISO [$PRE_KEY]: $PRE"
            notify_maybe "🟡 Se está armando · $EPIC $P" "$PRE (ER=$ER, volr=$VR). Esto NO es entrada — es aviso de que está cerca. Espera el ✅ del bot antes de operar." "Ping"
            last_pre_key="$PRE_KEY"; last_pre_ts="$NOW"
          fi
        fi
      fi
    fi
  fi
  sleep 6
done
