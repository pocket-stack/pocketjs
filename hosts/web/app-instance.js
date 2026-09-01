// One browser AppInstance. A same-origin hidden iframe loads this module so
// every Pocket package receives an independent JavaScript Realm and wasm Ui.
// The parent System host owns scheduling and composition through this narrow
// object; package code never receives another realm or framebuffer.

import { createWasmUi } from "./wasm-ops.js";

async function requiredFetch(url, kind) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${kind} not found at ${url} (${response.status})`);
  return response;
}

export async function create(options) {
  const viewport = [...(options.viewport ?? [480, 272])];
  const density = options.rasterDensity ?? 1;
  const wasmBytes = await (await requiredFetch(options.wasmUrl, "PocketJS wasm")).arrayBuffer();
  const wasm = await createWasmUi(wasmBytes, {
    width: viewport[0],
    height: viewport[1],
    rasterDensity: density,
  });

  const incoming = [];
  const outgoing = [];
  const companions = new Set(options.companions ?? []);
  wasm.ops.svcOpen = (name) => companions.has(name);
  wasm.ops.svcPoll = () => {
    if (incoming.length === 0) return null;
    const batch = incoming.splice(0).join("\n");
    return `${batch}\n`;
  };
  wasm.ops.svcSend = (line) => {
    if (typeof line === "string" && outgoing.length < 1024) outgoing.push(line);
  };
  if (options.surfaces) wasm.ops.__surfaces = { ...options.surfaces };

  globalThis.ui = wasm.ops;
  globalThis.frame = undefined;
  globalThis.__simHz = options.simHz ?? 60;
  globalThis.__pocketApp = options.packageId;
  const pak = await fetch(options.pakUrl);
  globalThis.__pak = pak.ok ? await pak.arrayBuffer() : undefined;
  const source = await (await requiredFetch(options.bundleUrl, "Pocket app bundle")).text();
  new Function(`${source}\n//# sourceURL=${options.packageId}.js`)();
  if (typeof globalThis.frame !== "function") {
    throw new Error(`${options.packageId} evaluated but installed no frame()`);
  }

  return {
    packageId: options.packageId,
    viewport,
    step(buttons = 0) {
      globalThis.frame(buttons, 0x8080);
      wasm.tick();
    },
    render() {
      return wasm.render();
    },
    renderComposited() {
      return wasm.renderComposited();
    },
    resize(width, height) {
      wasm.resizeViewport(width, height);
      viewport[0] = width;
      viewport[1] = height;
      if (typeof globalThis.__pocketResizeViewport === "function") {
        globalThis.__pocketResizeViewport(width, height);
      }
    },
    drawHash() {
      return wasm.drawHash ? wasm.drawHash() : 0n;
    },
    bindings() {
      return wasm.compositorBindings();
    },
    frames() {
      return wasm.compositorFrames();
    },
    uploadSurface(handle, pixels, width, height) {
      return wasm.uploadCompositorSurface(handle, pixels, width, height);
    },
    freeSurface(handle) {
      wasm.freeCompositorSurface(handle);
    },
    sendService(line) {
      incoming.push(typeof line === "string" ? line : JSON.stringify(line));
    },
    drainService() {
      return outgoing.splice(0);
    },
    dispose() {
      incoming.length = 0;
      outgoing.length = 0;
      globalThis.frame = undefined;
      globalThis.ui = undefined;
      globalThis.__pak = undefined;
    },
  };
}

globalThis.PocketAppInstance = { create };
