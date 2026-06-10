# RHEL Getting Started

## Scope

Target platform:

- RHEL 8 / 9 / 10
- x86_64
- GNOME desktop sessions

Backend rollout order:

1. RHEL 9 Wayland
2. RHEL 8 Wayland
3. RHEL 10 Wayland (preview)
4. X11 across all three

## 1. Build Runtime Artifact

Runtime artifact is required at `native/dist/el<major>/libstdspalinux.so`.

If you already have a built runtime library:

```bash
./native/scripts/build-runtime.sh \
  --el-major 9 \
  --prebuilt-lib /path/to/libstdspalinux.so
```

Validate guardrail:

```bash
./native/scripts/verify-no-legacy-cli-deps.sh \
  --lib native/dist/el9/libstdspalinux.so
```

## 2. Build Unified RPM

```bash
./packaging/rpm/build-unified-installer.sh \
  --el-major 9 \
  --version 0.0.42-uimate8
```

## 3. Install RPM

```bash
sudo dnf install -y ./dist/installers/uimate-appium-linux-0.0.42-uimate8-1.el9.x86_64.rpm
```

## 4. Start Appium

```bash
APPIUM_HOME=/opt/uimate/appium-home appium --base-path /wd/hub
```

## 5. Create Session (Wayland)

```json
{
  "platformName": "Linux",
  "appium:automationName": "AtApi2",
  "appium:appName": "gnome-clocks",
  "appium:linuxBackend": "wayland",
  "appium:waylandAutoShare": true
}
```

## 6. Ensure GNOME Session Is Unlocked (Wayland)

```bash
SESSION_ID=$(loginctl list-sessions --no-legend | awk '$3==ENVIRON["USER"] && $4!="-" && $8=="yes" {print $1; exit}')
loginctl show-session "$SESSION_ID" -p LockedHint -p Active -p State
```

If `LockedHint=yes`, unlock before creating sessions:

```bash
sudo loginctl unlock-session "$SESSION_ID"
```

## 7. Verify Driver + Runtime

```bash
appium driver list --installed
uimate-appium-doctor
ls -l /usr/local/lib/libstdspalinux.so
```

## 8. Smoke Validation

Wayland smoke:

```bash
python3 scripts/manual_calc_test.py \
  --server http://127.0.0.1:4723/wd/hub \
  --app-name gnome-clocks \
  --linux-backend wayland \
  --wayland-auto-share true \
  --xml-out /tmp/rhel-wayland-clocks.xml
```

X11 smoke:

```bash
python3 scripts/manual_calc_test.py \
  --server http://127.0.0.1:4723/wd/hub \
  --app-name nautilus \
  --linux-backend x11 \
  --xml-out /tmp/rhel-x11-nautilus.xml
```

## Notes

- On Wayland, `getWindowHandles` returns deterministic synthetic handles.
- Use `appium:linuxBackend=auto` only when Appium process has correct GUI session env.
- For detailed Wayland requirements on RHEL, see [RHEL_WAYLAND](RHEL_WAYLAND.md).
