Appium Linux Driver
====

[![NPM version](https://img.shields.io/npm/v/@stdspa/appium-linux-driver.svg)](https://npmjs.org/package/@stdspa/appium-linux-driver)
[![Downloads](https://img.shields.io/npm/dm/@stdspa/appium-linux-driver.svg)](https://npmjs.org/package/@stdspa/appium-linux-driver)
[![Build and Release](https://github.com/Itsmeaj/appium/actions/workflows/release.yml/badge.svg)](https://github.com/Itsmeaj/appium/actions/workflows/release.yml)

Appium Linux Driver enables desktop app automation on Linux using AT-SPI, with dual backend support for X11 and Wayland.

## Quick Install

```bash
curl -fsSL https://raw.githubusercontent.com/Itsmeaj/appium/main/install.sh | sudo bash
```

Release packages target **Ubuntu 20.04+ amd64** and **RHEL 10 x86_64**.
Installs Node.js 20.19.0, Appium 2.19.0, and the Linux driver — no manual setup required.

After install, verify: `uimate-appium-doctor`  
Start Appium: `APPIUM_HOME=/opt/uimate/appium-home appium --port 4723`

## Releases

Pre-built packages are published automatically to [GitHub Releases](https://github.com/Itsmeaj/appium/releases) on every version tag.

Each release contains two packages:

| Package | Target |
|---------|--------|
| `uimate-appium-linux_<version>_amd64.deb` | Ubuntu 20.04+ / Debian on x86-64 |
| `uimate-appium-linux-<version>-1.el10.x86_64.rpm` | RHEL 10 on x86-64 |

The RPM bundles the checked-in EL10 x86-64 runtime. Compatibility with earlier
RHEL releases is not claimed by the v0.0.56 release artifact.
For X11, the configured EL10 repositories must provide `xdotool`, `xclip`, and
`xsel`; the RPM declares all three as runtime dependencies.

## CI/CD Pipeline

Releases are fully automated via [`.github/workflows/release.yml`](.github/workflows/release.yml).

**Trigger:** push a `v*` tag to `main`.

**What the workflow does:**

1. Checks out the repo on an `ubuntu-22.04` runner
2. Installs Node.js 20.19.0 and build tools (`binutils`, `dpkg-dev`, `fakeroot`, `rpm`)
3. Installs dependencies from the committed Yarn lockfile
4. Builds the `.deb` package — bundles Node.js, Appium 2.19.0, and the driver offline
5. Builds the EL10 x86-64 `.rpm` package using `native/dist/el10/libstdspalinux.so`
6. Creates a GitHub Release with auto-generated notes and uploads both packages

**To cut a new release:**

```bash
# Bump version in package.json first, then:
git tag v0.0.44
git push origin main
git push origin v0.0.44
```

The CI job runs automatically and the release appears at `https://github.com/Itsmeaj/appium/releases/tag/v0.0.44` within a few minutes.

## Documentation

- [Getting Started](docs/GETTING_STARTED.md)
- [Backend Quickstart (X11 vs Wayland)](docs/BACKEND_QUICKSTART.md)
- [Unified Installer (Ubuntu + RHEL)](docs/UNIFIED_INSTALLER.md)
- [Ubuntu Wayland Guide](docs/UBUNTU_WAYLAND.md)
- [RHEL Getting Started](docs/RHEL_GETTING_STARTED.md)
- [RHEL Wayland Guide](docs/RHEL_WAYLAND.md)
- [RHEL Implementation Notes](docs/RHEL_IMPLEMENTATION.md)
- [Wayland Implementation Deep Dive](docs/WAYLAND_IMPLEMENTATION.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)

## Support Matrix

OS / Session | Wayland | X11 | Notes
--- | --- | --- | ---
Ubuntu 22.04 GNOME | Supported | Supported | Production path.
Ubuntu 24.04 GNOME | Supported | Supported | Production path.
RHEL 9 GNOME x86_64 | Enabled (phase 1) | Planned (phase 4) | Primary RHEL target.
RHEL 8 GNOME x86_64 | Enabled (phase 2) | Planned (phase 4) | Maintained after RHEL 9 baseline.
RHEL 10 GNOME x86_64 | Preview (phase 3) | Planned (phase 4) | ABI and package availability may change.

Backend behavior is API-compatible across OSes:

- `appium:linuxBackend`: `auto` (default), `x11`, `wayland`
- `appium:waylandRestoreToken`
- `appium:waylandTokenStorePath`
- `appium:waylandAutoShare` (default `true`)

## Manual Setup (Advanced)

```bash
npm install -g appium
appium driver install --source=npm @stdspa/appium-linux-driver
```

Or install a specific release package directly:

```bash
# Ubuntu
sudo apt-get install -y ./uimate-appium-linux_<version>_amd64.deb

# RHEL 10 x86-64
sudo dnf install -y ./uimate-appium-linux-<version>-1.el10.x86_64.rpm
```

## Quick Start

1. Install using the one-liner above
2. Start Appium:

```bash
APPIUM_HOME=/opt/uimate/appium-home appium --port 4723
```

3. Create a session with minimum capabilities:

```json
{
  "platformName": "Linux",
  "appium:automationName": "atspi2",
  "appium:appName": "yelp"
}
```

## Capabilities

Capability | Required | Description
--- | --- | ---
`platformName` | yes | Must be `Linux`.
`appium:automationName` | yes | Must be `atspi2` (case-insensitive).
`appium:appName` | yes | App binary or path (for example `yelp` or `/bin/yelp`).
`appium:appArguments` | no | Argument array passed directly to the application without a shell.
`appium:attachToRunningApp` | no | Attach to an existing application instead of killing or launching it. Defaults to `false`.
`appium:linuxBackend` | no | `auto` (default), `x11`, `wayland`.
`appium:waylandRestoreToken` | no | Optional previously issued portal restore token.
`appium:waylandTokenStorePath` | no | Optional token store path. Default: `~/.config/appium-linux-driver/portal-restore-tokens.json`.
`appium:waylandAutoShare` | no | Wayland-only. Defaults to `true`; auto-accepts XDG portal consent via AT-SPI (`xdg-desktop-portal-gnome` dialog).

`linuxBackend=auto` chooses Wayland when `XDG_SESSION_TYPE=wayland` or `WAYLAND_DISPLAY` is present; otherwise it chooses X11.

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

## Which Capabilities To Pass

X11:

```json
{
  "platformName": "Linux",
  "appium:automationName": "atspi2",
  "appium:appName": "galculator",
  "appium:linuxBackend": "x11"
}
```

Wayland:

```json
{
  "platformName": "Linux",
  "appium:automationName": "atspi2",
  "appium:appName": "galculator",
  "appium:linuxBackend": "wayland",
  "appium:waylandAutoShare": true
}
```

Auto-select backend:

```json
{
  "platformName": "Linux",
  "appium:automationName": "atspi2",
  "appium:appName": "galculator",
  "appium:linuxBackend": "auto"
}
```

For full step-by-step backend setup, see [Backend Quickstart (X11 vs Wayland)](docs/BACKEND_QUICKSTART.md).

## Locator Strategies

The driver supports:

- `xpath`
- `name`
- `class name`
- `id`
- `accessibility id`
- `tag name`
- `link text`
- `partial link text`
- `css selector`

Notes:

- XPath support is XPath 1.0 via `xpath.js`.
- CSS selector support includes practical subset (`tag`, `.class`, `#id`, `[attr]`, `[attr=value]`, descendant combinator).

## Extension Commands (`executeScript("linux: ...")`)

Command | Arguments | Description
--- | --- | ---
`linux: getDisplaySize` | none | Returns main display `{width, height}`.
`linux: mouseMove` | `{x, y}` | Moves pointer to absolute coordinates.
`linux: mouseSwipe` | `{sx, sy, ex, ey}` | Press-drag-release pointer gesture.
`linux: rightClick` | `{elementId}` | Right-clicks the center of the element.
`linux: doubleClick` | `{elementId}` | Double-clicks the center of the element.
`linux: mouseScroll` | `{moveLeftSteps?, moveUpSteps?}` | Scroll gesture; negative values reverse direction.
`linux: copy` | `{str}` | Copies string to system clipboard.
`linux: getClipboard` | none | Returns clipboard content.
`linux: click` | `[elementId]` | Clicks the given element (extension alias).
`linux: shell` | `{cmd}` | Executes shell command and returns stdout.

Example:

```python
find_btn = driver.find_element("name", "Find")
driver.execute_script("linux: click", [find_btn.id])
```

## Screenshots

- `driver.get_screenshot_as_file(...)` captures the active window.
- `element.screenshot(...)` captures an element region.

Wayland capture uses `gnome-screenshot` first when available to avoid interactive portal consent, with portal-native capture and `grim` as fallbacks.

## Wayland Notes

- On Ubuntu GNOME with `RemoteDesktop` portal v1, persisted restore tokens are not available; consent cannot be skipped by token reuse.
- By default, the driver runs an AT-SPI helper that auto-clicks portal `Share/Allow` buttons for unattended startup (`appium:waylandAutoShare=true`).
- If your environment disallows UI auto-consent, set `appium:waylandAutoShare=false` and approve portal dialogs manually.
- After successful startup, a restore token is rotated and persisted when the portal backend supports it.
- On GNOME (including RHEL), keep the active desktop session unlocked; locked sessions inhibit portal remote-desktop startup.
- If Wayland prerequisites are missing, the driver fails fast with actionable errors.

See [Ubuntu Wayland Guide](docs/UBUNTU_WAYLAND.md) for full setup.
For implementation details, see [Wayland Implementation Deep Dive](docs/WAYLAND_IMPLEMENTATION.md).

## UImate Runtime

This project relies on UImate runtime components distributed in `installers/`:

- [stdspalinux-ubuntu_18_04.deb](https://github.com/Itsmeaj/appium/blob/main/installers/stdspalinux-ubuntu_18_04.deb)
- [stdspalinux-ubuntu_20_04.deb](https://github.com/Itsmeaj/appium/blob/main/installers/stdspalinux-ubuntu_20_04.deb)
- [linux-inspector](https://github.com/Itsmeaj/appium/blob/main/installers/linux-inspector)

For RHEL packaging, runtime ownership lives under [`native/`](native/README.md), where EL-specific runtime artifacts are produced and validated before RPM creation.

## Test and Development

Run lint + unit tests:

```bash
npm test
```

Run functional tests:

```bash
npm run e2e-test
```

Notes:

- Functional tests are Linux-only and auto-skip on non-Linux hosts.
- Wayland-specific functional tests run only when `RUN_WAYLAND_E2E=1` in an active Wayland session.

## Contact

Name | Email
--- | ---
Ajay | send2ajay03@gmail.com
