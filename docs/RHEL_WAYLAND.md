# RHEL Wayland Guide

## Scope

- RHEL 8 / 9 / 10
- GNOME Wayland sessions
- x86_64

## Required Packages

```bash
sudo dnf install -y \
  xdg-desktop-portal \
  xdg-desktop-portal-gnome \
  pipewire \
  wl-clipboard \
  gnome-screenshot \
  python3-atspi
```

## Verify Session

```bash
echo "$XDG_SESSION_TYPE"
echo "$WAYLAND_DISPLAY"
echo "$DBUS_SESSION_BUS_ADDRESS"
echo "$XDG_RUNTIME_DIR"
```

Expected:

- `XDG_SESSION_TYPE=wayland`
- `WAYLAND_DISPLAY` non-empty
- DBus/runtime vars present

The active GNOME session must also be unlocked:

```bash
loginctl show-session "$(loginctl list-sessions --no-legend | awk '$3==ENVIRON["USER"] && $4!="-" && $8=="yes" {print $1; exit}')" -p LockedHint -p Active -p State
```

Expected:

- `LockedHint=no`
- `Active=yes`

If locked, unlock before starting Wayland automation:

```bash
sudo loginctl unlock-session <session-id>
```

## Start Appium

Desktop terminal:

```bash
APPIUM_HOME=/opt/uimate/appium-home appium --base-path /wd/hub
```

SSH terminal (export desktop env first):

```bash
GNOME_PID=$(pgrep -u "$USER" -n gnome-shell)
export DISPLAY=$(tr '\0' '\n' < /proc/$GNOME_PID/environ | grep '^DISPLAY=' | cut -d= -f2-)
export WAYLAND_DISPLAY=$(tr '\0' '\n' < /proc/$GNOME_PID/environ | grep '^WAYLAND_DISPLAY=' | cut -d= -f2-)
export XDG_SESSION_TYPE=$(tr '\0' '\n' < /proc/$GNOME_PID/environ | grep '^XDG_SESSION_TYPE=' | cut -d= -f2-)
export DBUS_SESSION_BUS_ADDRESS=$(tr '\0' '\n' < /proc/$GNOME_PID/environ | grep '^DBUS_SESSION_BUS_ADDRESS=' | cut -d= -f2-)
export XDG_RUNTIME_DIR=/run/user/$(id -u)
APPIUM_HOME=/opt/uimate/appium-home appium --base-path /wd/hub
```

## Session Capabilities

Recommended:

```json
{
  "platformName": "Linux",
  "appium:automationName": "AtSpi2",
  "appium:appName": "gnome-clocks",
  "appium:linuxBackend": "wayland",
  "appium:waylandAutoShare": true
}
```

Optional:

- `appium:waylandRestoreToken`
- `appium:waylandTokenStorePath`
- `appium:waylandAutoShare` (`true` by default)

## Behavior Notes

- Portal auto-share helper is enabled by default (`waylandAutoShare=true`).
- Screenshot path is portal-native first, with `gnome-screenshot` fallback if needed.
- Clipboard path uses `wl-copy`/`wl-paste` first, then runtime fallback.
- Window handles are synthetic and stable for `getWindowHandles` + `setWindow`.
- If GNOME session is locked, session creation fails fast with an explicit unlock message.
- On RHEL 10 test images, `gnome-clocks` and `nautilus` are reliable smoke targets.

## Fast Validation

```bash
python3 scripts/manual_calc_test.py \
  --server http://127.0.0.1:4723/wd/hub \
  --app-name gnome-clocks \
  --linux-backend wayland \
  --wayland-auto-share true \
  --xml-out /tmp/rhel-wayland-clocks-source.xml
```
