# RHEL Implementation Notes

This page explains how RHEL enablement is implemented in this repo.

## 1. Backend Compatibility Model

Public Appium interface stays unchanged:

- `appium:linuxBackend` (`auto`/`x11`/`wayland`)
- `appium:waylandRestoreToken`
- `appium:waylandTokenStorePath`
- `appium:waylandAutoShare`

Backend selection logic remains centralized in `lib/backends/index.js`.

## 2. Distro-Aware Runtime Detection

`lib/backends/linux-platform.js` adds:

- `/etc/os-release` parsing
- RHEL-family detection
- supported-major awareness (`8/9/10`)
- Wayland preflight checks with actionable messages

Wayland preflight validates:

- Wayland session env (`XDG_SESSION_TYPE` / `WAYLAND_DISPLAY`)
- DBus runtime env (`DBUS_SESSION_BUS_ADDRESS`, `XDG_RUNTIME_DIR`)
- portal + PipeWire commands

On RHEL-family distros, remediation uses `dnf` package hints.

## 3. Wayland Screenshot Path

`lib/backends/wayland-apis.js` now uses portal-first capture strategy:

1. `org.freedesktop.portal.Screenshot`
2. `gnome-screenshot` fallback
3. `grim` fallback

Strategy/failure messaging helpers:

- `lib/backends/wayland-screenshot-utils.js`
- unit coverage in `test/unit/backend-specs.js`

## 4. Native Runtime Ownership

New native subtree:

- `native/README.md`
- `native/scripts/build-runtime.sh`
- `native/scripts/verify-no-legacy-cli-deps.sh`
- `native/dist/el8|el9|el10/`

Guardrail blocks supported-path runtime artifacts that still embed
`xdotool` / `xclip` / `xsel` command dependencies.

## 5. RPM Installer Flow

New builder:

- `packaging/rpm/build-unified-installer.sh`

Produces:

- `uimate-appium-linux-<version>-1.el8.x86_64.rpm`
- `uimate-appium-linux-<version>-1.el9.x86_64.rpm`
- `uimate-appium-linux-<version>-1.el10.x86_64.rpm`

Installer behavior:

- bundles `libstdspalinux.so` to `/usr/local/lib/libstdspalinux.so`
- installs Node 20 and Appium at install time
- installs Appium Linux driver from bundled local artifact

## 6. Test Coverage Added

Unit tests now cover:

- backend selection stability
- token store behavior
- distro parser + RHEL preflight messaging
- Wayland screenshot strategy selection/failure messaging
