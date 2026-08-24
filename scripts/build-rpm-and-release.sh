#!/usr/bin/env bash
# Run on RHEL machine: 10.4.134.220
# Prerequisites:
#   - gh CLI installed and authenticated (gh auth login)
#   - EL10 x86-64 libstdspalinux.so staged in native/dist/el10/
#   - npm install already run
#
# Usage:
#   ./scripts/build-rpm-and-release.sh --version 0.0.42
#   ./scripts/build-rpm-and-release.sh --version 0.0.42 --tag v0.0.42
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
VERSION=""
TAG=""

usage() {
  cat <<'USAGE'
Build the EL10 x86_64 RPM and upload it to the GitHub Release.

Usage:
  scripts/build-rpm-and-release.sh --version VERSION [--tag TAG]

Required:
  --version VERSION   Package version (e.g. 0.0.42)

Optional:
  --tag TAG           Git tag to upload assets to (default: v<VERSION>)
  -h, --help          Show this help
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) VERSION="$2"; shift 2 ;;
    --tag)     TAG="$2";     shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage; exit 1 ;;
  esac
done

if [[ -z "$VERSION" ]]; then
  echo "Error: --version is required." >&2
  usage
  exit 1
fi

TAG="${TAG:-v${VERSION}}"

# Verify running on RHEL family
if ! grep -qi "rhel\|centos\|rocky\|almalinux" /etc/os-release 2>/dev/null; then
  echo "Error: This script must run on a RHEL-family machine (detected: $(. /etc/os-release && echo "${ID:-unknown}"))." >&2
  exit 1
fi

# Detect EL major from running OS
EL_MAJOR="${EL_MAJOR:-$(grep -oP 'VERSION_ID="\K[0-9]+' /etc/os-release | cut -d. -f1)}"
if [[ "${EL_MAJOR}" != "10" || "$(uname -m)" != "x86_64" ]]; then
  echo "Error: this release helper requires an EL10 x86_64 build host." >&2
  exit 1
fi

# Verify .so is staged
SO_PATH="${REPO_ROOT}/native/dist/el${EL_MAJOR}/libstdspalinux.so"
if [[ ! -f "$SO_PATH" ]]; then
  echo "Error: libstdspalinux.so not found at native/dist/el${EL_MAJOR}/libstdspalinux.so" >&2
  echo "Run scripts/stage-rhel-lib.sh first." >&2
  exit 1
fi

# Verify gh CLI available
if ! command -v gh >/dev/null 2>&1; then
  echo "Error: gh CLI not found. Install from https://cli.github.com/" >&2
  exit 1
fi

echo "=== Building RPM for el${EL_MAJOR} ==="
"${REPO_ROOT}/packaging/rpm/build-unified-installer.sh" \
  --el-major "${EL_MAJOR}" \
  --appium-spec appium@2.19.0 \
  --version "${VERSION}"

RPM_FILES=("${REPO_ROOT}"/dist/installers/*.rpm)
if [[ ${#RPM_FILES[@]} -eq 0 ]]; then
  echo "Error: No RPM files found in dist/installers/" >&2
  exit 1
fi

echo ""
echo "=== Uploading RPM(s) to GitHub Release ${TAG} ==="
gh release upload "${TAG}" \
  "${REPO_ROOT}"/dist/installers/*.rpm \
  --repo Itsmeaj/appium \
  --clobber

echo ""
echo "=== Done ==="
echo "Users can now install with:"
echo "  curl -fsSL https://raw.githubusercontent.com/Itsmeaj/appium/master/install.sh | sudo bash"
