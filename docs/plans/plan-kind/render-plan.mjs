import { readFileSync, writeFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const isPhased = process.argv[2] === "phased";
const sourceName = isPhased ? "phased-plan.md" : "plan.md";
const outputName = isPhased ? "phased-plan.html" : "plan.html";
const sourcePath = new URL(`./${sourceName}`, import.meta.url);
const outputPath = new URL(`./${outputName}`, import.meta.url);
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
  a: ({ href, children }) => React.createElement(
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

const kindFlow = `
<figure class="flow" aria-labelledby="kind-flow-title">
  <figcaption id="kind-flow-title">What each task kind is delivered, and where its output lands</figcaption>
  <svg viewBox="0 0 1200 470" role="img" aria-label="Before, a dispatch forks on kind into ship, which receives the intent as written, and scout, which receives the intent plus a daemon-composed report contract and lands in the scout archive library. After, the same dispatch also forks into plan, which receives the intent plus a contract that invokes the html-plans skill, leading to a dashboard decision review and optionally to phased-plan scheduling backlog tasks. Scout and plan outputs both land in one kind-discriminated archive library.">
    <defs>
      <marker id="flow-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 10 5 0 10z"/></marker>
    </defs>
    <text class="band" x="24" y="26">BEFORE</text>
    <g class="edges">
      <path d="M174 74H214"/>
      <path d="M364 62V44H404"/><path d="M364 86V112H404"/>
      <path d="M604 112H664"/>
    </g>
    <g class="node" transform="translate(24 48)"><rect width="150" height="52" rx="12"/><text x="75" y="31">Dispatch</text></g>
    <g class="node verify" transform="translate(214 48)"><rect width="150" height="52" rx="12"/><text x="75" y="31">kind</text></g>
    <g class="node" transform="translate(404 18)"><rect width="200" height="52" rx="12"/><text x="100" y="24">ship</text><text class="sub" x="100" y="42">intent as written</text></g>
    <g class="node" transform="translate(404 86)"><rect width="200" height="52" rx="12"/><text x="100" y="24">scout</text><text class="sub" x="100" y="42">intent + report contract</text></g>
    <g class="node bundle" transform="translate(664 86)"><rect width="210" height="52" rx="12"/><text x="105" y="24">scout archive library</text><text class="sub" x="105" y="42">mission-control/scout-archive</text></g>
    <text class="band" x="24" y="206">AFTER</text>
    <g class="edges">
      <path d="M174 254H214"/>
      <path d="M364 242V224H404"/><path d="M364 262V292H404"/><path d="M364 272V372H404"/>
      <path d="M604 292H664"/>
      <path d="M604 372H664"/><path d="M874 372H904"/>
      <path d="M769 346V318H904"/>
    </g>
    <g class="node" transform="translate(24 228)"><rect width="150" height="52" rx="12"/><text x="75" y="31">Dispatch</text></g>
    <g class="node verify" transform="translate(214 228)"><rect width="150" height="52" rx="12"/><text x="75" y="31">kind</text></g>
    <g class="node" transform="translate(404 198)"><rect width="200" height="52" rx="12"/><text x="100" y="24">ship</text><text class="sub" x="100" y="42">intent as written</text></g>
    <g class="node" transform="translate(404 266)"><rect width="200" height="52" rx="12"/><text x="100" y="24">scout</text><text class="sub" x="100" y="42">intent + report contract</text></g>
    <g class="node manager" transform="translate(404 346)"><rect width="200" height="52" rx="12"/><text x="100" y="24">plan</text><text class="sub" x="100" y="42">intent + invokes html-plans</text></g>
    <g class="node manager" transform="translate(664 346)"><rect width="210" height="52" rx="12"/><text x="105" y="24">review + decide</text><text class="sub" x="105" y="42">request_plan_decisions</text></g>
    <g class="node done" transform="translate(904 346)"><rect width="272" height="52" rx="12"/><text x="136" y="24">phased-plan schedules tasks</text><text class="sub" x="136" y="42">one backlog task per phase</text></g>
    <g class="node bundle" transform="translate(904 266)"><rect width="272" height="52" rx="12"/><text x="136" y="24">archive library</text><text class="sub" x="136" y="42">kind-discriminated, renamed</text></g>
    <text class="label" x="640" y="286">scout</text><text class="label" x="800" y="310">plan</text>
  </svg>
  <p>The plan branch is the only new fork. Its contract invokes a skill rather than restating one, and its output shares the library the scout kind already established, which is what the rename makes honest.</p>
</figure>`;

const phasedFlow = `
<figure class="flow phases" aria-labelledby="phased-flow-title">
  <figcaption id="phased-flow-title">Merge-aware implementation and value flow</figcaption>
  <svg viewBox="0 0 1200 400" role="img" aria-label="The planning pull request releases Phase 1, the kind-agnostic archive library, and Phase 2, the plan task kind, which have no dependency on one another and may run concurrently. Phase 2 releases Phase 3, the plan delivery contract. Phase 1 and Phase 3 together release Phase 4, plan capture into the archive. Each phase leaves an independently operable result.">
    <defs>
      <marker id="flow-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 10 5 0 10z"/></marker>
    </defs>
    <g class="edges">
      <path d="M204 140V86H300"/><path d="M204 160V214H300"/>
      <path d="M540 214H620"/>
      <path d="M860 214V160H940"/>
      <path d="M540 86H700V140H940"/>
      <path d="M420 264V320"/><path d="M780 264V320"/><path d="M1078 266V320"/>
    </g>
    <g class="node" transform="translate(24 120)"><rect width="180" height="60" rx="14"/><text x="90" y="27">Planning PR</text><text class="sub" x="90" y="46">publishes phase paths</text></g>
    <g class="node manager" transform="translate(300 56)"><rect width="240" height="60" rx="14"/><text x="120" y="27">Phase 1</text><text class="sub" x="120" y="46">kind-agnostic archives</text></g>
    <g class="node manager" transform="translate(300 184)"><rect width="240" height="60" rx="14"/><text x="120" y="27">Phase 2</text><text class="sub" x="120" y="46">the plan kind</text></g>
    <g class="node verify" transform="translate(620 184)"><rect width="240" height="60" rx="14"/><text x="120" y="27">Phase 3</text><text class="sub" x="120" y="46">plan delivery contract</text></g>
    <g class="node bundle" transform="translate(940 130)"><rect width="236" height="60" rx="14"/><text x="118" y="27">Phase 4</text><text class="sub" x="118" y="46">plan capture</text></g>
    <g class="node" transform="translate(300 320)"><rect width="240" height="56" rx="14"/><text x="120" y="25">Scouts unchanged</text><text class="sub" x="120" y="44">renamed library, same behaviour</text></g>
    <g class="node" transform="translate(620 320)"><rect width="320" height="56" rx="14"/><text x="160" y="25">A plan task plans and phases</text><text class="sub" x="160" y="44">artifacts live in its pull request</text></g>
    <g class="node done" transform="translate(958 320)"><rect width="218" height="56" rx="14"/><text x="109" y="25">Plans outlive checkouts</text><text class="sub" x="109" y="44">archived at teardown</text></g>
    <text class="label" x="222" y="80">concurrent</text><text class="label" x="222" y="208">concurrent</text><text class="label" x="566" y="206">needs the kind</text><text class="label" x="880" y="150">needs both</text>
  </svg>
  <p>Phase 1 and Phase 2 share no decisions and may merge in either order. Phase 3 needs only the kind; Phase 4 is the single point that needs both lines. Every merge leaves a usable, testable repository.</p>
</figure>`;

const diagrams = isPhased
  ? [phasedFlow]
  : [kindFlow];

const mermaidBlock = /<pre><code class="language-mermaid">[\s\S]*?<\/code><\/pre>/g;
const mermaidBlocks = body.match(mermaidBlock) ?? [];
if (mermaidBlocks.length !== diagrams.length) {
  throw new Error(
    `${sourceName} contains ${mermaidBlocks.length} Mermaid blocks, but the renderer defines ` +
      `${diagrams.length} inline SVG diagrams`,
  );
}
let diagramIndex = 0;
body = body.replace(
  mermaidBlock,
  () => diagrams[diagramIndex++],
);

const toc = isPhased
  ? [
      ["Decisions", "incorporated-human-decisions"],
      ["Repository findings", "repository-findings-that-changed-the-route"],
      ["Phase map", "phase-map"],
      ["Dependency flow", "dependency-and-delivery-flow"],
      ["Contracts", "cross-phase-contracts"],
      ["Merge strategy", "merge-order-and-compatibility-strategy"],
      ["Verification", "final-verification-strategy"],
      ["Audit", "complete-cross-phase-audit"],
    ]
  : [
      ["Outcome", "outcome"],
      ["Current state", "what-the-repository-does-today"],
      ["Decisions", "incorporated-human-decisions"],
      ["The plan kind", "the-plan-kind"],
      ["Archive library", "the-kind-agnostic-archive-library"],
      ["Flow", "flow"],
      ["Non-goals", "non-goals"],
      ["Risks", "risks"],
      ["Verification", "verification"],
    ];

// The sidebar's ids must name headings the markdown actually has. Asserted rather than
// trusted, for the same reason the Mermaid count above is: both files are edited by hand and
// separately, so a renamed heading would otherwise ship a dead in-page link that renders
// perfectly and only fails when somebody clicks it. Deriving the list instead would silently
// change the sidebar whenever a heading was added, which is a different kind of wrong - the
// curated order is the point, so the check is that the curation is still true.
const renderedIds = new Set([...body.matchAll(/<h[1-3] id="([^"]+)"/g)].map((match) => match[1]));
const deadLinks = toc.filter(([, id]) => !renderedIds.has(id));
if (deadLinks.length > 0) {
  throw new Error(
    `${sourceName} has no heading for ${deadLinks.length} sidebar link(s): `
      + deadLinks.map(([label, id]) => `"${label}" -> #${id}`).join(", "),
  );
}

const page = isPhased
  ? {
      title: "The plan task kind phased plan",
      kicker: "Mission Control · merge-aware implementation plan",
      heading: "Ship the plan kind in four merges",
      copy: "Make the archive library kind-agnostic and add the plan kind on independent tracks, then give the kind its delivery contract, then make its artifacts durable.",
      tabs: ["Archives", "The kind", "Contract", "Capture"],
      path: "Phase 1 ∥ Phase 2 → Phase 3 → Phase 4",
    }
  : {
      title: "The plan task kind",
      kicker: "Mission Control · product and engineering plan",
      heading: "The plan task kind",
      copy: "Dispatch an agent that plans rather than ships or investigates: it renders a reviewable HTML plan, refines it with you, and then asks whether to phase it into dependency-linked backlog tasks.",
      tabs: ["plan.html", "Decisions", "Phased tasks"],
      path: "Kind: ship · scout · plan",
    };

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>${page.title}</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg:#f2f4f7;--paper:#fff;--paper2:#f7f8fa;--ink:#1c232d;--muted:#626d7c;
      --dim:#7b8593;--line:#dce1e7;--line2:#e9edf1;--blue:#2c73c8;--green:#16815d;
      --amber:#a66508;--red:#bd3933;--purple:#7252b9;--code:#eef2f6;
      --shadow:0 18px 54px rgba(28,35,45,.10);
      --sans:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
      --mono:ui-monospace,"SFMono-Regular",Menlo,Consolas,monospace;
    }
    @media (prefers-color-scheme:dark) {
      :root {
        --bg:#0a0c0f;--paper:#14181e;--paper2:#0f1318;--ink:#e7ebf1;--muted:#939eae;
        --dim:#7c8798;--line:#29313b;--line2:#202730;--blue:#4a9eff;--green:#35c08a;
        --amber:#f6a733;--red:#f85149;--purple:#a371f7;--code:#1a2028;
        --shadow:0 20px 58px rgba(0,0,0,.38);
      }
    }
    *{box-sizing:border-box}html{scroll-behavior:smooth;background:var(--bg)}
    body{margin:0;min-width:0;background:radial-gradient(900px 520px at 88% -12%,color-mix(in srgb,var(--blue) 11%,transparent),transparent 62%),var(--bg);color:var(--ink);font:15px/1.68 var(--sans)}
    a{color:var(--blue);text-underline-offset:3px}a:hover{color:color-mix(in srgb,var(--blue) 75%,var(--ink))}
    .mast{border-bottom:1px solid var(--line);background:color-mix(in srgb,var(--paper) 90%,transparent);backdrop-filter:blur(16px)}
    .mast-inner{max-width:1380px;margin:auto;padding:42px clamp(20px,5vw,66px) 35px}
    .kicker{margin:0 0 8px;color:var(--blue);font:800 11px/1.2 var(--mono);letter-spacing:.15em;text-transform:uppercase}
    .mast h1{max-width:850px;margin:0;font-size:clamp(35px,5.5vw,64px);line-height:1.06;letter-spacing:-.045em}
    .mast-copy{max-width:850px;margin:16px 0 0;color:var(--muted);font-size:17px}
    .evidence-tabs{display:flex;flex-wrap:wrap;gap:0;margin-top:24px}
    .evidence-tabs span{display:inline-flex;align-items:center;gap:8px;padding:7px 12px;border:1px solid var(--line);background:var(--paper2);color:var(--muted);font:700 11px/1 var(--mono)}
    .evidence-tabs span:first-child{border-radius:9px 0 0 9px}.evidence-tabs span:last-child{border-radius:0 9px 9px 0}.evidence-tabs span+span{border-left:0}
    .evidence-tabs i{width:7px;height:7px;border-radius:50%;background:var(--green);box-shadow:0 0 0 3px color-mix(in srgb,var(--green) 14%,transparent)}
    .path{margin-top:16px;color:var(--dim);font:12px/1.5 var(--mono)}
    .layout{display:grid;grid-template-columns:220px minmax(0,930px);gap:34px;max-width:1240px;margin:0 auto;padding:30px 18px 92px}
    nav{position:sticky;top:18px;align-self:start;max-height:calc(100vh - 36px);overflow:auto;padding:14px;border:1px solid var(--line);border-radius:13px;background:var(--paper);box-shadow:var(--shadow)}
    nav b{display:block;margin:0 0 9px;color:var(--dim);font:800 10px/1.2 var(--mono);letter-spacing:.12em;text-transform:uppercase}
    nav a{display:block;padding:6px 8px;border-radius:7px;color:var(--muted);text-decoration:none;font-size:12px}nav a:hover{color:var(--ink);background:var(--paper2)}
    article{min-width:0;padding:10px clamp(18px,4vw,54px) 60px;border:1px solid var(--line);border-radius:17px;background:var(--paper);box-shadow:var(--shadow)}
    article>h1:first-child{display:none}h2{margin:48px 0 13px;padding-top:7px;border-top:1px solid var(--line);font-size:25px;line-height:1.25;letter-spacing:-.025em}h2:first-of-type{margin-top:22px;border-top:0}
    h3{margin:30px 0 9px;font-size:18px;line-height:1.35;letter-spacing:-.012em}h4{margin:22px 0 7px}
    p{margin:8px 0 14px}ul,ol{padding-left:24px}li{margin:5px 0}strong{color:var(--ink)}
    code{padding:2px 5px;border:1px solid var(--line2);border-radius:5px;background:var(--code);color:var(--blue);font:12.5px/1.45 var(--mono);overflow-wrap:anywhere}
    pre{max-width:100%;overflow:auto;margin:17px 0;padding:15px 17px;border:1px solid var(--line);border-radius:11px;background:var(--paper2)}pre code{padding:0;border:0;background:none;color:var(--ink);white-space:pre}
    table{display:block;width:100%;max-width:100%;overflow-x:auto;margin:18px 0;border-collapse:collapse;font-size:13px}th,td{padding:9px 11px;border:1px solid var(--line);text-align:left;vertical-align:top}th{background:var(--paper2);font-size:11px}
    blockquote{margin:18px 0;padding:10px 16px;border-left:3px solid var(--blue);background:color-mix(in srgb,var(--blue) 6%,var(--paper));color:var(--muted)}
    #approved-decisions{margin-top:56px;padding:22px 24px;border:1px solid color-mix(in srgb,var(--green) 48%,var(--line));border-radius:14px;background:color-mix(in srgb,var(--green) 6%,var(--paper));color:var(--ink)}
    .flow{max-width:100%;margin:22px 0;padding:16px;overflow-x:auto;border:1px solid var(--line);border-radius:14px;background:var(--paper2)}
    .flow figcaption{margin-bottom:13px;font-weight:760}.flow svg{display:block;width:100%;height:auto;min-width:760px}.flow p{margin:12px 3px 1px;color:var(--muted);font-size:12px}
    .flow .edges path{fill:none;stroke:var(--dim);stroke-width:1.7;marker-end:url(#flow-arrow)}.deletion .edges path{marker-end:url(#delete-arrow)}.publication .edges path{marker-end:url(#publish-arrow)}.reconciliation .edges path{marker-end:url(#reconcile-arrow)}.deletion .edges .failure,.publication .edges .failure{stroke:var(--red)}
    .flow .node rect{fill:var(--paper);stroke:var(--line);stroke-width:1.5}.flow .node.manager rect{fill:color-mix(in srgb,var(--blue) 10%,var(--paper));stroke:var(--blue)}
    .flow .node.bundle rect,.flow .node.done rect{fill:color-mix(in srgb,var(--green) 8%,var(--paper));stroke:var(--green)}.flow .node.db rect{stroke:var(--purple)}.flow .node.verify rect{stroke:var(--amber)}.flow .node.retry rect{stroke:var(--red);stroke-dasharray:5 4}
    .flow text{fill:var(--ink);font:650 13px var(--sans);text-anchor:middle}.flow text.sub{fill:var(--muted);font-size:10px;font-weight:480}.flow text.label{fill:var(--dim);font:500 9px var(--mono)}
    .flow text.band{fill:var(--dim);font:800 10px var(--mono);letter-spacing:.14em;text-anchor:start}
    footer{display:flex;justify-content:space-between;gap:20px;max-width:1240px;margin:0 auto 36px;padding:0 18px;color:var(--dim);font:11px/1.5 var(--mono)}
    @media(max-width:880px){.layout{grid-template-columns:1fr}.layout nav{position:static;display:flex;gap:4px;max-height:none;overflow-x:auto}.layout nav b{display:none}.layout nav a{white-space:nowrap}article{padding-inline:20px}}
    @media(max-width:560px){.mast-inner{padding-top:30px}.evidence-tabs span{flex:1;justify-content:center}.layout{padding-inline:8px}article{border-radius:13px}.path{overflow-wrap:anywhere}th,td{min-width:130px}th:first-child,td:first-child{min-width:44px}}
    @media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
    @media print{body{background:#fff}.mast,article,nav{box-shadow:none}.layout{display:block;max-width:none}.layout nav{display:none}article{border:0}.flow svg{min-width:0}footer{display:none}}
  </style>
</head>
<body>
  <header class="mast">
    <div class="mast-inner">
      <p class="kicker">${page.kicker}</p>
      <h1>${page.heading}</h1>
      <p class="mast-copy">${page.copy}</p>
      <div class="evidence-tabs" aria-label="${isPhased ? "Implementation phases" : "Archive contents"}">${page.tabs.map((label) => `<span><i></i>${label}</span>`).join("")}</div>
      <p class="path">${page.path.replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</p>
    </div>
  </header>
  <div class="layout">
    <nav aria-label="Plan sections"><b>On this page</b>${toc.map(([label, id]) => `<a href="#${id}">${label}</a>`).join("")}</nav>
    <article>${body}</article>
  </div>
  <footer><span>Source of truth: ${sourceName}</span><span>Offline render · no external requests</span></footer>
</body>
</html>`;

writeFileSync(outputPath, html);
