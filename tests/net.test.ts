import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import * as net from "../framework/src/net/index.ts";
import * as http from "../framework/src/net/http.ts";
import * as websocket from "../framework/src/net/websocket.ts";
import * as mqtt from "../framework/src/net/mqtt.ts";
import * as tcp from "../framework/src/net/tcp.ts";
import * as udp from "../framework/src/net/udp.ts";
import { npmExports, SUBPATHS } from "../framework/compiler/subpaths.ts";
import { jsxPlugin, packagePath, transformFile } from "../framework/compiler/jsx-plugin.ts";

describe("net package namespace", () => {
  test("the root exports support values without the NET v1 value API", () => {
    expect(Object.keys(net).sort()).toEqual([
      "AbortController",
      "AbortSignal",
      "NetworkError",
      "URL",
      "getNetworkLimits",
    ]);
    expect("fetch" in net).toBe(false);
    expect("netHost" in net).toBe(false);
    expect("NetError" in net).toBe(false);
    expect("PocketResponse" in net).toBe(false);
  });

  test("every protocol re-exports the same support object identities", () => {
    for (const protocol of [http, websocket, mqtt, tcp, udp]) {
      expect(protocol.AbortController).toBe(net.AbortController);
      expect(protocol.AbortSignal).toBe(net.AbortSignal);
      expect(protocol.NetworkError).toBe(net.NetworkError);
      expect(protocol.URL).toBe(net.URL);
    }
  });

  test("NetworkError carries stable structured fields", () => {
    const error = new net.NetworkError("connection failed", {
      category: "transport",
      code: "connection_refused",
      operation: "tcp.connect",
      temporary: true,
      address: "192.0.2.1",
      port: 9000,
      protocol: "tcp",
      causeCode: "ECONNREFUSED",
    });
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(net.NetworkError);
    expect(error).toMatchObject({
      name: "NetworkError",
      category: "transport",
      code: "connection_refused",
      operation: "tcp.connect",
      temporary: true,
      address: "192.0.2.1",
      port: 9000,
      protocol: "tcp",
      causeCode: "ECONNREFUSED",
    });
  });

  test("PocketJS URL and abort values do not depend on browser constructors", () => {
    const url = new net.URL("https://example.test/path?q=1");
    expect(url.href).toBe("https://example.test/path?q=1");
    expect(String(url)).toBe(url.href);
    expect(() => new net.URL("/relative")).toThrow(TypeError);

    const controller = new net.AbortController();
    const seen: unknown[] = [];
    controller.signal.addEventListener("abort", (event) => seen.push(event.target));
    controller.abort("stop");
    controller.abort("ignored");
    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toBe("stop");
    expect(seen).toEqual([controller.signal]);
    expect(() => controller.signal.throwIfAborted()).toThrow("stop");
    expect(() => new net.AbortSignal()).toThrow("Illegal constructor");
  });

  test("unbound support queries and direct protocol calls fail explicitly", async () => {
    expect(() => net.getNetworkLimits()).toThrow(net.NetworkError);
    expect(() => net.getNetworkLimits()).toThrow(/unadmitted scope/);
    await expect(http.fetch("https://example.test/")).rejects.toMatchObject({
      code: "unsupported",
      operation: "http.fetch",
      protocol: "http",
    });
    await expect(tcp.connect({ hostname: "example.test", port: 80 })).rejects
      .toBeInstanceOf(net.NetworkError);
  });

  test("canonical protocol exports have no framework-prefixed aliases", () => {
    const expected = {
      net: "framework/src/net/index.ts",
      "net/http": "framework/src/net/http.ts",
      "net/websocket": "framework/src/net/websocket.ts",
      "net/mqtt": "framework/src/net/mqtt.ts",
      "net/tcp": "framework/src/net/tcp.ts",
      "net/udp": "framework/src/net/udp.ts",
    } as const;
    for (const [name, file] of Object.entries(expected)) {
      expect(SUBPATHS[name]?.file).toBe(file);
      expect(SUBPATHS[name]?.aliases).toBeUndefined();
    }

    const exports = npmExports();
    for (const name of Object.keys(expected) as Array<keyof typeof expected>) {
      expect(exports[`./${name}`]).toBe(`./${expected[name]}`);
      expect(exports[`./vue-vapor/${name}`]).toBeUndefined();
      expect(exports[`./octane/${name}`]).toBeUndefined();
    }
    expect(JSON.stringify(exports)).not.toContain("framework/src/net-api.ts");
    expect(packagePath("@pocketjs/framework/vue-vapor/net", "vue-vapor")).toBeNull();
    expect(packagePath("@pocketjs/framework/octane/net/http", "octane")).toBeNull();
    expect(packagePath("@pocketjs/framework/net/http", "vue-vapor")).toBe(
      new URL("../framework/src/net/http.ts", import.meta.url).pathname,
    );
  });

  test("stock hosts remove a legacy global binding before app evaluation", async () => {
    const [webEngine, simRuntime] = await Promise.all([
      Bun.file(new URL("../hosts/web/engine.js", import.meta.url)).text(),
      Bun.file(new URL("../hosts/sim/sim.ts", import.meta.url)).text(),
    ]);
    expect(webEngine).not.toContain('from "./net.js"');
    expect(webEngine).not.toMatch(/globalThis\.net\s*=/);
    expect(webEngine).toContain('Reflect.deleteProperty(globalThis, "net")');
    expect(simRuntime).not.toMatch(/g\.net\s*=/);
    expect(simRuntime).toContain('Reflect.deleteProperty(g, "net")');
    expect(simRuntime.indexOf('Reflect.deleteProperty(g, "net")')).toBeLessThan(
      simRuntime.indexOf("(0, eval)(src)"),
    );
  });
});

describe("network surface demand gate", () => {
  const transform = (
    source: string,
    features: Readonly<Record<string, boolean>> = {},
  ) => transformFile(
    `/virtual/network-demand-${Bun.hash(source + JSON.stringify(features))}.ts`,
    source,
    "solid",
    { features },
  );

  test("root support values and explicit type imports create no I/O demand", async () => {
    await expect(transform(`
      import { NetworkError, getNetworkLimits } from "@pocketjs/framework/net";
      import type { RequestInit } from "@pocketjs/framework/net/http";
      import { NetworkError as HttpNetworkError } from "@pocketjs/framework/net/http";
      import type { Headers } from "@pocketjs/framework/net/http";
      export type { MqttClient } from "@pocketjs/framework/net/mqtt";
      void NetworkError; void HttpNetworkError; void getNetworkLimits;
    `)).resolves.toBeDefined();
  });

  test("unimplemented pure value classes fail at build time", async () => {
    await expect(transform(`
      import { Headers } from "@pocketjs/framework/net/http";
      void Headers;
    `)).rejects.toThrow("staged surface");
  });

  test("named value imports and re-exports fail closed without admission", async () => {
    await expect(transform(`
      import { fetch } from "@pocketjs/framework/net/http";
      void fetch;
    `)).rejects.toThrow("network.http.client");
    await expect(transform(`
      export { connect as connectMqtt } from "@pocketjs/framework/net/mqtt";
    `)).rejects.toThrow("network.mqtt.client");
  });

  test("namespace and star exports demand every role in the protocol module", async () => {
    await expect(transform(`
      import * as http from "@pocketjs/framework/net/http";
      void http;
    `, { "network.http.client": true })).rejects.toThrow("network.http.server");
    await expect(transform(`
      export * from "@pocketjs/framework/net/websocket";
    `)).rejects.toThrow("network.websocket.server.upgrade");
    await expect(transform(`
      export * as http from "@pocketjs/framework/net/http";
    `, { "network.http.server": true })).rejects.toThrow("network.http.client");
  });

  test("bare protocol imports fail closed as all-value demand", async () => {
    await expect(transform(`
      import "@pocketjs/framework/net/http";
    `, { "network.http.client": true })).rejects.toThrow("network.http.server");
    await expect(transform(`
      void import("@pocketjs/framework/net/udp");
    `, { "network.udp": true })).rejects.toThrow("staged surface");
  });

  test("constant dynamic imports and CommonJS require use the same gate", async () => {
    const sources = [
      "void import(`@pocketjs/framework/net/http`);",
      'void import("@pocketjs/framework/net/" + "http");',
      'const target = "@pocketjs/framework/net/http"; void import(target);',
      'require("@pocketjs/framework/net/http");',
      'const target = "@pocketjs/framework/net/" + "http"; require(target);',
    ];
    for (const source of sources) {
      await expect(transform(source)).rejects.toThrow("network.http.client");
    }
  });

  test("unresolved dynamic module specifiers fail closed", async () => {
    await expect(transform("declare const target: string; void import(target);"))
      .rejects.toThrow("compile-time strings");
    await expect(transform("declare const target: string; require(target);"))
      .rejects.toThrow("compile-time strings");
    await expect(transform('const target = "./local.ts"; void import(target);'))
      .resolves.toBeDefined();
  });

  test("role admission runs before staged surface readiness", async () => {
    await expect(transform(`
      import { fetch } from "@pocketjs/framework/net/http";
      void fetch;
    `, { "network.http.client": true })).rejects.toThrow("staged surface");

    await expect(transform(`
      import { upgrade } from "@pocketjs/framework/net/websocket";
      void upgrade;
    `, {
      "network.http.server": true,
      "network.websocket.server": true,
    })).rejects.toThrow("network.websocket.server.upgrade");
  });

  test("resolver rejects direct and aliased public protocol source paths", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pocketjs-network-public-path-"));
    const protocolPaths = ["http", "websocket", "mqtt", "tcp", "udp"].map((name) =>
      new URL(`../framework/src/net/${name}.ts`, import.meta.url).pathname
    );
    try {
      const link = join(directory, "protocol-link.ts");
      await symlink(protocolPaths[0]!, link);
      const attacks = [
        ...protocolPaths,
        link,
        `${link}?audit=1#network`,
        `${pathToFileURL(link).href}#network`,
      ];
      for (const [index, target] of attacks.entries()) {
        const entry = join(directory, `attack-${index}.ts`);
        await writeFile(entry, `import * as protocol from ${JSON.stringify(target)}; void protocol;`);
        let failure: unknown;
        try {
          await Bun.build({
            entrypoints: [entry],
            format: "iife",
            target: "browser",
            plugins: [jsxPlugin("solid", { entry, features: {} })],
          });
        } catch (error) {
          failure = error;
        }
        const messages = (failure as { errors?: readonly { message: string }[] } | undefined)
          ?.errors?.map((error) => error.message).join("\n") ?? "";
        expect(messages).toContain("canonical @pocketjs/framework/net/");
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
