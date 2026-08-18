import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  finalizeBuildPlan,
  type ResolvedBuildPlanContent,
} from "../framework/src/manifest/plan.ts";
import {
  createNetworkFactoryBuildContext,
  finalizeBundleArtifact,
  selectBundleArtifactMode,
  wrapNetworkBundleFactory,
} from "../tools/network-bundle-factory.ts";
import {
  LEGACY_NETWORK_FACTORY_PARAMETER,
  NETWORK_BINDING_RESERVED_IDENTIFIER,
  NETWORK_PRIVATE_SPECIFIER,
  type NetworkPrivateBuildContext,
} from "../framework/compiler/network-private.ts";
import { jsxPlugin, transformFile } from "../framework/compiler/jsx-plugin.ts";
import {
  NETWORK_V1_ABI_MAJOR,
  NETWORK_V1_ABI_MINOR,
  NETWORK_V1_LIMIT_PROTOCOL_ANY,
  NETWORK_V1_LIMIT_ROLE_ANY,
  NetworkV1CommandOpcode,
  NetworkV1CompletionPollStatus,
  NetworkV1DispatchStatus,
  NetworkV1LimitProtocol,
  NetworkV1LimitRole,
  type NetworkV1AsyncCommand,
  type NetworkV1BindingTable,
  type NetworkV1BufferLeaseReadIntoCommand,
  type NetworkV1BufferLeaseTakeCommand,
  type NetworkV1FeatureId,
  type NetworkV1LimitsQuery,
  type NetworkV1ServiceDispatcher,
} from "../contracts/spec/network/network-v1.ts";

const MARKER = "__pocketNetworkFactoryTestMarker";
const ROOT = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const GLOBAL_BINDING_NAMES = [
  NETWORK_BINDING_RESERVED_IDENTIFIER,
  LEGACY_NETWORK_FACTORY_PARAMETER,
] as const;

type TestGlobal = typeof globalThis & Record<string, unknown>;

function globals(): TestGlobal {
  return globalThis as TestGlobal;
}

function evaluateArtifact(source: string): unknown {
  return (0, eval)(source);
}

function content(withNetwork: boolean): ResolvedBuildPlanContent {
  return {
    app: {
      id: "dev.pocketjs.network-factory-test",
      title: "Network factory test",
      entry: "app.ts",
      framework: "solid",
      output: "app",
    },
    target: { id: "esp-test", hostAbi: 1 },
    viewport: {
      logical: [320, 240],
      physical: [320, 240],
      presentation: "integer-fit",
      rasterDensity: 1,
    },
    features: withNetwork ? { "network.http.client": true } : {},
    ...(withNetwork
      ? {
          network: {
            policy: {
              version: 1 as const,
              connect: [],
              listen: [],
              localNetwork: false,
              insecureTransport: false,
              broadcast: false,
              multicast: false,
              allowInvalidTlsForDevelopment: false,
              browserAmbientCredentials: false,
              browserOpaqueWebSocketRedirects: false,
              credentials: [],
            },
            providers: {
              backendByRole: {},
              tlsByRole: {},
              netDriverId: "net.driver.test",
            },
            resources: { minimum: {} },
          },
        }
      : {}),
  };
}

function networkContext(): NetworkPrivateBuildContext {
  return createNetworkFactoryBuildContext(finalizeBuildPlan(content(true)));
}

function formalBinding(
  context: NetworkPrivateBuildContext,
  hooks: Readonly<{
    dispatch?: (
      this: NetworkV1BindingTable,
      command: NetworkV1AsyncCommand,
    ) => void;
    register?: (dispatcher: NetworkV1ServiceDispatcher) => void;
  }> = {},
): NetworkV1BindingTable {
  const featureIds = Object.freeze(
    [...context.featureIds] as NetworkV1FeatureId[],
  );
  const handshake = Object.freeze({
    abiMajor: NETWORK_V1_ABI_MAJOR,
    abiMinor: NETWORK_V1_ABI_MINOR,
    runtimeGeneration: 1,
    planHash: Uint8Array.from(context.planHashBytes),
    featureIds,
  });
  return Object.freeze({
    handshake,
    getLimits(query: NetworkV1LimitsQuery) {
      const inProtocol = query.protocol === NETWORK_V1_LIMIT_PROTOCOL_ANY ||
        query.protocol === NetworkV1LimitProtocol.Http;
      const inRole = query.role === NETWORK_V1_LIMIT_ROLE_ANY ||
        query.role === NetworkV1LimitRole.Client;
      return Object.freeze({
        runtimeGeneration: 1,
        protocol: query.protocol,
        role: query.role,
        values: Object.freeze(inProtocol && inRole
          ? [
              Object.freeze({
                name: "http.bufferedBodyBytes",
                default: 256 * 1024,
                hard: 256 * 1024,
                minimum: 1,
              }),
              Object.freeze({
                name: "http.headerBytes",
                default: 8 * 1024,
                hard: 8 * 1024,
                minimum: 1,
              }),
              Object.freeze({
                name: "http.maxBodyChunkBytes",
                default: 2 * 1024,
                hard: 2 * 1024,
                minimum: 1,
              }),
              Object.freeze({
                name: "http.maxOperations",
                default: 8,
                hard: 8,
                minimum: 1,
              }),
              Object.freeze({
                name: "runtime.nativeBufferBytes",
                default: 512 * 1024,
                hard: 512 * 1024,
                minimum: 1,
              }),
            ]
          : []),
        featureIds: Object.freeze(inProtocol && inRole ? [...featureIds] : []),
      });
    },
    dispatch(command: NetworkV1AsyncCommand) {
      hooks.dispatch?.call(this, command);
      return Object.freeze({ status: NetworkV1DispatchStatus.Accepted });
    },
    nextCompletion() {
      return Object.freeze({
        status: NetworkV1CompletionPollStatus.Drained,
        payloadBytesDelivered: 0 as const,
      });
    },
    leaseTake(command: NetworkV1BufferLeaseTakeCommand) {
      return Object.freeze({
        status: NetworkV1DispatchStatus.Completed,
        byteLength: command.byteLength,
      });
    },
    leaseReadInto(command: NetworkV1BufferLeaseReadIntoCommand) {
      return Object.freeze({
        status: NetworkV1DispatchStatus.Completed,
        bytesCopied: command.maxBytes,
      });
    },
    leaseRelease() {
      return Object.freeze({ status: NetworkV1DispatchStatus.Completed });
    },
    registerServiceDispatcher(dispatcher: NetworkV1ServiceDispatcher) {
      hooks.register?.(dispatcher);
    },
  });
}

async function bundleNetworkEntry(
  entry: string,
  context: NetworkPrivateBuildContext,
): Promise<ReturnType<typeof Bun.build> extends Promise<infer Result> ? Result : never> {
  return await Bun.build({
    entrypoints: [context.bootstrapSpecifier],
    format: "iife",
    target: "browser",
    plugins: [jsxPlugin("solid", {
      entry,
      features: { "network.http.client": true },
      networkPrivate: context,
    })],
  });
}

async function bundlePlainEntry(
  entry: string,
): Promise<ReturnType<typeof Bun.build> extends Promise<infer Result> ? Result : never> {
  return await Bun.build({
    entrypoints: [entry],
    format: "iife",
    target: "browser",
    plugins: [jsxPlugin("solid", { entry })],
  });
}

function buildMessages(result: Awaited<ReturnType<typeof Bun.build>>): string {
  return result.logs.map((log) => log.message).join("\n");
}

afterEach(() => {
  delete globals()[MARKER];
  for (const name of GLOBAL_BINDING_NAMES) delete globals()[name];
});

describe("network factory admission", () => {
  test("requires the verified network plan and factory flag to agree", () => {
    const plainPlan = finalizeBuildPlan(content(false));
    const networkPlan = finalizeBuildPlan(content(true));

    expect(selectBundleArtifactMode(undefined, false)).toBe("iife");
    expect(selectBundleArtifactMode(plainPlan, false)).toBe("iife");
    expect(selectBundleArtifactMode(networkPlan, true)).toBe("network-factory");
    expect(() => selectBundleArtifactMode(networkPlan, false)).toThrow(
      "requires a factory-aware loader",
    );
    expect(() => selectBundleArtifactMode(plainPlan, true)).toThrow(
      "requires a ResolvedBuildPlan with network admission",
    );
    expect(() => selectBundleArtifactMode(undefined, true)).toThrow(
      "requires a ResolvedBuildPlan with network admission",
    );
  });

  test("rejects a modified plan before selecting an artifact ABI", () => {
    const plan = finalizeBuildPlan(content(true));
    expect(() => selectBundleArtifactMode({
      ...plan,
      target: { ...plan.target, id: "modified" },
    }, true)).toThrow("invalid ResolvedBuildPlan checksum");
  });

  test("derives per-artifact private names without a fixed define or parameter", () => {
    const first = createNetworkFactoryBuildContext(finalizeBuildPlan(content(true)));
    const secondPlan = finalizeBuildPlan({
      ...content(true),
      app: { ...content(true).app, id: "dev.pocketjs.network-factory-other" },
    });
    const second = createNetworkFactoryBuildContext(secondPlan);

    expect(first.takeIdentifier).not.toBe(second.takeIdentifier);
    expect(first.bindingIdentifier).not.toBe(second.bindingIdentifier);
    expect(first.pendingIdentifier).not.toBe(second.pendingIdentifier);
    expect(first.argumentsIdentifier).not.toBe(second.argumentsIdentifier);
    expect(first.takeIdentifier).not.toContain(NETWORK_BINDING_RESERVED_IDENTIFIER);
    expect(first.takeIdentifier).not.toContain(LEGACY_NETWORK_FACTORY_PARAMETER);
  });
});

describe("network factory artifact", () => {
  test("preserves a non-network IIFE byte-for-byte", () => {
    const source = "\uFEFF(() => { globalThis.legacy = true; })();\n";
    expect(finalizeBundleArtifact(source, "iife")).toBe(source);
  });

  test("captures before app initialization and retires the original argument", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pocketjs-network-factory-"));
    try {
      const entry = join(directory, "entry.ts");
      const context = networkContext();
      await Bun.write(entry, `
        const direct = (source: string): unknown => {
          try { return eval(source); } catch { return "unbound"; }
        };
        (globalThis as Record<string, unknown>).${MARKER} = {
          reserved: direct(${JSON.stringify(`typeof ${NETWORK_BINDING_RESERVED_IDENTIFIER}`)}),
          legacyParameter: direct(${JSON.stringify(`typeof ${LEGACY_NETWORK_FACTORY_PARAMETER}`)}),
          privateTake: direct(${JSON.stringify(`typeof ${context.takeIdentifier}`)}),
          privateSlot: direct(${JSON.stringify(`typeof ${context.bindingIdentifier}`)}),
          functionSlot: Function(${JSON.stringify(`return typeof ${context.bindingIdentifier}`)})(),
          globalEvalSlot: globalThis.eval(${JSON.stringify(`typeof ${context.bindingIdentifier}`)}),
          factoryArgument: direct("arguments[0]"),
          sourceGlobal: Object.prototype.hasOwnProperty.call(
            globalThis,
            ${JSON.stringify(NETWORK_BINDING_RESERVED_IDENTIFIER)},
          ),
          parameterGlobal: Object.prototype.hasOwnProperty.call(
            globalThis,
            ${JSON.stringify(LEGACY_NETWORK_FACTORY_PARAMETER)},
          ),
        };
        queueMicrotask(() => {
          (globalThis as Record<string, any>).${MARKER}.microtaskCheckpoint =
            direct(${JSON.stringify(`typeof ${context.takeIdentifier}`)});
        });
      `);
      const result = await bundleNetworkEntry(entry, context);
      expect(result.success).toBe(true);
      const source = await result.outputs[0]!.text();
      const factory = evaluateArtifact(wrapNetworkBundleFactory(source, context));

      expect(typeof factory).toBe("function");
      expect((factory as Function).length).toBe(0);
      expect(globals()[MARKER]).toBeUndefined();

      const binding = formalBinding(context);
      expect((factory as (binding: object) => unknown)(binding)).toBeUndefined();
      expect(globals()[MARKER]).toMatchObject({
        reserved: "undefined",
        legacyParameter: "undefined",
        privateTake: "undefined",
        privateSlot: "undefined",
        functionSlot: "undefined",
        globalEvalSlot: "undefined",
        sourceGlobal: false,
        parameterGlobal: false,
      });
      expect((globals()[MARKER] as Record<string, unknown>).factoryArgument).not.toBe(binding);
      await Promise.resolve();
      expect((globals()[MARKER] as Record<string, unknown>).microtaskCheckpoint).toBe("undefined");
      for (const name of GLOBAL_BINDING_NAMES) {
        expect(Object.prototype.hasOwnProperty.call(globalThis, name)).toBe(false);
      }
      for (const name of [
        context.takeIdentifier,
        context.bindingIdentifier,
        context.pendingIdentifier,
        context.argumentsIdentifier,
      ]) {
        expect(Object.prototype.hasOwnProperty.call(globalThis, name)).toBe(false);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects application imports of every compiler-only internal form", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pocketjs-network-private-import-"));
    const privateBindingPath = join(ROOT, "framework/src/net/http-binding.ts");
    const privateFormalPath = join(ROOT, "framework/src/net/network-v1-binding.ts");
    const privateLimitsPath = join(ROOT, "framework/src/net/network-limits.ts");
    const linkPath = join(directory, "binding-link.ts");
    const formalLinkPath = join(directory, "formal-link.ts");
    const limitsLinkPath = join(directory, "limits-link.ts");
    try {
      await symlink(privateBindingPath, linkPath);
      await symlink(privateFormalPath, formalLinkPath);
      await symlink(privateLimitsPath, limitsLinkPath);
      const context = networkContext();
      const javascriptAttack = join(directory, "derived-attack.js");
      await Bun.write(javascriptAttack, `void ${context.bindingIdentifier};`);
      const derivedIdentifiers = [
        context.takeIdentifier,
        context.bindingIdentifier,
        context.pendingIdentifier,
        context.argumentsIdentifier,
      ];
      const unicodeEscaped = (name: string): string =>
        name.replace("p", "\\u0070");
      const privatePaths = [
        privateBindingPath,
        privateFormalPath,
        privateLimitsPath,
      ];
      const directFileAttacks = privatePaths.flatMap((path) => {
        const fileUrl = pathToFileURL(path).href;
        return [
          `import ${JSON.stringify(path)};`,
          `void import(${JSON.stringify(path)});`,
          `require(${JSON.stringify(path)});`,
          `import ${JSON.stringify(`${path}?audit=1#x`)};`,
          `void import(${JSON.stringify(`${path}#audit`)});`,
          `require(${JSON.stringify(`${path}?audit`)});`,
          `import ${JSON.stringify(fileUrl)};`,
          `void import(${JSON.stringify(`${fileUrl}?audit=1#x`)});`,
          `require(${JSON.stringify(`${fileUrl}#audit`)});`,
        ];
      });
      const attacks = [
        `import ${JSON.stringify(NETWORK_PRIVATE_SPECIFIER)};`,
        `import "pocketjs:internal/future-version";`,
        `void import(${JSON.stringify(NETWORK_PRIVATE_SPECIFIER)});`,
        `require(${JSON.stringify(NETWORK_PRIVATE_SPECIFIER)});`,
        ...directFileAttacks,
        `import ${JSON.stringify(linkPath)};`,
        `import "./binding-link.ts?audit";`,
        `void import("./formal-link.ts#audit");`,
        `require("./limits-link.ts?audit=1#x");`,
        `void ${NETWORK_BINDING_RESERVED_IDENTIFIER};`,
        `void arguments[0];`,
        `import "./derived-attack.js";`,
        ...derivedIdentifiers.map((name) => `void ${name};`),
        ...derivedIdentifiers.map(
          (name) => `const { value: ${name} } = { value: 1 };`,
        ),
        ...derivedIdentifiers.map((name) => `void ${unicodeEscaped(name)};`),
      ];
      for (let index = 0; index < attacks.length; index++) {
        const entry = join(directory, `attack-${index}.ts`);
        await Bun.write(entry, attacks[index]!);
        let message = "";
        try {
          const result = await bundleNetworkEntry(entry, context);
          expect(result.success, `${attacks[index]} unexpectedly built`).toBe(false);
          message = buildMessages(result);
        } catch (error) {
          const errors = (error as { errors?: readonly { message?: string }[] }).errors;
          message = errors
            ? errors.map((item) => item.message ?? String(item)).join("\n")
            : error instanceof Error ? error.message : String(error);
        }
        expect(message).toContain("private network binding");
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects private limits installers in non-network artifacts too", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pocketjs-network-limits-private-"));
    const privateBindingPath = join(ROOT, "framework/src/net/http-binding.ts");
    const privateFormalPath = join(ROOT, "framework/src/net/network-v1-binding.ts");
    const privateLimitsPath = join(ROOT, "framework/src/net/network-limits.ts");
    const linkPath = join(directory, "limits-link.ts");
    try {
      await symlink(privateLimitsPath, linkPath);
      const attacks = [privateBindingPath, privateFormalPath, privateLimitsPath]
        .flatMap((path) => {
          const fileUrl = pathToFileURL(path).href;
          return [
            `import ${JSON.stringify(`${path}?plain`)};`,
            `void import(${JSON.stringify(`${fileUrl}#plain`)});`,
            `require(${JSON.stringify(fileUrl)});`,
          ];
        });
      attacks.push(
        `import "./limits-link.ts?plain";`,
        `void import("./limits-link.ts#plain");`,
        `require("./limits-link.ts?plain=1#x");`,
      );
      for (let index = 0; index < attacks.length; index += 1) {
        const entry = join(directory, `plain-attack-${index}.ts`);
        await Bun.write(entry, attacks[index]!);
        let message = "";
        try {
          const result = await bundlePlainEntry(entry);
          expect(result.success, `${attacks[index]} unexpectedly built`).toBe(false);
          message = buildMessages(result);
        } catch (error) {
          const errors = (error as { errors?: readonly { message?: string }[] }).errors;
          message = errors
            ? errors.map((item) => item.message ?? String(item)).join("\n")
            : error instanceof Error ? error.message : String(error);
        }
        expect(message).toContain("private network binding");
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("does not trust an application merely because its path is under framework source", async () => {
    const context = networkContext();
    const existingFrameworkPath = join(ROOT, "framework/src/net/http.ts");
    await expect(transformFile(
      existingFrameworkPath,
      `void ${context.bindingIdentifier};`,
      "solid",
      { networkPrivate: context },
    )).rejects.toThrow("private network binding identifier");
  });

  test("rejects a frozen accessor table without invoking its getter", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pocketjs-network-hostile-binding-"));
    try {
      const entry = join(directory, "entry.ts");
      const context = networkContext();
      await Bun.write(entry, `globalThis.${MARKER} = "application-ran";`);
      const result = await bundleNetworkEntry(entry, context);
      expect(result.success).toBe(true);
      const factory = evaluateArtifact(wrapNetworkBundleFactory(
        await result.outputs[0]!.text(),
        context,
      )) as (binding: object) => unknown;

      let getterCalls = 0;
      const hostile = Object.freeze(Object.defineProperty({}, "abiMajor", {
        enumerable: true,
        get: () => {
          getterCalls++;
          return 1;
        },
      }));
      expect(() => factory(hostile)).toThrow("handshake must be an own data property");
      expect(getterCalls).toBe(0);
      expect(globals()[MARKER]).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("links admitted limits through the compiler-only framework capture", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pocketjs-network-framework-capture-"));
    try {
      const entry = join(directory, "entry.ts");
      const context = networkContext();
      await Bun.write(entry, `
        import { getNetworkLimits } from "@pocketjs/framework/net";
        (globalThis as Record<string, unknown>).${MARKER} = getNetworkLimits(
          "http",
          "client",
        ).values["http.maxBodyChunkBytes"].default;
      `);
      const result = await bundleNetworkEntry(entry, context);
      expect(result.success).toBe(true);
      const bundled = await result.outputs[0]!.text();
      expect(bundled).not.toMatch(/\bimport\s+[^;]*pocketjs:internal\//);

      const factory = evaluateArtifact(wrapNetworkBundleFactory(bundled, context));
      const binding = formalBinding(context);
      expect((factory as (value: object) => unknown)(binding)).toBeUndefined();
      expect(globals()[MARKER]).toBe(2 * 1024);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("builds a PocketJS app whose mount and frame checkpoint start at factory call", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pocketjs-network-build-e2e-"));
    const output = join(directory, "dist");
    const app = join(directory, "app.tsx");
    const planPath = join(directory, "resolved-plan.json");
    const priorUi = globals().ui;
    const priorFrame = globals().frame;
    try {
      await Bun.write(app, `
        import { Text, View } from "@pocketjs/framework/components";
        import { onFrame } from "@pocketjs/framework/lifecycle";
        import { mount } from "@pocketjs/framework/solid";
        const checkpoint = (globalThis as Record<string, any>).${MARKER};
        checkpoint.initializers++;
        mount(() => {
          onFrame(() => checkpoint.frames++);
          return <View><Text>factory ready</Text></View>;
        });
        checkpoint.mounted = true;
      `);
      const plan = finalizeBuildPlan({
        ...content(true),
        app: {
          ...content(true).app,
          entry: "app.tsx",
          output: "network-factory-e2e",
        },
      });
      await Bun.write(planPath, `${JSON.stringify(plan)}\n`);

      const buildProcess = Bun.spawn([
        process.execPath,
        "tools/build.ts",
        `--plan=${planPath}`,
        `--project-root=${directory}`,
        `--outdir=${output}`,
        "--no-config",
        "--network-factory",
      ], {
        cwd: ROOT,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        buildProcess.exited,
        new Response(buildProcess.stdout).text(),
        new Response(buildProcess.stderr).text(),
      ]);
      expect(exitCode, `${stdout}\n${stderr}`).toBe(0);

      globals()[MARKER] = { initializers: 0, frames: 0, mounted: false };
      let nextNode = 2;
      globals().ui = {
        __host: "esp-test",
        __hostAbi: 1,
        __textures: Object.freeze({}),
        createNode: () => nextNode++,
        destroyNode: () => {},
        insertBefore: () => {},
        removeChild: () => {},
        setStyle: () => {},
        setProp: () => {},
        setText: () => {},
        replaceText: () => {},
        uploadTexture: () => 1,
        setImage: () => {},
        setSprite: () => {},
        animate: () => 1,
        cancelAnim: () => {},
        setFocus: () => {},
        measureText: () => 0,
      };
      delete globals().frame;

      const artifact = await Bun.file(
        join(output, "network-factory-e2e.js"),
      ).text();
      const factory = evaluateArtifact(artifact);
      expect(typeof factory).toBe("function");
      expect(globals()[MARKER]).toEqual({
        initializers: 0,
        frames: 0,
        mounted: false,
      });
      expect(globals().frame).toBeUndefined();

      const context = createNetworkFactoryBuildContext(plan);
      const binding = formalBinding(context);
      expect((factory as (value: object) => unknown)(binding)).toBeUndefined();
      expect(globals()[MARKER]).toEqual({
        initializers: 1,
        frames: 0,
        mounted: true,
      });
      expect(typeof globals().frame).toBe("function");
      (globals().frame as (buttons: number) => void)(0);
      expect(globals()[MARKER]).toEqual({
        initializers: 1,
        frames: 1,
        mounted: true,
      });
      for (const name of GLOBAL_BINDING_NAMES) {
        expect(Object.prototype.hasOwnProperty.call(globalThis, name)).toBe(false);
      }
    } finally {
      if (priorUi === undefined) delete globals().ui;
      else globals().ui = priorUi;
      if (priorFrame === undefined) delete globals().frame;
      else globals().frame = priorFrame;
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("consumes the factory on an invalid first call without running the IIFE", () => {
    const context = networkContext();
    const captureSource = `${context.takeIdentifier}();\n`;
    const factory = evaluateArtifact(wrapNetworkBundleFactory(
      captureSource +
      `globalThis.${MARKER} = true;`,
      context,
    )) as (...args: unknown[]) => void;

    expect(() => factory({})).toThrow("requires a frozen binding table");
    expect(globals()[MARKER]).toBeUndefined();
    expect(() => factory(Object.freeze({}))).toThrow("already invoked");
    expect(globals()[MARKER]).toBeUndefined();
  });

  test("requires exactly one argument and does not retry a throwing initializer", () => {
    const context = networkContext();
    const missing = evaluateArtifact(wrapNetworkBundleFactory(
      `${context.takeIdentifier}(); globalThis.${MARKER} = "missing-ran";`,
      context,
    )) as (...args: unknown[]) => void;
    expect(() => missing()).toThrow("requires exactly one binding argument");
    expect(globals()[MARKER]).toBeUndefined();

    const extraContext = networkContext();
    const extra = evaluateArtifact(wrapNetworkBundleFactory(
      `${extraContext.takeIdentifier}(); globalThis.${MARKER} = "extra-ran";`,
      extraContext,
    )) as (...args: unknown[]) => void;
    expect(() => extra(Object.freeze({}), Object.freeze({}))).toThrow(
      "requires exactly one binding argument",
    );
    expect(globals()[MARKER]).toBeUndefined();

    const throwingContext = networkContext();
    const throwing = evaluateArtifact(wrapNetworkBundleFactory(`
      ${throwingContext.takeIdentifier}();
      globalThis.${MARKER} = ((globalThis.${MARKER} ?? 0) + 1);
      throw new Error("initializer failed");
    `, throwingContext)) as (...args: unknown[]) => void;
    expect(() => throwing(Object.freeze({}))).toThrow("initializer failed");
    expect(globals()[MARKER]).toBe(1);
    expect(() => throwing(Object.freeze({}))).toThrow("already invoked");
    expect(globals()[MARKER]).toBe(1);
  });
});
