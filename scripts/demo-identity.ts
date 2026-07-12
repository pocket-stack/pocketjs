export interface DemoIdentity {
  readonly id: string;
  readonly name: string;
  readonly title: string;
}

/** Stable manifest identity used by every stock-demo entry point. */
export function demoIdentity(demo: string): DemoIdentity {
  const normalized = demo.replace(/-main$/, "");
  return {
    id: `dev.pocket-stack.${normalized.replace(/-/g, ".")}`,
    name: `pocketjs-${normalized}`,
    title: `PocketJS ${normalized}`,
  };
}
