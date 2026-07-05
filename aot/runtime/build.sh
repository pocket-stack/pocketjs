#!/usr/bin/env bash
# aot/runtime/build.sh — build the PocketJS-AOT GBA ROM.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

mkdir -p aot/dist

arm-none-eabi-gcc -mcpu=arm7tdmi -marm -ffreestanding -nostdlib -O2 -fno-strict-aliasing \
  -Wall -Wextra -Iaot/runtime -Taot/runtime/gba.ld \
  aot/runtime/crt0.s aot/runtime/cart.c aot/runtime/video.c aot/runtime/bg.c aot/runtime/obj.c \
  aot/runtime/input.c aot/runtime/map.c aot/runtime/player.c aot/runtime/actor.c aot/runtime/camera.c \
  aot/runtime/script_vm.c aot/runtime/textbox.c aot/runtime/debug.c aot/runtime/main.c aot/runtime/gen_cart.c \
  -lgcc -o aot/dist/game.elf

arm-none-eabi-objcopy -O binary aot/dist/game.elf aot/dist/game.gba

echo "built aot/dist/game.gba ($(wc -c < aot/dist/game.gba) bytes)"
