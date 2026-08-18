import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("getNetworkLimits survives hostile prototypes and returns an exact frozen graph", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pocketjs-net-limits-hardening-"));
  const resultPath = join(directory, "result.json");
  const limitsUrl = new URL(
    "../framework/src/net/network-limits.ts",
    import.meta.url,
  ).href;
  const netUrl = new URL("../framework/src/net/index.ts", import.meta.url).href;
  const source = `
    const limits = await import(${JSON.stringify(limitsUrl)});
    const net = await import(${JSON.stringify(netUrl)});
    limits.installNetworkLimitsProvider(() => ({
      values: [
        { name: "__proto__", default: 2, hard: 4, minimum: 1 },
        { name: "constructor", default: 8, hard: 16, minimum: 4 },
      ],
      features: ["__proto__", "network.http.client"],
    }));

    const createDescriptor = Object.getOwnPropertyDescriptor(Object, "create");
    const definePropertyDescriptor = Object.getOwnPropertyDescriptor(Object, "defineProperty");
    const definePropertiesDescriptor = Object.getOwnPropertyDescriptor(Object, "defineProperties");
    const freezeDescriptor = Object.getOwnPropertyDescriptor(Object, "freeze");
    const arrayIteratorDescriptor = Object.getOwnPropertyDescriptor(
      Array.prototype,
      Symbol.iterator,
    );
    const arrayMapDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, "map");
    const arrayForEachDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, "forEach");
    const defineProperty = Object.defineProperty;
    const getPrototypeOf = Object.getPrototypeOf;
    const getOwnPropertyNames = Object.getOwnPropertyNames;
    const isFrozen = Object.isFrozen;
    const poisonNames = ["protocol", "role", "values", "features", "default", "hard", "minimum"];
    const poisonDescriptors = [];
    for (let index = 0; index < poisonNames.length; index++) {
      poisonDescriptors[index] = Object.getOwnPropertyDescriptor(
        Object.prototype,
        poisonNames[index],
      );
    }
    const poisoned = () => { throw new Error("poisoned intrinsic used"); };
    let snapshot;
    try {
      defineProperty(Object, "create", { ...createDescriptor, value: poisoned });
      defineProperty(Object, "defineProperty", { ...definePropertyDescriptor, value: poisoned });
      defineProperty(Object, "defineProperties", { ...definePropertiesDescriptor, value: poisoned });
      defineProperty(Object, "freeze", { ...freezeDescriptor, value: poisoned });
      defineProperty(Array.prototype, Symbol.iterator, {
        configurable: true,
        get: poisoned,
      });
      defineProperty(Array.prototype, "map", { ...arrayMapDescriptor, value: poisoned });
      defineProperty(Array.prototype, "forEach", { ...arrayForEachDescriptor, value: poisoned });
      for (let index = 0; index < poisonNames.length; index++) {
        defineProperty(Object.prototype, poisonNames[index], {
          configurable: true,
          get: poisoned,
        });
      }
      snapshot = net.getNetworkLimits("http", "client");
    } finally {
      defineProperty(Object, "create", createDescriptor);
      defineProperty(Object, "defineProperty", definePropertyDescriptor);
      defineProperty(Object, "defineProperties", definePropertiesDescriptor);
      defineProperty(Object, "freeze", freezeDescriptor);
      defineProperty(Array.prototype, Symbol.iterator, arrayIteratorDescriptor);
      defineProperty(Array.prototype, "map", arrayMapDescriptor);
      defineProperty(Array.prototype, "forEach", arrayForEachDescriptor);
      for (let index = 0; index < poisonNames.length; index++) {
        const descriptor = poisonDescriptors[index];
        if (descriptor === undefined) delete Object.prototype[poisonNames[index]];
        else defineProperty(Object.prototype, poisonNames[index], descriptor);
      }
    }

    const rootNames = getOwnPropertyNames(snapshot).sort();
    const valueNames = getOwnPropertyNames(snapshot.values).sort();
    const featureNames = getOwnPropertyNames(snapshot.features).sort();
    await Bun.write(${JSON.stringify(resultPath)}, JSON.stringify({
      rootNames,
      valueNames,
      featureNames,
      nullPrototypes:
        getPrototypeOf(snapshot) === null &&
        getPrototypeOf(snapshot.values) === null &&
        getPrototypeOf(snapshot.features) === null &&
        getPrototypeOf(snapshot.values.__proto__) === null &&
        getPrototypeOf(snapshot.values.constructor) === null,
      recursivelyFrozen:
        isFrozen(snapshot) &&
        isFrozen(snapshot.values) &&
        isFrozen(snapshot.features) &&
        isFrozen(snapshot.values.__proto__) &&
        isFrozen(snapshot.values.constructor),
      protocol: snapshot.protocol,
      role: snapshot.role,
      protoDefault: snapshot.values.__proto__.default,
      constructorHard: snapshot.values.constructor.hard,
      protoFeature: snapshot.features.__proto__,
      httpFeature: snapshot.features["network.http.client"],
    }));
  `;

  try {
    const script = join(directory, "limits-hostile.ts");
    await Bun.write(script, source);
    const child = Bun.spawn([process.execPath, script], {
      stdout: "ignore",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(await Bun.file(resultPath).json()).toEqual({
      rootNames: ["features", "protocol", "role", "values"],
      valueNames: ["__proto__", "constructor"],
      featureNames: ["__proto__", "network.http.client"],
      nullPrototypes: true,
      recursivelyFrozen: true,
      protocol: "http",
      role: "client",
      protoDefault: 2,
      constructorHard: 16,
      protoFeature: true,
      httpFeature: true,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
