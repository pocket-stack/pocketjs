import { test, expect } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  connectOffloadUsbProvider,
  usbPacket,
  usbHash,
} from "../tools/offload-usb-provider.ts";
async function until<T>(f: () => T | undefined): Promise<T> {
  const end = Date.now() + 4000;
  while (Date.now() < end) {
    const value = f();
    if (value !== undefined) return value;
    await Bun.sleep(10);
  }
  throw Error("USB test deadline");
}
test("USB mailbox preserves identities, bounds records and binary payloads, and rotates a crashed executor", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pocket-usb-"));
  const provider = connectOffloadUsbProvider({
    directory,
    app: "test.usb",
    worker: new URL("./fixtures/offload-usb/worker.ts", import.meta.url),
    data: {},
  });
  const read = (file: string) => {
    try {
      return readFileSync(join(provider.root, file));
    } catch {
      return undefined;
    }
  };
  const send = (
    slot: number,
    sequence: number,
    method: string,
    payload: string,
    response?: "image",
  ) =>
    writeFileSync(
      join(provider.root, `req${slot}`),
      usbPacket(
        provider.epoch,
        12,
        sequence,
        0,
        0,
        0,
        0,
        Buffer.from(
          JSON.stringify({
            v: 1,
            id: sequence,
            method,
            payload,
            ...(response ? { response } : {}),
          }),
        ),
      ),
    );
  const reply = (slot: number, seq: number) =>
    until(() => {
      const b = read(`res${slot}`);
      return b && b.readUInt32LE(12) === seq ? b : undefined;
    });
  try {
    await until(() => read("ready"));
    send(0, 1, "test.echo", "hello");
    let b = await reply(0, 1);
    expect(JSON.parse(b.toString("utf8", 64))).toEqual({
      id: 1,
      payload: "hello",
    });
    expect(b.readUInt32LE(8)).toBe(12);
    expect(b.readUInt32LE(36)).toBe(usbHash(b.subarray(64)));
    send(0, 2, "test.image", "", "image");
    b = await reply(0, 2);
    expect(b.readUInt32LE(16)).toBe(2);
    expect(b.length).toBe(576);
    expect(b.subarray(64).every((n) => n === 42)).toBe(true);
    writeFileSync(join(provider.root, "req1"), Buffer.alloc(5000));
    await Bun.sleep(50);
    expect(existsSync(join(provider.root, "res1"))).toBe(false);
    send(2, 10, "test.delay", "obsolete");
    await Bun.sleep(40);
    send(2, 11, "test.echo", "current");
    await reply(2, 11);
    await Bun.sleep(240);
    expect(read("res2")!.readUInt32LE(12)).toBe(11);
    writeFileSync(
      join(provider.root, "req3"),
      usbPacket(provider.epoch, 12, 20, 0, 0, 0, 0, Buffer.from("null")),
    );
    await Bun.sleep(30);
    expect(read("res3")).toBeUndefined();
    const epoch = provider.epoch;
    send(1, 3, "test.crash", "");
    await until(() => {
      const ready = read("ready");
      // until() treats only undefined as pending. A boolean false here
      // would send the recovery request before the crashed worker exits.
      return provider.epoch !== epoch &&
        ready?.readUInt32LE(4) === provider.epoch
        ? ready
        : undefined;
    });
    expect(provider.epoch).not.toBe(epoch);
    send(0, 4, "test.echo", "recovered");
    b = await reply(0, 4);
    expect(b.readUInt32LE(4)).toBe(provider.epoch);
    expect(JSON.parse(b.toString("utf8", 64)).payload).toBe("recovered");
  } finally {
    provider.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 10000);
