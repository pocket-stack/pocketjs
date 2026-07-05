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
