// site/nav.ts — the docs information architecture. build.ts renders one page
// per slug from site/content/docs/<slug>.md and builds the sidebar from this.
export interface DocItem {
  slug: string;
  title: string;
}
export interface DocSection {
  title: string;
  items: DocItem[];
}

export const DOC_NAV: DocSection[] = [
  {
    title: "Introduction",
    items: [
      { slug: "overview", title: "Overview" },
      { slug: "getting-started", title: "Getting started" },
      { slug: "frameworks", title: "Frameworks" },
      { slug: "architecture", title: "Architecture" },
      { slug: "platform-contracts", title: "Platform contracts" },
    ],
  },
  {
    title: "Guides",
    items: [
      { slug: "components", title: "Components" },
      { slug: "styling", title: "Styling" },
      { slug: "reactivity", title: "Reactivity" },
      { slug: "animation", title: "Animation" },
      { slug: "input-focus", title: "Input & focus" },
      { slug: "app-shell", title: "App shell & overlays" },
      { slug: "devtools", title: "DevTools" },
    ],
  },
  {
    title: "Reference",
    items: [
      { slug: "api", title: "API reference" },
      { slug: "tailwind", title: "Tailwind utilities" },
      { slug: "build-pipeline", title: "Build pipeline" },
      { slug: "native-contract", title: "Native contract" },
    ],
  },
];

// The blog registry. build.ts renders one page per post from
// site/content/blog/<slug>.md plus the /blog/ index (newest first).
export interface BlogPost {
  slug: string;
  title: string;
  date: string; // ISO yyyy-mm-dd
  description: string;
  author: { name: string; url: string };
}

export const BLOG_POSTS: BlogPost[] = [
  {
    slug: "pocket-character",
    title: "Pocket Character: a Desktop Digital Human in One Native Process",
    date: "2026-07-19",
    description:
      "airi's 3D digital human — same VRM model, same idle loop, same blink math, same spring-bone physics, same transparent always-on-top window — rebuilt as a single native process on the Pocket runtime: 118 MB and 4 % of one core instead of an Electron tree's 2.2 GB and 44 %. Inside: morph targets that cost nothing between blinks, a VRM crate that learned the difference between +Z and −Z the hard way, a QuickJS bundle as the hot-swappable personality, and a measurement section with receipts — same machine, same ruler, screenshots included.",
    author: { name: 'Yifeng "Evan" Wang', url: "https://github.com/doodlewind" },
  },
  {
    slug: "pocket-youtube",
    title: "Pocket YouTube: Streaming YouTube to a PSP over a USB Cable",
    date: "2026-07-17",
    description:
      "The PSP's radio can't reach the modern web, so the network moved to the other end of the cable: a Mac companion runs yt-dlp and ffmpeg, and the handheld plays a ring buffer that happens to be a file — search, CJK titles, seek, pause, 44.1 kHz audio and all. Inside: a stream container you can ls, 256 colors impersonating 720p at 12 fps, and the three bugs only real silicon would show — a GPU race photographed by its own raster line, a leaked audio channel, and a build that shipped last week's code with a green checkmark.",
    author: { name: 'Yifeng "Evan" Wang', url: "https://github.com/doodlewind" },
  },
  {
    slug: "pocketjs-on-ps-vita",
    title: "Twice the Pixels, Zero Forks: PocketJS on PS Vita",
    date: "2026-07-13",
    description:
      "PocketJS 0.4.0's headline: the same apps, unchanged, as native PS Vita bubbles. The Vita port is now verified on real hardware: the 480×272 logical world renders at a true 960×544 through a target-owned raster density, while a pocket.json contract system makes ad hoc platform hacks fail the build. Plus front touch as deterministic input, 44 byte-exact Vita goldens, and release VPKs installed and run on a physical Vita.",
    author: { name: 'Yifeng "Evan" Wang', url: "https://github.com/doodlewind" },
  },
  {
    slug: "pocket-figma",
    title: "Pocket Figma: Figma at 333 MHz",
    date: "2026-07-10",
    description:
      "The limit of 2D UI is Figma — so we made a 2004 Sony PSP open a real design file. What actually lives inside a .fig, mapped byte by byte (it tells you how to read itself), baking 14,430 nodes into streamed CLUT8 tile pyramids where whitespace is free, the anatomy of a zoom, and nub-panning a 26,000-pixel artboard at 60 FPS in 32 MB — deterministic to the byte, at any clock rate.",
    author: { name: 'Yifeng "Evan" Wang', url: "https://github.com/doodlewind" },
  },
  {
    slug: "ui-runtime-that-cant-flake",
    title: "The UI Runtime That Can't Flake",
    date: "2026-07-09",
    description:
      "Why UI tests flake — a runtime-architecture answer, not a tooling one. Make every frame a pure state transition, quantize the network onto frame boundaries, and time becomes data: 60 runs of the same journey, one histogram bar. Then turn the clock rate into a dial and a whole user session becomes 13 replayable frames — the world an agent actually wants to live in.",
    author: { name: 'Yifeng "Evan" Wang', url: "https://github.com/doodlewind" },
  },
  {
    slug: "shipping-openstrike",
    title: "Shipping OpenStrike: a Counter-Strike-Shaped FPS on a 2004 Handheld",
    date: "2026-07-09",
    description:
      "OpenStrike is out — classic BSP maps, bots, tracers, and a Solid JSX HUD holding a locked 60 FPS on a real Sony PSP: 333 MHz, 32 MB, no shaders. A field guide for JavaScript developers to how it works: rules and HUD in TypeScript on QuickJS, a bundler for 1999's geometry, and a 16.7 ms budget with receipts.",
    author: { name: 'Yifeng "Evan" Wang', url: "https://github.com/doodlewind" },
  },
  {
    slug: "time-travel-devtools",
    title: "Time Travel over a USB Cable: PocketJS DevTools",
    date: "2026-07-08",
    description:
      "A component inspector that highlights on the PSP's physical screen, pause/step for the whole world, a REPL into the handheld — and time-travel debugging where a session is two bytes per frame, carried over PSPLINK, the homebrew scene's answer to the GDB remote stub.",
    author: { name: 'Yifeng "Evan" Wang', url: "https://github.com/doodlewind" },
  },
  {
    slug: "baking-motion",
    title: "Baking Motion into PocketJS: Keyframes, Arcs, and a 3D Pipeline",
    date: "2026-07-07",
    description:
      "The style table learns motion: compile-time keyframe timelines, an animatable stroke-arc primitive, and a painter-sorted 3D pipeline — plus the four hardware performance lessons a one-to-one port of yui540's motion studies forced out of the engine.",
    author: { name: 'Yifeng "Evan" Wang', url: "https://github.com/doodlewind" },
  },
  {
    slug: "introducing-pocketjs",
    title: "Introducing PocketJS",
    date: "2026-07-06",
    description:
      "Real Solid and Vue Vapor components, a compile-time Tailwind design system, and 60 FPS native animation on a 2004 handheld — inside 8 MB. What PocketJS is, and what's actually new in it.",
    author: { name: 'Yifeng "Evan" Wang', url: "https://github.com/doodlewind" },
  },
];

