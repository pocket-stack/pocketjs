#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../.." && pwd)"
output="${1:-${repo_root}/hosts/wm6/vs2005/prebuilt/PocketJS.WM6.Core.obj}"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/pocketjs-wm6-core.XXXXXX")"
trap 'rm -rf "$work_dir"' EXIT

arm_ld="${ARM_NONE_EABI_LD:-arm-none-eabi-ld}"
arm_objcopy="${ARM_NONE_EABI_OBJCOPY:-arm-none-eabi-objcopy}"
ce_objcopy="${WM6_CE_OBJCOPY:-arm-mingw32ce-objcopy}"
ce_ld="${WM6_CE_LD:-arm-mingw32ce-ld}"
ce_nm="${WM6_CE_NM:-arm-mingw32ce-nm}"
cargo="${CARGO:-cargo}"

for tool in "$cargo" "$arm_ld" "$arm_objcopy" "$ce_objcopy" "$ce_ld" "$ce_nm"; do
    if ! command -v "$tool" >/dev/null 2>&1; then
        echo "Required tool not found: ${tool}" >&2
        exit 2
    fi
done

export CARGO_TARGET_DIR="${work_dir}/cargo"
RUSTUP_TOOLCHAIN="${RUSTUP_TOOLCHAIN:-nightly}" "$cargo" build \
    --manifest-path "${repo_root}/engine/symbian/Cargo.toml" \
    --release --no-default-features --features freestanding \
    --target armv4t-none-eabi \
    -Z build-std=core,alloc,compiler_builtins \
    -Z build-std-features=compiler-builtins-mem

rust_archive="${CARGO_TARGET_DIR}/armv4t-none-eabi/release/libpocketjs_symbian_core.a"
aggregate="${work_dir}/pocketjs-core.elf.o"
localized="${work_dir}/pocketjs-core-localized.elf.o"
folded="${work_dir}/pocketjs-core-folded.elf.o"
unpatched="${work_dir}/pocketjs-core-unpatched.obj"
remapped="${work_dir}/pocketjs-core-remapped.obj"
linked="${work_dir}/PocketJS.WM6.Core.obj"

"$arm_ld" -m armelf -r -o "$aggregate" \
    --whole-archive "$rust_archive" --no-whole-archive
"$arm_objcopy" --wildcard \
    --keep-global-symbol='ui_*' \
    "$aggregate" "$localized"
"$arm_ld" -m armelf -r -x \
    -T "${script_dir}/core-sections.ld" \
    -o "$folded" "$localized"
"$ce_objcopy" \
    --strip-symbol=__aeabi_unwind_cpp_pr0 \
    -O pe-arm-wince-little \
    "$folded" "$unpatched"
python3 "${script_dir}/tools/patch_arm_coff_relocs.py" \
    "$folded" "$unpatched" "$remapped"
"$ce_ld" -m arm_wince_pe -r -o "$linked" "$remapped"

for symbol in ui_init ui_create_node ui_load_styles ui_render_incremental; do
    if ! "$ce_nm" "$linked" | grep -q " T ${symbol}\$"; then
        echo "Converted core is missing required export: ${symbol}" >&2
        exit 3
    fi
done
mkdir -p "$(dirname "$output")"
cp "$linked" "$output"
echo "Built ${output}"
