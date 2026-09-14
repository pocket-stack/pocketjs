# Dynamic text from a baked character set

**Ordinary `<Text>` accepts Unicode strings produced at runtime.** Font coverage
comes from the selected font slot. A filesystem name, metadata field or data
entry renders when its code points are present in that slot's baked atlas.
The origin of the string does not change the text API.

## Declare coverage

Place `fonts.json` beside the app entry:

```json
{
  "fallback": ["fonts/MyCjkFont.otf"],
  "characters": "你好気迫",
  "characterFiles": ["library.json"],
  "ranges": ["U+3040-30FF"]
}
```

`fallback` lists font files in search order. Paths are relative to `fonts.json`.
`characters`, UTF-8 `characterFiles` and inclusive Unicode `ranges` extend the
source-literal scan for every used font slot. The build tracks these files as
dependencies. Range selection skips surrogate code points. Character files have
a 4 MiB limit; the declared set has a 65,534-scalar limit before the baked atlas
adds ASCII and its missing-glyph cell. The final atlas enforces its own glyph
count limit. A font must contain the requested characters: a range declaration
does not manufacture missing glyphs.

**Coverage can include characters absent from the JS bundle.** A filename added
after compilation can render without a rebuild when its characters are in the
declared set. A character outside that set remains a missing-glyph cell. Match
the set and font to the app's supported languages and storage budget.

## PSP rendering

The PSP renderer materializes **at most eight 128×128 ABGR4444 font pages**,
with at most 256 KiB of pixel storage. It uploads pages needed by the DrawList.
A page key contains the font slot, atlas revision and source glyph range. A
same-size atlas replacement through `Ui::load_font_atlas` changes that revision.
Allocator address reuse cannot select pixels from the preceding font.

**A page referenced by queued GE commands stays immutable until `sceGuSync`.**
`reset_pool()` then releases page pins. Retired pages use LRU replacement. When
every page is pinned, the renderer paints the requested glyph from its source
coverage through the CPU sprite path. It does not overwrite an in-flight page
or substitute another cached character. CPU fallback preserves the glyph but
can increase frame cost; a GPU-page budget is not a frame-time guarantee.

The source atlas and its cmap remain resident in the package/core. This path
does not stream a full external CJK font archive from Memory Stick. Source font
storage, sparse archive reads and text shaping are separate from GPU page
residency. The [companion resource API](TEXT_RESOURCES.md) serves applications
that request glyphs beyond their packaged coverage.

## Music library example

```sh
bun tools/pocket.ts build --target psp --manifest apps/music-cjk/pocket.json --project-root . -- --release
```

`apps/music-cjk/main.tsx` reads `library:tracks` from the package after mounting,
using `getText()` from `@pocketjs/framework/pak`. UTF-8 decoding works on QuickJS
without `TextDecoder`. The JSON contains Chinese and Japanese titles, file
paths, kana and an accented Latin filename. The component uses ordinary
`<Text>` throughout and requires no companion. This is a runtime metadata
example; the JSON is not a Memory Stick directory scan or an MP3 decoder.

D-pad or L/R changes the selection and displayed path. Square switches to a
192-distinct-Han-character grid. Changing grid pages and returning to the list
exercises data replacement, cached pages and stable pixels. The demo font is a
licensed subset with provenance in `assets/fonts/NotoSansCJK-Demo.md`; it is not
a complete Chinese or Japanese font distribution.

## PSPMAN feedback and acceptance

The public [PSPMAN issue repository](https://github.com/obsoletesony/PSPMAN-Issues)
contains app-specific renderer and archive diagnostics. Its source and private
font-cache patches are not part of this repository.

| Feedback | Framework regression | Acceptance boundary |
| --- | --- | --- |
| [#58](https://github.com/obsoletesony/PSPMAN-Issues/issues/58): `気` displays but `迫` fails | Both scalars have nonzero cmap entries and render as runtime title/path data | Confirms this covered string on PocketJS; does not establish the cause in PSPMAN's private font path |
| [#38](https://github.com/obsoletesony/PSPMAN-Issues/issues/38), [#37](https://github.com/obsoletesony/PSPMAN-Issues/issues/37): damaged Han glyphs; #38 also reports doubled rows | More than 140 distinct glyphs, page pressure, same-address atlas replacement, repeated list/grid transitions | Cache pressure never changes glyph identity; PSPMAN's artwork and duplicate-row issues need their own reproduction |
| [#8](https://github.com/obsoletesony/PSPMAN-Issues/issues/8): an accented filename is omitted; [#29](https://github.com/obsoletesony/PSPMAN-Issues/issues/29): Japanese paths were not discovered | UTF-8 package data retains the path and displays it | Font support does not repair a scanner that discards or misdecodes a directory entry; #29 is labelled fixed in Alpha 4 |

PSPMAN can consume the declarative character policy and the native page cache
through an updated PocketJS dependency. A custom font provider must keep source
glyph identity stable and advance the atlas revision when replacing pixels.
Its external archive still needs an adapter to these contracts. Closing the
downstream issues requires validation in PSPMAN itself.

Run `bun test tests/font-config.test.ts tests/music-cjk.test.ts` and
`cargo test --locked --manifest-path engine/core/Cargo.toml font_pages` for the
coverage, runtime-data and GPU-page ownership regressions. Store hardware
captures and per-run measurements under `.pocket-build/validation/`.
