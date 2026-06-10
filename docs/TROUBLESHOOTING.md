# Troubleshooting

## X11 Backend Requires Linux Runtime

Error:

```text
X11 backend requires Linux runtime. Current platform is 'darwin'
```

Why:

- X11 backend is Linux-only.

Fix:

- Run on Linux.
- Or force Wayland on a supported Wayland session with `appium:linuxBackend=wayland`.

## Missing X11 Shared Library

Error:

```text
X11 backend prerequisite is missing: '/usr/local/lib/libstdspalinux.so'
```

Why:

- stdspalinux shared library is not installed.

Fix:

```bash
ls -l /usr/local/lib/libstdspalinux.so
```

- Install UImate/stdspalinux runtime package if missing.
- On RHEL, install the matching unified RPM (`el8`, `el9`, or `el10`) to provision this file.

## Installer `.deb` Is Tiny Text File

Symptom:

- `.deb` install fails immediately, or `file` output says ASCII text.

Why:

- You downloaded a Git LFS pointer instead of the real binary artifact.

Fix:

```bash
git lfs install
git lfs pull --include='installers/*'
file installers/stdspalinux-ubuntu_20_04.deb
```

Expected `file` output should identify a Debian binary package, not text.

## Wayland Session Not Detected

Error:

```text
Wayland backend requested, but this process is not in a Wayland session
```

Check:

```bash
echo "$XDG_SESSION_TYPE"
echo "$WAYLAND_DISPLAY"
```

Fix:

- Log in to a Wayland session.
- Avoid forcing Xorg for that run.

## Wayland Portal Consent Blocking Startup

Symptom:

- Session start waits for user consent.

Why:

- First run requires XDG portal permission for Remote Desktop / ScreenCast.

Fix:

- Approve the desktop prompt once.
- Re-run so restore token can be persisted.

## Wayland CreateSession Fails With "Session creation inhibited" / Locked Session

Error:

```text
Failed to initialize linux backend: Wayland desktop session '<id>' is locked
```

Why:

- GNOME blocks RemoteDesktop portal session creation when the active desktop session is locked.
- `journalctl` usually shows: `Session creation inhibited`.

Check:

```bash
loginctl show-session "$(loginctl list-sessions --no-legend | awk '$3==ENVIRON["USER"] && $4!="-" && $8=="yes" {print $1; exit}')" -p LockedHint -p Active -p State
```

Fix:

```bash
sudo loginctl unlock-session <session-id>
```

Then retry the Appium session.

## `APPIUM_HOME` Not Writable

Error:

```text
The APPIUM_HOME environment variable '/opt/uimate/appium-home' must be writeable
```

Fix:

```bash
sudo chmod 1777 /opt/uimate/appium-home
```

## Missing Wayland Tools (`wl-copy`, `wl-paste`, screenshot tools)

Symptoms:

- Clipboard behavior is inconsistent.
- Screenshots fail or are empty.

Check:

```bash
which wl-copy wl-paste gnome-screenshot grim
```

Fix:

```bash
sudo apt update
sudo apt install -y wl-clipboard
# optional fallback:
sudo apt install -y gnome-screenshot grim
```

RHEL equivalent:

```bash
sudo dnf install -y wl-clipboard
# optional fallback:
sudo dnf install -y gnome-screenshot
```

Portal-native screenshots are attempted first; these tools are fallback paths.

## Wayland Preflight Fails On RHEL

Symptom:

- Session creation fails fast with missing prerequisites (`xdg-desktop-portal`, `pipewire`, or session env vars).

Fix:

```bash
sudo dnf install -y xdg-desktop-portal xdg-desktop-portal-gnome pipewire python3-atspi
```

Then ensure Appium starts with active desktop env:

```bash
echo "$XDG_SESSION_TYPE"
echo "$DBUS_SESSION_BUS_ADDRESS"
echo "$XDG_RUNTIME_DIR"
```

## Functional Tests Show as Pending

Symptom:

- `npm run e2e-test` reports pending tests.

Why:

- Functional specs are Linux-only and skip on non-Linux hosts.
- Wayland specs also require `RUN_WAYLAND_E2E=1` and active Wayland session.

Fix:

```bash
RUN_WAYLAND_E2E=1 npm run e2e-test
```

## Verify Driver Installation

```bash
appium driver list --installed
```

Expected entry:

- `atspi2@... [installed (npm)]`
