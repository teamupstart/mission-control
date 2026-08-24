import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
// The preview boundary moved out of the Files component into one shared module when Scouts
// became a second surface rendering untrusted HTML. These assertions are unchanged: they are
// the contract BOTH surfaces now inherit, so they must keep passing from their new home.
import {
  HTML_PREVIEW_SANDBOX,
  htmlPreviewSource,
  inlinePreviewStyles,
} from "../src/web/lib/htmlPreview.ts";

/** One emitted bridge, found by a string only it contains. */
function bridgeContaining(marker: string): string {
  const bridge = [...htmlPreviewSource("ok").matchAll(/<script>([^<]+)<\/script>/g)]
    .map((match) => match[1]!)
    .find((script) => script.includes(marker));
  assert.ok(bridge, `no bridge contains ${marker}`);
  return bridge;
}

test("HTML preview prefixes a restrictive CSP before an existing head", () => {
  const source = htmlPreviewSource("<!doctype html><html><head><title>x</title></head><body>ok</body></html>");
  assert.match(source, /Content-Security-Policy/);
  assert.match(source, /default-src 'none'/);
  assert.match(source, /connect-src 'none'/);
  assert.match(source, /form-action 'none'/);
  assert.match(source, /navigate-to 'none'/);
  assert.ok(source.indexOf("Content-Security-Policy") < source.indexOf("<title>"));
});

test("every injected bridge is hash-authorized, and nothing else is", () => {
  // Recomputed from the emitted scripts rather than copied from the constants, so a
  // bridge edited without its hash - which fails invisibly, as a bridge that simply
  // does not run - fails HERE instead.
  //
  // THREE since the comment bridge landed. The extraction regex stops at the first `<`, so
  // this also pins the constraint that keeps it working: no bridge body may contain a
  // literal `<`. A comparison operator in one would truncate that script here and produce a
  // hash mismatch - which is the loud failure, and far better than the quiet one.
  const source = htmlPreviewSource("ok");
  const scripts = [...source.matchAll(/<script>([^<]+)<\/script>/g)].map((match) => match[1]!);
  assert.equal(scripts.length, 3);
  for (const script of scripts) assert.doesNotMatch(script, /</, "no bridge contains a literal <");
  const allowed = [...source.matchAll(/'sha256-([^']+)'/g)].map((match) => match[1]!);
  const hashes = scripts.map((script) => createHash("sha256").update(script).digest("base64"));
  assert.deepEqual(allowed.toSorted(), hashes.toSorted());
});

test("HTML fragments stay opaque and authorize only the three bridges", () => {
  const source = htmlPreviewSource("<h1>Hello</h1><script>alert(1)</script>");
  assert.match(source, /^<!doctype html><meta http-equiv="Content-Security-Policy"/);
  assert.doesNotMatch(source, /allow-same-origin/);
  assert.match(source, /event\.source===parent/);
  assert.match(source, /mission:file-preview-scroll/);
  assert.match(source, /mission:file-preview-link/);
  assert.match(source, /mission:file-preview-comment/);
  assert.match(source, /mission:file-preview-block/);
  assert.match(source, /mission:file-preview-ready/);
});

test("the comment bridge announces itself, so arming it is never a guess about timing", () => {
  // A `srcdoc` document can fire a load event for the `about:blank` before it, so a parent
  // arming on load alone can post into a window that is about to be replaced - and the
  // message is lost with it, leaving comment mode on in the toolbar and off in the frame.
  // The ping is the LAST statement in the bridge, so it cannot be sent before the listeners
  // above it are installed.
  const bridge = bridgeContaining("mission:file-preview-block");
  assert.match(bridge, /parent\.postMessage\(\{type:"mission:file-preview-ready"\}," ?\*"\)$/);
});

test("the sandbox is one exported constant, and it grants scripts and nothing else", () => {
  // The whole reason `HTML_PREVIEW_SANDBOX` is exported rather than written at each iframe:
  // a token added here is a token added to Files AND to Scouts, so it can only be added on
  // purpose. `allow-scripts` alone runs the three hashed bridges.
  assert.equal(HTML_PREVIEW_SANDBOX, "allow-scripts");
});

test("the comment bridge is inert until the parent that owns the frame enables it", () => {
  const bridge = bridgeContaining("mission:file-preview-comment");
  // Armed only by a message from `parent`, which is the same test the scroll bridge makes.
  // Scouts never sends it, so an archived report behaves exactly as it did before this
  // bridge existed - and no other frame or extension can arm it either.
  assert.match(bridge, /event\.source!==parent/);
  assert.match(bridge, /missionCommenting=event\.data\.enabled===true/);
  // Every click path begins by checking that flag, so with comment mode off the bridge does
  // not even look at where the click landed.
  assert.match(bridge, /"click",event=>\{if\(!missionCommenting\)return/);
});

test("the comment bridge reports a structural path and never any text", () => {
  const bridge = bridgeContaining("mission:file-preview-block");
  // The path is element indices with tag names, walked up to `document.body` and no further.
  // Starting at body is what makes it independent of the CSP meta, these three scripts, and
  // a stylesheet this module inlined - all of which land in `<head>`.
  assert.match(bridge, /node!==document\.body/);
  assert.match(bridge, /index:\[\.\.\.owner\.children\]\.indexOf\(node\)/);
  assert.match(bridge, /tag:node\.tagName\.toLowerCase\(\)/);
  // Nothing that could carry document content up. A resolver that searched the source for a
  // block's words would refuse most real blocks; see `resolveHtmlBlockAnchor`.
  assert.doesNotMatch(bridge, /textContent|innerText|innerHTML|outerHTML/);
  // No new capability: it reads its own document and posts to its own parent. No fetch, no
  // navigation, no storage, no token.
  assert.doesNotMatch(bridge, /fetch|XMLHttpRequest|location|localStorage|sessionStorage|cookie/);
});

test("the comment bridge takes the click before the link bridge can navigate it", () => {
  // Both listen on `document` in the capture phase, so registration order IS the behaviour:
  // `stopImmediatePropagation` only reaches listeners registered after this one. A paragraph
  // containing a link therefore takes a comment while comment mode is on.
  const source = htmlPreviewSource("ok");
  assert.ok(
    source.indexOf("mission:file-preview-comment") < source.indexOf("mission:file-preview-link"),
    "the comment bridge is injected before the link bridge",
  );
  const bridge = bridgeContaining("mission:file-preview-block");
  assert.match(bridge, /event\.preventDefault\(\);event\.stopImmediatePropagation\(\)/);
});

test("the link bridge claims authored navigation before scrolling fragments or posting links", () => {
  const source = htmlPreviewSource("ok");
  const bridge = [...source.matchAll(/<script>([^<]+)<\/script>/g)]
    .map((match) => match[1]!)
    .find((script) => script.includes("mission:file-preview-link"));
  assert.ok(bridge);
  // Every authored navigation is claimed before it is classified: fragments scroll inside
  // the document, while non-fragments cross the parent bridge instead of navigating it.
  assert.match(
    bridge,
    /preventDefault\(\).*startsWith\("#"\).*if\(!raw\).*scrollTo\(\{top:0\}\).*scrollIntoView\(\).*postMessage\(.*mission:file-preview-link/s,
  );
});

test("a head-looking comment cannot swallow the preview CSP or its bridges", () => {
  const hostile = '<!-- <head> --><script>fetch("https://example.com/leak")</script>';
  const source = htmlPreviewSource(hostile);
  assert.ok(source.indexOf("Content-Security-Policy") < source.indexOf(hostile));
  assert.ok(source.indexOf("mission:file-preview-scroll") < source.indexOf(hostile));
  assert.ok(source.indexOf("mission:file-preview-link") < source.indexOf(hostile));
});

test("checkout-local stylesheets are inlined without weakening the preview CSP", async () => {
  const reads: string[] = [];
  const source = '<html><head><link rel="stylesheet" href="theme.css"></head><body>ok</body></html>';
  const hydrated = await inlinePreviewStyles(source, "docs/archive/mockups/index.html", async (path) => {
    reads.push(path);
    return ":root { --bg: #111; }";
  });
  assert.deepEqual(reads, ["docs/archive/mockups/theme.css"]);
  assert.doesNotMatch(hydrated, /<link/);
  assert.match(hydrated, /data-mission-source="docs\/archive\/mockups\/theme\.css"/);
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
