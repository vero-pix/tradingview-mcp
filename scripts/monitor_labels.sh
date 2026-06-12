#!/bin/bash
# Monitor de labels del indicador via el comando confiable `data labels`.
# Consulta cada INTERVAL segundos, registra en JSONL, escribe log legible y
# avisa con notificacion macOS + sonido cuando cambian los precios/patrones.
# Uso: ./scripts/monitor_labels.sh [intervalo_segundos]

cd "$(dirname "$0")/.." || exit 1

# launchd corre con PATH mínimo: aseguramos node (fnm) por ruta estable.
export PATH="$HOME/.local/share/fnm/aliases/default/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:$PATH"

INTERVAL="${1:-5}"
LOG="/tmp/tv_labels_monitor.jsonl"
PREV=""
FIRST=1
LINES_STATE="{}"
THRESH="${THRESH:-0.0025}"   # proximidad: 0.25% del precio
MANUAL_LEVELS="${MANUAL_LEVELS:-}"   # niveles fijos a vigilar (ej. stop), coma-sep

notify() {
  # $1 = titulo, $2 = cuerpo
  osascript -e "display notification \"$2\" with title \"$1\" sound name \"Glass\"" 2>/dev/null
}

echo "[monitor] iniciado — consultando 'data labels' cada ${INTERVAL}s. Log: $LOG"
notify "TradingView · Patrones" "Monitor de labels activo (cada ${INTERVAL}s)"

while true; do
  OUT=$(node src/cli/index.js data labels 2>/dev/null)
  # firma compacta: pares texto:precio
  SIG=$(echo "$OUT" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const o=JSON.parse(s);const st=(o.studies||[])[0];if(!st){console.log('NODATA');return}console.log(st.labels.map(l=>l.text+':'+l.price).join('|'))}catch(e){console.log('ERR')}})")
  TS=$(node -e "console.log(new Date().toISOString())")

  if [ "$SIG" != "$PREV" ] && [ "$SIG" != "NODATA" ] && [ "$SIG" != "ERR" ]; then
    echo "{\"ts\":\"$TS\",\"labels\":\"$SIG\"}" >> "$LOG"
    echo "[$TS] ⚡ CAMBIO detectado:"
    echo "$SIG" | tr '|' '\n' | sed 's/^/   /'

    if [ "$FIRST" -eq 0 ]; then
      # Calcular que labels cambiaron (texto que aparece/cambia de precio vs PREV)
      DIFF=$(PREV="$PREV" NEW="$SIG" node -e '
        const prev=Object.fromEntries((process.env.PREV||"").split("|").filter(Boolean).map(p=>{const i=p.lastIndexOf(":");return [p.slice(0,i),p.slice(i+1)]}));
        const cur=(process.env.NEW||"").split("|").filter(Boolean).map(p=>{const i=p.lastIndexOf(":");return [p.slice(0,i),p.slice(i+1)]});
        const ch=[];
        for(const [t,v] of cur){ if(prev[t]===undefined) ch.push(t+" nuevo "+v); else if(prev[t]!==v) ch.push(t+" "+prev[t]+"→"+v); }
        console.log(ch.slice(0,4).join(", ")||"actualización de labels");
      ')
      notify "TradingView · Patrones" "$DIFF"
    fi
    PREV="$SIG"
    FIRST=0
  fi

  # --- Niveles horizontales: proximidad y rupturas ---
  PRICE=$(node src/cli/index.js quote 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const o=JSON.parse(s);console.log(o.last||o.close||'')}catch(e){console.log('')}})")
  LEVELS=$(node src/cli/index.js data lines 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const o=JSON.parse(s);const lv=[];(o.studies||[]).forEach(st=>(st.horizontal_levels||[]).forEach(x=>lv.push(x)));console.log([...new Set(lv)].join(','))}catch(e){console.log('')}})")

  # Sumar niveles manuales fijos (stop, etc.) a los del indicador
  if [ -n "$MANUAL_LEVELS" ]; then
    LEVELS=$([ -n "$LEVELS" ] && echo "$LEVELS,$MANUAL_LEVELS" || echo "$MANUAL_LEVELS")
  fi

  if [ -n "$PRICE" ] && [ -n "$LEVELS" ]; then
    RES=$(PRICE="$PRICE" LEVELS="$LEVELS" PREV="$LINES_STATE" THRESH="$THRESH" node scripts/level_alert.js 2>/dev/null)
    NEWSTATE=$(echo "$RES" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.stringify(JSON.parse(s).state))}catch(e){console.log('{}')}})")
    [ -n "$NEWSTATE" ] && LINES_STATE="$NEWSTATE"
    # Emitir alertas (una por línea)
    echo "$RES" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{(JSON.parse(s).alerts||[]).forEach(a=>console.log(a))}catch(e){}})" | while IFS= read -r A; do
      [ -z "$A" ] && continue
      TS2=$(node -e "console.log(new Date().toISOString())")
      echo "[$TS2] $A"
      echo "{\"ts\":\"$TS2\",\"alert\":\"$A\"}" >> "$LOG"
      notify "TradingView · Nivel" "$A"
    done
  fi

  sleep "$INTERVAL"
done
