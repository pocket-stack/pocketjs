# Frameworks

PocketJS supports two first-class app frameworks over the same native tree and
Rust core:

| Framework | Build id | JSX transform | Runtime renderer | Output suffix |
|---|---|---|---|---|
| Solid | `solid` | `babel-preset-solid` universal mode | `renderer-solid.ts` | none |
| Vue Vapor | `vue-vapor` | `vue-jsx-vapor` | `renderer-vue-vapor.ts` | `.vue-vapor` |

Solid is the default so existing apps keep building to `dist/<app>.js` and
`dist/<app>.pak`. Vue Vapor builds next to it:

```sh
bun tools/build.ts hero-main                    # dist/hero-main.js
bun tools/build.ts hero-vue-vapor-main --framework=vue-vapor
# dist/hero-vue-vapor-main.vue-vapor.js
```

There is no environment-variable switch for framework selection. Product
builds declare it in `pocket.json`; low-level compiler work can still use a
project config or one-command override.

## Manifest selection

```json
{
  "app": {
    "framework": "solid"
  }
}
```

Use `"vue-vapor"` for the Vue adapter. `pocket check|compile|build --target …`
resolves this value once and all framework/compiler/native stages consume the same plan.
Do not also put `framework` in `pocket.config.ts` for a manifest build.

## Low-level project config

`pocket.config.ts` is the low-level script default:

```ts
import { definePocketConfig } from "@pocketjs/framework/config";

export default definePocketConfig({
  framework: "solid",
});
```

Use Vue Vapor by changing the file:

```ts
export default definePocketConfig({
  framework: "vue-vapor",
});
```

The direct framework/compiler/dev scripts read the config by default. Use
`--framework=solid` or `--framework=vue-vapor` to override it for one
invocation. `--config=<path>` selects a different config file, and
`--no-config` ignores config entirely.

The same flag works through the dev and PSP entry points:

```sh
bun tools/dev.ts --framework=vue-vapor hero-vue-vapor-main
bun tools/psp.ts hero-vue-vapor --framework=vue-vapor --release
```

## Framework app imports

Apps import state and component lifecycle from the selected framework directly.
PocketJS does not wrap `createSignal`, `ref`, `onMount`, or `onMounted`.

Solid app:

```tsx
import { mount, frameworkName } from "@pocketjs/framework/solid";
import { View, Text, type NodeMirror } from "@pocketjs/framework/solid/components";
import { createSignal, onMount, Show } from "solid-js";

export default function App() {
  const [count, setCount] = createSignal(0);
  let marker: NodeMirror | undefined;

  onMount(() => {
    console.log(frameworkName(), marker?.id);
  });

  return (
    <View class="p-4 flex-col gap-2">
      <Text class="text-base text-slate-950">Framework: {frameworkName()}</Text>
      <View nodeRef={(node) => (marker = node ?? undefined)} focusable onPress={() => setCount(count() + 1)}>
        <Text class="text-sm text-blue-600">Count: {count()}</Text>
      </View>
      <Show when={count() > 2}>
        <Text class="text-sm text-emerald-600">Solid, native tree.</Text>
      </Show>
    </View>
  );
}

mount(() => <App />);
```

Vue Vapor app:

```tsx
import { mount, frameworkName } from "@pocketjs/framework/vue-vapor";
import { View, Text, type NodeMirror } from "@pocketjs/framework/vue-vapor/components";
import { onMounted, ref } from "vue";

export default function App() {
  const count = ref(0);
  let marker: NodeMirror | undefined;

  onMounted(() => {
    console.log(frameworkName(), marker?.id);
  });

  return (
    <View class="p-4 flex-col gap-2">
      <Text class="text-base text-slate-950">Framework: {frameworkName()}</Text>
      <View nodeRef={(node) => (marker = node ?? undefined)} focusable onPress={() => count.value++}>
        <Text class="text-sm text-blue-600">Count: {count.value}</Text>
      </View>
      {count.value > 2 ? (
        <Text class="text-sm text-emerald-600">Vue Vapor, native tree.</Text>
      ) : null}
    </View>
  );
}

mount(App);
```

The generic public subpaths remain Solid-first defaults. Use explicit framework
subpaths when an example or app is tied to a framework:

| Import | Solid build | Vue Vapor build |
|---|---|---|
| `@pocketjs/framework` | `framework/src/index.ts` | `framework/src/index-vue-vapor.ts` |
| `@pocketjs/framework/components` | `framework/src/components.ts` | `framework/src/components-vue-vapor.ts` |
| `@pocketjs/framework/lifecycle` | Solid lifecycle hooks | Vue Vapor lifecycle hooks |

Use `nodeRef` when a component should look similar across framework examples. Solid still supports
`ref`, but `nodeRef` avoids framework-specific ref semantics.

## Explicit framework subpaths

When you intentionally want one framework, import it directly:

```tsx
import { mount } from "@pocketjs/framework/solid";
import { View } from "@pocketjs/framework/solid/components";
```

```tsx
import { mount } from "@pocketjs/framework/vue-vapor";
import { View } from "@pocketjs/framework/vue-vapor/components";
```

Explicit subpaths are useful for framework-specific examples, tests, and
integration code. Most apps should prefer the generic PocketJS subpaths and keep
framework state imports native.

## What stays shared

Both frameworks use the same Tailwind-subset compiler, generated style table,
font atlas baker, `.pak` asset container, host detection, input/focus system,
overlay layer, animation API, PSP/Vita native build paths, browser dev host, and
PPSSPP/Vita3K capture paths. Switching frameworks changes only the JS
component/reactivity layer and renderer adapter.
