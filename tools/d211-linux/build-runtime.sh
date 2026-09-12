#!/usr/bin/env bash
#
# D211 cross-build: QuickJS + PocketJS runtime + fbdev host, linked with the
# Luban Xuantie GCC wrapper and LLVM LLD.
#
# Runs on the canonical builder (Ubuntu x86_64) with the Luban SDK already
# built. The host object graph is compiled with the SDK wrapper/sysroot; the
# final link uses the LLD shipped with the pinned Rust nightly because Luban's
# binutils 2.35 cannot parse modern RISC-V ELF attributes (Zaamo/Zalrsc).
#
# Environment:
#   POCKET_BUILD_ID           unique id baked into the binary
#   POCKETJS_TARGET_ID        verified ResolvedBuildPlan target
#   POCKETJS_HOST_ABI         verified ResolvedBuildPlan host ABI
#   POCKET_RASTER_DENSITY     plan raster density
#   POCKET_LOGICAL_WIDTH/HEIGHT  logical viewport
#   REPO_ROOT                 PocketJS checkout
#   BUILD_DIR                 scratch output directory
#   LUBAN_OUTPUT_DIR          <sdk>/output/<board>
#   LUBAN_GCC_PREFIX          e.g. riscv64-unknown-linux-gnu
#   LLD_SHIM_DIR              directory with ld.lld and <prefix>-ld.lld symlinks
#   QUICKJS_VERSION           pinned QuickJS version string
#   QUICKJS_DIR               libquickjs-sys/embed/quickjs
#   QUICKJS_STATIC_FUNCTIONS  libquickjs-sys/embed/static-functions.c
#   RUST_CORE_ARCHIVE         libpocketjs_symbian_core.a

set -euo pipefail

: "${POCKET_BUILD_ID:?missing POCKET_BUILD_ID}"
: "${POCKETJS_TARGET_ID:?missing POCKETJS_TARGET_ID}"
: "${POCKETJS_HOST_ABI:?missing POCKETJS_HOST_ABI}"
: "${POCKET_RASTER_DENSITY:?missing POCKET_RASTER_DENSITY}"
: "${POCKET_LOGICAL_WIDTH:?missing POCKET_LOGICAL_WIDTH}"
: "${POCKET_LOGICAL_HEIGHT:?missing POCKET_LOGICAL_HEIGHT}"
: "${REPO_ROOT:?missing REPO_ROOT}"
: "${BUILD_DIR:?missing BUILD_DIR}"
: "${LUBAN_OUTPUT_DIR:?missing LUBAN_OUTPUT_DIR}"
: "${LUBAN_GCC_PREFIX:?missing LUBAN_GCC_PREFIX}"
: "${LLD_SHIM_DIR:?missing LLD_SHIM_DIR}"
: "${QUICKJS_VERSION:?missing QUICKJS_VERSION}"
: "${QUICKJS_DIR:?missing QUICKJS_DIR}"
: "${QUICKJS_STATIC_FUNCTIONS:?missing QUICKJS_STATIC_FUNCTIONS}"
: "${RUST_CORE_ARCHIVE:?missing RUST_CORE_ARCHIVE}"

gcc="$LUBAN_OUTPUT_DIR/host/bin/$LUBAN_GCC_PREFIX-gcc"
ar="$LUBAN_OUTPUT_DIR/host/bin/$LUBAN_GCC_PREFIX-ar"
readelf="$LUBAN_OUTPUT_DIR/host/bin/$LUBAN_GCC_PREFIX-readelf"
nm="$LUBAN_OUTPUT_DIR/host/bin/$LUBAN_GCC_PREFIX-nm"

for tool in "$gcc" "$ar" "$readelf" "$nm"; do
  if [[ ! -x "$tool" ]]; then
    echo "d211 build: missing Luban tool $tool" >&2
    exit 1
  fi
done
if [[ ! -e "$LLD_SHIM_DIR/ld.lld" ]]; then
  echo "d211 build: no LLD shim in $LLD_SHIM_DIR" >&2
  exit 1
fi

objects="$BUILD_DIR/objects"
quickjs_objects="$objects/quickjs"
staging="$BUILD_DIR/staging"
mkdir -p "$quickjs_objects" "$staging"

quickjs_flags=(
  -std=gnu11
  -O2
  -fPIC
  -funsigned-char
  -fno-strict-aliasing
  -ffunction-sections
  -fdata-sections
  -D_GNU_SOURCE
  -DCONFIG_VERSION=\""$QUICKJS_VERSION"\"
  -I"$QUICKJS_DIR"
  -Wno-unused-parameter
)

quickjs_object_paths=()
for source in cutils.c dtoa.c libregexp.c libunicode.c quickjs.c; do
  object="$quickjs_objects/${source%.c}.o"
  "$gcc" "${quickjs_flags[@]}" -c "$QUICKJS_DIR/$source" -o "$object"
  quickjs_object_paths+=("$object")
done
static_object="$quickjs_objects/static-functions.o"
"$gcc" "${quickjs_flags[@]}" -c "$QUICKJS_STATIC_FUNCTIONS" -o "$static_object"
quickjs_object_paths+=("$static_object")
"$ar" rcs "$BUILD_DIR/libquickjs.a" "${quickjs_object_paths[@]}"

first_party_flags=(
  -std=gnu11
  -Os
  -fPIE
  -fno-strict-aliasing
  -ffunction-sections
  -fdata-sections
  -Wall
  -Wextra
  -Werror
  -Wno-unused-parameter
)

"$gcc" "${first_party_flags[@]}" \
  -DPOCKETJS_TARGET_ID=\""$POCKETJS_TARGET_ID"\" \
  -DPOCKETJS_HOST_ABI="$POCKETJS_HOST_ABI" \
  -DPOCKET_RASTER_DENSITY="$POCKET_RASTER_DENSITY" \
  -I"$REPO_ROOT/engine/quickjs-c" \
  -I"$REPO_ROOT/engine/ui-cabi/include" \
  -I"$REPO_ROOT/contracts/generated" \
  -I"$QUICKJS_DIR" \
  -c "$REPO_ROOT/engine/quickjs-c/pocket_runtime.c" \
  -o "$objects/pocket_runtime.o"

"$gcc" "${first_party_flags[@]}" \
  -c "$REPO_ROOT/engine/quickjs-c/rust_eh_personality.c" \
  -o "$objects/rust_eh_personality.o"

"$gcc" "${first_party_flags[@]}" \
  -DPOCKET_BUILD_ID=\""$POCKET_BUILD_ID"\" \
  -DPOCKET_RASTER_DENSITY="$POCKET_RASTER_DENSITY" \
  -DPOCKET_LOGICAL_WIDTH="$POCKET_LOGICAL_WIDTH" \
  -DPOCKET_LOGICAL_HEIGHT="$POCKET_LOGICAL_HEIGHT" \
  -I"$REPO_ROOT/engine/quickjs-c" \
  -I"$REPO_ROOT/engine/ui-cabi/include" \
  -I"$REPO_ROOT/hosts/d211-linux" \
  -c "$REPO_ROOT/hosts/d211-linux/main.c" \
  -o "$objects/main.o"

"$gcc" "${first_party_flags[@]}" \
  -I"$REPO_ROOT/hosts/d211-linux" \
  -c "$REPO_ROOT/hosts/d211-linux/input.c" \
  -o "$objects/input.o"

"$gcc" "${first_party_flags[@]}" \
  -I"$REPO_ROOT/hosts/d211-linux" \
  -I"$REPO_ROOT/engine/quickjs-c" \
  -c "$REPO_ROOT/hosts/d211-linux/audio.c" \
  -o "$objects/audio.o"

"$gcc" "${first_party_flags[@]}" \
  -I"$REPO_ROOT/hosts/d211-linux" \
  -I"$REPO_ROOT/engine/quickjs-c" \
  -c "$REPO_ROOT/hosts/d211-linux/backlight.c" \
  -o "$objects/backlight.o"

"$gcc" \
  -B"$LLD_SHIM_DIR" \
  -fuse-ld=lld \
  -pie \
  -Wl,-z,relro \
  -Wl,-z,now \
  -Wl,--gc-sections \
  -Wl,--no-undefined \
  -o "$staging/pocketjs-d211" \
  "$objects/main.o" \
  "$objects/audio.o" \
  "$objects/backlight.o" \
  "$objects/input.o" \
  "$objects/pocket_runtime.o" \
  "$objects/rust_eh_personality.o" \
  "$BUILD_DIR/libquickjs.a" \
  "$RUST_CORE_ARCHIVE" \
  -lm -lpthread

"$readelf" -h -l -A -d "$staging/pocketjs-d211" > "$BUILD_DIR/pocketjs-d211.readelf.txt"
"$nm" -g "$staging/pocketjs-d211" > "$BUILD_DIR/pocketjs-d211.symbols.txt"

ls -l "$staging/pocketjs-d211"
