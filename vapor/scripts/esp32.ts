#!/usr/bin/env bun
// Build, flash, and verify Pocket Vapor on a USB-connected ESP32 MeowBit.
//
//   bun vapor/scripts/esp32.ts flash [--port /dev/cu.usbmodem...] [--board meowbit]
//   bun vapor/scripts/esp32.ts verify [--port ...] [--no-flash] [--board meowbit]
//
// `verify` is the physical-device equivalent of parity.test.ts: it boots the
// real Vue Vapor oracle, replays the shared TodoMVC tape through the native
// firmware, and compares both 20x18 logical grids after every press.

import {
  existsSync,
  readdirSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { compileVaporApp, VAPOR_TARGETS } from "../compiler/compile.ts";
import { loadBoard } from "../compiler/boards.ts";
import {
  buildEsp32Firmware,
  DEFAULT_BOARD,
  esp32BuildId,
  resolveEspIdfEnvironment,
  runEspIdf,
  type Esp32BuildResult,
} from "../compiler/esp32.ts";
import { bootOracle } from "../oracle/boot.ts";
import type { CellGrid } from "../oracle/paint.ts";
import { TODO_TAPE } from "../tests/todo-tape.ts";

const ROOT = resolve(import.meta.dir, "..", "..");
const ENTRY = join(ROOT, "vapor", "examples", "todo", "todo.tsx");
const OUT = join(ROOT, "dist", "vapor");
const FIRMWARE = join(OUT, "todo.esp32.bin");
const RECEIPT = join(OUT, "esp32-device-receipt.json");
const TARGET = VAPOR_TARGETS.esp32;
const BAUD = 115200;
const CELLS = TARGET.width * TARGET.height;
const BOARD = loadBoard(option("--board") ?? DEFAULT_BOARD);

interface GridReceipt {
  header: string;
  chars: string[];
  pals: number[][];
  trips: number;
  frame: number;
  flush: number;
  commit: number;
}

function option(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

function autoPort(): string {
  const explicit = option("--port");
  if (explicit) return resolve(explicit);
  const ports = readdirSync("/dev")
    .filter((name) => /^cu\.(usbmodem|usbserial)/.test(name))
    .map((name) => join("/dev", name));
  if (ports.length !== 1) {
    throw new Error(
      ports.length === 0
        ? "no USB serial device found; pass --port /dev/cu.usbmodem..."
        : `multiple USB serial devices found; pass --port explicitly:\n${ports.join("\n")}`,
    );
  }
  return ports[0];
}

async function waitForPort(port: string, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(port)) return;
    await Bun.sleep(100);
  }
  throw new Error(`serial port did not reappear after flashing: ${port}`);
}

class SerialLines {
  private pending = "";
  private lines: string[] = [];
  private recent: string[] = [];
  private readonly decoder = new TextDecoder();
  private readError: unknown;
  private closing = false;
  private readonly child: Bun.PipedSubprocess;

  static async open(port: string): Promise<SerialLines> {
    const { idfToolsPath } = resolveEspIdfEnvironment();
    const pythonRoot = join(idfToolsPath, "python_env");
    const envs = readdirSync(pythonRoot)
      .filter((name) => /^idf.+_env$/.test(name))
      .sort()
      .reverse();
    const python = envs
      .map((name) => join(pythonRoot, name, "bin", "python"))
      .find((candidate) => existsSync(candidate));
    if (!python) throw new Error(`ESP-IDF Python environment not found under ${pythonRoot}`);
    const serial = new SerialLines(
      Bun.spawn(
        [
          python,
          "-u",
          join(import.meta.dir, "esp32_serial.py"),
          port,
          String(BAUD),
        ],
        { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
      ),
    );
    serial.readOutput();
    serial.watchExit();
    return serial;
  }

  private constructor(child: Bun.PipedSubprocess) {
    this.child = child;
  }

  close(): void {
    this.closing = true;
    this.child.stdin.end();
    this.child.kill();
  }

  clear(): void {
    this.lines.length = 0;
    this.pending = "";
  }

  send(command: string): void {
    this.child.stdin.write(`${command}\n`);
    this.child.stdin.flush();
  }

  private async readOutput(): Promise<void> {
    const reader = this.child.stdout.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        this.pending += this.decoder.decode(value, { stream: true });
        for (;;) {
          const newline = this.pending.indexOf("\n");
          if (newline < 0) break;
          const line = this.pending.slice(0, newline).replace(/\r$/, "");
          this.pending = this.pending.slice(newline + 1);
          this.lines.push(line);
          this.recent.push(line);
          if (this.recent.length > 20) this.recent.shift();
        }
      }
    } catch (error) {
      this.readError = error;
    } finally {
      try {
        reader.releaseLock();
      } catch {}
    }
  }

  private async watchExit(): Promise<void> {
    const [exitCode, stderr] = await Promise.all([
      this.child.exited,
      new Response(this.child.stderr).text(),
    ]);
    if (!this.closing) {
      this.readError = new Error(
        `ESP32 serial bridge exited (${exitCode})${stderr.trim() ? `:\n${stderr.trim()}` : ""}`,
      );
    }
  }

  async waitFor(prefix: string, timeoutMs = 5000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.readError) throw this.readError;
      const lineAt = this.lines.findIndex((line) => line.includes(prefix));
      if (lineAt >= 0) {
        const line = this.lines.splice(lineAt, 1)[0];
        return line.slice(line.indexOf(prefix));
      }
      await Bun.sleep(10);
    }
    throw new Error(
      `timed out waiting for ${prefix}; recent serial output:\n${this.recent.slice(-12).join("\n")}`,
    );
  }
}

function fields(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of line.split(/\s+/).slice(1)) {
    const equal = part.indexOf("=");
    if (equal > 0) out[part.slice(0, equal)] = part.slice(equal + 1);
  }
  return out;
}

function requireNumber(values: Record<string, string>, key: string): number {
  const value = Number(values[key]);
  if (!Number.isFinite(value)) throw new Error(`missing numeric ${key}: ${JSON.stringify(values)}`);
  return value;
}

function decodeChars(hex: string): string[] {
  if (!new RegExp(`^[0-9a-fA-F]{${CELLS * 2}}$`).test(hex)) {
    throw new Error(`invalid PVCH payload: expected ${CELLS * 2} hex digits, got ${hex.length}`);
  }
  const bytes = Buffer.from(hex, "hex");
  return Array.from({ length: TARGET.height }, (_, y) =>
    bytes.subarray(y * TARGET.width, (y + 1) * TARGET.width).toString("latin1"),
  );
}

function decodePals(hex: string): number[][] {
  if (!new RegExp(`^[0-9a-fA-F]{${CELLS * 2}}$`).test(hex)) {
    throw new Error(`invalid PVPA payload: expected ${CELLS * 2} hex digits, got ${hex.length}`);
  }
  const bytes = Buffer.from(hex, "hex");
  return Array.from({ length: TARGET.height }, (_, y) =>
    Array.from(bytes.subarray(y * TARGET.width, (y + 1) * TARGET.width)),
  );
}

async function readGrid(serial: SerialLines): Promise<GridReceipt> {
  serial.clear();
  serial.send("D");
  const header = await serial.waitFor("PVGRID ");
  const charsLine = await serial.waitFor("PVCH ");
  const palsLine = await serial.waitFor("PVPA ");
  await serial.waitFor("PVEND");
  const meta = fields(header);
  return {
    header,
    chars: decodeChars(charsLine.slice("PVCH ".length)),
    pals: decodePals(palsLine.slice("PVPA ".length)),
    trips: requireNumber(meta, "trips"),
    frame: requireNumber(meta, "frame"),
    flush: requireNumber(meta, "flush"),
    commit: requireNumber(meta, "commit"),
  };
}

function compareGrid(
  step: number,
  device: GridReceipt,
  oracle: CellGrid,
): void {
  if (device.trips !== 0) throw new Error(`step ${step}: runtime tripwires=${device.trips}`);
  for (let y = 0; y < TARGET.height; y++) {
    if (device.chars[y] !== oracle.chars[y]) {
      throw new Error(
        `step ${step}, row ${y} character mismatch:\ndevice ${JSON.stringify(device.chars[y])}\noracle ${JSON.stringify(oracle.chars[y])}`,
      );
    }
    const gotPals = device.pals[y].join(",");
    const wantPals = oracle.pals[y].join(",");
    if (gotPals !== wantPals) {
      throw new Error(`step ${step}, row ${y} palette mismatch:\ndevice ${gotPals}\noracle ${wantPals}`);
    }
  }
}

async function build(): Promise<{
  app: ReturnType<typeof compileVaporApp>;
  firmware: Esp32BuildResult;
}> {
  const source = await Bun.file(ENTRY).text();
  const app = compileVaporApp(ENTRY, source, "VAPOR TODO", "esp32");
  const firmware = await buildEsp32Firmware(app, FIRMWARE, BOARD);
  return { app, firmware };
}

async function flash(buildResult: Esp32BuildResult, port: string): Promise<void> {
  console.log(`\nflashing ${basename(FIRMWARE)} to ${port} at ${BAUD} baud...`);
  await runEspIdf([
    "-C",
    buildResult.projectDir,
    "-B",
    buildResult.buildDir,
    "-p",
    port,
    "-b",
    String(BAUD),
    "flash",
  ]);
  await waitForPort(port);
}

async function verify(
  port: string,
  app: ReturnType<typeof compileVaporApp>,
  expectedBuildId: string,
): Promise<void> {
  const serial = await SerialLines.open(port);
  const oracle = await bootOracle({
    width: TARGET.width,
    height: TARGET.height,
    styles: app.styles,
  });
  const receipts: GridReceipt[] = [];
  let ready = "";
  try {
    /* Some USB bridges reset on open and some do not. Repeated idempotent H
     * requests both tolerate a booting UART and probe an already-running
     * board; a spontaneous boot receipt is accepted by the same wait. */
    let handshakeError: unknown;
    for (let attempt = 0; attempt < 20; attempt++) {
      serial.clear();
      serial.send("H");
      try {
        ready = await serial.waitFor("PVREADY ", 600);
        handshakeError = undefined;
        break;
      } catch (error) {
        handshakeError = error;
      }
    }
    if (handshakeError) throw handshakeError;
    const identity = fields(ready);
    const expected = {
      board: BOARD.board,
      chip: BOARD.chip,
      grid: `${TARGET.width}x${TARGET.height}`,
      lcd: "1",
      panel: `${BOARD.lcd.width}x${BOARD.lcd.height}`,
      cell: `${BOARD.lcd.cell[0]}x${BOARD.lcd.cell[1]}`,
      build: expectedBuildId,
    };
    for (const [key, value] of Object.entries(expected)) {
      if (identity[key] !== value) {
        throw new Error(`unexpected firmware receipt ${key}=${identity[key]}; expected ${value}\n${ready}`);
      }
    }

    let resetReady = false;
    for (let attempt = 0; attempt < 3 && !resetReady; attempt++) {
      serial.clear();
      serial.send("R");
      try {
        await serial.waitFor("PVREADY ", 1000);
        resetReady = true;
      } catch {}
    }
    if (!resetReady) throw new Error("device did not acknowledge the in-process reset");

    let receipt = await readGrid(serial);
    if (receipt.commit < 1) throw new Error(`LCD runtime did not commit its boot frame: ${receipt.header}`);
    compareGrid(0, receipt, oracle.grid());
    receipts.push(receipt);

    for (let i = 0; i < TODO_TAPE.length; i++) {
      const button = TODO_TAPE[i];
      serial.clear();
      serial.send(`P ${button}`);
      const ack = await serial.waitFor(`PVACK button=${button} `);
      if (requireNumber(fields(ack), "trips") !== 0) {
        throw new Error(`step ${i + 1}: runtime tripwire in ${ack}`);
      }
      await oracle.press(button);
      receipt = await readGrid(serial);
      compareGrid(i + 1, receipt, oracle.grid());
      receipts.push(receipt);
      process.stdout.write(`\rdevice parity ${String(i + 1).padStart(2)}/${TODO_TAPE.length}`);
    }
    process.stdout.write("\n");
  } finally {
    oracle.unmount();
    serial.close();
  }

  const firmwareFile = Bun.file(FIRMWARE);
  const firmwareBytes = (await firmwareFile.exists()) ? await firmwareFile.arrayBuffer() : undefined;
  const localFirmwareSha256 = firmwareBytes
    ? new Bun.CryptoHasher("sha256").update(firmwareBytes).digest("hex")
    : undefined;
  await Bun.write(
    RECEIPT,
    JSON.stringify(
      {
        verifiedAt: new Date().toISOString(),
        port,
        baud: BAUD,
        board: BOARD.board,
        buildId: expectedBuildId,
        firmware: FIRMWARE,
        localFirmwareBytes: firmwareBytes?.byteLength,
        localFirmwareSha256,
        ready,
        interactionPresses: TODO_TAPE.length,
        gridReceipts: receipts.length,
        cellsComparedPerReceipt: CELLS,
        characterAndPaletteCellsCompared: receipts.length * CELLS * 2,
        final: receipts.at(-1),
      },
      null,
      2,
    ),
  );
  console.log(`physical ESP32 logical-grid parity passed; receipt: ${RECEIPT}`);
}

const command = process.argv[2] ?? "verify";
if (command !== "flash" && command !== "verify") {
  console.error(
    "usage: bun vapor/scripts/esp32.ts flash|verify [--port /dev/cu.usbmodem...] [--no-flash] [--board meowbit]",
  );
  process.exit(2);
}

const port = autoPort();
const source = await Bun.file(ENTRY).text();
let app = compileVaporApp(ENTRY, source, "VAPOR TODO", "esp32");
let firmware: Esp32BuildResult | undefined;
if (command === "flash" || !process.argv.includes("--no-flash")) {
  ({ app, firmware } = await build());
  await flash(firmware, port);
}
if (command === "verify") {
  const expectedBuildId = firmware?.buildId ?? await esp32BuildId(app, BOARD);
  await verify(port, app, expectedBuildId);
}
