import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const here = dirname(fileURLToPath(import.meta.url));
const markdown = await readFile(join(here, "phased-plan.md"), "utf8");
const bodyMarkdown = markdown.replace(/^# .+\n/, "");

function textOf(value) {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(textOf).join("");
  if (React.isValidElement(value)) return textOf(value.props.children);
  return "";
}

const usedSlugs = new Map();
function slugFor(children) {
  const base =
    textOf(children)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "section";
  const count = usedSlugs.get(base) ?? 0;
  usedSlugs.set(base, count + 1);
  return count === 0 ? base : `${base}-${count + 1}`;
}

const phaseGraph = `
<figure class="diagram" role="group" aria-labelledby="phase-flow-caption">
  <svg viewBox="0 0 1160 330" xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="phase-flow-title phase-flow-desc">
    <title id="phase-flow-title">Four serial implementation phases</title>
    <desc id="phase-flow-desc">Durable native allocation precedes consumer cutover, which precedes Treehouse dependency retirement, which precedes the Settings worktree operations surface.</desc>
    <defs>
      <marker id="phase-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" class="arrow-fill"/></marker>
    </defs>
    <text x="30" y="34" class="diagram-kicker">MERGE ORDER: EACH PHASE LEAVES A COMPLETE, SAFE SYSTEM</text>
    <g class="phase p1">
      <rect x="30" y="78" width="238" height="152" rx="18"/>
      <text x="54" y="111" class="num">01</text>
      <text x="54" y="145" class="title">Durable native allocator</text>
      <text x="54" y="174" class="sub">state machine + SQLite</text>
      <text x="54" y="196" class="sub">occupancy + reconciliation</text>
    </g>
    <g class="phase p2">
      <rect x="318" y="78" width="238" height="152" rx="18"/>
      <text x="342" y="111" class="num">02</text>
      <text x="342" y="145" class="title">Acquisition cutover</text>
      <text x="342" y="174" class="sub">tasks + checks + manual</text>
      <text x="342" y="196" class="sub">native default, Git fallback</text>
    </g>
    <g class="phase p3">
      <rect x="606" y="78" width="238" height="152" rx="18"/>
      <text x="630" y="111" class="num">03</text>
      <text x="630" y="145" class="title">Legacy retirement</text>
      <text x="630" y="174" class="sub">read / conditional return</text>
      <text x="630" y="196" class="sub">remove runtime dependency</text>
    </g>
    <g class="phase p4">
      <rect x="894" y="78" width="238" height="152" rx="18"/>
      <text x="918" y="111" class="num">04</text>
      <text x="918" y="145" class="title">Settings operations</text>
      <text x="918" y="174" class="sub">inventory + policy</text>
      <text x="918" y="196" class="sub">preview-first actions</text>
    </g>
    <path d="M268 154 H318" class="arrow"/>
    <path d="M556 154 H606" class="arrow"/>
    <path d="M844 154 H894" class="arrow"/>
    <text x="30" y="278" class="note">No concurrent phases: the manager contract, provider cutover, compatibility boundary, and browser projection overlap in sequence.</text>
    <text x="30" y="301" class="note">Every phase task depends on this plan session; each later task also depends directly on the phase before it.</text>
  </svg>
  <figcaption id="phase-flow-caption">The sequence first proves the allocator, then moves every caller, then retires Treehouse assumptions, and only then exposes the final operations contract.</figcaption>
</figure>`;

const preparedDiagrams = [phaseGraph];
let mermaidIndex = 0;

const rendered = renderToStaticMarkup(
  React.createElement(ReactMarkdown, {
    remarkPlugins: [remarkGfm],
    components: {
      h2: ({ children }) => React.createElement("h2", { id: slugFor(children) }, children),
      h3: ({ children }) => React.createElement("h3", { id: slugFor(children) }, children),
      table: ({ children }) =>
        React.createElement(
          "div",
          { className: "table-wrap" },
          React.createElement("table", null, children),
        ),
      pre: ({ children }) => {
        const child = Array.isArray(children) ? children[0] : children;
        const className = React.isValidElement(child) ? child.props.className : "";
        if (className === "language-mermaid") {
          const diagram = preparedDiagrams[mermaidIndex];
          if (!diagram) {
            throw new Error(
              `phased-plan.md contains an unexpected Mermaid block at position ${mermaidIndex + 1}`,
            );
          }
          mermaidIndex += 1;
          return React.createElement("div", {
            dangerouslySetInnerHTML: { __html: diagram },
          });
        }
        return React.createElement(
          "div",
          { className: "code-wrap" },
          React.createElement("pre", null, children),
        );
      },
    },
    children: bodyMarkdown,
  }),
);

if (mermaidIndex !== preparedDiagrams.length) {
  throw new Error(
    `phased-plan.md rendered ${mermaidIndex} Mermaid blocks, but ${preparedDiagrams.length} prepared diagrams exist`,
  );
}

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="Approved phased implementation plan for native Mission Control worktree management">
  <title>Native worktree management - phased plan</title>
  <style>
    :root {
      color-scheme: light dark;
      --canvas: #e8ebe7;
      --paper: #fffdf8;
      --ink: #1b2824;
      --muted: #68736e;
      --line: #c8d0ca;
      --forest: #173f34;
      --moss: #3d765b;
      --mint: #dcebe1;
      --teal: #2d6d70;
      --teal-pale: #dcebed;
      --ochre: #a7652f;
      --ochre-pale: #f3e3d2;
      --plum: #72556f;
      --plum-pale: #eee2ec;
      --code-bg: #15221e;
      --code-ink: #edf5f0;
      --shadow: 0 24px 70px rgba(25, 54, 43, .14);
      --display: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif;
      --body: "Avenir Next", Avenir, "Segoe UI", sans-serif;
      --mono: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
    }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body {
      margin: 0;
      color: var(--ink);
      background:
        radial-gradient(circle at 88% 0, rgba(45, 109, 112, .13), transparent 32rem),
        linear-gradient(rgba(23, 63, 52, .035) 1px, transparent 1px),
        linear-gradient(90deg, rgba(23, 63, 52, .035) 1px, transparent 1px),
        var(--canvas);
      background-size: auto, 28px 28px, 28px 28px, auto;
      font: 16px/1.66 var(--body);
    }
    a { color: var(--moss); text-underline-offset: .2em; }
    a:hover { color: var(--ochre); }
    a:focus-visible { outline: 3px solid #79b89a; outline-offset: 4px; }
    code, pre, .eyebrow, th, .step { font-family: var(--mono); }
    .shell {
      width: min(1220px, calc(100% - 28px));
      margin: 22px auto 72px;
      overflow: hidden;
      background: var(--paper);
      border-top: 7px solid var(--teal);
      box-shadow: var(--shadow);
    }
    .hero {
      position: relative;
      overflow: hidden;
      padding: clamp(44px, 8vw, 92px) clamp(24px, 7vw, 84px) 60px;
      color: #f1f7f3;
      background: linear-gradient(125deg, #12352d 0%, #205449 54%, #2d6d70 100%);
    }
    .hero::after {
      content: "04";
      position: absolute;
      right: clamp(-36px, 2vw, 24px);
      top: -78px;
      color: rgba(223, 241, 233, .08);
      font: 800 clamp(15rem, 31vw, 28rem)/1 var(--mono);
      letter-spacing: -.12em;
    }
    .hero > * { position: relative; z-index: 1; }
    .eyebrow {
      margin: 0 0 20px;
      color: #a9d7be;
      font-size: .74rem;
      font-weight: 800;
      letter-spacing: .16em;
      text-transform: uppercase;
    }
    h1, h2, h3 { font-family: var(--display); font-weight: 600; }
    h1 {
      max-width: 880px;
      margin: 0;
      font-size: clamp(3rem, 7vw, 6.2rem);
      line-height: .92;
      letter-spacing: -.047em;
    }
    .lede { max-width: 820px; margin: 28px 0 0; color: #d8e9df; font-size: 1.14rem; }
    .sequence {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 1px;
      background: var(--line);
      border-bottom: 1px solid var(--line);
    }
    .sequence div { padding: 16px 18px; background: var(--paper); }
    .sequence .step { display: block; color: var(--teal); font-size: .7rem; font-weight: 800; letter-spacing: .1em; }
    .sequence strong { display: block; margin-top: 4px; font-size: .9rem; }
    nav {
      display: flex;
      flex-wrap: wrap;
      gap: 8px 18px;
      padding: 16px clamp(22px, 6vw, 72px);
      background: #e0ebe5;
      border-bottom: 1px solid var(--line);
    }
    nav a { font: 700 .74rem var(--mono); text-decoration: none; text-transform: uppercase; letter-spacing: .03em; }
    main { padding: 25px clamp(22px, 6vw, 72px) 80px; }
    h2 {
      margin: 68px 0 18px;
      padding-top: 10px;
      color: var(--forest);
      font-size: clamp(2rem, 4vw, 3.15rem);
      line-height: 1.05;
      letter-spacing: -.032em;
      scroll-margin-top: 20px;
    }
    h3 { margin: 34px 0 10px; color: var(--forest); font-size: 1.5rem; scroll-margin-top: 20px; }
    p, li { max-width: 88ch; }
    p { margin: 12px 0; }
    li { margin: 6px 0; }
    strong { color: var(--forest); }
    .table-wrap, .code-wrap, .diagram { max-width: 100%; overflow-x: auto; margin: 25px 0; }
    table { width: 100%; min-width: 820px; border-collapse: collapse; font-size: .93rem; }
    th, td { padding: 11px 13px; text-align: left; vertical-align: top; border-bottom: 1px solid var(--line); }
    th { color: #f1f7f3; background: var(--forest); font-size: .72rem; letter-spacing: .05em; text-transform: uppercase; }
    tbody tr:nth-child(even) { background: #edf2ee; }
    :not(pre) > code { padding: .12em .34em; color: #1e4a3d; background: #e2ece5; border-radius: 4px; font-size: .9em; }
    pre { margin: 0; padding: 19px 21px; color: var(--code-ink); background: var(--code-bg); font-size: .84rem; line-height: 1.58; white-space: pre-wrap; overflow-wrap: anywhere; }
    .diagram { padding: 18px; background: #edf3ef; border: 1px solid var(--line); }
    .diagram svg { display: block; width: 100%; min-width: 980px; height: auto; }
    .diagram figcaption { max-width: 88ch; margin: 12px 12px 3px; color: var(--muted); font-size: .88rem; }
    .diagram text { font-family: var(--mono); text-anchor: start; }
    .diagram .diagram-kicker { fill: var(--teal); font-size: 12px; font-weight: 800; letter-spacing: .1em; }
    .diagram .phase rect { fill: var(--paper); stroke-width: 2.5; }
    .diagram .p1 rect { stroke: var(--moss); }
    .diagram .p2 rect { stroke: var(--teal); }
    .diagram .p3 rect { stroke: var(--ochre); }
    .diagram .p4 rect { stroke: var(--plum); }
    .diagram .num { fill: var(--muted); font-size: 18px; font-weight: 800; }
    .diagram .title { fill: var(--ink); font: 700 15px var(--body); }
    .diagram .sub { fill: var(--muted); font-size: 11px; }
    .diagram .arrow { fill: none; stroke: var(--teal); stroke-width: 2.5; marker-end: url(#phase-arrow); }
    .diagram .arrow-fill { fill: var(--teal); }
    .diagram .note { fill: var(--muted); font-size: 11px; }
    .handoff {
      margin: 50px 0 5px;
      padding: 22px 24px;
      background: var(--teal-pale);
      border: 1px solid color-mix(in srgb, var(--teal) 45%, transparent);
      border-left: 6px solid var(--teal);
    }
    .handoff strong { color: var(--teal); }
    footer { padding: 25px clamp(22px, 6vw, 72px); color: var(--muted); background: #e0ebe5; border-top: 1px solid var(--line); font-size: .84rem; }
    @media (max-width: 820px) {
      .sequence { grid-template-columns: 1fr 1fr; }
    }
    @media (max-width: 560px) {
      .shell { width: min(100% - 14px, 1220px); margin-top: 7px; }
      .sequence { grid-template-columns: 1fr; }
      main { padding-bottom: 58px; }
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --canvas: #101614; --paper: #18221e; --ink: #e7eee9; --muted: #aab7b0;
        --line: #394941; --forest: #8bc7a6; --moss: #7fbd9d; --mint: #203a2d;
        --teal: #83c5c7; --teal-pale: #20383a; --ochre: #e0a46e; --ochre-pale: #3a2b21;
        --plum: #c6a1c1; --plum-pale: #352832; --code-bg: #0d1512; --code-ink: #edf5f0;
        --shadow: 0 24px 70px rgba(0, 0, 0, .42);
      }
      nav, footer { background: #172b22; }
      tbody tr:nth-child(even) { background: #202d27; }
      :not(pre) > code { color: #dff1e5; background: #294036; }
      .sequence div { background: #18221e; }
      .diagram { background: #15271f; }
      .diagram .phase rect { fill: #1a2721; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <header class="hero">
      <p class="eyebrow">Approved implementation sequence · 15 August 2026</p>
      <h1>Native worktree management</h1>
      <p class="lede">Four merge-aware phases absorb pooled-worktree ownership into Mission Control, stop new Treehouse use, preserve historical safety, and finish with an operator-facing worktree control plane.</p>
    </header>
    <div class="sequence" aria-label="Implementation phases">
      <div><span class="step">PHASE 01</span><strong>Prove the allocator</strong></div>
      <div><span class="step">PHASE 02</span><strong>Move every caller</strong></div>
      <div><span class="step">PHASE 03</span><strong>Retire the dependency</strong></div>
      <div><span class="step">PHASE 04</span><strong>Expose operations</strong></div>
    </div>
    <nav aria-label="Phased plan sections">
      <a href="#source-and-approval">Approval</a>
      <a href="#repository-findings-that-refine-the-source-design">Findings</a>
      <a href="#sizing-estimate-and-phase-count-rationale">Sizing</a>
      <a href="#phases">Phases</a>
      <a href="#dependency-graph-and-merge-order">Dependencies</a>
      <a href="#cross-phase-contracts">Contracts</a>
      <a href="#final-verification-strategy">Verification</a>
      <a href="#complete-set-audit">Audit</a>
    </nav>
    <main>
      ${rendered}
      <div class="handoff"><strong>Scheduling contract.</strong> Each phase is one Mission Control task. All four depend on this planning session, and Phases 2 through 4 also depend directly on the preceding phase task.</div>
    </main>
    <footer>Source of truth: docs/plans/native-worktree-management/phased-plan.md · Detailed phase files sit beside it · Offline render: phased-plan.html</footer>
  </div>
</body>
</html>
`;

await writeFile(join(here, "phased-plan.html"), html);
