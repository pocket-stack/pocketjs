// playset/modules/user-interface/notification-queue.ts — capped visible-toast
// queue (pending promotion, sticky, per-item lifetimes) plus an expiring
// message feed, both driven by an injected Clock.
//
// Ported from GameBlocks (github.com/xt4d/GameBlocks, MIT © 2026 Weihao
// Cheng) — modules/user-interface/NotificationQueue.js. Verbatim semantics.

import { DEFAULT_CLOCK, type Clock } from "../math/time-utils.ts";

export interface NotificationItem extends Record<string, unknown> {
  id: number | string;
  content: unknown;
  type: string;
  sticky: boolean;
  lifetimeMs: number;
  createdAt: number;
  shownAt: number;
  expiresAt: number;
}

export type NotificationListener = (visible: NotificationItem[]) => void;

function cloneItem<T extends Record<string, unknown>>(item: T): T {
  return { ...item };
}

export class NotificationQueue {
  clock: Clock;
  maxVisible: number;
  defaultLifetimeMs: number;
  idPrefix: string | null;
  currentTimeMs: number;
  pending: NotificationItem[];
  visible: NotificationItem[];
  listeners: Set<NotificationListener>;
  nextId: number;

  constructor(
    maxVisible = 3,
    defaultLifetimeMs = 1500,
    idPrefix: string | null = null,
    clock: Clock = DEFAULT_CLOCK,
  ) {
    this.clock = clock;
    this.maxVisible = Math.max(1, Math.floor(maxVisible));
    this.defaultLifetimeMs = Math.max(0, defaultLifetimeMs);
    this.idPrefix = idPrefix;
    this.currentTimeMs = this.readNow();
    this.pending = [];
    this.visible = [];
    this.listeners = new Set();
    this.nextId = 1;
  }

  readNow(): number {
    return this.clock.now();
  }

  setTime(nowMs: number = this.readNow()): number {
    this.currentTimeMs = nowMs;
    return this.currentTimeMs;
  }

  syncClock(): number {
    return this.setTime(this.readNow());
  }

  subscribe(listener: NotificationListener, emitInitial = false): () => boolean {
    if (typeof listener !== "function") {
      throw new Error("NotificationQueue.subscribe: listener must be a function");
    }

    this.listeners.add(listener);
    if (emitInitial) listener(this.getVisible());
    return () => this.listeners.delete(listener);
  }

  _emit(): void {
    const visible = this.getVisible();
    for (const listener of this.listeners) listener(visible);
  }

  _createId(): number | string {
    const id = this.idPrefix == null ? this.nextId : `${this.idPrefix}${this.nextId}`;
    this.nextId += 1;
    return id;
  }

  _promote(): void {
    while (this.visible.length < this.maxVisible && this.pending.length > 0) {
      const item = this.pending.shift() as NotificationItem;
      item.shownAt = this.currentTimeMs;
      item.expiresAt = item.sticky ? 0 : this.currentTimeMs + item.lifetimeMs;
      this.visible.push(item);
    }
  }

  add(
    content: unknown,
    type = "info",
    lifetimeMs: number = this.defaultLifetimeMs,
    sticky = false,
    extra: Record<string, unknown> = {},
  ): NotificationItem {
    const item = {
      id: this._createId(),
      content,
      type,
      sticky: Boolean(sticky),
      lifetimeMs: lifetimeMs,
      createdAt: this.currentTimeMs,
      shownAt: 0,
      expiresAt: 0,
      ...extra,
    } as NotificationItem;

    this.pending.push(item);
    this._promote();
    this._emit();
    return cloneItem(item);
  }

  remove(id: number | string): boolean {
    const visibleIndex = this.visible.findIndex((item) => item.id === id);
    if (visibleIndex >= 0) {
      this.visible.splice(visibleIndex, 1);
      this._promote();
      this._emit();
      return true;
    }

    const pendingIndex = this.pending.findIndex((item) => item.id === id);
    if (pendingIndex >= 0) {
      this.pending.splice(pendingIndex, 1);
      this._emit();
      return true;
    }

    return false;
  }

  clear(): void {
    this.pending = [];
    this.visible = [];
    this._emit();
  }

  expire(): NotificationItem[] {
    this.visible = this.visible.filter((item) => {
      if (item.sticky) return true;
      return item.expiresAt > this.currentTimeMs;
    });
    this._promote();
    this._emit();
    return this.getVisible();
  }

  tick(deltaMs = 0): NotificationItem[] {
    const safeDelta = Math.max(0, deltaMs);
    this.currentTimeMs += safeDelta;
    return this.expire();
  }

  tickAt(nowMs: number = this.readNow()): NotificationItem[] {
    this.setTime(nowMs);
    return this.expire();
  }

  getVisible(): NotificationItem[] {
    return this.visible.map(cloneItem);
  }

  getPending(): NotificationItem[] {
    return this.pending.map(cloneItem);
  }

  dispose(): void {
    this.clear();
    this.listeners.clear();
  }
}

export interface FeedMessage extends Record<string, unknown> {
  messageId: string;
  text: unknown;
  kind: string;
  atMs: number;
  expiresAtMs: number;
}

export type FeedListener = (messages: FeedMessage[]) => void;

export class ExpiringMessageFeed {
  clock: Clock;
  lingerMs: number;
  maxEntries: number;
  idPrefix: string;
  sequence: number;
  messages: FeedMessage[];
  listeners: Set<FeedListener>;

  constructor(lingerMs = 3000, maxEntries = 6, idPrefix = "message-", clock: Clock = DEFAULT_CLOCK) {
    this.clock = clock;
    this.lingerMs = lingerMs;
    this.maxEntries = maxEntries;
    this.idPrefix = idPrefix;
    this.sequence = 0;
    this.messages = [];
    this.listeners = new Set();
  }

  subscribe(listener: FeedListener): () => boolean {
    if (typeof listener !== "function") {
      throw new Error("ExpiringMessageFeed.subscribe: listener must be a function");
    }

    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  _notify(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }

  push(
    text: unknown,
    kind = "info",
    atMs: number = this.clock.now(),
    lingerMs: number = this.lingerMs,
    extra: Record<string, unknown> = {},
  ): FeedMessage {
    this.sequence += 1;
    const message = {
      messageId: `${this.idPrefix}${this.sequence}`,
      text,
      kind,
      atMs,
      expiresAtMs: atMs + lingerMs,
      ...extra,
    } as FeedMessage;

    this.messages.unshift(message);
    this.messages = this.messages.slice(0, this.maxEntries);
    this._notify();
    return cloneItem(message);
  }

  tick(nowMs: number = this.clock.now()): FeedMessage[] {
    this.messages = this.messages.filter((message) => nowMs < message.expiresAtMs);
    this._notify();
    return this.snapshot();
  }

  clear(): void {
    this.messages = [];
    this._notify();
  }

  snapshot(): FeedMessage[] {
    return this.messages.map(cloneItem);
  }
}
