# PSP USB offload

The PSP host can serve an app that requires `io.offload` over **PSPLINK host0**. The build hashes the app ID into its mailbox directory. The Mac adapter mounts beneath the directory passed to `usbhostfs_pc`; it uses the same capability worker module as the LAN adapter.

```ts
import { connectOffloadUsbProvider } from "@pocketjs/framework/offload/provider";
connectOffloadUsbProvider({
  directory: "dist/psplink",
  app: "dev.pocket-stack.map",
  worker: new URL("./worker.ts", import.meta.url),
  data: config,
});
```

Device apps continue using `offload()`, `createResourceRuntime()`, `createOffloadMeshCollection()` and `ResourceMesh`. They do not read host0 files or decode protocol packets in JavaScript. Pocket Map's PSP entry shares its camera, prediction, resource collections, provider and saved-place model with the 3DS entry; it supplies a 480×272 viewport and a smaller residency budget.

## Scheduling and ownership

**One lower-priority native worker owns the offload file operations.** The UI submits at most one bounded record, consumes at most one completion and uploads at most one binary result per frame. These entry points copy bounded buffers and use atomic state transfers; they never open, read, seek, write or wait on a host0 file. PSPLINK itself has synchronous file RPCs, so this separation is necessary even with small read chunks.

The worker uses **eight preallocated slots**, each with a 4 KiB request, 64-byte header and 128 KiB response buffer. It allocates no Rust, QuickJS or UI objects; PocketJS's PSP allocator remains confined to the UI thread. The single PSP CPU schedules the worker while UI work yields; GE executes submitted graphics independently. This implementation does not use the Media Engine or parse MVT on the device.

Slot ownership moves through `FREE → QUEUED → SENT → READY → BORROWED → FREE`. The worker only accesses QUEUED/SENT payloads; the UI only accesses FREE/READY/BORROWED payloads. Release/acquire atomics publish each transfer. A borrowed binary remains immutable until the UI releases its ticket. An abandoned request continues occupying its native slot until its response or a session change.

Each envelope contains a Mac epoch, device boot nonce, sequence, response kind, request ID, dimensions, payload length and FNV checksum. The checksum detects partial file reads; it is not authentication. **Physical USB access establishes this connection**, without the LAN pairing key. The Mac atomically replaces response files. Replies from an obsolete sequence cannot overwrite a newer result in the same slot.

The Mac starts at most eight capability calls. A 12-second execution timeout terminates the capability subprocess; replacement begins only after its exit, with a new epoch. Queue credit is not released while the old computation continues. The UI independently expires an unrefreshed connection after three seconds, including when the worker is stuck inside a USB call. It retains locally materialized resources for cached navigation.

## GPU resources

A PMH1 mesh is validated once, expanded once into GE color/float vertices and written back to the data cache once. **Subsequent frames submit a retained vertex pointer and affine matrix.** They do not triangulate, expand geometry or retransmit pixels when the camera pans. A mesh is limited to 4,096 source vertices / 2,048 triangles / 36,880 wire bytes. The GE vertex pool is capped at 4 MiB, charged in PSP allocator size classes, including retired buffers.

Mesh disposal preserves vertices until the preceding display list completes. `Ui.take_texture()` similarly invalidates an image handle immediately while returning its storage to the backend for delayed release. This prevents an evicted image from being overwritten while the GE still samples it. RGB565 images and PMH1 meshes use the existing resource fallback and eviction contracts; their CPU/GPU copies remain separate from transport staging.

The resource runtime still samples demand accessors every frame. **Unchanged demands skip union reconstruction and cache reconciliation.** Scalar snapshots detect changes even when a caller mutates a reused array. Clear, invalidation, priority changes, cancellation and owner cleanup retain their existing behavior.

## Diagnostics and limits

The worker writes frame count, work duration, JS/core/GE submission duration and GE fence wait to the app mailbox. Durations exclude intentional vblank waiting but include OS scheduling and debugger preemption. Mac logs contain method, ID, payload size and elapsed provider time; they omit search text and other request payloads.

The PSP offload build omits the old synchronous DevTools mailbox probe. Normal PSPLINK module reload remains available. This initial adapter is for an app-specific embedded PSP executable; it does not add arbitrary multi-app USB routing or video playback. Pocket YouTube's complete-frame replacement policy is appropriate for video, whereas map tiles keep independent identities and cache ownership.

This transport prevents a blocked offload call from blocking the UI thread. It does not make arbitrary JavaScript, component mounting, garbage collection or GPU work free. Pocket Map's hardware record distinguishes settled 60 Hz rendering from the slower frames during new UI and resource materialization.
