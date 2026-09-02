// apps/pocket-remote/icons.tsx — glyphs drawn from rectangles. The baked
// atlas carries only the text the source spells out, so an icon that leaned
// on a symbol codepoint would render as the tofu box on the device; these
// are Views, and they recolour with the theme like everything else.
//
// Every icon fills a 24x24 box positioned by its parent.

import { Text, View } from "@pocketjs/framework/components";
import { themed } from "./theme.ts";

/** Icon stroke tone: dimmed in the dock at rest, the theme foreground when
 *  the item is live, accent for the active workspace, dark on accent fills. */
type Tone = "fg" | "dim" | "accent" | "onAccent";
type Shape = "plain" | "rot45" | "rot90" | "rot135" | "rot315" | "dot4" | "dot8";

/**
 * A class string reaches the device as a whole literal looked up in the baked
 * table, so every tone x shape pair is spelled out here rather than composed.
 */
const STROKE: Record<Tone, Record<Shape, string>> = {
  fg: {
    plain: "absolute bg-[#a9b1d6]",
    rot45: "absolute bg-[#a9b1d6] rotate-45",
    rot90: "absolute bg-[#a9b1d6] rotate-90",
    rot135: "absolute bg-[#a9b1d6] rotate-135",
    rot315: "absolute bg-[#a9b1d6] rotate-315",
    dot4: "absolute bg-[#a9b1d6] rounded-[2]",
    dot8: "absolute bg-[#a9b1d6] rounded-[4]",
  },
  dim: {
    plain: "absolute bg-[#565f89]",
    rot45: "absolute bg-[#565f89] rotate-45",
    rot90: "absolute bg-[#565f89] rotate-90",
    rot135: "absolute bg-[#565f89] rotate-135",
    rot315: "absolute bg-[#565f89] rotate-315",
    dot4: "absolute bg-[#565f89] rounded-[2]",
    dot8: "absolute bg-[#565f89] rounded-[4]",
  },
  accent: {
    plain: "absolute bg-[#7aa2f7]",
    rot45: "absolute bg-[#7aa2f7] rotate-45",
    rot90: "absolute bg-[#7aa2f7] rotate-90",
    rot135: "absolute bg-[#7aa2f7] rotate-135",
    rot315: "absolute bg-[#7aa2f7] rotate-315",
    dot4: "absolute bg-[#7aa2f7] rounded-[2]",
    dot8: "absolute bg-[#7aa2f7] rounded-[4]",
  },
  onAccent: {
    plain: "absolute bg-[#13141c]",
    rot45: "absolute bg-[#13141c] rotate-45",
    rot90: "absolute bg-[#13141c] rotate-90",
    rot135: "absolute bg-[#13141c] rotate-135",
    rot315: "absolute bg-[#13141c] rotate-315",
    dot4: "absolute bg-[#13141c] rounded-[2]",
    dot8: "absolute bg-[#13141c] rounded-[4]",
  },
};

const strokeRef = (tone: Tone) => {
  switch (tone) {
    case "fg":
      return themed("fgFill");
    case "dim":
      return themed("fgDimFill");
    case "accent":
      return themed("accentFill");
    case "onAccent":
      return themed("surfaceDark");
  }
};

interface BarProps {
  tone: Tone;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Optional rotation in degrees. */
  rot?: 45 | 90 | 135 | 315;
  /** A round dot (w = h = 4 or 8). */
  round?: boolean;
}

/** One rectangle of an icon. */
function Bar(p: BarProps) {
  const shape: Shape =
    p.rot === 45 ? "rot45" : p.rot === 90 ? "rot90" : p.rot === 135 ? "rot135" : p.rot === 315 ? "rot315" : p.round ? (p.w >= 8 ? "dot8" : "dot4") : "plain";
  return (
    <View
      class={STROKE[p.tone][shape]}
      style={{ insetL: p.x, insetT: p.y, width: p.w, height: p.h }}
      ref={strokeRef(p.tone)}
    />
  );
}

export type IconName =
  | "menu"
  | "terminal"
  | "browser"
  | "files"
  | "editor"
  | "fullscreen"
  | "float"
  | "screenshot"
  | "keyboard"
  | "more"
  | "prev"
  | "play"
  | "next"
  | "sun"
  | "speaker"
  | "mute"
  | "levels"
  | "hide"
  | "close";

export function Icon(p: { name: IconName; tone: Tone }) {
  switch (p.name) {
    case "menu":
      // Omarchy's menu is the one thing on this remote that may borrow a
      // letter: Ω is in Inter's Greek block and the atlas bakes it from here.
      return (
        <View class="absolute left-0 top-0 w-[24] h-[24] items-center justify-center">
          <Text
            class={p.tone === "onAccent" ? "text-xl font-bold text-[#13141c]" : "text-xl font-bold text-[#a9b1d6]"}
            ref={themed(p.tone === "onAccent" ? "textOnAccent" : p.tone === "dim" ? "textDim" : "text")}
          >
            Ω
          </Text>
        </View>
      );
    case "terminal":
      return (
        <>
          <Bar tone={p.tone} x={2} y={4} w={20} h={2} />
          <Bar tone={p.tone} x={2} y={18} w={20} h={2} />
          <Bar tone={p.tone} x={2} y={4} w={2} h={16} />
          <Bar tone={p.tone} x={20} y={4} w={2} h={16} />
          <Bar tone={p.tone} x={6} y={8} w={5} h={2} rot={45} />
          <Bar tone={p.tone} x={6} y={12} w={5} h={2} rot={315} />
          <Bar tone={p.tone} x={12} y={14} w={6} h={2} />
        </>
      );
    case "browser":
      return (
        <>
          <View
            class="absolute left-[3] top-[3] w-[18] h-[18] rounded-full border-2 border-[#a9b1d6]"
            ref={themed(p.tone === "dim" ? "borderMuted" : "borderFg")}
          />
          <Bar tone={p.tone} x={3} y={11} w={18} h={2} />
          <View
            class="absolute left-[8] top-[3] w-[8] h-[18] rounded-full border-2 border-[#a9b1d6]"
            ref={themed(p.tone === "dim" ? "borderMuted" : "borderFg")}
          />
        </>
      );
    case "files":
      return (
        <>
          <Bar tone={p.tone} x={2} y={5} w={8} h={3} />
          <Bar tone={p.tone} x={2} y={7} w={20} h={13} />
        </>
      );
    case "editor":
      return (
        <>
          <Bar tone={p.tone} x={4} y={11} w={16} h={4} rot={315} />
          <Bar tone={p.tone} x={3} y={17} w={4} h={4} />
        </>
      );
    case "fullscreen":
      return (
        <>
          <Bar tone={p.tone} x={3} y={3} w={7} h={2} />
          <Bar tone={p.tone} x={3} y={3} w={2} h={7} />
          <Bar tone={p.tone} x={14} y={3} w={7} h={2} />
          <Bar tone={p.tone} x={19} y={3} w={2} h={7} />
          <Bar tone={p.tone} x={3} y={19} w={7} h={2} />
          <Bar tone={p.tone} x={3} y={14} w={2} h={7} />
          <Bar tone={p.tone} x={14} y={19} w={7} h={2} />
          <Bar tone={p.tone} x={19} y={14} w={2} h={7} />
        </>
      );
    case "float":
      return (
        <>
          <Bar tone={p.tone} x={3} y={3} w={13} h={2} />
          <Bar tone={p.tone} x={3} y={3} w={2} h={13} />
          <Bar tone={p.tone} x={3} y={14} w={6} h={2} />
          <Bar tone={p.tone} x={14} y={3} w={2} h={6} />
          <Bar tone={p.tone} x={8} y={8} w={13} h={13} />
        </>
      );
    case "screenshot":
      return (
        <>
          <Bar tone={p.tone} x={2} y={7} w={20} h={13} />
          <Bar tone={p.tone} x={8} y={4} w={8} h={3} />
          <View
            class="absolute left-[8] top-[10] w-[8] h-[8] rounded-full bg-[#1a1b26]"
            ref={themed("surface")}
          />
        </>
      );
    case "keyboard":
      return (
        <>
          <Bar tone={p.tone} x={2} y={6} w={20} h={2} />
          <Bar tone={p.tone} x={2} y={6} w={2} h={12} />
          <Bar tone={p.tone} x={20} y={6} w={2} h={12} />
          <Bar tone={p.tone} x={2} y={16} w={20} h={2} />
          <Bar tone={p.tone} x={6} y={9} w={2} h={2} />
          <Bar tone={p.tone} x={10} y={9} w={2} h={2} />
          <Bar tone={p.tone} x={14} y={9} w={2} h={2} />
          <Bar tone={p.tone} x={8} y={13} w={8} h={2} />
        </>
      );
    case "more":
      return (
        <>
          <Bar tone={p.tone} x={3} y={10} w={4} h={4} round />
          <Bar tone={p.tone} x={10} y={10} w={4} h={4} round />
          <Bar tone={p.tone} x={17} y={10} w={4} h={4} round />
        </>
      );
    case "prev":
      return (
        <>
          <Bar tone={p.tone} x={5} y={6} w={2} h={12} />
          <Bar tone={p.tone} x={9} y={8} w={8} h={2} rot={315} />
          <Bar tone={p.tone} x={9} y={14} w={8} h={2} rot={45} />
        </>
      );
    case "play":
      return (
        <>
          <Bar tone={p.tone} x={8} y={8} w={8} h={2} rot={45} />
          <Bar tone={p.tone} x={8} y={14} w={8} h={2} rot={315} />
        </>
      );
    case "next":
      return (
        <>
          <Bar tone={p.tone} x={7} y={8} w={8} h={2} rot={45} />
          <Bar tone={p.tone} x={7} y={14} w={8} h={2} rot={315} />
          <Bar tone={p.tone} x={17} y={6} w={2} h={12} />
        </>
      );
    case "sun":
      return (
        <>
          <Bar tone={p.tone} x={8} y={8} w={8} h={8} round />
          <Bar tone={p.tone} x={11} y={2} w={2} h={4} />
          <Bar tone={p.tone} x={11} y={18} w={2} h={4} />
          <Bar tone={p.tone} x={2} y={11} w={4} h={2} />
          <Bar tone={p.tone} x={18} y={11} w={4} h={2} />
          <Bar tone={p.tone} x={4} y={4} w={4} h={2} rot={45} />
          <Bar tone={p.tone} x={16} y={18} w={4} h={2} rot={45} />
          <Bar tone={p.tone} x={16} y={4} w={4} h={2} rot={315} />
          <Bar tone={p.tone} x={4} y={18} w={4} h={2} rot={315} />
        </>
      );
    case "speaker":
      // A horn in three steps, then two sound bars.
      return (
        <>
          <Bar tone={p.tone} x={2} y={9} w={4} h={6} />
          <Bar tone={p.tone} x={6} y={7} w={3} h={10} />
          <Bar tone={p.tone} x={9} y={5} w={3} h={14} />
          <Bar tone={p.tone} x={15} y={9} w={2} h={6} />
          <Bar tone={p.tone} x={19} y={6} w={2} h={12} />
        </>
      );
    case "mute":
      return (
        <>
          <Bar tone={p.tone} x={2} y={9} w={4} h={6} />
          <Bar tone={p.tone} x={6} y={7} w={3} h={10} />
          <Bar tone={p.tone} x={9} y={5} w={3} h={14} />
          <Bar tone={p.tone} x={14} y={11} w={8} h={2} rot={45} />
          <Bar tone={p.tone} x={14} y={11} w={8} h={2} rot={315} />
        </>
      );
    case "levels":
      // Two sliders with their knobs, the control-centre glyph.
      return (
        <>
          <Bar tone={p.tone} x={3} y={8} w={18} h={2} />
          <Bar tone={p.tone} x={13} y={5} w={4} h={8} round />
          <Bar tone={p.tone} x={3} y={16} w={18} h={2} />
          <Bar tone={p.tone} x={7} y={13} w={4} h={8} round />
        </>
      );
    case "hide":
      // A chevron pointing down: put the keyboard away.
      return (
        <>
          <Bar tone={p.tone} x={5} y={11} w={8} h={2} rot={45} />
          <Bar tone={p.tone} x={11} y={11} w={8} h={2} rot={315} />
        </>
      );
    case "close":
      return (
        <>
          <Bar tone={p.tone} x={5} y={11} w={14} h={2} rot={45} />
          <Bar tone={p.tone} x={5} y={11} w={14} h={2} rot={315} />
        </>
      );
  }
}
