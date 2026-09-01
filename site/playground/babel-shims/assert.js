// CJS shim for node's `assert` — @babel/helper-module-imports does
// `var _assert = require("assert"); _assert(cond, msg)`, so module.exports MUST
// be the callable itself (an ESM default would arrive as a namespace object).
"use strict";
function assert(v, m) {
  if (!v) throw new Error(m || "assert failed");
}
assert.ok = assert;
assert.equal = (a, b, m) => {
  if (a != b) throw new Error(m || a + " != " + b);
};
assert.strictEqual = (a, b, m) => {
  if (a !== b) throw new Error(m || a + " !== " + b);
};
assert.notStrictEqual = (a, b, m) => {
  if (a === b) throw new Error(m || "unexpected equal");
};
assert.deepEqual = () => {};
assert.default = assert;
module.exports = assert;
