// Octane renderer over the native `ui.*` tree.
//
// Octane's universal client target compiles JSX into immutable host plans
// plus dynamic value slots and executes them against a UniversalHostDriver
// (no DOM, no virtual DOM). This module is the renderer that compiled
// modules import — the compiler descriptor's `module` id resolves here — so
// it re-exports the host-neutral universal ABI (hooks, plan helpers,
// hookSlots/withSlot) and implements the driver that maps universal host
// command batches onto the shared NodeMirror arena in native-tree.ts.

export * from "octane/universal/native";

import { profiler } from "octane/profiling";
import {
  createUniversalRoot,
  type UniversalComponent,
  type UniversalHostDriver,
  type UniversalHostParent,
  type UniversalRoot,
} from "octane/universal/native";
import { ENUMS, SCREEN_H, SCREEN_W } from "../../contracts/spec/spec.ts";
import {
  applyProps,
  createElement,
  createTextNode,
  insertNode,
  removeNode,
  replaceText,
  setProp,
  type HostProps,
  type NodeMirror,
} from "./native-tree.ts";
import { getOverlayRoot } from "./overlay.ts";

export {
  createElement,
  createTextNode,
  detachNode,
  getFirstChild,
  getNextSibling,
  getParentNode,
  insertNode,
  isTextNode,
  missCounters,
  registerSprite,
  registerTexture,
  release,
  removeNode,
  replaceText,
  resetRendererState,
  resetSprites,
  resetTextures,
  retain,
  rootMirror,
  runSweep,
  setProp,
  setStyleResolver,
  type HostProps,
  type NodeMirror,
} from "./native-tree.ts";

/** Renderer alias used by the compiler descriptor and every compiled plan. */
export const OCTANE_RENDERER_ID = "pocket";

// ---------------------------------------------------------------------------
// Portal targets
// ---------------------------------------------------------------------------
// <Portal>/<Modal>/<ActionBar> pass this marker as the createPortal target.
// The driver materializes one full-screen absolute view under the overlay
// root when the portal registration is prepared, and removes it exactly once
// when the registration is released (retarget, unmount, abort).

const OVERLAY_TARGET = Symbol.for("pocketjs.octane.overlay-target");

export interface OverlayPortalTarget {
  readonly [OVERLAY_TARGET]: true;
}

export function overlayPortalTarget(): OverlayPortalTarget {
  return { [OVERLAY_TARGET]: true } as OverlayPortalTarget;
}

function isOverlayTarget(value: unknown): value is OverlayPortalTarget {
  return (
    !!value &&
    typeof value === "object" &&
    (value as Record<symbol, unknown>)[OVERLAY_TARGET] === true
  );
}

function isNodeMirrorTarget(value: unknown): value is NodeMirror {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as NodeMirror).id === "number" &&
    Array.isArray((value as NodeMirror).children)
  );
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

interface PocketContainer {
  root: NodeMirror;
  mirrors: Map<number, NodeMirror>;
  committedProps: Map<number, HostProps>;
  portalHosts: Map<string | number, NodeMirror>;
}

let portalTargetSeq = 0;

function textValue(props: Readonly<Record<string, unknown>>): string {
  const value = props.value;
  return value == null ? "" : String(value);
}

function createPocketDriver(): UniversalHostDriver<PocketContainer, NodeMirror> {
  return {
    id: OCTANE_RENDERER_ID,
    capabilities: { text: "host" },
    portals: {
      prepareTarget(context) {
        const container = context.container;
        const target = context.target;
        if (context.transported) {
          throw new Error("PocketJS: octane portal targets never cross a transport");
        }
        let host: NodeMirror;
        let owned = false;
        if (isOverlayTarget(target)) {
          host = createElement("view");
          setProp(
            host,
            "style",
            {
              width: SCREEN_W,
              height: SCREEN_H,
              posType: ENUMS.PosType.Absolute,
              insetT: 0,
              insetR: 0,
              insetB: 0,
              insetL: 0,
              zIndex: 1000,
            },
            undefined,
          );
          insertNode(getOverlayRoot(), host);
          owned = true;
        } else if (isNodeMirrorTarget(target)) {
          host = target;
        } else {
          throw new Error(
            "PocketJS: octane portal target must be overlayPortalTarget() or a NodeMirror",
          );
        }
        const id = ++portalTargetSeq;
        const handle = context.createPortalTargetHandle(id);
        container.portalHosts.set(id, host);
        return {
          handle,
          release() {
            container.portalHosts.delete(id);
            if (owned && host.parent) removeNode(host.parent, host);
          },
        };
      },
    },
    prepareBatch(container, batch) {
      if (batch.renderer !== OCTANE_RENDERER_ID) {
        throw new Error(
          `PocketJS: octane driver renderer mismatch (batch=${JSON.stringify(batch.renderer)})`,
        );
      }
      const { mirrors, committedProps, portalHosts } = container;
      const resolveParent = (parent: UniversalHostParent): NodeMirror => {
        if (parent === null) return container.root;
        if (typeof parent === "number") {
          const mirror = mirrors.get(parent);
          if (!mirror) throw new Error(`PocketJS: octane driver unknown parent ${parent}`);
          return mirror;
        }
        const host = portalHosts.get(parent.id);
        if (!host) throw new Error(`PocketJS: octane driver unknown portal target ${String(parent.id)}`);
        return host;
      };
      const resolve = (id: number): NodeMirror => {
        const mirror = mirrors.get(id);
        if (!mirror) throw new Error(`PocketJS: octane driver unknown node ${id}`);
        return mirror;
      };
      let applied = false;
      return {
        apply() {
          if (applied) return;
          applied = true;
          for (const command of batch.commands) {
            applyCommand(command);
          }
        },
        abort() {
          // Nothing staged outside apply(): host mutation happens only on
          // acceptance, so an aborted attempt has nothing to release.
        },
      };
      function applyCommand(command: (typeof batch.commands)[number]): void {
            switch (command.op) {
              case "create": {
                if (mirrors.has(command.id)) {
                  throw new Error(`PocketJS: octane driver duplicate node ${command.id}`);
                }
                let mirror: NodeMirror;
                if (command.type === "#text") {
                  mirror = createTextNode(textValue(command.props));
                } else {
                  mirror = createElement(command.type);
                  applyProps(mirror, command.props as HostProps);
                }
                mirrors.set(command.id, mirror);
                committedProps.set(command.id, command.props as HostProps);
                break;
              }
              case "update": {
                const mirror = resolve(command.id);
                const prev = committedProps.get(command.id) ?? {};
                if (mirror.domTag === "#text") {
                  const next = textValue(command.props);
                  if (next !== mirror.text) replaceText(mirror, next);
                } else {
                  applyProps(mirror, command.props as HostProps, prev);
                }
                committedProps.set(command.id, command.props as HostProps);
                break;
              }
              case "insert":
              case "move": {
                const parent = resolveParent(command.parent);
                const before = command.before === null ? null : resolve(command.before);
                insertNode(parent, resolve(command.id), before);
                break;
              }
              case "remove": {
                removeNode(resolveParent(command.parent), resolve(command.id));
                break;
              }
              case "destroy": {
                // removeNode already queued the detached subtree for the
                // end-of-frame sweep (native destroyNode frees whole trees);
                // the driver only drops its records.
                mirrors.delete(command.id);
                committedProps.delete(command.id);
                break;
              }
              default:
                throw new Error(
                  `PocketJS: octane driver does not implement host command '${command.op}'`,
                );
            }
      }
    },
    getPublicInstance(container, id) {
      return container.mirrors.get(id) ?? null;
    },
  };
}

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

export type OctaneRenderRoot = UniversalComponent<Record<string, never>>;

let activeRoot: UniversalRoot | null = null;

/** The universal root of the mounted app (input/event plumbing hooks). */
export function getActiveOctaneRoot(): UniversalRoot | null {
  return activeRoot;
}

export function render(code: OctaneRenderRoot, root: NodeMirror): () => void {
  // Builds alias octane/profiling to the no-op stub (jsx-plugin), so these
  // are belt-and-braces for unbundled paths (unit imports without the
  // plugin): the real profiler's per-render records otherwise pin render
  // graphs under the pinned QuickJS's non-ephemeron weak marking.
  profiler.stop();
  profiler.clear();
  const container: PocketContainer = {
    root,
    mirrors: new Map(),
    committedProps: new Map(),
    portalHosts: new Map(),
  };
  const universalRoot = createUniversalRoot<PocketContainer, NodeMirror>(
    container,
    createPocketDriver(),
  );
  activeRoot = universalRoot;
  const attempt = universalRoot.render(code, {});
  if (attempt.status === "suspended") {
    attempt.abort();
    throw new Error("PocketJS: octane render() suspended at mount — Suspense-on-boot is not supported");
  }
  return () => {
    if (activeRoot === universalRoot) activeRoot = null;
    universalRoot.unmount();
  };
}
