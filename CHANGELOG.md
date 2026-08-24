# Changelog

All notable changes to this project are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0]

### Added
- Appium Doctor checks for Linux, the desktop session, the native AT-SPI
  runtime, and Wayland portal prerequisites.
- CI compatibility checks that install the driver through Appium 2.19 and 3.4.
- Safe direct application launch arguments and attach-to-running-app support.
- `docs/ARCHITECTURE.md` documents the open and native components and the
  roadmap toward a fully self-contained build.
- `CONTRIBUTING.md` describes contribution guidelines, with emphasis on
  distro/toolkit coverage and the accessibility-tree hot path.

### Changed
- Switched to Appium's public `appium/driver` and `appium/support` exports.
- Corrected the extension automation name to `AtSpi2` and declared supported
  Node.js and Appium version ranges.
- Restricted portal restore-token files to owner-only permissions.
- Reworked the documentation for community use, including native runtime
  prerequisites, the cross-distro support matrix, and the standard
  `appium driver install` path.
- Declared compatibility with Appium 2 and Appium 3.

## [0.0.55]

### Added
- Initial public release of the Appium Linux Driver.
- AT-SPI2-based desktop automation for Linux with dual backend support:
  - **X11** via the native runtime.
  - **Wayland** via XDG desktop portals (`RemoteDesktop`, `ScreenCast`,
    `Screenshot`), with unattended portal consent handling.
- Auto backend selection from `XDG_SESSION_TYPE` / `WAYLAND_DISPLAY`.
- Locator strategies: xpath, name, class name, id, accessibility id, tag name,
  link text, partial link text, css selector.
- Extension commands: `linux: click`, `rightClick`, `doubleClick`, `mouseMove`,
  `mouseSwipe`, `mouseScroll`, `copy`, `getClipboard`, `getDisplaySize`,
  `shell`.
- Window- and element-region screenshots.
- Cross-distro detection and preflight for Ubuntu (20/22/24/26 + family) and
  RHEL (8/9/10 + family).
- Pre-built `.deb` / `.rpm` packages published via GitHub Actions.
