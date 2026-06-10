# Getting Started

## Scope

This guide is the fastest path to run Appium Linux Driver on:

- Ubuntu 22.04 / 24.04 (GNOME)
- RHEL 8 / 9 / 10 (GNOME, x86_64)

For backend internals, see [Wayland Implementation Deep Dive](WAYLAND_IMPLEMENTATION.md).
For exact capability sets, see [Backend Quickstart (X11 vs Wayland)](BACKEND_QUICKSTART.md).

## 1. Pick Installer Path

- Ubuntu: use unified `.deb` flow in [Unified Installer](UNIFIED_INSTALLER.md#ubuntu-deb-flow).
- RHEL: use unified `.rpm` flow in [Unified Installer](UNIFIED_INSTALLER.md#rhel-rpm-flow).

## 2. Start Appium Server

```bash
APPIUM_HOME=/opt/uimate/appium-home appium
```

## 3. Choose Backend Capability

Common capabilities:

```json
{
  "platformName": "Linux",
  "appium:automationName": "atspi2",
  "appium:appName": "galculator"
}
```

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

Auto-select:

```json
{
  "platformName": "Linux",
  "appium:automationName": "atspi2",
  "appium:appName": "galculator",
  "appium:linuxBackend": "auto"
}
```

## 4. Verify Session Type

```bash
echo "XDG_SESSION_TYPE=$XDG_SESSION_TYPE"
echo "WAYLAND_DISPLAY=$WAYLAND_DISPLAY"
```

If `XDG_SESSION_TYPE=wayland`, use Wayland (or `auto`).
If `XDG_SESSION_TYPE=x11`, use X11.

## 5. Smoke Test (Python)

```python
from appium import webdriver
from appium.options.common.base import AppiumOptions
from appium.webdriver.common.appiumby import AppiumBy

caps = {
    "platformName": "Linux",
    "appium:automationName": "atspi2",
    "appium:appName": "galculator",
    "appium:linuxBackend": "auto"
}

driver = webdriver.Remote(
    "http://127.0.0.1:4723",
    options=AppiumOptions().load_capabilities(caps)
)

find_button = driver.find_element(AppiumBy.NAME, "Find")
find_button.click()
print(driver.page_source[:500])

driver.quit()
```

## 6. Next Docs

- Ubuntu Wayland specifics: [UBUNTU_WAYLAND](UBUNTU_WAYLAND.md)
- RHEL specifics: [RHEL_GETTING_STARTED](RHEL_GETTING_STARTED.md), [RHEL_WAYLAND](RHEL_WAYLAND.md)
- RHEL internals: [RHEL_IMPLEMENTATION](RHEL_IMPLEMENTATION.md)
- Troubleshooting: [TROUBLESHOOTING](TROUBLESHOOTING.md)
