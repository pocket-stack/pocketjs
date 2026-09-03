import { describe, expect, test } from "bun:test";
import { transformFile } from "../framework/compiler/jsx-plugin.ts";
import { compileSvelte, compileSvelteModule } from "../framework/compiler/svelte-compile.ts";

const COUNTER = `
<script lang="ts">
  import { Text, View } from "@pocketjs/framework/svelte/components";
  let count = $state(0);
</script>

<View class="flex-row gap-3" onPress={() => count++}>
  <Text class="text-base text-white">Count: {count}</Text>
</View>
`;

const compileFails = (source: string): string => {
  try {
    compileSvelte(source, "/virtual/Bad.svelte");
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected compileSvelte to throw");
};

describe("Svelte custom-renderer compilation", () => {
  test("emits the PocketJS renderer as the component's $renderer", () => {
    const result = compileSvelte(COUNTER, "/virtual/Counter.svelte");

    expect(result.code).toContain(
      `import $renderer from '@pocketjs/framework/svelte/renderer'`,
    );
    expect(result.code).toContain("svelte/internal/flags/custom-renderer");
    // init-operations grabs window/document/navigator eagerly; a custom
    // renderer must never pull it in.
    expect(result.code).not.toContain("svelte/internal/init-operations");
    expect(result.code).not.toContain("disclose-version");
  });

  test("keeps static classes and text as string literals for pass-1 collection", () => {
    const result = compileSvelte(COUNTER, "/virtual/Counter.svelte");

    expect(result.code).toContain("flex-row gap-3");
    expect(result.code).toContain("text-base text-white");
    expect(result.code).toContain("Count: ");
  });

  test("runs the compiled component through PocketJS collection", async () => {
    const result = await transformFile("/virtual/Counter.svelte", COUNTER, "svelte");

    expect(result.classStrings).toContain("flex-row gap-3");
    expect(result.classStrings).toContain("text-base text-white");
    expect(result.textCodepoints.has("C".codePointAt(0)!)).toBe(true);
  });

  test("compiles a .svelte.ts runes module and strips its types", () => {
    const result = compileSvelteModule(
      `export const store = $state<{ n: number }>({ n: 0 });`,
      "/virtual/store.svelte.ts",
    );

    expect(result.code).not.toContain("<{ n: number }>");
    expect(result.code).toContain("$.proxy");
  });

  test("a Svelte module demands framework=svelte", async () => {
    await expect(
      transformFile("/virtual/Counter.svelte", COUNTER, "solid"),
    ).rejects.toThrow(/requires framework "svelte"/);
  });
});

describe("PocketJS authoring rules", () => {
  test("<style> blocks are refused", () => {
    expect(compileFails(`<style>.a { color: red }</style><view></view>`)).toContain(
      "<style> blocks aren't supported",
    );
  });

  test("class: and style: directives are refused", () => {
    expect(compileFails(`<view class:on={true}></view>`)).toContain("`class:` directives");
    expect(compileFails(`<view style:color="red"></view>`)).toContain("`style:` directives");
  });

  test("a style attribute names the style prop instead", () => {
    expect(compileFails(`<view style="width: 2px"></view>`)).toContain(
      "<View style={{ width: 10 }} />",
    );
  });

  test("interpolated and clsx-shaped class values are refused", () => {
    expect(compileFails("<view class={`p-${n}`}></view>")).toContain("FULL literals");
    expect(compileFails(`<view class="a {b}"></view>`)).toContain("FULL literals");
    expect(compileFails(`<view class={{ on: true }}></view>`)).toContain("FULL class literals");
    expect(compileFails(`<view class={["a", "b"]}></view>`)).toContain("FULL class literals");
  });

  test("ternaries of full class literals are allowed", () => {
    const result = compileSvelte(
      `<script>let on = $state(true);</script><view class={on ? "p-2 bg-red-500" : "p-2 bg-slate-700"}></view>`,
      "/virtual/Ok.svelte",
    );

    expect(result.code).toContain("p-2 bg-red-500");
    expect(result.code).toContain("p-2 bg-slate-700");
  });

  test("motion and transition imports are refused with the native alternative", () => {
    const message = compileFails(
      `<script>import { spring } from "svelte/motion";</script><view></view>`,
    );

    expect(message).toContain("svelte/motion");
    expect(message).toContain("animate()");
  });

  test("Svelte's own custom-renderer refusals still apply", () => {
    expect(compileFails(`<view bind:this={node}></view>`)).toContain("customRenderer");
    expect(compileFails(`<svelte:window onresize={() => {}} />`)).toContain("customRenderer");
    expect(compileFails(`<view transition:fade></view>`)).toContain("customRenderer");
  });

  test("errors name the file and line", () => {
    expect(compileFails(`<view></view>\n<view style="x"></view>`)).toContain("Bad.svelte:2:");
  });
});
