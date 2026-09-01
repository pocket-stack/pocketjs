import type { NodeMirror } from "./renderer.ts";

let overlayRoot: NodeMirror | null = null;

export function setOverlayRoot(root: NodeMirror | null): void {
  overlayRoot = root;
}

export function getOverlayRoot(): NodeMirror {
  if (!overlayRoot) {
    throw new Error("PocketJS: overlay root is not installed");
  }
  return overlayRoot;
}
