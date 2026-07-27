/* Splits index.html's showcase sections into one standalone page each, so the five
   variants and the compare-all page cannot drift from one another. Re-run after editing
   index.html:  node build-pages.mjs  */
import { readFileSync, writeFileSync } from "node:fs";

const src = readFileSync(new URL("./index.html", import.meta.url), "utf8");

const PAGES = [
  { id: "spine", file: "01-spine.html", n: "1", name: "Spine" },
  { id: "gauges", file: "02-gauges.html", n: "2", name: "Gauges" },
  { id: "day-track", file: "03-day-track.html", n: "3", name: "Day track" },
  { id: "ledger", file: "04-ledger.html", n: "4", name: "Ledger" },
  { id: "triage", file: "05-triage.html", n: "5", name: "Triage" },
];

/** The section element with this id, start tag to its matching close. */
function section(id) {
  const open = src.indexOf(`<section class="showcase" id="${id}">`);
  if (open < 0) throw new Error(`no section #${id}`);
  const close = src.indexOf("</section>", open);
  return src.slice(open, close + "</section>".length);
}

/** The first .frame in a chunk, balanced on div depth. */
function firstFrame(chunk) {
  const open = chunk.indexOf('<div class="frame">');
  let i = open, depth = 0;
  const tag = /<\/?div\b/g;
  tag.lastIndex = open;
  for (let m; (m = tag.exec(chunk)); ) {
    depth += m[0] === "<div" ? 1 : -1;
    if (depth === 0) { i = m.index + "</div>".length; break; }
  }
  return chunk.slice(open, i);
}

const nav = (current) =>
  [
    { href: "index.html", i: "all", label: "Compare all five", id: "index" },
    ...PAGES.map((p) => ({ href: p.file, i: p.n, label: p.name, id: p.id })),
  ]
    .map(
      (l) =>
        `  <a href="${l.href}"${l.id === current ? ' aria-current="page"' : ""}><i>${l.i}</i> ${l.label}</a>`,
    )
    .join("\n");

for (const page of PAGES) {
  const chunk = section(page.id);
  const lede = /<p class="lede">([\s\S]*?)<\/p>/.exec(chunk)?.[1] ?? "";
  const narrow = firstFrame(chunk).replace('<div class="frame">', '<div class="frame narrow">');
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Usage bar ${page.n} - ${page.name}</title>
<link rel="stylesheet" href="usage-bar.css">
</head>
<body>

<div class="page-head">
  <h1>${page.n}. ${page.name}</h1>
  <p>${lede.trim()}</p>
</div>

<nav class="mock-nav">
${nav(page.id)}
</nav>

${chunk.replace(/<p class="lede">[\s\S]*?<\/p>\n\n/, "")}

<section class="showcase">
  <h2>Narrow <span>940px</span> <em>laptop, or a window at half width</em></h2>
  <p class="lede">Same bar in the width where the topbar's responsive ladder starts shedding ink.
  What wraps first, and whether it still reads, is part of the choice.</p>
  ${narrow}
</section>

</body>
</html>
`;
  writeFileSync(new URL(`./${page.file}`, import.meta.url), html);
  console.log(`wrote ${page.file}`);
}
