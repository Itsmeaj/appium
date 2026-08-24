#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

PACKAGE_NAME="uimate-appium-linux"
PACKAGE_ARCH="amd64"
OUTPUT_DIR="${REPO_ROOT}/dist/installers"
RUNTIME_DEB=""
DRIVER_STAGE_DIR=""
DRIVER_OFFLINE_DIR=""
APPIUM_VERIFY_DIR=""
DRIVER_BUNDLE_NAME="itsmeaj-appium-linux-driver.tgz"
VERIFY_DRIVER_RUNTIME_NAME="verify-driver-runtime.js"
APPIUM_SPEC="appium@2.19.0"

usage() {
  cat <<'USAGE'
Build a unified Debian installer that bundles stdspalinux runtime
and bootstraps Node.js/Appium/Appium Linux Driver.

Usage:
  packaging/deb/build-unified-installer.sh --runtime-deb /path/to/stdspalinux-runtime.deb [options]

Required:
  --runtime-deb PATH        Path to a real stdspalinux runtime .deb file.

Optional:
  --appium-spec SPEC       Appium npm spec to install during package post-install.
                           Examples: appium, appium@2.19.0, appium@beta
                           Default: appium
  --output-dir PATH         Output directory for generated package.
                            Default: dist/installers
  --version VERSION         Override package version.
                            Default: package.json version
  -h, --help                Show this help message.
USAGE
}

PACKAGE_VERSION="${PACKAGE_VERSION:-$(node -p "require('${REPO_ROOT}/package.json').version" 2>/dev/null || echo "0.0.0")}"
PACKAGE_VERSION="${PACKAGE_VERSION#v}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --runtime-deb)
      RUNTIME_DEB="$2"
      shift 2
      ;;
    --appium-spec)
      APPIUM_SPEC="$2"
      shift 2
      ;;
    --output-dir)
      OUTPUT_DIR="$2"
      shift 2
      ;;
    --version)
      PACKAGE_VERSION="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ -z "${RUNTIME_DEB}" ]]; then
  echo "Error: --runtime-deb is required." >&2
  usage
  exit 1
fi

if [[ ! -f "${RUNTIME_DEB}" ]]; then
  echo "Error: runtime .deb not found: ${RUNTIME_DEB}" >&2
  exit 1
fi

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "Error: Debian installer builds must run on Linux because the bundled driver contains Linux-native runtime dependencies." >&2
  exit 1
fi

if [[ "$(head -n1 "${RUNTIME_DEB}")" == "version https://git-lfs.github.com/spec/v1" ]]; then
  echo "Error: ${RUNTIME_DEB} is a Git LFS pointer, not a real Debian package." >&2
  echo "Provide the actual runtime .deb binary file." >&2
  exit 1
fi

for cmd in dpkg dpkg-deb fakeroot node npm corepack make g++ python3; do
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    echo "Error: required command not found: ${cmd}" >&2
    echo "Install build tools with: sudo apt-get install -y dpkg-dev fakeroot" >&2
    exit 1
  fi
done

BUILD_ARCH="$(dpkg --print-architecture)"
if [[ "${BUILD_ARCH}" != "${PACKAGE_ARCH}" ]]; then
  echo "Error: Debian installer must be built on ${PACKAGE_ARCH}; detected build architecture: ${BUILD_ARCH}." >&2
  exit 1
fi

if ! RUNTIME_ARCH="$(dpkg-deb -f "${RUNTIME_DEB}" Architecture 2>/dev/null)"; then
  echo "Error: unable to read Architecture from runtime package: ${RUNTIME_DEB}" >&2
  exit 1
fi
if [[ "${RUNTIME_ARCH}" != "${PACKAGE_ARCH}" ]]; then
  echo "Error: runtime package architecture must be ${PACKAGE_ARCH}; detected: ${RUNTIME_ARCH}." >&2
  exit 1
fi

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "${WORK_DIR}"' EXIT

PKG_ROOT="${WORK_DIR}/${PACKAGE_NAME}"
DEBIAN_DIR="${PKG_ROOT}/DEBIAN"
BIN_DIR="${PKG_ROOT}/usr/local/bin"
RUNTIME_CTRL_DIR="${WORK_DIR}/runtime-control"
DRIVER_STAGE_DIR="${WORK_DIR}/driver-package"
DRIVER_OFFLINE_DIR="${PKG_ROOT}/opt/uimate/offline"
APPIUM_VERIFY_DIR="${WORK_DIR}/appium-verification"

mkdir -p "${DEBIAN_DIR}" "${BIN_DIR}" "${RUNTIME_CTRL_DIR}" "${DRIVER_OFFLINE_DIR}" "${OUTPUT_DIR}"

dpkg-deb -e "${RUNTIME_DEB}" "${RUNTIME_CTRL_DIR}"
RUNTIME_DEPENDS="$(awk -F': ' '$1 == "Depends" {print $2}' "${RUNTIME_CTRL_DIR}/control" | tr -d '\r' || true)"
BASE_DEPENDS="bash, ca-certificates, curl, xz-utils"
if [[ -n "${RUNTIME_DEPENDS}" ]]; then
  COMBINED_DEPENDS="${BASE_DEPENDS}, ${RUNTIME_DEPENDS}"
else
  COMBINED_DEPENDS="${BASE_DEPENDS}"
fi

# Merge stdspalinux runtime payload directly into this package so installation
# is truly single-package and does not require nested dpkg/gdebi calls.
dpkg-deb -x "${RUNTIME_DEB}" "${PKG_ROOT}"

build_driver_bundle() {
  for cmd in node npm; do
    if ! command -v "${cmd}" >/dev/null 2>&1; then
      echo "Error: required command not found while packaging driver bundle: ${cmd}" >&2
      exit 1
    fi
  done

  if [[ ! -d "${REPO_ROOT}/build" ]]; then
    (
      cd "${REPO_ROOT}"
      npm run build
    )
  fi

  rm -rf "${DRIVER_STAGE_DIR}"
  mkdir -p "${DRIVER_STAGE_DIR}/build"
  cp -R "${REPO_ROOT}/build/." "${DRIVER_STAGE_DIR}/build/"
  cp \
    "${REPO_ROOT}/index.js" \
    "${REPO_ROOT}/LICENSE" \
    "${REPO_ROOT}/package.json" \
    "${REPO_ROOT}/yarn.lock" \
    "${DRIVER_STAGE_DIR}/"

  DRIVER_PACKAGE_JSON="${DRIVER_STAGE_DIR}/package.json" node <<'EOF'
const fs = require('fs');
const p = process.env.DRIVER_PACKAGE_JSON;
const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
const productionDeps = Object.keys(pkg.dependencies || {});
pkg.files = ['build', 'index.js', 'LICENSE'];
pkg.bundleDependencies = productionDeps;
pkg.bundledDependencies = productionDeps;
pkg.scripts = {};
delete pkg.devDependencies;
delete pkg['pre-commit'];
fs.writeFileSync(p, `${JSON.stringify(pkg, null, 2)}\n`);
EOF

  local install_log
  install_log="${WORK_DIR}/driver-package-install.log"
  (
    cd "${DRIVER_STAGE_DIR}"
    if ! YARN_CACHE_FOLDER="${WORK_DIR}/yarn-cache" corepack yarn@1.22.22 install \
      --production=true \
      --frozen-lockfile \
      --ignore-scripts \
      --non-interactive > "${install_log}" 2>&1; then
      cat "${install_log}" >&2 || true
      exit 1
    fi

    NPM_CONFIG_CACHE="${WORK_DIR}/npm-cache" npm rebuild sharp --foreground-scripts
    SHARP_PACKAGE_JSON="${DRIVER_STAGE_DIR}/node_modules/sharp/package.json" node <<'NODEEOF'
const fs = require('fs');
const packagePath = process.env.SHARP_PACKAGE_JSON;
const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
pkg.files = [...new Set([...(pkg.files || []), 'build/Release/*.node', 'vendor/**'])];
fs.writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
NODEEOF

    npm_node_gyp="$(npm root -g)/npm/node_modules/node-gyp/bin/node-gyp.js"
    if [[ ! -f "${npm_node_gyp}" ]]; then
      echo "Error: npm-bundled node-gyp was not found: ${npm_node_gyp}" >&2
      exit 1
    fi
    (
      cd node_modules/@stdspa/stdspalinux_temp
      node "${npm_node_gyp}" rebuild
    )
  )

  NPM_CONFIG_CACHE="${WORK_DIR}/npm-cache" npm install \
    --prefix "${APPIUM_VERIFY_DIR}" \
    --ignore-scripts \
    --no-audit \
    --no-fund \
    "${APPIUM_SPEC}"
  NODE_PATH="${APPIUM_VERIFY_DIR}/node_modules${NODE_PATH:+:${NODE_PATH}}" \
    node "${REPO_ROOT}/packaging/common/${VERIFY_DRIVER_RUNTIME_NAME}" "${DRIVER_STAGE_DIR}"

  local tgz_name
  tgz_name="$(
    cd "${DRIVER_STAGE_DIR}" &&
    npm pack --silent | tail -n 1
  )"
  if [[ -z "${tgz_name}" || ! -f "${DRIVER_STAGE_DIR}/${tgz_name}" ]]; then
    echo "Error: failed to generate local driver bundle." >&2
    exit 1
  fi

  local bundle_path
  local bundle_listing
  bundle_path="${DRIVER_STAGE_DIR}/${tgz_name}"
  bundle_listing="$(tar -tzf "${bundle_path}")"
  for required_path in \
    "package/package.json" \
    "package/build/index.js" \
    "package/node_modules/@babel/runtime/helpers/interopRequireDefault.js" \
    "package/node_modules/@stdspa/stdspalinux_temp/package.json" \
    "package/node_modules/@stdspa/stdspalinux_temp/build/Release/NativeExtension.node" \
    "package/node_modules/sharp/package.json" \
    "package/node_modules/sharp/build/Release/sharp-linux-x64.node"; do
    if ! grep -Fxq "${required_path}" <<<"${bundle_listing}"; then
      echo "Error: bundled driver artifact is missing required runtime path: ${required_path}" >&2
      exit 1
    fi
  done
  if ! grep -Eq '^package/node_modules/sharp/vendor/.+/linux-x64/lib/libvips-cpp\.so\.42$' <<<"${bundle_listing}"; then
    echo "Error: bundled driver artifact is missing the sharp libvips runtime." >&2
    exit 1
  fi
  cp "${DRIVER_STAGE_DIR}/${tgz_name}" "${DRIVER_OFFLINE_DIR}/${DRIVER_BUNDLE_NAME}"
}

build_driver_bundle
cp "${REPO_ROOT}/packaging/common/${VERIFY_DRIVER_RUNTIME_NAME}" "${DRIVER_OFFLINE_DIR}/${VERIFY_DRIVER_RUNTIME_NAME}"
printf '%s\n' "${APPIUM_SPEC}" > "${DRIVER_OFFLINE_DIR}/appium-spec.txt"

cat > "${DEBIAN_DIR}/control" <<EOF
Package: ${PACKAGE_NAME}
Version: ${PACKAGE_VERSION}
Section: utils
Priority: optional
Architecture: ${PACKAGE_ARCH}
Maintainer: Ajay <send2ajay03@gmail.com>
Depends: ${COMBINED_DEPENDS}
Description: Unified installer for UImate runtime and Appium Linux Driver
 This package bundles stdspalinux runtime and bootstraps Node.js 20,
 Appium, and @itsmeaj/appium-linux-driver for Ubuntu environments.
EOF

cat > "${DEBIAN_DIR}/postinst" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
export PATH="/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin:${PATH:-}"
NODE_VERSION="${UIMATE_NODE_VERSION:-20.19.0}"
APPIUM_HOME_DIR="/opt/uimate/appium-home"
PROFILE_FILE="/etc/profile.d/uimate-appium.sh"
DRIVER_BUNDLE="/opt/uimate/offline/itsmeaj-appium-linux-driver.tgz"
VERIFY_DRIVER_RUNTIME_SCRIPT="/opt/uimate/offline/verify-driver-runtime.js"
APPIUM_REQUESTED_SPEC_FILE="/opt/uimate/offline/appium-spec.txt"
# Read the bundled spec written at build time; fall back to "appium" if missing.
APPIUM_SPEC_DEFAULT="$(cat "${APPIUM_REQUESTED_SPEC_FILE}" 2>/dev/null || echo "appium")"
APPIUM_SPEC="${UIMATE_APPIUM_SPEC:-${APPIUM_SPEC_DEFAULT}}"
DRIVER_INSTALL_DIR="${APPIUM_HOME_DIR}/node_modules/@itsmeaj/appium-linux-driver"

log() {
  echo "[uimate-installer] $*"
}

ensure_node_20() {
  if command -v node >/dev/null 2>&1; then
    local node_version
    node_version="$(node -v || true)"
    if [[ "${node_version}" =~ ^v20\. ]]; then
      log "Node.js ${node_version} already installed."
      return
    fi
  fi

  local arch
  local node_arch
  local node_dist
  local node_url
  local tmp_dir
  local install_dir

  arch="$(dpkg --print-architecture)"
  case "${arch}" in
    amd64) node_arch="x64" ;;
    arm64) node_arch="arm64" ;;
    *)
      log "ERROR: unsupported architecture for bundled Node install: ${arch}"
      exit 1
      ;;
  esac

  node_dist="node-v${NODE_VERSION}-linux-${node_arch}"
  node_url="https://nodejs.org/dist/v${NODE_VERSION}/${node_dist}.tar.xz"
  tmp_dir="$(mktemp -d)"
  install_dir="/opt/uimate/${node_dist}"

  log "Installing Node.js ${NODE_VERSION} from ${node_url} ..."
  if ! curl -fsS --max-time 15 --head "https://nodejs.org/" >/dev/null 2>&1; then
    log "ERROR: Cannot reach nodejs.org. Internet access is required to download Node.js ${NODE_VERSION}."
    log "On air-gapped machines, install Node.js 20 manually (https://nodejs.org/dist/v${NODE_VERSION}/) then re-run: dpkg --configure -a"
    exit 1
  fi
  curl -fsSL "${node_url}" -o "${tmp_dir}/node.tar.xz"
  tar -xJf "${tmp_dir}/node.tar.xz" -C "${tmp_dir}"
  rm -rf "${install_dir}"
  mv "${tmp_dir}/${node_dist}" "${install_dir}"
  chown -R root:root "${install_dir}"

  ln -sf "${install_dir}/bin/node" /usr/local/bin/node
  ln -sf "${install_dir}/bin/npm" /usr/local/bin/npm
  ln -sf "${install_dir}/bin/npx" /usr/local/bin/npx
  if [[ -x "${install_dir}/bin/corepack" ]]; then
    ln -sf "${install_dir}/bin/corepack" /usr/local/bin/corepack
  fi

  rm -rf "${tmp_dir}"
}

ensure_appium() {
  log "Installing Appium from spec '${APPIUM_SPEC}'..."
  ensure_appium_symlink
  if command -v appium >/dev/null 2>&1; then
    log "Existing Appium before install: $(appium --version || echo unknown)"
  fi
  /usr/local/bin/npm install -g "${APPIUM_SPEC}"
  ensure_appium_symlink

  if ! command -v appium >/dev/null 2>&1; then
    log "ERROR: Appium binary not found after npm install. npm prefix: $(/usr/local/bin/npm prefix -g || echo unknown)"
    exit 1
  fi

  log "Resolved Appium version: $(appium --version || echo unknown)"
}

ensure_appium_symlink() {
  local npm_prefix
  local appium_candidate

  npm_prefix="$(/usr/local/bin/npm prefix -g 2>/dev/null || true)"
  if [[ -z "${npm_prefix}" ]]; then
    return
  fi

  appium_candidate="${npm_prefix}/bin/appium"
  if [[ -x "${appium_candidate}" ]]; then
    ln -sf "${appium_candidate}" /usr/local/bin/appium
  fi
}

ensure_profile_env() {
  mkdir -p "${APPIUM_HOME_DIR}"
  chown root:root "${APPIUM_HOME_DIR}"
  chmod 1777 "${APPIUM_HOME_DIR}"
  cat > "${PROFILE_FILE}" <<'EOPROFILE'
export APPIUM_HOME=/opt/uimate/appium-home
EOPROFILE
  chmod 0644 "${PROFILE_FILE}"
}

extract_driver_bundle() {
  if [[ ! -f "${DRIVER_BUNDLE}" ]]; then
    log "ERROR: bundled driver artifact missing: ${DRIVER_BUNDLE}"
    exit 1
  fi

  log "Extracting bundled Appium Linux driver into ${DRIVER_INSTALL_DIR}"
  rm -rf "${DRIVER_INSTALL_DIR}"
  mkdir -p "${DRIVER_INSTALL_DIR}"
  tar -xzf "${DRIVER_BUNDLE}" -C "${DRIVER_INSTALL_DIR}" --strip-components=1
}

register_driver_manifest() {
  local manifest_path
  manifest_path="${APPIUM_HOME_DIR}/node_modules/.cache/appium/extensions.yaml"
  mkdir -p "$(dirname "${manifest_path}")"

  node - "${DRIVER_INSTALL_DIR}" "${manifest_path}" <<'NODEEOF'
const fs = require('fs');
const path = require('path');

const [driverDir, manifestPath] = process.argv.slice(2);
const pkg = JSON.parse(fs.readFileSync(path.join(driverDir, 'package.json'), 'utf8'));
const appiumMeta = pkg.appium || {};

for (const field of ['driverName', 'automationName', 'platformNames', 'mainClass']) {
  if (!appiumMeta[field] || (Array.isArray(appiumMeta[field]) && appiumMeta[field].length === 0)) {
    throw new Error(`Driver package.json is missing required appium metadata field: ${field}`);
  }
}

const lines = [
  'schemaRev: 4',
  'drivers:',
  `  ${appiumMeta.driverName}:`,
  `    pkgName: ${JSON.stringify(pkg.name)}`,
  `    version: ${JSON.stringify(pkg.version)}`,
  `    automationName: ${JSON.stringify(appiumMeta.automationName)}`,
  '    platformNames:',
  ...appiumMeta.platformNames.map((platformName) => `      - ${JSON.stringify(platformName)}`),
  `    mainClass: ${JSON.stringify(appiumMeta.mainClass)}`,
  '    installType: "local"',
  `    installSpec: ${JSON.stringify(pkg.name)}`,
  `    installPath: ${JSON.stringify(driverDir)}`,
];

if (pkg.peerDependencies && typeof pkg.peerDependencies.appium === 'string') {
  lines.push(`    appiumVersion: ${JSON.stringify(pkg.peerDependencies.appium)}`);
}

lines.push('plugins: {}');
fs.writeFileSync(manifestPath, `${lines.join('\n')}\n`);
NODEEOF
}

verify_driver_runtime() {
  if [[ ! -f "${VERIFY_DRIVER_RUNTIME_SCRIPT}" ]]; then
    log "ERROR: bundled driver verifier missing: ${VERIFY_DRIVER_RUNTIME_SCRIPT}"
    exit 1
  fi

  log "Verifying extracted driver runtime dependencies..."
  /usr/local/bin/node "${VERIFY_DRIVER_RUNTIME_SCRIPT}" "${DRIVER_INSTALL_DIR}"
}

verify_driver_registration() {
  local appium_cmd
  local installed_json
  local warning_file
  export APPIUM_HOME="${APPIUM_HOME_DIR}"
  appium_cmd="/usr/local/bin/appium"
  if [[ ! -x "${appium_cmd}" ]]; then
    appium_cmd="$(command -v appium || true)"
  fi

  if [[ -z "${appium_cmd}" ]]; then
    log "ERROR: appium command is unavailable; cannot verify driver registration."
    exit 1
  fi

  log "Validating Appium driver registration..."
  warning_file="$(mktemp)"
  if ! installed_json="$("${appium_cmd}" driver list --installed --json 2> "${warning_file}")"; then
    cat "${warning_file}" >&2 || true
    rm -f "${warning_file}"
    log "ERROR: appium driver list --installed --json failed."
    exit 1
  fi
  if [[ -s "${warning_file}" ]]; then
    cat "${warning_file}" >&2
    if grep -Eqi 'may be incompatible|peer dependency' "${warning_file}"; then
      log "WARNING: Appium reported a peer dependency notice (non-fatal). The driver will still be registered."
    fi
  fi
  rm -f "${warning_file}"
  echo "${installed_json}"

  DRIVER_INSTALL_DIR="${DRIVER_INSTALL_DIR}" INSTALLED_JSON="${installed_json}" /usr/local/bin/node <<'NODEEOF'
const fs = require('fs');
const path = require('path');

const driverDir = process.env.DRIVER_INSTALL_DIR;
const installedJson = process.env.INSTALLED_JSON;
const pkg = JSON.parse(fs.readFileSync(path.join(driverDir, 'package.json'), 'utf8'));
const meta = pkg.appium || {};
const installed = JSON.parse(installedJson);
const record = installed[meta.driverName];

if (!record) {
  throw new Error(`Driver '${meta.driverName}' is missing from appium driver list output`);
}
if (record.pkgName !== pkg.name) {
  throw new Error(`Driver pkgName mismatch: expected '${pkg.name}', got '${record.pkgName}'`);
}
if (record.version !== pkg.version) {
  throw new Error(`Driver version mismatch: expected '${pkg.version}', got '${record.version}'`);
}
if (record.automationName !== meta.automationName) {
  throw new Error(`Driver automationName mismatch: expected '${meta.automationName}', got '${record.automationName}'`);
}
if (!Array.isArray(record.platformNames) || !record.platformNames.includes('Linux')) {
  throw new Error(`Driver platformNames are invalid: ${JSON.stringify(record.platformNames)}`);
}
if (record.mainClass !== meta.mainClass) {
  throw new Error(`Driver mainClass mismatch: expected '${meta.mainClass}', got '${record.mainClass}'`);
}
if (record.installPath && record.installPath !== driverDir) {
  throw new Error(`Driver installPath mismatch: expected '${driverDir}', got '${record.installPath}'`);
}
NODEEOF
}

find_free_port() {
  /usr/local/bin/node <<'NODEEOF'
const net = require('net');
const server = net.createServer();
server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  console.log(address.port);
  server.close();
});
NODEEOF
}

wait_for_appium_status() {
  local port="$1"
  local status_file="$2"
  local url

  for _ in $(seq 1 30); do
    for url in \
      "http://127.0.0.1:${port}/status" \
      "http://127.0.0.1:${port}/wd/hub/status"; do
      if curl -fsS "${url}" > "${status_file}"; then
        printf '%s\n' "${url}"
        return 0
      fi
    done
    sleep 1
  done

  return 1
}

verify_appium_server() {
  local appium_cmd
  local port
  local log_file
  local status_file
  local status_url
  local appium_pid

  appium_cmd="/usr/local/bin/appium"
  if [[ ! -x "${appium_cmd}" ]]; then
    appium_cmd="$(command -v appium || true)"
  fi

  if [[ -z "${appium_cmd}" ]]; then
    log "ERROR: appium command is unavailable; cannot verify server response."
    exit 1
  fi

  port="$(find_free_port)"
  log_file="$(mktemp)"
  status_file="$(mktemp)"

  log "Starting Appium server smoke test on port ${port}..."
  APPIUM_HOME="${APPIUM_HOME_DIR}" "${appium_cmd}" --address 127.0.0.1 --port "${port}" --log-no-colors > "${log_file}" 2>&1 &
  appium_pid=$!

  if ! status_url="$(wait_for_appium_status "${port}" "${status_file}")"; then
    cat "${log_file}" >&2 || true
    kill "${appium_pid}" >/dev/null 2>&1 || true
    wait "${appium_pid}" >/dev/null 2>&1 || true
    rm -f "${log_file}" "${status_file}"
    log "ERROR: Appium server did not respond successfully during smoke test."
    exit 1
  fi

  log "Appium server responded successfully at ${status_url}"
  cat "${status_file}"
  kill "${appium_pid}" >/dev/null 2>&1 || true
  wait "${appium_pid}" >/dev/null 2>&1 || true
  rm -f "${log_file}" "${status_file}"
}

main() {
  mkdir -p /opt/uimate
  ensure_node_20
  ensure_appium
  ensure_profile_env
  printf '%s\n' "${APPIUM_SPEC}" > "${APPIUM_REQUESTED_SPEC_FILE}"
  chmod 0644 "${APPIUM_REQUESTED_SPEC_FILE}"
  extract_driver_bundle
  register_driver_manifest
  verify_driver_runtime
  verify_driver_registration
  verify_appium_server

  log "Installation completed."
  log "Verify runtime: ls -l /usr/local/lib/libstdspalinux.so"
  log "Appium home: ${APPIUM_HOME_DIR}"
  log "Requested Appium spec: ${APPIUM_SPEC}"
  log "Appium version: $(appium --version || echo unknown)"
  log "Start server with: APPIUM_HOME=${APPIUM_HOME_DIR} appium"
}

main "$@"
EOF

cat > "${DEBIAN_DIR}/prerm" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
exit 0
EOF

cat > "${BIN_DIR}/uimate-appium-doctor" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

APPIUM_HOME_DIR="${APPIUM_HOME:-/opt/uimate/appium-home}"
DRIVER_DIR="${APPIUM_HOME_DIR}/node_modules/@itsmeaj/appium-linux-driver"
VERIFY_SCRIPT="/opt/uimate/offline/verify-driver-runtime.js"
REQUESTED_APPIUM_SPEC="$(cat /opt/uimate/offline/appium-spec.txt 2>/dev/null || echo unknown)"

echo "=== UImate Appium Doctor ==="
echo "Requested Appium spec: ${REQUESTED_APPIUM_SPEC}"
echo "Node: $(command -v node >/dev/null 2>&1 && node -v || echo missing)"
echo "NPM: $(command -v npm >/dev/null 2>&1 && npm -v || echo missing)"
echo "Appium: $(command -v appium >/dev/null 2>&1 && appium --version || echo missing)"
echo "APPIUM_HOME: ${APPIUM_HOME_DIR}"

if [[ -f /usr/local/lib/libstdspalinux.so ]]; then
  echo "stdspalinux: present (/usr/local/lib/libstdspalinux.so)"
else
  echo "stdspalinux: missing (/usr/local/lib/libstdspalinux.so)"
fi

echo "Wayland env:"
echo "  XDG_SESSION_TYPE=${XDG_SESSION_TYPE:-<unset>}"
echo "  WAYLAND_DISPLAY=${WAYLAND_DISPLAY:-<unset>}"

echo "Portal tooling:"
for c in xdg-desktop-portal wl-copy wl-paste gnome-screenshot; do
  if command -v "${c}" >/dev/null 2>&1; then
    echo "  ${c}: ok"
  else
    echo "  ${c}: missing"
  fi
done

if command -v appium >/dev/null 2>&1; then
  echo "Installed drivers:"
  APPIUM_HOME="${APPIUM_HOME_DIR}" appium driver list --installed --json || true
else
  echo "Installed drivers: appium command missing"
fi

if command -v node >/dev/null 2>&1 && [[ -f "${VERIFY_SCRIPT}" && -d "${DRIVER_DIR}" ]]; then
  echo "Driver runtime verification:"
  node "${VERIFY_SCRIPT}" "${DRIVER_DIR}" || true
else
  echo "Driver runtime verification: skipped (driver or verifier missing)"
fi
EOF

chmod 0755 "${DEBIAN_DIR}/postinst" "${DEBIAN_DIR}/prerm" "${BIN_DIR}/uimate-appium-doctor"

OUT_FILE="${OUTPUT_DIR}/${PACKAGE_NAME}_${PACKAGE_VERSION}_${PACKAGE_ARCH}.deb"
fakeroot dpkg-deb --build "${PKG_ROOT}" "${OUT_FILE}" >/dev/null

echo "Built installer: ${OUT_FILE}"
