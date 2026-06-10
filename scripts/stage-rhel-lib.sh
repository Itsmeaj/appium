#!/usr/bin/env bash
# Run on RHEL machine to find and stage libstdspalinux.so before building the RPM.
# The EL8-compiled .so is forward-compatible with RHEL 8, 9, and 10.
#
# Usage:
#   ./scripts/stage-rhel-lib.sh [--lib /path/to/libstdspalinux.so]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
DEST="${REPO_ROOT}/native/dist/el8/libstdspalinux.so"
EXPLICIT_LIB=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --lib) EXPLICIT_LIB="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: scripts/stage-rhel-lib.sh [--lib /path/to/libstdspalinux.so]"
      exit 0
      ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [[ -n "$EXPLICIT_LIB" ]]; then
  if [[ ! -f "$EXPLICIT_LIB" ]]; then
    echo "Error: file not found: $EXPLICIT_LIB" >&2
    exit 1
  fi
  cp "$EXPLICIT_LIB" "$DEST"
  echo "Staged $EXPLICIT_LIB → native/dist/el8/libstdspalinux.so"
  exit 0
fi

# Auto-discover from common install locations
CANDIDATES=(
  /usr/local/lib/libstdspalinux.so
  /usr/lib/libstdspalinux.so
  /usr/lib64/libstdspalinux.so
  /opt/uimate/lib/libstdspalinux.so
  /opt/uimate/libstdspalinux.so
)

for candidate in "${CANDIDATES[@]}"; do
  if [[ -f "$candidate" ]]; then
    echo "Found: $candidate"
    cp "$candidate" "$DEST"
    echo "Staged → native/dist/el8/libstdspalinux.so"
    exit 0
  fi
done

echo "libstdspalinux.so not found in common locations."
echo ""
echo "Options:"
echo "  1. Provide the path explicitly:"
echo "       ./scripts/stage-rhel-lib.sh --lib /path/to/libstdspalinux.so"
echo ""
echo "  2. Build from source (requires CMake and EL8 build environment):"
echo "       ./native/scripts/build-runtime.sh --el-major 8"
exit 1
