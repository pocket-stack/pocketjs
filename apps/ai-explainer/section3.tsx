import { createSignal } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { onButtonPress, onFrame } from "@pocketjs/framework/lifecycle";
import { BTN } from "@pocketjs/framework/input";

// ---------------------------------------------------------------------------
// Timings and Animation Configurations (Section 3 - Vector Embeddings)
// ---------------------------------------------------------------------------

const TRACK_FRAMES = 3552; // 59.20 seconds @ 60 Hz

const CAPTIONS = [
  { start: 0, end: 270, text: 'If IDs are just arbitrary numbers, how does a model know that the word "King" is related to "Queen",' },
  { start: 270, end: 480, text: 'but completely different from "Apple"?' },
  { start: 480, end: 810, text: "This is solved by vectorization, turning tokens into high-dimensional vectors, or embeddings." },
  { start: 810, end: 1200, text: "Imagine a 3D coordinate space. In this space, words with similar meanings are grouped close together." },
  { start: 1200, end: 1530, text: 'Tokens like "King", "Queen", "Prince", and "Princess" cluster in one region representing royalty.' },
  { start: 1530, end: 1800, text: 'Meanwhile, "Apple", "Banana", and other fruits cluster in a separate area,' },
  { start: 1800, end: 1980, text: 'and tech terms like "Microsoft" float elsewhere.' },
  { start: 1980, end: 2400, text: "By converting text into coordinates, the model can calculate the semantic distance between words." },
  { start: 2400, end: 2550, text: "But this leads to a puzzle." },
  { start: 2550, end: 2970, text: 'If "Apple" has a single fixed position in this space, how does the model know if we mean the fruit or the tech company?' },
  { start: 2970, end: 3300, text: "To solve this, we need a mechanism that updates a word's meaning based on its context." },
  { start: 3300, end: 3552, text: "And that is where attention comes in." }
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

export default function AiExplainerSection3() {
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

  // Left Panel Animation
  const convPanelX = () => {
    const p = pos();
    if (p < 60) return -80;
    if (p < 120) return interpolate(p, 60, 60, -80, 0);
    return 0;
  };

  const convPanelY = () => {
    const p = pos();
    if (p >= 3420) return interpolate(p, 3420, 60, 0, -100);
    return 0;
  };

  const convPanelOpacity = () => {
    const p = pos();
    if (p < 60) return 0;
    if (p < 120) return interpolate(p, 60, 60, 0, 1);
    if (p >= 3420) return interpolate(p, 3420, 60, 1, 0);
    return 1;
  };

  // Right Panel Animation
  const spacePanelX = () => {
    const p = pos();
    if (p < 72) return 80;
    if (p < 132) return interpolate(p, 72, 60, 80, 0);
    return 0;
  };

  const spacePanelY = () => {
    const p = pos();
    if (p >= 3432) return interpolate(p, 3432, 60, 0, 100);
    return 0;
  };

  const spacePanelOpacity = () => {
    const p = pos();
    if (p < 72) return 0;
    if (p < 132) return interpolate(p, 72, 60, 0, 1);
    if (p >= 3432) return interpolate(p, 3432, 60, 1, 0);
    return 1;
  };

  // Left Panel Word Boxes
  const boxKingOpacity = () => interpolate(pos(), 240, 36, 0, 1);
  const boxQueenOpacity = () => interpolate(pos(), 330, 36, 0, 1);
  const boxAppleOpacity = () => interpolate(pos(), 420, 36, 0, 1);

  // 3D Space Rotator Orbit + Zoom
  const spaceRotateY = () => {
    const p = pos();
    const cycle = (p % 360) / 360;
    return Math.sin(cycle * Math.PI * 2) * 15;
  };

  const spaceRotateX = () => {
    const p = pos();
    const cycle = (p % 360) / 360;
    return Math.cos(cycle * Math.PI * 2) * 10;
  };

  const spaceZoomScale = () => {
    const p = pos();
    if (p < 2400) return 1.0;
    if (p < 2490) return interpolate(p, 2400, 90, 1.0, 1.4);
    return 1.4;
  };

  const spaceZoomX = () => {
    const p = pos();
    if (p < 2400) return 0;
    if (p < 2490) return interpolate(p, 2400, 90, 0, 120);
    return 120;
  };

  const spaceZoomY = () => {
    const p = pos();
    if (p < 2400) return 0;
    if (p < 2490) return interpolate(p, 2400, 90, 0, -120);
    return -120;
  };

  const viewportOpacity = () => interpolate(pos(), 780, 60, 0, 1);

  // Node Staggers
  const royaltyNodeOpacity = () => interpolate(pos(), 810, 48, 0, 1);
  const royaltyNodeScale = () => interpolate(pos(), 810, 48, 0, 1);

  const fruitNodeOpacity = () => interpolate(pos(), 830, 48, 0, 1);
  const fruitNodeScale = () => interpolate(pos(), 830, 48, 0, 1);

  const techNodeOpacity = () => interpolate(pos(), 850, 48, 0, 1);
  const techNodeScale = () => interpolate(pos(), 850, 48, 0, 1);

  // Cluster Highlight Animations
  const royaltyHighlightBg = () => {
    const p = pos();
    if (p >= 1320 && p < 1350) return interpolateColor(p, 1320, 30, "#0f172acc", "#38bdf84d");
    if (p >= 1350 && p < 1410) return interpolateColor(p, 1350, 60, "#38bdf84d", "#0f172acc");
    return "#0f172acc";
  };

  const royaltyHighlightScale = () => {
    const p = pos();
    if (p >= 1320 && p < 1350) return interpolate(p, 1320, 30, 1.0, 1.1);
    if (p >= 1350 && p < 1410) return interpolate(p, 1350, 60, 1.1, 1.0);
    return 1.0;
  };

  const fruitHighlightBg = () => {
    const p = pos();
    if (p >= 1470 && p < 1500) return interpolateColor(p, 1470, 30, "#0f172acc", "#34d3994d");
    if (p >= 1500 && p < 1560) return interpolateColor(p, 1500, 60, "#34d3994d", "#0f172acc");
    return "#0f172acc";
  };

  const fruitHighlightScale = () => {
    const p = pos();
    if (p >= 1470 && p < 1500) return interpolate(p, 1470, 30, 1.0, 1.1);
    if (p >= 1500 && p < 1560) return interpolate(p, 1500, 60, 1.1, 1.0);
    return 1.0;
  };

  const techHighlightBg = () => {
    const p = pos();
    if (p >= 1620 && p < 1650) return interpolateColor(p, 1620, 30, "#0f172acc", "#fb923c4d");
    if (p >= 1650 && p < 1710) return interpolateColor(p, 1650, 60, "#fb923c4d", "#0f172acc");
    return "#0f172acc";
  };

  const techHighlightScale = () => {
    const p = pos();
    if (p >= 1620 && p < 1650) return interpolate(p, 1620, 30, 1.0, 1.1);
    if (p >= 1650 && p < 1710) return interpolate(p, 1650, 60, 1.1, 1.0);
    return 1.0;
  };

  // Distance Connector Lines
  const distanceLinesFade = () => {
    const p = pos();
    if (p >= 2340) return interpolate(p, 2340, 30, 1, 0);
    return 1;
  };

  const matchLineOpacity = () => {
    const p = pos();
    if (p < 1920) return 0;
    if (p < 1956) return interpolate(p, 1920, 36, 0, 0.85) * distanceLinesFade();
    return 0.85 * distanceLinesFade();
  };

  const matchLabelOpacity = () => {
    const p = pos();
    if (p < 1950) return 0;
    if (p < 1974) return interpolate(p, 1950, 24, 0, 1) * distanceLinesFade();
    return 1 * distanceLinesFade();
  };

  const diffLineOpacity = () => {
    const p = pos();
    if (p < 2040) return 0;
    if (p < 2076) return interpolate(p, 2040, 36, 0, 0.85) * distanceLinesFade();
    return 0.85 * distanceLinesFade();
  };

  const diffLabelOpacity = () => {
    const p = pos();
    if (p < 2070) return 0;
    if (p < 2094) return interpolate(p, 2070, 24, 0, 1) * distanceLinesFade();
    return 1 * distanceLinesFade();
  };

  // Apple Node Split
  const singleAppleOpacity = () => {
    const p = pos();
    if (p < 2490) return fruitNodeOpacity();
    if (p < 2520) return interpolate(p, 2490, 30, 1, 0);
    return 0;
  };

  const splitAppleFruitOpacity = () => {
    const p = pos();
    if (p < 2520) return 0;
    if (p < 2568) return interpolate(p, 2520, 48, 0, 1);
    return 1;
  };

  const splitAppleTechOpacity = () => {
    const p = pos();
    if (p < 2550) return 0;
    if (p < 2598) return interpolate(p, 2550, 48, 0, 1);
    return 1;
  };

  const appleContextBorderFruit = () => {
    const p = pos();
    if (p >= 3000) return "#10b981";
    return "#34d399";
  };

  const appleContextBorderTech = () => {
    const p = pos();
    if (p >= 3030) return "#60a5fa";
    return "#fb923c";
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
          <Text class="text-lg font-bold text-sky-400">MODULE // VECTOR_EMBEDDINGS</Text>
        </View>
        <Text class="text-base text-slate-400 font-bold">PREVIEW_MODE: PROTO_V1</Text>
      </View>

      {/* Main Content Area */}
      <View class="absolute flex-row gap-12" style={{ insetT: 140, insetL: 100, width: 1720, height: 680, zIndex: 5 }}>
        
        {/* Left Column: Vector Embedding Generator */}
        <View
          class="flex-col justify-center gap-6 p-10 rounded-xl border-2 border-sky-400"
          style={{
            width: 720,
            height: 680,
            bgColor: "#0f172a99",
            borderColor: "#38bdf833",
            insetL: convPanelX(),
            insetT: convPanelY(),
            opacity: convPanelOpacity(),
          }}
        >
          <Text class="text-sm font-bold text-slate-400 mb-2">// VECTOR_EMBEDDING_GENERATOR</Text>

          {/* Word Box: King */}
          <View
            class="flex-row justify-between items-center p-6 rounded-xl border border-sky-400"
            style={{ bgColor: "#04081466", borderColor: "#38bdf833", opacity: boxKingOpacity() }}
          >
            <Text class="text-2xl font-bold text-slate-50">"King"</Text>
            <Text class="text-xl font-bold text-sky-400">──►</Text>
            <Text class="text-lg font-bold text-sky-400">[0.28, -0.45, 0.81, ...]</Text>
          </View>

          {/* Word Box: Queen */}
          <View
            class="flex-row justify-between items-center p-6 rounded-xl border border-sky-400"
            style={{ bgColor: "#04081466", borderColor: "#38bdf833", opacity: boxQueenOpacity() }}
          >
            <Text class="text-2xl font-bold text-slate-50">"Queen"</Text>
            <Text class="text-xl font-bold text-sky-400">──►</Text>
            <Text class="text-lg font-bold text-sky-400">[0.26, -0.42, 0.79, ...]</Text>
          </View>

          {/* Word Box: Apple */}
          <View
            class="flex-row justify-between items-center p-6 rounded-xl border border-sky-400"
            style={{ bgColor: "#04081466", borderColor: "#38bdf833", opacity: boxAppleOpacity() }}
          >
            <Text class="text-2xl font-bold text-slate-50">"Apple"</Text>
            <Text class="text-xl font-bold text-sky-400">──►</Text>
            <Text class="text-lg font-bold text-sky-400">[0.05, 0.89, -0.32, ...]</Text>
          </View>
        </View>

        {/* Right Column: 3D Scatter Space */}
        <View
          class="flex-col justify-center items-center rounded-xl border border-sky-400 overflow-hidden"
          style={{
            width: 950,
            height: 680,
            bgColor: "#0f172a66",
            borderColor: "#38bdf81a",
            insetL: spacePanelX(),
            insetT: spacePanelY(),
            opacity: spacePanelOpacity(),
          }}
        >
          <View class="absolute" style={{ insetT: 20, insetL: 30, zIndex: 6 }}>
            <Text class="text-sm font-bold text-slate-400">// 3D_VECTOR_SPACE</Text>
          </View>

          {/* 3D Viewport Box */}
          <View
            class="relative w-[850] h-[580]"
            style={{
              opacity: viewportOpacity(),
              scale: spaceZoomScale(),
              insetL: spaceZoomX(),
              insetT: spaceZoomY(),
              rotateY: spaceRotateY(),
              rotateX: spaceRotateX(),
            }}
          >
            {/* Grid Axes */}
            <View class="absolute w-[850] h-[2]" style={{ insetT: 290, insetL: 0, bgColor: "#38bdf826" }} />
            <View class="absolute w-[2] h-[580]" style={{ insetT: 0, insetL: 425, bgColor: "#38bdf826" }} />

            {/* Nodes: Royalty (Blue) */}
            <View
              class="absolute px-4 py-2 rounded-lg border-2 border-sky-400"
              style={{
                insetL: 380,
                insetT: 150,
                translateZ: 100,
                bgColor: royaltyHighlightBg(),
                scale: royaltyNodeScale() * royaltyHighlightScale(),
                opacity: royaltyNodeOpacity(),
              }}
            >
              <Text class="text-lg font-bold text-sky-400">King</Text>
            </View>

            <View
              class="absolute px-4 py-2 rounded-lg border-2 border-sky-400"
              style={{
                insetL: 460,
                insetT: 125,
                translateZ: 90,
                bgColor: royaltyHighlightBg(),
                scale: royaltyNodeScale() * royaltyHighlightScale(),
                opacity: royaltyNodeOpacity(),
              }}
            >
              <Text class="text-lg font-bold text-sky-400">Queen</Text>
            </View>

            <View
              class="absolute px-4 py-2 rounded-lg border-2 border-sky-400"
              style={{
                insetL: 400,
                insetT: 200,
                translateZ: 80,
                bgColor: royaltyHighlightBg(),
                scale: royaltyNodeScale() * royaltyHighlightScale(),
                opacity: royaltyNodeOpacity(),
              }}
            >
              <Text class="text-lg font-bold text-sky-400">Prince</Text>
            </View>

            <View
              class="absolute px-4 py-2 rounded-lg border-2 border-sky-400"
              style={{
                insetL: 480,
                insetT: 175,
                translateZ: 70,
                bgColor: royaltyHighlightBg(),
                scale: royaltyNodeScale() * royaltyHighlightScale(),
                opacity: royaltyNodeOpacity(),
              }}
            >
              <Text class="text-lg font-bold text-sky-400">Princess</Text>
            </View>

            {/* Nodes: Fruit (Green) */}
            <View
              class="absolute px-4 py-2 rounded-lg border-2 border-emerald-400"
              style={{
                insetL: 160,
                insetT: 380,
                translateZ: -100,
                bgColor: fruitHighlightBg(),
                scale: fruitNodeScale() * fruitHighlightScale(),
                opacity: fruitNodeOpacity(),
              }}
            >
              <Text class="text-lg font-bold text-emerald-400">Banana</Text>
            </View>

            {/* Single Apple Node */}
            <View
              class="absolute px-4 py-2 rounded-lg border-2 border-emerald-400"
              style={{
                insetL: 200,
                insetT: 420,
                translateZ: -80,
                bgColor: fruitHighlightBg(),
                scale: fruitNodeScale() * fruitHighlightScale(),
                opacity: singleAppleOpacity(),
              }}
            >
              <Text class="text-lg font-bold text-emerald-400">Apple</Text>
            </View>

            {/* Nodes: Tech (Orange) */}
            <View
              class="absolute px-4 py-2 rounded-lg border-2 border-orange-400"
              style={{
                insetL: 620,
                insetT: 390,
                translateZ: -50,
                bgColor: techHighlightBg(),
                scale: techNodeScale() * techHighlightScale(),
                opacity: techNodeOpacity(),
              }}
            >
              <Text class="text-lg font-bold text-orange-400">Microsoft</Text>
            </View>

            {/* Split Nodes for Context Zoom (Apple Fruit & Tech) */}
            <View
              class="absolute px-4 py-2 rounded-lg border-2"
              style={{
                insetL: 140,
                insetT: 440,
                translateZ: -100,
                bgColor: "#0f172ae6",
                borderColor: appleContextBorderFruit(),
                opacity: splitAppleFruitOpacity(),
              }}
            >
              <Text class="text-base font-bold text-emerald-400">Apple (Fruit)</Text>
            </View>

            <View
              class="absolute px-4 py-2 rounded-lg border-2"
              style={{
                insetL: 270,
                insetT: 370,
                translateZ: -60,
                bgColor: "#0f172ae6",
                borderColor: appleContextBorderTech(),
                opacity: splitAppleTechOpacity(),
              }}
            >
              <Text class="text-base font-bold text-sky-400">Apple (Tech)</Text>
            </View>

            {/* Distance Connector Lines */}
            {/* Line: King -> Queen */}
            <View
              class="absolute h-[2]"
              style={{
                insetL: 420,
                insetT: 155,
                width: 75,
                rotate: -20,
                bgColor: "#38bdf8",
                opacity: matchLineOpacity(),
              }}
            />
            <View
              class="absolute px-3 py-1 rounded border border-sky-400"
              style={{
                insetL: 425,
                insetT: 110,
                bgColor: "#0f172ae6",
                opacity: matchLabelOpacity(),
              }}
            >
              <Text class="text-xs font-bold text-sky-400">Sim = 0.88</Text>
            </View>

            {/* Line: King -> Apple */}
            <View
              class="absolute h-[2]"
              style={{
                insetL: 240,
                insetT: 280,
                width: 250,
                rotate: 50,
                bgColor: "#ef4444",
                opacity: diffLineOpacity(),
              }}
            />
            <View
              class="absolute px-3 py-1 rounded border border-red-500"
              style={{
                insetL: 310,
                insetT: 280,
                bgColor: "#0f172ae6",
                opacity: diffLabelOpacity(),
              }}
            >
              <Text class="text-xs font-bold text-red-500">Sim = 0.05</Text>
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

        <Text class="text-sm text-slate-400 font-bold">FRAME_TIME: 02:24:12</Text>
        <Text class="text-sm text-slate-400 font-bold">SYS_METRIC: VECTOR_MAPPING</Text>
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
