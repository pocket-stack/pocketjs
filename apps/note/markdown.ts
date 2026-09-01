// apps/note/markdown.ts — a small block + inline markdown parser.
//
// Purpose-built for the note widget: no HTML, no references, no nesting
// beyond one list level of indentation — the subset that keeps a desktop
// sticky-note honest. The parser is pure string → data so it unit-tests in
// bun without a host; rendering decisions (fonts, colors, wrap) live in
// layout.ts. Every block records the [start, end) line range it came from,
// so view-mode clicks can drop an edit caret near the right source line.

export type SpanStyle = "plain" | "bold" | "em" | "code" | "link";

export interface Span {
  text: string;
  style: SpanStyle;
}

export type Block =
  | { kind: "h1" | "h2" | "h3"; spans: Span[]; line: number; endLine: number }
  | { kind: "p"; spans: Span[]; line: number; endLine: number }
  | {
      kind: "li";
      spans: Span[];
      /** "•" for bullets, "1." style labels for ordered items. */
      marker: string;
      /** 0 for top-level items, 1 for one indent step (2+ spaces). */
      depth: number;
      line: number;
      endLine: number;
    }
  | { kind: "quote"; spans: Span[]; line: number; endLine: number }
  | { kind: "code"; text: string; line: number; endLine: number }
  | { kind: "hr"; line: number; endLine: number };

// ---------------------------------------------------------------------------
// Inline spans
// ---------------------------------------------------------------------------

/** Merge adjacent spans of one style (keeps the seg count low). */
function push(spans: Span[], text: string, style: SpanStyle): void {
  if (text === "") return;
  const last = spans[spans.length - 1];
  if (last && last.style === style) last.text += text;
  else spans.push({ text, style });
}

/** Find `close` at or after `from`, not preceded by a backslash. */
function findClose(text: string, close: string, from: number): number {
  let i = text.indexOf(close, from);
  while (i > 0 && text[i - 1] === "\\") i = text.indexOf(close, i + 1);
  return i;
}

/**
 * Scan one line's inline markup: `code`, **bold**, *em* / _em_, [text](url).
 * Unterminated markers stay literal — mid-edit text should read as typed,
 * not vanish into a style.
 */
export function parseInline(text: string): Span[] {
  const spans: Span[] = [];
  let plain = "";
  let i = 0;
  const flush = () => {
    push(spans, plain, "plain");
    plain = "";
  };
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\" && i + 1 < text.length) {
      plain += text[i + 1];
      i += 2;
      continue;
    }
    if (ch === "`") {
      const end = findClose(text, "`", i + 1);
      if (end > i) {
        flush();
        push(spans, text.slice(i + 1, end), "code");
        i = end + 1;
        continue;
      }
    }
    if (text.startsWith("**", i)) {
      const end = findClose(text, "**", i + 2);
      if (end > i + 1) {
        flush();
        for (const inner of parseInline(text.slice(i + 2, end))) {
          // Bold wins over nested styles except code.
          push(spans, inner.text, inner.style === "code" ? "code" : "bold");
        }
        i = end + 2;
        continue;
      }
    }
    if (ch === "*" || ch === "_") {
      const end = findClose(text, ch, i + 1);
      // An emphasis run must be non-empty and not start with a space
      // (so "3 * 4 * 5" stays arithmetic).
      if (end > i + 1 && text[i + 1] !== " ") {
        flush();
        push(spans, text.slice(i + 1, end), "em");
        i = end + 1;
        continue;
      }
    }
    if (ch === "[") {
      const close = findClose(text, "]", i + 1);
      if (close > i && text[close + 1] === "(") {
        const paren = findClose(text, ")", close + 2);
        if (paren > close) {
          flush();
          push(spans, text.slice(i + 1, close), "link");
          i = paren + 1;
          continue;
        }
      }
    }
    plain += ch;
    i++;
  }
  flush();
  return spans;
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

const HR = /^ {0,3}(-{3,}|\*{3,}|_{3,})\s*$/;
const ORDERED = /^( *)(\d{1,3})\. (.*)$/;

export function parseMarkdown(src: string): Block[] {
  const lines = src.split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const start = i;

    if (line.trim() === "") {
      i++;
      continue;
    }

    // Fenced code: everything verbatim until the closing fence (or EOF —
    // an unterminated fence mid-edit swallows the tail, verbatim).
    if (line.startsWith("```")) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        body.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // closing fence
      blocks.push({ kind: "code", text: body.join("\n"), line: start, endLine: i });
      continue;
    }

    if (HR.test(line)) {
      blocks.push({ kind: "hr", line: start, endLine: i + 1 });
      i++;
      continue;
    }

    const heading = /^(#{1,3}) (.*)$/.exec(line);
    if (heading) {
      const kind = (["h1", "h2", "h3"] as const)[heading[1].length - 1];
      blocks.push({ kind, spans: parseInline(heading[2]), line: start, endLine: i + 1 });
      i++;
      continue;
    }

    if (line.startsWith("> ") || line === ">") {
      const body: string[] = [];
      while (i < lines.length && (lines[i].startsWith("> ") || lines[i] === ">")) {
        body.push(lines[i] === ">" ? "" : lines[i].slice(2));
        i++;
      }
      blocks.push({ kind: "quote", spans: parseInline(body.join("\n")), line: start, endLine: i });
      continue;
    }

    const bullet = /^( *)[-*+] (.*)$/.exec(line);
    const ordered = ORDERED.exec(line);
    if (bullet || ordered) {
      const indent = (bullet ?? ordered)![1].length;
      const text = bullet ? bullet[2] : ordered![3];
      blocks.push({
        kind: "li",
        spans: parseInline(text),
        marker: bullet ? "•" : `${ordered![2]}.`,
        depth: indent >= 2 ? 1 : 0,
        line: start,
        endLine: i + 1,
      });
      i++;
      continue;
    }

    // Paragraph: soft-join consecutive plain lines.
    const body: string[] = [];
    while (i < lines.length) {
      const l = lines[i];
      if (
        l.trim() === "" ||
        l.startsWith("```") ||
        l.startsWith("#") ||
        l.startsWith("> ") ||
        l === ">" ||
        HR.test(l) ||
        /^( *)[-*+] /.test(l) ||
        ORDERED.test(l)
      ) {
        break;
      }
      body.push(l);
      i++;
    }
    blocks.push({ kind: "p", spans: parseInline(body.join(" ")), line: start, endLine: i });
  }
  return blocks;
}
