#!/usr/bin/env python3
"""Reset and validate a Symbian Pocket image through its serial receipts."""

from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
from pathlib import Path

import serial


PREFIXES = ("SP_HARDWARE", "SP_INVENTORY", "SP_BOOT", "SP_STATUS", "SP_RUNTIME")


def parse_receipt(line: str) -> tuple[str, dict[str, object]] | None:
    for prefix in PREFIXES:
        marker = prefix + " "
        if line.startswith(marker):
            return prefix, json.loads(line[len(marker) :])
    return None


def reset_target(port: serial.Serial) -> None:
    # Match esptool's normal run reset: IO0 released, EN pulsed low.
    port.dtr = False
    port.rts = True
    time.sleep(0.12)
    port.rts = False
    time.sleep(0.08)
    port.reset_input_buffer()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", default="COM13")
    parser.add_argument("--baud", type=int, default=115200)
    parser.add_argument("--seconds", type=float, default=24.0)
    parser.add_argument(
        "--log",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "build" / "hardware-validation.log",
    )
    parser.add_argument("--no-reset", action="store_true")
    args = parser.parse_args()

    receipts: dict[str, list[dict[str, object]]] = {key: [] for key in PREFIXES}
    transcript: list[str] = []
    fatal: list[str] = []

    with serial.Serial(args.port, args.baud, timeout=0.2, write_timeout=1.0) as port:
        if not args.no_reset:
            reset_target(port)
        deadline = time.monotonic() + args.seconds
        while time.monotonic() < deadline:
            raw = port.readline()
            if not raw:
                continue
            line = raw.decode("utf-8", "replace").rstrip()
            print(line)
            transcript.append(line)
            if "Guru Meditation" in line or "panic'ed" in line:
                fatal.append(line)
            try:
                receipt = parse_receipt(line)
            except json.JSONDecodeError as error:
                fatal.append(f"invalid receipt JSON: {error}: {line}")
                continue
            if receipt:
                prefix, payload = receipt
                receipts[prefix].append(payload)

    args.log.parent.mkdir(parents=True, exist_ok=True)
    args.log.write_text("\n".join(transcript) + "\n", encoding="utf-8")

    hardware = receipts["SP_HARDWARE"][-1] if receipts["SP_HARDWARE"] else {}
    inventory = receipts["SP_INVENTORY"][-1] if receipts["SP_INVENTORY"] else {}
    boot = receipts["SP_BOOT"][-1] if receipts["SP_BOOT"] else {}
    statuses = receipts["SP_STATUS"]

    checks = {
        "no panic/reset loop": not fatal,
        "runtime ready": boot.get("ready") is True,
        "actual QuickJS": boot.get("quickjs") is True,
        "actual PocketJS Core": boot.get("pocketjsCore") is True,
        "display profile 160x128 rotation 3": (
            boot.get("width") == 160
            and boot.get("height") == 128
            and boot.get("rotation") == 3
        ),
        "4 MiB flash": hardware.get("flashBytes") == 4 * 1024 * 1024,
        "PSRAM detected": int(hardware.get("psramBytes", 0)) >= 3_900_000,
        "controller 0x40 detected": inventory.get("controller40") is True,
        "safe boot outputs off": inventory.get("outputsOff") is True,
        "two status windows": len(statuses) >= 2,
        "outputs stay locked": bool(statuses) and all(
            item.get("outputsUnlocked") is False for item in statuses
        ),
        "QuickJS peak within limit": bool(statuses) and max(
            int(item.get("qjsPeak", 0)) for item in statuses
        ) <= 1_600_000,
    }
    if statuses:
        checks["fixed-step cadence >= 50 fps"] = (
            statistics.median(float(item.get("fps", 0.0)) for item in statuses) >= 50.0
        )
    else:
        checks["fixed-step cadence >= 50 fps"] = False
    if receipts["SP_RUNTIME"]:
        checks["no frame errors"] = not any(
            int(item.get("frameError", 0)) < 0 for item in receipts["SP_RUNTIME"]
        )

    print("\nValidation:")
    for name, passed in checks.items():
        print(f"  {'PASS' if passed else 'FAIL'}  {name}")
    print(
        "  INFO  inventory: "
        f"imu={inventory.get('imu68', 'unknown')} "
        f"sd={inventory.get('sdMounted', 'unknown')}"
    )
    print(f"  INFO  transcript: {args.log}")
    return 0 if all(checks.values()) else 1


if __name__ == "__main__":
    sys.exit(main())
