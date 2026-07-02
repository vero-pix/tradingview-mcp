#!/bin/bash
# =============================================================================
# recalibracion_semanal.sh — ¿La config A+ de producción sigue viva esta semana?
#
# Corre la validación out-of-sample: la config que está en producción (la del
# detector) contra los últimos 7 días de datos reales (que ninguna calibración
# vio). Manda el veredicto a Telegram/macOS.
#
# NO cambia nada solo: si el edge se degradó, avisa "recalibrar JUNTAS" y el
# barrido se corre a mano con Claude (backtest_aplus_sweep.cjs). Seguridad primero.
#
# Programado: domingos 20:00 vía launchd (cl.vero.recalibracion).
# =============================================================================

cd "$(dirname "$0")/.." || exit 1

# node con ruta fija (fnm da rutas efímeras que launchd no resuelve)
NODE="$HOME/.local/share/fnm/aliases/default/bin/node"
[ -x "$NODE" ] || NODE=$(command -v node)

# La config de PRODUCCIÓN del detector ETH (mantener = detector_servicio.sh):
#   er1, er5, rsiLo, rsiHi, mom5×ATR, trend×ATR, pullback×ATR, volr
PROD="0.30,0.25,50,70,0.6,0.25,0.5,1.0"
BARS=10080   # 7 días de velas 1m

OUT=$("$NODE" scripts/backtest_aplus_sweep.cjs --symbol ETHUSDT --bars $BARS --pin "$PROD" 2>/dev/null | grep "Señales")

if [ -z "$OUT" ]; then
  ./scripts/notify.sh "Recalibración A+ · Vero" "ℹ️ Semana sin señales A+ en el backtest OOS (mercado sin setups o sin datos). La config sigue vigente; nada que hacer." "Glass"
  exit 0
fi

# parsear "  Señales: 15  (0.72/día)   WR: 80%   Neto/u: +$24.2   PF: 2.57"
N=$(echo "$OUT"    | sed -E 's/.*Señales: ([0-9]+).*/\1/')
DIA=$(echo "$OUT"  | sed -E 's/.*\(([0-9.]+)\/día\).*/\1/')
WR=$(echo "$OUT"   | sed -E 's/.*WR: ([0-9]+)%.*/\1/')
PF=$(echo "$OUT"   | sed -E 's/.*PF: ([0-9.∞]+).*/\1/')
NETO=$(echo "$OUT" | sed -E 's/.*Neto\/u: (\+?\$?-?[0-9.$-]+).*/\1/')

DATOS="últimos 7d: $N señales ($DIA/día), WR $WR%, neto $NETO/u, PF $PF"

if [ "$N" -lt 3 ]; then
  ./scripts/notify.sh "Recalibración A+ · Vero" "ℹ️ Semana con pocas señales ($DATOS). Muestra insuficiente para veredicto — seguimos igual." "Glass"
elif [ "$PF" = "∞" ] || "$NODE" -e "process.exit(parseFloat('$PF') >= 1.3 ? 0 : 1)"; then
  ./scripts/notify.sh "Recalibración A+ · Vero" "🟢 Config de producción sigue con edge ($DATOS). Nada que tocar." "Glass"
elif "$NODE" -e "process.exit(parseFloat('$PF') >= 1.0 ? 0 : 1)"; then
  ./scripts/notify.sh "Recalibración A+ · Vero" "🟡 Edge marginal esta semana ($DATOS). Ojo la próxima semana; si repite, recalibrar con Claude." "Glass"
else
  ./scripts/notify.sh "⚠️ Recalibración A+ · Vero" "🔴 La config de producción PERDIÓ esta semana ($DATOS). Correr el barrido con Claude y recalibrar JUNTAS. NO aflojar filtros a mano." "Basso"
fi
