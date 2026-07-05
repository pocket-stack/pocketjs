#!/usr/bin/env bash
#
# Build the headless mGBA test runner (mgba_runner) against the installed
# libmgba. Requires mGBA to be installed via Homebrew:  brew install mgba
#
set -euo pipefail

# Resolve this script's directory so the build works from anywhere.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Locate the mGBA install prefix (Homebrew), with a sane fallback.
if command -v brew >/dev/null 2>&1; then
	MGBA="$(brew --prefix mgba)"
else
	MGBA="/opt/homebrew/Cellar/mgba/0.10.5_2"
fi

if [ ! -f "$MGBA/include/mgba/gba/core.h" ]; then
	echo "error: libmgba headers not found under $MGBA/include" >&2
	echo "       install mGBA first:  brew install mgba" >&2
	exit 1
fi

echo "Using libmgba prefix: $MGBA"

clang -O2 -Wall -Wextra \
	-o "$HERE/mgba_runner" \
	"$HERE/mgba_runner.c" \
	-I"$MGBA/include" \
	-L"$MGBA/lib" -lmgba \
	-Wl,-rpath,"$MGBA/lib"

echo "Built: $HERE/mgba_runner"
