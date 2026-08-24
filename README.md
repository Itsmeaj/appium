Appium Linux Driver
====

[![NPM version](https://img.shields.io/npm/v/@itsmeaj/appium-linux-driver.svg)](https://npmjs.org/package/@itsmeaj/appium-linux-driver)
[![Downloads](https://img.shields.io/npm/dm/@itsmeaj/appium-linux-driver.svg)](https://npmjs.org/package/@itsmeaj/appium-linux-driver)
[![Build and Release](https://github.com/Itsmeaj/appium/actions/workflows/release.yml/badge.svg)](https://github.com/Itsmeaj/appium/actions/workflows/release.yml)

**Desktop application automation for Linux, through Appium — on both X11 and Wayland.**

Appium has never shipped a working Linux desktop driver. This project fills that
gap: it drives real Linux GUI applications via [AT-SPI2](https://www.freedesktop.org/wiki/Accessibility/AT-SPI2/)
(the standard Linux accessibility stack) and exposes them through the regular
Appium/WebDriver protocol, so your existing Appium clients, locator strategies,
and test code work unchanged.

It supports **X11 and Wayland**, auto-selects the right backend per session, and
runs unattended on GNOME — including the Wayland XDG-portal consent flow.

> **Provenance.** This driver was built independently as a personal open-source
> project and is maintained under that authorship. It is used in production for
> Linux desktop test automation (including Omnissa Horizon Client suites), which
> is where much of its real-world hardening comes from.

---

## How it works (and what it depends on)

Like every platform-specific Appium driver, this driver stands on a native
automation backend:

| Appium driver | Native backend it relies on |
|---|---|
| XCUITest / Mac2 | Apple **XCTest** (closed, macOS-only) |
| Espresso / UiAutomator2 | Google instrumentation frameworks |
| **Appium Linux Driver** | A native **AT-SPI2 runtime** + XDG portals |

Concretely:

- The **accessibility tree** that powers `findElement` and `getPageSource` is
  extracted by a native AT-SPI runtime component (`libstdspalinux.so`) for
  speed. This is the Linux analogue of XCUITest depending on XCTest — it is a
  documented **prerequisite**, installed once, not something you build per
  project.
- On **Wayland**, input injection, screenshots, clipboard, and window
  management are implemented in pure JavaScript on top of **XDG desktop
  portals**, `dbus-next`, and standard CLI tools (`wl-clipboard`,
  `gnome-screenshot`/`grim`) — no proprietary code on those paths.
- On **X11**, input and window operations also go through the native runtime.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full breakdown of what
is open, what is native, and the roadmap toward a fully self-contained build.

---

## Install

### Standard Appium install (recommended)

If you already have [Appium 2 or 3](https://appium.io) installed:

```bash
appium driver install --source=npm @itsmeaj/appium-linux-driver
```

Then install the native AT-SPI runtime prerequisite (see
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#native-runtime-prerequisite)) and the
Wayland system packages for your distro (below).

### Wayland system prerequisites

Ubuntu / Debian family:

```bash
sudo apt update
sudo apt install -y \
  xdg-desktop-portal xdg-desktop-portal-gnome \
  pipewire wl-clipboard gnome-screenshot python3-pyatspi
```

RHEL family (RHEL / Rocky / Alma / Oracle / CentOS / Fedora):

```bash
sudo dnf install -y \
  xdg-desktop-portal xdg-desktop-portal-gnome \
  pipewire wl-clipboard gnome-screenshot python3-atspi
```

### All-in-one installer (optional convenience)

For turnkey CI hosts, pre-built packages bundle a known-good Node.js + Appium +
this driver + the native runtime under `/opt/uimate/`:

```bash
curl -fsSL https://raw.githubusercontent.com/Itsmeaj/appium/main/install.sh | sudo bash
```

Release packages target **Ubuntu 20.04+ amd64** and **RHEL 10 x86_64**.
Installs Node.js 20.19.0, Appium 2.19.0, and the Linux driver — no manual setup required.

After install, verify: `uimate-appium-doctor`.
Start Appium: `APPIUM_HOME=/opt/uimate/appium-home appium --port 4723`

## Releases

Pre-built packages are published automatically to [GitHub Releases](https://github.com/Itsmeaj/appium/releases) on every version tag.

Each release contains two packages:

| Package | Target |
|---------|--------|
| `uimate-appium-linux_<version>_amd64.deb` | Ubuntu 20.04+ / Debian on x86-64 |
| `uimate-appium-linux-<version>-1.el10.x86_64.rpm` | RHEL 10 on x86-64 |

The RPM bundles the checked-in EL10 x86-64 runtime. Compatibility with earlier
RHEL releases is not claimed by the v0.1.0 release artifact.
For X11, the configured EL10 repositories must provide `xdotool`, `xclip`, and
`xsel`; the RPM declares all three as runtime dependencies.

See [docs/UNIFIED_INSTALLER.md](docs/UNIFIED_INSTALLER.md) for building these
packages from source.

Releases are fully automated via [`.github/workflows/release.yml`](.github/workflows/release.yml).

**Trigger:** push a `v*` tag to `main`.

**What the workflow does:**

1. Checks out the repo on an `ubuntu-22.04` runner
2. Installs Node.js 20.19.0 and build tools (`binutils`, `dpkg-dev`, `fakeroot`, `rpm`)
3. Installs dependencies from the committed Yarn lockfile
4. Builds the `.deb` package — bundles Node.js, Appium 2.19.0, and the driver offline
5. Builds the EL10 x86-64 `.rpm` package using `native/dist/el10/libstdspalinux.so`
6. Creates a GitHub Release with auto-generated notes and uploads both packages

### Manual package installation

```bash
npm install -g appium
appium driver install --source=npm @itsmeaj/appium-linux-driver
```

Or install a specific release package directly:

```bash
# Ubuntu
sudo apt-get install -y ./uimate-appium-linux_<version>_amd64.deb

# RHEL 10 x86-64
sudo dnf install -y ./uimate-appium-linux-<version>-1.el10.x86_64.rpm
```

---

## Quick Start

Start Appium:

```bash
appium --port 4723
```

Create a session with the minimum capabilities:

```json
{
  "platformName": "Linux",
  "appium:automationName": "atspi2",
  "appium:appName": "yelp"
}
```

The backend is auto-selected from the session type. Pin it explicitly with
`appium:linuxBackend` when needed. For step-by-step backend setup see
[docs/BACKEND_QUICKSTART.md](docs/BACKEND_QUICKSTART.md).

---

## Support Matrix

| OS / Session | Wayland | X11 | Notes |
|---|---|---|---|
| Ubuntu 22.04 / 24.04 GNOME | Supported | Supported | Production path |
| Ubuntu 20.04 / 26.04 GNOME | Supported | Supported | Same family path |
| Ubuntu-family (Mint, Pop!\_OS, elementary) | Supported | Supported | Detected via `ID_LIKE` |
| RHEL 9 GNOME x86_64 | Supported | Planned | Primary RHEL target |
| RHEL 8 GNOME x86_64 | Supported | Planned | Maintained after RHEL 9 |
| RHEL 10 GNOME x86_64 | Preview | Planned | ABI/package availability may change |
| RHEL-family (Rocky, Alma, Oracle, CentOS, Fedora) | Supported | Planned | Detected via `ID`/`ID_LIKE` |

Backend behavior is API-compatible across all supported OSes.

---

## Capabilities

| Capability | Required | Description |
|---|---|---|
| `platformName` | yes | Must be `Linux`. |
| `appium:automationName` | yes | Must be `atspi2` (case-insensitive). |
| `appium:appName` | yes | App binary or path (for example `yelp` or `/bin/yelp`). |
| `appium:appArguments` | no | Argument array passed directly to the application without a shell. |
| `appium:attachToRunningApp` | no | Attach to an existing application instead of killing or launching it. Default `false`. |
| `appium:linuxBackend` | no | `auto` (default), `x11`, `wayland`. |
| `appium:waylandRestoreToken` | no | Previously issued portal restore token. |
| `appium:waylandTokenStorePath` | no | Token store path. Default: `~/.config/appium-linux-driver/portal-restore-tokens.json`. |
| `appium:waylandAutoShare` | no | Wayland-only. Default `true`; auto-accepts XDG portal consent via AT-SPI. |

`linuxBackend=auto` chooses Wayland when `XDG_SESSION_TYPE=wayland` or
`WAYLAND_DISPLAY` is present; otherwise X11.

### Launch With Arguments

Pass each command-line token as a separate array entry. The driver launches the
configured application directly and does not create a shell wrapper:

```json
{
  "platformName": "Linux",
  "appium:automationName": "atspi2",
  "appium:appName": "/usr/bin/horizon-client-next",
  "appium:appArguments": [
    "--serverURL=localhost:4443",
    "--desktopName=desktop1",
    "--protocol=BLAST",
    "--nonInteractive"
  ],
  "appium:linuxBackend": "x11"
}
```

### Attach To A Running Application

Set `appium:attachToRunningApp` when another process owns application launch.
Ending the Appium session does not terminate an attached application:

```json
{
  "platformName": "Linux",
  "appium:automationName": "atspi2",
  "appium:appName": "/usr/bin/horizon-client-next",
  "appium:attachToRunningApp": true,
  "appium:linuxBackend": "x11"
}
```

---

## Locator Strategies

`xpath`, `name`, `class name`, `id`, `accessibility id`, `tag name`,
`link text`, `partial link text`, `css selector`.

Notes:

- XPath is XPath 1.0 (via `xpath.js`).
- CSS selector support is a practical subset (`tag`, `.class`, `#id`,
  `[attr]`, `[attr=value]`, descendant combinator).

## Extension Commands (`executeScript("linux: ...")`)

| Command | Arguments | Description |
|---|---|---|
| `linux: getDisplaySize` | none | Returns main display `{width, height}`. |
| `linux: mouseMove` | `{x, y}` | Moves pointer to absolute coordinates. |
| `linux: mouseSwipe` | `{sx, sy, ex, ey}` | Press-drag-release pointer gesture. |
| `linux: rightClick` | `{elementId}` | Right-clicks the element center. |
| `linux: doubleClick` | `{elementId}` | Double-clicks the element center. |
| `linux: mouseScroll` | `{moveLeftSteps?, moveUpSteps?}` | Scroll gesture; negatives reverse direction. |
| `linux: copy` | `{str}` | Copies string to the system clipboard. |
| `linux: getClipboard` | none | Returns clipboard content. |
| `linux: click` | `[elementId]` | Clicks the given element. |
| `linux: shell` | `{cmd}` | Executes a shell command and returns stdout. |

```python
find_btn = driver.find_element("name", "Find")
driver.execute_script("linux: click", [find_btn.id])
```

## Screenshots

- `driver.get_screenshot_as_file(...)` captures the active window.
- `element.screenshot(...)` captures an element region.

On Wayland, capture prefers `gnome-screenshot` to avoid interactive portal
consent, with portal-native capture and `grim` as fallbacks.

## Wayland Notes

- On Ubuntu GNOME with `RemoteDesktop` portal v1, restore tokens cannot bypass
  consent; the driver runs an AT-SPI helper that auto-accepts the portal
  `Share/Allow` dialog (`appium:waylandAutoShare=true`).
- Set `appium:waylandAutoShare=false` to approve portal dialogs manually.
- Keep the desktop session unlocked; locked sessions inhibit portal startup.
- If Wayland prerequisites are missing, the driver fails fast with actionable,
  distro-aware errors.

See [docs/UBUNTU_WAYLAND.md](docs/UBUNTU_WAYLAND.md) and
[docs/WAYLAND_IMPLEMENTATION.md](docs/WAYLAND_IMPLEMENTATION.md) for details.

---

## Documentation

- [Architecture & Dependencies](docs/ARCHITECTURE.md)
- [Getting Started](docs/GETTING_STARTED.md)
- [Backend Quickstart (X11 vs Wayland)](docs/BACKEND_QUICKSTART.md)
- [Unified Installer (Ubuntu + RHEL)](docs/UNIFIED_INSTALLER.md)
- [Ubuntu Wayland Guide](docs/UBUNTU_WAYLAND.md)
- [RHEL Getting Started](docs/RHEL_GETTING_STARTED.md)
- [RHEL Wayland Guide](docs/RHEL_WAYLAND.md)
- [Wayland Implementation Deep Dive](docs/WAYLAND_IMPLEMENTATION.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Distro
coverage reports, toolkit (GTK4/Qt/Electron) findings, and performance data are
especially valuable.

## Test and Development

```bash
npm test          # lint + unit tests
npm run e2e-test  # functional tests (Linux-only, auto-skip elsewhere)
```

Wayland functional tests run only when `RUN_WAYLAND_E2E=1` in an active Wayland
session.

## License

[Apache-2.0](LICENSE). The native AT-SPI runtime prerequisite is distributed as
a separate redistributable binary; see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Contact

| Name | Email |
|---|---|
| Ajay | send2ajay03@gmail.com |
