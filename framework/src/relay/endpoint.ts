/** Relay composed endpoint — the L1 session, the P3 queue/credit machines
 * and the L2 resource layer as one object over one transport.
 *
 * Each layer stays a library; this file is the wiring the wire adapter
 * (`tools/relay-wire.ts`) and a device host instantiate:
 *
 *   send:    L2 client/authority -> RelaySender.admit (credit admission,
 *            bounded queue) -> pump (seq at selection) -> ordered outbox
 *            -> transport.trySend
 *   receive: transport record -> RelaySession.handleRecord (decode, session
 *            pin, per-stream seq) -> RelayReceiver.ingest (window
 *            occupancy) -> pumpReceive -> L2 client/authority -> release
 *            (credit returns) -> relay.credit rides the sideband back
 *
 * The session's own control frames after the bootstrap (READY, OPEN,
 * PING/pong) enter the same sender through `admitControl`: OPEN and READY
 * consume the stream-0 control slice, ping and pong ride the sideband. The
 * HELLO exchange on session 0 goes straight to the outbox. Inbound stream-0
 * records the session consumes itself return their control-slice credit
 * through `onControlFrame`; sideband records (credit, ping, reset, CANCEL)
 * earn none. Inbound business frames on opened streams go through the
 * receiver's per-stream window and are delivered by pumpReceive().
 *
 * Per-session state (sender, receiver, request table, client or authority)
 * is built when the session is pinned and dropped when it ends; a
 * reconnect starts from a fresh set with seq, credit and correlation at
 * their initial values (draft §3.2 step 4).
 *
 * Bounded demand (§3.9): a request the window cannot admit is refused BUSY
 * to the caller, who keeps it. The provider's prepared envelopes (chunks of
 * one object, a push, an invalidate) wait in a per-stream FIFO until credit
 * admits them; every entry belongs to one accepted request or one active
 * subscription, so the FIFO is bounded by admitted work, not by peer
 * input. Frames stamped with a seq that a busy transport did not take wait
 * in the ordered outbox, whose size is one pump batch plus the bootstrap
 * frame. */

import {
  RELAY_CODEC,
  RELAY_ERROR,
  RELAY_LIMITS,
  RELAY_OP,
  RELAY_TYPE,
  type RelayResourceRef,
  type RelayRxLimits,
} from "../../../contracts/spec/relay.ts";
import type { ResourceResult } from "../resource-cache.ts";
import { RelayChunkAssembler } from "./assembler.ts";
import {
  RELAY_P3_ERROR,
  RELAY_PRIORITY,
  RelayCreditTable,
  RelayReceiver,
  RelayRequestTable,
  RelaySender,
  RelaySideband,
  isSidebandFrame,
  type P3Result,
  type RelayReceived,
  type RelayRequestState,
  type RelayStreamAlloc,
} from "./credit.ts";
import type { RelayDecodedFrame } from "./frame.ts";
import { validateRelayMetadata } from "./metadata.ts";
import {
  RelayResourceAuthority,
  RelayResourceClient,
  type RelayGetOutcome,
  type RelayResourceEnvelope,
  type RelayResourceIncomingFrame,
  type RelayResourceWire,
  type RelaySubscriptionHandler,
} from "./resource.ts";
import {
  createRelaySession,
  type RelayControlAdmission,
  type RelayLocalCapabilities,
  type RelayNegotiation,
  type RelayOpenRequest,
  type RelayOpenResult,
  type RelayPeerContext,
  type RelayPhase,
  type RelayRandomBytes,
  type RelayScheduler,
  type RelaySendStatus,
  type RelaySession,
  type RelayTransportAdapter,
} from "./session.ts";

// --- public types --------------------------------------------------------------

/** A REQUEST the provider endpoint hands to the application. */
export interface RelayIncomingRequest {
  stream: number;
  correlation: number;
  op: string;
  metadata: Record<string, unknown>;
  /** View over the record's data region; copy to keep it past the call. */
  data: Uint8Array;
  codec: number;
  /** True once the peer sent request.cancel for this correlation. The
   * request still needs its one terminal (§3.6). */
  cancelRequested(): boolean;
}

export interface RelayEndpointHooks {
  onPhase?: (phase: RelayPhase, detail?: { reason?: string }) => void;
  /** Provider: return a RELAY_ERROR code to refuse an OPEN, or null. */
  authorizeOpen?: (req: RelayOpenRequest, peer: RelayPeerContext) => string | null;
  /** A stream binding and its window slice exist on this end. */
  onStreamOpened?: (result: RelayOpenResult) => void;
  /** A peer fault the endpoint dropped a frame for or ended the session
   * on; `code` is a RELAY_P3_ERROR / RELAY_ERROR / RELAY_FRAME_ERROR value. */
  onProtocolError?: (code: string, detail: string) => void;
  /** A business stream was reset (seq gap resync, peer reset, local reset). */
  onStreamReset?: (stream: number, reason: string) => void;
  /** Provider: a schema-valid resource.get. Answer with replyObject(),
   * replyNotModified() or replyError(); without the hook the endpoint
   * answers UNSUPPORTED. */
  onGet?: (request: RelayIncomingRequest) => void;
  /** Provider: a REQUEST op the endpoint does not answer itself. Return
   * true when the application took it (and will answer through respond());
   * false answers UNSUPPORTED. */
  onRequest?: (request: RelayIncomingRequest) => boolean;
  /** Provider: an inbound CANCEL; the request is marked, the application
   * decides between the in-flight success terminal and CANCELLED/none. */
  onCancel?: (cancel: { targetStream: number; correlation: number; reason: string; request: RelayRequestState | undefined }) => void;
  /** Provider: a consumer cache.evict advisory; no ACK exists (R5 Q5). */
  onEvict?: (metadata: Record<string, unknown>) => void;
}

export interface RelayEndpointOptions {
  role: "guest" | "provider";
  transport: RelayTransportAdapter;
  local: RelayLocalCapabilities;
  hooks?: RelayEndpointHooks;
  scheduler?: RelayScheduler;
  randomBytes?: RelayRandomBytes;
  pingIntervalMs?: number;
  stallMs?: number;
  retryMs?: number;
  /** Normal frames one send pump selects (§3.9: a guest submits at most 2
   * per logical frame; the sender's default). flush() repeats pumps until
   * the window, the queues or the transport stop it. */
  framesPerPump?: number;
  bytesPerPump?: number;
  /** Request slots kept free for input/control (§3.9 recommends 2 of 8);
   * resource requests are refused BUSY inside the reserve. Default 0. */
  requestReserve?: number;
  /** Frames the ordered outbox holds for a busy transport before the
   * session's own bootstrap send is refused busy. Default 32. */
  outboxFrames?: number;
}

/** The per-session machines, for tests and diagnostics. */
export interface RelayEndpointInspection {
  session: bigint;
  negotiation: RelayNegotiation;
  sender: RelaySender;
  receiver: RelayReceiver;
  requests: RelayRequestTable;
  creditTable: RelayCreditTable;
  allocations: ReadonlyMap<number, RelayStreamAlloc>;
  client?: RelayResourceClient;
  assembler?: RelayChunkAssembler;
  authority?: RelayResourceAuthority;
  /** Provider envelopes waiting for window credit, per stream. */
  demand: ReadonlyMap<number, readonly RelayResourceEnvelope[]>;
  outboxFrames: number;
}

// --- per-session state ----------------------------------------------------------

interface Bound {
  session: bigint;
  negotiation: RelayNegotiation;
  sideband: RelaySideband;
  creditTable: RelayCreditTable;
  sender: RelaySender;
  /** Inbound window grants: stream 0's control slice plus one slice per
   * opened stream. The receiver reads this map. */
  allocations: Map<number, RelayStreamAlloc>;
  receiver: RelayReceiver;
  requests: RelayRequestTable;
  assembler?: RelayChunkAssembler;
  client?: RelayResourceClient;
  authority?: RelayResourceAuthority;
  demand: Map<number, RelayResourceEnvelope[]>;
  /** Sideband controls the lane refused (SIDEBAND_FULL): retried on the next
   * flush. Bounded by pending requests (cancels) plus streams (resets). */
  pendingSideband: Array<() => P3Result>;
  streamsByNs: Map<string, number>;
}

/** Stream 0's slice of the attachment window: a quarter, capped by the §3.9
 * control proposal (the RelaySender default, written out so the receiver
 * side of the peer computes the same value). */
export function relayControlSlice(limits: RelayRxLimits): RelayStreamAlloc {
  return {
    frames: Math.max(1, Math.min(RELAY_LIMITS.controlWindowFrames, Math.floor(limits.windowFrames / 4))),
    bytes: Math.max(1, Math.min(RELAY_LIMITS.controlWindowBytes, Math.floor(limits.windowBytes / 4))),
  };
}

/** A newly opened stream takes the OPEN response's per-stream window,
 * capped by what the attachment window has left after stream 0 and the
 * live streams opened before it. Both ends see the same OPEN responses and
 * resets in the same order, so both compute the same slice; a reset stream
 * returns its slice (its id never reopens within a session). */
export function relayStreamSlice(
  attachment: RelayRxLimits,
  allocated: Iterable<RelayStreamAlloc>,
  opened: RelayRxLimits,
): RelayStreamAlloc {
  let frames = 0;
  let bytes = 0;
  for (const a of allocated) { frames += a.frames; bytes += a.bytes; }
  return {
    frames: Math.min(opened.windowFrames, attachment.windowFrames - frames),
    bytes: Math.min(opened.windowBytes, attachment.windowBytes - bytes),
  };
}

const priorityFor = (type: number) => type === RELAY_TYPE.INVALIDATE ? RELAY_PRIORITY.CONTROL : RELAY_PRIORITY.VISIBLE;

// --- the endpoint -----------------------------------------------------------------

export class RelayEndpoint {
  readonly session: RelaySession;
  readonly role: "guest" | "provider";
  private readonly transport: RelayTransportAdapter;
  private readonly hooks: RelayEndpointHooks;
  private readonly outbox: Uint8Array[] = [];
  private readonly outboxCap: number;
  private readonly requestReserve: number;
  private bound: Bound | null = null;
  private flushing = false;
  private flushAgain = false;
  private flushScheduled = false;
  private protocolErrorCount = 0;

  /** The L2 seam the resource client calls; every call lands in the P3
   * sender, never on the transport. */
  private readonly wire: RelayResourceWire = {
    request: (stream, metadata, data, codec) => this.wireRequest(stream, metadata, data, codec),
    advise: (metadata) => this.wireAdvise(metadata),
    cancel: (stream, correlation, reason) => this.wireCancel(stream, correlation, reason ?? "cancel"),
  };

  constructor(private readonly options: RelayEndpointOptions) {
    this.role = options.role;
    this.transport = options.transport;
    this.hooks = options.hooks ?? {};
    this.outboxCap = options.outboxFrames ?? 32;
    this.requestReserve = options.requestReserve ?? 0;
    this.session = createRelaySession({
      role: options.role,
      local: options.local,
      transport: { peer: options.transport.peer, trySend: (bytes) => this.trySendDirect(bytes) },
      scheduler: options.scheduler,
      randomBytes: options.randomBytes,
      pingIntervalMs: options.pingIntervalMs,
      stallMs: options.stallMs,
      retryMs: options.retryMs,
      authorizeOpen: this.hooks.authorizeOpen,
      onPhase: (phase, detail) => this.onPhase(phase, detail),
      onBusinessFrame: (frame, wireBytes) => this.onBusinessFrame(frame, wireBytes),
      onCredit: (metadata) => this.onCredit(metadata),
      onReset: (metadata) => this.onPeerReset(metadata),
      onStreamError: (stream, code) => this.onStreamError(stream, code),
      admitControl: (input) => this.admitControl(input),
      onControlFrame: (frame, wireBytes) => this.onControlFrame(frame, wireBytes),
      onCancel: (frame) => this.onPeerCancel(frame),
      onStreamOpened: (opened) => this.onStreamOpened(opened),
    });
  }

  get phase(): RelayPhase { return this.session.phase; }
  get peer(): RelayPeerContext { return this.transport.peer; }
  get negotiation(): RelayNegotiation | undefined { return this.session.negotiation; }
  /** The current session's resource client (guest); undefined before the
   * session is pinned and after it ends. */
  get client(): RelayResourceClient | undefined { return this.bound?.client; }
  /** The current session's authority (provider). */
  get authority(): RelayResourceAuthority | undefined { return this.bound?.authority; }
  get protocolErrors(): number { return this.protocolErrorCount; }

  inspect(): RelayEndpointInspection | undefined {
    const b = this.bound;
    if (!b) return undefined;
    return {
      session: b.session, negotiation: b.negotiation, sender: b.sender, receiver: b.receiver,
      requests: b.requests, creditTable: b.creditTable, allocations: b.allocations,
      client: b.client, assembler: b.assembler, authority: b.authority, demand: b.demand,
      outboxFrames: this.outbox.length,
    };
  }

  // --- L1 surface -------------------------------------------------------------------

  /** Guest: start the handshake. */
  hello(): { ok: true } | { ok: false; code: string } {
    const result = this.session.hello();
    this.flush();
    return result;
  }

  whenReady(): Promise<RelayNegotiation> { return this.session.whenReady(); }

  /** Guest: OPEN a stream; the window slice exists when the promise resolves. */
  open(request: RelayOpenRequest): Promise<RelayOpenResult> {
    const opened = this.session.open(request);
    this.flush();
    return opened;
  }

  /** One complete wire record from the transport: decode and session
   * checks, window accounting, delivery of everything staged, and a send
   * pump. A host with a per-frame delivery budget calls ingestRecord(),
   * pumpReceive(n) and flush() itself. */
  handleRecord(bytes: Uint8Array): void {
    this.ingestRecord(bytes);
    this.pumpReceive();
    this.flush();
  }

  /** Decode and stage one record without delivering business frames. */
  ingestRecord(bytes: Uint8Array): void {
    this.session.handleRecord(bytes);
  }

  /** The physical connection dropped: the session returns to idle and the
   * per-session machines are discarded. */
  handleDisconnect(reason: string): void {
    this.session.handleDisconnect(reason);
  }

  /** Protocol teardown from this end. */
  close(): void {
    this.session.close();
  }

  // --- L2 surface: guest ---------------------------------------------------------------

  get(
    stream: number,
    ref: RelayResourceRef,
    args: { accept: number[]; maxObjectBytes: number; ifRevision?: string },
    complete: (result: ResourceResult<RelayGetOutcome>) => void,
  ): { correlation: number } | { ok: false; code: string } {
    const client = this.bound?.client;
    if (!client) return { ok: false, code: RELAY_ERROR.BUSY };
    const result = client.get(stream, ref, args, complete);
    this.flush();
    return result;
  }

  subscribe(
    stream: number,
    target: RelayResourceRef | { ns: string },
    delivery: string,
    handler: RelaySubscriptionHandler,
    complete: (result: ResourceResult<{ subscription?: number }>) => void,
  ): { correlation: number } | { ok: false; code: string } {
    const client = this.bound?.client;
    if (!client) return { ok: false, code: RELAY_ERROR.BUSY };
    const result = client.subscribe(stream, target, delivery, handler, complete);
    this.flush();
    return result;
  }

  unsubscribe(subscription: number, complete?: (result: ResourceResult<{ subscription?: number }>) => void):
    { correlation: number } | { ok: false; code: string } {
    const client = this.bound?.client;
    if (!client) return { ok: false, code: RELAY_ERROR.BUSY };
    const result = client.unsubscribe(subscription, complete);
    this.flush();
    return result;
  }

  release(stream: number, ref: RelayResourceRef, lease: number,
    complete?: (result: ResourceResult<{ subscription?: number }>) => void):
    { correlation: number } | { ok: false; code: string } {
    const client = this.bound?.client;
    if (!client) return { ok: false, code: RELAY_ERROR.BUSY };
    const result = client.release(stream, ref, lease, complete);
    this.flush();
    return result;
  }

  reportEvict(ref: RelayResourceRef, reason: string): void {
    this.bound?.client?.reportEvict(ref, reason);
    this.flush();
  }

  /** Withdraw interest in an in-flight get: request.cancel on the
   * sideband; the slot frees when the one terminal is consumed. */
  cancel(correlation: number, reason = "cancel"): void {
    this.bound?.client?.cancel(correlation, reason);
    this.flush();
  }

  // --- L2 surface: provider ------------------------------------------------------------

  /** Queue one prepared envelope (a terminal, a chunk, a push, an
   * invalidate) on its stream; credit admission happens in flush(). */
  respond(envelope: RelayResourceEnvelope): void {
    const b = this.bound;
    if (!b) return;
    this.enqueue(b, envelope);
    this.flush();
  }

  replyError(request: { stream: number; correlation: number; op: string; metadata?: Record<string, unknown> },
    code: string, message = code, effect?: string): void {
    const b = this.bound;
    if (!b?.authority) return;
    const envelope = request.op === RELAY_OP.RESOURCE_GET
      ? b.authority.answerGetError(request, code, message)
      : b.authority.answerError(request, request.op, code, message);
    if (effect !== undefined) envelope.metadata.effect = effect;
    this.respond(envelope);
  }

  replyNotModified(request: { stream: number; correlation: number }, ref: RelayResourceRef): void {
    const b = this.bound;
    if (!b?.authority) return;
    this.respond(b.authority.answerNotModified(request, ref));
  }

  /** Answer a resource.get with one complete object: admission against the
   * request's accept/maxObjectBytes, chunking under the negotiated limits,
   * then the chunks enter the stream's demand FIFO. A refusal is answered
   * to the peer with the error terminal and reported to the caller. */
  replyObject(
    request: RelayIncomingRequest,
    object: { ref: RelayResourceRef; codec: number; data: Uint8Array; value?: Record<string, unknown> },
  ): { ok: true; frames: number } | { ok: false; code: string } {
    const b = this.bound;
    if (!b?.authority) return { ok: false, code: RELAY_ERROR.BUSY };
    const args = request.metadata.args as { accept: number[]; maxObjectBytes: number };
    if (!args.accept.includes(object.codec)) {
      this.respond(b.authority.answerGetError(request, RELAY_ERROR.UNSUPPORTED, `codec ${object.codec} not accepted`));
      return { ok: false, code: RELAY_ERROR.UNSUPPORTED };
    }
    const refused = b.authority.checkGet(object.data.length, args);
    if (refused) {
      this.respond(b.authority.answerGetError(request, refused.code, refused.message ?? refused.code));
      return { ok: false, code: refused.code };
    }
    const plan = b.authority.chunkObject({
      type: RELAY_TYPE.RESPONSE, stream: request.stream, correlation: request.correlation,
      ref: object.ref, codec: object.codec, data: object.data, value: object.value,
    });
    if (!plan.ok) {
      this.respond(b.authority.answerGetError(request, plan.code, plan.message));
      return { ok: false, code: plan.code };
    }
    for (const env of plan.frames) this.enqueue(b, env);
    this.flush();
    return { ok: true, frames: plan.frames.length };
  }

  /** Push one complete object to an active subscription. */
  pushObject(input: {
    stream: number; subscription: number; ref: RelayResourceRef; codec: number; data: Uint8Array;
    value?: Record<string, unknown>; baseRevision?: string;
  }): { ok: true; frames: number } | { ok: false; code: string } {
    const b = this.bound;
    if (!b?.authority) return { ok: false, code: RELAY_ERROR.BUSY };
    const sub = b.authority.subscriptionEntry(input.subscription);
    if (!sub || !sub.active || sub.stream !== input.stream) return { ok: false, code: RELAY_ERROR.NOT_FOUND };
    const plan = b.authority.chunkObject({
      type: RELAY_TYPE.PUSH, stream: input.stream, correlation: 0, subscription: input.subscription,
      ref: input.ref, codec: input.codec, data: input.data, value: input.value, baseRevision: input.baseRevision,
    });
    if (!plan.ok) return { ok: false, code: plan.code };
    for (const env of plan.frames) this.enqueue(b, env);
    this.flush();
    return { ok: true, frames: plan.frames.length };
  }

  /** Authority invalidation on the stream bound to the namespace. */
  invalidate(input: Parameters<RelayResourceAuthority["buildInvalidate"]>[0]): void {
    const b = this.bound;
    if (!b?.authority) return;
    this.respond(b.authority.buildInvalidate(input));
  }

  /** relay.reset from this end: the peer's and this end's requests and
   * subscriptions on the stream fail; the id never reopens. */
  resetStream(stream: number, reason: string): void {
    const b = this.bound;
    if (!b || !b.allocations.has(stream) || stream === 0) return;
    const sent = b.sender.sendReset(stream, reason);
    if (!sent.ok && sent.code === RELAY_P3_ERROR.SIDEBAND_FULL) {
      b.pendingSideband.push(() => b.sender.sendReset(stream, reason));
    }
    this.session.forgetStream(stream);
    this.applyStreamReset(b, stream, reason);
    this.flush();
  }

  // --- send path ----------------------------------------------------------------------

  /** Drain the outbox, admit provider demand, pump the sender until the
   * window or the transport stops it. Re-entrant calls (a synchronous
   * transport delivering the peer's reply inside trySend) run once the
   * outer pass completes. */
  flush(): void {
    if (this.flushing) { this.flushAgain = true; return; }
    this.flushing = true;
    try {
      do {
        this.flushAgain = false;
        this.flushOnce();
      } while (this.flushAgain);
    } finally {
      this.flushing = false;
    }
  }

  private flushOnce(): void {
    const drained = this.drainOutbox();
    if (drained === "offline") { this.session.handleDisconnect("transport offline"); return; }
    if (drained === "busy") return;
    const b = this.bound;
    if (!b) return;
    this.retrySideband(b);
    this.admitDemand(b);
    for (let guard = 0; guard < 4096; guard++) {
      if (this.bound !== b) return;
      const pumped = b.sender.pump();
      this.outbox.push(...pumped.frames);
      if (!pumped.ok) { this.fatal(pumped.code ?? RELAY_P3_ERROR.BUSY, "send pump"); return; }
      if (pumped.frames.length === 0) break;
      const status = this.drainOutbox();
      if (status === "offline") { this.session.handleDisconnect("transport offline"); return; }
      if (status === "busy") return;
    }
  }

  private drainOutbox(): "drained" | "busy" | "offline" {
    while (this.outbox.length > 0) {
      const status = this.transport.trySend(this.outbox[0]);
      if (status === "accepted") { this.outbox.shift(); continue; }
      if (status === "busy") return "busy";
      this.outbox.length = 0;
      return "offline";
    }
    return "drained";
  }

  /** Bootstrap frames the session sends itself (HELLO, HELLO response)
   * join the ordered outbox; they never overtake a stamped frame. */
  private trySendDirect(bytes: Uint8Array): RelaySendStatus {
    if (this.outbox.length >= this.outboxCap) return "busy";
    this.outbox.push(bytes);
    return this.drainOutbox() === "offline" ? "offline" : "accepted";
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    Promise.resolve().then(() => {
      this.flushScheduled = false;
      this.flush();
    });
  }

  private retrySideband(b: Bound): void {
    while (b.pendingSideband.length > 0) {
      const result = b.pendingSideband[0]();
      if (!result.ok && result.code === RELAY_P3_ERROR.SIDEBAND_FULL) return;
      b.pendingSideband.shift();
    }
  }

  /** Provider demand FIFO -> sender queue, per stream in order, as far as
   * the window admits. BUSY keeps the head for the next credit; an
   * unadmittable envelope is dropped and counted. */
  private admitDemand(b: Bound): void {
    for (const [stream, queue] of b.demand) {
      while (queue.length > 0) {
        const env = queue[0];
        const admitted = b.sender.admit({
          type: env.type, stream, codec: env.codec ?? RELAY_CODEC.NONE,
          metadata: env.metadata, data: env.data, correlation: env.correlation,
          priority: priorityFor(env.type),
          association: env.type === RELAY_TYPE.RESPONSE
            ? { kind: "correlation", id: env.correlation }
            : typeof env.metadata.subscription === "number"
              ? { kind: "subscription", id: env.metadata.subscription }
              : undefined,
        });
        if (admitted.ok) {
          queue.shift();
          this.noteSentTerminal(b, env);
          continue;
        }
        if (admitted.code === RELAY_P3_ERROR.BUSY) break;
        queue.shift();
        this.protocolError(admitted.code, `envelope on stream ${stream} not admitted`);
        if (admitted.code === RELAY_P3_ERROR.STREAM_DEAD) queue.length = 0;
      }
      if (queue.length === 0) b.demand.delete(stream);
    }
  }

  /** A terminal RESPONSE the provider admitted to the queue frees its
   * request slot: the work is done and the frame is in the ordered send
   * stream (§3.9: the provider releases its execution slot on completion). */
  private noteSentTerminal(b: Bound, env: RelayResourceEnvelope): void {
    if (env.type !== RELAY_TYPE.RESPONSE || env.metadata.final !== true) return;
    if (!b.requests.get(env.correlation)) return;
    const recorded = b.requests.terminal(env.correlation, {
      status: String(env.metadata.status), final: true,
      errorCode: (env.metadata.error as { code?: string } | undefined)?.code,
      effect: typeof env.metadata.effect === "string" ? env.metadata.effect : undefined,
    });
    if (recorded.ok) b.requests.consumeTerminal(env.correlation);
  }

  private enqueue(b: Bound, envelope: RelayResourceEnvelope): void {
    const queue = b.demand.get(envelope.stream);
    if (queue) queue.push(envelope);
    else b.demand.set(envelope.stream, [envelope]);
  }

  // --- session hooks --------------------------------------------------------------------

  private onPhase(phase: RelayPhase, detail?: { reason?: string }): void {
    if (phase === "ready-sent" || phase === "hello-received") this.bind();
    else if (phase === "closed" || phase === "idle") this.unbind();
    this.hooks.onPhase?.(phase, detail);
  }

  /** The session is pinned: build this session's machines from the
   * negotiated limits before the first frame on it (READY) is emitted. */
  private bind(): void {
    const negotiation = this.session.negotiation;
    if (!negotiation) return;
    const limits = negotiation.rxLimits;
    const session = this.session.sessionId;
    const control = relayControlSlice(limits);
    const sideband = new RelaySideband();
    const creditTable = new RelayCreditTable();
    const sender = new RelaySender(session, sideband, {
      windowFrames: limits.windowFrames,
      windowBytes: limits.windowBytes,
      controlSlice: control,
      maxWireBytes: limits.maxWireBytes,
      maxMetaBytes: limits.maxMetaBytes,
      codecs: negotiation.codecs,
      framesPerPump: this.options.framesPerPump,
      bytesPerPump: this.options.bytesPerPump ?? limits.windowBytes,
    }, creditTable);
    const allocations = new Map<number, RelayStreamAlloc>([[0, control]]);
    const receiver = new RelayReceiver(session, allocations, creditTable, RELAY_LIMITS.maxStreams, 1);
    const bound: Bound = {
      session, negotiation, sideband, creditTable, sender, allocations, receiver,
      requests: new RelayRequestTable(limits.maxPending),
      demand: new Map(), pendingSideband: [], streamsByNs: new Map(),
    };
    if (this.role === "guest") {
      bound.assembler = new RelayChunkAssembler({
        maxAssemblies: limits.maxAssemblies, maxScratchBytes: limits.maxScratchBytes,
      });
      bound.client = new RelayResourceClient({
        wire: this.wire,
        negotiated: { maxObjectBytes: limits.maxObjectBytes, codecs: negotiation.codecs },
        assembler: bound.assembler,
      });
    } else {
      bound.authority = new RelayResourceAuthority({
        maxWireBytes: limits.maxWireBytes, maxMetaBytes: limits.maxMetaBytes,
      });
    }
    this.bound = bound;
  }

  /** The session ended: stamped-but-unsent frames are void, every pending
   * get and subscription fails (RESYNC_REQUIRED / onEnd), and the machines
   * are dropped. A reconnect binds a fresh set. */
  private unbind(): void {
    this.outbox.length = 0;
    const b = this.bound;
    if (!b) return;
    this.bound = null;
    if (b.client) {
      for (const stream of b.allocations.keys()) if (stream !== 0) b.client.resetStream(stream);
    }
  }

  private onStreamOpened(opened: RelayOpenResult): void {
    const b = this.bound;
    if (!b) return;
    const slice = relayStreamSlice(b.negotiation.rxLimits, b.allocations.values(), opened.rxLimits);
    if (slice.frames < 1 || slice.bytes < 1) {
      this.protocolError(RELAY_P3_ERROR.STREAM_LIMIT, `stream ${opened.stream}: no attachment window left`);
    } else {
      const allocated = b.sender.openStream(opened.stream, slice);
      if (!allocated.ok) this.protocolError(allocated.code, `stream ${opened.stream}: slice refused`);
      else b.allocations.set(opened.stream, slice);
    }
    b.streamsByNs.set(opened.namespace, opened.stream);
    this.hooks.onStreamOpened?.(opened);
  }

  /** Post-bootstrap control frames: OPEN/READY take the control slice as
   * ordinary stream-0 work, ping and pong ride the sideband. */
  private admitControl(input: RelayControlAdmission): { ok: true } | { ok: false; code: string } {
    const b = this.bound;
    if (!b) return { ok: false, code: "NOT_READY" };
    let result: P3Result;
    if (input.metadata.op === RELAY_OP.PING) {
      const token = input.metadata.token as number;
      result = input.type === RELAY_TYPE.REQUEST
        ? b.sender.sendPing(input.correlation, token)
        : b.sender.sendPong(input.correlation, token);
    } else {
      result = b.sender.admit({
        type: input.type, stream: 0, metadata: input.metadata,
        correlation: input.correlation, priority: RELAY_PRIORITY.CONTROL,
      });
    }
    if (!result.ok) {
      return { ok: false, code: result.code === RELAY_P3_ERROR.SIDEBAND_FULL ? "BUSY" : result.code };
    }
    this.scheduleFlush();
    return { ok: true };
  }

  /** An inbound stream-0 record the session consumed held one slot of the
   * peer's control slice; it returns as relay.credit on the next pump.
   * Sideband records earn nothing. */
  private onControlFrame(frame: RelayDecodedFrame, wireBytes: number): void {
    const b = this.bound;
    if (!b || isSidebandFrame(frame)) return;
    const noted = b.creditTable.note(0, 1, wireBytes);
    if (!noted.ok) this.protocolError(noted.code, "control credit row");
  }

  private onBusinessFrame(frame: RelayDecodedFrame, wireBytes: number): void {
    const b = this.bound;
    if (!b) return;
    const association = frame.type === RELAY_TYPE.RESPONSE
      ? { kind: "correlation" as const, id: frame.correlation }
      : frame.type === RELAY_TYPE.PUSH && typeof frame.metadata.subscription === "number"
        ? { kind: "subscription" as const, id: frame.metadata.subscription }
        : undefined;
    const ingested = b.receiver.ingest(frame, wireBytes, association);
    if (ingested.ok) return;
    if (ingested.code === RELAY_P3_ERROR.WINDOW_OVERFLOW || ingested.code === RELAY_P3_ERROR.SESSION_FATAL) {
      // §3.9: the peer sent past the granted window; the attachment ends.
      this.fatal(ingested.code, `stream ${frame.stream} seq ${frame.seq}`);
    } else if (ingested.code === RELAY_P3_ERROR.SEQ_GAP) {
      this.onStreamError(frame.stream, RELAY_ERROR.RESYNC_REQUIRED);
    } else {
      this.protocolError(ingested.code, `stream ${frame.stream} seq ${frame.seq} not staged`);
    }
  }

  private onCredit(metadata: Record<string, unknown>): void {
    const b = this.bound;
    if (!b) return;
    const applied = b.sender.applyCredit(metadata as { targetStream: number; framesReleased: string; bytesReleased: string });
    if (!applied.ok) this.fatal(applied.code, `relay.credit for stream ${String(metadata.targetStream)}`);
  }

  private onPeerReset(metadata: Record<string, unknown>): void {
    const b = this.bound;
    if (!b) return;
    const stream = metadata.targetStream as number;
    this.applyStreamReset(b, stream, `peer: ${String(metadata.reason)}`);
  }

  private onPeerCancel(frame: RelayDecodedFrame): void {
    const b = this.bound;
    if (!b) return;
    const state = b.requests.get(frame.correlation);
    if (state) b.requests.cancel(frame.correlation);
    this.hooks.onCancel?.({
      targetStream: frame.metadata.targetStream as number,
      correlation: frame.correlation,
      reason: typeof frame.metadata.reason === "string" ? frame.metadata.reason : "",
      request: state,
    });
  }

  private onStreamError(stream: number, code: string): void {
    const b = this.bound;
    if (!b) return;
    if (code === RELAY_ERROR.RESYNC_REQUIRED && b.allocations.has(stream)) {
      // A seq hole on a reliable stream: resync is a reset of that stream
      // on both ends (draft §3.3); new work needs a new stream id.
      this.resetStream(stream, "seq gap");
      return;
    }
    this.protocolError(code, `stream ${stream}`);
  }

  private applyStreamReset(b: Bound, stream: number, reason: string): void {
    b.receiver.applyReset(stream, reason);
    b.sender.applyReset(stream);
    b.requests.failStream(stream);
    b.client?.resetStream(stream);
    b.authority?.resetStream(stream);
    b.demand.delete(stream);
    b.allocations.delete(stream);
    for (const [ns, s] of b.streamsByNs) if (s === stream) b.streamsByNs.delete(ns);
    this.hooks.onStreamReset?.(stream, reason);
  }

  // --- receive delivery ------------------------------------------------------------------

  /** Deliver staged business frames, one receiver pump at a time (§3.9
   * guest delivery ≤ 1 per pump), up to maxFrames. Each frame is handed
   * to the L2 layer and then released, which is where its wire credit
   * returns. Returns the number delivered. */
  pumpReceive(maxFrames = Number.POSITIVE_INFINITY): number {
    let delivered = 0;
    while (delivered < maxFrames) {
      const b = this.bound;
      if (!b) break;
      const batch = b.receiver.pump();
      if (batch.length === 0) break;
      for (const rx of batch) {
        delivered++;
        this.deliver(b, rx);
        if (this.bound === b) {
          const released = b.receiver.release(rx.handle);
          if (!released.ok) this.protocolError(released.code, `release ${rx.handle}`);
        }
      }
    }
    return delivered;
  }

  private deliver(b: Bound, rx: RelayReceived): void {
    if (this.role === "guest") this.deliverGuest(b, rx.frame);
    else this.deliverProvider(b, rx.frame);
  }

  private incoming(f: RelayDecodedFrame): RelayResourceIncomingFrame {
    return { type: f.type, codec: f.codec, stream: f.stream, correlation: f.correlation, metadata: f.metadata, data: f.data };
  }

  private deliverGuest(b: Bound, f: RelayDecodedFrame): void {
    const client = b.client!;
    if (f.type === RELAY_TYPE.RESPONSE) {
      const meta = f.metadata;
      const final = meta.final === true;
      const error = meta.error;
      // P3 first: one terminal per request; a response for an unknown or
      // finished request is a peer fault and drops with its credit.
      const recorded = b.requests.terminal(f.correlation, {
        status: typeof meta.status === "string" ? meta.status : "",
        final,
        errorCode: typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string"
          ? (error as { code: string }).code : undefined,
        effect: typeof meta.effect === "string" ? meta.effect : undefined,
      });
      if (!recorded.ok) { this.protocolError(recorded.code, `response for correlation ${f.correlation}`); return; }
      client.handleFrame(this.incoming(f));
      if (final) {
        const consumed = b.requests.consumeTerminal(f.correlation);
        if (!consumed.ok) this.protocolError(consumed.code, `terminal for correlation ${f.correlation}`);
      }
      return;
    }
    if (f.type === RELAY_TYPE.PUSH || f.type === RELAY_TYPE.INVALIDATE) {
      client.handleFrame(this.incoming(f));
      return;
    }
    this.protocolError(RELAY_ERROR.UNSUPPORTED, `guest received frame type ${f.type}`);
  }

  private deliverProvider(b: Bound, f: RelayDecodedFrame): void {
    if (f.type === RELAY_TYPE.REQUEST) { this.serveRequest(b, f); return; }
    if (f.type === RELAY_TYPE.INVALIDATE) {
      if (f.metadata.op === RELAY_OP.CACHE_EVICT && validateRelayMetadata(RELAY_OP.CACHE_EVICT, f.metadata) === null) {
        this.hooks.onEvict?.(f.metadata);
      } else {
        this.protocolError(RELAY_ERROR.INVALID, `invalidate op ${String(f.metadata.op)} from a consumer`);
      }
      return;
    }
    this.protocolError(RELAY_ERROR.UNSUPPORTED, `provider received frame type ${f.type}`);
  }

  private serveRequest(b: Bound, f: RelayDecodedFrame): void {
    const authority = b.authority!;
    const op = f.metadata.op as string;
    const admitted = b.requests.admitKnown(f.stream, f.correlation);
    if (!admitted.ok) {
      if (b.requests.get(f.correlation)) {
        this.protocolError(RELAY_P3_ERROR.BAD_CORRELATION, `request id ${f.correlation} reused`);
        return;
      }
      // The peer exceeded the negotiated maxPending: refused, not dropped.
      this.respond(authority.answerError(f, op, RELAY_ERROR.BUSY, "request window full"));
      return;
    }
    const request: RelayIncomingRequest = {
      stream: f.stream, correlation: f.correlation, op, metadata: f.metadata, data: f.data, codec: f.codec,
      cancelRequested: () => b.requests.get(f.correlation)?.cancelRequested ?? false,
    };
    switch (op) {
      case RELAY_OP.RESOURCE_SUBSCRIBE: this.respond(authority.answerSubscribe(f)); return;
      case RELAY_OP.RESOURCE_UNSUBSCRIBE: this.respond(authority.answerUnsubscribe(f)); return;
      case RELAY_OP.RESOURCE_RELEASE: this.respond(authority.answerRelease(f)); return;
      case RELAY_OP.RESOURCE_GET: {
        const invalid = validateRelayMetadata(`${RELAY_OP.RESOURCE_GET}.request`, f.metadata);
        if (invalid) { this.respond(authority.answerGetError(f, RELAY_ERROR.INVALID, invalid)); return; }
        if (this.hooks.onGet) { this.hooks.onGet(request); return; }
        this.respond(authority.answerGetError(f, RELAY_ERROR.UNSUPPORTED, "no resource source"));
        return;
      }
      default:
        if (this.hooks.onRequest?.(request)) return;
        this.respond(authority.answerError(f, op, RELAY_ERROR.UNSUPPORTED, `unknown op ${op}`));
    }
  }

  // --- L2 wire seam (guest) ------------------------------------------------------------

  private wireRequest(stream: number, metadata: Record<string, unknown>, data?: Uint8Array, codec?: number): number {
    const b = this.bound;
    if (!b || this.session.phase !== "ready" || !b.allocations.has(stream)) return 0;
    const correlation = this.session.allocateCorrelation();
    if (correlation === 0) return 0;
    const slot = b.requests.admitKnown(stream, correlation, this.requestReserve);
    if (!slot.ok) return 0;
    const admitted = b.sender.admit({
      type: RELAY_TYPE.REQUEST, stream, metadata, data,
      codec: codec ?? (data && data.length ? RELAY_CODEC.JSON : RELAY_CODEC.NONE),
      correlation, association: { kind: "correlation", id: correlation },
    });
    if (!admitted.ok) {
      // No frame left: the slot returns; the correlation stays consumed.
      b.requests.abandon(correlation);
      return 0;
    }
    // The client registers its pending entry after this call returns; the
    // frame leaves on the next flush, never inside this call.
    this.scheduleFlush();
    return correlation;
  }

  private wireAdvise(metadata: Record<string, unknown>): void {
    const b = this.bound;
    if (!b || this.session.phase !== "ready") return;
    const ref = metadata.resource as RelayResourceRef | undefined;
    const stream = ref ? b.streamsByNs.get(ref.ns) : undefined;
    if (stream === undefined) return; // advisory: no stream for the namespace, nothing to say
    b.sender.admit({
      type: RELAY_TYPE.INVALIDATE, stream, metadata, correlation: 0, priority: RELAY_PRIORITY.CONTROL,
    });
    this.scheduleFlush();
  }

  private wireCancel(stream: number, correlation: number, reason: string): void {
    const b = this.bound;
    if (!b) return;
    b.requests.cancel(correlation);
    const sent = b.sender.cancel(stream, correlation, reason);
    if (!sent.ok && sent.code === RELAY_P3_ERROR.SIDEBAND_FULL) {
      b.pendingSideband.push(() => b.sender.cancel(stream, correlation, reason));
    }
    this.scheduleFlush();
  }

  // --- faults ----------------------------------------------------------------------------

  private protocolError(code: string, detail: string): void {
    this.protocolErrorCount++;
    this.hooks.onProtocolError?.(code, detail);
  }

  /** A fault the attachment cannot continue after (window overflow,
   * out-of-range credit, a dead send pump): counted, reported, and the
   * session closes. */
  private fatal(code: string, detail: string): void {
    this.protocolError(code, detail);
    this.session.close();
  }
}
