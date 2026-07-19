import { createSignal } from "solid-js";
import { Text, View, Image } from "@pocketjs/framework/components";
import { onButtonPress, onFrame } from "@pocketjs/framework/lifecycle";
import { BTN } from "@pocketjs/framework/input";

// ---------------------------------------------------------------------------
// Timings and Animation Configurations
// ---------------------------------------------------------------------------

const TRACK_FRAMES = 2920; // 48.68 seconds @ 60 Hz

const CAPTIONS = [
  { start: 0, end: 300, text: "Despite all the hype, a Large Language Model only does one job." },
  { start: 300, end: 480, text: "Predict the next token. That's it." },
  { start: 480, end: 630, text: "When you type \"All that glitters\"," },
  { start: 630, end: 780, text: "the model predicts that the next sequence is likely \"is not gold.\"" },
  { start: 780, end: 930, text: "When you ask \"The capital of France is\"," },
  { start: 930, end: 1080, text: "it predicts \"Paris.\"" },
  { start: 1080, end: 1410, text: "Everything else... writing code... summarizing PDFs... answering questions..." },
  { start: 1410, end: 1650, text: "starts from this surprisingly simple idea." },
  { start: 1650, end: 1890, text: "A language model isn't storing answers like a database." },
  { start: 1890, end: 2250, text: "Instead, it's learned statistical relationships between billions of text pieces." },
  { start: 2250, end: 2520, text: "The more data it sees... the better it becomes at predicting what comes next." },
  { start: 2520, end: 2670, text: "But this raises another question." },
  { start: 2670, end: 2920, text: "Humans read words. Computers don't. So how does a language model even read text?" }
];

function interpolate(frame: number, start: number, duration: number, from: number, to: number): number {
  if (frame < start) return from;
  if (frame > start + duration) return to;
  const t = (frame - start) / duration;
  const ease = t * t * (3 - 2 * t); // smoothstep
  return from + (to - from) * ease;
}

export default function AiExplainer() {
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

  // Interpolated animation values
  const pos = () => position();
  
  // Slide panels in (frame 60..120) and out (frame 2790..2850)
  const leftPanelX = () => {
    const p = pos();
    if (p > 2700) return interpolate(p, 2790, 60, 0, -60);
    return interpolate(p, 60, 60, -60, 0);
  };
  const leftPanelOpacity = () => {
    const p = pos();
    if (p > 2700) return interpolate(p, 2790, 60, 1, 0);
    return interpolate(p, 60, 60, 0, 1);
  };

  const rightPanelX = () => {
    const p = pos();
    if (p > 2700) return interpolate(p, 2808, 60, 0, 60);
    return interpolate(p, 72, 60, 60, 0);
  };
  const rightPanelOpacity = () => {
    const p = pos();
    if (p > 2700) return interpolate(p, 2808, 60, 1, 0);
    return interpolate(p, 72, 60, 0, 1);
  };

  // Case 1 prompt opacity (fades in 210..240, dims 750..798)
  const case1Opacity = () => {
    const p = pos();
    return interpolate(p, 210, 30, 0, 1) * interpolate(p, 750, 48, 1, 0.4);
  };
  const case1Y = () => interpolate(pos(), 750, 48, 0, -10);
  const case1Scale = () => interpolate(pos(), 750, 48, 1, 0.95);
  const predict1Opacity = () => interpolate(pos(), 480, 36, 0, 1);
  const predict1Scale = () => interpolate(pos(), 480, 36, 0.9, 1);

  // Case 2 prompt opacity
  const case2Opacity = () => interpolate(pos(), 780, 30, 0, 1);
  const predict2Opacity = () => interpolate(pos(), 870, 36, 0, 1);
  const predict2Scale = () => interpolate(pos(), 870, 36, 0.9, 1);

  // Floating apps vs Comparison panel switch
  const floatAppsOpacity = () => {
    const p = pos();
    return interpolate(p, 1080, 48, 0, 1) * interpolate(p, 1650, 36, 1, 0);
  };
  const floatAppsY = () => interpolate(pos(), 1650, 36, 0, -20);
  const floatAppCardOpacity = (delayOffset: number) => interpolate(pos(), 1080 + delayOffset, 36, 0, 1);

  const compPanelOpacity = () => interpolate(pos(), 1692, 48, 0, 1);
  const dbCardOpacity = () => interpolate(pos(), 1710, 48, 0, 1);
  const dbCardY = () => interpolate(pos(), 1710, 48, 15, 0);
  const nnCardOpacity = () => interpolate(pos(), 1730, 48, 0, 1);
  const nnCardY = () => interpolate(pos(), 1730, 48, 15, 0);

  // Connection line pulse opacity
  const linePulseOpacity = () => {
    const p = pos();
    if (p >= 2280 && p <= 2600) {
      return 0.3 + 0.5 * Math.sin((p - 2280) * 0.1);
    }
    return 0.3;
  };

  return (
    <View debugName="AiExplainerRoot" class="w-full h-full bg-[#040814] relative overflow-hidden">
      {/* Glow Orbs */}
      <View
        class="absolute left-[-60] top-[-60] w-[200] h-[200] rounded-full bg-gradient-to-b from-[#38bdf819] to-transparent"
        style={{
          scale: 1.0 + 0.1 * Math.sin(pos() * 0.02),
        }}
      />
      <View
        class="absolute right-[-60] bottom-[-60] w-[200] h-[200] rounded-full bg-gradient-to-b from-[#38bdf819] to-transparent"
        style={{
          scale: 1.0 + 0.1 * Math.cos(pos() * 0.02),
        }}
      />

      {/* Tech Header */}
      <View class="absolute top-0 left-0 w-full h-[24] px-6 flex-row justify-between items-center bg-[#040814cc]">
        <View class="flex-row items-center gap-2">
          <View class="w-2 h-2 rounded-full bg-[#38bdf8] shadow-md" />
          <Text class="text-xs font-bold text-[#cbd5e1] tracking-wide">MODULE // LARGE_LANGUAGE_MODELS</Text>
        </View>
        <Text class="text-xs font-bold text-[#64748b]">PREVIEW_MODE: PROTO_V1</Text>
        {/* Bottom border separator */}
        <View class="absolute bottom-0 left-0 w-full h-[1] bg-[#38bdf826]" />
      </View>

      {/* Content Columns */}
      <View class="w-full h-[180] mt-[34] px-6 flex-row gap-5 items-center justify-between">
        
        {/* Left Panel: Prompt Console */}
        <View
          class="w-[210] h-[166] rounded-xl bg-[#0f172a99] border border-[#38bdf826] p-4 relative justify-center gap-4 flex-col"
          style={{
            translateX: leftPanelX(),
            opacity: leftPanelOpacity(),
          }}
        >
          <Text class="absolute top-2 left-3 text-xs font-bold text-[#64748b] tracking-wide">// PROMPT CONSOLE</Text>
          
          {/* Case 1 */}
          <View
            class="flex-col gap-2"
            style={{
              opacity: case1Opacity(),
              translateY: case1Y(),
              scale: case1Scale(),
            }}
          >
            <View class="flex-row items-center">
              <Text class="text-sm font-bold text-white">All that glitters</Text>
              {pos() >= 210 && pos() < 750 && (
                <View class="w-[6] h-4 bg-[#38bdf8] ml-[6] animate-pulse" />
              )}
            </View>
            <View
              class="bg-[#38bdf819] border border-[#38bdf866] p-2 rounded-md flex-row justify-between items-center"
              style={{
                opacity: predict1Opacity(),
                scale: predict1Scale(),
              }}
            >
              <Text class="text-xs font-bold text-[#38bdf8]">is not gold</Text>
              <Text class="text-xs font-bold text-[#38bdf8] border border-[#38bdf84d] bg-[#38bdf826] px-1 rounded">P = 98.4%</Text>
            </View>
          </View>

          {/* Case 2 */}
          <View
            class="flex-col gap-2"
            style={{
              opacity: case2Opacity(),
            }}
          >
            <View class="flex-row items-center">
              <Text class="text-xs font-bold text-white">The capital of France is</Text>
              {pos() >= 780 && (
                <View class="w-[6] h-[14] bg-[#38bdf8] ml-[6] animate-pulse" />
              )}
            </View>
            <View
              class="bg-[#38bdf819] border border-[#38bdf866] p-2 rounded-md flex-row justify-between items-center"
              style={{
                opacity: predict2Opacity(),
                scale: predict2Scale(),
              }}
            >
              <Text class="text-xs font-bold text-[#38bdf8]">Paris</Text>
              <Text class="text-xs font-bold text-[#38bdf8] border border-[#38bdf84d] bg-[#38bdf826] px-1 rounded">P = 99.8%</Text>
            </View>
          </View>
        </View>

        {/* Right Panel: Technical Visuals */}
        <View
          class="w-[210] h-[166] rounded-xl bg-[#0f172a66] border border-[#38bdf81a] p-4 relative justify-center items-center overflow-hidden"
          style={{
            translateX: rightPanelX(),
            opacity: rightPanelOpacity(),
          }}
        >
          {/* Visual 1: Floating Apps (frame 1080..1650) */}
          <View
            class="absolute top-4 bottom-4 left-2 right-2 flex-col justify-between"
            style={{
              opacity: floatAppsOpacity(),
              translateY: floatAppsY(),
            }}
          >
            <View class="flex-row gap-2 justify-between">
              <View
                class="w-[94] h-[38] bg-[#0f172aCC] border border-[#38bdf833] rounded-lg p-[5] flex-row items-center gap-2"
                style={{ opacity: floatAppCardOpacity(0) }}
              >
                <Image src="icon-code.svg" class="w-[14] h-[14]" />
                <View class="flex-col">
                  <Text class="text-xs font-bold text-white leading-3">Writing Code</Text>
                  <Text class="text-xs text-[#94a3b8] leading-3">Token Streams</Text>
                </View>
              </View>
              <View
                class="w-[94] h-[38] bg-[#0f172aCC] border border-[#38bdf833] rounded-lg p-[5] flex-row items-center gap-2"
                style={{ opacity: floatAppCardOpacity(8) }}
              >
                <Image src="icon-doc.svg" class="w-[14] h-[14]" />
                <View class="flex-col">
                  <Text class="text-xs font-bold text-white leading-3">Summarizing</Text>
                  <Text class="text-xs text-[#94a3b8] leading-3">Attention Maps</Text>
                </View>
              </View>
            </View>
            <View class="flex-row gap-2 justify-between">
              <View
                class="w-[94] h-[38] bg-[#0f172aCC] border border-[#38bdf833] rounded-lg p-[5] flex-row items-center gap-2"
                style={{ opacity: floatAppCardOpacity(16) }}
              >
                <Image src="icon-chat.svg" class="w-[14] h-[14]" />
                <View class="flex-col">
                  <Text class="text-xs font-bold text-white leading-3">Q&A Chat</Text>
                  <Text class="text-xs text-[#94a3b8] leading-3">Probability Net</Text>
                </View>
              </View>
              <View
                class="w-[94] h-[38] bg-[#0f172aCC] border border-[#38bdf833] rounded-lg p-[5] flex-row items-center gap-2"
                style={{ opacity: floatAppCardOpacity(24) }}
              >
                <Image src="icon-bot.svg" class="w-[14] h-[14]" />
                <View class="flex-col">
                  <Text class="text-xs font-bold text-white leading-3">Agents</Text>
                  <Text class="text-xs text-[#94a3b8] leading-3">Thought Loops</Text>
                </View>
              </View>
            </View>
          </View>

          {/* Visual 2: DB vs NN Comparison (frame 1692..2790) */}
          <View
            class="absolute inset-3 flex-col gap-3 justify-center text-xs"
            style={{
              opacity: compPanelOpacity(),
            }}
          >
            {/* DB Card */}
            <View
              class="w-full bg-[#0f172aB3] border border-[#38bdf826] rounded-lg p-2 relative"
              style={{
                opacity: dbCardOpacity(),
                translateY: dbCardY(),
              }}
            >
              <Text class="text-xs font-bold text-[#38bdf8] border border-[#38bdf84d] px-1 rounded-sm absolute top-[-6] left-[8] bg-[#0f172a]">
                DATABASE LOOKUP
              </Text>
              <Text class="text-xs text-[#94a3b8] font-bold mt-[6]">
                SELECT capital FROM countries WHERE name = 'France'
              </Text>
              <Text class="text-xs text-white font-bold mt-[6]">
                ──► Result: <Text class="text-[#38bdf8]">'Paris'</Text> (Exact Match)
              </Text>
            </View>

            {/* NN Card */}
            <View
              class="w-full bg-[#0f172aB3] border border-[#38bdf826] rounded-lg p-2 relative flex-col"
              style={{
                opacity: nnCardOpacity(),
                translateY: nnCardY(),
              }}
            >
              <Text class="text-xs font-bold text-[#38bdf8] border border-[#38bdf84d] px-1 rounded-sm absolute top-[-6] left-[8] bg-[#0f172a]">
                PROBABILITY NETWORK
              </Text>
              
              {/* Mini Neural Network Display */}
              <View class="w-full h-[40] relative mt-[6] items-center justify-between flex-row px-4">
                {/* Connections (horizontal simulated lines via thin absolute Views) */}
                <View class="absolute left-[24] top-[20] w-[40] h-[1] bg-[#38bdf8]" style={{ opacity: linePulseOpacity() }} />
                <View class="absolute left-[24] top-[20] w-[40] h-[1] bg-[#38bdf8]" style={{ opacity: linePulseOpacity(), rotate: 30 }} />
                <View class="absolute left-[70] top-[14] w-[40] h-[1] bg-[#38bdf8]" style={{ opacity: linePulseOpacity() }} />
                <View class="absolute left-[70] top-[26] w-[40] h-[1] bg-[#38bdf8]" style={{ opacity: linePulseOpacity() }} />

                {/* Nodes */}
                <View class="w-[10] h-[10] rounded-full border border-[#38bdf8] bg-[#0f172a] items-center justify-center">
                  <Text class="text-xs text-[#cbd5e1] mt-3">"France"</Text>
                </View>
                <View class="flex-col gap-3 justify-center">
                  <View class="w-[8] h-[8] rounded-full border border-[#38bdf8] bg-[#0f172a]" />
                  <View class="w-[8] h-[8] rounded-full border border-[#38bdf8] bg-[#0f172a]" />
                </View>
                <View class="flex-col gap-3 justify-center items-start">
                  <View class="flex-row items-center gap-1">
                    <View class="w-[10] h-[10] rounded-full border border-white bg-[#38bdf8] shadow-md" />
                    <View class="flex-col">
                      <Text class="text-xs font-bold text-[#38bdf8]">"Paris"</Text>
                      <Text class="text-xs text-[#38bdf8]">P = 0.98</Text>
                    </View>
                  </View>
                  <View class="flex-row items-center gap-1">
                    <View class="w-[8] h-[8] rounded-full border border-[#38bdf8] bg-[#0f172a]" />
                    <View class="flex-col">
                      <Text class="text-xs text-[#94a3b8]">"London"</Text>
                      <Text class="text-xs text-[#64748b]">P = 0.01</Text>
                    </View>
                  </View>
                </View>
              </View>

              <Text class="text-xs text-[#64748b] text-center mt-[6]">
                Learned Statistical Relationships (Trillions of parameters)
              </Text>
            </View>
          </View>
        </View>
      </View>

      {/* Tech Footer */}
      <View class="absolute bottom-0 left-0 w-full h-[18] px-6 flex-row justify-between items-center bg-[#040814cc]">
        {/* Top border separator */}
        <View class="absolute top-0 left-0 w-full h-[1] bg-[#38bdf80d]" />
        <Text class="text-xs text-[#cbd5e1]">{`FRAME_TIME: ${String(Math.floor(pos() / 60)).padStart(2, "0")}:${String(pos() % 60).padStart(2, "0")}:00`}</Text>
        <Text class="text-xs text-[#cbd5e1]">SYS_METRIC: PROBABILITY_SAMPLING</Text>
      </View>

      {/* Captions Overlay */}
      <View class="absolute bottom-[24] left-12 right-12 bg-[#0f172aE6] border border-[#38bdf833] px-6 py-2 rounded-xl items-center min-h-[28] justify-center">
        <Text class="text-xs font-bold text-center text-[#f8fafc]">
          {currentCaption()}
        </Text>
      </View>
    </View>
  );
}
