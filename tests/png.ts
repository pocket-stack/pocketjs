// The deterministic PNG encoder lives in tools/png.ts (production tooling
// must not import from tests/). This re-export keeps the golden and e2e
// helpers on their existing import path.
export { encodePNG } from "../tools/png.ts";
