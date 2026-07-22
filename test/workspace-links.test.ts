import { test } from "node:test";
import assert from "node:assert/strict";
import {
  pathDefaultsToPreview,
  markdownLinkUrl,
  workspaceAssetPath,
  workspaceFileTarget,
} from "../src/web/lib/workspaceLinks.ts";

const CWD = "/Users/jordan/work tree";

test("resolves the absolute Codex file-link shape inside the session checkout", () => {
  assert.deepEqual(
    workspaceFileTarget("/Users/jordan/work%20tree/docs/mockups/feature-lab/index.html", CWD),
    { path: "docs/mockups/feature-lab/index.html", line: null, column: null },
  );
});

test("resolves relative links and source locations", () => {
  assert.deepEqual(workspaceFileTarget("./src/App.tsx:42:7", CWD), {
    path: "src/App.tsx", line: 42, column: 7,
  });
  assert.deepEqual(workspaceFileTarget("README.md#L12C3", CWD), {
    path: "README.md", line: 12, column: 3,
  });
  assert.deepEqual(workspaceFileTarget("README.md:12", CWD), {
    path: "README.md", line: 12, column: null,
  });
  assert.deepEqual(workspaceFileTarget("package.json:12", CWD), {
    path: "package.json", line: 12, column: null,
  });
  assert.deepEqual(workspaceFileTarget("readme.md:5:2", CWD), {
    path: "readme.md", line: 5, column: 2,
  });
  assert.deepEqual(workspaceFileTarget("Makefile:9:2", CWD), {
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

test("HTML assets resolve from the document directory but cannot escape the checkout", () => {
  assert.equal(
    workspaceAssetPath("theme.css?v=2", "docs/mockups/feature-lab/index.html"),
    "docs/mockups/feature-lab/theme.css",
  );
  assert.equal(
    workspaceAssetPath("../theme.css", "docs/mockups/feature-lab/index.html"),
    "docs/mockups/theme.css",
  );
  assert.equal(workspaceAssetPath("../../../../secret.css", "docs/mockups/index.html"), null);
  assert.equal(workspaceAssetPath("https://example.com/theme.css", "docs/mockups/index.html"), null);
});
