import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  MERMAID_MAX_DIAGRAMS,
  MERMAID_MAX_FRAME_HEIGHT,
  MERMAID_MAX_SOURCE_LENGTH,
  MERMAID_MIN_FRAME_HEIGHT,
  MERMAID_PREVIEW_SANDBOX,
  MERMAID_READY_MESSAGE,
  MERMAID_RENDERED_MESSAGE,
  acceptMermaidRendererMessage,
  clampMermaidFrameHeight,
  createMermaidRenderRequest,
  isPassiveMermaidSource,
  mermaidRendererUrl,
  normalizeMermaidPalette,
  parseMermaidRenderRequest,
  parseMermaidRendererMessage,
} from "../src/web/lib/mermaidPreview.ts";

const TOKEN = "12345678-1234-4123-8123-123456789abc";
const OTHER_TOKEN = "abcdef12-1234-4123-8123-123456789abc";
const PALETTE = {
  background: "#0a0c0f",
  surface: "#171c23",
  foreground: "#e7ebf1",
  muted: "#939eae",
  line: "#232a33",
  primary: "#4a9eff",
  success: "#35c08a",
  warning: "#f6a733",
  danger: "#f85149",
  secondary: "#a371f7",
};

test("the Mermaid bridge pins the approved resource and sandbox bounds", () => {
  assert.equal(MERMAID_PREVIEW_SANDBOX, "allow-scripts");
  assert.equal(MERMAID_MAX_SOURCE_LENGTH, 50_000);
  assert.equal(MERMAID_MAX_DIAGRAMS, 32);
  assert.equal(mermaidRendererUrl(TOKEN), `/mermaid-renderer.html#${TOKEN}`);
  assert.equal(clampMermaidFrameHeight(-1), MERMAID_MIN_FRAME_HEIGHT);
  assert.equal(clampMermaidFrameHeight(999_999), MERMAID_MAX_FRAME_HEIGHT);
});

test("renderer requests require a bounded source, ordinal, token, and allowlisted palette", () => {
  const request = createMermaidRenderRequest(TOKEN, "flowchart LR\nA --> B", 2, PALETTE);
  assert.ok(request);
  assert.deepEqual(parseMermaidRenderRequest(request, TOKEN), request);
  assert.equal(parseMermaidRenderRequest(request, OTHER_TOKEN), null);
  assert.equal(createMermaidRenderRequest(TOKEN, "x".repeat(MERMAID_MAX_SOURCE_LENGTH + 1), 1, PALETTE), null);
  assert.equal(createMermaidRenderRequest(TOKEN, "flowchart LR", MERMAID_MAX_DIAGRAMS + 1, PALETTE), null);
  assert.equal(normalizeMermaidPalette({ ...PALETTE, primary: "url(https://sentinel.invalid)" }), null);
});

test("renderer requests reject external assets and active destinations before Mermaid sees them", () => {
  for (const source of [
    'flowchart LR\nRemote@{ img: "/pixel.png", label: "Remote" }',
    'flowchart LR\nclick Remote "https://sentinel.invalid/click"',
    "flowchart LR\nA[![remote](/pixel.png)]",
    "flowchart LR\nA[https://sentinel.invalid]",
    'classDiagram\nlink ClassA "/relative-destination"',
    "flowchart LR\nA:::custom\nclassDef custom fill:url(/paint.svg)",
  ]) {
    assert.equal(isPassiveMermaidSource(source), false);
    assert.equal(createMermaidRenderRequest(TOKEN, source, 1, PALETTE), null);
  }
  assert.equal(isPassiveMermaidSource("flowchart LR\nA[Local label] --> B[Done]"), true);
});

test("renderer responses reject another frame, a non-opaque origin, and stale tokens", () => {
  const frame = {};
  const ready = { type: MERMAID_READY_MESSAGE, token: TOKEN };
  assert.deepEqual(
    acceptMermaidRendererMessage({ source: frame, origin: "null", data: ready }, frame, TOKEN),
    ready,
  );
  assert.equal(
    acceptMermaidRendererMessage({ source: {}, origin: "null", data: ready }, frame, TOKEN),
    null,
  );
  assert.equal(
    acceptMermaidRendererMessage({ source: frame, origin: "http://127.0.0.1:7317", data: ready }, frame, TOKEN),
    null,
  );
  assert.equal(parseMermaidRendererMessage({ ...ready, token: OTHER_TOKEN }, TOKEN), null);
  assert.deepEqual(
    parseMermaidRendererMessage({ type: MERMAID_RENDERED_MESSAGE, token: TOKEN, height: 50_000 }, TOKEN),
    { type: MERMAID_RENDERED_MESSAGE, token: TOKEN, height: MERMAID_MAX_FRAME_HEIGHT },
  );
});

test("the renderer document puts its no-network CSP before styles, markup, and script", () => {
  const html = readFileSync(fileURLToPath(new URL("../src/web/mermaid-renderer.html", import.meta.url)), "utf8");
  const csp = html.indexOf("Content-Security-Policy");
  assert.ok(csp > 0);
  assert.ok(csp < html.indexOf("<style>"));
  assert.ok(csp < html.indexOf("mission-mermaid-classic-script"));
  for (const directive of [
    "default-src 'none'",
    "connect-src 'none'",
    "script-src 'nonce-mission-mermaid-v1'",
    "style-src 'unsafe-inline'",
    "img-src 'none'",
    "font-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "navigate-to 'none'",
  ]) assert.match(html, new RegExp(directive.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("the child bridge validates its parent source and origin before parsing a tokened request", () => {
  const source = readFileSync(fileURLToPath(new URL("../src/web/mermaid-renderer.ts", import.meta.url)), "utf8");
  assert.doesNotMatch(source, /^import /m);
  assert.match(source, /event\.source !== window\.parent/);
  assert.match(source, /event\.origin !== expectedParentOrigin/);
  assert.match(source, /rendererRequest\(event\.data, token\)/);
  assert.doesNotMatch(source, /bindFunctions/);
});
