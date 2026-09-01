// CJS shim for node builtins babel references but never actually needs in the
// browser (fs/os/module/url/util/...). A Proxy returns a no-op for any unknown
// property so a stray access can't crash the transform. configFile:false +
// babelrc:false keep babel off the fs/config paths at runtime.
"use strict";
const noop = () => {};
const api = {
  inspect: (x) => String(x),
  format: (...a) => a.join(" "),
  deprecate: (fn) => fn,
  inherits: noop,
  promisify: (fn) => fn,
  debuglog: () => noop,
  createRequire: () => () => {
    throw new Error("require() unavailable in the browser");
  },
  fileURLToPath: (u) => String(u).replace(/^file:\/\//, ""),
  pathToFileURL: (x) => ({ href: "file://" + x }),
  platform: () => "browser",
  homedir: () => "/",
  tmpdir: () => "/",
  cwd: () => "/",
  existsSync: () => false,
  readFileSync: () => {
    throw new Error("fs unavailable in the browser");
  },
};
api.default = api;
module.exports = new Proxy(api, { get: (t, p) => (p in t ? t[p] : noop) });
