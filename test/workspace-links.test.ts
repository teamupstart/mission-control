import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectPathTokens,
  matchCheckoutPaths,
  pathDefaultsToPreview,
  markdownLinkUrl,
  workspaceAssetPath,
  workspaceFileTarget,
} from "../src/web/lib/workspaceLinks.ts";

const CWD = "/Users/jordan/work tree";

test("resolves the absolute Codex file-link shape inside the session checkout", () => {
  assert.deepEqual(
    workspaceFileTarget("/Users/jordan/work%20tree/docs/archive/mockups/feature-lab/index.html", CWD),
    { path: "docs/archive/mockups/feature-lab/index.html", line: null, column: null },
  );
});

test("resolves relative links and source locations", () => {
  assert.deepEqual(workspaceFileTarget("./src/App.tsx:42:7", CWD), {
    path: "src/App.tsx", line: 42, column: 7,
  });
  assert.deepEqual(workspaceFileTarget("README.md#L12C3", CWD), {
    path: "README.md", line: 12, column: 3,
  });
  const rootFiles = new Set(["README.md", "package.json", "readme.md", "Makefile"]);
  const exists = (path: string) => rootFiles.has(path);
  assert.deepEqual(workspaceFileTarget("README.md:12", CWD, exists), {
    path: "README.md", line: 12, column: null,
  });
  assert.deepEqual(workspaceFileTarget("package.json:12", CWD, exists), {
    path: "package.json", line: 12, column: null,
  });
  assert.deepEqual(workspaceFileTarget("readme.md:5:2", CWD, exists), {
    path: "readme.md", line: 5, column: 2,
  });
  assert.deepEqual(workspaceFileTarget("Makefile:9:2", CWD, exists), {
    path: "Makefile", line: 9, column: 2,
  });
});

test("does not claim external URLs, dashboard routes, or checkout escapes", () => {
  assert.equal(workspaceFileTarget("https://example.com/page.html", CWD), null);
  assert.equal(workspaceFileTarget("https://example.com:443/page.ts:12", CWD), null);
  assert.equal(workspaceFileTarget("https%3A%2F%2Fexample.com%2Fpage.ts%3A12", CWD), null);
  assert.equal(workspaceFileTarget("mailto:123", CWD), null);
  assert.equal(workspaceFileTarget("tel:123", CWD), null);
  assert.equal(workspaceFileTarget("sms%3A123", CWD), null);
  assert.equal(workspaceFileTarget("webcal:123", CWD), null);
  assert.equal(workspaceFileTarget("custom+viewer%3A456", CWD), null);
  assert.equal(workspaceFileTarget("custom.viewer:123", CWD), null);
  assert.equal(workspaceFileTarget("Tel:123", CWD), null);
  assert.deepEqual(workspaceFileTarget("custom.viewer:123", CWD, (path) => path === "custom.viewer"), {
    path: "custom.viewer", line: 123, column: null,
  });
  assert.equal(workspaceFileTarget("/api/sessions", CWD), null);
  assert.equal(workspaceFileTarget("/Users/jordan/other/page.html", CWD), null);
  assert.equal(workspaceFileTarget("../../secret.txt", CWD), null);
});

test("allows external protocols through Markdown while blocking active-content URLs", () => {
  for (const href of ["webcal:123", "tel:123", "sms:456", "geo:1,2", "ftp://example.com/a"]) {
    assert.equal(markdownLinkUrl(href), href);
  }
  for (const href of ["javascript:alert(1)", "java\nscript:alert(1)", "data:text/html,x", "file:///tmp/x"]) {
    assert.equal(markdownLinkUrl(href), "");
  }
});

test("HTML and Markdown default to preview without treating ordinary source as previewable", () => {
  for (const path of ["index.html", "page.HTM", "README.md", "guide.markdown", "old.mdown"]) {
    assert.equal(pathDefaultsToPreview(path), true, path);
  }
  assert.equal(pathDefaultsToPreview("src/App.tsx"), false);
});

test("bare path detection spans the token an agent typed, punctuation excluded", () => {
  const text = "Written up at `docs/plans/x/plan.md`, and the page beside it (docs/plans/x/plan.html).";
  assert.deepEqual(
    detectPathTokens(text).map((token) => [token.raw, token.start, token.end]),
    [
      ["docs/plans/x/plan.md", 15, 35],
      ["docs/plans/x/plan.html", 62, 84],
    ],
  );
  // The span has to be exactly the path: rebuilding the string around it is how every
  // caller renders the surrounding prose, so an off-by-one eats a character of it.
  for (const token of detectPathTokens(text)) {
    assert.equal(text.slice(token.start, token.end), token.raw);
  }
});

test("a source location rides with the path instead of hiding it", () => {
  assert.deepEqual(detectPathTokens("see src/App.tsx:42:7 for it"), [
    { path: "src/App.tsx", line: 42, column: 7, raw: "src/App.tsx:42:7", start: 4, end: 20 },
  ]);
  assert.deepEqual(detectPathTokens("README.md:12 says so"), [
    { path: "README.md", line: 12, column: null, raw: "README.md:12", start: 0, end: 12 },
  ]);
  // A clock reading is not a file, and nothing about `12` is path-shaped.
  assert.deepEqual(detectPathTokens("ran at 12:30 today"), []);
});

test("prose that merely looks path-ish is not offered as a file", () => {
  const text = [
    "e.g. this and/or that, vs. those; ../escape.ts and /abs/file.ts and C:\\win\\x.ts",
    "https://example.test/a.ts and release.v2 and plain words",
  ].join(" ");
  assert.deepEqual(detectPathTokens(text).map((token) => token.path), ["and/or"]);
});

test("a checkout listing links the names a shape rule has to guess wrong about", () => {
  // The three kinds nothing in a token's SHAPE can vouch for. They are ordinary files an
  // agent names as often as any other, and a matcher that asks the checkout instead of
  // guessing has no reason to miss them.
  const checkout = new Set(["Makefile", ".env", "docs/My Plan.md", "gradlew", "src/App.tsx"]);
  const found = (text: string) => matchCheckoutPaths(text, checkout).map((t) => t.raw);
  assert.deepEqual(found("run make against the Makefile first"), ["Makefile"]);
  assert.deepEqual(found("secrets live in .env, not in git"), [".env"]);
  assert.deepEqual(found("see docs/My Plan.md for the shape"), ["docs/My Plan.md"]);
  // `./x` is the form agents type at a shell. The rendered text keeps it; the path it
  // resolves to is the listed one, exactly as a written link's href would normalize.
  assert.deepEqual(found("./gradlew build"), ["./gradlew"]);
  assert.deepEqual(matchCheckoutPaths("./gradlew build", checkout).map((t) => t.path), ["gradlew"]);
  // And the shape-only matcher, which is what the ensemble scorecard is stuck with,
  // demonstrably cannot: this is why the transcript does not use it.
  for (const text of ["the Makefile first", "in .env, not", "docs/My Plan.md for"]) {
    assert.notDeepEqual(detectPathTokens(text).map((t) => t.raw), found(text), text);
  }
});

test("membership decides, so prose and near-misses stay prose", () => {
  const checkout = new Set(["src/App.tsx", "README.md", "a", "notes.md", "notes.md.bak"]);
  const found = (text: string) => matchCheckoutPaths(text, checkout).map((t) => t.raw);
  // Path-shaped but absent, and present but only as a fragment of a longer word.
  assert.deepEqual(found("compare src/Missing.tsx with notes/other.md"), []);
  assert.deepEqual(found("src/App.tsxx and xsrc/App.tsx are other files"), []);
  // Longest match wins, so a name is never linked as a prefix of the one that was written.
  assert.deepEqual(found("open notes.md.bak now"), ["notes.md.bak"]);
  assert.deepEqual(found("open notes.md now"), ["notes.md"]);
  // Surrounding punctuation is peeled, one character at a time.
  assert.deepEqual(found("(README.md), and `src/App.tsx`."), ["README.md", "src/App.tsx"]);
});

test("a one-character file is reachable however it is written, prose included", () => {
  // Membership is the only test. No length rule, so nothing in the listing is unreachable
  // - a hole in that set is a file the operator can see in the Files tab and cannot click
  // to from the conversation that named it. A bare `a` in prose IS the relative path `a`,
  // and it links.
  const checkout = new Set(["a", "Q.md", "x/y", "d/a"]);
  const found = (text: string) => matchCheckoutPaths(text, checkout).map((t) => t.raw);
  assert.deepEqual(found("open a now"), ["a"], "bare, in running prose");
  assert.deepEqual(found("open ./a now"), ["./a"], "shell form");
  assert.deepEqual(found("see a:3 for it"), ["a:3"], "with a source location");
  assert.deepEqual(found("open d/a now"), ["d/a"], "inside a directory");
  assert.deepEqual(found("read Q.md and x/y"), ["Q.md", "x/y"]);
});

test("what a one-character file costs is paid in prose, and boundaries still hold", () => {
  // The honest consequence, pinned so nobody has to rediscover it: in a checkout that
  // really contains a file named `a`, English articles link too - measured at 71 of 94
  // links on one screen. Every one of those links is CORRECT, in that it opens a file
  // that exists, which is why this is the trade taken rather than a hole in the set.
  const checkout = new Set(["a"]);
  const found = (text: string) => matchCheckoutPaths(text, checkout).map((t) => t.raw);
  assert.deepEqual(found("the Files window, not a tab"), ["a"]);
  assert.deepEqual(found("a thing and a half"), ["a", "a"]);
  // Word boundaries are the only thing keeping that bounded, and they still do their job:
  // the letter is never matched inside a longer word.
  assert.deepEqual(found("catamaran assay abracadabra"), []);
  assert.deepEqual(found("cat sat on a mat"), ["a"]);
});

test("punctuation is peeled from both ends, however deeply a path is nested", () => {
  // The two ends used to disagree - trailing looped, leading peeled exactly one - so
  // `(README.md)` resolved and `([README.md])` did not. Nesting like that is ordinary in
  // prose and in Markdown, and the asymmetry made the difference invisible from outside.
  const checkout = new Set(["README.md", "src/App.tsx"]);
  const found = (text: string) => matchCheckoutPaths(text, checkout).map((t) => t.raw);
  assert.deepEqual(found("see ([README.md]) there"), ["README.md"]);
  assert.deepEqual(found('run ("src/App.tsx") now'), ["src/App.tsx"]);
  assert.deepEqual(found("{`README.md`} and [[README.md]]"), ["README.md", "README.md"]);
  // Peeling stops at the first character that is not punctuation, so advancing the start
  // still never enters a word - the boundary guarantee the whole matcher rests on.
  assert.deepEqual(matchCheckoutPaths("catamaran", new Set(["a"])), []);
  assert.deepEqual(matchCheckoutPaths("(a)", new Set(["a"])).map((t) => t.raw), ["a"]);
});

test("an absolute path is never read as the listed file with its slash removed", () => {
  // Found in a live transcript: an inline `</a>` peeled down to the substring `/a` and
  // linked a file named `a`, because path normalization drops an empty leading segment
  // just like any other. The href it produced was absolute, which the checkout resolver
  // then refused - a link that looks live and does nothing.
  const checkout = new Set(["a", "etc/passwd", "src/App.tsx"]);
  const found = (text: string) => matchCheckoutPaths(text, checkout).map((t) => t.raw);
  // Nothing at all: the leading `<` peels, but what is behind it is `/a`, an absolute
  // path - and the bare `a` inside the tag is not at a word boundary, so it is not a
  // candidate either. Both guards have to hold for this to come out empty.
  assert.deepEqual(found("the tag </a> closes it"), []);
  assert.deepEqual(found("read /etc/passwd now"), []);
  assert.deepEqual(found("/src/App.tsx is absolute"), []);
  // The relative spellings of the same files are unaffected.
  assert.deepEqual(found("read etc/passwd now"), ["etc/passwd"]);
  assert.deepEqual(found("read ./etc/passwd now"), ["./etc/passwd"]);
});

test("a listing-matched path keeps its source location", () => {
  const checkout = new Set(["src/App.tsx"]);
  assert.deepEqual(matchCheckoutPaths("failing at src/App.tsx:42:7 today", checkout), [
    { path: "src/App.tsx", line: 42, column: 7, raw: "src/App.tsx:42:7", start: 11, end: 27 },
  ]);
});

test("HTML assets resolve from the document directory but cannot escape the checkout", () => {
  assert.equal(
    workspaceAssetPath("theme.css?v=2", "docs/archive/mockups/feature-lab/index.html"),
    "docs/archive/mockups/feature-lab/theme.css",
  );
  assert.equal(
    workspaceAssetPath("../theme.css", "docs/archive/mockups/feature-lab/index.html"),
    "docs/archive/mockups/theme.css",
  );
  assert.equal(workspaceAssetPath("../../../../secret.css", "docs/archive/mockups/index.html"), null);
  assert.equal(workspaceAssetPath("https://example.com/theme.css", "docs/archive/mockups/index.html"), null);
});
