// demos/note/sample.ts — the note the widget wakes up with.
//
// Doubles as the font-atlas charset anchor: the baker harvests codepoints
// from source literals, so everything the sample renders is guaranteed
// baked. Typing sticks to ASCII (always baked, 32..126); other input
// renders as tofu until a CJK-capable atlas lands (known v1 limit).

export const SAMPLE_DOC = `# Pocket Note

A markdown sticky for your desktop — one process, a real PocketJS app.

## What works

- **Bold**, *emphasis*, \`inline code\`, [links](https://pocketjs.dev)
- Bullet and numbered lists
  - one level of nesting
- Quotes, rules, fenced code

> The window is the ui surface: same core, same DrawList,
> same bytes as the PSP build.

\`\`\`
bun scripts/build.ts note-main --density=2
cargo run -p note-widget
\`\`\`

---

1. The I-beam toggles into editing; the eye back to preview
2. Drag to select in either mode; Cmd-C copies
3. Cmd-Z / Shift-Cmd-Z undo and redo
4. Drag the header to move, the corner to resize; dots for the menu

*Idle costs nothing: no dirt, no frame.*
`;
