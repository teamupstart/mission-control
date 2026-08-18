// Usage:
//   node render-plan.mjs [phased] [--check]
//
// plan.md is authoritative. This renderer creates a self-contained offline review page and
// refuses to silently drop the request-flow diagram declared by the plan.
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
  const label = textOf(children);
  const id = slug(label);
  if (level === 2) headings.push([label, id]);
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

const requestFlow = `
<figure class="flow" aria-labelledby="request-flow-title">
  <figcaption id="request-flow-title">Public product report request flow</figcaption>
  <svg viewBox="0 0 1180 390" role="img" aria-label="A human can report through the Feedback modal, or explicitly ask an agent to report through Mission MCP. Both paths meet at the Mission Control daemon, which derives the safe body and fixed labels. The daemon uses the user's GitHub CLI to create a public issue, then the existing GitHub Issues task source can sweep it into the backlog for evaluation.">
    <defs><marker id="flow-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 10 5 0 10z"/></marker></defs>
    <g class="edges">
      <path d="M170 85H245"/><path d="M430 85H515"/>
      <path d="M170 250H245"/><path d="M430 250H515"/>
      <path d="M700 168H780"/><path d="M965 168H1030"/>
      <path d="M1095 200V304H965"/>
    </g>
    <g class="node human" transform="translate(20 55)"><rect width="150" height="60" rx="13"/><text x="75" y="27">Human</text><text class="sub" x="75" y="45">reviews public content</text></g>
    <g class="node ui" transform="translate(245 55)"><rect width="185" height="60" rx="13"/><text x="92" y="27">Feedback modal</text><text class="sub" x="92" y="45">five-type report draft</text></g>
    <g class="node human" transform="translate(20 220)"><rect width="150" height="60" rx="13"/><text x="75" y="27">Human</text><text class="sub" x="75" y="45">explicit report request</text></g>
    <g class="node agent" transform="translate(245 220)"><rect width="185" height="60" rx="13"/><text x="92" y="27">Agent + Mission MCP</text><text class="sub" x="92" y="45">bounded report input</text></g>
    <g class="node service" transform="translate(515 135)"><rect width="185" height="66" rx="13"/><text x="92" y="28">Daemon service</text><text class="sub" x="92" y="48">safe body + fixed labels</text></g>
    <g class="node cli" transform="translate(780 135)"><rect width="185" height="66" rx="13"/><text x="92" y="28">User's gh CLI</text><text class="sub" x="92" y="48">existing authentication</text></g>
    <g class="node public" transform="translate(1030 135)"><rect width="130" height="66" rx="13"/><text x="65" y="28">Public repo</text><text class="sub" x="65" y="48">new GitHub issue</text></g>
    <g class="node source" transform="translate(770 304)"><rect width="195" height="60" rx="13"/><text x="97" y="27">GitHub task source</text><text class="sub" x="97" y="45">triage sweep into backlog</text></g>
  </svg>
  <p>The dashboard and agent entry points share one contract and one daemon-owned GitHub writer. Task ingestion remains a separate, existing operator-controlled path.</p>
</figure>`;

const monitorFlow = `
<figure class="flow" aria-labelledby="monitor-flow-title">
  <figcaption id="monitor-flow-title">GitHub CLI attachment release monitor</figcaption>
  <svg viewBox="0 0 1180 410" role="img" aria-label="A recurring mission files a low-priority release checker task. The checker verifies the upstream issue, stable GitHub CLI release, official help, and merged plan. If support is unavailable it finishes and leaves the mission enabled. If support is available it creates one follow-up task and pauses the mission. The follow-up adapts and enables image attachments, merges its pull request, then archives the mission.">
    <defs><marker id="monitor-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 10 5 0 10z"/></marker></defs>
    <g class="monitor-edges">
      <path d="M205 100H280"/><path d="M485 100H565"/>
      <path d="M665 130V205H385V265"/><path d="M765 100H845"/>
      <path d="M945 130V205H735V265"/><path d="M945 130V265"/>
      <path d="M845 295H760"/><path d="M1045 295V358H205"/>
    </g>
    <g class="node service" transform="translate(20 67)"><rect width="185" height="66" rx="13"/><text x="92" y="28">Recurring mission</text><text class="sub" x="92" y="48">selected cadence</text></g>
    <g class="node agent" transform="translate(280 67)"><rect width="205" height="66" rx="13"/><text x="102" y="28">Release checker task</text><text class="sub" x="102" y="48">low priority, skip active</text></g>
    <g class="node public" transform="translate(565 67)"><rect width="200" height="66" rx="13"/><text x="100" y="27">GitHub primary sources</text><text class="sub" x="100" y="47">issue + stable gh + help</text></g>
    <g class="node muted" transform="translate(280 265)"><rect width="210" height="62" rx="13"/><text x="105" y="27">Not released</text><text class="sub" x="105" y="46">finish; mission stays enabled</text></g>
    <g class="node ui" transform="translate(845 67)"><rect width="200" height="66" rx="13"/><text x="100" y="27">Contract verified</text><text class="sub" x="100" y="47">one deterministic follow-up</text></g>
    <g class="node service" transform="translate(635 265)"><rect width="210" height="62" rx="13"/><text x="105" y="27">Pause mission</text><text class="sub" x="105" y="46">prevent another occurrence</text></g>
    <g class="node agent" transform="translate(945 265)"><rect width="210" height="62" rx="13"/><text x="105" y="27">Enablement follow-up</text><text class="sub" x="105" y="46">adapt, enable, test, merge</text></g>
    <g class="node final" transform="translate(20 350)"><rect width="185" height="48" rx="12"/><text x="92" y="29">Archive mission</text></g>
  </svg>
  <p>The mission remains enabled only while upstream support is unavailable. Verification pauses it before implementation, and the merged follow-up archives it while retaining its audit history.</p>
</figure>`;

const phaseFlow = `
<figure class="flow" aria-labelledby="phase-flow-title">
  <figcaption id="phase-flow-title">Merge-aware implementation and release follow-up</figcaption>
  <svg viewBox="0 0 1180 390" role="img" aria-label="The merged planning artifacts release Phase 1, the reporting core and confirmed agent path. Phase 1 releases Phase 2, the dashboard Feedback surface. Separately, the merged planning artifacts allow a weekly upstream monitor. Only after stable GitHub CLI support and the completed initial feature does that monitor release the future image attachment enablement task.">
    <defs><marker id="phase-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 10 5 0 10z"/></marker></defs>
    <g class="phase-edges">
      <path d="M225 105H310"/><path d="M540 105H625"/>
      <path d="M120 138V285H310"/><path d="M540 285H625"/>
      <path d="M760 138V240"/><path d="M840 105H1040V240"/>
    </g>
    <g class="node planning" transform="translate(20 70)"><rect width="205" height="70" rx="14"/><text x="102" y="30">Planning artifacts</text><text class="sub" x="102" y="51">approved and merged</text></g>
    <g class="node agent" transform="translate(310 70)"><rect width="230" height="70" rx="14"/><text x="115" y="29">Phase 1</text><text class="sub" x="115" y="49">core + confirmed agent path</text></g>
    <g class="node ui" transform="translate(625 70)"><rect width="215" height="70" rx="14"/><text x="107" y="29">Phase 2</text><text class="sub" x="107" y="49">dashboard Feedback surface</text></g>
    <g class="node service" transform="translate(310 250)"><rect width="230" height="70" rx="14"/><text x="115" y="29">Weekly monitor</text><text class="sub" x="115" y="49">issue + stable gh + help</text></g>
    <g class="node final" transform="translate(625 250)"><rect width="270" height="70" rx="14"/><text x="135" y="29">Future enablement task</text><text class="sub" x="135" y="49">adapt, enable, verify, archive</text></g>
    <text class="edge-label" x="930" y="94">initial feature complete</text>
  </svg>
  <p>The two implementation phases are serial because the dashboard consumes the merged reporting contract. The release monitor is operational and cannot enable images until both the stable upstream CLI and the completed initial feature exist.</p>
</figure>`;

const mermaid = /<pre><code class="language-mermaid">[\s\S]*?<\/code><\/pre>/g;
const blocks = body.match(mermaid) ?? [];
const diagrams = phased ? [phaseFlow] : [requestFlow, monitorFlow];
if (blocks.length !== diagrams.length) {
  throw new Error(`${sourceName} has ${blocks.length} Mermaid blocks; renderer expects ${diagrams.length}`);
}
let diagram = 0;
body = body.replace(mermaid, () => diagrams[diagram++]);

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>${phased ? "Public product issue reporting phased plan" : "Public product issue reporting plan"}</title>
  <style>
    :root{color-scheme:light dark;--bg:#eef2f0;--paper:#fff;--paper2:#f6f8f7;--ink:#18211e;--muted:#627069;--line:#d8e0dc;--green:#18765b;--blue:#276eae;--purple:#7157a8;--amber:#a7660f;--code:#edf4f1;--shadow:0 18px 48px rgba(24,44,36,.10);--sans:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
    @media(prefers-color-scheme:dark){:root{--bg:#0b0f0e;--paper:#141b18;--paper2:#101613;--ink:#e5eee9;--muted:#97a79f;--line:#293730;--green:#48c99d;--blue:#69adf3;--purple:#b7a0eb;--amber:#efa74b;--code:#19241f;--shadow:0 20px 58px rgba(0,0,0,.35)}}
    *{box-sizing:border-box}html{scroll-behavior:smooth;background:var(--bg)}body{margin:0;min-width:0;background:radial-gradient(950px 520px at 90% -12%,color-mix(in srgb,var(--green) 14%,transparent),transparent 62%),var(--bg);color:var(--ink);font:15px/1.68 var(--sans)}a{color:var(--blue);text-underline-offset:3px}.mast{border-bottom:1px solid var(--line);background:color-mix(in srgb,var(--paper) 91%,transparent)}.mast-inner{max-width:1320px;margin:auto;padding:40px clamp(20px,5vw,64px) 34px}.kicker{margin:0 0 8px;color:var(--green);font:800 11px/1.2 var(--mono);letter-spacing:.14em;text-transform:uppercase}.mast h1{max-width:920px;margin:0;font-size:clamp(35px,5vw,58px);line-height:1.06;letter-spacing:-.04em}.mast-copy{max-width:900px;margin:15px 0 0;color:var(--muted);font-size:17px}.badges{display:flex;flex-wrap:wrap;gap:7px;margin-top:20px}.badge{padding:5px 10px;border:1px solid color-mix(in srgb,var(--green) 38%,var(--line));border-radius:999px;background:color-mix(in srgb,var(--green) 7%,var(--paper));color:var(--green);font:700 11px var(--mono)}.layout{display:grid;grid-template-columns:235px minmax(0,940px);gap:32px;max-width:1250px;margin:auto;padding:30px 18px 90px}nav{position:sticky;top:18px;align-self:start;max-height:calc(100vh - 36px);overflow:auto;padding:14px;border:1px solid var(--line);border-radius:13px;background:var(--paper);box-shadow:var(--shadow)}nav b{display:block;margin:0 0 8px;color:var(--muted);font:800 10px var(--mono);letter-spacing:.12em;text-transform:uppercase}nav a{display:block;padding:6px 8px;border-radius:7px;color:var(--muted);text-decoration:none;font-size:12px}nav a:hover{color:var(--ink);background:var(--paper2)}article{min-width:0;padding:10px clamp(18px,4vw,50px) 58px;border:1px solid var(--line);border-radius:17px;background:var(--paper);box-shadow:var(--shadow)}article>h1:first-child{display:none}h2{margin:46px 0 13px;padding-top:7px;border-top:1px solid var(--line);font-size:24px;line-height:1.25;letter-spacing:-.02em}h2:first-of-type{margin-top:22px;border-top:0}h3{margin:29px 0 9px;font-size:18px;line-height:1.35}p{margin:8px 0 14px}ul,ol{padding-left:24px}li{margin:5px 0}code{padding:2px 5px;border:1px solid var(--line);border-radius:5px;background:var(--code);color:var(--green);font:12.5px/1.45 var(--mono);overflow-wrap:anywhere}pre{max-width:100%;overflow:auto;margin:17px 0;padding:15px 17px;border:1px solid var(--line);border-radius:11px;background:var(--paper2)}pre code{padding:0;border:0;background:none;color:var(--ink);white-space:pre}table{display:block;width:100%;max-width:100%;overflow-x:auto;margin:18px 0;border-collapse:collapse;font-size:13px}th,td{padding:9px 11px;border:1px solid var(--line);text-align:left;vertical-align:top}th{background:var(--paper2);font-size:11px}.flow{max-width:100%;margin:22px 0;padding:16px;overflow-x:auto;border:1px solid var(--line);border-radius:14px;background:var(--paper2)}.flow figcaption{margin-bottom:12px;font-weight:760}.flow svg{display:block;width:100%;height:auto;min-width:760px}.flow p{margin:11px 3px 0;color:var(--muted);font-size:12px}.flow .edges path{fill:none;stroke:var(--muted);stroke-width:1.8;marker-end:url(#flow-arrow)}.flow .monitor-edges path{fill:none;stroke:var(--muted);stroke-width:1.8;marker-end:url(#monitor-arrow)}.flow .phase-edges path{fill:none;stroke:var(--muted);stroke-width:1.8;marker-end:url(#phase-arrow)}.flow .node rect{fill:var(--paper);stroke:var(--line);stroke-width:1.5}.flow .human rect,.flow .planning rect{fill:color-mix(in srgb,var(--blue) 8%,var(--paper));stroke:var(--blue)}.flow .ui rect{fill:color-mix(in srgb,var(--green) 8%,var(--paper));stroke:var(--green)}.flow .agent rect{fill:color-mix(in srgb,var(--purple) 8%,var(--paper));stroke:var(--purple)}.flow .service rect,.flow .source rect{fill:color-mix(in srgb,var(--amber) 8%,var(--paper));stroke:var(--amber)}.flow .cli rect,.flow .public rect,.flow .final rect{fill:color-mix(in srgb,var(--green) 8%,var(--paper));stroke:var(--green)}.flow .muted rect{fill:var(--paper);stroke:var(--muted);stroke-dasharray:4 4}.flow text{fill:var(--ink);font:650 13px var(--sans);text-anchor:middle}.flow text.sub{fill:var(--muted);font-size:10px;font-weight:480}.flow text.edge-label{fill:var(--muted);font:500 10px var(--mono)}footer{max-width:1250px;margin:0 auto 34px;padding:0 18px;color:var(--muted);font:11px var(--mono)}
    @media(max-width:860px){.layout{grid-template-columns:1fr}.layout nav{position:static;display:flex;gap:4px;max-height:none;overflow-x:auto}.layout nav b{display:none}.layout nav a{white-space:nowrap}article{padding-inline:20px}}@media(max-width:560px){.mast-inner{padding-top:28px}.layout{padding-inline:8px}article{border-radius:13px}th,td{min-width:130px}}@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}@media print{body{background:#fff}.mast,article,nav{box-shadow:none}.layout{display:block;max-width:none}.layout nav,footer{display:none}article{border:0}.flow svg{min-width:0}}
  </style>
</head>
<body>
  <header class="mast"><div class="mast-inner"><p class="kicker">Mission Control · ${phased ? "merge-aware implementation" : "product and engineering plan"}</p><h1>${phased ? "Public product issue reporting: phased implementation" : "Public product issue reporting"}</h1><p class="mast-copy">${phased ? "Two serial merge units deliver the confirmed agent path first and the direct dashboard surface second, while a separate weekly monitor waits for stable CLI image support." : "One safe CLI reporting contract for the dashboard and user-authorized agents, with image support built behind a hard gate and a self-cleaning release monitor."}</p><div class="badges"><span class="badge">five report types</span><span class="badge">${phased ? "2 serial phases" : "dashboard + MCP"}</span><span class="badge">CLI-only v1</span><span class="badge">attachment gate off</span><span class="badge">release monitor</span></div></div></header>
  <div class="layout"><nav aria-label="Plan sections"><b>On this page</b>${headings.map(([label, id]) => `<a href="#${id}">${label}</a>`).join("")}</nav><article>${body}</article></div>
  <footer>Source of truth: ${sourceName} · static HTML · no external requests</footer>
</body>
</html>`;

if (check) {
  const existing = readFileSync(outputPath, "utf8");
  if (existing !== html) throw new Error(`${outputName} is stale; rerun render-plan.mjs ${phased ? "phased" : ""}`.trim());
  console.log(`${outputName} is current`);
} else {
  writeFileSync(outputPath, html);
}
