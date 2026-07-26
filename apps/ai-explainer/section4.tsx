import { createSignal } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { onButtonPress, onFrame } from "@pocketjs/framework/lifecycle";
import { BTN } from "@pocketjs/framework/input";

// ---------------------------------------------------------------------------
// Timings and Animation Configurations (Section 4 - Attention Mechanism)
// ---------------------------------------------------------------------------

const TRACK_FRAMES = 3520; // 58.68 seconds @ 60 Hz

const CAPTIONS = [
  { start: 0, end: 408, text: 'In 2017, a team of Google researchers published a paper that changed everything: "Attention Is All You Need".' },
  { start: 408, end: 828, text: "Attention allows a model to look at a sentence and weigh the relationships between words." },
  { start: 828, end: 1470, text: 'Consider these two sentences: "Apple released new Macs" versus "Apple tastes delicious".' },
  { start: 1470, end: 1830, text: 'In the first sentence, the attention mechanism draws a strong connection between "Apple" and "Macs".' },
  { start: 1830, end: 2220, text: 'This context shifts the vector representation of "Apple" closer to "Microsoft" and technology.' },
  { start: 2220, end: 2490, text: 'In the second, it connects "Apple" with "tastes" and "delicious",' },
  { start: 2490, end: 2700, text: "shifting its meaning toward fruit." },
  { start: 2700, end: 2970, text: "Instead of reading words in isolation, the model dynamically computes context weights for every single token." },
  { start: 2970, end: 3240, text: "This was so revolutionary, researchers abandoned previous architectures like LSTMs" },
  { start: 3240, end: 3520, text: "and built a brand new system entirely around attention. They called it: The Transformer." }
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

export default function AiExplainerSection4() {
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
    const cap = CAPTIONS.find((c) => pos >= c.start && pos < c.end);
    return cap ? cap.text : "";
  };

  const pos = () => position();

  // Stage 1: Google Paper Card (90f - 690f / 1.5s - 11.5s)
  const paperOpacity = () => {
    const p = pos();
    if (p < 90) return 0;
    if (p < 150) return interpolate(p, 90, 60, 0, 1);
    if (p < 690) return 1;
    if (p < 750) return interpolate(p, 690, 60, 1, 0);
    return 0;
  };

  const paperScale = () => {
    const p = pos();
    if (p < 90) return 0.8;
    if (p < 150) return interpolate(p, 90, 60, 0.8, 1.0);
    if (p < 690) return 1.0;
    if (p < 750) return interpolate(p, 690, 60, 1.0, 0.8);
    return 0.8;
  };

  // Stage 2: Attention Comparison Frame (810f - 2880f / 13.5s - 48s)
  const attFrameOpacity = () => {
    const p = pos();
    if (p < 810) return 0;
    if (p < 870) return interpolate(p, 810, 60, 0, 1);
    if (p < 2880) return 1;
    if (p < 2940) return interpolate(p, 2880, 60, 1, 0);
    return 0;
  };

  const attFrameScale = () => {
    const p = pos();
    if (p >= 2880) return interpolate(p, 2880, 60, 1.0, 0.95);
    return 1.0;
  };

  // Token list entrance stagger
  const tokenY = () => {
    const p = pos();
    if (p < 850) return 30;
    if (p < 890) return interpolate(p, 850, 40, 30, 0);
    return 0;
  };

  const tokenOpacity = () => interpolate(pos(), 850, 40, 0, 1);

  // Case 1: Tech connection (1500f - 2250f / 25s - 37.5s)
  const techLineOpacity = () => {
    const p = pos();
    if (p < 1500) return 0;
    if (p < 1560) return interpolate(p, 1500, 60, 0, 0.85);
    return 0.85;
  };

  const techBadgeOpacity = () => interpolate(pos(), 1560, 30, 0, 1);

  const techIndicatorX = () => {
    const p = pos();
    if (p < 1680) return 40;
    if (p < 1728) return interpolate(p, 1680, 48, 40, 0);
    return 0;
  };

  const techIndicatorOpacity = () => interpolate(pos(), 1680, 48, 0, 1);

  const techAppleBg = () => {
    const p = pos();
    if (p >= 1710 && p < 1758) return interpolateColor(p, 1710, 48, "#040814b3", "#38bdf81f");
    if (p >= 1758) return "#38bdf81f";
    return "#040814b3";
  };

  const techAppleX = () => {
    const p = pos();
    if (p >= 1710 && p < 1758) return interpolate(p, 1710, 48, 0, 30);
    if (p >= 1758) return 30;
    return 0;
  };

  // Case 2: Food connection (2250f - 2880f / 37.5s - 48s)
  const foodLineOpacity = () => {
    const p = pos();
    if (p < 2250) return 0;
    if (p < 2310) return interpolate(p, 2250, 60, 0, 0.85);
    return 0.85;
  };

  const foodBadgeOpacity = () => interpolate(pos(), 2310, 30, 0, 1);

  const foodIndicatorX = () => {
    const p = pos();
    if (p < 2430) return 40;
    if (p < 2478) return interpolate(p, 2430, 48, 40, 0);
    return 0;
  };

  const foodIndicatorOpacity = () => interpolate(pos(), 2430, 48, 0, 1);

  const foodAppleBg = () => {
    const p = pos();
    if (p >= 2460 && p < 2508) return interpolateColor(p, 2460, 48, "#040814b3", "#34d3991f");
    if (p >= 2508) return "#34d3991f";
    return "#040814b3";
  };

  const foodAppleX = () => {
    const p = pos();
    if (p >= 2460 && p < 2508) return interpolate(p, 2460, 48, 0, 30);
    if (p >= 2508) return 30;
    return 0;
  };

  // Stage 3: LSTM vs Transformer Reveal (2970f - 3420f / 49.5s - 57s)
  const transformerBoxOpacity = () => {
    const p = pos();
    if (p < 2970) return 0;
    if (p < 3030) return interpolate(p, 2970, 60, 0, 1);
    if (p < 3420) return 1;
    if (p < 3480) return interpolate(p, 3420, 60, 1, 0);
    return 0;
  };

  const transformerBoxScale = () => {
    const p = pos();
    if (p < 2970) return 0.8;
    if (p < 3030) return interpolate(p, 2970, 60, 0.8, 1.0);
    if (p < 3420) return 1.0;
    if (p < 3480) return interpolate(p, 3420, 60, 1.0, 1.1);
    return 0.8;
  };

  // LSTM Cross-out strike line
  const lstmCrossScaleX = () => interpolate(pos(), 3120, 48, 0, 1);

  const lstmBoxColor = () => {
    const p = pos();
    if (p >= 3150) return "#ef4444";
    return "#cbd5e1";
  };

  const lstmBoxBorder = () => {
    const p = pos();
    if (p >= 3150) return "#ef4444";
    return "#38bdf833";
  };

  const lstmBoxOpacity = () => {
    const p = pos();
    if (p >= 3150) return 0.4;
    return 1.0;
  };

  const transCardScale = () => {
    const p = pos();
    if (p >= 3210 && p < 3246) return interpolate(p, 3210, 36, 1.0, 1.1);
    if (p >= 3246 && p < 3282) return interpolate(p, 3246, 36, 1.1, 1.0);
    return 1.0;
  };

  return (
    <View class="absolute w-[1920] h-[1080] bg-slate-950 overflow-hidden">
      {/* Background Grid Pattern */}
      <View class="absolute w-[1920] h-[1080]" style={{ zIndex: 1, bgColor: "#040814" }} />

      {/* Glowing Orbs */}
      <View
        class="absolute w-[600] h-[600] rounded-full"
        style={{
          insetT: -200,
          insetL: -100,
          bgColor: "#38bdf80f",
          zIndex: 2,
        }}
      />
      <View
        class="absolute w-[600] h-[600] rounded-full"
        style={{
          insetB: -200,
          insetR: -100,
          bgColor: "#38bdf80f",
          zIndex: 2,
        }}
      />

      {/* Technical Header */}
      <View
        class="absolute flex-row justify-between items-center px-16"
        style={{
          insetT: 0,
          insetL: 0,
          width: 1920,
          height: 80,
          bgColor: "#040814cc",
          zIndex: 10,
        }}
      >
        {/* Bottom Border Line */}
        <View class="absolute" style={{ insetB: 0, insetL: 0, width: 1920, height: 2, bgColor: "#38bdf81a" }} />

        <View class="flex-row items-center gap-3">
          <View class="w-3 h-3 rounded-full bg-sky-400" />
          <Text class="text-lg font-bold text-sky-400">MODULE // ATTENTION_MECHANISM</Text>
        </View>
        <Text class="text-base text-slate-400 font-bold">PREVIEW_MODE: PROTO_V1</Text>
      </View>

      {/* Main Content Area */}
      <View class="absolute flex-row justify-center items-center" style={{ insetT: 140, insetL: 100, width: 1720, height: 680, zIndex: 5 }}>
        
        {/* Stage 1: Google Research Paper Card */}
        <View
          class="absolute flex-col justify-center items-center p-10 rounded-xl border-2 border-sky-400"
          style={{
            width: 580,
            height: 480,
            bgColor: "#0f172acc",
            borderColor: "#38bdf84d",
            opacity: paperOpacity(),
            scale: paperScale(),
            zIndex: 8,
          }}
        >
          <View class="px-3 py-1 rounded border border-sky-400 mb-6" style={{ borderColor: "#38bdf8" }}>
            <Text class="text-xs font-bold text-sky-400">RESEARCH // GOOGLE_2017</Text>
          </View>
          <Text class="text-4xl font-bold text-slate-50 text-center mb-5">Attention Is All You Need</Text>
          <Text class="text-base font-bold text-slate-400 text-center">Vaswani, Shazeer, Parmar, Uszkoreit, Jones...</Text>
        </View>

        {/* Stage 2: Attention Comparison Frame */}
        <View
          class="w-[1720] h-[680] flex-col justify-between"
          style={{
            opacity: attFrameOpacity(),
            scale: attFrameScale(),
          }}
        >
          {/* Row 1: Technology Context */}
          <View
            class="flex-row justify-between items-center p-10 rounded-xl border border-sky-400"
            style={{
              height: 310,
              bgColor: "#0f172a99",
              borderColor: "#38bdf81a",
            }}
          >
            <View class="absolute" style={{ insetT: 15, insetL: 25 }}>
              <Text class="text-xs font-bold text-slate-400">CASE_01 // TECHNOLOGY_MAPPING</Text>
            </View>

            {/* Tokens List */}
            <View class="flex-row gap-6 items-center" style={{ translateY: tokenY(), opacity: tokenOpacity() }}>
              <View
                class="px-7 py-4 rounded-xl border-2 border-sky-400"
                style={{
                  bgColor: techAppleBg(),
                  translateX: techAppleX(),
                }}
              >
                <Text class="text-2xl font-bold text-slate-50">Apple</Text>
              </View>

              <View class="px-7 py-4 rounded-xl border-2 border-sky-400" style={{ bgColor: "#040814b3", borderColor: "#38bdf833" }}>
                <Text class="text-2xl font-bold text-slate-50">released</Text>
              </View>

              <View class="px-7 py-4 rounded-xl border-2 border-sky-400" style={{ bgColor: "#040814b3", borderColor: "#38bdf833" }}>
                <Text class="text-2xl font-bold text-slate-50">new</Text>
              </View>

              <View class="px-7 py-4 rounded-xl border-2 border-sky-400" style={{ bgColor: "#040814b3", borderColor: "#38bdf8" }}>
                <Text class="text-2xl font-bold text-slate-50">Macs</Text>
              </View>
            </View>

            {/* Connection Connector Line: Apple -> Macs */}
            <View
              class="absolute h-[3]"
              style={{
                insetL: 140,
                insetT: 100,
                width: 580,
                bgColor: "#38bdf8",
                opacity: techLineOpacity(),
              }}
            />
            <View
              class="absolute px-3 py-1 rounded border border-sky-400"
              style={{
                insetL: 400,
                insetT: 75,
                bgColor: "#040814",
                borderColor: "#38bdf8",
                opacity: techBadgeOpacity(),
              }}
            >
              <Text class="text-xs font-bold text-sky-400">w = 0.85</Text>
            </View>

            {/* Context Indicator (Right side) */}
            <View
              class="flex-row items-center gap-5 p-6 rounded-xl border border-sky-400"
              style={{
                width: 380,
                bgColor: "#04081480",
                borderColor: "#38bdf81a",
                translateX: techIndicatorX(),
                opacity: techIndicatorOpacity(),
              }}
            >
              <Text class="text-4xl font-bold text-sky-400">[TECH]</Text>
              <View class="flex-col">
                <Text class="text-xl font-bold text-slate-50">TECHNOLOGY_CLUSTER</Text>
                <Text class="text-xs font-bold text-slate-400">Vector Shift: → [Microsoft, Hardware]</Text>
              </View>
            </View>
          </View>

          {/* Row 2: Food Context */}
          <View
            class="flex-row justify-between items-center p-10 rounded-xl border border-sky-400"
            style={{
              height: 310,
              bgColor: "#0f172a99",
              borderColor: "#38bdf81a",
            }}
          >
            <View class="absolute" style={{ insetT: 15, insetL: 25 }}>
              <Text class="text-xs font-bold text-slate-400">CASE_02 // BOTANICAL_MAPPING</Text>
            </View>

            {/* Tokens List */}
            <View class="flex-row gap-6 items-center" style={{ translateY: tokenY(), opacity: tokenOpacity() }}>
              <View
                class="px-7 py-4 rounded-xl border-2 border-emerald-400"
                style={{
                  bgColor: foodAppleBg(),
                  translateX: foodAppleX(),
                }}
              >
                <Text class="text-2xl font-bold text-slate-50">Apple</Text>
              </View>

              <View class="px-7 py-4 rounded-xl border-2 border-emerald-400" style={{ bgColor: "#040814b3", borderColor: "#34d39933" }}>
                <Text class="text-2xl font-bold text-slate-50">tastes</Text>
              </View>

              <View class="px-7 py-4 rounded-xl border-2 border-emerald-400" style={{ bgColor: "#040814b3", borderColor: "#34d399" }}>
                <Text class="text-2xl font-bold text-slate-50">delicious</Text>
              </View>
            </View>

            {/* Connection Connector Line: Apple -> delicious */}
            <View
              class="absolute h-[3]"
              style={{
                insetL: 140,
                insetT: 100,
                width: 420,
                bgColor: "#34d399",
                opacity: foodLineOpacity(),
              }}
            />
            <View
              class="absolute px-3 py-1 rounded border border-emerald-400"
              style={{
                insetL: 320,
                insetT: 75,
                bgColor: "#040814",
                borderColor: "#34d399",
                opacity: foodBadgeOpacity(),
              }}
            >
              <Text class="text-xs font-bold text-emerald-400">w = 0.92</Text>
            </View>

            {/* Context Indicator (Right side) */}
            <View
              class="flex-row items-center gap-5 p-6 rounded-xl border border-emerald-400"
              style={{
                width: 380,
                bgColor: "#04081480",
                borderColor: "#34d3991a",
                translateX: foodIndicatorX(),
                opacity: foodIndicatorOpacity(),
              }}
            >
              <Text class="text-4xl font-bold text-emerald-400">[FOOD]</Text>
              <View class="flex-col">
                <Text class="text-xl font-bold text-slate-50">AGRICULTURE_CLUSTER</Text>
                <Text class="text-xs font-bold text-slate-400">Vector Shift: → [Fruit, Organic]</Text>
              </View>
            </View>
          </View>

        </View>

        {/* Stage 3: LSTM vs Transformer Architecture Reveal */}
        <View
          class="absolute flex-row justify-between items-center p-10 rounded-xl border-2 border-sky-400"
          style={{
            width: 1000,
            height: 600,
            bgColor: "#0f172ad9",
            borderColor: "#38bdf84d",
            opacity: transformerBoxOpacity(),
            scale: transformerBoxScale(),
            zIndex: 9,
          }}
        >
          {/* Left Column: LSTM */}
          <View class="flex-col justify-center items-center" style={{ width: 440, height: 500 }}>
            <Text class="text-2xl font-bold text-slate-50 mb-8">LEGACY ARCHITECTURE</Text>

            <View
              class="flex-col justify-center items-center p-6 rounded-xl border-2"
              style={{
                width: 320,
                bgColor: "#040814b3",
                borderColor: lstmBoxBorder(),
                opacity: lstmBoxOpacity(),
              }}
            >
              <Text class="text-xl font-bold" style={{ textColor: lstmBoxColor() }}>LSTM / RNN</Text>

              {/* Red Strike Line */}
              <View
                class="absolute w-[320] h-[6]"
                style={{
                  insetT: 30,
                  insetL: 0,
                  bgColor: "#ef4444",
                  scaleX: lstmCrossScaleX(),
                }}
              />
            </View>
          </View>

          {/* Right Column: Transformer */}
          <View class="flex-col justify-center items-center" style={{ width: 440, height: 500 }}>
            <Text class="text-2xl font-bold text-slate-50 mb-8">MODERN PARADIGM</Text>

            <View
              class="flex-col justify-center items-center p-6 rounded-xl border-2 border-sky-400"
              style={{
                width: 320,
                bgColor: "#040814b3",
                borderColor: "#38bdf8",
                scale: transCardScale(),
              }}
            >
              <View class="absolute px-3 py-1 rounded bg-sky-400" style={{ insetT: -14, insetL: 80 }}>
                <Text class="text-xs font-bold text-slate-950">ATTENTION NATIVE</Text>
              </View>
              <Text class="text-xl font-bold text-sky-400">THE TRANSFORMER</Text>
            </View>
          </View>
        </View>

      </View>

      {/* Tech Footer Details */}
      <View
        class="absolute flex-row justify-between items-center px-16"
        style={{
          insetB: 0,
          insetL: 0,
          width: 1920,
          height: 60,
          bgColor: "#040814",
          zIndex: 10,
        }}
      >
        {/* Top Border Line */}
        <View class="absolute" style={{ insetT: 0, insetL: 0, width: 1920, height: 1, bgColor: "#38bdf80d" }} />

        <Text class="text-sm text-slate-400 font-bold">FRAME_TIME: 02:43:28</Text>
        <Text class="text-sm text-slate-400 font-bold">SYS_METRIC: CONTEXTUAL_WEIGHTING</Text>
      </View>

      {/* Captions Overlay */}
      <View class="absolute flex-row justify-center w-[1920]" style={{ insetB: 90, zIndex: 100 }}>
        <View
          class="px-10 py-4 rounded-xl border border-sky-400"
          style={{
            bgColor: "#0f172ad9",
            borderColor: "#38bdf833",
            width: 1200,
          }}
        >
          <Text class="text-2xl font-bold text-slate-50 text-center">{currentCaption()}</Text>
        </View>
      </View>
    </View>
  );
}
