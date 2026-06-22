#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# One-time setup: register the JL Customs kiosk to launch on login.
# Run on the Raspberry Pi after `npm install`:  bash install-kiosk.sh
# ─────────────────────────────────────────────────────────────
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AUTOSTART_DIR="$HOME/.config/autostart"
DESKTOP_FILE="$AUTOSTART_DIR/jlcustoms-kiosk.desktop"

chmod +x "$APP_DIR/start-kiosk.sh"
mkdir -p "$AUTOSTART_DIR"

cat > "$DESKTOP_FILE" <<EOF
[Desktop Entry]
Type=Application
Name=JL Customs Kiosk
Comment=Customer-facing touchscreen kiosk
Exec=$APP_DIR/start-kiosk.sh
X-GNOME-Autostart-enabled=true
Terminal=false
EOF

echo "Installed autostart entry: $DESKTOP_FILE"
echo "It will launch $APP_DIR/start-kiosk.sh on the next desktop login."
echo
echo "Test it now without rebooting:  bash \"$APP_DIR/start-kiosk.sh\""
echo "Remove autostart later with:    rm \"$DESKTOP_FILE\""
