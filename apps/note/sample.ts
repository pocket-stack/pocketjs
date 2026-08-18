// apps/note/sample.ts — the note the widget wakes up with.
//
// Doubles as the font-atlas charset anchor: the baker harvests codepoints
// from source literals, so everything the sample renders is guaranteed
// baked. Beyond the baked set, the widget host rasterizes new glyphs at
// runtime (text.glyphs.runtime) and the gpui host shapes through the OS
// text system (text.layout.native, docs/BACKENDS.md) — tofu is a
// console-target concern only.

export const SAMPLE_DOC = `# Pocket Note

A markdown sticky for your desktop — one process, a real PocketJS app.

## What works

- **Bold**, *emphasis*, \`inline code\`, [links](https://pocketjs.dev)
- Bullet and numbered lists
  - one level of nesting
- Quotes, rules, fenced code

> The window is the ui surface: same core, same DrawList —
> painted from baked atlases by wgpu, or with native text
> by gpui (docs/BACKENDS.md).

\`\`\`
bun run macos note   # gpui backend, native text
bun run note         # wgpu widget, baked atlases
\`\`\`

---

1. The pencil toggles into editing; the eye back to preview
2. Drag to select in either mode; Cmd-C, Cmd-X, Cmd-V work
3. Cmd-Z / Shift-Cmd-Z undo and redo
4. Drag the header to move, the corner to resize; dots for the menu

*Idle costs nothing: no dirt, no frame.*
`;
