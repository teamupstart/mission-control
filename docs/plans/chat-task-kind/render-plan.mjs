// Usage:
//   node render-plan.mjs                   write plan.html from plan.md
//   node render-plan.mjs --phased          write phased-plan.html from phased-plan.md
//   node render-plan.mjs --check [--phased] fail if the selected HTML is not current
import { readFileSync, writeFileSync } from "node:fs";

const checkOnly = process.argv.includes("--check");
const phased = process.argv.includes("--phased");
const sourceName = phased ? "phased-plan.md" : "plan.md";
const outputName = phased ? "phased-plan.html" : "plan.html";
const sourcePath = new URL(`./${sourceName}`, import.meta.url);
const outputPath = new URL(`./${outputName}`, import.meta.url);
const source = readFileSync(sourcePath, "utf8");

function slug(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function inline(value) {
  const code = [];
  let rendered = escapeHtml(value).replace(/`([^`]+)`/g, (_match, text) => {
    const token = `@@CODE${code.length}@@`;
    code.push(`<code>${text}</code>`);
    return token;
  });
  rendered = rendered
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");
  return code.reduce((text, replacement, index) => text.replace(`@@CODE${index}@@`, replacement), rendered);
}

function table(lines, start) {
  const rows = [];
  let at = start;
  while (at < lines.length && /^\|.*\|\s*$/.test(lines[at])) {
    rows.push(lines[at].split("|").slice(1, -1).map((cell) => cell.trim()));
    at += 1;
  }
  const [head, separator, ...rest] = rows;
  if (!head || !separator || !separator.every((cell) => /^:?-{3,}:?$/.test(cell))) return null;
  return {
    at,
    html: `<table><thead><tr>${head.map((cell) => `<th>${inline(cell)}</th>`).join("")}</tr></thead>`
      + `<tbody>${rest.map((row) => `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table>`,
  };
}

function renderMarkdown(markdown) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let at = 0;
  while (at < lines.length) {
    const line = lines[at];
    if (!line.trim()) {
      at += 1;
      continue;
    }
    if (line.startsWith("```")) {
      const language = line.slice(3).trim();
      const block = [];
      at += 1;
      while (at < lines.length && !lines[at].startsWith("```")) block.push(lines[at++]);
      if (at < lines.length) at += 1;
      out.push(`<pre><code${language ? ` class="language-${escapeHtml(language)}"` : ""}>${escapeHtml(block.join("\n"))}</code></pre>`);
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const label = heading[2];
      out.push(`<h${level} id="${slug(label.replaceAll("`", ""))}">${inline(label)}</h${level}>`);
      at += 1;
      continue;
    }
    const maybeTable = table(lines, at);
    if (maybeTable) {
      out.push(maybeTable.html);
      at = maybeTable.at;
      continue;
    }
    const bullet = /^-\s+(.+)$/.exec(line);
    if (bullet) {
      const items = [];
      while (at < lines.length) {
        const match = /^-\s+(.+)$/.exec(lines[at]);
        if (!match) break;
        let item = match[1];
        at += 1;
        while (at < lines.length && /^\s{2,}\S/.test(lines[at]) && !/^\s*[-*]\s/.test(lines[at])) {
          item += ` ${lines[at].trim()}`;
          at += 1;
        }
        items.push(`<li>${inline(item)}</li>`);
      }
      out.push(`<ul>${items.join("")}</ul>`);
      continue;
    }
    const numbered = /^\d+\.\s+(.+)$/.exec(line);
    if (numbered) {
      const items = [];
      while (at < lines.length) {
        const match = /^\d+\.\s+(.+)$/.exec(lines[at]);
        if (!match) break;
        let item = match[1];
        at += 1;
        while (at < lines.length && /^\s{2,}\S/.test(lines[at]) && !/^\s*\d+\.\s/.test(lines[at])) {
          item += ` ${lines[at].trim()}`;
          at += 1;
        }
        items.push(`<li>${inline(item)}</li>`);
      }
      out.push(`<ol>${items.join("")}</ol>`);
      continue;
    }
    const paragraph = [line.trim()];
    at += 1;
    while (
      at < lines.length
      && lines[at].trim()
      && !/^(#{1,3})\s+/.test(lines[at])
      && !/^```/.test(lines[at])
      && !/^-\s+/.test(lines[at])
      && !/^\d+\.\s+/.test(lines[at])
      && !/^\|.*\|\s*$/.test(lines[at])
    ) {
      paragraph.push(lines[at].trim());
      at += 1;
    }
    out.push(`<p>${inline(paragraph.join(" "))}</p>`);
  }
  return out.join("\n");
}

let body = renderMarkdown(source);

const rootFlow = `
<figure class="flow" aria-labelledby="chat-flow-title">
  <figcaption id="chat-flow-title">How chat changes the dispatch and completion flow</figcaption>
  <svg viewBox="0 0 1120 430" role="img" aria-label="Before, a dispatch with intent starts an agent turn, then Foreman completion leads to a Workflow or pull request wrap-up. After, choosing chat launches an isolated conversation from an opening message. Without an explicit Workflow, idle returns to the conversation and the human completes and closes it. With an explicit Workflow, ordinary Foreman completion applies.">
    <defs>
      <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 10 5 0 10z"/></marker>
    </defs>
    <text class="band" x="24" y="28">BEFORE</text>
    <g class="edges">
      <path d="M198 78H252"/><path d="M442 78H496"/><path d="M686 78H740"/>
    </g>
    <g class="node" transform="translate(24 50)"><rect width="174" height="56" rx="12"/><text x="87" y="25">Dispatch</text><text class="sub" x="87" y="43">non-empty intent</text></g>
    <g class="node" transform="translate(252 50)"><rect width="190" height="56" rx="12"/><text x="95" y="25">Agent turn</text><text class="sub" x="95" y="43">task objective</text></g>
    <g class="node warn" transform="translate(496 50)"><rect width="190" height="56" rx="12"/><text x="95" y="25">Foreman completion</text><text class="sub" x="95" y="43">settled objective</text></g>
    <g class="node done" transform="translate(740 50)"><rect width="340" height="56" rx="12"/><text x="170" y="25">Workflow or PR wrap-up</text><text class="sub" x="170" y="43">artifact-oriented finish</text></g>

    <text class="band" x="24" y="190">AFTER</text>
    <g class="edges">
      <path d="M198 246H252"/><path d="M442 246H496"/><path d="M686 246H740"/>
      <path d="M835 218V172H591V218"/><path d="M930 246H968V328H910"/>
      <path d="M835 274V330H686"/>
    </g>
    <g class="node chat" transform="translate(24 218)"><rect width="174" height="56" rx="12"/><text x="87" y="25">Choose chat</text><text class="sub" x="87" y="43">After work: None</text></g>
    <g class="node" transform="translate(252 218)"><rect width="190" height="56" rx="12"/><text x="95" y="25">Isolated session</text><text class="sub" x="95" y="43">opening message</text></g>
    <g class="node chat" transform="translate(496 218)"><rect width="190" height="56" rx="12"/><text x="95" y="25">Conversation</text><text class="sub" x="95" y="43">no promised artifact</text></g>
    <g class="node decide" transform="translate(740 218)"><rect width="190" height="56" rx="12"/><text x="95" y="25">Explicit Workflow?</text><text class="sub" x="95" y="43">operator choice</text></g>
    <g class="node" transform="translate(496 328)"><rect width="190" height="56" rx="12"/><text x="95" y="25">Stay open</text><text class="sub" x="95" y="43">idle returns to chat</text></g>
    <g class="node done" transform="translate(720 328)"><rect width="190" height="56" rx="12"/><text x="95" y="25">Complete &amp; close</text><text class="sub" x="95" y="43">human boundary</text></g>
    <g class="node warn" transform="translate(930 328)"><rect width="166" height="56" rx="12"/><text x="83" y="25">Foreman path</text><text class="sub" x="83" y="43">only when opted in</text></g>
    <text class="label" x="770" y="310">No</text><text class="label" x="966" y="286">Yes</text><text class="label" x="711" y="164">next message</text>
  </svg>
  <p>The default path never interprets conversational idle as shipping. A Workflow selected by hand is the explicit opt-in to ordinary completion behavior.</p>
</figure>`;

const phasedFlow = `
<figure class="flow" aria-labelledby="phase-flow-title">
  <figcaption id="phase-flow-title">Planning dependency and implementation outcome</figcaption>
  <svg viewBox="0 0 1040 270" role="img" aria-label="The planning pull request merges before the one chat implementation phase starts. That phase delivers manual immediate dispatch, human-ended default completion, and documentation with browser proof together.">
    <defs>
      <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 10 5 0 10z"/></marker>
    </defs>
    <g class="edges">
      <path d="M224 78H312"/>
      <path d="M500 106V192H568"/>
      <path d="M500 106V148H770V192"/>
      <path d="M500 106V148H950V192"/>
    </g>
    <g class="node" transform="translate(24 50)"><rect width="200" height="56" rx="12"/><text x="100" y="25">Planning PR</text><text class="sub" x="100" y="43">documents on main</text></g>
    <g class="node chat" transform="translate(312 50)"><rect width="376" height="56" rx="12"/><text x="188" y="25">Phase 1: chat task kind</text><text class="sub" x="188" y="43">one vertical lifecycle change</text></g>
    <g class="node done" transform="translate(478 192)"><rect width="180" height="56" rx="12"/><text x="90" y="25">Manual dispatch</text><text class="sub" x="90" y="43">required opener</text></g>
    <g class="node done" transform="translate(680 192)"><rect width="180" height="56" rx="12"/><text x="90" y="25">Human-ended idle</text><text class="sub" x="90" y="43">no shipping default</text></g>
    <g class="node done" transform="translate(882 192)"><rect width="144" height="56" rx="12"/><text x="72" y="25">Proof</text><text class="sub" x="72" y="43">docs + e2e</text></g>
  </svg>
  <p>One phase is intentional: all creation and completion seams become safe in the same merge.</p>
</figure>`;

const mermaid = /<pre><code class="language-mermaid">[\s\S]*?<\/code><\/pre>/g;
const diagrams = body.match(mermaid) ?? [];
if (diagrams.length !== 1) {
  throw new Error(`plan.md must contain exactly one Mermaid flow, found ${diagrams.length}`);
}
body = body.replace(mermaid, phased ? phasedFlow : rootFlow);

const headings = [...body.matchAll(/<h2 id="([^"]+)">([\s\S]*?)<\/h2>/g)]
  .map((match) => ({ id: match[1], label: match[2].replace(/<[^>]+>/g, "") }));
const nav = headings
  .map(({ id, label }) => `<a href="#${id}">${label}</a>`)
  .join("\n");

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>${phased ? "The chat task kind: phased implementation" : "The chat task kind"}</title>
  <style>
    :root{color-scheme:light dark;--bg:#f2f4f7;--paper:#fff;--paper2:#f7f8fa;--ink:#1c232d;--muted:#626d7c;--dim:#7b8593;--line:#dce1e7;--line2:#e9edf1;--blue:#2c73c8;--green:#16815d;--amber:#a66508;--violet:#7252b9;--code:#eef2f6;--shadow:0 18px 54px rgba(28,35,45,.10);--sans:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;--mono:ui-monospace,"SFMono-Regular",Menlo,Consolas,monospace}
    @media(prefers-color-scheme:dark){:root{--bg:#0a0c0f;--paper:#14181e;--paper2:#0f1318;--ink:#e7ebf1;--muted:#939eae;--dim:#7c8798;--line:#29313b;--line2:#202730;--blue:#4a9eff;--green:#35c08a;--amber:#f6a733;--violet:#a371f7;--code:#1a2028;--shadow:0 20px 58px rgba(0,0,0,.38)}}
    *{box-sizing:border-box}html{scroll-behavior:smooth;background:var(--bg)}body{margin:0;min-width:0;background:radial-gradient(900px 520px at 88% -12%,color-mix(in srgb,var(--violet) 12%,transparent),transparent 62%),var(--bg);color:var(--ink);font:15px/1.68 var(--sans)}a{color:var(--blue);text-underline-offset:3px}.mast{border-bottom:1px solid var(--line);background:color-mix(in srgb,var(--paper) 90%,transparent);backdrop-filter:blur(16px)}.mast-inner{max-width:1380px;margin:auto;padding:42px clamp(20px,5vw,66px) 35px}.kicker{margin:0 0 8px;color:var(--violet);font:800 11px/1.2 var(--mono);letter-spacing:.15em;text-transform:uppercase}.mast h1{max-width:900px;margin:0;font-size:clamp(35px,5.5vw,64px);line-height:1.06;letter-spacing:-.045em}.mast-copy{max-width:850px;margin:16px 0 0;color:var(--muted);font-size:17px}.chips{display:flex;flex-wrap:wrap;gap:7px;margin-top:22px}.chips span{padding:7px 11px;border:1px solid var(--line);border-radius:999px;background:var(--paper2);color:var(--muted);font:700 11px/1 var(--mono)}.chips .active{border-color:var(--violet);color:var(--violet);background:color-mix(in srgb,var(--violet) 8%,var(--paper))}.path{margin-top:16px;color:var(--dim);font:12px/1.5 var(--mono)}.layout{display:grid;grid-template-columns:220px minmax(0,930px);gap:34px;max-width:1240px;margin:0 auto;padding:30px 18px 92px}nav{position:sticky;top:18px;align-self:start;max-height:calc(100vh - 36px);overflow:auto;padding:14px;border:1px solid var(--line);border-radius:13px;background:var(--paper);box-shadow:var(--shadow)}nav b{display:block;margin:0 0 9px;color:var(--dim);font:800 10px/1.2 var(--mono);letter-spacing:.12em;text-transform:uppercase}nav a{display:block;padding:6px 8px;border-radius:7px;color:var(--muted);text-decoration:none;font-size:12px}nav a:hover{color:var(--ink);background:var(--paper2)}article{min-width:0;padding:10px clamp(18px,4vw,54px) 60px;border:1px solid var(--line);border-radius:17px;background:var(--paper);box-shadow:var(--shadow)}article>h1:first-child{display:none}h2{margin:48px 0 13px;padding-top:7px;border-top:1px solid var(--line);font-size:25px;line-height:1.25;letter-spacing:-.025em}h2:first-of-type{margin-top:22px;border-top:0}h3{margin:30px 0 9px;font-size:18px;line-height:1.35;letter-spacing:-.012em}p{margin:8px 0 14px}ul,ol{padding-left:24px}li{margin:5px 0}code{padding:2px 5px;border:1px solid var(--line2);border-radius:5px;background:var(--code);color:var(--blue);font:12.5px/1.45 var(--mono);overflow-wrap:anywhere}pre{max-width:100%;overflow:auto;margin:17px 0;padding:15px 17px;border:1px solid var(--line);border-radius:11px;background:var(--paper2)}pre code{padding:0;border:0;background:none;color:var(--ink);white-space:pre}table{display:block;width:100%;max-width:100%;overflow-x:auto;margin:18px 0;border-collapse:collapse;font-size:13px}th,td{padding:9px 11px;border:1px solid var(--line);text-align:left;vertical-align:top}th{background:var(--paper2);font-size:11px}.flow{max-width:100%;margin:22px 0;padding:16px;overflow-x:auto;border:1px solid var(--line);border-radius:14px;background:var(--paper2)}.flow figcaption{margin-bottom:13px;font-weight:760}.flow svg{display:block;width:100%;height:auto;min-width:760px}.flow p{margin:12px 3px 1px;color:var(--muted);font-size:12px}.flow .edges path{fill:none;stroke:var(--dim);stroke-width:1.7;marker-end:url(#arrow)}.flow .node rect{fill:var(--paper);stroke:var(--line);stroke-width:1.5}.flow .node.chat rect{fill:color-mix(in srgb,var(--violet) 10%,var(--paper));stroke:var(--violet)}.flow .node.done rect{fill:color-mix(in srgb,var(--green) 8%,var(--paper));stroke:var(--green)}.flow .node.warn rect,.flow .node.decide rect{fill:color-mix(in srgb,var(--amber) 7%,var(--paper));stroke:var(--amber)}.flow text{fill:var(--ink);font:650 13px var(--sans);text-anchor:middle}.flow text.sub{fill:var(--muted);font-size:10px;font-weight:480}.flow text.label{fill:var(--dim);font:500 9px var(--mono)}.flow text.band{fill:var(--dim);font:800 10px var(--mono);letter-spacing:.14em;text-anchor:start}footer{display:flex;justify-content:space-between;gap:20px;max-width:1240px;margin:0 auto 36px;padding:0 18px;color:var(--dim);font:11px/1.5 var(--mono)}
    @media(max-width:880px){.layout{grid-template-columns:1fr}.layout nav{position:static;display:flex;gap:4px;max-height:none;overflow-x:auto}.layout nav b{display:none}.layout nav a{white-space:nowrap}article{padding-inline:20px}}@media(max-width:560px){.mast-inner{padding-top:30px}.layout{padding-inline:8px}article{border-radius:13px}.path{overflow-wrap:anywhere}th,td{min-width:130px}}@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}@media print{body{background:#fff}.mast,article,nav{box-shadow:none}.layout{display:block;max-width:none}.layout nav{display:none}article{border:0}.flow svg{min-width:0}footer{display:none}}
  </style>
</head>
<body>
  <header class="mast"><div class="mast-inner">
    <p class="kicker">Mission Control · ${phased ? "phased implementation" : "product and engineering plan"}</p>
    <h1>${phased ? "The chat task kind: phased implementation" : "The chat task kind"}</h1>
    <p class="mast-copy">${phased
      ? "One vertical implementation phase carries chat from manual immediate dispatch through a human-ended default completion boundary."
      : "Open an isolated agent conversation without promising a change, report, or plan. Chat defaults to no Workflow and stays open until the human completes it."}</p>
    <div class="chips" aria-label="${phased ? "Delivery summary" : "Task kinds"}">${phased
      ? '<span class="active">1 phase</span><span>required opener</span><span>manual only</span><span>human-ended</span>'
      : '<span>ship</span><span>scout</span><span>plan</span><span class="active">chat</span>'}</div>
    <p class="path">docs/plans/chat-task-kind/${sourceName} → ${outputName}</p>
  </div></header>
  <main class="layout">
    <nav aria-label="Plan sections"><b>Plan sections</b>${nav}</nav>
    <article>${body}</article>
  </main>
  <footer><span>Source: ${sourceName}</span><span>Self-contained · no external requests</span></footer>
</body>
</html>\n`;

if (checkOnly) {
  const existing = readFileSync(outputPath, "utf8");
  if (existing !== html) {
    console.error(`${outputName} is out of date; run node render-plan.mjs${phased ? " --phased" : ""}`);
    process.exitCode = 1;
  }
} else {
  writeFileSync(outputPath, html);
}
