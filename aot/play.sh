#!/usr/bin/env bash
# aot/play.sh — build the demo ROM from TSX and open it in the mGBA window so
# you can play it yourself with the keyboard.
#
#   bash aot/play.sh                 # build + launch the town demo
#   bash aot/play.sh path/to/game.tsx   # build + launch a different game
#
# Controls (mGBA defaults):
#   Arrow keys .... walk
#   X ............. A  (talk / confirm / advance text / pick menu item)
#   Z ............. B  (cancel)
#   Enter ......... Start        Backspace ... Select
set -euo pipefail

cd "$(cd "$(dirname "$0")/.." && pwd)" # repo root
ENTRY="${1:-aot/demo/game.tsx}"
ROM="$PWD/aot/dist/pocket-town.gba"

echo "▸ Compiling $ENTRY → $ROM"
bun aot/compiler/cli.ts build "$ENTRY" --out "$ROM"

APP="$(brew --prefix mgba 2>/dev/null)/mGBA.app"
echo "▸ Launching mGBA — arrows to walk, X = A (talk/confirm), Z = B, Enter = Start"
if [ -d "$APP" ]; then
  open -n "$APP" --args "$ROM"
else
  mgba "$ROM" # fall back to the CLI binary if the .app isn't where we expect
fi
