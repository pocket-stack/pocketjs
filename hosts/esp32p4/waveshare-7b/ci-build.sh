#!/usr/bin/env bash
set -euo pipefail

# Final-link the complete QuickJS host inside Espressif's pinned IDF image.
# The normal device command builds a real app; CI uses the smallest valid guest
# so runtime/C ABI, BSP, dependency-lock, and linker regressions stay covered.

readonly POCKETJS_CI_TOOLCHAIN="nightly-2026-07-02"
readonly POCKETJS_CI_TARGET="riscv32imafc-esp-espidf"
readonly POCKETJS_CI_ROOT="$(git rev-parse --show-toplevel)"
readonly POCKETJS_CI_TMP="$(mktemp -d /tmp/pocketjs-esp32p4-ci.XXXXXX)"
readonly POCKETJS_CI_RUSTUP="${POCKETJS_CI_TMP}/rustup"
readonly POCKETJS_CI_CARGO="${POCKETJS_CI_TMP}/cargo"
trap 'rm -rf "${POCKETJS_CI_TMP}"' EXIT

if ! command -v curl >/dev/null ||
  ! command -v clang >/dev/null ||
  ! ldconfig -p 2>/dev/null | grep -q libclang; then
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends ca-certificates clang curl libclang-dev
fi

export RUSTUP_HOME="${POCKETJS_CI_RUSTUP}"
export CARGO_HOME="${POCKETJS_CI_CARGO}"
export PATH="${CARGO_HOME}/bin:${PATH}"
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs |
  sh -s -- -y --profile minimal --default-toolchain none
rustup toolchain install "${POCKETJS_CI_TOOLCHAIN}" --profile minimal --component rust-src

readonly POCKETJS_CI_GCC="$(command -v riscv32-esp-elf-gcc)"
readonly POCKETJS_CI_AR="$(command -v riscv32-esp-elf-ar)"
readonly POCKETJS_CI_SYSROOT="$(${POCKETJS_CI_GCC} -print-sysroot)"
readonly POCKETJS_CI_GCC_INCLUDE="$(${POCKETJS_CI_GCC} -print-file-name=include)"
readonly POCKETJS_CI_GCC_FIXED="$(${POCKETJS_CI_GCC} -print-file-name=include-fixed)"

export CARGO_TARGET_DIR="${POCKETJS_CI_TMP}/rust-target"
export CARGO_TARGET_RISCV32IMAFC_ESP_ESPIDF_RUSTFLAGS="-C relocation-model=static"
export CC_riscv32imafc_esp_espidf="${POCKETJS_CI_GCC}"
export AR_riscv32imafc_esp_espidf="${POCKETJS_CI_AR}"
export CFLAGS_riscv32imafc_esp_espidf="-mabi=ilp32f -march=rv32imafc_zicsr_zifencei_xesppie -Wno-error=incompatible-pointer-types -fno-pic -fno-pie"
export BINDGEN_EXTRA_CLANG_ARGS="--target=riscv32-unknown-elf --sysroot=${POCKETJS_CI_SYSROOT} -isystem ${POCKETJS_CI_GCC_INCLUDE} -isystem ${POCKETJS_CI_GCC_FIXED} -isystem ${POCKETJS_CI_SYSROOT}/include"

cargo "+${POCKETJS_CI_TOOLCHAIN}" build \
  --locked \
  --manifest-path "${POCKETJS_CI_ROOT}/hosts/esp32p4/runtime/Cargo.toml" \
  --release \
  --lib \
  --target "${POCKETJS_CI_TARGET}" \
  --features esp-idf \
  -Z build-std=std,panic_abort

readonly POCKETJS_CI_RUST_LIB="${CARGO_TARGET_DIR}/${POCKETJS_CI_TARGET}/release/libpocketjs_esp32p4_runtime.a"
readonly POCKETJS_CI_APP_JS="${POCKETJS_CI_TMP}/app.js"
readonly POCKETJS_CI_APP_PAK="${POCKETJS_CI_TMP}/app.pak"
readonly POCKETJS_CI_BUILD="${POCKETJS_CI_TMP}/idf-build"
printf '%s\n' 'globalThis.frame = function () {};' >"${POCKETJS_CI_APP_JS}"
: >"${POCKETJS_CI_APP_PAK}"

idf.py \
  -C "${POCKETJS_CI_ROOT}/hosts/esp32p4/waveshare-7b" \
  -B "${POCKETJS_CI_BUILD}" \
  -D "POCKETJS_REPO_ROOT=${POCKETJS_CI_ROOT}" \
  -D "POCKETJS_RUST_LIB=${POCKETJS_CI_RUST_LIB}" \
  -D "POCKETJS_APP_JS=${POCKETJS_CI_APP_JS}" \
  -D "POCKETJS_APP_PAK=${POCKETJS_CI_APP_PAK}" \
  -D "POCKETJS_APP_TITLE=CI" \
  -D "POCKETJS_BUILD_ID=ci-final-link" \
  build

test -s "${POCKETJS_CI_BUILD}/pocketjs_esp32p4_waveshare_7b.bin"
python - "${POCKETJS_CI_BUILD}/flasher_args.json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as source:
    flash_files = json.load(source)["flash_files"]
required = {"0x2000", "0x8000", "0x10000"}
missing = required.difference(flash_files)
if missing:
    raise SystemExit(f"segmented flash manifest is missing: {sorted(missing)}")
PY
