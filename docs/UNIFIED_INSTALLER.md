# Unified Installer (Ubuntu + RHEL 10)

This project ships OS-specific unified installer flows that bundle runtime + Appium driver artifact.

## Ubuntu `.deb` Flow

### What It Installs

`uimate-appium-linux_<version>_amd64.deb` installs:

- UImate runtime files (including `/usr/local/lib/libstdspalinux.so`)
- Node.js 20.x under `/opt/uimate/`
- Global Appium CLI from the requested npm spec
- Bundled Appium Linux driver artifact with production `node_modules`
- `/usr/local/bin/uimate-appium-doctor`

### Build Prerequisites

```bash
sudo apt-get update
sudo apt-get install -y dpkg-dev fakeroot
```

### Build

```bash
git lfs install
git lfs pull --include='installers/*'
./packaging/deb/build-unified-installer.sh \
  --runtime-deb installers/stdspalinux-ubuntu_20_04.deb \
  --appium-spec appium@2.19.0 \
  --version 0.1.0
```

Output:

- `dist/installers/uimate-appium-linux_0.1.0_amd64.deb`

### Install

```bash
sudo apt-get install -y ./dist/installers/uimate-appium-linux_0.1.0_amd64.deb
```

## RHEL `.rpm` Flow

### Scope

- RHEL 10
- x86_64
- GNOME sessions

The v0.1.0 release does not claim compatibility with earlier RHEL releases.
The EL10 X11 runtime invokes `xdotool`, `xclip`, and `xsel`; these are declared
RPM dependencies and must be available from the target machine's configured
repositories.

### Runtime Artifact Requirement

RHEL RPM build expects EL-specific runtime artifact at:

- `native/dist/el10/libstdspalinux.so`

Generate/stage runtime artifact:

```bash
./native/scripts/build-runtime.sh --el-major 10 --prebuilt-lib /path/to/libstdspalinux.so
```

Validate runtime guardrail (no `xdotool`/`xclip`/`xsel` dependency):

```bash
./native/scripts/verify-no-legacy-cli-deps.sh --lib native/dist/el10/libstdspalinux.so
```

### Build RPM

```bash
./packaging/rpm/build-unified-installer.sh \
  --el-major 10 \
  --appium-spec appium@2.19.0 \
  --version 0.1.0
```

Outputs:

- `dist/installers/uimate-appium-linux-0.1.0-1.el10.x86_64.rpm`
- `dist/installers/uimate-appium-linux-0.1.0-1.el10.x86_64.rpm.sha256`

### Install RPM

```bash
sudo dnf install -y ./dist/installers/uimate-appium-linux-0.1.0-1.el10.x86_64.rpm
```

## Verify Installation (Both Flows)

```bash
node -v
npm -v
appium --version
APPIUM_HOME=/opt/uimate/appium-home appium driver list --installed
uimate-appium-doctor
```

Expected driver entry:

- `atspi2@... [installed (local)]`

What the installer now validates before it reports success:

- the requested Appium npm spec resolves and installs
- the packaged Linux driver bundle contains production runtime dependencies
- the extracted driver entrypoint can be required without missing modules
- `APPIUM_HOME=/opt/uimate/appium-home appium driver list --installed --json` shows the expected driver metadata
- a local Appium server starts and returns a healthy `/status` response

Notes:

- Build the offline driver bundle on Linux, not macOS, because native dependencies such as `sharp` and `@stdspa/stdspalinux_temp` are platform-specific.
- For the RHEL RPM flow, build on a RHEL-compatible host for the same EL major you are targeting so the bundled native dependency set matches the final SUT environment.
- The build scripts now fail fast if you try to build the installer on the wrong host OS for the target artifact.

## Upgrade

Build with a new version and install again (`apt`/`dnf` handles upgrade):

```bash
# Ubuntu
./packaging/deb/build-unified-installer.sh --runtime-deb installers/stdspalinux-ubuntu_20_04.deb --appium-spec appium@beta --version 0.0.42-uimate9
sudo apt-get install -y ./dist/installers/uimate-appium-linux_0.0.42-uimate9_amd64.deb

# RHEL 10 x86-64
./packaging/rpm/build-unified-installer.sh --el-major 10 --appium-spec appium@beta --version 0.0.42-uimate9
sudo dnf install -y ./dist/installers/uimate-appium-linux-0.0.42-uimate9-1.el10.x86_64.rpm
```
