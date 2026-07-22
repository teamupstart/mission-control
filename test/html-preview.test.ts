import { test } from "node:test";
import assert from "node:assert/strict";
import { htmlPreviewSource, inlinePreviewStyles } from "../src/web/components/FileWorkspace.tsx";

test("HTML preview injects a restrictive CSP into an existing head", () => {
  const source = htmlPreviewSource("<!doctype html><html><head><title>x</title></head><body>ok</body></html>");
  assert.match(source, /Content-Security-Policy/);
  assert.match(source, /default-src 'none'/);
  assert.match(source, /connect-src 'none'/);
  assert.match(source, /form-action 'none'/);
  assert.ok(source.indexOf("Content-Security-Policy") < source.indexOf("<title>"));
});

test("HTML fragments are wrapped without enabling scripts or same-origin access", () => {
  const source = htmlPreviewSource("<h1>Hello</h1><script>alert(1)</script>");
  assert.match(source, /^<!doctype html><html><head>/);
  assert.doesNotMatch(source, /allow-scripts|allow-same-origin/);
});

test("checkout-local stylesheets are inlined without weakening the preview CSP", async () => {
  const reads: string[] = [];
  const source = '<html><head><link rel="stylesheet" href="theme.css"></head><body>ok</body></html>';
  const hydrated = await inlinePreviewStyles(source, "docs/mockups/index.html", async (path) => {
    reads.push(path);
    return ":root { --bg: #111; }";
  });
  assert.deepEqual(reads, ["docs/mockups/theme.css"]);
  assert.doesNotMatch(hydrated, /<link/);
  assert.match(hydrated, /data-mission-source="docs\/mockups\/theme\.css"/);
  assert.match(hydrated, /--bg: #111/);
  const preview = htmlPreviewSource(hydrated);
  assert.match(preview, /style-src 'unsafe-inline'/);
  assert.doesNotMatch(preview, /allow-same-origin|allow-scripts/);
});

test("remote stylesheets are neither fetched nor inlined", async () => {
  let read = false;
  const source = '<link rel="stylesheet" href="https://example.com/theme.css"><h1>ok</h1>';
  const hydrated = await inlinePreviewStyles(source, "index.html", async () => {
    read = true;
    return "";
  });
  assert.equal(read, false);
  assert.equal(hydrated, source);
});
