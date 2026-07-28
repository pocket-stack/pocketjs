#!/usr/bin/env python3
"""Capture the ESP32 host's logical RGB565 framebuffer over its debug UART."""

from __future__ import annotations

import argparse
import json
import struct
import time
import zlib
from pathlib import Path

import serial


KEY_MASKS = {
    "u": 0x0010,
    "r": 0x0020,
    "d": 0x0040,
    "l": 0x0080,
    "a": 0x4000,
    "b": 0x2000,
    "q": 0x0008,
    "e": 0x0001,
}


def read_exact(port: serial.Serial, size: int, timeout: float = 12.0) -> bytes:
    deadline = time.monotonic() + timeout
    data = bytearray()
    while len(data) < size and time.monotonic() < deadline:
        chunk = port.read(size - len(data))
        if chunk:
            data.extend(chunk)
    if len(data) != size:
        raise RuntimeError(f"frame truncated: expected {size} bytes, received {len(data)}")
    return bytes(data)


def png_chunk(kind: bytes, payload: bytes) -> bytes:
    body = kind + payload
    return struct.pack(">I", len(payload)) + body + struct.pack(">I", zlib.crc32(body))


def write_rgb565_png(path: Path, width: int, height: int, pixels: bytes) -> None:
    rows = bytearray()
    for y in range(height):
        rows.append(0)
        for x in range(width):
            offset = (y * width + x) * 2
            value = pixels[offset] | pixels[offset + 1] << 8
            red = ((value >> 11) & 0x1F) * 255 // 31
            green = ((value >> 5) & 0x3F) * 255 // 63
            blue = (value & 0x1F) * 255 // 31
            rows.extend((red, green, blue))
    payload = (
        b"\x89PNG\r\n\x1a\n"
        + png_chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + png_chunk(b"IDAT", zlib.compress(bytes(rows), 9))
        + png_chunk(b"IEND", b"")
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(payload)


def wait_for_line(
    port: serial.Serial,
    predicate,
    timeout: float,
) -> bytes | None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        line = port.readline()
        if line and predicate(line):
            return line
    return None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", default="COM13")
    parser.add_argument("--output", type=Path, default=Path("hosts/esp32/build/device-frame.png"))
    parser.add_argument(
        "--keys",
        default="",
        help="comma-separated UART key injections: u,d,l,r,a,b,q,e",
    )
    parser.add_argument("--boot-wait", type=float, default=9.0)
    args = parser.parse_args()

    with serial.Serial(args.port, 115200, timeout=0.35, write_timeout=2) as port:
        # Match esptool's run reset: release IO0, pulse EN low, then wait for
        # QuickJS/PocketJS to finish mounting.
        port.dtr = False
        port.rts = True
        port.dtr = port.dtr  # Force a Windows usbser control-line update.
        time.sleep(0.12)
        port.rts = False
        port.dtr = port.dtr
        time.sleep(0.08)
        port.reset_input_buffer()
        time.sleep(args.boot_wait)
        port.reset_input_buffer()

        # A short console handshake makes the first post-reset command
        # deterministic on Windows USB serial adapters, where the first byte
        # after a control-line transition can otherwise be lost.
        ready = None
        for _ in range(8):
            port.write(b"S")
            port.flush()
            ready = wait_for_line(port, lambda line: line.startswith(b"SP_CONSOLE "), 1.0)
            if ready is not None:
                break
        if ready is None:
            raise RuntimeError("device console did not become ready")

        for key in (item.strip().lower() for item in args.keys.split(",")):
            if not key:
                continue
            if key not in KEY_MASKS:
                raise SystemExit(f"unsupported key: {key}")
            port.write(key.encode("ascii"))
            port.flush()
            expected = KEY_MASKS[key]
            receipt = wait_for_line(
                port,
                lambda line: (
                    line.startswith(b"SP_INPUT ")
                    and b'"source":"serial"' in line
                    and int(json.loads(line.removeprefix(b"SP_INPUT ").decode("ascii"))["mask"]) & expected
                    == expected
                ),
                2.5,
            )
            if receipt is None:
                raise RuntimeError(f"device did not acknowledge injected key: {key}")
            time.sleep(0.2)
        port.write(b"P")
        port.flush()

        metadata: dict[str, int] | None = None
        line = wait_for_line(port, lambda item: item.startswith(b"SP_FRAME_BEGIN "), 10.0)
        if line is not None:
            metadata = json.loads(line.removeprefix(b"SP_FRAME_BEGIN ").decode("ascii"))
        if metadata is None:
            raise RuntimeError("device did not emit SP_FRAME_BEGIN")

        width = int(metadata["width"])
        height = int(metadata["height"])
        size = int(metadata["bytes"])
        if size != width * height * 2:
            raise RuntimeError(f"unexpected RGB565 size: {metadata}")
        pixels = read_exact(port, size)
        trailer = port.readline() + port.readline()
        if b"SP_FRAME_END" not in trailer:
            raise RuntimeError("missing SP_FRAME_END")

    output = args.output.resolve()
    write_rgb565_png(output, width, height, pixels)
    print(json.dumps({"output": str(output), "width": width, "height": height, "bytes": size}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
