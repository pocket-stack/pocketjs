// test/note.test.ts — Pocket Note: markdown parser + editor caret math
// (pure, fake measure), plus a sim boot smoke test.
//
//   bun scripts/build.ts note-main && bun test test/note.test.ts

import { describe, expect, test } from "bun:test";
import { parseInline, parseMarkdown } from "../demos/note/markdown.ts";
import {
  backspace,
  caretFromX,
  caretLine,
  caretX,
  insertAt,
  layoutDoc,
  lineEnd,
  lineStart,
  moveVertical,
} from "../demos/note/editor.ts";
import { runScenario, treeHasText } from "../host-sim/sim.ts";

// ---------------------------------------------------------------------------
// markdown.ts
// ---------------------------------------------------------------------------

describe("markdown blocks", () => {
  test("headings, paragraphs, rules", () => {
    const blocks = parseMarkdown("# Title\n\nBody one\nBody two\n\n---\n\n## Sub");
    expect(blocks.map((b) => b.kind)).toEqual(["h1", "p", "hr", "h2"]);
    const p = blocks[1];
    if (p.kind !== "p") throw new Error("expected p");
    // Soft-joined paragraph.
    expect(p.spans[0].text).toBe("Body one Body two");
    expect(p.line).toBe(2);
  });

  test("lists carry markers and depth", () => {
    const blocks = parseMarkdown("- a\n  - b\n1. c\n12. d");
    expect(blocks.map((b) => (b.kind === "li" ? `${b.marker}/${b.depth}` : "?"))).toEqual([
      "•/0",
      "•/1",
      "1./0",
      "12./0",
    ]);
  });

  test("fenced code is verbatim, unterminated fence swallows the tail", () => {
    const blocks = parseMarkdown("```\na **b**\n```\n\n```\ntail");
    expect(blocks.map((b) => b.kind)).toEqual(["code", "code"]);
    const [a, b] = blocks;
    if (a.kind !== "code" || b.kind !== "code") throw new Error("expected code");
    expect(a.text).toBe("a **b**");
    expect(b.text).toBe("tail");
  });

  test("quotes merge adjacent lines", () => {
    const blocks = parseMarkdown("> a\n> b");
    expect(blocks).toHaveLength(1);
    const q = blocks[0];
    if (q.kind !== "quote") throw new Error("expected quote");
    expect(q.spans[0].text).toBe("a\nb");
  });
});

describe("markdown inline", () => {
  test("styles split into spans", () => {
    expect(parseInline("a **b** `c` *d* [e](f)")).toEqual([
      { text: "a ", style: "plain" },
      { text: "b", style: "bold" },
      { text: " ", style: "plain" },
      { text: "c", style: "code" },
      { text: " ", style: "plain" },
      { text: "d", style: "em" },
      { text: " ", style: "plain" },
      { text: "e", style: "link" },
    ]);
  });

  test("unterminated markers stay literal", () => {
    expect(parseInline("a **b")).toEqual([{ text: "a **b", style: "plain" }]);
    expect(parseInline("3 * 4 * 5")).toEqual([{ text: "3 * 4 * 5", style: "plain" }]);
  });

  test("escapes suppress markup", () => {
    expect(parseInline("\\*not em\\*")).toEqual([{ text: "*not em*", style: "plain" }]);
  });
});

// ---------------------------------------------------------------------------
// editor.ts — fake measure: every char 10px, so maxW 100 = 10 chars/line
// ---------------------------------------------------------------------------

const M = (text: string) => text.length * 10;

describe("editor wrap", () => {
  test("every source char lands on exactly one line", () => {
    const doc = "alpha beta gamma delta\n\nepsilon";
    const lines = layoutDoc(doc, 100, M);
    // Offsets tile the document: each line starts where wrap math put it,
    // hard-broken lines skip their '\n'.
    let cursor = 0;
    for (const line of lines) {
      expect(line.start).toBeGreaterThanOrEqual(cursor);
      expect(line.start - cursor).toBeLessThanOrEqual(1); // at most the '\n'
      expect(line.end).toBeGreaterThanOrEqual(line.start);
      cursor = line.end;
    }
    expect(cursor).toBe(doc.length);
  });

  test("soft breaks land after a space", () => {
    const lines = layoutDoc("alpha beta gamma", 100, M);
    // "alpha beta" is exactly 10 chars — fits; break after its space.
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ start: 0, end: 6, soft: true });
    expect(lines[1]).toMatchObject({ start: 6, end: 16, soft: false });
  });

  test("spaceless overflow breaks mid-word; empty lines survive", () => {
    const lines = layoutDoc("abcdefghijklmno\n\nx", 100, M);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatchObject({ start: 0, end: 10, soft: true });
    expect(lines[1]).toMatchObject({ start: 10, end: 15, soft: false });
    expect(lines[2]).toMatchObject({ start: 16, end: 16 });
    expect(lines[3]).toMatchObject({ start: 17, end: 18 });
  });
});

describe("editor caret", () => {
  const doc = "alpha beta gamma";
  const lines = layoutDoc(doc, 100, M); // ["alpha ", "beta gamma"] offsets 0..6, 6..16

  test("caret at a soft boundary belongs to the next line", () => {
    expect(caretLine(lines, 5)).toBe(0);
    expect(caretLine(lines, 6)).toBe(1);
    expect(caretLine(lines, 16)).toBe(1);
  });

  test("caret x measures the line prefix", () => {
    expect(caretX(doc, lines, 8, M)).toBe(20); // "be" on line 1
  });

  test("click placement snaps to nearest boundary and round-trips", () => {
    expect(caretFromX(doc, lines, 1, 24, M)).toBe(8); // 24px → after "be"
    expect(caretFromX(doc, lines, 1, 26, M)).toBe(9); // past midpoint → "bet|"
    expect(caretFromX(doc, lines, 0, 999, M)).toBe(5); // end of soft line: before its space
    expect(caretFromX(doc, lines, 1, 999, M)).toBe(16);
  });

  test("vertical moves keep the goal column", () => {
    expect(moveVertical(doc, lines, 8, -1, 20, M)).toBe(2); // up from "be|" → "al|"
    expect(moveVertical(doc, lines, 2, 1, 20, M)).toBe(8);
    expect(moveVertical(doc, lines, 2, -1, 20, M)).toBe(0); // top exits to 0
    expect(moveVertical(doc, lines, 8, 1, 20, M)).toBe(doc.length);
  });

  test("home/end respect soft trailing spaces", () => {
    expect(lineStart(lines, 3)).toBe(0);
    expect(lineEnd(lines, 3)).toBe(5); // before the soft space
    expect(lineEnd(lines, 8)).toBe(16);
  });

  test("edits move the caret with the text", () => {
    let s = { doc: "ab", caret: 1 };
    s = insertAt(s, "XY");
    expect(s).toEqual({ doc: "aXYb", caret: 3 });
    s = backspace(s);
    expect(s).toEqual({ doc: "aXb", caret: 2 });
  });
});

// ---------------------------------------------------------------------------
// sim smoke: the bundle boots on a plain ui host and renders the sample
// ---------------------------------------------------------------------------

describe("note-main boots standalone", () => {
  test("sample note renders without a widget host", async () => {
    const trace = await runScenario({ app: "note-main", seconds: 2 });
    expect(treeHasText(trace.tree, "POCKET NOTE")).toBe(true);
    expect(treeHasText(trace.tree, "What works")).toBe(true);
  }, 30000);
});
