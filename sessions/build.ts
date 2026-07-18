// sessions/build.ts — static-site generator for sessions.pocketjs.dev.
//
//   bun sessions/build.ts        # -> sessions/dist/
//
// The wiki has two kinds of pages:
//   1. chapters — sessions/content/<slug>.md, with wiki extensions:
//        :::quote <meta line>   author-quote card (verbatim prompt, escaped)
//        :::agent <meta line>   agent-excerpt card
//        [[S35]] / [[PR61]]     links to session archive / GitHub PRs
//   2. generated — /, /timeline/, /sessions/, /sessions/<nnn>/, /numbers/,
//      built from sessions/data/*.json (distilled from the author's own
//      Claude Code session archive; see /colophon/).

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, cpSync } from "node:fs";
import { dirname } from "node:path";
import { marked } from "marked";
import { createHighlighter } from "shiki";
import { renderPage } from "./templates.ts";
import { WIKI_NAV } from "./nav.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const SITE = ROOT + "sessions/";
const OUT = SITE + "dist/";
const GH = "https://github.com/pocket-stack/pocketjs";

// ---------------------------------------------------------------- data
type Msg = { ts: string; text: string };
type Session = {
  dir: string;
  file: string;
  sessionId: string;
  cwd: string;
  branches: string[];
  firstTs: string;
  lastTs: string;
  summaries: string[];
  humanMessages: Msg[];
  plans: { ts: string; plan: string }[];
  toolCounts: Record<string, number>;
  assistantCount: number;
  slashCommands: string[];
  sizeMB: number;
};
type Pr = { number: number; title: string; mergedAt: string; headRefName: string };
type DayCommits = { date: string; count: number };
type Tag = { tag: string; date: string; pr: number; title: string };

const sessions: Session[] = JSON.parse(readFileSync(SITE + "data/sessions.json", "utf8"));
const prs: Pr[] = (JSON.parse(readFileSync(SITE + "data/prs.json", "utf8")) as Pr[]).sort(
  (a, b) => (a.mergedAt < b.mergedAt ? -1 : 1),
);
const commits: DayCommits[] = JSON.parse(readFileSync(SITE + "data/commits.json", "utf8"));
const tags: Tag[] = JSON.parse(readFileSync(SITE + "data/tags.json", "utf8"));

const sid = (i: number) => `S${i}`;
const spad = (i: number) => String(i).padStart(3, "0");
const wtOf = (s: Session): string => {
  const d = s.dir;
  let m = d.match(/superset-worktrees-(?:pocketjs-|dreamcart-)?(.+)$/);
  if (m) return m[1];
  m = d.match(/-Users-evan-(code-.+|Downloads-.+)$/);
  if (m) return m[1].replace(/^code-/, "").replace(/^Downloads-/, "dl/") + " (main)";
  return d;
};
const repoOf = (s: Session): "pocketjs" | "dreamcart" =>
  s.dir.includes("dreamcart") ? "dreamcart" : "pocketjs";
const dayOf = (s: Session) => s.firstTs.slice(0, 10);
const hasPage = (s: Session) => s.humanMessages.length > 0 || s.plans.length > 0;
const titleOf = (s: Session): string => {
  if (s.summaries.length) return s.summaries[0];
  const t = s.humanMessages[0]?.text ?? "";
  const one = t.replace(/\s+/g, " ").trim();
  return one ? one.slice(0, 72) + (one.length > 72 ? "…" : "") : "（空 session）";
};
const DOW = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const dow = (date: string) => DOW[new Date(date + "T12:00:00Z").getUTCDay()];
const esc = (t: string) =>
  t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const hm = (ts: string) => (ts ? ts.slice(11, 16) : "");

// ---------------------------------------------------------------- output
const write = (rel: string, data: string) => {
  const p = OUT + rel;
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, data);
};

// ---------------------------------------------------------------- wiki shell
const allSlugs = WIKI_NAV.flatMap((s) => s.items);
const hrefFor = (slug: string) => (slug ? `/${slug}/` : "/");
const sidebarFor = (active: string) =>
  WIKI_NAV.map(
    (sec) =>
      `<div class="doc-sec"><div class="doc-sec-t">${sec.title}</div>` +
      sec.items
        .map(
          (it) =>
            `<a href="${hrefFor(it.slug)}" class="${it.slug === active ? "on" : ""}">${it.title}</a>`,
        )
        .join("") +
      `</div>`,
  ).join("");

function wikiPage(opts: {
  slug: string;
  title: string;
  html: string;
  active?: string;
  description?: string;
}): void {
  const i = allSlugs.findIndex((s) => s.slug === opts.slug);
  const prev = i > 0 ? allSlugs[i - 1] : undefined;
  const next = i >= 0 && i < allSlugs.length - 1 ? allSlugs[i + 1] : undefined;
  const pager =
    `<nav class="doc-pager">` +
    (prev
      ? `<a href="${hrefFor(prev.slug)}" class="prev"><span>上一篇</span>${prev.title}</a>`
      : `<span></span>`) +
    (next
      ? `<a href="${hrefFor(next.slug)}" class="next"><span>下一篇</span>${next.title}</a>`
      : `<span></span>`) +
    `</nav>`;
  const body =
    `<div class="doc-shell"><aside class="doc-nav">${sidebarFor(opts.slug)}</aside>` +
    `<article class="doc-body"><div class="prose prose-invert max-w-none doc-content">${opts.html}</div>${pager}</article></div>`;
  write(`${opts.slug ? opts.slug + "/" : ""}index.html`, renderPage({
    title: opts.slug ? opts.title : null,
    active: opts.active ?? "story",
    body,
    bodyClass: "doc-page",
    path: hrefFor(opts.slug),
    description: opts.description,
  }));
}

// ---------------------------------------------------------------- markdown
async function setupMarkdown() {
  const highlighter = await createHighlighter({
    themes: ["one-dark-pro"],
    langs: ["tsx", "typescript", "jsx", "javascript", "json", "bash", "rust", "toml", "html", "css", "diff"],
  });
  const ALIAS: Record<string, string> = { ts: "typescript", js: "javascript", sh: "bash", shell: "bash", console: "bash", jsonc: "json", rs: "rust", txt: "text" };
  const loaded = new Set(highlighter.getLoadedLanguages());
  marked.use({
    renderer: {
      code(token: { text?: string; lang?: string }) {
        const raw = (token.lang ?? "").trim().split(/\s+/)[0].toLowerCase();
        const lang = ALIAS[raw] ?? raw;
        return highlighter.codeToHtml(token.text ?? "", {
          theme: "one-dark-pro",
          lang: loaded.has(lang) ? lang : "text",
        });
      },
      heading(token: { tokens?: unknown[]; depth?: number; text?: string }) {
        const depth = token.depth ?? 1;
        const html = this.parser!.parseInline(token.tokens as never);
        const slug = (token.text ?? "")
          .toLowerCase()
          .replace(/<[^>]+>/g, "")
          .replace(/[`*_]/g, "")
          .replace(/[^\p{Script=Han}a-z0-9\s-]/gu, "")
          .trim()
          .replace(/\s+/g, "-");
        return `<h${depth} id="${slug}">${html}</h${depth}>\n`;
      },
    },
  });
}

// Wiki block extensions. Blocks are lifted out before marked runs (their
// bodies are verbatim transcripts — escaped, never markdown-parsed), then
// spliced back over placeholder tokens.
async function renderChapterMd(md: string): Promise<string> {
  const blocks: string[] = [];
  const lift = (cls: string, label: string) => (_m: string, meta: string, body: string) => {
    const i = blocks.length;
    blocks.push(
      `<div class="${cls} not-prose"><div class="q-meta">${label}${esc(meta.trim())}</div>` +
        `<div class="q-body">${esc(body.trim())}</div></div>`,
    );
    return `\n@@WIKIBLOCK${i}@@\n`;
  };
  md = md.replace(/:::quote([^\n]*)\n([\s\S]*?)\n:::/g, lift("quote-card", "作者 · "));
  md = md.replace(/:::agent([^\n]*)\n([\s\S]*?)\n:::/g, lift("agent-card", "agent · "));
  let html = await marked.parse(md);
  html = html.replace(/<p>@@WIKIBLOCK(\d+)@@<\/p>|@@WIKIBLOCK(\d+)@@/g, (_m, a, b) => blocks[Number(a ?? b)]);
  html = html.replace(/\[\[S(\d+)\]\]/g, (_m, n) => {
    const i = Number(n);
    const s = sessions[i];
    return s && hasPage(s)
      ? `<a class="s-ref" href="/sessions/${spad(i)}/">S${i}</a>`
      : `<span class="s-ref">S${n}</span>`;
  });
  html = html.replace(/\[\[PR(\d+)\]\]/g, (_m, n) =>
    `<a class="s-ref" href="${GH}/pull/${n}" target="_blank" rel="noreferrer">PR #${n}</a>`);
  return html;
}

// ---------------------------------------------------------------- home
function statTiles(): string {
  const withContent = sessions.filter(hasPage);
  const totalMsgs = sessions.reduce((a, s) => a + s.humanMessages.length, 0);
  const totalTools = sessions.reduce(
    (a, s) => a + Object.values(s.toolCounts).reduce((x, y) => x + y, 0),
    0,
  );
  const totalMB = Math.round(sessions.reduce((a, s) => a + s.sizeMB, 0));
  const tiles: [string, string][] = [
    ["15 天", "仓库诞生 → v0.5.0"],
    [String(withContent.length), "开发 session"],
    [String(totalMsgs), "作者指令（人类消息）"],
    [totalTools.toLocaleString("en-US"), "agent 工具调用"],
    [String(prs.length), "merged PR"],
    [String(tags.length), "发布的版本"],
    [`${(totalMB / 1024).toFixed(1)} GB`, "session 转录原始体积"],
    ["1 + N", "一个作者 + 一群 coding agent"],
  ];
  return tiles
    .map(([v, k]) => `<div class="stat-tile"><div class="v">${v}</div><div class="k">${k}</div></div>`)
    .join("");
}

async function buildHome() {
  const introMd = readFileSync(SITE + "content/index.md", "utf8");
  const intro = await renderChapterMd(introMd);
  const body =
    `<div class="doc-shell"><aside class="doc-nav">${sidebarFor("")}</aside>` +
    `<article class="doc-body">` +
    `<header class="not-prose">` +
    `<p class="font-mono text-xs uppercase tracking-widest text-brand-2">The making of PocketJS</p>` +
    `<h1 class="mt-3 text-4xl font-bold tracking-tight text-slate-100">一个框架的<span class="text-gradient">诞生档案</span></h1>` +
    `<p class="mt-4 max-w-2xl text-lg text-slate-400">2026 年 7 月 3 日，PocketJS 从一个游戏项目里被抽取成独立仓库；7 月 7 日，v0.2.0 发上 npm。` +
    `这个站点用全部 ${sessions.filter(hasPage).length} 个真实开发 session 的转录，回答一个问题：<b class="text-slate-200">它是怎么被一个人和一群 coding agent 做出来的？</b></p>` +
    `<div class="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-4">${statTiles()}</div>` +
    `</header>` +
    `<div class="prose prose-invert max-w-none doc-content mt-10">${intro}</div>` +
    `<nav class="doc-pager"><span></span><a href="/prehistory/" class="next"><span>开始阅读</span>前史：dreamcart 里的 PSP 梦</a></nav>` +
    `</article></div>`;
  write("index.html", renderPage({
    title: null,
    active: "home",
    body,
    bodyClass: "doc-page",
    path: "/",
  }));
}

// ---------------------------------------------------------------- timeline
function buildTimeline() {
  const byDay = new Map<string, { prs: Pr[]; sessions: number[]; commits: number; tags: Tag[] }>();
  const touch = (d: string) => {
    if (!byDay.has(d)) byDay.set(d, { prs: [], sessions: [], commits: 0, tags: [] });
    return byDay.get(d)!;
  };
  for (const c of commits) touch(c.date).commits = c.count;
  for (const p of prs) touch(p.mergedAt.slice(0, 10)).prs.push(p);
  sessions.forEach((s, i) => {
    if (s.firstTs) touch(dayOf(s)).sessions.push(i);
  });
  for (const t of tags) touch(t.date).tags.push(t);

  const days = [...byDay.keys()].sort();
  const phase = (d: string) =>
    d < "2026-07-03" ? "前史 · dreamcart 时期" : d <= "2026-07-07" ? "从零到一 · 主线五天" : "后记 · 复利期";
  let lastPhase = "";
  let html = "";
  for (const d of days) {
    const v = byDay.get(d)!;
    const p = phase(d);
    if (p !== lastPhase) {
      html += `<h2 class="mt-10 mb-4 text-xl font-bold text-slate-100">${p}</h2>`;
      lastPhase = p;
    }
    const chips: string[] = [];
    if (v.commits) chips.push(`<span class="chip">${v.commits} commits</span>`);
    if (v.prs.length) chips.push(`<span class="chip">${v.prs.length} PR</span>`);
    if (v.sessions.length) chips.push(`<span class="chip">${v.sessions.length} session</span>`);
    const tagPills = v.tags.map((t) => `<span class="tl-tag">${t.tag}</span>`).join(" ");
    const prList = v.prs
      .map(
        (pr) =>
          `<div class="tl-pr"><span class="n">#${pr.number}</span><a href="${GH}/pull/${pr.number}" target="_blank" rel="noreferrer">${esc(pr.title)}</a></div>`,
      )
      .join("");
    const sess = v.sessions
      .map((i) => {
        const s = sessions[i];
        const label = `${sid(i)} · ${wtOf(s)}`;
        return hasPage(s)
          ? `<a class="chip hot" href="/sessions/${spad(i)}/">${label}</a>`
          : `<span class="chip">${label}</span>`;
      })
      .join("");
    html +=
      `<div class="tl-day not-prose${v.tags.length ? " tagged" : ""}">` +
      `<div class="tl-date">${d} <span class="dow">${dow(d)}</span> ${tagPills} <span class="flex flex-wrap gap-1.5">${chips.join("")}</span></div>` +
      (prList ? `<div class="tl-prs">${prList}</div>` : "") +
      (sess ? `<div class="tl-sess">${sess}</div>` : "") +
      `</div>`;
  }
  const head =
    `<h1>全量时间线</h1>` +
    `<p>从 dreamcart 里的第一次 PSP 实验（6 月 16 日）到 v0.5.0（7 月 17 日）：每一天的 commit、merged PR、开发 session 与版本发布。` +
    `点击 session 徽章可进入该 session 的完整指令流。</p>`;
  wikiPage({ slug: "timeline", title: "全量时间线", html: head + html, active: "timeline" });
}

// ---------------------------------------------------------------- sessions
function sessionMetaChips(s: Session): string {
  const topTools = Object.entries(s.toolCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([k, v]) => `<span class="chip">${k} ×${v}</span>`)
    .join("");
  const branches = s.branches
    .filter((b) => b !== "HEAD")
    .slice(0, 6)
    .map((b) => `<span class="chip">${esc(b)}</span>`)
    .join("");
  const span = s.firstTs ? `${hm(s.firstTs)} → ${hm(s.lastTs)}` : "";
  return (
    `<div class="flex flex-wrap gap-1.5 not-prose">` +
    `<span class="chip hot">${repoOf(s)}/${wtOf(s)}</span>` +
    (span ? `<span class="chip">${span}</span>` : "") +
    `<span class="chip">${s.sizeMB} MB 转录</span>` +
    `<span class="chip">${s.humanMessages.length} 条指令</span>` +
    `<span class="chip">${s.assistantCount} 条 agent 消息</span>` +
    branches +
    topTools +
    `</div>`
  );
}

function buildSessionPages() {
  const pageable = sessions.map((s, i) => ({ s, i })).filter(({ s }) => hasPage(s));
  pageable.forEach(({ s, i }, k) => {
    const prev = pageable[k - 1];
    const next = pageable[k + 1];
    type Item = { ts: string; kind: "msg" | "plan"; text: string };
    const items: Item[] = [
      ...s.humanMessages.map((m) => ({ ts: m.ts, kind: "msg" as const, text: m.text })),
      ...s.plans.map((p) => ({ ts: p.ts, kind: "plan" as const, text: p.plan })),
    ].sort((a, b) => (a.ts < b.ts ? -1 : 1));
    const stream = items
      .map((it) => {
        if (it.kind === "plan")
          return `<details class="plan-details"><summary>agent 计划（ExitPlanMode · ${hm(it.ts)}）— 点击展开</summary><pre>${esc(it.text)}</pre></details>`;
        // Context-compaction summaries are harness-injected, not author words.
        const isCompaction = it.text.startsWith("This session is being continued");
        const who = isCompaction ? "上下文续接摘要" : "作者";
        const body = isCompaction
          ? `<details><summary class="cursor-pointer text-slate-500">压缩后的会话摘要（非作者原话）— 点击展开</summary>${esc(it.text)}</details>`
          : esc(it.text);
        return `<div class="msg-card${isCompaction ? " opacity-70" : ""}"><div class="m-head"><span class="who">${who}</span><span>${it.ts.slice(0, 16).replace("T", " ")}</span></div><div class="m-body">${body}</div></div>`;
      })
      .join("");
    const summaries = s.summaries.length
      ? `<p class="mt-3 text-slate-400">${s.summaries.map(esc).join(" · ")}</p>`
      : "";
    const pager =
      `<nav class="doc-pager">` +
      (prev
        ? `<a href="/sessions/${spad(prev.i)}/" class="prev"><span>上一个</span>${sid(prev.i)} · ${dayOf(prev.s)}</a>`
        : `<span></span>`) +
      (next
        ? `<a href="/sessions/${spad(next.i)}/" class="next"><span>下一个</span>${sid(next.i)} · ${dayOf(next.s)}</a>`
        : `<span></span>`) +
      `</nav>`;
    const body =
      `<div class="doc-shell"><aside class="doc-nav">${sidebarFor("sessions")}</aside>` +
      `<article class="doc-body">` +
      `<a href="/sessions/" class="text-sm text-slate-400 hover:text-brand-2">&larr; Session 档案馆</a>` +
      `<h1 class="mt-3 text-3xl font-bold tracking-tight text-slate-100">${sid(i)} · ${dayOf(s)} <span class="text-slate-500">${wtOf(s)}</span></h1>` +
      summaries +
      `<div class="mt-5">${sessionMetaChips(s)}</div>` +
      `<div class="mt-8">${stream || '<p class="text-slate-500">该 session 没有可展示的指令。</p>'}</div>` +
      pager +
      `</article></div>`;
    write(`sessions/${spad(i)}/index.html`, renderPage({
      title: `${sid(i)} · ${titleOf(s)}`,
      active: "sessions",
      body,
      bodyClass: "doc-page",
      path: `/sessions/${spad(i)}/`,
      description: `${dayOf(s)} 在 ${wtOf(s)} 的开发 session：${titleOf(s)}`,
    }));
  });
}

function buildSessionsIndex() {
  let html =
    `<h1>Session 档案馆</h1>` +
    `<p>全部 ${sessions.filter(hasPage).length} 个有内容的开发 session，按开始时间排列。` +
    `每一页是一条完整的「作者指令流」：作者当时说了什么、什么时候说的、agent 给出的计划长什么样。` +
    `原文未经润色 —— 这是这座 wiki 最一手的史料。</p>`;
  let lastDay = "";
  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    if (!s.firstTs) continue;
    const d = dayOf(s);
    if (d !== lastDay) {
      html += `<h2 class="mt-8 mb-2 text-lg font-bold text-slate-100">${d} <span class="text-sm font-normal text-slate-500">${dow(d)}</span></h2>`;
      lastDay = d;
    }
    const label = `<span class="font-mono text-xs text-slate-500">${sid(i)} ${hm(s.firstTs)}</span> ` +
      `<b>${esc(wtOf(s))}</b> <span class="text-slate-500">· ${s.humanMessages.length} 条指令 · ${s.sizeMB} MB</span><br>` +
      `<span class="text-sm text-slate-400">${esc(titleOf(s))}</span>`;
    html += hasPage(s)
      ? `<a href="/sessions/${spad(i)}/" class="not-prose block card p-4 my-2 hover:border-brand transition-colors">${label}</a>`
      : `<div class="not-prose block card p-4 my-2 opacity-50">${label}</div>`;
  }
  wikiPage({ slug: "sessions", title: "Session 档案馆", html, active: "sessions" });
}

// ---------------------------------------------------------------- numbers
function bars(rows: [string, number][], unit = ""): string {
  const max = Math.max(...rows.map(([, v]) => v), 1);
  return (
    `<div class="not-prose grid gap-1.5 my-4">` +
    rows
      .map(
        ([k, v]) =>
          `<div class="bar-row"><span class="lbl">${esc(k)}</span><div><div class="bar" style="width:${((v / max) * 100).toFixed(1)}%"></div></div><span class="val">${v.toLocaleString("en-US")}${unit}</span></div>`,
      )
      .join("") +
    `</div>`
  );
}

function buildNumbers() {
  const toolTotals = new Map<string, number>();
  for (const s of sessions)
    for (const [k, v] of Object.entries(s.toolCounts))
      toolTotals.set(k, (toolTotals.get(k) ?? 0) + v);
  const topTools = [...toolTotals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14);

  const msgsByDay = new Map<string, number>();
  for (const s of sessions) {
    if (!s.firstTs) continue;
    msgsByDay.set(dayOf(s), (msgsByDay.get(dayOf(s)) ?? 0) + s.humanMessages.length);
  }
  const byWt = new Map<string, number>();
  for (const s of sessions) byWt.set(wtOf(s), (byWt.get(wtOf(s)) ?? 0) + s.humanMessages.length);
  const topWt = [...byWt.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  const biggest = sessions
    .map((s, i) => ({ s, i }))
    .sort((a, b) => b.s.sizeMB - a.s.sizeMB)
    .slice(0, 10);

  const html =
    `<h1>数字全景</h1>` +
    `<p>整个项目在数据里的样子。所有数字都来自 session 转录与 git 历史本身，构建时自动计算。</p>` +
    `<div class="not-prose grid grid-cols-2 gap-3 sm:grid-cols-4 my-6">${statTiles()}</div>` +
    `<h2>每天的 commit 数</h2>` +
    bars(commits.map((c) => [c.date.slice(5), c.count])) +
    `<h2>每天的作者指令数</h2>` +
    bars([...msgsByDay.entries()].sort().map(([d, v]) => [d.slice(5), v])) +
    `<h2>agent 工具调用 Top 14</h2><p>Edit/Write 是写代码，Bash 是构建、测试与真机部署，TodoWrite 是任务拆解，Task 是派出子 agent。</p>` +
    bars(topTools) +
    `<h2>各 worktree 的作者指令数</h2><p>并行 worktree 是这个项目的标志性工作方式 —— 高峰期一天同时开 8 条线。</p>` +
    bars(topWt) +
    `<h2>最大的 10 个 session（按转录体积）</h2>` +
    bars(biggest.map(({ s, i }) => [`${sid(i)} ${wtOf(s)}`, Math.round(s.sizeMB)]), " MB") +
    `<p>想知道这些数字背后的故事，去读 <a href="/steering/">作者如何思考与 steering</a> 和 <a href="/agent/">Agent 如何拆解与推进</a>。</p>`;
  wikiPage({ slug: "numbers", title: "数字全景", html, active: "numbers" });
}

// ---------------------------------------------------------------- chapters
async function buildChapters() {
  for (const { slug, title } of allSlugs) {
    if (["", "timeline", "sessions", "numbers"].includes(slug)) continue;
    const md = SITE + "content/" + slug + ".md";
    if (!existsSync(md)) {
      console.warn(`  chapters: MISSING ${slug}.md`);
      continue;
    }
    const html = await renderChapterMd(readFileSync(md, "utf8"));
    wikiPage({ slug, title, html });
  }
}

// ---------------------------------------------------------------- main
async function main() {
  console.log("sessions.pocketjs.dev build:");
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  cpSync(ROOT + "site/assets/favicon.svg", OUT + "favicon.svg");
  cpSync(ROOT + "assets/fonts/Inter-Regular.ttf", OUT + "assets/fonts/Inter-Regular.ttf");
  cpSync(ROOT + "assets/fonts/Inter-Bold.ttf", OUT + "assets/fonts/Inter-Bold.ttf");

  await setupMarkdown();
  await buildHome();
  await buildChapters();
  buildTimeline();
  buildSessionsIndex();
  buildSessionPages();
  buildNumbers();

  write("404.html", renderPage({
    title: "Not found",
    active: "",
    bodyClass: "",
    path: "/404.html",
    body: `<section class="mx-auto flex min-h-[60vh] max-w-xl flex-col items-center justify-center px-5 py-24 text-center">
      <div class="font-mono text-6xl font-bold text-gradient">404</div>
      <h1 class="mt-4 text-2xl font-bold text-slate-100">这一页不在档案里。</h1>
      <div class="mt-7 flex gap-3"><a href="/" class="btn btn-primary px-5 py-2.5">回到首页</a><a href="/timeline/" class="btn px-5 py-2.5">看时间线</a></div>
    </section>`,
  }));

  const proc = Bun.spawnSync(
    ["bunx", "@tailwindcss/cli", "-i", SITE + "assets/tailwind.css", "-o", OUT + "assets/site.css", "--minify"],
    { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
  );
  if (proc.exitCode !== 0) {
    console.error(proc.stderr.toString());
    throw new Error("tailwind build failed");
  }
  console.log(`  assets/site.css  (${(Bun.file(OUT + "assets/site.css").size / 1024).toFixed(0)} KiB)`);
  console.log("sessions.pocketjs.dev build: done -> sessions/dist/");
}

await main();
