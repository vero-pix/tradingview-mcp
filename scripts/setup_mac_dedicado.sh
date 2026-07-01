#!/bin/bash
# =============================================================================
# setup_mac_dedicado.sh — Deja un Mac como "cerebro" 24/7 del sistema de Vero.
#
# Instala los servicios (detector ETH, detector BTC, bot de Telegram) como
# launchd, para que corran permanentes y sobrevivan reinicios.
#
# ANTES de correr esto, en el Mac nuevo:
#   1. Instalar node (fnm):  curl -fsSL https://fnm.vercel.app/install | bash
#                            luego:  fnm install --lts && fnm default lts-latest
#   2. Clonar el repo:  mkdir -p ~/Trading && cd ~/Trading
#                       git clone https://github.com/vero-pix/tradingview-mcp.git
#   3. Copiar credenciales:  poner ~/Trading/.env.telegram (AirDrop del Mac principal)
#
# Después:  cd ~/Trading/tradingview-mcp && bash scripts/setup_mac_dedicado.sh
#
# ⚠️ El bot solo puede correr en UN Mac a la vez. Al prender este, APAGA el bot y
#    los detectores en el Mac principal (launchctl unload de esos plists).
# =============================================================================
set -e
LA="$HOME/Library/LaunchAgents"
REPO="$HOME/Trading/tradingview-mcp"
mkdir -p "$LA"

# --- Chequeos previos ---
[ -d "$REPO" ] || { echo "❌ No existe $REPO — clona el repo primero."; exit 1; }
[ -f "$HOME/Trading/.env.telegram" ] || { echo "❌ Falta ~/Trading/.env.telegram (credenciales) — cópialo del Mac principal."; exit 1; }
NODE="$HOME/.local/share/fnm/aliases/default/bin/node"; [ -x "$NODE" ] || NODE="$(command -v node)"
[ -n "$NODE" ] || { echo "❌ No encuentro node — instala node (fnm) primero."; exit 1; }
echo "✅ repo, credenciales y node OK ($NODE)"

# --- Detector ETH ---
cat > "$LA/cl.vero.detectoreth.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>cl.vero.detectoreth</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$REPO/scripts/detector_servicio.sh</string></array>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>EnvironmentVariables</key><dict><key>ZONE_ALERTS</key><string>0</string><key>ARM_ORDER</key><string>1</string></dict>
  <key>StandardOutPath</key><string>/tmp/vero_detector.log</string>
  <key>StandardErrorPath</key><string>/tmp/vero_detector.log</string>
</dict></plist>
PLIST

# --- Detector BTC ---
cat > "$LA/cl.vero.detectorbtc.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>cl.vero.detectorbtc</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$REPO/scripts/detector_servicio.sh</string></array>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>EnvironmentVariables</key><dict>
    <key>ZONE_ALERTS</key><string>0</string><key>ARM_ORDER</key><string>1</string>
    <key>BINANCE_SYMBOL</key><string>BTCUSDT</string><key>EPIC</key><string>BTCUSD</string>
    <key>ZONAS_FILE</key><string>scripts/zonas_BTCUSD.env</string><key>LIQ_MIN</key><string>8</string>
  </dict>
  <key>StandardOutPath</key><string>/tmp/vero_detector_btc.log</string>
  <key>StandardErrorPath</key><string>/tmp/vero_detector_btc.log</string>
</dict></plist>
PLIST

# --- Bot de Telegram ---
cp "$REPO/scripts/cl.vero.telegrambot.plist" "$LA/cl.vero.telegrambot.plist"

# --- Cargar los tres servicios ---
for L in cl.vero.detectoreth cl.vero.detectorbtc cl.vero.telegrambot; do
  launchctl unload "$LA/$L.plist" 2>/dev/null || true
  launchctl load "$LA/$L.plist"
  echo "✅ cargado $L"
done

echo ""
echo "🟣 Listo. El cerebro está corriendo:"
launchctl list | grep -i vero || true
echo ""
echo "⚠️ RECUERDA: en tu Mac PRINCIPAL, apaga el bot y los detectores para que no choquen:"
echo "   launchctl unload ~/Library/LaunchAgents/cl.vero.detectoreth.plist"
echo "   launchctl unload ~/Library/LaunchAgents/cl.vero.detectorbtc.plist"
echo "   pkill -f telegram_confirm_bot"
