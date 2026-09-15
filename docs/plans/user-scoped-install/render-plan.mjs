// Markdown is authoritative. Run with --check to verify every rendered page is current.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const escape = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const words = (children) => React.Children.toArray(children).map((child) => typeof child === "string" ? child : child?.props ? words(child.props.children) : "").join("");
const slug = (value) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function diagram(definition) {
  const nodes = [...definition.matchAll(/\b([A-Z])\[([^\]]+)\]/g)];
  const unique = [...new Map(nodes.map(([, id, label]) => [id, label])).entries()];
  const height = unique.length * 85 + 40;
  const positions = new Map(unique.map(([id], index) => [id, 22 + index * 85]));
  const edges = [...definition.matchAll(/\b([A-Z])(?:\[[^\]]+\])?\s*-->(?:\|([^|]+)\|)?\s*([A-Z])/g)];
  const boxes = unique.map(([id, label]) => `<g><rect x="160" y="${positions.get(id)}" width="480" height="54" rx="10"/><text x="400" y="${positions.get(id) + 32}" text-anchor="middle">${escape(label)}</text></g>`).join("");
  const lines = edges.map(([, from, label, to]) => {
    const start = positions.get(from);
    const end = positions.get(to);
    const back = end < start;
    const path = back ? `M160 ${start + 27}H70V${end + 27}H158`
      : end - start > 85 ? `M640 ${start + 27}H690V${end + 27}H642`
      : `M400 ${start + 54}V${end - 3}`;
    return `<path class="edge" d="${path}"/>${label ? `<text class="edge-label" x="${back ? 60 : 415}" y="${back ? (start + end) / 2 : start + 75}"${back ? ` transform="rotate(-90 60 ${(start + end) / 2})"` : ""}>${escape(label)}</text>` : ""}`;
  }).join("");
  return `<figure><svg viewBox="0 0 740 ${height}" role="img" aria-label="${escape(unique.map(([, label]) => label).join("; "))}"><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10z"/></marker></defs>${lines}${boxes}</svg></figure>`;
}

for (const name of ["plan", "phased-plan"]) {
  const input = new URL(`./${name}.md`, import.meta.url);
  if (!existsSync(input)) continue;
  const source = readFileSync(input, "utf8");
  const headings = [];
  const components = Object.fromEntries([1, 2, 3].map((level) => [`h${level}`, ({ children }) => {
    const label = words(children);
    const id = slug(label);
    if (level === 2) headings.push({ id, label });
    return React.createElement(`h${level}`, { id }, children);
  }]));
  components.table = ({ children }) => React.createElement("div", { className: "table-wrap" }, React.createElement("table", {}, children));
  let body = renderToStaticMarkup(React.createElement(ReactMarkdown, { remarkPlugins: [remarkGfm], components }, source));
  const diagrams = [...source.matchAll(/```mermaid\n([\s\S]*?)```/g)].map((match) => diagram(match[1]));
  let index = 0;
  body = body.replace(/<pre><code class="language-mermaid">[\s\S]*?<\/code><\/pre>/g, () => diagrams[index++]);
  if (index !== diagrams.length || index > 5) throw new Error("Diagram count differs from Markdown");
  const title = source.match(/^# (.+)$/m)?.[1] ?? name;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>${escape(title)}</title>
<style>
:root{color-scheme:light dark;--bg:#eff3f4;--paper:#fff;--ink:#182b35;--muted:#526572;--line:#c9d5da;--accent:#086b83;--soft:#edf5f7}
@media(prefers-color-scheme:dark){:root{--bg:#10171c;--paper:#182229;--ink:#e8f0f5;--muted:#b0c1cb;--line:#41545f;--accent:#78d5ed;--soft:#20333c}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.65 system-ui,-apple-system,sans-serif}main{max-width:1260px;margin:auto;padding:36px 24px 80px;display:grid;grid-template-columns:220px minmax(0,1fr);gap:28px}nav{position:sticky;top:24px;align-self:start;max-height:90vh;overflow:auto;font-size:13px}nav a{display:block;padding:6px 0}article{min-width:0;padding:24px 40px 48px;background:var(--paper);border:1px solid var(--line);border-radius:16px}h1{font-size:clamp(28px,4vw,44px);line-height:1.12;letter-spacing:-.025em}h2{margin-top:40px;padding-top:20px;border-top:1px solid var(--line);font-size:25px;line-height:1.25}h3{font-size:19px;margin-top:28px}a{color:var(--accent);text-underline-offset:3px}p,li{overflow-wrap:anywhere}li{margin:7px 0}code{font:13px/1.5 ui-monospace,monospace;background:var(--soft);border-radius:4px;padding:2px 4px;overflow-wrap:anywhere}pre{max-width:100%;overflow:auto;background:var(--soft);padding:16px;border-radius:8px}pre code{white-space:pre;padding:0}.table-wrap{max-width:100%;overflow:auto;margin:20px 0}table{border-collapse:collapse;font-size:14px;min-width:580px;width:100%}th,td{padding:11px;border:1px solid var(--line);vertical-align:top;text-align:left}th{background:var(--soft)}figure{margin:22px 0;max-width:100%;overflow:auto;background:var(--soft);border-radius:12px}svg{display:block;width:100%;min-width:620px}svg rect{fill:var(--paper);stroke:var(--accent)}svg text{fill:var(--ink);font:15px system-ui,sans-serif}.edge{fill:none;stroke:var(--accent);stroke-width:2;marker-end:url(#arrow)}marker path{fill:var(--accent)}svg .edge-label{font-size:12px;fill:var(--muted)}footer{margin-top:32px;font-size:12px;color:var(--muted)}@media(max-width:850px){main{display:block;padding:14px 10px 40px}nav{position:static;display:flex;gap:14px;overflow:auto;white-space:nowrap;margin-bottom:14px}article{padding:16px 20px 32px}}@media print{main{display:block;padding:0}nav{display:none}article{border:0}body{background:white}figure svg{min-width:0}}
</style></head><body><main><nav aria-label="Plan sections">${headings.map(({ id, label }) => `<a href="#${id}">${escape(label)}</a>`).join("")}</nav><article>${body}<footer>Source: <a href="${name}.md">${name}.md</a></footer></article></main></body></html>
`;
  const output = new URL(`./${name}.html`, import.meta.url);
  if (process.argv.includes("--check")) {
    if (!existsSync(output) || readFileSync(output, "utf8") !== html) throw new Error(`${name}.html is stale`);
    console.log(`${name}.html matches Markdown; ${index} inline SVG diagram(s)`);
  } else {
    writeFileSync(output, html);
    console.log(`Wrote docs/plans/user-scoped-install/${name}.html`);
  }
}
