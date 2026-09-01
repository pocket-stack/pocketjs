interface MockVaporNode {
  id: number;
  parent: MockVaporNode | null;
  children: MockVaporNode[];
}

function isMockVaporNode(value: unknown): value is MockVaporNode {
  return typeof value === "object" &&
    value !== null &&
    typeof (value as Partial<MockVaporNode>).id === "number" &&
    Array.isArray((value as Partial<MockVaporNode>).children);
}

function insertMockVaporBlock(block: unknown, parent: MockVaporNode): void {
  if (typeof block === "function" && block.length === 0) {
    insertMockVaporBlock((block as () => unknown)(), parent);
    return;
  }
  if (Array.isArray(block)) {
    for (const child of block) insertMockVaporBlock(child, parent);
    return;
  }
  if (!isMockVaporNode(block)) return;
  if (block.parent) {
    const oldIndex = block.parent.children.indexOf(block);
    if (oldIndex >= 0) block.parent.children.splice(oldIndex, 1);
  }
  block.parent = parent;
  parent.children.push(block);
}

function removeMockVaporBlock(block: unknown, parent: MockVaporNode): void {
  if (Array.isArray(block)) {
    for (const child of block) removeMockVaporBlock(child, parent);
    return;
  }
  if (!isMockVaporNode(block)) return;
  const index = parent.children.indexOf(block);
  if (index >= 0) parent.children.splice(index, 1);
  block.parent = null;
}

/**
 * One shared Vue Vapor test double so Bun's process-wide module mock cannot
 * make behavior depend on which test file registers `vue` first.
 */
export function createVueVaporTestRuntime() {
  return {
    computed<T>(read: () => T) {
      return { get value() { return read(); } };
    },
    createVaporApp(component: { setup?: () => unknown }) {
      let root: MockVaporNode | undefined;
      let block: unknown;
      return {
        mount(nextRoot: MockVaporNode) {
          root = nextRoot;
          block = component.setup?.();
          insertMockVaporBlock(block, root);
        },
        unmount() {
          if (root) removeMockVaporBlock(block, root);
          root = undefined;
          block = undefined;
        },
      };
    },
    defineVaporComponent<T>(setup: T): T {
      return setup;
    },
    insert: insertMockVaporBlock,
    onScopeDispose() {},
    remove: removeMockVaporBlock,
    shallowRef<T>(value: T) {
      return { value };
    },
    watchEffect(run: () => void) {
      run();
      return () => {};
    },
  };
}
