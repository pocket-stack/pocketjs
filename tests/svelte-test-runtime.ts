// Registers the .svelte / .svelte.ts loaders for Bun's test runner, so a test
// can `await import()` a real component. Kept in one module because Bun's
// plugin registration is process-wide, exactly like tests/vue-vapor-test-runtime.ts.

import { plugin } from "bun";
import { compileSvelte, compileSvelteModule } from "../framework/compiler/svelte-compile.ts";

let installed = false;

export function installSvelteLoader(): void {
  if (installed) return;
  installed = true;
  plugin({
    name: "pocketjs-svelte-test",
    setup(build) {
      build.onLoad({ filter: /\.svelte\.[jt]s$/ }, async (args) => ({
        contents: compileSvelteModule(await Bun.file(args.path).text(), args.path).code,
        loader: "js",
      }));
      build.onLoad({ filter: /\.svelte$/ }, async (args) => ({
        contents: compileSvelte(await Bun.file(args.path).text(), args.path).code,
        loader: "js",
      }));
    },
  });
}
