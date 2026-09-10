import { before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertElectronGuiLaunchAllowed } from "./helpers/electron-gui.ts";

const require = createRequire(import.meta.url);

/**
 * Backstop for a hung browser, NOT an assertion about how fast one starts.
 *
 * These two cases launch a real Electron GUI, which is the only way to measure laid-out
 * geometry. That launch is cheap on Linux CI and expensive on a developer's Mac, where the
 * runner also keeps a second test file in flight: measured here, ~10s idle and past 40s under
 * that contention, against a former 20s deadline. The deadline firing produced a bare
 * ETIMEDOUT, which reads as the layout defect this test exists to catch rather than as a busy
 * machine. Keep it far above the honest cost - a real hang still fails, just later.
 */
const ELECTRON_TIMEOUT_MS = 240_000;

before(() => {
  assertElectronGuiLaunchAllowed();
});

/** Run one Electron fixture in a throwaway profile and return its stdout. */
function runElectronFixture(args: string[]): string {
  const electron = require("electron") as string;
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const userData = mkdtempSync(join(tmpdir(), "mission-workflow-browser-"));
  try {
    return execFileSync(electron, [
      ...(process.platform === "linux" ? ["--no-sandbox"] : []),
      `--user-data-dir=${userData}`,
      ...args,
    ], { encoding: "utf8", env, timeout: ELECTRON_TIMEOUT_MS });
  } finally {
    rmSync(userData, { force: true, recursive: true });
  }
}

/**
 * Here rather than in `e2e/` because a headless browser reserves zero for every scroller
 * however it is styled, so only a real window can measure this.
 */
test("the pipeline strip reserves a visible scrollbar the platform would not have drawn", () => {
  const output = runElectronFixture([
    fileURLToPath(new URL("fixtures/pipeline-strip-scrollbar-browser.cjs", import.meta.url)),
    fileURLToPath(new URL("../src/web/styles.css", import.meta.url)),
  ]);
  const { strip, plain, fits } = JSON.parse(output.trim()) as {
    strip: { reserved: number; overflow: number };
    plain: { reserved: number; overflow: number };
    fits: { reserved: number; overflow: number };
  };

  // Both scrollers hold more than they can show, so a scrollbar is due in each.
  assert.ok(strip.overflow > 0, "the measured strip must overflow for a scrollbar to be due");
  assert.ok(plain.overflow > 0, "the control strip must overflow too");

  const measured = `strip ${strip.reserved}px, control ${plain.reserved}px`;
  assert.equal(
    strip.reserved,
    10,
    `\`.wf-pipeline-strip\` must reserve its scrollbar track (${measured})`,
  );
  // The control is what makes the height above mean something, and it cannot be a fixed
  // number: this runs on macOS, whose overlay scrollbars reserve 0, and on Linux CI, whose
  // classic ones reserve 15. What holds on both is that the strip's track is the height the
  // product asked for and NOT whatever the platform would have done unasked - so deleting the
  // rule makes the two equal and fails here, on either platform.
  assert.notEqual(
    strip.reserved,
    plain.reserved,
    `the rule, not the platform, must decide the strip's track (${measured})`,
  );

  // A pipeline that fits pays nothing for the scrollbar. The track is reserved on overflow
  // only, so any padding trimmed to offset it would come straight out of this case's height.
  assert.equal(fits.overflow, 0, "the single-card strip must not overflow");
  assert.equal(
    fits.reserved,
    0,
    `a strip that fits its pane must reserve no track (${fits.reserved}px)`,
  );
});

test("published workflow nodes stay within the visible React Flow graph", () => {
  const output = runElectronFixture([
    fileURLToPath(new URL("fixtures/workflow-graph-browser.cjs", import.meta.url)),
    fileURLToPath(new URL("../src/web/styles.css", import.meta.url)),
    require.resolve("@xyflow/react/dist/style.css"),
  ]);
  const { graph, root, nodes } = JSON.parse(output.trim()) as {
    graph: DOMRect;
    root: DOMRect;
    nodes: DOMRect[];
  };

  assert.ok(root.height > 0, "React Flow root must have a visible height");
  assert.ok(nodes.length > 0, "published graph must render nodes");
  for (const node of nodes) {
    assert.ok(node.top >= graph.top && node.bottom <= graph.bottom, "published node must remain inside the visible graph");
    assert.ok(node.top >= root.top && node.bottom <= root.bottom, "published node must remain inside the React Flow root");
  }
});

test("editable workflow canvas remains mounted with default node statuses", () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "mission-workflow-canvas-"));
  const bundlePath = join(fixtureDir, "canvas.js");
  const htmlPath = join(fixtureDir, "index.html");
  let output: string;
  try {
    execFileSync(require.resolve("esbuild/bin/esbuild"), [
      fileURLToPath(new URL("fixtures/workflow-canvas-mount.tsx", import.meta.url)),
      "--bundle",
      "--platform=browser",
      "--format=iife",
      `--outfile=${bundlePath}`,
    ], { encoding: "utf8" });
    writeFileSync(htmlPath, '<!doctype html><div id="root" style="width:800px;height:600px"></div><script src="./canvas.js"></script>');
    output = runElectronFixture([
      fileURLToPath(new URL("fixtures/workflow-canvas-mount-browser.cjs", import.meta.url)),
      htmlPath,
    ]);
  } finally {
    rmSync(fixtureDir, { force: true, recursive: true });
  }

  const result = JSON.parse(output.trim()) as {
    mounted: boolean;
    errors: string[];
    controls: string[];
    nativeTitles: number;
    attribution: boolean;
    maxZoomDisabled: boolean;
    maxZoomDescription: string;
    minZoomDisabled: boolean;
    minZoomDescription: string;
  };
  assert.deepEqual(result.errors, []);
  assert.equal(result.mounted, true);
  assert.deepEqual(result.controls, [
    "Zoom in",
    "Zoom out",
    "Fit the graph to view",
    "Reset canvas zoom",
  ]);
  assert.equal(result.nativeTitles, 0);
  assert.equal(result.attribution, true);
  assert.equal(result.maxZoomDisabled, true);
  assert.equal(result.maxZoomDescription, "Already at maximum zoom");
  assert.equal(result.minZoomDisabled, true);
  assert.equal(result.minZoomDescription, "Already at minimum zoom");
});
