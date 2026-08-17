import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  POCKET_MUSIC_SERVICE,
  connectPocketMusic,
  parsePocketMusicBatch,
  parsePocketMusicState,
} from "../apps/pocket-music/service.ts";
import { parseIPodFilesystem, parseIPodNanoUSB } from "../tools/pocket-music.ts";
import { parseBmpFacts } from "../tools/ipodnano-rockbox.ts";

const state = {
  t: "pocket-music.state",
  daemonConnected: true,
  deviceConnected: true,
  playerRunning: true,
  playing: true,
  positionMs: 42_000,
  volume: 48,
  sequence: 7,
  track: {
    id: "window-seat",
    title: "Window Seat",
    artist: "Pocket Music",
    album: "Hardware Sessions",
    durationMs: 240_000,
  },
} as const;

describe("Pocket Music guest protocol", () => {
  test("accepts complete daemon state and rejects malformed values", () => {
    const parsed = parsePocketMusicState(JSON.stringify(state));
    expect(parsed?.daemonConnected).toBe(true);
    expect(parsed?.sequence).toBe(7);
    expect(parsed?.track?.title).toBe("Window Seat");
    expect(parsePocketMusicState(JSON.stringify({ ...state, volume: 101 }))).toBeNull();
    expect(parsePocketMusicState(JSON.stringify({ ...state, deviceConnected: "yes" }))).toBeNull();
    expect(parsePocketMusicState('{"t":"pocket-music.input"}')).toBeNull();
  });

  test("retains only valid state lines from a daemon batch", () => {
    expect(
      parsePocketMusicBatch([JSON.stringify(state), "not json", '{"t":"future"}'].join("\n")),
    ).toHaveLength(1);
  });

  test("opens only its authored channel and serializes bounded commands", () => {
    const opened: string[] = [];
    const sent: string[] = [];
    const service = connectPocketMusic({
      svcOpen(channel) {
        opened.push(channel);
        return channel === POCKET_MUSIC_SERVICE;
      },
      svcPoll() {
        return `${JSON.stringify(state)}\n`;
      },
      svcSend(line) {
        sent.push(line);
      },
    });
    expect(opened).toEqual(["pocket-music"]);
    expect(service?.poll()).toHaveLength(1);
    service?.send("volume-up");
    expect(JSON.parse(sent[0]!)).toEqual({ t: "pocket-music.command", op: "volume-up" });
  });
});

describe("iPod nano 2G discovery", () => {
  test("identifies the attached model from Apple USB ids", () => {
    const ioreg = `+-o iPod@01130000  <class IOUSBHostDevice>\n  {\n    "idVendor" = 1452\n    "idProduct" = 4704\n    "USB Serial Number" = "NANO2G-TEST"\n  }`;
    expect(parseIPodNanoUSB(ioreg)).toEqual({
      connected: true,
      vendorId: 0x05ac,
      productId: 0x1260,
      serial: "NANO2G-TEST",
      model: "ipod-nano-2g",
    });
    expect(parseIPodNanoUSB("no device")).toEqual({ connected: false });
  });

  test("identifies the same hardware under Rockbox's USB product name", () => {
    const ioreg = `+-o Rockbox media player@01130000  <class IOUSBHostDevice>\n  {\n    "idVendor" = 1452\n    "idProduct" = 4704\n  }`;
    expect(parseIPodNanoUSB(ioreg)).toEqual({
      connected: true,
      vendorId: 0x05ac,
      productId: 0x1260,
      model: "ipod-nano-2g",
    });
  });

  test("keeps the destructive HFS to FAT32 gate explicit", () => {
    expect(parseIPodFilesystem("3: Apple_HFS iPod 4.0 GB disk6s3")).toBe("hfs");
    expect(parseIPodFilesystem("3: Microsoft Basic Data iPod 4.0 GB disk6s3")).toBe("fat32");
    expect(parseIPodFilesystem("1: DOS_FAT_32 IPOD 4.0 GB disk6s2")).toBe("fat32");
    expect(parseIPodFilesystem("2: Apple_HFS ipodpatcher-5.0 10.6 MB disk9s2")).toBe(
      "unknown",
    );
    expect(parseIPodFilesystem("internal APFS")).toBe("unknown");
  });
});

test("Rockbox USB branding is the exact nano 2G bitmap contract", () => {
  const logo = readFileSync(
    new URL("../hosts/ipodnano/rockbox/usblogo.128x37x16.bmp", import.meta.url),
  );
  const source = readFileSync(
    new URL("../hosts/ipodnano/rockbox/usblogo.128x37x16.svg", import.meta.url),
    "utf8",
  );
  expect(parseBmpFacts(logo)).toEqual({ width: 128, height: 37, bitsPerPixel: 24 });
  expect(source).toContain(">PocketJS</text>");
  expect(source).toContain('x="40"');
  expect(source).toContain('text-anchor="middle"');
});

test("native daemon maps the Rockbox consumer usages and seizes only the nano", () => {
  const daemon = readFileSync(
    new URL("../hosts/ipodnano/PocketMusicDaemon.m", import.meta.url),
    "utf8",
  );
  expect(daemon).toContain("kIPodVendorID = 0x05ac");
  expect(daemon).toContain("kIPodNano2ProductID = 0x1260");
  expect(daemon).toContain("kIOHIDOptionsTypeSeizeDevice");
  expect(daemon).toContain("ControlForConsumerUsage((uint32_t)integerValue)");
  for (const usage of ["0x00e9", "0x00ea", "0x00e2", "0x00cd", "0x00b7", "0x00b5", "0x00b6"]) {
    expect(daemon).toContain(usage);
  }
});
