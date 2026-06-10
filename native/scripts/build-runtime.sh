#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NATIVE_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

EL_MAJOR=""
SOURCE_DIR="${NATIVE_ROOT}/libstdspalinux"
OUTPUT_DIR="${NATIVE_ROOT}/dist"
PREBUILT_LIB=""

usage() {
  cat <<'USAGE'
Build or stage libstdspalinux runtime artifact for a target EL major.

Usage:
  native/scripts/build-runtime.sh --el-major 8|9|10 [options]

Required:
  --el-major N             Target EL major (8, 9, 10)

Optional:
  --source-dir PATH        Runtime source root. Default: native/libstdspalinux
  --output-dir PATH        Output base directory. Default: native/dist
  --prebuilt-lib PATH      Skip source build and stage this prebuilt libstdspalinux.so
  -h, --help               Show help

Notes:
- Compile this artifact inside a matching EL container/VM for ABI correctness.
- Output path: <output-dir>/el<major>/libstdspalinux.so
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --el-major)
      EL_MAJOR="$2"
      shift 2
      ;;
    --source-dir)
      SOURCE_DIR="$2"
      shift 2
      ;;
    --output-dir)
      OUTPUT_DIR="$2"
      shift 2
      ;;
    --prebuilt-lib)
      PREBUILT_LIB="$2"
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

if [[ -z "${EL_MAJOR}" ]]; then
  echo "Error: --el-major is required" >&2
  usage
  exit 1
fi
if [[ "${EL_MAJOR}" != "8" && "${EL_MAJOR}" != "9" && "${EL_MAJOR}" != "10" ]]; then
  echo "Error: --el-major must be one of: 8, 9, 10" >&2
  exit 1
fi

TARGET_DIR="${OUTPUT_DIR}/el${EL_MAJOR}"
TARGET_LIB="${TARGET_DIR}/libstdspalinux.so"
mkdir -p "${TARGET_DIR}"

if [[ -n "${PREBUILT_LIB}" ]]; then
  if [[ ! -f "${PREBUILT_LIB}" ]]; then
    echo "Error: --prebuilt-lib not found: ${PREBUILT_LIB}" >&2
    exit 1
  fi
  cp "${PREBUILT_LIB}" "${TARGET_LIB}"
  echo "Staged runtime artifact: ${TARGET_LIB}"
  exit 0
fi

if [[ ! -d "${SOURCE_DIR}" ]]; then
  echo "Error: runtime source dir not found: ${SOURCE_DIR}" >&2
  echo "Import libstdspalinux source into native/libstdspalinux (or pass --source-dir)." >&2
  exit 1
fi

WORK_DIR="${SOURCE_DIR}/.build-el${EL_MAJOR}"
rm -rf "${WORK_DIR}"
mkdir -p "${WORK_DIR}"

if [[ -f "${SOURCE_DIR}/CMakeLists.txt" ]]; then
  cmake -S "${SOURCE_DIR}" -B "${WORK_DIR}" -DCMAKE_BUILD_TYPE=Release
  cmake --build "${WORK_DIR}" --config Release
elif [[ -f "${SOURCE_DIR}/Makefile" ]]; then
  make -C "${SOURCE_DIR}" clean
  make -C "${SOURCE_DIR}" -j"$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 2)"
else
  echo "Error: unsupported runtime build system in ${SOURCE_DIR}" >&2
  echo "Expected CMakeLists.txt or Makefile." >&2
  exit 1
fi

FOUND_LIB="$(find "${WORK_DIR}" "${SOURCE_DIR}" -type f -name 'libstdspalinux.so' | head -n 1 || true)"
if [[ -z "${FOUND_LIB}" ]]; then
  echo "Error: build finished but libstdspalinux.so was not found" >&2
  exit 1
fi

cp "${FOUND_LIB}" "${TARGET_LIB}"
echo "Built runtime artifact: ${TARGET_LIB}"
