import { URL as PocketURL } from "../../framework/src/net/index.ts";

String.prototype.normalize = () => { throw new Error("poisoned normalize"); };
String.prototype.codePointAt = () => { throw new Error("poisoned codePointAt"); };
String.prototype.split = (() => { throw new Error("poisoned split"); }) as never;
String.prototype.startsWith = () => { throw new Error("poisoned startsWith"); };
Array.prototype.push = () => { throw new Error("poisoned push"); };
Array.prototype.splice = () => { throw new Error("poisoned splice"); };
RegExp.prototype.test = () => { throw new Error("poisoned test"); };
Math.floor = () => { throw new Error("poisoned floor"); };
Object.freeze = (() => { throw new Error("poisoned freeze"); }) as never;
globalThis.String = class PoisonedString {
  constructor() {
    throw new Error("poisoned String");
  }
} as never;
globalThis.Uint8Array = class PoisonedUint8Array {
  constructor() {
    throw new Error("poisoned Uint8Array");
  }
} as never;

const actual = new PocketURL("https://faß.example:443/a/../雪").href;
if (actual !== "https://xn--fa-hia.example/%E9%9B%AA") {
  throw new Error(`unexpected canonical URL: ${actual}`);
}
