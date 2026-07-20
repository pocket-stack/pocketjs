// playset/modules/user-interface/ui-state-model.ts — observable flat UI state:
// patch/replace with per-key equality; listeners get (snapshot, changedKeys).
//
// Ported from GameBlocks (github.com/xt4d/GameBlocks, MIT © 2026 Weihao
// Cheng) — modules/user-interface/UiStateModel.js. Verbatim semantics; adds
// createUiSignal(), a Solid bridge (model.subscribe → signal) so PocketJS
// HUDs consume snapshots idiomatically.

import { createSignal, getOwner, onCleanup } from "solid-js";

export type UiState = Record<string, unknown>;
export type UiStateListener<T extends UiState> = (state: T, changedKeys: string[]) => void;
export type UiStateEquality = (a: unknown, b: unknown) => boolean;

function cloneState<T extends UiState>(state: T): T {
  return { ...state };
}

export class UiStateModel<T extends UiState = UiState> {
  state: T;
  emitInitial: boolean;
  equality: UiStateEquality;
  listeners: Set<UiStateListener<T>>;

  constructor(
    initialState: T = {} as T,
    emitInitial = false,
    equality: UiStateEquality = Object.is,
  ) {
    this.state = cloneState(initialState);
    this.emitInitial = emitInitial;
    this.equality = equality;
    this.listeners = new Set();
  }

  getState(): T {
    return cloneState(this.state);
  }

  subscribe(listener: UiStateListener<T>, emitInitial: boolean = this.emitInitial): () => boolean {
    if (typeof listener !== "function") {
      throw new Error("UiStateModel.subscribe: listener must be a function");
    }

    this.listeners.add(listener);
    if (emitInitial) {
      listener(this.getState(), Object.keys(this.state));
    }

    return () => this.listeners.delete(listener);
  }

  patch(partialState: Partial<T> = {}): string[] {
    const nextState = cloneState(this.state) as UiState;
    const changedKeys: string[] = [];

    for (const [key, value] of Object.entries(partialState)) {
      if (this.equality((this.state as UiState)[key], value)) continue;
      nextState[key] = value;
      changedKeys.push(key);
    }

    if (changedKeys.length === 0) return [];

    this.state = nextState as T;
    const snapshot = this.getState();
    for (const listener of this.listeners) {
      listener(snapshot, changedKeys);
    }

    return changedKeys;
  }

  replace(nextState: T = {} as T): string[] {
    const keys = new Set([...Object.keys(this.state), ...Object.keys(nextState)]);
    const changedKeys: string[] = [];

    for (const key of keys) {
      if (this.equality((this.state as UiState)[key], (nextState as UiState)[key])) continue;
      changedKeys.push(key);
    }

    if (changedKeys.length === 0) return [];

    this.state = cloneState(nextState);
    const snapshot = this.getState();
    for (const listener of this.listeners) {
      listener(snapshot, changedKeys);
    }

    return changedKeys;
  }
}

/**
 * Bridge a UiStateModel to a Solid accessor: the returned signal tracks every
 * emitted snapshot. Unsubscribes with the owning reactive scope when one
 * exists (safe to call outside an owner for ad-hoc use — then the caller keeps
 * the model alive).
 */
export function createUiSignal<T extends UiState>(model: UiStateModel<T>): () => T {
  const [state, setState] = createSignal<T>(model.getState());
  const unsubscribe = model.subscribe((snapshot) => setState(() => snapshot));
  if (getOwner()) onCleanup(() => unsubscribe());
  return state;
}
