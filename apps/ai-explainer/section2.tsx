import { createSignal } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { onButtonPress, onFrame } from "@pocketjs/framework/lifecycle";
import { BTN } from "@pocketjs/framework/input";

// ---------------------------------------------------------------------------
// Timings and Animation Configurations (Section 2 - Tokenization)
// ---------------------------------------------------------------------------

const TRACK_FRAMES = 2925; // 48.76 seconds @ 60 Hz

const CAPTIONS = [
  { start: 0, end: 192, text: "Computers never actually read words." },
  { start: 192, end: 408, text: "Everything must eventually become numbers." },
  { start: 408, end: 600, text: "The first step is called tokenization." },
  { start: 600, end: 810, text: "Instead of treating an entire sentence as one giant object," },
  { start: 810, end: 1080, text: "the tokenizer breaks it into smaller pieces called tokens." },
  { start: 1080, end: 1320, text: "Sometimes they're whole words. Sometimes they're parts of words. Sometimes they're punctuation." },
  { start: 1320, end: 1530, text: "Even emojis become tokens." },
  { start: 1530, end: 1680, text: "Every token receives an ID." },
  { start: 1680, end: 1920, text: "The language model never sees the word itself. It only sees these numerical IDs." },
  { start: 1920, end: 2100, text: "But IDs alone don't carry meaning." },
  { start: 2100, end: 2400, text: "Token 523 isn't inherently similar to token 524." },
  { start: 2400, end: 2700, text: "So the next challenge is teaching the model which words are actually related." },
  { start: 2700, end: 2925, text: "That's where vectors come in." }
];

const chipStarts = [780, 870, 960, 1050, 1350]; // frames for All, that, glitt, ers, 🔥

const CHIPS_DATA = [
  { val: "All", id: "1023" },
  { val: "that", id: "194" },
  { val: "glitt", id: "8856" },
  { val: "ers", id: "230" },
  { val: "🔥", id: "9532" }
];

function interpolate(frame: number, start: number, duration: number, from: number, to: number): number {
  if (frame < start) return from;
  if (frame > start + duration) return to;
  const t = (frame - start) / duration;
  const ease = t * t * (3 - 2 * t); // smoothstep
  return from + (to - from) * ease;
}

function toHexColor(r: number, g: number, b: number, a: number): string {
  const toHex = (x: number) => {
    const hex = Math.max(0, Math.min(255, Math.round(x))).toString(16);
    return hex.length === 1 ? "0" + hex : hex;
  };
  return `#${toHex(r)}${toHex(g)}${toHex(b)}${toHex(Math.round(a * 255))}`;
}

function interpolateColor(frame: number, start: number, duration: number, fromHex: string, toHex: string): string {
  const f = interpolate(frame, start, duration, 0, 1);
  
  const parseHex = (hex: string) => {
    const clean = hex.replace("#", "");
    const r = parseInt(clean.substring(0, 2), 16);
    const g = parseInt(clean.substring(2, 4), 16);
    const b = parseInt(clean.substring(4, 6), 16);
    return { r, g, b };
  };

  const cFrom = parseHex(fromHex);
  const cTo = parseHex(toHex);
  
  const r = Math.round(cFrom.r * (1 - f) + cTo.r * f);
  const g = Math.round(cFrom.g * (1 - f) + cTo.g * f);
  const b = Math.round(cFrom.b * (1 - f) + cTo.b * f);
  return toHexColor(r, g, b, 1);
}

export default function AiExplainerSection2() {
  const [position, setPosition] = createSignal(0);
  const [playing, setPlaying] = createSignal(true);

  onButtonPress(BTN.CIRCLE, () => setPlaying(!playing()));
  onButtonPress(BTN.RIGHT | BTN.RTRIGGER, () => setPosition((p) => Math.min(TRACK_FRAMES - 1, p + 300)));
  onButtonPress(BTN.LEFT | BTN.LTRIGGER, () => setPosition((p) => Math.max(0, p - 300)));

  onFrame(() => {
    if (!playing()) return;
    setPosition((p) => (p + 1) % TRACK_FRAMES);
  });

  const currentCaption = () => {
    const pos = position();
    const cap = CAPTIONS.find(c => pos >= c.start && pos < c.end);
    return cap ? cap.text : "";
  };

  const pos = () => position();

  // Left Panel Animation Functions
  const leftPanelX = () => {
    const p = pos();
    if (p < 60) return -80;
    if (p < 120) return interpolate(p, 60, 60, -80, 0);
    return 0;
  };

  const leftPanelY = () => {
    const p = pos();
    if (p > 2790) return interpolate(p, 2790, 60, 0, 100);
    return 0;
  };

  const leftPanelOpacity = () => {
    const p = pos();
    if (p < 60) return 0;
    if (p < 120) return interpolate(p, 60, 60, 0, 1);
    if (p > 2790) return interpolate(p, 2790, 60, 1, 0);
    return 1;
  };

  // Scanner Sweep Animation Functions
  const scannerOpacity = () => {
    const p = pos();
    if (p < 390) return 0;
    if (p < 420) return interpolate(p, 390, 30, 0, 0.8);
    if (p < 690) return 0.8;
    return interpolate(p, 690, 18, 0.8, 0);
  };

  const scannerX = () => {
    return interpolate(pos(), 420, 270, 0, 760);
  };

  // Text colors
  const getTextAllColor = () => {
    const p = pos();
    if (p < 780) return "#f8fafc";
    return interpolateColor(p, 780, 12, "#f8fafc", "#38bdf8");
  };

  const getTextThatColor = () => {
    const p = pos();
    if (p < 870) return "#f8fafc";
    return interpolateColor(p, 870, 12, "#f8fafc", "#38bdf8");
  };

  const getTextGlittersColor = () => {
    const p = pos();
    if (p < 960) return "#f8fafc";
    return interpolateColor(p, 960, 12, "#f8fafc", "#f43f5e");
  };

  const getEmojiOpacity = () => {
    return interpolate(pos(), 1290, 30, 0, 1);
  };

  // Chip dynamic state calculations
  const getChipOpacity = (i: number) => {
    const p = pos();
    const start = chipStarts[i];
    const base = interpolate(p, start, 30, 0, 1);
    const shift = interpolate(p, 2460, 48, 1, 0.5);
    return base * shift;
  };

  const getChipScale = (i: number) => {
    const p = pos();
    const start = chipStarts[i];
    const base = interpolate(p, start, 30, 0.8, 1);
    const shift = interpolate(p, 2460, 48, 1, 0.9);
    return base * shift;
  };

  const getChipTranslateY = () => {
    const p = pos();
    return interpolate(p, 2460, 48, 0, -20);
  };

  const getFlipFactor = () => {
    return interpolate(pos(), 1590, 48, 0, 1);
  };

  const getChipBorderColor = () => {
    const f = getFlipFactor();
    const red = Math.round(56 * (1 - f) + 96 * f);
    const green = Math.round(189 * (1 - f) + 165 * f);
    const blue = Math.round(248 * (1 - f) + 250 * f);
    return toHexColor(red, green, blue, 1);
  };

  const getChipBgColor = () => {
    const f = getFlipFactor();
    const red = Math.round(15 * (1 - f) + 30 * f);
    const green = Math.round(23 * (1 - f) + 41 * f);
    const blue = Math.round(42 * (1 - f) + 59 * f);
    return toHexColor(red, green, blue, 0.8);
  };

  const getChipWordOpacity = () => {
    return interpolate(pos(), 1590, 48, 1, 0.3);
  };

  // Right Panel Animation Functions
  const vocabPanelX = () => {
    const p = pos();
    if (p < 1890) return 40;
    if (p < 1950) return interpolate(p, 1890, 60, 40, 0);
    if (p > 2808) return interpolate(p, 2808, 60, 0, 100);
    return 0;
  };

  const vocabPanelOpacity = () => {
    const p = pos();
    if (p < 1890) return 0;
    if (p < 1950) return interpolate(p, 1890, 60, 0, 1);
    if (p < 2460) return 1;
    if (p < 2508) return interpolate(p, 2460, 48, 1, 0.3);
    if (p > 2808) return interpolate(p, 2808, 60, 0.3, 0);
    return 0.3;
  };

  // Row compare (row 523, 524)
  const getRowCompareColor = () => {
    const p = pos();
    if (p < 1980) return "#94a3b8";
    return interpolateColor(p, 1980, 48, "#94a3b8", "#ef4444");
  };

  const getRowCompareBg = () => {
    const p = pos();
    const factor = interpolate(p, 1980, 48, 0, 1);
    return toHexColor(239, 68, 68, 0.05 * factor);
  };

  const getRowCompareBorder = () => {
    const p = pos();
    const factor = interpolate(p, 1980, 48, 0, 1);
    return toHexColor(239, 68, 68, 0.2 * factor);
  };

  // Highlight rows (All, that, glitt, ers)
  const getVocabRowHighlightFactor = (index: number) => {
    const start = chipStarts[index];
    return interpolate(pos(), start, 30, 0, 1);
  };

  const getVocabRowBorder = (index: number) => {
    const factor = getVocabRowHighlightFactor(index);
    return toHexColor(56, 189, 248, 0.05 + 0.35 * factor);
  };

  const getVocabRowBg = (index: number) => {
    const factor = getVocabRowHighlightFactor(index);
    return toHexColor(56, 189, 248, 0.08 * factor);
  };

  const getVocabRowColor = (index: number) => {
    const start = chipStarts[index];
    return interpolateColor(pos(), start, 30, "#94a3b8", "#38bdf8");
  };

  const renderChip = (chip: typeof CHIPS_DATA[0], index: number) => {
    return (
      <View
        class="justify-center items-center flex-col"
        style={{
          opacity: getChipOpacity(index),
          scale: getChipScale(index),
          translateY: getChipTranslateY(),
          borderColor: getChipBorderColor(),
          bgColor: getChipBgColor(),
          borderWidth: 2,
          paddingT: 20, paddingR: 20, paddingB: 20, paddingL: 20,
          radius: 8,
          minW: 120,
        }}
      >
        <Text
          class="text-2xl font-bold text-white"
          style={{
            opacity: getChipWordOpacity(),
            marginB: 8,
          }}
        >
          {chip.val}
        </Text>
        <View
          class="w-full"
          style={{
            height: 1,
            bgColor: "#38bdf833",
            marginB: 8,
          }}
        />
        <Text class="text-sm font-bold text-center text-[#38bdf8]">
          ID: {chip.id}
        </Text>
      </View>
    );
  };

  return (
    <View debugName="AiExplainerSection2Root" class="w-full h-full bg-[#040814] relative overflow-hidden">
      {/* Background grid lines */}
      {Array.from({ length: 31 }).map((_, i) => (
        <View
          class="absolute bg-[#38bdf8]"
          style={{
            insetL: (i + 1) * 60,
            insetT: 0,
            width: 1,
            height: 1080,
            opacity: 0.05,
            zIndex: 1,
          }}
        />
      ))}
      {Array.from({ length: 17 }).map((_, i) => (
        <View
          class="absolute bg-[#38bdf8]"
          style={{
            insetL: 0,
            insetT: (i + 1) * 60,
            width: 1920,
            height: 1,
            opacity: 0.05,
            zIndex: 1,
          }}
        />
      ))}

      {/* Glowing Orbs */}
      <View
        class="absolute left-[-100] top-[200] w-[600] h-[600] rounded-full bg-gradient-to-b from-[#38bdf819] to-transparent"
        style={{
          scale: 1.0 + 0.12 * Math.sin(pos() * 0.02),
          zIndex: 2,
        }}
      />
      <View
        class="absolute right-[-100] top-[-100] w-[600] h-[600] rounded-full bg-gradient-to-b from-[#38bdf819] to-transparent"
        style={{
          scale: 1.0 + 0.12 * Math.cos(pos() * 0.02),
          zIndex: 2,
        }}
      />

      {/* Tech Header */}
      <View
        class="absolute top-0 left-0 w-full flex-row justify-between items-center bg-[#040814cc]"
        style={{
          height: 80,
          paddingL: 48,
          paddingR: 48,
          zIndex: 10,
        }}
      >
        <View class="flex-row items-center gap-3">
          <View class="w-4 h-4 rounded-full bg-[#38bdf8] shadow-md" />
          <Text class="text-2xl font-bold text-[#cbd5e1] tracking-wide">MODULE // TOKENIZATION_ENGINE</Text>
        </View>
        <Text class="text-xl font-bold text-[#64748b]">PREVIEW_MODE: PROTO_V1</Text>
        {/* Bottom border separator */}
        <View class="absolute bottom-0 left-0 w-full h-[2] bg-[#38bdf826]" />
      </View>

      {/* Content Columns */}
      <View
        class="w-full flex-row justify-between items-center"
        style={{
          height: 680,
          marginT: 120,
          paddingL: 48,
          paddingR: 48,
          zIndex: 5,
        }}
      >
        
        {/* Left Side: Tokenizer Machine */}
        <View
          class="relative justify-center flex-col"
          style={{
            width: 950,
            height: 600,
            radius: 24,
            bgColor: "#0f172a99",
            borderWidth: 2,
            borderColor: "#38bdf826",
            paddingT: 40, paddingR: 40, paddingB: 40, paddingL: 40,
            gap: 48,
            translateX: leftPanelX(),
            translateY: leftPanelY(),
            opacity: leftPanelOpacity(),
          }}
        >
          <Text class="absolute top-6 left-8 text-xl font-bold text-[#64748b] tracking-wide">// TOKENIZATION_PIPELINE</Text>

          {/* Text Input Box */}
          <View
            class="relative flex-row items-center"
            style={{
              bgColor: "#04081480",
              borderWidth: 1,
              borderColor: "#38bdf81a",
              paddingT: 32, paddingR: 32, paddingB: 32, paddingL: 32,
              radius: 12,
            }}
          >
            <Text
              class="text-2xl font-bold text-white tracking-wide"
              style={{ scale: 1.5 }}
            >
              <Text style={{ textColor: getTextAllColor() }}>All</Text>{" "}
              <Text style={{ textColor: getTextThatColor() }}>that</Text>{" "}
              <Text style={{ textColor: getTextGlittersColor() }}>glitters</Text>
              <Text style={{ opacity: getEmojiOpacity() }}> 🔥</Text>
            </Text>

            {/* Scanner line */}
            <View
              class="absolute bg-[#38bdf8] shadow-lg"
              style={{
                insetT: 0,
                width: 4,
                height: 104,
                insetL: scannerX(),
                opacity: scannerOpacity(),
              }}
            />
          </View>

          {/* Token output list */}
          <View
            class="flex-row flex-wrap items-center"
            style={{
              gap: 20,
              minH: 120,
            }}
          >
            {renderChip(CHIPS_DATA[0], 0)}
            {renderChip(CHIPS_DATA[1], 1)}
            {renderChip(CHIPS_DATA[2], 2)}
            {renderChip(CHIPS_DATA[3], 3)}
            {renderChip(CHIPS_DATA[4], 4)}
          </View>
        </View>

        {/* Right Side: Vocabulary Database Panel */}
        <View
          class="relative flex-col justify-center"
          style={{
            width: 720,
            height: 600,
            radius: 24,
            bgColor: "#0f172a66",
            borderWidth: 1,
            borderColor: "#38bdf81a",
            paddingT: 40, paddingR: 40, paddingB: 40, paddingL: 40,
            translateX: vocabPanelX(),
            opacity: vocabPanelOpacity(),
          }}
        >
          <Text class="absolute top-6 left-8 text-xl font-bold text-[#64748b] tracking-wide">// VOCABULARY DATABASE</Text>

          <View class="flex-col gap-3 mt-6">
            {/* Rows (unrelated rows that get highlighted red for comparison) */}
            <View
              class="flex-row justify-between rounded-lg"
              style={{
                bgColor: getRowCompareBg(),
                borderColor: getRowCompareBorder(),
                borderWidth: 1,
                paddingT: 12, paddingR: 12, paddingB: 12, paddingL: 12,
                radius: 8,
              }}
            >
              <Text class="text-lg font-bold" style={{ textColor: getRowCompareColor() }}>Token: 523</Text>
              <Text class="text-lg font-bold" style={{ textColor: getRowCompareColor() }}>"apple"</Text>
            </View>
            <View
              class="flex-row justify-between rounded-lg"
              style={{
                bgColor: getRowCompareBg(),
                borderColor: getRowCompareBorder(),
                borderWidth: 1,
                paddingT: 12, paddingR: 12, paddingB: 12, paddingL: 12,
                radius: 8,
              }}
            >
              <Text class="text-lg font-bold" style={{ textColor: getRowCompareColor() }}>Token: 524</Text>
              <Text class="text-lg font-bold" style={{ textColor: getRowCompareColor() }}>"orange"</Text>
            </View>

            {/* Matching rows that light up */}
            <View
              class="flex-row justify-between rounded-lg"
              style={{
                bgColor: getVocabRowBg(0),
                borderColor: getVocabRowBorder(0),
                borderWidth: 1,
                paddingT: 12, paddingR: 12, paddingB: 12, paddingL: 12,
                radius: 8,
              }}
            >
              <Text class="text-lg font-bold" style={{ textColor: getVocabRowColor(0) }}>Token: 1023</Text>
              <Text class="text-lg font-bold" style={{ textColor: getVocabRowColor(0) }}>"All"</Text>
            </View>
            <View
              class="flex-row justify-between rounded-lg"
              style={{
                bgColor: getVocabRowBg(1),
                borderColor: getVocabRowBorder(1),
                borderWidth: 1,
                paddingT: 12, paddingR: 12, paddingB: 12, paddingL: 12,
                radius: 8,
              }}
            >
              <Text class="text-lg font-bold" style={{ textColor: getVocabRowColor(1) }}>Token: 194</Text>
              <Text class="text-lg font-bold" style={{ textColor: getVocabRowColor(1) }}>"that"</Text>
            </View>
            <View
              class="flex-row justify-between rounded-lg"
              style={{
                bgColor: getVocabRowBg(2),
                borderColor: getVocabRowBorder(2),
                borderWidth: 1,
                paddingT: 12, paddingR: 12, paddingB: 12, paddingL: 12,
                radius: 8,
              }}
            >
              <Text class="text-lg font-bold" style={{ textColor: getVocabRowColor(2) }}>Token: 8856</Text>
              <Text class="text-lg font-bold" style={{ textColor: getVocabRowColor(2) }}>"glitt"</Text>
            </View>
            <View
              class="flex-row justify-between rounded-lg"
              style={{
                bgColor: getVocabRowBg(3),
                borderColor: getVocabRowBorder(3),
                borderWidth: 1,
                paddingT: 12, paddingR: 12, paddingB: 12, paddingL: 12,
                radius: 8,
              }}
            >
              <Text class="text-lg font-bold" style={{ textColor: getVocabRowColor(3) }}>Token: 230</Text>
              <Text class="text-lg font-bold" style={{ textColor: getVocabRowColor(3) }}>"ers"</Text>
            </View>
          </View>
        </View>
      </View>

      {/* Tech Footer */}
      <View
        class="absolute bottom-0 left-0 w-full flex-row justify-between items-center bg-[#040814cc]"
        style={{
          height: 60,
          paddingL: 48,
          paddingR: 48,
          zIndex: 10,
        }}
      >
        {/* Top border separator */}
        <View class="absolute top-0 left-0 w-full h-[2] bg-[#38bdf80d]" />
        <Text class="text-lg text-[#cbd5e1]">{`FRAME_TIME: ${String(Math.floor(pos() / 3600)).padStart(2, "0")}:${String(Math.floor((pos() % 3600) / 60)).padStart(2, "0")}:${String(pos() % 60).padStart(2, "0")}`}</Text>
        <Text class="text-lg text-[#cbd5e1]">SYS_METRIC: VOCABULARY_INDEXING</Text>
      </View>

      {/* Captions Overlay */}
      <View
        class="absolute items-center justify-center bg-[#0f172aE6] border border-[#38bdf833] rounded-[16]"
        style={{
          insetB: 100,
          insetL: 360,
          width: 1200,
          paddingL: 48,
          paddingR: 48,
          paddingT: 16,
          paddingB: 16,
          minH: 60,
          zIndex: 50,
        }}
      >
        <Text class="text-2xl font-bold text-center text-[#f8fafc]">
          {currentCaption()}
        </Text>
      </View>
    </View>
  );
}
