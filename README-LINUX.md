# JL Customs Kiosk — Linux / Raspberry Pi 5

This is the Linux build of the customer kiosk (`user/`), set up to run on a
**Raspberry Pi 5** running **Raspberry Pi OS (64-bit, Bookworm)**. The page code
(slideshow, gallery, estimate builder, email/print, video call) is identical to
the Windows app — only the Electron packaging and launch are Linux-specific.

Everything the original kiosk does works here:

| Feature | Works on the Pi via |
| --- | --- |
| Slideshow / attract screen | Chromium renderer, same as Windows |
| Gallery + lightbox | same |
| Estimate builder, running total | same |
| Email an estimate | backend SMTP (no client change) |
| Print an estimate | `window.print()` → CUPS (see Printing below) |
| Video call (Jitsi) | needs camera + audio (see Video call below) |
| Offline photo cache | `app.getPath('userData')` on Linux |
| Fullscreen kiosk lock | `KIOSK=1` (see below) |
| Auto-update | AppImage build (see Auto-update below) |

---

## 1. Prerequisites

```bash
# 64-bit Raspberry Pi OS. Confirm the architecture is aarch64:
uname -m            # should print: aarch64

# Node.js 18+ (matches the backend's fetch requirement)
sudo apt update
sudo apt install -y nodejs npm
node -v             # 18 or newer

# Electron's runtime libraries (most are preinstalled on Pi OS desktop)
sudo apt install -y libnss3 libatk1.0-0 libatk-bridge2.0-0 libgtk-3-0 \
                    libgbm1 libasound2

# Optional kiosk niceties
sudo apt install -y unclutter        # hides the mouse cursor when idle
```

---

## 2. Install

```bash
cd user-linux
npm install
```

This pulls the **arm64** Electron binary automatically because you're on the Pi.

---

## 3. Run

**Windowed (development / first test):**

```bash
npm start
```

**Fullscreen kiosk (locked, production):**

```bash
npm run kiosk          # same as KIOSK=1 npm start
```

In kiosk mode the window is fullscreen and locked. Press **F** or **F11** is
intentionally the only fullscreen toggle in dev; in `KIOSK=1` the window stays
locked. To quit during testing use **Alt+F4** or `pkill -f electron`.

The backend URL is unchanged from the Windows app — it lives in `config.js`
(`window.JLConfig.serverUrl`). Edit that one line to point at a different server.

---

## 4. Launch on boot (autostart)

```bash
bash install-kiosk.sh
```

This writes `~/.config/autostart/jlcustoms-kiosk.desktop`, which runs
`start-kiosk.sh` (fullscreen, screen-blanking disabled, cursor hidden) every time
the desktop logs in. Enable auto-login in `sudo raspi-config` →
*System Options → Boot / Auto Login → Desktop Autologin* so it comes up
unattended after a power cycle.

Test it without rebooting:

```bash
bash start-kiosk.sh
```

Remove autostart later with `rm ~/.config/autostart/jlcustoms-kiosk.desktop`.

---

## 5. Build a distributable AppImage (optional, enables auto-update)

```bash
npm run build          # builds for the host arch
npm run build -- --arm64   # force arm64 (the Pi 5 target)
```

This produces, in `dist/`:

- `JL-Customs-User-<version>-arm64.AppImage` — portable, self-updating
- `JL-Customs-User-<version>-arm64.deb` — system package (`sudo apt install ./<file>.deb`)
- `latest-linux-arm64.yml` — the auto-update feed

> A prebuilt **arm64 AppImage + deb** are already checked into `dist/` (built via
> WSL cross-compile). `dist/` is gitignored, so they live only in this working
> copy — rebuild on the Pi for a clean native build, or just copy the AppImage
> to the Pi and run it.

`start-kiosk.sh` automatically prefers an AppImage in `dist/` over running from
source. To publish a release that field kiosks auto-update from:

```bash
cp .env.example .env   # then put a GH_TOKEN in .env
npm run dist
```

Bump `version` in `package.json` before each release. See **Auto-update** below
for how updates reach the Pi.

---

## Auto-update

On Linux, electron-updater can only self-update a packaged **AppImage**. The app
detects this at runtime (`main.js` → `canAutoUpdate()`):

- Run from source (`npm start`) or installed as `.deb` → updater is **skipped**
  (logged, no errors).
- Run as the built AppImage → it checks GitHub Releases every 15 minutes and
  installs new versions silently, exactly like the Windows kiosk.

Linux releases publish a `latest-linux-arm64.yml` feed and do not collide with
the Windows `latest.yml` in the same `interactive-kiosk-user` repo.

---

## Video call (Jitsi)

The call page opens `meet.jit.si` in the same window. Electron auto-grants camera
and microphone permission (`setPermissionRequestHandler` in `main.js`), so you
only need working hardware:

```bash
# Camera present?
ls /dev/video*

# Audio devices present? (Pi OS Bookworm uses PipeWire)
wpctl status
```

Plug in a USB webcam with a mic (or a Pi camera + USB mic) and set the correct
default input/output in the Pi audio settings.

---

## Printing an estimate

`window.print()` uses the system print stack. Install CUPS and add the printer:

```bash
sudo apt install -y cups
sudo usermod -aG lpadmin "$USER"
# then add the printer at http://localhost:631 or via the desktop print settings
```

If the shop only emails estimates, printing can be ignored.

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Black screen / GPU crash on launch | Run with `DISABLE_GPU=1` (e.g. `DISABLE_GPU=1 npm run kiosk`). It calls `app.disableHardwareAcceleration()`. |
| AppImage exits with a `chrome-sandbox` / SUID error | `start-kiosk.sh` already passes `--no-sandbox`. To run the AppImage by hand: `./dist/*.AppImage --no-sandbox`. |
| Screen blanks / sleeps after a few minutes | `start-kiosk.sh` runs `xset` to disable blanking on X11. On a Wayland session, disable screen blank in *Raspberry Pi Configuration → Display* / Screen Blanking instead. |
| Cursor visible on the touchscreen | `sudo apt install unclutter` (the launch script uses it if present). |
| No camera/mic in the video call | Check `ls /dev/video*` and `wpctl status`; confirm a USB webcam with a mic is attached. |
| `npm start` errors about missing `.so` libraries | Install the runtime libs from step 1. |
| App won't update | Auto-update only runs from the AppImage build — `npm start` and `.deb` never self-update by design. |

---

## What changed from the Windows `user/` app

Only packaging/launch — no page or feature code was modified.

- `package.json` — build target switched from Windows NSIS to Linux **AppImage + deb**; added an `author` (required for the deb maintainer field), `deb` gz compression (xz `-mx9` is impractically slow), and `npm run kiosk`.
- `main.js` — added `KIOSK=1` fullscreen-lock mode, an optional `DISABLE_GPU=1` knob for Pi GPU issues, and an auto-update guard so it only self-updates from an AppImage on Linux.
- `icon.png` — a 512×512 app icon (electron-builder requires ≥256×256; the UI's `logo.png` is 225×225 and is left untouched).
- `start-kiosk.sh`, `install-kiosk.sh` — Linux kiosk launch + autostart helpers.
- `.env.example` — build-time `GH_TOKEN` template.
