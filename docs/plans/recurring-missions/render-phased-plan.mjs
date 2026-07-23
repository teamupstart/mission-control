import { readFileSync, writeFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const sourcePath = new URL("./phased-plan.md", import.meta.url);
const outputPath = new URL("./phased-plan.html", import.meta.url);
const source = readFileSync(sourcePath, "utf8");

function slug(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function textOf(children) {
  return React.Children.toArray(children)
    .map((child) =>
      typeof child === "string" ? child : child?.props ? textOf(child.props.children) : "",
    )
    .join("");
}

const components = {
  h1: ({ children }) => React.createElement("h1", { id: slug(textOf(children)) }, children),
  h2: ({ children }) => React.createElement("h2", { id: slug(textOf(children)) }, children),
  h3: ({ children }) => React.createElement("h3", { id: slug(textOf(children)) }, children),
  a: ({ href, children }) =>
    React.createElement(
      "a",
      {
        href,
        target: href?.startsWith("http") ? "_blank" : undefined,
        rel: href?.startsWith("http") ? "noreferrer" : undefined,
      },
      children,
    ),
};

let body = renderToStaticMarkup(
  React.createElement(ReactMarkdown, { remarkPlugins: [remarkGfm], components }, source),
);

const graph = `
<figure class="flow" aria-labelledby="phase-flow-title">
  <figcaption id="phase-flow-title">Merge and task dependency graph</figcaption>
  <svg viewBox="0 0 1120 255" role="img" aria-label="The planning session gates every task. Phase 1 durable foundation gates Phase 2 exact-once scheduler, which gates Phase 3 HTTP and SSE, which gates Phase 4 Scheduled Catalog UI.">
    <defs>
      <marker id="phase-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 10 5 0 10z"/></marker>
    </defs>
    <g class="edge primary-edge">
      <path d="M210 122H278"/><path d="M478 122H520"/><path d="M720 122H762"/><path d="M962 122H1010"/>
    </g>
    <g class="edge planning-edge">
      <path d="M120 84C180 22 335 27 378 83"/>
      <path d="M120 80C250 0 545 3 620 83"/>
      <path d="M120 76C330 -14 775 0 862 83"/>
    </g>
    <g class="node planning" transform="translate(20 82)"><rect width="190" height="80" rx="14"/><text x="95" y="31">Planning session</text><text class="sub" x="95" y="53">artifacts must merge first</text></g>
    <g class="node" transform="translate(278 82)"><rect width="200" height="80" rx="14"/><text x="100" y="29">Phase 1</text><text class="sub" x="100" y="49">Durable foundation</text><text class="sub" x="100" y="65">types · recurrence · SQLite</text></g>
    <g class="node" transform="translate(520 82)"><rect width="200" height="80" rx="14"/><text x="100" y="29">Phase 2</text><text class="sub" x="100" y="49">Exact-once scheduler</text><text class="sub" x="100" y="65">claim · recover · catch up</text></g>
    <g class="node" transform="translate(762 82)"><rect width="200" height="80" rx="14"/><text x="100" y="29">Phase 3</text><text class="sub" x="100" y="49">HTTP + live state</text><text class="sub" x="100" y="65">zod · Registry · SSE</text></g>
    <g class="node final" transform="translate(1010 82)"><rect width="100" height="80" rx="14"/><text x="50" y="29">Phase 4</text><text class="sub" x="50" y="49">Catalog UI</text><text class="sub" x="50" y="65">proof</text></g>
    <text class="label" x="244" y="111">merge</text><text class="label" x="499" y="111">merge</text><text class="label" x="741" y="111">merge</text><text class="label" x="985" y="111">merge</text>
    <text class="planning-label" x="560" y="20">Every scheduled task also carries a direct planning-session dependency</text>
  </svg>
  <p>The implementation is serial because each pull request consumes a contract owned by the previous one. Numbering reflects real merge prerequisites, not presentation alone.</p>
</figure>`;

body = body.replace(/<pre><code class="language-mermaid">[\s\S]*?<\/code><\/pre>/, graph);

const toc = [
  ["Approved requirements", "approved-requirements-carried-forward"],
  ["Investigation", "repository-investigation-and-resolved-discrepancies"],
  ["Phase graph", "phase-graph"],
  ["Concurrency", "concurrency-and-merge-order"],
  ["Cross-phase contracts", "cross-phase-contracts"],
  ["Verification", "final-verification-strategy"],
  ["Ownership audit", "requirement-ownership-audit"],
  ["Final audit", "final-cross-phase-audit"],
];

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>Recurring Missions · Phased Implementation Plan</title>
  <style>
    :root{color-scheme:light dark;--bg:#f4f5f8;--paper:#fff;--paper2:#f8f8fb;--ink:#20232a;--muted:#626b79;--line:#dde1e8;--accent:#7652cf;--accent2:#a371f7;--good:#15805c;--warn:#a76708;--code:#f1eef9;--shadow:0 14px 36px rgba(30,34,44,.08)}
    @media(prefers-color-scheme:dark){:root{--bg:#0a0c0f;--paper:#14181e;--paper2:#0f1217;--ink:#e7ebf1;--muted:#9aa5b5;--line:#29313b;--accent:#a371f7;--accent2:#bb93ff;--good:#35c08a;--warn:#f6a733;--code:#1d1927;--shadow:0 14px 42px rgba(0,0,0,.28)}}
    *{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:radial-gradient(900px 460px at 85% -10%,color-mix(in srgb,var(--accent) 13%,transparent),transparent 60%),var(--bg);color:var(--ink);font:15px/1.68 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    a{color:var(--accent);text-underline-offset:3px}a:hover{color:var(--accent2)}
    .mast{border-bottom:1px solid var(--line);background:color-mix(in srgb,var(--paper) 88%,transparent);backdrop-filter:blur(16px)}.mast-inner{max-width:1380px;margin:auto;padding:26px clamp(18px,4vw,54px)}.kicker{margin:0 0 6px;color:var(--accent);font-size:12px;font-weight:800;letter-spacing:1.2px;text-transform:uppercase}.mast h1{margin:0;font-size:clamp(27px,4vw,46px);line-height:1.12;letter-spacing:-1.2px}.mast p{max-width:860px;margin:10px 0 0;color:var(--muted)}.badges{display:flex;flex-wrap:wrap;gap:7px;margin-top:14px}.badge{padding:4px 9px;border:1px solid color-mix(in srgb,var(--accent) 38%,var(--line));border-radius:999px;color:var(--accent);background:color-mix(in srgb,var(--accent) 8%,var(--paper));font-size:11px}
    .layout{display:grid;grid-template-columns:220px minmax(0,980px);gap:34px;max-width:1280px;margin:0 auto;padding:28px 18px 90px}nav{position:sticky;top:18px;align-self:start;padding:14px;border:1px solid var(--line);border-radius:13px;background:var(--paper);box-shadow:var(--shadow)}nav b{display:block;margin:0 0 8px;color:var(--muted);font-size:10px;letter-spacing:1px;text-transform:uppercase}nav a{display:block;padding:5px 7px;border-radius:6px;color:var(--muted);text-decoration:none;font-size:12px}nav a:hover{color:var(--ink);background:var(--paper2)}
    article{min-width:0;padding:10px clamp(8px,3vw,36px) 50px;border:1px solid var(--line);border-radius:16px;background:var(--paper);box-shadow:var(--shadow)}article>h1:first-child{display:none}h2{margin:45px 0 12px;padding-top:5px;border-top:1px solid var(--line);font-size:23px;line-height:1.3;letter-spacing:-.3px}h2:first-of-type{margin-top:20px;border-top:0}h3{margin:28px 0 8px;font-size:17px;line-height:1.35}p{margin:8px 0 13px}ul,ol{padding-left:24px}li{margin:4px 0}code{padding:2px 5px;border-radius:5px;background:var(--code);color:var(--accent2);font:12.5px ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}pre{max-width:100%;overflow:auto;padding:14px 16px;border:1px solid var(--line);border-radius:10px;background:var(--paper2)}pre code{padding:0;background:none;color:var(--ink);white-space:pre}table{display:block;width:100%;max-width:100%;overflow-x:auto;border-collapse:collapse;font-size:13px}th,td{padding:8px 10px;border:1px solid var(--line);text-align:left;vertical-align:top}th{background:var(--paper2)}
    .flow{margin:22px 0;padding:16px;border:1px solid var(--line);border-radius:14px;background:var(--paper2);overflow-x:auto}.flow figcaption{margin-bottom:12px;font-weight:750}.flow svg{display:block;width:100%;height:auto;min-width:850px}.flow .edge path{fill:none;stroke:var(--muted);stroke-width:1.7;marker-end:url(#phase-arrow)}.flow .planning-edge path{stroke:var(--accent);stroke-width:1.2;stroke-dasharray:5 5}.flow .node rect{fill:var(--paper);stroke:var(--line);stroke-width:1.5}.flow .node.planning rect{fill:color-mix(in srgb,var(--accent) 11%,var(--paper));stroke:var(--accent)}.flow .node.final rect{stroke:var(--good)}.flow text{fill:var(--ink);font:650 13px system-ui;text-anchor:middle}.flow text.sub{fill:var(--muted);font-size:10px;font-weight:450}.flow text.label{fill:var(--muted);font-size:9px;font-weight:500}.flow text.planning-label{fill:var(--accent);font-size:10px;font-weight:650}.flow p{margin:11px 3px 0;color:var(--muted);font-size:12px}
    @media(max-width:860px){.layout{grid-template-columns:1fr}.layout nav{position:static;display:flex;gap:4px;overflow-x:auto}.layout nav b{display:none}.layout nav a{white-space:nowrap}article{padding-inline:18px}}@media print{body{background:#fff}.mast,article,nav{box-shadow:none}.layout{display:block;max-width:none}.layout nav{display:none}article{border:0}.flow svg{min-width:0}}
  </style>
</head>
<body>
  <header class="mast"><div class="mast-inner"><p class="kicker">Mission Control · Approved implementation sequence</p><h1>Recurring Missions: Scheduled Catalog</h1><p>Four reviewable merge units from durable recurrence and exact-once catch-up through the complete operational catalog, with every task gated on the planning artifacts.</p><div class="badges"><span class="badge">Approved</span><span class="badge">4 phases</span><span class="badge">Durable local catch-up</span><span class="badge">SSE live state</span><span class="badge">Serial merge graph</span></div></div></header>
  <div class="layout">
    <nav aria-label="Plan sections"><b>On this page</b>${toc.map(([label, id]) => `<a href="#${id}">${label}</a>`).join("")}</nav>
    <article>${body}</article>
  </div>
</body>
</html>`;

writeFileSync(outputPath, html);
