// Browser shim for vue-jsx-vapor's WASI compiler package.
//
// The upstream `@vue-jsx-vapor/compiler-rs-wasm32-wasi` package is marked
// `cpu: ["wasm32"]`, so Bun does not install it on macOS even though the
// browser bundle needs its JS wrapper shape. Keep the npm artifact external and
// load the stable versioned WASM/worker assets from esm.sh.

import {
  getDefaultContext,
  instantiateNapiModuleSync,
  WASI,
} from "@napi-rs/wasm-runtime";

const VERSION = "3.2.17";
const CDN = `https://esm.sh/@vue-jsx-vapor/compiler-rs-wasm32-wasi@${VERSION}`;
const WASM_URL = `${CDN}/compiler-rs.wasm32-wasi.wasm`;
const WORKER_URL = `${CDN}/wasi-worker-browser.mjs`;

const wasi = new WASI({ version: "preview1" });
const emnapiContext = getDefaultContext();
const sharedMemory = new WebAssembly.Memory({
  initial: 4000,
  maximum: 65536,
  shared: true,
});
const wasmFile = await fetch(WASM_URL).then((res) => res.arrayBuffer());

const { napiModule } = instantiateNapiModuleSync(wasmFile, {
  context: emnapiContext,
  asyncWorkPoolSize: 4,
  wasi,
  onCreateWorker() {
    return new Worker(WORKER_URL, { type: "module" });
  },
  overwriteImports(importObject) {
    importObject.env = {
      ...importObject.env,
      ...importObject.napi,
      ...importObject.emnapi,
      memory: sharedMemory,
    };
    return importObject;
  },
  beforeInit({ instance }) {
    for (const name of Object.keys(instance.exports)) {
      if (name.startsWith("__napi_register__")) {
        (instance.exports[name] as () => void)();
      }
    }
  },
});

export default napiModule.exports;
export const ErrorCodes = napiModule.exports.ErrorCodes;
export const transform = napiModule.exports.transform;
