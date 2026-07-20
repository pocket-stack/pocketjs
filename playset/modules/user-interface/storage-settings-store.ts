// playset/modules/user-interface/storage-settings-store.ts — typed key/value
// settings persistence: raw readers/writers plus a JSON settings store.
//
// Ported from GameBlocks (github.com/xt4d/GameBlocks, MIT © 2026 Weihao
// Cheng) — modules/user-interface/StorageSettingsStore.js. ONE deliberate
// deviation: the original resolved `window.localStorage` (or null) — a DOM
// dependency PocketJS guests don't have. Here the backend is an injectable
// {getItem/setItem/removeItem} interface and `resolveStorage` falls back to a
// shared in-memory Map backend, so settings survive within a session by
// default. Hosts can inject a persistent backend (e.g. via the effect shell's
// storage capability) later without touching callers. All parsing/merging
// semantics are verbatim.

export interface StorageBackend {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export class MemoryStorageBackend implements StorageBackend {
  private items = new Map<string, string>();

  getItem(key: string): string | null {
    return this.items.has(key) ? (this.items.get(key) as string) : null;
  }

  setItem(key: string, value: string): void {
    this.items.set(key, String(value));
  }

  removeItem(key: string): void {
    this.items.delete(key);
  }
}

/** Shared default backend — plays the role window.localStorage did. */
export const DEFAULT_MEMORY_STORAGE = new MemoryStorageBackend();

export function resolveStorage(storage: StorageBackend | null = null): StorageBackend {
  if (storage) return storage;
  return DEFAULT_MEMORY_STORAGE;
}

export function readStorageItem(storage: StorageBackend | null, key: string): string | null {
  if (!storage || !key) return null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStorageItem(storage: StorageBackend | null, key: string, value: string): boolean {
  if (!storage || !key) return false;
  try {
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function readBoolean(raw: string | null | undefined, fallback = false): boolean {
  if (raw == null) return fallback;
  if (raw === "true" || raw === "1" || raw === "on") return true;
  if (raw === "false" || raw === "0" || raw === "off") return false;
  return fallback;
}

export function readInteger(raw: string | null | undefined, fallback = 0): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function readJsonStorageItem<T>(storage: StorageBackend | null, key: string, fallback: T | null = null): T | null {
  const raw = readStorageItem(storage, key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export class JsonSettingsStore<T extends Record<string, unknown> = Record<string, unknown>> {
  storage: StorageBackend;
  storageKey: string;
  defaults: T;
  settings: T;

  constructor(storage: StorageBackend | null = null, storageKey = "", defaults: T = {} as T) {
    this.storage = resolveStorage(storage);
    this.storageKey = storageKey;
    this.defaults = { ...defaults };
    this.settings = { ...defaults };
  }

  load(): T {
    const saved = readJsonStorageItem<Partial<T>>(this.storage, this.storageKey, null);
    if (saved && typeof saved === "object") {
      this.settings = {
        ...this.settings,
        ...saved,
      };
    }
    return this.settings;
  }

  save(): T {
    writeStorageItem(this.storage, this.storageKey, JSON.stringify(this.settings));
    return this.settings;
  }

  update(nextSettings: Partial<T> = {}): T {
    this.settings = {
      ...this.settings,
      ...nextSettings,
    };
    return this.settings;
  }
}
