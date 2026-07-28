from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import serial


def read_stage(port: serial.Serial, stage: int, deadline: float) -> dict:
    while time.monotonic() < deadline:
        raw = port.readline()
        if not raw:
            continue
        text = raw.decode("utf-8", errors="replace").strip()
        print(text)
        if not text.startswith("SP_PROBE "):
            continue
        payload = json.loads(text[len("SP_PROBE ") :])
        if payload.get("stage") == stage:
            return payload
    raise TimeoutError(f"probe stage {stage} was not observed")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", default="COM13")
    parser.add_argument("--out", default="build/probe-result.json")
    args = parser.parse_args()

    with serial.Serial(args.port, 115200, timeout=0.25) as port:
        port.dtr = False
        port.rts = False
        time.sleep(0.3)
        stage1 = read_stage(port, 1, time.monotonic() + 12)
        # The probe still finishes its LCD setup after emitting stage 1.
        time.sleep(0.5)
        port.write(b"ACTIVE\n")
        port.flush()
        stage2 = read_stage(port, 2, time.monotonic() + 8)

    checks = {
        "controller40": stage1.get("controller40") is True,
        "imu68": stage1.get("imu68") is True,
        "mpu6050": stage1.get("whoAmI") in (0x68, 0x69),
        "psram4MiB": 3_500_000 <= stage1.get("psramBytes", 0) <= 4_500_000,
        "sdReadWrite": stage1.get("sdMounted") is True and stage1.get("sdWritable") is True,
        "safeActive": stage2.get("buzzer") is True
        and stage2.get("motorsTouched") is False
        and stage2.get("outputsOff") is True,
    }
    result = {"stage1": stage1, "stage2": stage2, "checks": checks, "passed": all(checks.values())}
    output = Path(args.out)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["passed"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
