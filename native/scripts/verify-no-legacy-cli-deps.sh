#!/usr/bin/env bash
set -euo pipefail

LIB_PATH=""

usage() {
  cat <<'USAGE'
Verify runtime library does not rely on legacy shell tooling.

Usage:
  native/scripts/verify-no-legacy-cli-deps.sh --lib /path/to/libstdspalinux.so
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --lib)
      LIB_PATH="$2"
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

if [[ -z "${LIB_PATH}" ]]; then
  echo "Error: --lib is required" >&2
  usage
  exit 1
fi

if [[ ! -f "${LIB_PATH}" ]]; then
  echo "Error: file not found: ${LIB_PATH}" >&2
  exit 1
fi

if ! command -v strings >/dev/null 2>&1; then
  echo "Error: required command not found: strings" >&2
  exit 1
fi
if ! command -v rg >/dev/null 2>&1; then
  echo "Error: required command not found: rg" >&2
  exit 1
fi

if strings "${LIB_PATH}" | rg -n "xdotool|xclip|xsel" >/dev/null; then
  echo "Error: legacy command dependency detected in ${LIB_PATH}" >&2
  echo "Expected native X11 implementation without xdotool/xclip/xsel shell calls." >&2
  exit 1
fi

echo "OK: no legacy xdotool/xclip/xsel command references in ${LIB_PATH}"
