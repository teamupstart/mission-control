import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const here = dirname(fileURLToPath(import.meta.url));
const markdown = await readFile(join(here, "plan.md"), "utf8");
const heading = markdown.match(/^# (.+)$/m)?.[1] ?? "Implementation plan";
const escape = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
const expectedFlow = `flowchart LR
  S[Any verified session] --> M[Existing MCP submission tool]
  M --> D[Daemon: authenticate and derive owner / episode]
  D --> A[Directory A capture job]
  D --> B[Directory B capture job]
  A --> X[Immutable archive A]
  B --> Y[Immutable archive B]
  X --> I[Existing archive index and SSE]
  Y --> I
  I --> U[Scouts library and session Scouts tab]`;

const box = (x, y, width, lines, accent = false) => `<g class="node${accent ? " accent" : ""}"><rect x="${x}" y="${y}" width="${width}" height="64" rx="9"/>${lines.map((line, index) => `<text x="${x + width / 2}" y="${y + (lines.length === 1 ? 37 : 27) + index * 20}">${escape(line)}</text>`).join("")}</g>`;
const diagram = `<div class="diagram-scroll"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 430" role="img" aria-labelledby="flow-title flow-description">
<title id="flow-title">Independent scout reports from one session</title>
<desc id="flow-description">Any verified session calls the existing MCP tool. The daemon authenticates the owner and episode, creates a separate capture job for each report directory, and publishes two immutable archives. The existing index and event stream update the Scouts library and session Scouts tab.</desc>
<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10Z"/></marker></defs>
${box(20, 25, 185, ["Any verified session"])}
${box(260, 25, 200, ["Existing MCP", "submission tool"])}
${box(520, 25, 285, ["Daemon: authenticate", "derive owner / episode"], true)}
${box(410, 160, 220, ["Directory A capture job"])}
${box(720, 160, 220, ["Directory B capture job"])}
${box(410, 280, 220, ["Immutable archive A"], true)}
${box(720, 280, 220, ["Immutable archive B"], true)}
${box(25, 280, 275, ["Existing archive", "index and SSE"])}
${box(25, 160, 275, ["Scouts library and", "session Scouts tab"], true)}
<g class="arrows"><path d="M205 57H260"/><path d="M460 57H520"/><path d="M662 89V122H520V160"/><path d="M662 122H830V160"/><path d="M520 224V280"/><path d="M830 224V280"/><path d="M520 344V382H163V344"/><path d="M830 344V402H163V344"/><path d="M163 280V224"/></g>
</svg></div>`;

let renderedFlows = 0;
const body = renderToStaticMarkup(React.createElement(ReactMarkdown, {
  remarkPlugins: [remarkGfm],
  components: {
    table: ({ children }) => React.createElement("div", { className: "table-scroll", tabIndex: 0 }, React.createElement("table", null, children)),
    pre: ({ children }) => {
      const child = Array.isArray(children) ? children[0] : children;
      if (React.isValidElement(child) && child.props.className === "language-mermaid") {
        if (String(child.props.children).trim() !== expectedFlow) {
          throw new Error("The Markdown flow changed. Update its inline SVG rendering before publishing.");
        }
        renderedFlows += 1;
        return React.createElement("figure", { dangerouslySetInnerHTML: { __html: diagram } });
      }
      return React.createElement("div", { className: "code-scroll" }, React.createElement("pre", null, children));
    },
  },
  children: markdown,
}));
if (renderedFlows !== 1) throw new Error(`Expected one flow diagram; rendered ${renderedFlows}.`);

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><title>${escape(heading)}</title>
<style>
:root{color-scheme:light dark;--bg:#f6f7f9;--paper:#fff;--text:#202937;--muted:#566477;--line:#cdd5df;--tint:#eef4f8;--accent:#175e79;--code:#eef1f5}
@media(prefers-color-scheme:dark){:root{--bg:#10151d;--paper:#171e29;--text:#e4eaf3;--muted:#b2c0d2;--line:#45546a;--tint:#213343;--accent:#8dd6ee;--code:#242e3e}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.65 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{width:min(1100px,100%);margin:36px auto 72px;padding:40px 52px;background:var(--paper);border:1px solid var(--line);border-top:6px solid var(--accent);border-radius:10px}h1,h2,h3{line-height:1.22;letter-spacing:-.02em;text-wrap:balance}h1{font-size:clamp(28px,4vw,44px);margin:0 0 24px;max-width:850px}h2{font-size:27px;margin:48px 0 18px;padding-top:22px;border-top:1px solid var(--line)}h3{font-size:21px;margin:28px 0 14px}p{margin:14px 0}a{color:var(--accent);text-underline-offset:3px}li{margin:9px 0}ul,ol{padding-left:26px}code{font:0.88em/1.6 ui-monospace,SFMono-Regular,Consolas,monospace;background:var(--code);padding:2px 5px;border-radius:4px;overflow-wrap:anywhere}pre{margin:0;padding:18px;white-space:pre;min-width:0}pre code{padding:0;background:none;overflow-wrap:normal}.table-scroll,.code-scroll,.diagram-scroll{max-width:100%;overflow-x:auto;overscroll-behavior-x:contain}.table-scroll{margin:22px 0;border:1px solid var(--line);border-radius:7px}table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;vertical-align:top;padding:14px 16px;border-bottom:1px solid var(--line);min-width:120px;overflow-wrap:anywhere}th{background:var(--tint);font-size:13px;letter-spacing:.02em}tr:last-child td{border-bottom:0}.code-scroll{background:var(--code);border:1px solid var(--line);border-radius:7px}figure{margin:24px 0;padding:10px;background:var(--tint);border:1px solid var(--line);border-radius:9px}svg{display:block;width:100%;min-width:690px}svg text{fill:var(--text);font:15px system-ui,sans-serif;text-anchor:middle}.node rect{fill:var(--paper);stroke:var(--line);stroke-width:1.5}.node.accent rect{stroke:var(--accent);stroke-width:2}.arrows path{fill:none;stroke:var(--accent);stroke-width:2;marker-end:url(#arrow)}marker path{fill:var(--accent)}strong{font-weight:650}@media(max-width:650px){body{font-size:15px}main{margin:0 auto;padding:28px 20px;border-radius:0;border-left:0;border-right:0}h2{font-size:24px}th,td{padding:11px;min-width:135px}.table-scroll table{min-width:620px}}@media print{main{width:100%;margin:0;padding:0;border:0}h2,h3{break-after:avoid}tr,figure{break-inside:avoid}.table-scroll,.code-scroll,.diagram-scroll{overflow:visible}svg{min-width:0}}
</style></head><body><main>${body}</main></body></html>
`;
await writeFile(join(here, "plan.html"), html);
console.log(`Rendered ${join(here, "plan.html")} from plan.md with ${renderedFlows} offline SVG diagram.`);
