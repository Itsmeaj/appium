# Ubuntu Wayland Guide

## Scope

This guide covers Wayland automation for Ubuntu GNOME 22.04 and 24.04.
For implementation internals, see [Wayland Implementation Deep Dive](WAYLAND_IMPLEMENTATION.md).
For X11 vs Wayland comparison and capability cheatsheet, see [Backend Quickstart (X11 vs Wayland)](BACKEND_QUICKSTART.md).

## Required Packages

```bash
sudo apt update
sudo apt install -y \
  xdg-desktop-portal \
  xdg-desktop-portal-gnome \
  pipewire \
  wl-clipboard \
  python3-pyatspi
```

Optional screenshot fallback tools:

```bash
sudo apt install -y gnome-screenshot grim
```

## Verify Wayland Session

```bash
echo "$XDG_SESSION_TYPE"
echo "$WAYLAND_DISPLAY"
```

Expected:

- `XDG_SESSION_TYPE` should be `wayland`
- `WAYLAND_DISPLAY` should be non-empty

## Start Appium

If you are in a terminal inside the logged-in GNOME Wayland desktop:

```bash
APPIUM_HOME=/opt/uimate/appium-home appium --base-path /wd/hub
```

If you are connected via SSH, export the GUI session env before starting Appium:

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
  "appium:automationName": "atspi2",
  "appium:appName": "yelp",
  "appium:linuxBackend": "wayland"
}
```

Optional token controls:

- `appium:waylandRestoreToken`
- `appium:waylandTokenStorePath`
- `appium:waylandAutoShare` (default `true`)

Manual-consent mode (if you do not want auto-share):

```json
{
  "platformName": "Linux",
  "appium:automationName": "atspi2",
  "appium:appName": "galculator",
  "appium:linuxBackend": "wayland",
  "appium:waylandAutoShare": false
}
```

Default token store path:

```text
~/.config/appium-linux-driver/portal-restore-tokens.json
```

## First Run Behavior

On Ubuntu GNOME portal stacks that expose `RemoteDesktop` interface v1, each new portal remote-desktop session needs consent.

To keep runs unattended, the driver enables portal auto-consent by default on Wayland:

- It watches for the `xdg-desktop-portal-gnome` consent window via AT-SPI.
- It invokes the `Share/Allow` button action programmatically.

Disable this with `appium:waylandAutoShare=false` if you want manual approvals.

When the desktop portal backend supports restore tokens, the driver still rotates/stores them for token-based restore flows.

## Backend Selection Behavior

- `linuxBackend=auto`: chooses Wayland if Wayland env vars are detected.
- `linuxBackend=x11`: forces X11 backend.
- `linuxBackend=wayland`: forces Wayland backend and fails fast if prerequisites are missing.

## Practical Notes

- Window handles on Wayland are deterministic synthetic IDs (not compositor-native IDs).
- Clipboard uses portal-compatible path with fallback behavior when `wl-copy`/`wl-paste` are absent.
- Screenshot commands use portal-native capture first, then `gnome-screenshot` / `grim` fallback.
- Keep the GNOME session unlocked for unattended runs (portal may reject requests when the seat is locked).
