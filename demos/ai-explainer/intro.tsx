import { createSignal } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { onButtonPress, onFrame } from "@pocketjs/framework/lifecycle";
import { BTN } from "@pocketjs/framework/input";

// ---------------------------------------------------------------------------
// Timings and Animation Configurations (Intro Scene)
// ---------------------------------------------------------------------------

const TRACK_FRAMES = 2798; // 46.64 seconds @ 60 Hz

const CAPTIONS = [
  { start: 0, end: 240, text: "If you've ever opened Twitter, LinkedIn or YouTube recently, you've probably seen words like..." },
  { start: 240, end: 348, text: "Transformer..." },
  { start: 348, end: 450, text: "RAG..." },
  { start: 450, end: 552, text: "Agents..." },
  { start: 552, end: 660, text: "Embeddings..." },
  { start: 660, end: 768, text: "MCP..." },
  { start: 768, end: 888, text: "Reasoning models..." },
  { start: 888, end: 1080, text: "Context Engineering." },
  { start: 1080, end: 1320, text: "Everyone throws these words around as if everyone already understands them." },
  { start: 1320, end: 1590, text: "But most developers only know how to call an API. Very few actually understand what's happening underneath." },
  { start: 1590, end: 2010, text: "By the end of this video you'll understand how modern AI systems actually work, why they were built this way, and how every concept connects together." },
  { start: 2010, end: 2130, text: "This isn't just theory." },
  { start: 2130, end: 2430, text: "We're going to build the entire mental model of AI engineering from first principles." },
  { start: 2430, end: 2610, text: "Let's start with the most important question." },
  { start: 2610, end: 2798, text: "What exactly is a Large Language Model?" }
];

const highlightTimings = [
  { start: 240, end: 330 }, // Card 0: Transformer (4.0s to 5.5s)
  { start: 348, end: 420 }, // Card 1: RAG (5.8s to 7.0s)
  { start: 450, end: 528 }, // Card 2: Agents (7.5s to 8.8s)
  { start: 552, end: 630 }, // Card 3: Embeddings (9.2s to 10.5s)
  { start: 660, end: 732 }, // Card 4: MCP (11.0s to 12.2s)
  { start: 768, end: 852 }, // Card 5: Reasoning (12.8s to 14.2s)
  { start: 888, end: 990 }  // Card 6: Context (14.8s to 16.5s)
];

const CARDS = [
  { id: "transformer", icon: "<T>", title: "Transformer", sub: "Attention Engine" },
  { id: "rag", icon: "DB", title: "RAG", sub: "Knowledge Base" },
  { id: "agents", icon: "O──►", title: "Agents", sub: "Autonomy Loop" },
  { id: "embeddings", icon: "XYZ", title: "Embeddings", sub: "Vector Space" },
  { id: "mcp", icon: "🔌", title: "MCP", sub: "Tool Protocol" },
  { id: "reasoning", icon: "???", title: "Reasoning", sub: "Compute Search" },
  { id: "context", icon: "MEM", title: "Context Engineering", sub: "Active Memory Pipeline" }
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

export default function AiExplainerIntro() {
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

  const getHighlightFactor = (i: number, p: number) => {
    const timing = highlightTimings[i];
    if (p < timing.start) return 0;
    if (p < timing.start + 30) return interpolate(p, timing.start, 30, 0, 1);
    if (p < timing.end) return 1;
    if (p < timing.end + 30) return interpolate(p, timing.end, 30, 1, 0);
    return 0;
  };

  const getErrorFactor = (i: number, p: number) => {
    const start = 1110 + i * 6; // starts at 18.5s (1110 frames) staggered by 6 frames
    return interpolate(p, start, 60, 0, 1);
  };

  const getResolvedFactor = (i: number, p: number) => {
    const start = 1530 + i * 5; // starts at 25.5s (1530 frames) staggered by 5 frames
    return interpolate(p, start, 60, 0, 1);
  };

  const cardEntranceOpacity = (i: number) => {
    return interpolate(pos(), 90 + i * 9, 48, 0, 1);
  };

  const cardEntranceScale = (i: number) => {
    return interpolate(pos(), 90 + i * 9, 48, 0.8, 1);
  };

  const cardEntranceY = (i: number) => {
    return interpolate(pos(), 90 + i * 9, 48, 50, 0);
  };

  const getCardBorderColor = (i: number) => {
    const p = pos();
    const h = getHighlightFactor(i, p);
    const e = getErrorFactor(i, p);
    const r = getResolvedFactor(i, p);

    if (r > 0) {
      // Blend from error (#ef4444 = 239, 68, 68) to resolved (#10b981 = 16, 185, 129)
      const red = Math.round(239 * (1 - r) + 16 * r);
      const green = Math.round(68 * (1 - r) + 185 * r);
      const blue = Math.round(68 * (1 - r) + 129 * r);
      const alpha = 0.15 + 0.85 * (e > r ? e : r);
      return toHexColor(red, green, blue, alpha);
    }
    if (e > 0) {
      // Blend from normal/highlight to error
      const r_norm = 56;
      const g_norm = 189;
      const b_norm = 248;
      const a_norm = 0.15 + 0.85 * h;

      const red = Math.round(r_norm * (1 - e) + 239 * e);
      const green = Math.round(g_norm * (1 - e) + 68 * e);
      const blue = Math.round(b_norm * (1 - e) + 68 * e);
      const alpha = a_norm * (1 - e) + 1.0 * e;
      return toHexColor(red, green, blue, alpha);
    }
    if (h > 0) {
      return toHexColor(56, 189, 248, 0.15 + 0.85 * h);
    }
    return "#38bdf826";
  };

  const getCardBgColor = (i: number) => {
    const p = pos();
    const h = getHighlightFactor(i, p);
    return toHexColor(15, 23, 42, 0.6 + 0.25 * h);
  };

  const getCardScale = (i: number) => {
    const entranceScale = cardEntranceScale(i);
    const h = getHighlightFactor(i, pos());
    return entranceScale * (1.0 + 0.05 * h);
  };

  const getCardTranslateY = (i: number) => {
    return cardEntranceY(i);
  };

  const getCardOpacity = (i: number) => {
    return cardEntranceOpacity(i);
  };

  const getTopLineColor = (i: number) => {
    const p = pos();
    const r = getResolvedFactor(i, p);
    const e = getErrorFactor(i, p);

    if (r > 0) {
      return toHexColor(16, 185, 129, 0.3 + 0.7 * r);
    }
    if (e > 0) {
      return toHexColor(239, 68, 68, 0.3 + 0.7 * e);
    }
    return "#38bdf84d";
  };

  const getCardAccentColor = (i: number) => {
    const p = pos();
    const r = getResolvedFactor(i, p);
    const e = getErrorFactor(i, p);

    if (r > 0) {
      return toHexColor(16, 185, 129, 0.8 + 0.2 * r);
    }
    if (e > 0) {
      return toHexColor(239, 68, 68, 0.8 + 0.2 * e);
    }
    return "#38bdf8";
  };

  // Connection lines visibility / pulse
  const connectionsOpacity = () => {
    const p = pos();
    if (p < 1500) return 0;
    if (p < 1560) return interpolate(p, 1500, 60, 0, 0.4);
    if (p < 1872) return 0.4;
    return interpolate(p, 1872, 30, 0.4, 0);
  };

  // Grid container exit transition
  const gridOpacity = () => {
    return interpolate(pos(), 1860, 48, 1, 0);
  };

  const gridY = () => {
    return interpolate(pos(), 1860, 48, 0, -100);
  };

  // Title Block entrance and exit transitions
  const titleOpacity = () => {
    const p = pos();
    if (p < 1950) return 0;
    if (p < 2022) return interpolate(p, 1950, 72, 0, 1);
    if (p < 2610) return 1;
    return interpolate(p, 2610, 90, 1, 0);
  };

  const titleY = () => {
    const p = pos();
    if (p < 1950) return 30;
    if (p < 2022) return interpolate(p, 1950, 72, 30, 0);
    return 0;
  };

  const titleScale = () => {
    const p = pos();
    if (p < 1950) return 0.9;

    let scale = 1.0;
    if (p < 2022) {
      scale = interpolate(p, 1950, 72, 0.9, 1.0);
    }

    if (p >= 1968 && p <= 2004) {
      scale += 0.03 * Math.sin((p - 1968) * (Math.PI / 36));
    }

    if (p >= 2610) {
      scale = interpolate(p, 2610, 90, scale, 1.15);
    }

    return scale;
  };

  const titleTextShadow = () => {
    const p = pos();
    if (p >= 1968 && p <= 2004) {
      const factor = Math.sin((p - 1968) * (Math.PI / 36));
      return `0 0 ${Math.round(40 + 20 * factor)}px rgba(56, 189, 248, ${0.2 + 0.4 * factor})`;
    }
    return "0 0 40px rgba(56, 189, 248, 0.2)";
  };

  const renderCard = (card: typeof CARDS[0], index: number) => {
    const cardWidth = card.title === "Context Engineering" ? 670 : 320;

    return (
      <View
        class="relative justify-center items-center flex-col overflow-hidden border-2 shadow-md"
        style={{
          width: cardWidth,
          height: 220,
          opacity: getCardOpacity(index),
          scale: getCardScale(index),
          translateY: getCardTranslateY(index),
          bgColor: getCardBgColor(index),
          borderColor: getCardBorderColor(index),
          borderWidth: 2,
          radius: 16,
          paddingT: 24, paddingR: 24, paddingB: 24, paddingL: 24,
          zIndex: 4,
        }}
      >
        {/* Top border line indicator */}
        <View
          class="absolute top-0 left-0 w-full"
          style={{
            height: 4,
            bgColor: getTopLineColor(index),
          }}
        />

        {/* Icon */}
        <Text
          class="font-bold text-white text-2xl"
          style={{
            textColor: getCardAccentColor(index),
            scale: 1.5,
            marginB: 16,
          }}
        >
          {card.icon}
        </Text>

        {/* Title */}
        <Text class="text-2xl font-bold text-white">
          {card.title}
        </Text>

        {/* Subtitle */}
        <Text
          class="text-lg text-[#94a3b8]"
          style={{
            marginT: 8,
          }}
        >
          {card.sub}
        </Text>
      </View>
    );
  };

  return (
    <View debugName="AiExplainerRoot" class="w-full h-full bg-[#040814] relative overflow-hidden">
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

      {/* Ambient Glow Orbs */}
      <View
        class="absolute left-[-200] top-[-200] w-[600] h-[600] rounded-full bg-gradient-to-b from-[#38bdf819] to-transparent"
        style={{
          scale: 1.0 + 0.1 * Math.sin(pos() * 0.017),
          zIndex: 2,
        }}
      />
      <View
        class="absolute right-[-200] bottom-[-200] w-[600] h-[600] rounded-full bg-gradient-to-b from-[#38bdf819] to-transparent"
        style={{
          scale: 1.0 + 0.1 * Math.cos(pos() * 0.017),
          zIndex: 2,
        }}
      />
      <View
        class="absolute left-[560] top-[140] w-[800] h-[800] rounded-full bg-gradient-to-b from-[#38bdf819] to-transparent"
        style={{
          scale: 1.0 + 0.15 * Math.sin(pos() * 0.026),
          opacity: 0.6 + 0.2 * Math.sin(pos() * 0.026),
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
          <Text class="text-2xl font-bold text-[#cbd5e1]">MODULE // AI_ENGINEERING_EXPLAINER</Text>
        </View>
        <Text class="text-xl font-bold text-[#64748b]">PREVIEW_MODE: PROTO_V1</Text>
        {/* Bottom border separator */}
        <View class="absolute bottom-0 left-0 w-full h-[2] bg-[#38bdf826]" />
      </View>

      {/* Content Area */}
      <View
        class="absolute inset-0 justify-center items-center"
        style={{
          paddingT: 120,
          paddingB: 80,
          paddingL: 80,
          paddingR: 80,
          zIndex: 5,
        }}
      >

        {/* Keywords Grid Container */}
        <View
          class="absolute flex-col"
          style={{
            insetL: 275,
            insetT: 280,
            width: 1370,
            height: 470,
            gap: 30,
            opacity: gridOpacity(),
            translateY: gridY(),
          }}
        >
          {/* Connection Lines (rendered behind cards) */}
          <View class="absolute inset-0" style={{ zIndex: 3 }}>
            {/* Row 1 Horizontal lines */}
            <View class="absolute bg-[#38bdf8]" style={{ insetL: 320, insetT: 110, width: 30, height: 2, opacity: connectionsOpacity() }} />
            <View class="absolute bg-[#38bdf8]" style={{ insetL: 670, insetT: 110, width: 30, height: 2, opacity: connectionsOpacity() }} />
            <View class="absolute bg-[#38bdf8]" style={{ insetL: 1020, insetT: 110, width: 30, height: 2, opacity: connectionsOpacity() }} />

            {/* Row 2 Horizontal lines */}
            <View class="absolute bg-[#38bdf8]" style={{ insetL: 320, insetT: 360, width: 30, height: 2, opacity: connectionsOpacity() }} />
            <View class="absolute bg-[#38bdf8]" style={{ insetL: 670, insetT: 360, width: 30, height: 2, opacity: connectionsOpacity() }} />

            {/* Vertical lines */}
            <View class="absolute bg-[#38bdf8]" style={{ insetL: 160, insetT: 220, width: 2, height: 30, opacity: connectionsOpacity() }} />
            <View class="absolute bg-[#38bdf8]" style={{ insetL: 510, insetT: 220, width: 2, height: 30, opacity: connectionsOpacity() }} />
            <View class="absolute bg-[#38bdf8]" style={{ insetL: 860, insetT: 220, width: 2, height: 30, opacity: connectionsOpacity() }} />
            <View class="absolute bg-[#38bdf8]" style={{ insetL: 1210, insetT: 220, width: 2, height: 30, opacity: connectionsOpacity() }} />
          </View>

          {/* Row 1 Cards */}
          <View class="flex-row w-full" style={{ gap: 30, zIndex: 4 }}>
            {renderCard(CARDS[0], 0)}
            {renderCard(CARDS[1], 1)}
            {renderCard(CARDS[2], 2)}
            {renderCard(CARDS[3], 3)}
          </View>

          {/* Row 2 Cards */}
          <View class="flex-row w-full" style={{ gap: 30, zIndex: 4 }}>
            {renderCard(CARDS[4], 4)}
            {renderCard(CARDS[5], 5)}
            {renderCard(CARDS[6], 6)}
          </View>
        </View>

        {/* Central Title Block */}
        <View
          class="absolute items-center justify-center flex-col"
          style={{
            insetL: 360,
            insetT: 340,
            width: 1200,
            height: 400,
            opacity: titleOpacity(),
            translateY: titleY(),
            scale: titleScale(),
          }}
        >
          <Text
            class="text-2xl font-bold text-center text-white"
            style={{
              scale: 4.0,
              translateY: -30,
            }}
          >
            AI Engineering
          </Text>
          <Text
            class="text-2xl font-bold text-center text-[#38bdf8]"
            style={{
              scale: 4.0,
              translateY: 45,
            }}
          >
            Explained
          </Text>
          <Text
            class="text-xl text-[#94a3b8] text-center"
            style={{
              translateY: 120,
            }}
          >
            Everything You Need to Build Modern AI Applications
          </Text>
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
        <Text class="text-lg text-[#cbd5e1]">SYS_METRIC: DETERMINISTIC_TIMELINE</Text>
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
