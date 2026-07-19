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

1. Click the text to edit (Esc or DONE to finish)
2. Drag the header to move, the corner to resize
3. The dots menu has theme, reset and close

*Idle costs nothing: no dirt, no frame.*
`;
