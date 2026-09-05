#!/usr/bin/env bash
set -euo pipefail

quickjs_repo="https://github.com/pocket-stack/quickjs-rs"
quickjs_rev="0fc946fb670c0c29bc0135f510bcb0f595415a61"
quickjs_version="2026-06-04"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
output="${1:-${script_dir}/../vs2005/prebuilt/PocketJS.WM6.QuickJS.v3.dll}"
core_object="${WM6_CORE_OBJECT:-${script_dir}/../vs2005/prebuilt/PocketJS.WM6.Core.obj}"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/pocketjs-wm6-quickjs-dll.XXXXXX")"
trap 'rm -rf "$work_dir"' EXIT

if [[ -z "${WM6_CEGCC_ROOT:-}" ]]; then
    echo "WM6_CEGCC_ROOT must point at an extracted mingw32ce toolchain." >&2
    exit 2
fi
tool_bin="${WM6_CEGCC_ROOT}/mingw32ce/bin"
cc="${tool_bin}/arm-mingw32ce-gcc"
if [[ ! -x "$cc" ]]; then
    echo "arm-mingw32ce-gcc was not found under ${tool_bin}." >&2
    exit 2
fi
if [[ ! -f "$core_object" ]]; then
    echo "PocketJS WM6 core object not found: ${core_object}" >&2
    echo "Build it first with engine/wm6/build-core.sh." >&2
    exit 2
fi
if [[ -n "${WM6_CEGCC_LIBDIR:-}" ]]; then
    export LD_LIBRARY_PATH="${WM6_CEGCC_LIBDIR}${LD_LIBRARY_PATH:+:${LD_LIBRARY_PATH}}"
fi

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
mkdir -p "${work_dir}/obj" "$(dirname "$output")"
cp "${script_dir}/src/wm6_math.c" "${work_dir}/wm6_math.c"
cp "${script_dir}/src/runtime_dll.c" "${work_dir}/runtime_dll.c"
cp "${script_dir}/src/pocketjs_wm6_core.h" \
    "${work_dir}/pocketjs_wm6_core.h"
cp "${script_dir}/../vs2005/runtime/wm6_quickjs_abi.h" \
    "${work_dir}/wm6_quickjs_abi.h"

common_flags=(
    -std=gnu99 -march=armv4t -msoft-float -Os -funsigned-char
    -D_WIN32_WCE=0x0502 -DWINCE -D_WIN32
    "-DCONFIG_VERSION=\"${quickjs_version}\""
    "-I${quickjs_dir}" "-I${work_dir}"
)
for source in cutils dtoa libregexp libunicode quickjs; do
    "$cc" "${common_flags[@]}" -c "${quickjs_dir}/${source}.c" \
        -o "${work_dir}/obj/${source}.o"
done
"$cc" "${common_flags[@]}" -c "${work_dir}/wm6_math.c" \
    -o "${work_dir}/obj/wm6_math.o"
"$cc" "${common_flags[@]}" -c "${work_dir}/runtime_dll.c" \
    -o "${work_dir}/obj/runtime_dll.o"

"$cc" -shared -static-libgcc -march=armv4t -msoft-float \
    -o "${work_dir}/PocketJS.WM6.QuickJS.v3.dll" \
    "${work_dir}/obj/runtime_dll.o" "${work_dir}/obj/wm6_math.o" \
    "${work_dir}/obj/quickjs.o" "${work_dir}/obj/cutils.o" \
    "${work_dir}/obj/dtoa.o" "${work_dir}/obj/libregexp.o" \
    "${work_dir}/obj/libunicode.o" "$core_object" -lm
cp "${work_dir}/PocketJS.WM6.QuickJS.v3.dll" "$output"
echo "Built ${output}"
