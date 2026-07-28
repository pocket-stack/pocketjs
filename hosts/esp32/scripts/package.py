#!/usr/bin/env python3
"""Create reproducible serial-flash artifacts and their SHA-256 manifest."""

from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path


VERSION = "0.1.0"
FLASH_BYTES = 4 * 1024 * 1024

HERE = Path(__file__).resolve().parent
HOST = HERE.parent
BUILD = HOST / ".pio" / "build" / "symbian_pocket"
DIST = HOST / "dist"
PLATFORMIO = Path.home() / ".platformio"
FRAMEWORK = PLATFORMIO / "packages" / "framework-arduinoespressif32"
ESPTOOL = PLATFORMIO / "packages" / "tool-esptoolpy" / "esptool.py"
ESPTOOL_PYTHON = PLATFORMIO / "penv" / "Scripts" / "python.exe"


def digest(path: Path) -> str:
    checksum = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            checksum.update(chunk)
    return checksum.hexdigest().upper()


def main() -> int:
    required = {
        "bootloader": BUILD / "bootloader.bin",
        "partitions": BUILD / "partitions.bin",
        "application": BUILD / "firmware.bin",
        "elf": BUILD / "firmware.elf",
        "boot_app0": FRAMEWORK / "tools" / "partitions" / "boot_app0.bin",
    }
    missing = [str(path) for path in required.values() if not path.exists()]
    if missing:
        raise SystemExit("Build artifacts missing:\n" + "\n".join(missing))
    if not ESPTOOL.exists():
        raise SystemExit(f"esptool is missing: {ESPTOOL}")

    DIST.mkdir(parents=True, exist_ok=True)
    names = {
        "bootloader": DIST / "bootloader.bin",
        "partitions": DIST / "partitions.bin",
        "application": DIST / f"symbian-pocket-{VERSION}-app.bin",
        "elf": DIST / f"symbian-pocket-{VERSION}.elf",
    }
    for key, destination in names.items():
        shutil.copy2(required[key], destination)

    merged = DIST / f"symbian-pocket-{VERSION}-full-4mb.bin"
    python = ESPTOOL_PYTHON if ESPTOOL_PYTHON.exists() else Path(sys.executable)
    subprocess.run(
        [
            str(python),
            str(ESPTOOL),
            "--chip",
            "esp32",
            "merge_bin",
            "-o",
            str(merged),
            "--flash_mode",
            "dio",
            "--flash_freq",
            "40m",
            "--flash_size",
            "4MB",
            "0x1000",
            str(required["bootloader"]),
            "0x8000",
            str(required["partitions"]),
            "0xe000",
            str(required["boot_app0"]),
            "0x10000",
            str(required["application"]),
        ],
        check=True,
    )
    size = merged.stat().st_size
    if size > FLASH_BYTES:
        raise SystemExit(f"Merged image exceeds 4 MiB: {size}")
    if size < FLASH_BYTES:
        with merged.open("ab") as stream:
            stream.write(b"\xff" * (FLASH_BYTES - size))

    validation = HOST / "build" / "hardware-validation.log"
    artifacts = [*names.values(), merged]
    if validation.exists():
        copied_validation = DIST / validation.name
        shutil.copy2(validation, copied_validation)
        artifacts.append(copied_validation)

    manifest = {
        "firmware": "Symbian Pocket",
        "version": VERSION,
        "target": "ESP32-WROVER-B / ESP32-D0WD rev1",
        "flashBytes": FLASH_BYTES,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "transport": "serial-only",
        "portUsed": "COM13",
        "layout": {
            "bootloader": "0x1000",
            "partitions": "0x8000",
            "bootApp0": "0xE000",
            "application": "0x10000",
        },
        "backup": {
            "path": r"D:\ESP32\XuErSi\backups\before_symbian_pocket_probe_20260727_234359_4mb.bin",
            "sha256": "36AD56830B0D386EE03F192F979C92FA7D909A265FD7D0022937D0F45F74B039",
        },
        "artifacts": [
            {
                "file": path.name,
                "bytes": path.stat().st_size,
                "sha256": digest(path),
            }
            for path in artifacts
        ],
    }
    manifest_path = DIST / "manifest.json"
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(manifest_path)
    for item in manifest["artifacts"]:
        print(f"{item['sha256']}  {item['file']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
