# Wayland Implementation Deep Dive

## Why this exists

Linux GUI automation on modern Ubuntu defaults to Wayland, where classic X11 APIs are not available for global window/input control.  
This driver keeps X11 behavior intact and adds a Wayland backend that uses desktop-safe APIs.

## Design goals

- Keep existing Appium command surface stable.
- Support both X11 and Wayland from the same driver.
- Auto-select the right backend by default.
- Run unattended automation on Ubuntu GNOME Wayland where possible.
- Support phased enablement for RHEL 8/9/10 GNOME Wayland.
- Fail fast with actionable errors when prerequisites are missing.

## Architecture

The driver now uses a backend interface selected per session:

- `X11Backend`: wraps the existing `@stdspa/stdspalinux_temp` behavior.
- `WaylandBackend`: uses XDG Portal + AT-SPI + native helpers.

Selection logic:

- Capability `appium:linuxBackend` accepts `auto`, `x11`, `wayland`.
- `auto` chooses Wayland when `XDG_SESSION_TYPE=wayland` or `WAYLAND_DISPLAY` is present.
- Otherwise it falls back to X11.

## Wayland session bootstrap

Wayland setup uses portal remote desktop flow:

1. `CreateSession`
2. `SelectSources` (`ScreenCast`)
3. `SelectDevices` (`RemoteDesktop`)
4. `Start`

The backend detects portal interface versions at runtime and adapts behavior:

- If persist/restore is supported, it uses token flows.
- If not supported (for example `RemoteDesktop` v1), it falls back safely and logs the limitation.

## Restore token strategy

Token source precedence:

1. `appium:waylandRestoreToken` capability (if provided)
2. Token store file (default: `~/.config/appium-linux-driver/portal-restore-tokens.json`)

After successful `Start`, when portal returns a new token, the driver rotates and saves it.

## Unattended consent handling on Ubuntu GNOME

Important portal behavior:

- On Ubuntu GNOME stacks exposing `RemoteDesktop` v1, token-only bypass is not available.
- A consent action is still required for remote-desktop start.

To keep sessions unattended, the driver adds `appium:waylandAutoShare` (default `true`):

- Starts a short-lived `python3` helper using `pyatspi`.
- Watches `xdg-desktop-portal-gnome` dialog in AT-SPI tree.
- Programmatically clicks `Share/Allow` button.
- Stops helper immediately after portal start completes (or on teardown).

This is why `python3-pyatspi` is a required package for unattended Wayland startup.

## Input, source, window, and screenshot behavior

### Input injection

Primary path is portal `RemoteDesktop` notifications (`NotifyPointer*`, `NotifyKeyboard*`) once session is active.

### Page source

AT-SPI is used for XML hierarchy.  
If window-specific hierarchy is empty on Wayland, driver falls back to desktop hierarchy to avoid returning empty source.

### Window handles

Wayland does not expose X11 window IDs.  
Driver generates deterministic synthetic handles from stable app/window identity so `getWindowHandles` and `setWindow` remain compatible.

### Screenshots

Uses portal-native screenshot capture first (`org.freedesktop.portal.Screenshot`), with `gnome-screenshot`/`grim` fallback as compatibility path.

### Preflight checks

Before session bootstrap, the backend validates desktop/runtime prerequisites (Wayland session env, portal binaries, PipeWire, DBus session vars) and emits distro-aware remediation hints (`dnf` for RHEL family).

## Key capabilities

- `appium:linuxBackend`: `auto` (default), `x11`, `wayland`
- `appium:waylandRestoreToken`: optional one-time restore token
- `appium:waylandTokenStorePath`: optional custom token store path
- `appium:waylandAutoShare`: Wayland-only, default `true`

## Practical limits

- Requires active unlocked graphical session for the target user.
- If organization policy blocks portal UI automation, set `appium:waylandAutoShare=false` and approve manually.
- Current Wayland target is Ubuntu GNOME; compositor-general support is future work.

## Implementation map (code)

- Backend selection:
  - `lib/backends/index.js`
  - `lib/desired-caps.js`
- Wayland backend core:
  - `lib/backends/wayland-apis.js`
  - `lib/backends/token-store.js`
- Window/source compatibility:
  - `lib/commands/window.js`
  - `lib/commands/source.js`
- User-facing docs:
  - `README.md`
  - `docs/UBUNTU_WAYLAND.md`

## Validation approach used

- Unit tests for backend selection and token store behavior.
- Functional Wayland smoke test:
  - Start Appium in active Wayland user session env.
  - Create session with `appium:linuxBackend=wayland`.
  - Launch calculator and fetch XML page source.
  - Confirm portal auto-share log lines and non-empty XML output.
