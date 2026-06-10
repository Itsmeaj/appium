# Backend Quickstart (X11 vs Wayland)

This page gives exact capabilities and launch steps for each backend.

## 1. Check Linux Session Type

```bash
echo "XDG_SESSION_TYPE=$XDG_SESSION_TYPE"
echo "WAYLAND_DISPLAY=$WAYLAND_DISPLAY"
echo "DISPLAY=$DISPLAY"
```

Interpretation:

- If `XDG_SESSION_TYPE=wayland`, use Wayland.
- If `XDG_SESSION_TYPE=x11`, use X11.
- If running over SSH, start Appium with the same GUI user environment as the logged-in desktop session.

## 2. Common Required Capabilities

```json
{
  "platformName": "Linux",
  "appium:automationName": "atspi2",
  "appium:appName": "galculator"
}
```

## 3. X11 Path

Use this on Xorg sessions.

### Start Appium

```bash
APPIUM_HOME=/opt/uimate/appium-home appium --base-path /wd/hub
```

### Capabilities

```json
{
  "platformName": "Linux",
  "appium:automationName": "atspi2",
  "appium:appName": "galculator",
  "appium:linuxBackend": "x11"
}
```

Notes:

- Requires `/usr/local/lib/libstdspalinux.so`.
- X11 handles map to runtime window IDs.
- RHEL X11 rollout is phase 4 (Wayland-first plan).

## 4. Wayland Path (GNOME)

### Install Wayland prerequisites

Ubuntu:

```bash
sudo apt update
sudo apt install -y \
  xdg-desktop-portal \
  xdg-desktop-portal-gnome \
  pipewire \
  wl-clipboard \
  gnome-screenshot \
  python3-pyatspi
```

RHEL 8/9/10:

```bash
sudo dnf install -y \
  xdg-desktop-portal \
  xdg-desktop-portal-gnome \
  pipewire \
  wl-clipboard \
  gnome-screenshot \
  python3-atspi
```

### Start Appium in active desktop user session

If already in desktop terminal:

```bash
APPIUM_HOME=/opt/uimate/appium-home appium --base-path /wd/hub
```

If connected over SSH:

```bash
GNOME_PID=$(pgrep -u "$USER" -n gnome-shell)
export DISPLAY=$(tr '\0' '\n' < /proc/$GNOME_PID/environ | grep '^DISPLAY=' | cut -d= -f2-)
export WAYLAND_DISPLAY=$(tr '\0' '\n' < /proc/$GNOME_PID/environ | grep '^WAYLAND_DISPLAY=' | cut -d= -f2-)
export XDG_SESSION_TYPE=$(tr '\0' '\n' < /proc/$GNOME_PID/environ | grep '^XDG_SESSION_TYPE=' | cut -d= -f2-)
export DBUS_SESSION_BUS_ADDRESS=$(tr '\0' '\n' < /proc/$GNOME_PID/environ | grep '^DBUS_SESSION_BUS_ADDRESS=' | cut -d= -f2-)
export XDG_RUNTIME_DIR=/run/user/$(id -u)
APPIUM_HOME=/opt/uimate/appium-home appium --base-path /wd/hub
```

### Capabilities (Wayland)

```json
{
  "platformName": "Linux",
  "appium:automationName": "atspi2",
  "appium:appName": "galculator",
  "appium:linuxBackend": "wayland",
  "appium:waylandAutoShare": true
}
```

Optional Wayland capabilities:

- `appium:waylandRestoreToken`
- `appium:waylandTokenStorePath`
- `appium:waylandAutoShare` (default `true`)

Notes:

- Wayland window handles are deterministic synthetic handles.
- Screenshot flow is portal-native first, then CLI fallback.
- Keep desktop session unlocked.
- On RHEL GNOME, confirm lock state with `loginctl show-session <id> -p LockedHint`.

## 5. Auto Mode

```json
{
  "platformName": "Linux",
  "appium:automationName": "atspi2",
  "appium:appName": "galculator",
  "appium:linuxBackend": "auto"
}
```

Behavior:

- Picks Wayland if `XDG_SESSION_TYPE=wayland` or `WAYLAND_DISPLAY` exists.
- Otherwise picks X11.

## 6. Quick Smoke Test

```bash
python3 scripts/manual_calc_test.py \
  --server http://127.0.0.1:4723/wd/hub \
  --app-name gnome-clocks \
  --linux-backend wayland \
  --wayland-auto-share true \
  --xml-out /tmp/wayland-source.xml
```

X11 equivalent:

```bash
python3 scripts/manual_calc_test.py \
  --server http://127.0.0.1:4723/wd/hub \
  --app-name nautilus \
  --linux-backend x11 \
  --xml-out /tmp/x11-source.xml
```
