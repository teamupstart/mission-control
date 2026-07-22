import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "../src/web/components/Markdown.tsx";

// Rendered rather than driven through a browser, for the same reason as the other render
// tests here: the dashboard's SSE stream holds the connection open, which hangs headless
// automation. Static markup is the whole surface anyway - this component's entire job is
// turning a string into HTML, and every claim below is about that HTML.

function render(md: string, breaks = false): string {
  return renderToStaticMarkup(createElement(Markdown, { children: md, breaks }));
}

test("a fenced block becomes a highlighted <pre><code>, tagged with its language", () => {
  const html = render("```ts\nconst x: number = 1;\n```");
  assert.match(html, /<pre><code class="[^"]*language-ts/);
  // `hljs` is the class the token stylesheet hangs off. Without it the block renders as
  // undifferentiated text - which is the bug this whole feature exists to fix.
  assert.match(html, /<pre><code class="[^"]*\bhljs\b/);
});

test("keywords and literals come out as separate token spans, not one flat string", () => {
  const html = render("```js\nconst greeting = 'hi';\n```");
  assert.match(html, /class="hljs-keyword">const</);
  assert.match(html, /class="hljs-string">&#x27;hi&#x27;</);
});

test("an unlabelled fence is left uncoloured rather than guessed at", () => {
  // `detect: false`. Agents emit plenty of fences that aren't code - log tails, file
  // trees, error dumps - and auto-detection paints those in confident, meaningless
  // colour. A fence with no language gets a code block and no tokens.
  const html = render("```\nERROR  connection refused after 3 tries\n```");
  assert.match(html, /<pre><code/);
  assert.doesNotMatch(html, /hljs-/);
});

test("a fence naming a language highlight.js doesn't ship still renders as code", () => {
  // `ignoreMissing: true`. An unknown language must degrade to a plain block, never
  // throw - a single exotic fence would otherwise blank the whole turn it lives in.
  const html = render("```notalanguage\nsome text\n```");
  assert.match(html, /<pre><code/);
  assert.match(html, /some text/);
});

test("with `breaks`, single newlines inside a paragraph survive as breaks", () => {
  // `remarkBreaks`. Chat turns used to be `white-space: pre-wrap`, so without it every
  // existing message would silently reflow into one run-on paragraph.
  const html = render("first line\nsecond line", true);
  assert.match(html, /first line<br\/?>\s*second line/);
});

test("without `breaks` - the default - a single newline reflows instead", () => {
  // Plans and Foreman briefs were never pre-wrap, so they must keep markdown's own
  // reflow. A `<br>` here would break every paragraph of hard-wrapped plan prose.
  const html = render("first line\nsecond line");
  assert.doesNotMatch(html, /<br/);
  assert.match(html, /first line\s*second line/);
});

test("GFM still applies: tables and strikethrough parse", () => {
  assert.match(render("| a | b |\n| - | - |\n| 1 | 2 |"), /<table>/);
  assert.match(render("~~gone~~"), /<del>gone<\/del>/);
});

test("an unterminated fence renders as code rather than losing the text", () => {
  // What a turn looks like mid-stream, before its closing fence has arrived. It must
  // degrade to a code block that shows the partial content, not swallow it.
  const html = render("here it comes:\n```ts\nconst x = 1;");
  assert.match(html, /<pre><code/);
  assert.match(html, /const/);
  assert.match(html, /here it comes/);
});

test("raw HTML in a message is escaped, not mounted", () => {
  // Transcript text is whatever an agent typed, and an agent quoting markup must not be
  // able to inject nodes into the dashboard. react-markdown escapes by default (no
  // rehype-raw); this pins that, since the fix for a rendering complaint is exactly the
  // kind of change that reaches for it.
  const html = render("<img src=x onerror=alert(1)>");
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});

test("external protocol links keep their browser href", () => {
  const html = render("[calendar](webcal:123) [call](tel:456) [map](geo:1,2) [file](ftp://example.com/a)");
  assert.match(html, /href="webcal:123"/);
  assert.match(html, /href="tel:456"/);
  assert.match(html, /href="geo:1,2"/);
  assert.match(html, /href="ftp:\/\/example\.com\/a"/);
});

test("active-content protocol links receive an inert href", () => {
  const html = render("[bad](javascript:alert(1)) [data](data:text/html,x)");
  assert.equal(html, '<p><a href="">bad</a> <a href="">data</a></p>');
});
