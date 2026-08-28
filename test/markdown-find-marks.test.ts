import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { Markdown } from "../src/web/components/Markdown.tsx";
import { FILES_DIAGRAM_RENDERERS } from "../src/web/components/markdownDiagramRegistry.tsx";
import {
  rehypeFindMarks,
  type MarkdownFindHit,
  type MarkdownFindReport,
} from "../src/web/lib/rehypeFindMarks.ts";
import {
  DIAGRAM_LIMIT_PROPERTY,
  DIAGRAM_ORDINAL_PROPERTY,
  DIAGRAM_TAG_PROPERTY,
} from "../src/web/lib/rehypeDiagramFences.ts";

/**
 * Markdown preview's find, from both ends.
 *
 * The plugin is Preview's MODEL as well as its renderer, so both halves are asserted, and
 * they are asserted through different doors on purpose.
 *
 * **What is DRAWN** goes through the real component and this repository's real plugin chain,
 * because that is the only place `remark-gfm` -> `remark-rehype` -> `rehype-highlight`
 * actually runs and therefore the only place "a link destination renders to nothing" is a
 * fact rather than a fixture. `renderToStaticMarkup` runs no effects, so the report cannot be
 * observed there - but every reported hit draws at least one fragment carrying its key, so
 * the number of DISTINCT keys in the markup is the reported count, and the number of
 * fragments is larger exactly when inline markup split a hit.
 *
 * **What is REPORTED** goes to the plugin directly, over hast built by hand. The run rules
 * and the block ranges are properties of the walk, and a hand-built tree can state the one
 * case a parser will not produce on demand: a node the parser recorded no position for.
 */

interface Drawn {
  html: string;
  /** Distinct logical hits, in document order - the count the bar shows. */
  keys: string[];
  /** Every fragment's key. Longer than `keys` when a hit was split by inline markup. */
  fragments: string[];
}

function draw(
  source: string,
  query: string,
  options: { caseSensitive?: boolean; currentKey?: string | null; diagrams?: boolean } = {},
): Drawn {
  const html = renderToStaticMarkup(
    createElement(Markdown, {
      children: source,
      ...(options.diagrams ? { diagramRenderers: FILES_DIAGRAM_RENDERERS } : {}),
      find: {
        query,
        caseSensitive: options.caseSensitive ?? false,
        currentKey: options.currentKey ?? null,
        onHits: () => {},
      },
    }),
  );
  const fragments = [...html.matchAll(/data-find-key="([^"]+)"/g)].map((match) => match[1]!);
  return { html, keys: [...new Set(fragments)], fragments };
}

test("a plain match draws one mark per occurrence", () => {
  const { keys, fragments, html } = draw(
    "The reconnect budget bounds the reconnect loop.\n",
    "reconnect",
  );
  assert.deepEqual(keys, ["rendered:1", "rendered:2"]);
  assert.equal(fragments.length, 2);
  assert.match(html, /<mark class="find-hit" data-find-key="rendered:1">reconnect<\/mark>/);
});

test("a hit split by inline markup is ONE hit drawn as two fragments sharing one key", () => {
  // `foo**bar**` renders as a text node plus a `strong`. A reader sees one word, so a
  // per-node scan finding nothing here is the defect run joining exists for.
  const { keys, fragments } = draw("A foo**bar** appears here.\n", "foobar");
  assert.deepEqual(keys, ["rendered:1"], "one logical hit, so one key");
  assert.deepEqual(fragments, ["rendered:1", "rendered:1"], "drawn as two fragments");
});

test("a match inside a fenced code block still marks, across highlight span boundaries", () => {
  const source = ["```ts", "const reconnectBudgetMs = 30;", "```", ""].join("\n");
  const inside = draw(source, "reconnectBudgetMs");
  assert.deepEqual(inside.keys, ["rendered:1"]);
  assert.match(inside.html, /<pre>/);
  // `rehypeHighlight` splits that declaration into several spans, so a query spanning them
  // is one hit only because the run crossed them.
  const crossing = draw(source, "const reconnectBudgetMs");
  assert.deepEqual(crossing.keys, ["rendered:1"]);
  assert.ok(crossing.fragments.length >= 2, "the hit was drawn in more than one span");
});

test("is-current marks exactly one hit, however many fragments it has", () => {
  const { html, fragments } = draw(
    "A foo**bar** and another foobar.\n",
    "foobar",
    { currentKey: "rendered:1" },
  );
  assert.equal(fragments.length, 3, "two fragments for the split hit, one for the plain one");
  const current = [...html.matchAll(/class="find-hit is-current" data-find-key="([^"]+)"/g)]
    .map((match) => match[1]!);
  assert.deepEqual(current, ["rendered:1", "rendered:1"]);
  assert.equal(new Set(current).size, 1);
});

test("a run never joins across a visible separation", () => {
  const cases: [string, string][] = [
    ["a hard break", "foo\\\nbar\n"],
    ["two paragraphs", "foo\n\nbar\n"],
    ["two list items", "- foo\n- bar\n"],
    ["two table cells", ["| a | b |", "| --- | --- |", "| foo | bar |", ""].join("\n")],
    ["a heading and its paragraph", "# foo\n\nbar\n"],
  ];
  for (const [what, source] of cases) {
    assert.deepEqual(draw(source, "foobar").keys, [], `joined across ${what}`);
  }
  // The same two words ARE one hit when nothing visible separates them.
  assert.deepEqual(draw("foo*bar*\n", "foobar").keys, ["rendered:1"]);
});

test("a visible separator INSIDE an inline element still breaks the run", () => {
  /*
   * The regression this pins. Run building was two mutually recursive walkers, and the inline
   * one reported a separator it had crossed through a flag the caller acted on only after
   * taking all of its pieces - so text either side of a nested separator arrived in one run.
   * An image inside a link is the case: the reader sees `foo`, a picture, then `bar`, and
   * `foobar` is not a word on that screen.
   */
  assert.deepEqual(draw("A [foo![shot](s.png)bar](docs/x.md) link.\n", "foobar").keys, []);
  // The halves are still each findable, so the run broke rather than the text being dropped.
  assert.deepEqual(draw("A [foo![shot](s.png)bar](docs/x.md) link.\n", "foo").keys, ["rendered:1"]);
  assert.deepEqual(draw("A [foo![shot](s.png)bar](docs/x.md) link.\n", "bar").keys, ["rendered:1"]);
  // A hard break nested inside emphasis is the same rule one level down.
  assert.deepEqual(draw("*foo\\\nbar*\n", "foobar").keys, []);
});

test("a query that only occurs where nothing renders draws nothing", () => {
  const cases: [string, string, string][] = [
    ["a link destination", "See [the audit](docs/matching-url.md).\n", "matching-url"],
    ["an image URL", "![shot](docs/matching-image.png)\n", "matching-image"],
    ["a reference definition", "See [audit][ref].\n\n[ref]: docs/matching-ref.md\n", "matching-ref"],
    ["a fence info string", "```matchinginfo\nplain\n```\n", "matchinginfo"],
  ];
  for (const [what, source, query] of cases) {
    const { keys, fragments } = draw(source, query);
    assert.deepEqual(keys, [], `marked inside ${what}`);
    assert.deepEqual(fragments, [], `fragments inside ${what}`);
  }
  // The count is zero because the surface shows nothing, not because the document is
  // unsearchable: its rendered text still matches.
  assert.deepEqual(draw("See [the audit](docs/matching-url.md).\n", "audit").keys, ["rendered:1"]);
});

test("a rendered Mermaid fence offers no match, because its source is not on screen", () => {
  const source = ["```mermaid", "flowchart LR", "  A[match] --> B", "```", ""].join("\n");
  assert.deepEqual(draw(source, "match", { diagrams: true }).keys, []);
  // Without the registry that same fence IS source on screen, and is searched like any code.
  assert.deepEqual(draw(source, "match").keys, ["rendered:1"]);
});

test("the case flag reaches the drawn marks", () => {
  const source = "Match and match.\n";
  assert.deepEqual(draw(source, "Match", { caseSensitive: true }).keys, ["rendered:1"]);
  assert.deepEqual(draw(source, "Match", { caseSensitive: false }).keys, ["rendered:1", "rendered:2"]);
});

test("no find prop, and an empty query, render exactly the markup they always did", () => {
  const source = "The reconnect budget is bounded.\n";
  const plain = renderToStaticMarkup(createElement(Markdown, { children: source }));
  const searched = renderToStaticMarkup(
    createElement(Markdown, {
      children: source,
      find: { query: "", caseSensitive: false, currentKey: null, onHits: () => {} },
    }),
  );
  assert.equal(searched, plain, "an empty query installs no plugin");
  assert.doesNotMatch(plain, /find-hit/);
});

// ---- what the plugin REPORTS ----

/** Run the plugin over a hand-built tree and hand back what it said it drew. */
function report(
  tree: unknown,
  query: string,
  options: { caseSensitive?: boolean; currentKey?: string | null } = {},
): MarkdownFindHit[] {
  const sink: MarkdownFindReport = { hits: [] };
  rehypeFindMarks({
    query,
    caseSensitive: options.caseSensitive ?? false,
    currentKey: options.currentKey ?? null,
    report: sink,
  })(tree);
  return sink.hits;
}

function text(value: string) {
  return { type: "text", value };
}

function element(
  tagName: string,
  children: unknown[],
  extra: Record<string, unknown> = {},
) {
  return { type: "element", tagName, properties: {}, children, ...extra };
}

/** A block the parser placed, spelled the way `remark-rehype` spells it. */
function placed(tagName: string, children: unknown[], startLine: number, endLine = startLine) {
  return element(tagName, children, {
    position: { start: { line: startLine }, end: { line: endLine } },
  });
}

test("every reported hit carries the source lines of the block it sits in", () => {
  const tree = element("root", [
    placed("h1", [text("Heading match")], 1),
    placed("p", [text("Paragraph "), element("strong", [text("match")])], 3, 4),
  ]);
  assert.deepEqual(report(tree, "match"), [
    { key: "rendered:1", range: { startLine: 1, endLine: 1 } },
    { key: "rendered:2", range: { startLine: 3, endLine: 4 } },
  ]);
});

test("a hit in a block the parser did not place still marks, reporting a null range", () => {
  const tree = element("root", [element("p", [text("unplaced match")])]);
  const paragraph = (tree.children[0] as { children: unknown[] });
  assert.deepEqual(report(tree, "match"), [{ key: "rendered:1", range: null }]);
  // Marked, not skipped: the missing line costs the toggle its position, nothing else.
  assert.equal(
    (paragraph.children as { tagName?: string }[]).filter((child) => child.tagName === "mark").length,
    1,
  );
});

test("a nested block reports its OWN range, not its container's", () => {
  const tree = element("root", [
    placed("blockquote", [placed("p", [text("quoted match")], 7)], 6, 8),
  ]);
  assert.deepEqual(report(tree, "match"), [
    { key: "rendered:1", range: { startLine: 7, endLine: 7 } },
  ]);
});

test("the run joins inline elements and breaks at a br, an img and a nested block", () => {
  const joined = element("root", [
    placed("p", [text("foo"), element("strong", [text("bar")])], 1),
  ]);
  assert.equal(report(joined, "foobar").length, 1);

  for (const separator of [
    element("br", []),
    element("img", [], { properties: { src: "shot.png" } }),
    placed("div", [], 1),
  ]) {
    const broken = element("root", [
      placed("p", [text("foo"), separator, text("bar")], 1),
    ]);
    assert.deepEqual(report(broken, "foobar"), [], `joined across ${JSON.stringify(separator)}`);
  }
});

test("a nested separator flushes the run at the depth it is found", () => {
  // The same rule over hand-built hast, at two depths, so the report agrees with the marks.
  const nested = element("root", [
    placed("p", [
      element("a", [
        text("foo"),
        element("img", [], { properties: { src: "s.png" } }),
        text("bar"),
      ]),
    ], 1),
  ]);
  assert.deepEqual(report(nested, "foobar"), [], "joined across a nested img");
  assert.equal(report(nested, "foo").length, 1);
  assert.equal(report(nested, "bar").length, 1);

  // Two levels down, and across a `br` rather than an image.
  const deeper = element("root", [
    placed("p", [
      element("em", [element("strong", [text("foo"), element("br", []), text("bar")])]),
    ], 1),
  ]);
  assert.deepEqual(report(deeper, "foobar"), [], "joined across a doubly nested br");
});

test("a node occupying no space neither marks nor breaks the run", () => {
  const tree = element("root", [
    placed("p", [
      text("foo"),
      element("script", [text("matching script")]),
      text("bar"),
    ], 1),
  ]);
  // The script's own text is not rendered text, so it is not searched...
  assert.deepEqual(report(tree, "matching"), []);
  // ...and it is not a visible separation either, so the word around it is still one word.
  assert.deepEqual(report(tree, "foobar").length, 1);
});

test("one logical hit is drawn as however many fragments it needs, under one key", () => {
  const paragraph = placed("p", [text("foo"), element("strong", [text("bar")])], 1);
  const tree = element("root", [paragraph]);
  const hits = report(tree, "foobar");
  assert.equal(hits.length, 1);
  const marks: { tagName?: string; properties?: Record<string, unknown> }[] = [];
  const walk = (node: { tagName?: string; children?: unknown[] }): void => {
    if (node.tagName === "mark") marks.push(node);
    for (const child of node.children ?? []) walk(child as { children?: unknown[] });
  };
  walk(tree);
  assert.equal(marks.length, 2, "two fragments");
  assert.deepEqual(
    marks.map((mark) => mark.properties?.dataFindKey),
    [hits[0]!.key, hits[0]!.key],
    "both carry the one hit's key",
  );
});

test("the current key marks only that hit's fragments", () => {
  const tree = element("root", [
    placed("p", [text("match one")], 1),
    placed("p", [text("match two")], 3),
  ]);
  report(tree, "match", { currentKey: "rendered:2" });
  const classes: unknown[] = [];
  const walk = (node: { tagName?: string; properties?: Record<string, unknown>; children?: unknown[] }): void => {
    if (node.tagName === "mark") classes.push(node.properties?.className);
    for (const child of node.children ?? []) walk(child as { children?: unknown[] });
  };
  walk(tree);
  assert.deepEqual(classes, [["find-hit"], ["find-hit", "is-current"]]);
});

test("a hidden diagram fence is skipped while an over-limit one is searched", () => {
  const fence = (overLimit: boolean) => element("root", [
    placed("pre", [
      element("code", [text("flowchart match")], {
        properties: {
          [DIAGRAM_TAG_PROPERTY]: "mermaid",
          [DIAGRAM_ORDINAL_PROPERTY]: 1,
          [DIAGRAM_LIMIT_PROPERTY]: overLimit,
        },
      }),
    ], 2, 4),
  ]);
  assert.deepEqual(report(fence(false), "match"), [], "a rendered diagram shows no source");
  assert.deepEqual(
    report(fence(true), "match"),
    [{ key: "rendered:1", range: { startLine: 2, endLine: 4 } }],
    "an over-limit fence renders as source, so it is searched",
  );
});

test("an empty query reports nothing and leaves the tree alone", () => {
  const tree = element("root", [placed("p", [text("match")], 1)]);
  assert.deepEqual(report(tree, ""), []);
  assert.deepEqual(tree.children[0], placed("p", [text("match")], 1));
});
