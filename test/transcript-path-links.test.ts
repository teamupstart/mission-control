import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown, markdownPropsEqual } from "../src/web/components/Markdown.tsx";
import { FILES_DIAGRAM_RENDERERS } from "../src/web/components/markdownDiagramRegistry.tsx";
import { rehypeWorkspacePaths } from "../src/web/lib/rehypeWorkspacePaths.ts";
import { LatestFileRequests } from "../src/web/lib/sessionFiles.ts";
import { tooltipLabels } from "./helpers/markup.ts";

// What is at stake: an agent names a file the way it reads in a terminal - in backticks or
// bare in a sentence - and the dashboard is the one place that can open it. Every claim
// here is about the markup, because the markup IS the feature: existence is settled while
// the tree is built, so a path that becomes an anchor is one the checkout has, and a path
// that does not is inert text with no click, no cursor and no hover affordance suggesting
// otherwise. A renderer that guessed and corrected itself afterwards would flicker links
// onto words that turn out not to be files.

const CHECKOUT = new Set([
  "docs/plans/session-card-legibility/plan.md",
  "docs/plans/session-card-legibility/plan.html",
  "src/App.tsx",
  "README.md",
  "Makefile",
  ".env",
  "docs/My Plan.md",
]);

function render(md: string, paths: ReadonlySet<string> | null = CHECKOUT): string {
  return renderToStaticMarkup(createElement(Markdown, {
    children: md,
    breaks: true,
    onLinkClick: () => true,
    filePaths: paths,
  }));
}

/** The anchor, minus the `aria-describedby` Tooltip threads through every one of them. */
const anchor = (href: string, text = href) =>
  new RegExp(`<a class="workspace-path" href="${href.replace(/[.*+?^$()|[\]\\/]/g, "\\$&")}"[^>]*>${text.replace(/[.*+?^$()|[\]\\/]/g, "\\$&")}</a>`);

test("a bare path in prose becomes a link to the file in this session's checkout", () => {
  const html = render("Written up at docs/plans/session-card-legibility/plan.md, see it.");
  assert.match(html, anchor("docs/plans/session-card-legibility/plan.md"));
  assert.deepEqual(tooltipLabels(html), [
    "Open docs/plans/session-card-legibility/plan.md in this session's files",
  ]);
  // The sentence around it survives intact - the token is replaced, not the text node.
  assert.match(html, /Written up at <a/);
  assert.match(html, /<\/span>, see it\.<\/p>/);
});

test("a backticked path is linked without losing the code span it was written in", () => {
  const html = render("Rendered beside it: `docs/plans/session-card-legibility/plan.html`");
  assert.match(html, /<code><a class="workspace-path"/);
  assert.match(html, /plan\.html<\/a>/);
  assert.match(html, /<\/span><\/code>/);
});

test("a path-shaped word this checkout does not have stays plain text", () => {
  const html = render("Compare notes/other.md and src/Missing.tsx with src/App.tsx.");
  assert.doesNotMatch(html, /notes\/other\.md<\/a>/);
  assert.doesNotMatch(html, /Missing\.tsx<\/a>/);
  assert.match(html, />src\/App\.tsx<\/a>/);
  // One anchor in the sentence, not three hopeful ones.
  assert.equal(html.match(/workspace-path/g)?.length, 1);
});

test("names with no extension, a leading dot, or a space in them link like any other", () => {
  // The listing is what decides, so a file is linkable because the checkout HAS it, not
  // because its name happens to look file-shaped. These three are the cases where those
  // two answers differ, and all three are ordinary files an agent names constantly.
  const html = render("Run the Makefile, read .env, then open docs/My Plan.md today.");
  assert.match(html, anchor("Makefile"));
  assert.match(html, anchor(".env"));
  assert.match(html, anchor("docs/My Plan.md"));
  assert.equal(html.match(/workspace-path/g)?.length, 3);
});

test("a one-character file is clickable however it is written, prose included", () => {
  // Through the real renderer: a listed file named `a` is reachable by writing the
  // relative path `a`, with no exception for where it appears. All three spellings below
  // are the same file and all three are anchors.
  const withOneChar = new Set([...CHECKOUT, "a"]);
  const html = render("The Files window, not a tab. Open `a` instead, or ./a.", withOneChar);
  assert.match(html, anchor("a"), "bare, in running prose");
  assert.match(html, /<code><a class="workspace-path" href="a"/, "backticked");
  assert.match(html, anchor("./a"), "shell form");
  assert.equal(html.match(/workspace-path/g)?.length, 3);
});

test("a source location is carried into the href rather than cutting the path short", () => {
  const html = render("failing at src/App.tsx:42:7 today");
  assert.match(html, anchor("src/App.tsx:42:7"));
});

test("fenced code is left alone, so a diff or a file tree is not turned into links", () => {
  const html = render("```\nsrc/App.tsx\nREADME.md\n```");
  assert.doesNotMatch(html, /workspace-path/);
  assert.match(html, /<pre><code>/);
});

test("a link the agent actually wrote is not re-marked or nested", () => {
  const html = render("[the plan](docs/plans/session-card-legibility/plan.md)");
  assert.doesNotMatch(html, /workspace-path/);
  assert.equal(html.match(/<a /g)?.length, 1);
});

test("no listing and no handler each mean no path links at all", () => {
  // Before the listing lands - and for every surface with no session behind it, which is
  // plans, Foreman briefs and the Markdown file preview - the prose renders as it always
  // has. Marking a path up in a plan would offer a file nothing there can open.
  assert.doesNotMatch(render("see src/App.tsx", null), /workspace-path/);
  const noHandler = renderToStaticMarkup(createElement(Markdown, {
    children: "see src/App.tsx",
    filePaths: CHECKOUT,
  }));
  assert.doesNotMatch(noHandler, /workspace-path/);
});

test("the tree walker descends into prose and inline code, and stops at links and fences", () => {
  const tree = {
    type: "root",
    children: [
      { type: "element", tagName: "p", children: [{ type: "text", value: "a README.md b" }] },
      { type: "element", tagName: "code", children: [{ type: "text", value: "README.md" }] },
      { type: "element", tagName: "a", children: [{ type: "text", value: "README.md" }] },
      {
        type: "element",
        tagName: "pre",
        children: [
          { type: "element", tagName: "code", children: [{ type: "text", value: "README.md" }] },
        ],
      },
    ],
  };
  rehypeWorkspacePaths({ paths: new Set(["README.md"]) })(tree);
  interface Node { type: string; tagName?: string; children?: Node[] }
  const shape = (node: Node) => (node.children ?? []).map((child) => child.tagName ?? child.type);
  const [prose, inline, link, fence] = tree.children as Node[];
  assert.deepEqual(shape(prose!), ["text", "a", "text"]);
  assert.deepEqual(shape(inline!), ["a"]);
  assert.deepEqual(shape(link!), ["text"]);
  assert.deepEqual(shape(fence!.children![0]!), ["text"]);
});

test("a text node with no path in it is left as the same node, not rebuilt", () => {
  // The transcript re-renders on every SSE frame and the overwhelming majority of text
  // mentions no file. Splicing an identical replacement in would hand React a new node
  // each time and throw away the reconciliation this costs nothing to keep.
  const text = { type: "text", value: "no files named here at all" };
  const tree = { type: "root", children: [text] };
  rehypeWorkspacePaths({ paths: new Set(["src/App.tsx", "Makefile"]) })(tree);
  assert.equal(tree.children[0], text);
});

test("both transcript hosts hand the panel the store, so all three layouts link paths", () => {
  // An affordance added to SessionCard alone reaches one layout of three. The transcript
  // has exactly two mount sites - the grid's expanded card and the console/board detail -
  // and each has to pass the store, or the same conversation links its paths in one place
  // and renders them as dead text in the other.
  const card = readFileSync("src/web/components/SessionCard.tsx", "utf8");
  const detail = readFileSync("src/web/components/layouts/ConsoleDetail.tsx", "utf8");
  const shared = readFileSync("src/web/components/layouts/types.ts", "utf8");
  assert.match(card, /<TranscriptPanel[\s\S]*?files=\{files\}[\s\S]*?\/>/);
  assert.match(detail, /<TranscriptPanel[\s\S]*?files=\{view\.files\}[\s\S]*?\/>/);
  assert.match(shared, /files: p\.files,/);
});

test("the panel asks for the listing and hands it to the renderer", () => {
  const panel = readFileSync("src/web/components/TranscriptPanel.tsx", "utf8");
  assert.match(panel, /useWorkspacePaths\(files, sessionId, Boolean\(session\.cwd && onOpenFile\)\)/);
  assert.match(panel, /<Markdown breaks onLinkClick=\{onOpenFile\} filePaths=\{filePaths\}>/);
});

test("the link probe and the path index share one request; the Files tab publishes into it", () => {
  // The promise is that no two readers disagree about which files exist - NOT that the
  // daemon is asked once. Those are different claims and the code makes only the first.
  const store = readFileSync("src/web/lib/sessionFiles.ts", "utf8");
  // Shared: a written link's probe and the transcript's index come off one memoized
  // request, so neither can be answered from a listing the other has not seen.
  assert.match(store, /const probe = useCallback\([\s\S]*?listPaths\(sessionId\)/);
  assert.match(store, /const warmPaths = useCallback\([\s\S]*?listPaths\(sessionId\)/);
  // Not shared: the Files tab lists for itself, because it needs the entry rows and the
  // request-ordering guard that go with rendering a list. Three fetch sites, and the two
  // that are not `listPaths` must publish, or the tab's newer listing never reaches the
  // transcript and the two surfaces drift apart.
  assert.equal(store.match(/api\.listFiles\(/g)?.length, 3, "listPaths, ensure, refresh");
  assert.equal(store.match(/publishPaths\(sessionId, result\.files\)/g)?.length, 2, "ensure and refresh");
});

test("reopening a conversation refreshes its path index without blanking or racing Files", () => {
  // The first listing is only a checkout snapshot. An agent can create a report after the
  // transcript closes, so treating that set as durable makes the report path dead text on
  // the next open. Files appears to heal it because that tab performs a separate listing.
  const store = readFileSync("src/web/lib/sessionFiles.ts", "utf8");
  const from = store.indexOf("const warmPaths = useCallback(");
  assert.ok(from > 0, "warmPaths still exists");
  const warmBody = store.slice(from, store.indexOf("\n  const ", from + 1));
  assert.match(warmBody, /const previous = pathIndexRef\.current\[sessionId\]/);
  assert.match(
    warmBody,
    /if \(previous\) probeFiles\.current\.delete\(sessionId\)/,
    "a reopened conversation must not reuse the resolved listing promise",
  );
  assert.doesNotMatch(
    warmBody,
    /if \(pathIndexRef\.current\[sessionId\]\) return/,
    "an existing index is the reason to refresh, not a reason to skip it",
  );
  assert.match(
    warmBody,
    /if \(all\[sessionId\] !== previous\) return all/,
    "a slower conversation refresh must yield to a newer Files-tab listing",
  );
});

test("a path warm that lands after the session was dropped does not resurrect it", () => {
  // The race, in order: `warmPaths` starts a listing, the session leaves the fleet and
  // `drop` clears its state, then the listing resolves. Writing the index at that point
  // leaves a path set for a session nobody is showing, which nothing clears - `drop`
  // has already run - and which makes `warmPaths` skip its own fetch if the id is ever
  // reused, so the new transcript links against the OLD checkout's files.
  //
  // Guarding on "is the key still absent" cannot catch it: after `drop` it is absent by
  // design. The guard has to be the request generation, which is why `warmPaths` books
  // one and `drop` already calls `forgetSession`. Driven against the real class.
  const requests = new LatestFileRequests();
  const key = "s1\0paths";
  const inFlight = requests.begin(key);
  requests.forgetSession("s1");
  assert.equal(requests.isCurrent(key, inFlight), false, "the completion must be dropped");

  // And with the id reused, the newer warm owns the index while the older one stays dead.
  const reused = requests.begin(key);
  assert.equal(requests.isCurrent(key, inFlight), false);
  assert.equal(requests.isCurrent(key, reused), true);

  // Both halves have to be wired or the guard above is inert. Sliced to the function
  // body rather than matched across the file: `ensure` and `refresh` carry the same two
  // calls, so a loose pattern passes while `warmPaths` itself has no guard at all.
  const store = readFileSync("src/web/lib/sessionFiles.ts", "utf8");
  const from = store.indexOf("const warmPaths = useCallback(");
  assert.ok(from > 0, "warmPaths still exists");
  const warmBody = store.slice(from, store.indexOf("\n  const ", from + 1));
  assert.match(warmBody, /requests\.current\.begin\(key\)/, "warmPaths books a request");
  assert.match(
    warmBody,
    /if \(!requests\.current\.isCurrent\(key, request\)\) return;/,
    "and drops its own completion when that request is no longer current",
  );
  assert.match(
    store,
    /const drop = useCallback\(\(sessionId: string\) => \{\s*requests\.current\.forgetSession\(sessionId\)/,
    "drop invalidates this session's in-flight requests",
  );
});

test("a turn's markup survives the SSE frames arriving under it", () => {
  // Measured, not assumed: before this, every anchor in every turn was destroyed and
  // rebuilt a few times a second, because `components.a` was rebuilt inline on each
  // render and React unmounts a subtree whose element TYPE changed. The visible cost was
  // that a path link's tooltip could never finish opening - the element it was anchored
  // to stopped existing first - and the claim behind every written link was re-probed on
  // every frame. Two things keep it fixed, and each fails silently on its own.
  const source = readFileSync("src/web/components/Markdown.tsx", "utf8");
  assert.match(source, /const components = useMemo\(/, "the a component's identity must be stable");
  assert.match(source, /linkHandler\.current/, "the live handler is reached through a ref");

  // Same props, including the same handler: a hit, or the memo is decoration.
  const paths = new Set(["a.ts"]);
  const onLinkClick = () => true;
  const base = { children: "x", breaks: true, onLinkClick, filePaths: paths };
  assert.equal(markdownPropsEqual(base, { ...base }), true);
  // Everything that genuinely changes the output still re-renders.
  assert.equal(markdownPropsEqual(base, { ...base, children: "y" }), false, "new text");
  assert.equal(markdownPropsEqual(base, { ...base, breaks: false }), false, "breaks toggled");
  assert.equal(markdownPropsEqual(base, { ...base, filePaths: new Set(["a.ts"]) }), false, "new listing");
  assert.equal(markdownPropsEqual(base, { ...base, onLinkClick: undefined }), false, "handler removed");
  assert.equal(
    markdownPropsEqual(base, { ...base, diagramRenderers: FILES_DIAGRAM_RENDERERS }),
    false,
    "diagram capability enabled",
  );
  const withDiagrams = {
    ...base,
    diagramRenderers: FILES_DIAGRAM_RENDERERS,
    diagramDocumentKey: "docs/one.md",
  };
  assert.equal(
    markdownPropsEqual(withDiagrams, { ...withDiagrams, diagramDocumentKey: "docs/two.md" }),
    false,
    "new diagram document",
  );
});

test("a replaced link handler re-renders, so no anchor is left calling the old one", () => {
  // The body refreshes its handler ref DURING its own render, so skipping that render
  // with a new handler pins every rendered anchor to the previous closure - and that
  // closure carries App's `layout` and `sessions`. Switching layout with the transcript
  // text unchanged would then open the grid's Files overlay from Console.
  const paths = new Set(["a.ts"]);
  const base = { children: "x", breaks: true, onLinkClick: () => true, filePaths: paths };
  assert.equal(markdownPropsEqual(base, { ...base, onLinkClick: () => true }), false);

  // Which is only affordable because the caller hands down ONE wrapper rather than a
  // fresh closure per render. Both halves are required: compare identity without a
  // stable caller and the memo never hits; a stable caller without the comparison is
  // the staleness above.
  const panel = readFileSync("src/web/components/TranscriptPanel.tsx", "utf8");
  assert.match(panel, /openFileRef\.current = onOpenFile;/, "the ref tracks the live handler");
  assert.match(
    panel,
    /const openFile = useCallback<WorkspaceLinkHandler>\(\s*\(href, probe\) => openFileRef\.current\?\.\(href, probe\) \?\? false,\s*\[\],/,
    "and the wrapper handed down never changes identity",
  );
  assert.match(panel, /onOpenFile=\{linkHandler\}/, "turns receive the stable wrapper");
});
