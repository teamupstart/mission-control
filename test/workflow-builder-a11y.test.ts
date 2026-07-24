import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const canvas = readFileSync(new URL("../src/web/workflows/WorkflowCanvas.tsx", import.meta.url), "utf8");
const node = readFileSync(new URL("../src/web/workflows/WorkflowNode.tsx", import.meta.url), "utf8");
const library = readFileSync(new URL("../src/web/workflows/WorkflowLibrary.tsx", import.meta.url), "utf8");
const runs = readFileSync(new URL("../src/web/workflows/WorkflowRuns.tsx", import.meta.url), "utf8");
const page = readFileSync(new URL("../src/web/workflows/WorkflowPage.tsx", import.meta.url), "utf8");
const properties = readFileSync(new URL("../src/web/workflows/WorkflowProperties.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../src/web/styles.css", import.meta.url), "utf8");

test("builder exposes semantic names, roving focus, live state, and focus restoration", () => {
  assert.match(canvas, /focusable: node\.id === focusNodeId/);
  assert.match(canvas, /incoming connections/);
  assert.match(canvas, /outgoing connections/);
  assert.match(canvas, /ariaLabel="Workflow minimap"/);
  assert.match(node, /aria-description/);
  assert.match(node, /aria-label="Pass output"/);
  assert.match(node, /aria-label="Fail output"/);
  assert.match(library, /aria-live="polite"/);
  assert.match(library, /role="group"/);
  assert.match(library, /connectTrigger\.current\?\.focus/);
  assert.match(library, /aria-live="assertive"/);
  assert.match(runs, /role="alert"/);
  assert.match(runs, /aria-live="assertive"/);
  assert.match(page, /role="tablist"/);
  assert.match(page, /role="tab"/);
  assert.match(page, /role="tabpanel"/);
  assert.match(page, /event\.key === "ArrowRight"/);
  assert.match(properties, /<span tabIndex=\{0\}>/);
  assert.match(properties, /aria-label=\{`Remove \$\{edge\.sourcePort\} connection/);
});

test("workflow meaning is not color-only and reduced motion is honored", () => {
  assert.match(node, /runtimeStatus\.replaceAll/);
  assert.match(styles, /\.workflow-runtime-fail \.workflow-node::before/);
  assert.match(styles, /content: "!"/);
  assert.match(styles, /\.workflow-edge-fail path \{ stroke: var\(--danger\); stroke-dasharray:/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(styles, /\.workflow-port-label/);
  assert.match(styles, /\.workflow-node:focus-within/);
});
