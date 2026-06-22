#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# Launch the JL Customs customer kiosk fullscreen on a Raspberry Pi.
# Run it manually to test, or let install-kiosk.sh wire it into autostart.
# ─────────────────────────────────────────────────────────────
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$APP_DIR"

# Production kiosk: fullscreen + locked window (see main.js KIOSK_MODE).
export KIOSK=1

# Keep the display awake. These are X11 tools; on a Wayland session they no-op,
# so disable screen blanking in the OS power settings there instead.
if command -v xset >/dev/null 2>&1; then
  xset s off      || true
  xset -dpms      || true
  xset s noblank  || true
fi

# Hide the mouse pointer when idle (optional; install with `sudo apt install unclutter`).
if command -v unclutter >/dev/null 2>&1; then
  unclutter -idle 0.5 -root &
fi

# Prefer a built AppImage (self-updating) when present, else run from source.
APPIMAGE_FILE="$(ls -1 dist/*.AppImage 2>/dev/null | head -n1 || true)"
if [ -n "${APPIMAGE_FILE:-}" ]; then
  chmod +x "$APPIMAGE_FILE" || true
  # --no-sandbox avoids the chrome-sandbox SUID error common on Pi OS kiosks.
  exec "$APPIMAGE_FILE" --no-sandbox
else
  exec npm start
fi
