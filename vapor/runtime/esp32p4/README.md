# Pocket Vapor ESP32-P4 runtime

This runtime targets one exact board: the
Waveshare ESP32-P4-WIFI6-Touch-LCD-7B HW V1.0. It uses the 1024×600
EK79007 MIPI-DSI panel, GT911 touch controller, and 32 MiB flash. Pocket
Vapor renders its 20×18 logical grid and nine hardware-neutral virtual
buttons through LVGL; no JavaScript engine runs on the device.

The reproducible toolchain is ESP-IDF v5.5.4, Waveshare BSP v1.0.4,
EK79007 driver v1.0.4, `esp_lvgl_port` v2.7.2, and LVGL v9.2.2. The
resolved component graph is checked in as [`dependencies.lock`](dependencies.lock).

## Build, flash, and verify

The board-scoped commands and artifacts are separate from the classic ESP32
MeowBit target:

```sh
bun run vapor:esp32p4
# dist/vapor/todo.esp32-waveshare-esp32-p4-wifi6-touch-lcd-7b.bin
# dist/vapor/gen-esp32-waveshare-esp32-p4-wifi6-touch-lcd-7b/

bun run vapor:esp32p4:flash
bun run vapor:esp32p4:verify
```

Both `flash` and the default `verify` write the connected board. Pass an
explicit port when more than one serial device is present. To verify an
already-flashed matching build without writing flash, opt in explicitly:

```sh
bun vapor/scripts/esp32.ts verify \
  --board waveshare-esp32-p4-wifi6-touch-lcd-7b \
  --no-flash \
  --port /dev/cu.usbmodem5B901842141
```

## Make a full backup before the first flash

Do **not** reuse the MeowBit backup command. This board requires
`--chip esp32p4` and a full `0x2000000`-byte (32 MiB) read. A 4 MiB read is
not a complete backup.

First use `chip-id` and `flash-id` to confirm the connected ESP32-P4, MAC,
and 32 MiB flash. Name the backup directory from the lowercase MAC without
colons so images from different boards cannot be confused. The following
macOS example uses the stable 230400-baud read used on the connected board:

```sh
PORT="/dev/cu/..."
DEVICE_KEY="esp32p4-<12-hex-mac>"
BACKUP_DIR="${HOME}/Library/Caches/pocketjs/device-backups/${DEVICE_KEY}"
BACKUP="${BACKUP_DIR}/$(date +%F)-pre-pocket-vapor-full-flash.bin"
BACKUP_NAME="$(basename "$BACKUP")"

uvx --from esptool esptool --chip esp32p4 --port "$PORT" chip-id
uvx --from esptool esptool --chip esp32p4 --port "$PORT" read-mac
uvx --from esptool esptool --chip esp32p4 --port "$PORT" flash-id
mkdir -p "$BACKUP_DIR"
uvx --from esptool esptool --chip esp32p4 --port "$PORT" --baud 230400 \
  read-flash 0x0 0x2000000 "$BACKUP"
test "$(stat -f '%z' "$BACKUP")" = 33554432
(
  cd "$BACKUP_DIR"
  shasum -a 256 "$BACKUP_NAME" > "${BACKUP_NAME}.sha256"
  shasum -a 256 -c "${BACKUP_NAME}.sha256"
)
```

Keep the backup and checksum outside `dist/`, because generated output is
disposable. Do not interrupt the read, accept a short file, or use an image
captured from another board: the full image can contain device-specific
factory state.

For the device connected during the 2026-08-03 bring-up, the pre-flash
evidence is:

- MAC: `e8:f6:0a:e6:cf:2f`
- backup: `/Users/evan/Library/Caches/pocketjs/device-backups/esp32p4-e8f60ae6cf2f/2026-08-03-pre-pocket-vapor-full-flash.bin`
- checksum sidecar: `/Users/evan/Library/Caches/pocketjs/device-backups/esp32p4-e8f60ae6cf2f/2026-08-03-pre-pocket-vapor-full-flash.bin.sha256`
- size: `33,554,432` bytes
- SHA-256: `212d5892d2a973541fc0144845987741e56d3bed733cf8d2f3ba7e4fcc303789`

This is live-machine evidence, not a file stored in this repository.

## Segmented Pocket Vapor flash layout

The generated `.bin` next to `dist/vapor` is the **application-only** image.
It belongs at `0x10000`, never at offset zero. The normal board command uses
ESP-IDF's segmented flash operation:

| image | ESP32-P4 offset |
|---|---:|
| bootloader | `0x2000` |
| partition table | `0x8000` |
| Pocket Vapor app | `0x10000` |

These offsets are recorded in the generated project's
`build/flasher_args.json`. Prefer `bun run vapor:esp32p4:flash` or
`idf.py flash` from that project over a hand-written `write-flash` command.
In particular, the classic ESP32 bootloader offset `0x1000` is wrong for
this ESP32-P4 image.

## Full-image restore is recovery-only

A full restore overwrites the entire boot chain, partition table, factory
state, application, and every other flash region. It is not part of the
normal Pocket Vapor build/flash loop. Do not run `erase-flash` first, and do
not restore a downloaded factory image when the board's own verified backup
is available.

Only after deliberately choosing recovery, reconnect the same board, verify
its MAC, verify the exact 32 MiB file and checksum, and then write that
verified image at offset zero:

```sh
PORT="/dev/cu/..."
BACKUP=/absolute/path/to/this-board-pre-pocket-vapor-full-flash.bin
BACKUP_DIR="$(dirname "$BACKUP")"
BACKUP_NAME="$(basename "$BACKUP")"

test "$(stat -f '%z' "$BACKUP")" = 33554432
(cd "$BACKUP_DIR" && shasum -a 256 -c "${BACKUP_NAME}.sha256")
uvx --from esptool esptool --chip esp32p4 --port "$PORT" chip-id
uvx --from esptool esptool --chip esp32p4 --port "$PORT" read-mac

# Destructive recovery step: only for the same board and verified image.
uvx --from esptool esptool --chip esp32p4 --port "$PORT" --baud 230400 \
  write-flash 0x0 "$BACKUP"
```

Writing and hash verification prove transport and flash contents, not that
the application booted or the screen and touch controls work. Complete
acceptance still requires `PVREADY`, logical-grid replay with zero
tripwires, a visible EK79007 frame, and physical GT911 touch checks.
