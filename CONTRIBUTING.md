# Contributing

Thanks for your interest in the Appium Linux Driver. This is an independently
maintained open-source project, and outside contributions are welcome.

## High-value contributions

Because Linux desktop automation spans many distros and toolkits, the most
useful contributions are often reports and data, not just code:

- **Distro coverage** — confirmation (or failures) on a specific
  distro/version/session you run. Include `/etc/os-release`, `XDG_SESSION_TYPE`,
  GNOME/compositor version, and the Appium driver log.
- **Toolkit findings** — GTK4/libadwaita, Qt, and Electron apps can expose
  AT-SPI differently than GTK3. Concrete app + observed-vs-expected page source
  is gold.
- **Performance data** — page-source / find timings on large application trees,
  with the app and distro noted. Performance is a first-class concern (see
  [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)); please do not land changes that
  regress the accessibility-tree hot path.
- **Open-backend work** — anything that moves a capability from the native
  runtime to an open implementation *without* losing speed (see the roadmap in
  ARCHITECTURE.md).

## Development setup

```bash
git clone https://github.com/Itsmeaj/appium.git
cd appium
npm install
npm test          # lint + unit tests (cross-platform)
npm run e2e-test  # functional tests (Linux-only; auto-skip elsewhere)
```

Wayland functional tests run only when `RUN_WAYLAND_E2E=1` inside an active
Wayland desktop session.

## Pull request guidelines

- Keep PRs focused; one concern per PR.
- Run `npm run lint` and `npm test` before pushing.
- For changes touching `lib/backends/` or `lib/commands/` (the runtime hot
  paths), describe the performance impact and include before/after timings when
  relevant.
- Do not introduce a pure-JavaScript-over-D-Bus accessibility-tree walker; it
  cannot meet the performance bar on large trees and is out of scope by design.
- Update docs and the support matrix when behavior or coverage changes.

## Reporting bugs

Open a GitHub issue with:

- distro + version, session type (X11/Wayland), GNOME/compositor version
- Appium version and the driver version
- the capabilities used and a minimal repro
- the Appium server log (and `getPageSource` output when relevant)

## License

By contributing you agree that your contributions are licensed under the
project's [Apache-2.0](LICENSE) license.
