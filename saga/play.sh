#!/usr/bin/env bash
# saga/play.sh — build REALITY DISTORTION and open it in mGBA.
#   bash saga/play.sh [game.ts]
set -euo pipefail
cd "$(dirname "$0")"
GAME="${1:-game/reality-distortion.ts}"
OUT="dist/$(basename "${GAME%.*}").gba"
bun compiler/cli.ts build "$GAME" --out "$OUT" --title REALDISTORT
MGBA_APP="$(brew --prefix mgba 2>/dev/null)/mGBA.app"
if [ -d "$MGBA_APP" ]; then
  open -n "$MGBA_APP" --args "$PWD/$OUT"
else
  mgba "$OUT"
fi
