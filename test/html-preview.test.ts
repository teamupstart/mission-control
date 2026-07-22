import { test } from "node:test";
import assert from "node:assert/strict";
import { htmlPreviewSource } from "../src/web/components/FileWorkspace.tsx";

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
