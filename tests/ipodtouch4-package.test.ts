import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { encodePocketPackage, POCKET_SECTION } from "../contracts/spec/pocket-package.ts";
import { canonicalJson } from "../framework/src/manifest/plan.ts";
import { resolveIPodTouch4BuildPlan } from "../tools/ipodtouch4-profile.ts";
import { verifyIPodTouch4Package } from "../tools/ipodtouch4-package.ts";
import { parseRuntimeOptions } from "../tools/ipodtouch4-runtime.ts";
import { makeVariant } from "../tools/pocket-pack.ts";

const manifest = JSON.parse(readFileSync(new URL("../apps/clear/pocket.json", import.meta.url), "utf8"));
const plan = resolveIPodTouch4BuildPlan(manifest);
function fixture(mutate?: (variant: ReturnType<typeof makeVariant>) => void) {
  const variant = makeVariant({ target: plan.target.id, hostAbi: plan.target.hostAbi,
    planJson: canonicalJson(plan), identity: { id: plan.app.id, title: plan.app.title, output: plan.app.output },
    js: new TextEncoder().encode("globalThis.frame = () => {};"), pak: new Uint8Array([0]) });
  mutate?.(variant);
  return encodePocketPackage({ manifest: new TextEncoder().encode(JSON.stringify(manifest)), variants: [variant] });
}
test("iPod package re-admits its own manifest and exact target", () => {
  expect(verifyIPodTouch4Package(fixture())).toEqual(plan);
  expect(() => verifyIPodTouch4Package(fixture((v) => { v.target = "3ds-dev"; }))).toThrow("target/ABI");
  expect(() => verifyIPodTouch4Package(fixture((v) => { v.hostAbi = 7; }))).toThrow("target/ABI");
});
test("iPod package rejects changed plans and missing payloads despite a valid container hash", () => {
  expect(() => verifyIPodTouch4Package(fixture((v) => {
    v.sections.find((s) => s.kind === POCKET_SECTION.plan)!.bytes = new TextEncoder().encode(JSON.stringify({ ...plan, planHash: "altered" }));
  }))).toThrow("plan differs");
  expect(() => verifyIPodTouch4Package(fixture((v) => { v.sections = v.sections.filter((s) => s.kind !== POCKET_SECTION.pak); }))).toThrow("section 4");
  expect(() => verifyIPodTouch4Package(fixture((v) => { v.sections.find((s) => s.kind === POCKET_SECTION.js)!.bytes = new Uint8Array([1]); }))).toThrow("terminator");
});
test("Runtime CLI selects USB by default and makes LAN and external package inputs explicit", () => {
  expect(parseRuntimeOptions(["push"])).toMatchObject({ command: "push", app: "clear", lan: false, port: 8131 });
  expect(parseRuntimeOptions(["dev", "--lan", "--no-push", "--app", "clear"])).toMatchObject({ lan: true, noPush: true });
  expect(parseRuntimeOptions(["status", "--host", "192.0.2.1", "--key", "dev.key"])).toMatchObject({ host: "192.0.2.1", lan: true });
  expect(() => parseRuntimeOptions(["push", "--port", "NaN"])).toThrow("port");
  expect(() => parseRuntimeOptions(["push", "--app", "../../etc"])).toThrow("--manifest");
  expect(() => parseRuntimeOptions(["push", "--key"])).toThrow("requires a value");
});
