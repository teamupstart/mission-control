import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const here = dirname(fileURLToPath(import.meta.url));
const markdown = await readFile(join(here, "plan.md"), "utf8");
const bodyMarkdown = markdown.replace(/^# .+\n/, "");

function textOf(value) {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(textOf).join("");
  if (React.isValidElement(value)) return textOf(value.props.children);
  return "";
}

const usedSlugs = new Map();
function slugFor(children) {
  const base = textOf(children)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "section";
  const count = usedSlugs.get(base) ?? 0;
  usedSlugs.set(base, count + 1);
  return count === 0 ? base : `${base}-${count + 1}`;
}

const architectureDiagram = `
<div class="diagram" role="img" aria-label="Before and after worktree ownership flow">
  <svg viewBox="0 0 1120 510" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <marker id="arch-arrow-old" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" class="old-fill"/></marker>
      <marker id="arch-arrow-new" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" class="new-fill"/></marker>
    </defs>
    <text x="30" y="34" class="diagram-kicker old-text">TODAY: SPLIT AUTHORITY</text>
    <text x="590" y="34" class="diagram-kicker new-text">TARGET: ONE NATIVE ALLOCATOR</text>
    <line x1="560" y1="12" x2="560" y2="492" class="divider"/>

    <g class="node"><rect x="34" y="72" width="142" height="58" rx="10"/><text x="105" y="96">Task</text><text x="105" y="115" class="sub">dispatcher</text></g>
    <g class="node"><rect x="34" y="164" width="142" height="58" rx="10"/><text x="105" y="188">Check lease</text><text x="105" y="207" class="sub">manager</text></g>
    <g class="node"><rect x="34" y="256" width="142" height="58" rx="10"/><text x="105" y="280">Manual</text><text x="105" y="299" class="sub">session script</text></g>
    <g class="node old"><rect x="235" y="145" width="150" height="86" rx="12"/><text x="310" y="177">Treehouse CLI</text><text x="310" y="197" class="sub">allocator + reset</text><text x="310" y="216" class="sub">process scan</text></g>
    <g class="node"><rect x="414" y="79" width="118" height="62" rx="10"/><text x="473" y="104">State file</text><text x="473" y="123" class="sub">+ file lock</text></g>
    <g class="node"><rect x="414" y="179" width="118" height="62" rx="10"/><text x="473" y="204">Git</text><text x="473" y="223" class="sub">worktrees</text></g>
    <g class="node"><rect x="235" y="321" width="150" height="74" rx="10"/><text x="310" y="347">Mission DB</text><text x="310" y="366" class="sub">tasks + checks</text><text x="310" y="385" class="sub">partial ownership</text></g>
    <g class="node"><rect x="34" y="359" width="142" height="58" rx="10"/><text x="105" y="383">Pool reaper</text><text x="105" y="402" class="sub">text status parser</text></g>

    <path d="M176 101 H216 Q235 101 235 145" class="old-arrow"/>
    <path d="M176 193 H235" class="old-arrow"/>
    <path d="M176 285 H216 Q235 285 235 231" class="old-arrow"/>
    <path d="M385 170 Q402 170 414 119" class="old-arrow"/>
    <path d="M385 205 H414" class="old-arrow"/>
    <path d="M176 388 H214 Q235 388 235 231" class="old-arrow"/>
    <path d="M176 118 Q206 340 235 350" class="old-arrow dotted"/>
    <path d="M176 210 Q205 342 235 358" class="old-arrow dotted"/>

    <g class="node"><rect x="600" y="63" width="142" height="58" rx="10"/><text x="671" y="87">Task</text><text x="671" y="106" class="sub">dispatcher</text></g>
    <g class="node"><rect x="600" y="146" width="142" height="58" rx="10"/><text x="671" y="170">Check lease</text><text x="671" y="189" class="sub">manager</text></g>
    <g class="node"><rect x="600" y="229" width="142" height="58" rx="10"/><text x="671" y="253">Manual</text><text x="671" y="272" class="sub">session client</text></g>
    <g class="node"><rect x="600" y="312" width="142" height="58" rx="10"/><text x="671" y="336">Worktrees UI</text><text x="671" y="355" class="sub">status + actions</text></g>
    <g class="node new"><rect x="798" y="157" width="168" height="110" rx="14"/><text x="882" y="190">WorktreeManager</text><text x="882" y="212" class="sub">lease identity</text><text x="882" y="232" class="sub">state + safety</text><text x="882" y="252" class="sub">provider registry</text></g>
    <g class="node"><rect x="994" y="65" width="102" height="62" rx="10"/><text x="1045" y="90">SQLite</text><text x="1045" y="109" class="sub">slots + leases</text></g>
    <g class="node"><rect x="994" y="181" width="102" height="62" rx="10"/><text x="1045" y="206">Git</text><text x="1045" y="225" class="sub">worktrees</text></g>
    <g class="node"><rect x="994" y="297" width="102" height="62" rx="10"/><text x="1045" y="322">Existing</text><text x="1045" y="341" class="sub">process scan</text></g>

    <path d="M742 92 H770 Q798 92 798 171" class="new-arrow"/>
    <path d="M742 175 H798" class="new-arrow"/>
    <path d="M742 258 H798" class="new-arrow"/>
    <path d="M742 341 H770 Q798 341 798 253" class="new-arrow"/>
    <path d="M966 184 Q985 168 994 119" class="new-arrow"/>
    <path d="M966 212 H994" class="new-arrow"/>
    <path d="M966 240 Q985 255 994 306" class="new-arrow"/>
    <text x="30" y="452" class="diagram-note">Treehouse owns slot state; Mission Control reconstructs app ownership</text>
    <text x="30" y="470" class="diagram-note">across DB rows, holders, pins, and in-memory race guards.</text>
    <text x="590" y="452" class="diagram-note">Domain owners call one daemon allocator.</text>
    <text x="590" y="470" class="diagram-note">SQLite records every native transition; Git and process safety sit below.</text>
  </svg>
</div>`;

const migrationDiagram = `
<div class="diagram compact" role="img" aria-label="Staged migration from Treehouse to the native worktree manager">
  <svg viewBox="0 0 1120 300" xmlns="http://www.w3.org/2000/svg">
    <defs><marker id="migration-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" class="new-fill"/></marker></defs>
    <text x="30" y="35" class="diagram-kicker new-text">STAGED CUTOVER: NEVER DUAL-OWN A WORKTREE</text>
    <g class="node new"><rect x="32" y="72" width="168" height="68" rx="12"/><text x="116" y="100">New acquisition</text><text x="116" y="121" class="sub">task, check, manual</text></g>
    <g class="node"><rect x="264" y="72" width="180" height="68" rx="12"/><text x="354" y="100">Native pool</text><text x="354" y="121" class="sub">new paths + SQLite</text></g>
    <path d="M200 106 H264" class="new-arrow migration"/>

    <g class="node old"><rect x="32" y="188" width="168" height="68" rx="12"/><text x="116" y="216">Legacy record</text><text x="116" y="237" class="sub">provider = treehouse</text></g>
    <g class="node old"><rect x="264" y="188" width="180" height="68" rx="12"/><text x="354" y="216">Compatibility bridge</text><text x="354" y="237" class="sub">JSON + conditional return</text></g>
    <path d="M200 222 H264" class="new-arrow migration"/>

    <g class="node"><rect x="516" y="72" width="190" height="68" rx="12"/><text x="611" y="100">Native operations</text><text x="611" y="121" class="sub">one allocator authority</text></g>
    <path d="M444 106 H516" class="new-arrow migration"/>

    <g class="node"><rect x="516" y="188" width="190" height="68" rx="12"/><text x="611" y="216">Prove exact lease</text><text x="611" y="237" class="sub">or leave untouched</text></g>
    <path d="M444 222 H516" class="new-arrow migration"/>

    <g class="node new"><rect x="778" y="130" width="180" height="68" rx="12"/><text x="868" y="158">Legacy MC count: 0</text><text x="868" y="179" class="sub">foreign leases remain</text></g>
    <path d="M706 222 Q746 222 778 181" class="new-arrow migration"/>
    <g class="node"><rect x="988" y="130" width="106" height="68" rx="12"/><text x="1041" y="158">Remove</text><text x="1041" y="179" class="sub">dependency</text></g>
    <path d="M958 164 H988" class="new-arrow migration"/>
  </svg>
</div>`;

const preparedDiagrams = [architectureDiagram, migrationDiagram];
let mermaidIndex = 0;

const rendered = renderToStaticMarkup(
  React.createElement(ReactMarkdown, {
    remarkPlugins: [remarkGfm],
    components: {
      h2: ({ children }) => React.createElement("h2", { id: slugFor(children) }, children),
      h3: ({ children }) => React.createElement("h3", { id: slugFor(children) }, children),
      table: ({ children }) => React.createElement("div", { className: "table-wrap" }, React.createElement("table", null, children)),
      pre: ({ children }) => {
        const child = Array.isArray(children) ? children[0] : children;
        const className = React.isValidElement(child) ? child.props.className : "";
        if (className === "language-mermaid") {
          const diagram = preparedDiagrams[mermaidIndex];
          if (!diagram) {
            throw new Error(`plan.md contains an unexpected Mermaid block at position ${mermaidIndex + 1}`);
          }
          mermaidIndex += 1;
          return React.createElement("div", { dangerouslySetInnerHTML: { __html: diagram } });
        }
        return React.createElement("div", { className: "code-wrap" }, React.createElement("pre", null, children));
      },
    },
    children: bodyMarkdown,
  }),
);

if (mermaidIndex !== preparedDiagrams.length) {
  throw new Error(
    `plan.md rendered ${mermaidIndex} Mermaid blocks, but ${preparedDiagrams.length} prepared diagrams exist`,
  );
}

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="Investigation and engineering plan for native Mission Control worktree management">
  <title>Native worktree management</title>
  <style>
    :root {
      color-scheme: light dark;
      --canvas: #e9ece7;
      --paper: #fffdf7;
      --ink: #1d2926;
      --muted: #65706c;
      --line: #c8d0ca;
      --forest: #173f34;
      --moss: #3d765b;
      --mint: #dcebe1;
      --copper: #b76536;
      --copper-pale: #f4dfd1;
      --blue: #396b79;
      --blue-pale: #dce9ec;
      --red: #a34943;
      --red-pale: #f3dedb;
      --code-bg: #17231f;
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
        radial-gradient(circle at 15% 0, rgba(61, 118, 91, .12), transparent 34rem),
        linear-gradient(rgba(23, 63, 52, .035) 1px, transparent 1px),
        linear-gradient(90deg, rgba(23, 63, 52, .035) 1px, transparent 1px),
        var(--canvas);
      background-size: auto, 28px 28px, 28px 28px, auto;
      font: 16px/1.66 var(--body);
    }
    a { color: var(--moss); text-underline-offset: .2em; }
    a:hover { color: var(--copper); }
    a:focus-visible { outline: 3px solid #79b89a; outline-offset: 4px; }
    code, pre, .eyebrow, .pill, th { font-family: var(--mono); }
    .shell {
      width: min(1220px, calc(100% - 28px));
      margin: 22px auto 72px;
      overflow: hidden;
      background: var(--paper);
      border-top: 7px solid var(--moss);
      box-shadow: var(--shadow);
    }
    .hero {
      position: relative;
      overflow: hidden;
      padding: clamp(44px, 8vw, 92px) clamp(24px, 7vw, 84px) 64px;
      color: #f1f7f3;
      background: linear-gradient(125deg, #12352d 0%, #1d5141 62%, #2d6950 100%);
    }
    .hero::after {
      content: "";
      position: absolute;
      right: -130px;
      top: -190px;
      width: 500px;
      height: 500px;
      border: 82px solid rgba(191, 222, 202, .11);
      border-radius: 48% 52% 47% 53%;
      transform: rotate(18deg);
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
    h1, h2, h3, h4 { font-family: var(--display); font-weight: 600; }
    h1 {
      max-width: 880px;
      margin: 0;
      font-size: clamp(3rem, 7vw, 6.3rem);
      line-height: .92;
      letter-spacing: -.047em;
    }
    .lede { max-width: 820px; margin: 29px 0 0; color: #d8e9df; font-size: 1.14rem; }
    .verdict {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 15px;
      max-width: 920px;
      margin-top: 34px;
      padding: 19px 22px;
      color: #173e32;
      background: #dceee3;
      border-left: 6px solid #78b58f;
      box-shadow: 0 12px 32px rgba(0, 0, 0, .17);
    }
    .verdict .mark { font: 800 1.2rem var(--mono); }
    nav {
      display: flex;
      flex-wrap: wrap;
      gap: 8px 18px;
      padding: 16px clamp(22px, 6vw, 72px);
      background: #e0ebe3;
      border-bottom: 1px solid var(--line);
    }
    nav a { font: 700 .74rem var(--mono); text-decoration: none; text-transform: uppercase; letter-spacing: .03em; }
    main { padding: 25px clamp(22px, 6vw, 72px) 80px; }
    h2 {
      margin: 70px 0 18px;
      padding-top: 10px;
      color: var(--forest);
      font-size: clamp(2rem, 4vw, 3.25rem);
      line-height: 1.04;
      letter-spacing: -.032em;
      scroll-margin-top: 20px;
    }
    h3 { margin: 36px 0 10px; color: var(--forest); font-size: 1.55rem; scroll-margin-top: 20px; }
    h4 { margin: 24px 0 7px; font-size: 1.18rem; }
    p, li { max-width: 87ch; }
    p { margin: 12px 0; }
    li { margin: 6px 0; }
    blockquote { margin: 22px 0; padding: 12px 20px; background: var(--mint); border-left: 5px solid var(--moss); }
    strong { color: var(--forest); }
    hr { margin: 48px 0; border: 0; border-top: 1px solid var(--line); }
    .status-strip {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 1px;
      background: var(--line);
      border-bottom: 1px solid var(--line);
    }
    .status-strip div { padding: 16px 20px; background: var(--paper); }
    .status-strip span { display: block; color: var(--muted); font: .69rem var(--mono); text-transform: uppercase; letter-spacing: .1em; }
    .status-strip strong { display: block; margin-top: 3px; font-size: .97rem; }
    .table-wrap, .code-wrap, .diagram { max-width: 100%; overflow-x: auto; margin: 25px 0; }
    table { width: 100%; min-width: 780px; border-collapse: collapse; font-size: .94rem; }
    th, td { padding: 11px 13px; text-align: left; vertical-align: top; border-bottom: 1px solid var(--line); }
    th { color: #f0f7f2; background: var(--forest); font-size: .72rem; letter-spacing: .05em; text-transform: uppercase; }
    tbody tr:nth-child(even) { background: #eef2ed; }
    :not(pre) > code { padding: .12em .34em; color: #1e4a3d; background: #e2ece5; border-radius: 4px; font-size: .9em; }
    pre { margin: 0; padding: 19px 21px; color: var(--code-ink); background: var(--code-bg); font-size: .84rem; line-height: 1.58; white-space: pre-wrap; overflow-wrap: anywhere; }
    .diagram { padding: 18px; background: #edf3ef; border: 1px solid var(--line); }
    .diagram svg { display: block; width: 100%; min-width: 930px; height: auto; }
    .diagram.compact svg { min-width: 870px; }
    .diagram text { font: 700 13px var(--mono); fill: var(--ink); text-anchor: middle; }
    .diagram .sub { font-size: 10.5px; font-weight: 500; fill: var(--muted); }
    .diagram .node rect { fill: var(--paper); stroke: var(--moss); stroke-width: 2; }
    .diagram .node.old rect { fill: var(--copper-pale); stroke: var(--copper); }
    .diagram .node.new rect { fill: var(--mint); stroke: var(--moss); stroke-width: 2.5; }
    .diagram .diagram-kicker { font-size: 12px; letter-spacing: .11em; text-anchor: start; }
    .diagram .old-text { fill: var(--copper); }
    .diagram .new-text { fill: var(--moss); }
    .diagram .diagram-note { font-size: 10.5px; font-weight: 500; text-anchor: start; fill: var(--muted); }
    .diagram .divider { stroke: var(--line); stroke-width: 2; stroke-dasharray: 7 8; }
    .diagram .old-arrow, .diagram .new-arrow { fill: none; stroke-width: 2.3; }
    .diagram .old-arrow { stroke: var(--copper); marker-end: url(#arch-arrow-old); }
    .diagram .new-arrow { stroke: var(--moss); marker-end: url(#arch-arrow-new); }
    .diagram .new-arrow.migration { marker-end: url(#migration-arrow); }
    .diagram .dotted { stroke-dasharray: 5 5; }
    .diagram .old-fill { fill: var(--copper); }
    .diagram .new-fill { fill: var(--moss); }
    .review {
      margin: 48px 0 8px;
      padding: 22px 24px;
      background: var(--blue-pale);
      border: 1px solid color-mix(in srgb, var(--blue) 45%, transparent);
      border-left: 6px solid var(--blue);
    }
    .review strong { color: var(--blue); }
    footer { padding: 25px clamp(22px, 6vw, 72px); color: var(--muted); background: #e0ebe3; border-top: 1px solid var(--line); font-size: .84rem; }
    @media (max-width: 760px) {
      .shell { width: min(100% - 14px, 1220px); margin-top: 7px; }
      .status-strip { grid-template-columns: 1fr; }
      .verdict { grid-template-columns: 1fr; }
      main { padding-bottom: 58px; }
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --canvas: #101614; --paper: #18221e; --ink: #e7eee9; --muted: #aab7b0;
        --line: #394941; --forest: #8bc7a6; --moss: #7fbd9d; --mint: #203a2d;
        --copper: #e29a6f; --copper-pale: #3a2a22; --blue: #82bac8; --blue-pale: #20343a;
        --red: #da827a; --red-pale: #3b2524; --code-bg: #0d1512; --code-ink: #edf5f0;
        --shadow: 0 24px 70px rgba(0, 0, 0, .42);
      }
      nav, footer { background: #172b22; }
      tbody tr:nth-child(even) { background: #202d27; }
      :not(pre) > code { color: #dff1e5; background: #294036; }
      .status-strip div { background: #18221e; }
      .verdict { color: #e3f3e9; background: #203b2e; }
      .diagram { background: #15271f; }
      .diagram .node rect { fill: #1a2721; }
      .diagram .node.old rect { fill: #3a2a22; }
      .diagram .node.new rect { fill: #203a2d; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <header class="hero">
      <p class="eyebrow">Investigation and engineering plan · 15 August 2026</p>
      <h1>Native worktree management</h1>
      <p class="lede">Absorb Treehouse's pooled-worktree mechanics into Mission Control, consolidate overlapping ownership logic, and retire the runtime dependency without losing fail-closed safety.</p>
      <div class="verdict"><span class="mark">→</span><span><strong>Recommended direction:</strong> one daemon-owned, SQLite-backed worktree manager, with a staged read/return-only bridge for existing Treehouse leases.</span></div>
    </header>
      <div class="status-strip" aria-label="Plan status">
      <div><span>Status</span><strong>Approved for phased planning</strong></div>
      <div><span>Scope</span><strong>Plan only, no application changes</strong></div>
      <div><span>Evidence</span><strong>Mission Control + Treehouse v2.1.1</strong></div>
    </div>
    <nav aria-label="Plan sections">
      <a href="#executive-recommendation">Recommendation</a>
      <a href="#what-treehouse-actually-provides">Treehouse</a>
      <a href="#redundant-and-conflicting-implementations">Overlap</a>
      <a href="#target-architecture">Architecture</a>
      <a href="#legacy-migration-and-dependency-removal">Migration</a>
      <a href="#delivery-sequence">Delivery</a>
      <a href="#adopted-decisions">Decisions</a>
      <a href="#success-criteria">Success</a>
    </nav>
    <main>
      ${rendered}
      <div class="review"><strong>Decision record.</strong> Mission Control recorded all four recommended architecture choices and authorized the phased implementation follow-up on 15 August 2026.</div>
    </main>
    <footer>Source of truth: docs/plans/native-worktree-management/plan.md · Offline render: plan.html · Generated by render-plan.mjs</footer>
  </div>
</body>
</html>
`;

await writeFile(join(here, "plan.html"), html);
