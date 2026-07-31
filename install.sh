#!/usr/bin/env bash
set -euo pipefail

REPO="Itsmeaj/appium"

detect_os() {
  # shellcheck source=/dev/null
  . /etc/os-release 2>/dev/null && echo "${ID:-unknown}" || echo "unknown"
}

detect_os_major() {
  # shellcheck source=/dev/null
  . /etc/os-release 2>/dev/null
  echo "${VERSION_ID%%.*}"
}

download_and_install() {
  local url="$1"
  local file="/tmp/$(basename "$url")"
  echo "Downloading $(basename "$url") ..."
  curl -fsSL "$url" -o "$file"
  echo "Installing..."
  if [[ "$file" == *.deb ]]; then
    sudo apt-get install -y "$file"
  elif [[ "$file" == *.rpm ]]; then
    sudo dnf install -y "$file"
  fi
  rm -f "$file"
}

echo "=== UImate Appium Linux Driver Installer ==="
echo ""

# Resolve latest release tag by following the redirect — avoids GitHub API rate limits
LATEST_URL=$(curl -fsSLI -o /dev/null -w "%{url_effective}" "https://github.com/${REPO}/releases/latest" 2>/dev/null)
LATEST_TAG=$(basename "${LATEST_URL}")
VERSION="${LATEST_TAG#v}"

if [[ -z "$VERSION" || "$VERSION" == "$LATEST_TAG" ]]; then
  echo "Error: Could not determine latest release version." >&2
  echo "Check: https://github.com/${REPO}/releases/latest" >&2
  exit 1
fi

echo "Latest release: ${LATEST_TAG}"
OS=$(detect_os)
OS_MAJOR=$(detect_os_major)
ARCH=$(uname -m)

case "$OS" in
  ubuntu|debian)
    if [[ "$ARCH" != "x86_64" ]]; then
      echo "Unsupported architecture for Ubuntu/Debian package: $ARCH (required: x86_64)." >&2
      exit 1
    fi
    echo "Detected OS: Ubuntu/Debian"
    URL="https://github.com/${REPO}/releases/download/${LATEST_TAG}/uimate-appium-linux_${VERSION}_amd64.deb"
    download_and_install "$URL"
    ;;
  rhel|centos|rocky|almalinux|fedora)
    if [[ "$OS_MAJOR" != "10" || "$ARCH" != "x86_64" ]]; then
      echo "Unsupported RHEL-family target: ${OS} ${OS_MAJOR:-unknown} ${ARCH} (required: EL10 x86_64)." >&2
      exit 1
    fi
    echo "Detected OS: RHEL-family EL10 x86_64"
    URL="https://github.com/${REPO}/releases/download/${LATEST_TAG}/uimate-appium-linux-${VERSION}-1.el10.x86_64.rpm"
    download_and_install "$URL"
    ;;
  *)
    echo "Unsupported OS: $OS" >&2
    echo "Supported release packages: Ubuntu/Debian x86_64 and RHEL-family EL10 x86_64" >&2
    exit 1
    ;;
esac

echo ""
echo "=== Installation complete ==="
echo "Verify:  uimate-appium-doctor"
echo "Start:   APPIUM_HOME=/opt/uimate/appium-home appium --port 4723"
