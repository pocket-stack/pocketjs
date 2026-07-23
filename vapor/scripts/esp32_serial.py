#!/usr/bin/env python3
"""Raw line bridge between stdin/stdout and an ESP32 UART.

The MeowBit's GD32 USB bridge uses modem-control lines for reset/download.
pyserial lets us explicitly release DTR/RTS after opening the port; generic
file-descriptor opens can otherwise leave the ESP32 held during boot.
"""

from __future__ import annotations

import os
import select
import sys

import serial


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: esp32_serial.py <port> <baud>", file=sys.stderr)
        return 2

    port, baud_text = sys.argv[1:]
    uart = serial.Serial(
        port,
        int(baud_text),
        timeout=0,
        write_timeout=1,
        dsrdtr=False,
        rtscts=False,
    )
    uart.dtr = False
    uart.rts = False
    pending = b""

    try:
        while True:
            readable, _, _ = select.select([sys.stdin.fileno(), uart.fileno()], [], [], 0.02)
            if sys.stdin.fileno() in readable:
                data = os.read(sys.stdin.fileno(), 4096)
                if not data:
                    return 0
                uart.write(data)
                uart.flush()
            if uart.fileno() in readable:
                data = uart.read(max(1, uart.in_waiting))
                if not data:
                    continue
                pending += data
                while b"\n" in pending:
                    raw, pending = pending.split(b"\n", 1)
                    line = raw.rstrip(b"\r").decode("utf-8", "replace")
                    print(line, flush=True)
    finally:
        uart.close()


if __name__ == "__main__":
    raise SystemExit(main())
