import { readFileSync, writeFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const sourcePath = new URL("./plan.md", import.meta.url);
const outputPath = new URL("./plan.html", import.meta.url);
const source = readFileSync(sourcePath, "utf8");

function slug(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function textOf(children) {
  return React.Children.toArray(children)
    .map((child) => (typeof child === "string" ? child : child?.props ? textOf(child.props.children) : ""))
    .join("");
}

const components = {
  h1: ({ children }) => React.createElement("h1", { id: slug(textOf(children)) }, children),
  h2: ({ children }) => React.createElement("h2", { id: slug(textOf(children)) }, children),
  h3: ({ children }) => React.createElement("h3", { id: slug(textOf(children)) }, children),
  a: ({ href, children }) =>
    React.createElement("a", { href, target: href?.startsWith("http") ? "_blank" : undefined, rel: href?.startsWith("http") ? "noreferrer" : undefined }, children),
};

let body = renderToStaticMarkup(
  React.createElement(ReactMarkdown, { remarkPlugins: [remarkGfm], components }, source),
);

const flow = `
<figure class="flow" aria-labelledby="flow-title">
  <figcaption id="flow-title">Scheduled mission data and request flow</figcaption>
  <svg viewBox="0 0 1180 440" role="img" aria-label="Scheduled Catalog sends validated mutations to daemon routes and SQLite. The schedule manager claims due occurrences and creates ordinary tasks through TaskManager. Registry and SSE update the UI. Foreman reads the backlog over HTTP and uses existing gates before dispatch.">
    <defs>
      <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 10 5 0 10z"/></marker>
      <linearGradient id="purple" x1="0" x2="1"><stop stop-color="#8b5cf6"/><stop offset="1" stop-color="#a371f7"/></linearGradient>
    </defs>
    <g class="edge">
      <path d="M210 110H315"/><path d="M475 110H570"/><path d="M650 150v60"/><path d="M570 260H470"/>
      <path d="M315 260H220"/><path d="M140 220v-70"/><path d="M650 310v58H780"/><path d="M895 330v-70"/>
      <path class="dashed" d="M980 110H845"/><path class="dashed" d="M980 390H915"/>
    </g>
    <g class="node primary" transform="translate(30 70)"><rect width="180" height="80" rx="14"/><text x="90" y="33">Scheduled Catalog</text><text class="sub" x="90" y="54">create · preview · history</text></g>
    <g class="node" transform="translate(315 70)"><rect width="160" height="80" rx="14"/><text x="80" y="33">Daemon routes</text><text class="sub" x="80" y="54">zod + parseBody</text></g>
    <g class="node db" transform="translate(570 70)"><rect width="160" height="80" rx="14"/><text x="80" y="31">SQLite</text><text class="sub" x="80" y="52">schedules · revisions</text><text class="sub" x="80" y="67">occurrences · tasks</text></g>
    <g class="node primary" transform="translate(570 210)"><rect width="160" height="100" rx="14"/><text x="80" y="34">Schedule manager</text><text class="sub" x="80" y="56">due → claim → recover</text><text class="sub" x="80" y="74">daemon only</text></g>
    <g class="node" transform="translate(315 220)"><rect width="155" height="80" rx="14"/><text x="77" y="33">TaskManager</text><text class="sub" x="77" y="54">ordinary backlog task</text></g>
    <g class="node" transform="translate(30 220)"><rect width="190" height="80" rx="14"/><text x="95" y="33">Registry + SSE</text><text class="sub" x="95" y="54">one live browser channel</text></g>
    <g class="node" transform="translate(780 290)"><rect width="135" height="80" rx="14"/><text x="67" y="33">Foreman</text><text class="sub" x="67" y="54">HTTP only · no DB</text></g>
    <g class="node" transform="translate(780 180)"><rect width="135" height="80" rx="14"/><text x="67" y="33">Agent session</text><text class="sub" x="67" y="54">existing safe dispatch</text></g>
    <g class="node optional" transform="translate(980 70)"><rect width="170" height="80" rx="14"/><text x="85" y="31">OS wake adapter</text><text class="sub" x="85" y="52">optional resume signal</text><text class="sub" x="85" y="67">catch-up stays fallback</text></g>
    <g class="node future" transform="translate(980 350)"><rect width="170" height="70" rx="14"/><text x="85" y="29">Always-on runner</text><text class="sub" x="85" y="50">future shared lease</text></g>
    <text class="label" x="232" y="100">validated mutation</text><text class="label" x="482" y="100">only writer</text>
    <text class="label" x="660" y="188">claim</text><text class="label" x="480" y="250">create</text>
    <text class="label" x="718" y="350">existing backlog API</text><text class="label" x="916" y="100">resume/start</text>
  </svg>
  <p>The scheduler’s authority ends at <code>TaskManager</code>. Foreman remains a separate, DB-free process and sees generated work only as ordinary backlog tasks.</p>
</figure>`;

body = body.replace(/<pre><code class="language-mermaid">[\s\S]*?<\/code><\/pre>/, flow);

const toc = [
  ["Outcome", "outcome"],
  ["Product contract", "product-contract"],
  ["UX", "ux"],
  ["Standby modes", "scheduling-and-standby-modes"],
  ["Shared contracts", "shared-contracts"],
  ["SQLite design", "sqlite-design"],
  ["Daemon lifecycle", "daemon-lifecycle"],
  ["HTTP and SSE", "http-and-sse"],
  ["Data flow", "data-and-request-flow"],
  ["Testing", "testing"],
  ["Acceptance", "acceptance-criteria"],
];

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>Recurring Missions: Scheduled Catalog · Detailed Plan</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg:#f4f5f8;--paper:#fff;--paper2:#f8f8fb;--ink:#20232a;--muted:#626b79;
      --line:#dde1e8;--accent:#7652cf;--accent2:#a371f7;--code:#f1eef9;
      --good:#15805c;--warn:#a76708;--bad:#bd3028;--shadow:0 14px 36px rgba(30,34,44,.08);
    }
    @media (prefers-color-scheme:dark) {
      :root {--bg:#0a0c0f;--paper:#14181e;--paper2:#0f1217;--ink:#e7ebf1;--muted:#9aa5b5;--line:#29313b;--accent:#a371f7;--accent2:#bb93ff;--code:#1d1927;--good:#35c08a;--warn:#f6a733;--bad:#f56a64;--shadow:0 14px 42px rgba(0,0,0,.28)}
    }
    *{box-sizing:border-box} html{scroll-behavior:smooth} body{margin:0;background:radial-gradient(900px 460px at 85% -10%,color-mix(in srgb,var(--accent) 13%,transparent),transparent 60%),var(--bg);color:var(--ink);font:15px/1.68 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    a{color:var(--accent);text-underline-offset:3px} a:hover{color:var(--accent2)}
    .mast{border-bottom:1px solid var(--line);background:color-mix(in srgb,var(--paper) 88%,transparent);backdrop-filter:blur(16px)}
    .mast-inner{max-width:1380px;margin:auto;padding:26px clamp(18px,4vw,54px)}
    .kicker{margin:0 0 6px;color:var(--accent);font-size:12px;font-weight:800;letter-spacing:1.2px;text-transform:uppercase}
    .mast h1{margin:0;font-size:clamp(27px,4vw,46px);line-height:1.12;letter-spacing:-1.2px}.mast p{max-width:820px;margin:10px 0 0;color:var(--muted)}
    .badges{display:flex;flex-wrap:wrap;gap:7px;margin-top:14px}.badge{padding:4px 9px;border:1px solid color-mix(in srgb,var(--accent) 38%,var(--line));border-radius:999px;color:var(--accent);background:color-mix(in srgb,var(--accent) 8%,var(--paper));font-size:11px}
    .layout{display:grid;grid-template-columns:220px minmax(0,920px);gap:34px;max-width:1220px;margin:0 auto;padding:28px 18px 90px}
    nav{position:sticky;top:18px;align-self:start;padding:14px;border:1px solid var(--line);border-radius:13px;background:var(--paper);box-shadow:var(--shadow)}
    nav b{display:block;margin:0 0 8px;color:var(--muted);font-size:10px;letter-spacing:1px;text-transform:uppercase}
    nav a{display:block;padding:5px 7px;border-radius:6px;color:var(--muted);text-decoration:none;font-size:12px}nav a:hover{color:var(--ink);background:var(--paper2)}
    article{min-width:0;padding:10px clamp(8px,3vw,36px) 50px;border:1px solid var(--line);border-radius:16px;background:var(--paper);box-shadow:var(--shadow)}
    article>h1:first-child{display:none} h2{margin:45px 0 12px;padding-top:5px;border-top:1px solid var(--line);font-size:23px;line-height:1.3;letter-spacing:-.3px}h2:first-of-type{margin-top:20px;border-top:0}h3{margin:28px 0 8px;font-size:17px;line-height:1.35}h4{margin:20px 0 6px}
    p{margin:8px 0 13px} strong{color:var(--ink)} ul,ol{padding-left:24px}li{margin:4px 0}
    code{padding:2px 5px;border-radius:5px;background:var(--code);color:var(--accent2);font:12.5px ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}
    pre{max-width:100%;overflow:auto;padding:14px 16px;border:1px solid var(--line);border-radius:10px;background:var(--paper2)}pre code{padding:0;background:none;color:var(--ink);white-space:pre}
    blockquote{margin:18px 0;padding:9px 15px;border-left:3px solid var(--accent);background:color-mix(in srgb,var(--accent) 6%,var(--paper));color:var(--muted)}
    table{display:block;width:100%;max-width:100%;overflow-x:auto;border-collapse:collapse;font-size:13px}th,td{padding:8px 10px;border:1px solid var(--line);text-align:left;vertical-align:top}th{background:var(--paper2)}
    hr{border:0;border-top:1px solid var(--line)}
    .flow{margin:22px 0;padding:16px;border:1px solid var(--line);border-radius:14px;background:var(--paper2);overflow:hidden}.flow figcaption{margin-bottom:12px;font-weight:750}.flow svg{display:block;width:100%;height:auto;min-width:720px}.flow{overflow-x:auto}.flow .edge path{fill:none;stroke:var(--muted);stroke-width:1.7;marker-end:url(#arrow)}.flow .edge .dashed{stroke-dasharray:7 6}.flow .node rect{fill:var(--paper);stroke:var(--line);stroke-width:1.5}.flow .node.primary rect{fill:color-mix(in srgb,var(--accent) 12%,var(--paper));stroke:var(--accent)}.flow .node.db rect{stroke:var(--good)}.flow .node.optional rect{stroke:var(--warn);stroke-dasharray:5 4}.flow .node.future rect{stroke:var(--muted);stroke-dasharray:5 4}.flow text{fill:var(--ink);font:600 13px system-ui;text-anchor:middle}.flow text.sub{fill:var(--muted);font-size:10px;font-weight:450}.flow text.label{fill:var(--muted);font-size:9px;font-weight:500}.flow p{margin:11px 3px 0;color:var(--muted);font-size:12px}
    .note{margin:16px 0;padding:12px 14px;border:1px solid color-mix(in srgb,var(--accent) 30%,var(--line));border-radius:10px;background:color-mix(in srgb,var(--accent) 7%,var(--paper))}
    @media(max-width:860px){.layout{grid-template-columns:1fr}.layout nav{position:static;display:flex;gap:4px;overflow-x:auto}.layout nav b{display:none}.layout nav a{white-space:nowrap}article{padding-inline:18px}}
    @media print{body{background:#fff}.mast,article,nav{box-shadow:none}.layout{display:block;max-width:none}.layout nav{display:none}article{border:0}.flow svg{min-width:0}}
  </style>
</head>
<body>
  <header class="mast"><div class="mast-inner"><p class="kicker">Mission Control · Detailed product & engineering plan</p><h1>Recurring Missions: Scheduled Catalog</h1><p>Durable recurring task templates with exact-once occurrence history, explicit standby guarantees, ordinary backlog creation, and unchanged Foreman safety boundaries.</p><div class="badges"><span class="badge">Approved</span><span class="badge">Local-first</span><span class="badge">SSE live state</span><span class="badge">SQLite exact-once ledger</span><span class="badge">Standby-aware</span></div></div></header>
  <div class="layout">
    <nav aria-label="Plan sections"><b>On this page</b>${toc.map(([label, id]) => `<a href="#${id}">${label}</a>`).join("")}</nav>
    <article>${body}</article>
  </div>
</body>
</html>`;

writeFileSync(outputPath, html);
