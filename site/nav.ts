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
    slug: "baking-motion",
    title: "Baking Motion: Keyframes, 3D and a Locked 60 FPS on a 2004 Handheld",
    date: "2026-07-07",
    description:
      "PocketJS grew a compile-time keyframe engine, a stroke-arc primitive and a real 3D transform pipeline — and a fidelity port of yui540's motion studies forced four hardware lessons: baked disc corners, incremental layout, cache-key discipline, and a pipelined frame loop.",
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

export const AOT_DOC_NAV: DocSection[] = [
  {
    title: "Product line",
    items: [
      { slug: "overview", title: "Overview" },
      { slug: "getting-started", title: "Getting started" },
      { slug: "authoring", title: "Authoring model" },
      { slug: "compiler", title: "Compiler pipeline" },
    ],
  },
  {
    title: "Runtime",
    items: [
      { slug: "cartridge", title: "Cartridge format" },
      { slug: "runtime", title: "GBA runtime" },
      { slug: "web-demo", title: "Web demo" },
    ],
  },
];
