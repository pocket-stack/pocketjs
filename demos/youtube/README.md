# Pocket YouTube

Watch YouTube on a PSP — no WiFi, one USB cable.

The PSP never touches the network: a companion **macOS host service** owns
the protocol layer (yt-dlp), the decode (ffmpeg) and the pixels (a CLUT8
quantizer), and everything reaches the device through the directory the PSP
already mounts as `host0:` under PSPLINK. The 802.11b radio was never going
to stream 2026 YouTube; the USB port is right there.

```
┌─ Mac ──────────────────────────────┐        ┌─ PSP ───────────────────────┐
│ yt-dlp   search / resolve URL      │  USB   │ demos/youtube  (PocketJS)   │
│ ffmpeg   decode + scale + PCM      │ ─────▶ │ svc mailbox    (ops 30-33)  │
│ quant.ts CLUT8 + dither            │usbhostfs│ video plane   (ops 34-37)  │
│ serve.ts mailbox + .pkst rings     │        │ sceAudio SRC thread         │
└────────────────────────────────────┘        └─────────────────────────────┘
```

## The wire

Everything rides the **SVC** convention (spec.ts): control is JSON lines in
`pocket-svc/youtube/{out,in}.jsonl` (spec ops 30–32, the DevTools mailbox
split generalized), bulk bytes are side files:

- **Result cards** — each search hit becomes ONE 256×64 CLUT8 IMG entry,
  rendered host-side (thumbnail + two title lines + meta). The PSP's baked
  font atlas can never cover arbitrary titles — CJK included — so the Mac,
  which has every glyph, does the typesetting and the device just samples a
  texture (`loadImgFile`, op 33).
- **Playback** — a `.pkst` STREAM container (spec.ts byte layout): one
  preallocated file holding a video slot ring (256×128 CLUT8 frames, palette
  per frame, Floyd–Steinberg dithered) and a PCM chunk ring (22.05 kHz s16
  stereo). The writer publishes a slot's seq only after its bytes are down;
  the reader (native `vid.rs`) re-checks the seq after reading — a lapped
  slot is discarded, never presented. `videoTick` (op 35) is a bounded
  per-frame IO pump (~10 KB/tick steady state ≈ 0.6 MB/s, tuned for
  usbhostfs), and audio plays from a RAM ring on a dedicated thread
  (`sceAudioSRCChReserve` — the main thread owns ALL file IO, one USB pipe,
  one owner).

Pause is `SIGSTOP` on the ffmpeg pipes; seek kills and respawns them at the
new offset and bumps the stream's epoch so the device resyncs. `-re` paces
the writer at source rate, so "chase the newest seq" IS the play clock.

## Run it

```sh
# 1. PSP plugged in, PSPLINK running (Game → PSPLINK on the device):
bun run hw youtube -r

# 2. In another terminal — point the service at the SAME dir hw serves as host0:
bun demos/youtube/host/serve.ts --dir native/target/mipsel-sony-psp/release
```

With `bun psplink` instead of `hw`, use `--dir dist/psplink`. Needs `yt-dlp`
and `ffmpeg` on PATH (`brew install yt-dlp ffmpeg`).

On device: △ opens the keyboard, START searches, d-pad browses, ○ plays;
in the player ○ pauses, ◁/▷ seek ±10 s, × backs out.

**PPSSPP** (no hardware): the svc probe falls back to `ms0:` — point
`--dir` at the emulator's memstick root and load the EBOOT from the GUI.

**Browser dev** (`bun run web` + `serve.ts --http 8620`): the app's driver
falls back to fetch for search/browse; the video plane is native-only, the
player screen says so.

## Layout

- `main.tsx` / `app.tsx` / `player.tsx` / `keyboard.tsx` / `store.ts` — the
  PocketJS app (Solid).
- `driver.ts` — the effect driver: `runEffect("yt/*")` → svc mailbox (USB)
  or fetch (browser), plus the one-per-frame card-texture loader.
- `protocol.ts` — the JSON-line message types both sides import.
- `host/serve.ts` — the Mac service (mailbox tail + dispatch + `--http`).
- `host/yt.ts` `media.ts` `ring.ts` `quant.ts` `cards.ts` `img.ts` — search,
  the ffmpeg→ring pipeline, the `.pkst` writer, the quantizer, the card
  renderer, the IMG encoder.
- Engine pieces this app introduced: spec ops 30–37, `core/src/stream.rs`,
  `native/src/{svc,vid,audio}.rs`, `Ui::update_texture_t8`.

## Contracts held elsewhere

- `.pkst` golden: `test/youtube-host.test.ts` writes
  `test/fixtures/youtube-golden.pkst`; core's cargo test parses it
  (`stream_golden_fixture_parses`). `UPDATE=1` refreshes.
- App journeys: `test/youtube-sim.test.ts` (canned host injected through
  `__pocketEffectDriver`).
