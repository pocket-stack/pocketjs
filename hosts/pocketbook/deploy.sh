#!/usr/bin/env bash
# Deploy the PocketBook host + a demo app to a device mounted over USB.
#
# Usage:
#   hosts/pocketbook/deploy.sh [MOUNT_POINT] [APP_NAME]
#
#   MOUNT_POINT  device mount root (default: auto-detect the first PocketBook
#                under /run/media/$USER, /media/$USER, or /Volumes on macOS)
#   APP_NAME     launcher folder name (default: pocketjs-hero)
#
# Prereqs (run from the repo root):
#   # 1. cross-compile the host
#   (cd hosts/pocketbook && cargo zigbuild --release --target armv7-unknown-linux-gnueabi.2.23)
#   # 2. build the app bundle for the pocketbook target
#   bun pocket compile --target pocketbook --manifest apps/hero/pocket.json --project-root .
#
# The host reads app.js + app.pak from its working directory (override with
# POCKET_JS / POCKET_PAK), so we install them next to the binary.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOST_BIN="$ROOT/hosts/pocketbook/target/armv7-unknown-linux-gnueabi/release/pocketbook-host"
BUNDLE_JS="$ROOT/dist/hero-main.js"
BUNDLE_PAK="$ROOT/dist/hero-main.pak"

APP_NAME="${2:-pocketjs-hero}"

# --- locate the device mount point -----------------------------------------
detect_mount() {
  local bases=("/run/media/${USER:-$USER}" "/media/${USER:-$USER}" "/Volumes")
  for base in "${bases[@]}"; do
    [ -d "$base" ] || continue
    # A PocketBook exposes an `applications/` dir at its storage root.
    for cand in "$base"/*; do
      [ -d "$cand/applications" ] && { echo "$cand"; return; }
    done
  done
  return 1
}

MOUNT="${1:-}"
if [ -z "$MOUNT" ]; then
  MOUNT="$(detect_mount || true)"
fi
if [ -z "$MOUNT" ] || [ ! -d "$MOUNT" ]; then
  echo "error: no device mount point found. Pass it explicitly:" >&2
  echo "  $0 /run/media/\$USER/PB626" >&2
  exit 1
fi

# --- sanity-check artifacts -------------------------------------------------
[ -f "$HOST_BIN" ] || { echo "error: host binary missing — run cargo zigbuild first ($HOST_BIN)" >&2; exit 1; }
[ -f "$BUNDLE_JS" ] || { echo "error: $BUNDLE_JS missing — run 'bun pocket compile --target pocketbook …' first" >&2; exit 1; }
[ -f "$BUNDLE_PAK" ] || { echo "error: $BUNDLE_PAK missing — run 'bun pocket compile --target pocketbook …' first" >&2; exit 1; }

DEST="$MOUNT/applications/$APP_NAME"
echo "==> deploying to $DEST"
mkdir -p "$DEST"

cp "$HOST_BIN" "$DEST/$APP_NAME"
cp "$BUNDLE_JS" "$DEST/app.js"
cp "$BUNDLE_PAK" "$DEST/app.pak"
chmod +x "$DEST/$APP_NAME"

echo "==> done. Eject safely, then launch '$APP_NAME' from the PocketBook launcher."
echo "    (If it doesn't appear, the firmware may need a rescan/restart.)"
