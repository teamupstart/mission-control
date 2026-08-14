// Usage:
//   node render-plan.mjs [phased] [--check]
//
// The Markdown files are authoritative. This renderer keeps their offline HTML views reproducible
// and refuses to silently drop the one flow diagram each source declares.
import { readFileSync, writeFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const phased = process.argv.includes("phased");
const check = process.argv.includes("--check");
const sourceName = phased ? "phased-plan.md" : "plan.md";
const outputName = phased ? "phased-plan.html" : "plan.html";
const sourcePath = new URL(`./${sourceName}`, import.meta.url);
const outputPath = new URL(`./${outputName}`, import.meta.url);
const source = readFileSync(sourcePath, "utf8");

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function textOf(children) {
  return React.Children.toArray(children)
    .map((child) => typeof child === "string" ? child : child?.props ? textOf(child.props.children) : "")
    .join("");
}

const headings = [];
const heading = (level) => ({ children }) => {
  const text = textOf(children);
  const id = slug(text);
  if (level === 2) headings.push([text, id]);
  return React.createElement(`h${level}`, { id }, children);
};

const components = {
  h1: heading(1),
  h2: heading(2),
  h3: heading(3),
  a: ({ href, children }) => React.createElement("a", { href }, children),
};

let body = renderToStaticMarkup(
  React.createElement(ReactMarkdown, { remarkPlugins: [remarkGfm], components }, source),
);

const captureFlow = `
<figure class="flow" aria-labelledby="capture-flow-title">
  <figcaption id="capture-flow-title">Scout prompt context from live work to immutable archive</figcaption>
  <svg viewBox="0 0 1160 390" role="img" aria-label="Human prompts flow through session delivery into a durable scout episode journal and a harness transcript. Task intent, journal, transcript and visible session name meet in the scout collector, which freezes an archive capture job. The immutable manifest feeds the archive index, search and Scouts reader.">
    <defs><marker id="flow-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 10 5 0 10z"/></marker></defs>
    <g class="edges">
      <path d="M178 76H235"/><path d="M420 62H490"/><path d="M420 90H490"/>
      <path d="M175 260H490"/><path d="M662 205H730"/><path d="M905 205H970"/>
      <path d="M815 232V302"/><path d="M1055 232V302"/>
    </g>
    <g class="node human" transform="translate(20 48)"><rect width="158" height="58" rx="13"/><text x="79" y="26">Human prompt</text><text class="sub" x="79" y="44">during scout work</text></g>
    <g class="node" transform="translate(235 48)"><rect width="185" height="58" rx="13"/><text x="92" y="26">Session delivery</text><text class="sub" x="92" y="44">accepted turn boundary</text></g>
    <g class="node journal" transform="translate(490 18)"><rect width="190" height="58" rx="13"/><text x="95" y="26">Episode journal</text><text class="sub" x="95" y="44">durable authorship</text></g>
    <g class="node transcript" transform="translate(490 92)"><rect width="190" height="58" rx="13"/><text x="95" y="26">Harness transcript</text><text class="sub" x="95" y="44">normalized, paged</text></g>
    <g class="node human" transform="translate(20 232)"><rect width="155" height="58" rx="13"/><text x="77" y="26">Task intent</text><text class="sub" x="77" y="44">exact initial prompt</text></g>
    <g class="node collector" transform="translate(490 176)"><rect width="172" height="58" rx="13"/><text x="86" y="26">Scout collector</text><text class="sub" x="86" y="44">title + human prompts</text></g>
    <g class="node bundle" transform="translate(730 176)"><rect width="175" height="58" rx="13"/><text x="87" y="26">Capture job</text><text class="sub" x="87" y="44">frozen for recovery</text></g>
    <g class="node bundle" transform="translate(970 176)"><rect width="170" height="58" rx="13"/><text x="85" y="26">Manifest</text><text class="sub" x="85" y="44">immutable bundle</text></g>
    <g class="node final" transform="translate(720 302)"><rect width="190" height="58" rx="13"/><text x="95" y="26">Archive index</text><text class="sub" x="95" y="44">title + prompt search</text></g>
    <g class="node final" transform="translate(960 302)"><rect width="190" height="58" rx="13"/><text x="95" y="26">Scouts reader</text><text class="sub" x="95" y="44">report + prompt context</text></g>
    <text class="label" x="575" y="168">visible session name also enters here</text>
  </svg>
  <p>The report stays primary. The new path freezes only the concise title and attributed human prompts before the existing verified publication step.</p>
</figure>`;

const phaseFlow = `
<figure class="flow" aria-labelledby="phase-flow-title">
  <figcaption id="phase-flow-title">Merge-aware implementation sequence</figcaption>
  <svg viewBox="0 0 1120 280" role="img" aria-label="The merged planning artifacts release Phase 1 durable prompt context, which releases Phase 2 portable archive projection, which releases Phase 3 Scouts reader. Each phase also produces an independently useful green state.">
    <defs><marker id="flow-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 10 5 0 10z"/></marker></defs>
    <g class="edges"><path d="M220 112H290"/><path d="M530 112H600"/><path d="M840 112H910"/><path d="M410 145V218"/><path d="M720 145V218"/><path d="M1010 145V218"/></g>
    <g class="node planning" transform="translate(20 78)"><rect width="200" height="68" rx="14"/><text x="100" y="30">Planning artifacts</text><text class="sub" x="100" y="51">must merge before tasks</text></g>
    <g class="node" transform="translate(290 78)"><rect width="240" height="68" rx="14"/><text x="120" y="28">Phase 1</text><text class="sub" x="120" y="48">durable prompt context</text></g>
    <g class="node" transform="translate(600 78)"><rect width="240" height="68" rx="14"/><text x="120" y="28">Phase 2</text><text class="sub" x="120" y="48">portable archive projection</text></g>
    <g class="node final" transform="translate(910 78)"><rect width="200" height="68" rx="14"/><text x="100" y="28">Phase 3</text><text class="sub" x="100" y="48">prompt context reader</text></g>
    <g class="state" transform="translate(305 218)"><rect width="210" height="42" rx="10"/><text x="105" y="26">restart-safe attribution</text></g>
    <g class="state" transform="translate(615 218)"><rect width="210" height="42" rx="10"/><text x="105" y="26">short title + search</text></g>
    <g class="state" transform="translate(905 218)"><rect width="210" height="42" rx="10"/><text x="105" y="26">complete reader UX</text></g>
  </svg>
  <p>The graph is serial because every later merge consumes a reviewed contract from the prior one. Numbering reflects direct implementation dependencies.</p>
</figure>`;

const diagrams = [phased ? phaseFlow : captureFlow];
const mermaid = /<pre><code class="language-mermaid">[\s\S]*?<\/code><\/pre>/g;
const blocks = body.match(mermaid) ?? [];
if (blocks.length !== diagrams.length) {
  throw new Error(`${sourceName} has ${blocks.length} Mermaid blocks, renderer has ${diagrams.length} SVGs`);
}
let diagram = 0;
body = body.replace(mermaid, () => diagrams[diagram++]);

const title = phased
  ? "Short scout titles and prompt context: phased plan"
  : "Short scout titles with preserved prompt context";
const kicker = phased ? "Mission Control · merge-aware implementation" : "Mission Control · product and engineering plan";
const summary = phased
  ? "Three serial merge units: durable authorship, portable archive projection, then the reader that exposes it."
  : "Keep the model-generated session name as the scout title while preserving the original request and later human prompts as bounded, searchable archive context.";

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>${title}</title>
  <style>
    :root{color-scheme:light dark;--bg:#f3f5f4;--paper:#fff;--paper2:#f7f9f8;--ink:#18221f;--muted:#61706b;--line:#dce4e0;--accent:#17785c;--blue:#2e6fbb;--amber:#b36d12;--code:#edf4f1;--shadow:0 18px 50px rgba(21,38,32,.09);--sans:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
    @media(prefers-color-scheme:dark){:root{--bg:#0b0f0e;--paper:#141b18;--paper2:#101613;--ink:#e5eee9;--muted:#95a69f;--line:#293730;--accent:#43c59a;--blue:#65a8f5;--amber:#f2aa4c;--code:#19241f;--shadow:0 20px 58px rgba(0,0,0,.34)}}
    *{box-sizing:border-box}html{scroll-behavior:smooth;background:var(--bg)}body{margin:0;min-width:0;background:radial-gradient(900px 500px at 90% -12%,color-mix(in srgb,var(--accent) 13%,transparent),transparent 62%),var(--bg);color:var(--ink);font:15px/1.68 var(--sans)}a{color:var(--blue);text-underline-offset:3px}.mast{border-bottom:1px solid var(--line);background:color-mix(in srgb,var(--paper) 90%,transparent)}.mast-inner{max-width:1320px;margin:auto;padding:40px clamp(20px,5vw,64px) 34px}.kicker{margin:0 0 8px;color:var(--accent);font:800 11px/1.2 var(--mono);letter-spacing:.14em;text-transform:uppercase}.mast h1{max-width:900px;margin:0;font-size:clamp(34px,5vw,58px);line-height:1.06;letter-spacing:-.04em}.mast-copy{max-width:880px;margin:15px 0 0;color:var(--muted);font-size:17px}.badges{display:flex;flex-wrap:wrap;gap:7px;margin-top:20px}.badge{padding:5px 10px;border:1px solid color-mix(in srgb,var(--accent) 38%,var(--line));border-radius:999px;background:color-mix(in srgb,var(--accent) 7%,var(--paper));color:var(--accent);font:700 11px var(--mono)}.layout{display:grid;grid-template-columns:230px minmax(0,930px);gap:32px;max-width:1240px;margin:auto;padding:30px 18px 90px}nav{position:sticky;top:18px;align-self:start;max-height:calc(100vh - 36px);overflow:auto;padding:14px;border:1px solid var(--line);border-radius:13px;background:var(--paper);box-shadow:var(--shadow)}nav b{display:block;margin:0 0 8px;color:var(--muted);font:800 10px var(--mono);letter-spacing:.12em;text-transform:uppercase}nav a{display:block;padding:6px 8px;border-radius:7px;color:var(--muted);text-decoration:none;font-size:12px}nav a:hover{color:var(--ink);background:var(--paper2)}article{min-width:0;padding:10px clamp(18px,4vw,50px) 58px;border:1px solid var(--line);border-radius:17px;background:var(--paper);box-shadow:var(--shadow)}article>h1:first-child{display:none}h2{margin:46px 0 13px;padding-top:7px;border-top:1px solid var(--line);font-size:24px;line-height:1.25;letter-spacing:-.02em}h2:first-of-type{margin-top:22px;border-top:0}h3{margin:29px 0 9px;font-size:18px;line-height:1.35}p{margin:8px 0 14px}ul,ol{padding-left:24px}li{margin:5px 0}code{padding:2px 5px;border:1px solid var(--line);border-radius:5px;background:var(--code);color:var(--accent);font:12.5px/1.45 var(--mono);overflow-wrap:anywhere}pre{max-width:100%;overflow:auto;margin:17px 0;padding:15px 17px;border:1px solid var(--line);border-radius:11px;background:var(--paper2)}pre code{padding:0;border:0;background:none;color:var(--ink);white-space:pre}table{display:block;width:100%;max-width:100%;overflow-x:auto;margin:18px 0;border-collapse:collapse;font-size:13px}th,td{padding:9px 11px;border:1px solid var(--line);text-align:left;vertical-align:top}th{background:var(--paper2);font-size:11px}.flow{max-width:100%;margin:22px 0;padding:16px;overflow-x:auto;border:1px solid var(--line);border-radius:14px;background:var(--paper2)}.flow figcaption{margin-bottom:12px;font-weight:760}.flow svg{display:block;width:100%;height:auto;min-width:760px}.flow p{margin:11px 3px 0;color:var(--muted);font-size:12px}.flow .edges path{fill:none;stroke:var(--muted);stroke-width:1.7;marker-end:url(#flow-arrow)}.flow .node rect{fill:var(--paper);stroke:var(--line);stroke-width:1.5}.flow .node.human rect,.flow .node.planning rect{fill:color-mix(in srgb,var(--blue) 8%,var(--paper));stroke:var(--blue)}.flow .node.journal rect,.flow .node.collector rect{fill:color-mix(in srgb,var(--amber) 8%,var(--paper));stroke:var(--amber)}.flow .node.bundle rect,.flow .node.final rect{fill:color-mix(in srgb,var(--accent) 8%,var(--paper));stroke:var(--accent)}.flow .state rect{fill:var(--paper);stroke:var(--accent);stroke-dasharray:4 4}.flow text{fill:var(--ink);font:650 13px var(--sans);text-anchor:middle}.flow text.sub{fill:var(--muted);font-size:10px;font-weight:480}.flow text.label{fill:var(--muted);font:500 9px var(--mono)}footer{max-width:1240px;margin:0 auto 34px;padding:0 18px;color:var(--muted);font:11px var(--mono)}
    @media(max-width:860px){.layout{grid-template-columns:1fr}.layout nav{position:static;display:flex;gap:4px;max-height:none;overflow-x:auto}.layout nav b{display:none}.layout nav a{white-space:nowrap}article{padding-inline:20px}}@media(max-width:560px){.mast-inner{padding-top:28px}.layout{padding-inline:8px}article{border-radius:13px}th,td{min-width:130px}}@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}@media print{body{background:#fff}.mast,article,nav{box-shadow:none}.layout{display:block;max-width:none}.layout nav,footer{display:none}article{border:0}.flow svg{min-width:0}}
  </style>
</head>
<body>
  <header class="mast"><div class="mast-inner"><p class="kicker">${kicker}</p><h1>${title}</h1><p class="mast-copy">${summary}</p><div class="badges"><span class="badge">ai-harness only</span><span class="badge">${phased ? "3 serial phases" : "additive archive v1"}</span><span class="badge">offline render</span></div></div></header>
  <div class="layout"><nav aria-label="Plan sections"><b>On this page</b>${headings.map(([label, id]) => `<a href="#${id}">${label}</a>`).join("")}</nav><article>${body}</article></div>
  <footer>Source of truth: ${sourceName} · static HTML · no external requests</footer>
</body>
</html>`;

if (check) {
  const existing = readFileSync(outputPath, "utf8");
  if (existing !== html) throw new Error(`${outputName} is stale; rerun render-plan.mjs`);
  console.log(`${outputName} is current`);
} else {
  writeFileSync(outputPath, html);
}
