#!/usr/bin/env bash
set -euo pipefail

quickjs_repo="https://github.com/pocket-stack/quickjs-rs"
quickjs_rev="0fc946fb670c0c29bc0135f510bcb0f595415a61"
quickjs_version="2026-06-04"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../../.." && pwd)"
bundle="${1:-${script_dir}/../vs2005/prebuilt/PocketJS.WM6.Demo.js}"
pak="${2:-${script_dir}/../vs2005/prebuilt/PocketJS.WM6.Demo.pak}"
viewport_width="${3:-640}"
viewport_height="${4:-480}"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/pocketjs-wm6-native-test.XXXXXX")"
trap 'rm -rf "$work_dir"' EXIT

cargo="${CARGO:-cargo}"
cc="${CC:-cc}"
for tool in "$cargo" "$cc" git patch; do
    if ! command -v "$tool" >/dev/null 2>&1; then
        echo "Required tool not found: ${tool}" >&2
        exit 2
    fi
done
for asset in "$bundle" "$pak"; do
    if [[ ! -f "$asset" ]]; then
        echo "Required Hero asset not found: ${asset}" >&2
        exit 2
    fi
done

if [[ -n "${WM6_QUICKJS_SOURCE:-}" ]]; then
    if [[ "$(git -C "$WM6_QUICKJS_SOURCE" rev-parse HEAD)" != "$quickjs_rev" ]]; then
        echo "WM6_QUICKJS_SOURCE is not at the pinned revision ${quickjs_rev}." >&2
        exit 2
    fi
    cp -R "$WM6_QUICKJS_SOURCE" "${work_dir}/quickjs-rs"
else
    git init -q "${work_dir}/quickjs-rs"
    git -C "${work_dir}/quickjs-rs" remote add origin "$quickjs_repo"
    git -C "${work_dir}/quickjs-rs" fetch -q --depth 1 origin "$quickjs_rev"
    git -C "${work_dir}/quickjs-rs" checkout -q FETCH_HEAD
fi

quickjs_dir="${work_dir}/quickjs-rs/libquickjs-sys/embed/quickjs"
patch -d "$quickjs_dir" -p1 < "${script_dir}/patches/quickjs-wm6.patch"
export CARGO_TARGET_DIR="${work_dir}/cargo"
RUSTUP_TOOLCHAIN="${RUSTUP_TOOLCHAIN:-nightly}" "$cargo" build \
    --manifest-path "${repo_root}/engine/symbian/Cargo.toml" \
    --release --no-default-features
core_archive="${CARGO_TARGET_DIR}/release/libpocketjs_symbian_core.a"

mkdir -p "${work_dir}/obj"
common_flags=(
    -std=gnu99 -O2 -funsigned-char -Wall -Wextra -Werror
    "-DCONFIG_VERSION=\"${quickjs_version}\""
    "-I${script_dir}/tests"
    -isystem "$quickjs_dir"
    "-I${script_dir}/src"
    "-I${script_dir}/../vs2005/runtime"
)
for source in cutils dtoa libregexp libunicode quickjs; do
    "$cc" "${common_flags[@]}" -w -c "${quickjs_dir}/${source}.c" \
        -o "${work_dir}/obj/${source}.o"
done
"$cc" "${common_flags[@]}" -c "${script_dir}/src/runtime_dll.c" \
    -o "${work_dir}/obj/runtime_dll.o"
"$cc" "${common_flags[@]}" -c "${script_dir}/tests/runtime_smoke.c" \
    -o "${work_dir}/obj/runtime_smoke.o"

"$cc" -o "${work_dir}/runtime-smoke" \
    "${work_dir}/obj/runtime_smoke.o" "${work_dir}/obj/runtime_dll.o" \
    "${work_dir}/obj/quickjs.o" "${work_dir}/obj/cutils.o" \
    "${work_dir}/obj/dtoa.o" "${work_dir}/obj/libregexp.o" \
    "${work_dir}/obj/libunicode.o" "$core_archive" \
    -lgcc_s -lutil -lrt -lpthread -lm -ldl
"${work_dir}/runtime-smoke" \
    "$bundle" "$pak" "$viewport_width" "$viewport_height"
