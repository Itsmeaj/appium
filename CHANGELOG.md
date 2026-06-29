# Changelog

All notable changes to this project are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed
- Documentation reworked for community/open-source readiness: honest dependency
  framing (native AT-SPI runtime as a documented prerequisite, à la XCTest),
  accurate cross-distro support matrix, and standard `appium driver install` as
  the primary install path.
- Widened the `appium` peer dependency range to signal compatibility with
  current and future Appium 2.x+ servers.

### Added
- `docs/ARCHITECTURE.md` — transparent open-vs-native breakdown and the roadmap
  toward a fully self-contained build without regressing performance.
- `CONTRIBUTING.md` — contribution guidelines, with emphasis on distro/toolkit
  coverage reports and protecting the accessibility-tree hot path.

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
