import { mkdirSync } from "node:fs";
import type { Locator } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";

/**
 * The workflow minimap is painted through tokens, so a skin repaints a minimap that is
 * already on screen.
 *
 * React Flow writes a `nodeColor` result as an inline `fill` on each minimap rect, which no
 * stylesheet can override: a skin chosen while a canvas is mounted would leave the minimap on
 * the old colours until something re-rendered it. The canvas now names its rects by class and
 * `styles.css` fills them from `--canvas-minimap-node` and `--canvas-minimap-fail`; its mask
 * reads `--canvas-minimap-mask` through React Flow's own variable. Only a browser can show
 * the cascade reaching the SVG of a live React Flow instance, and that the same elements
 * repaint rather than a remount drawing new ones.
 */

const EVIDENCE = artifactsDir("workflow-minimap-tokens");
const BUILTIN_BUTTON = /^No-Mistakes Review \(High Rigor\)\s*built-in\b/i;

async function shoot(target: Locator, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await target.scrollIntoViewIfNeeded();
  await target.screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/workflow-minimap-tokens/${name}.png`);
}

test("a mounted workflow minimap repaints from its tokens without a re-render", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.goto(`${daemon.baseURL}/#/library`);
  await dashboard.getByRole("button", { name: BUILTIN_BUTTON }).click();
  await dashboard.getByRole("button", { name: "Graph", exact: true }).click();

  const minimap = dashboard.getByRole("img", { name: "Workflow minimap" });
  await expect(minimap).toBeVisible();
  const nodes = minimap.locator("rect.react-flow__minimap-node");
  await expect(nodes.first()).toBeAttached();
  const count = await nodes.count();
  expect(count, "the built-in workflow draws its nodes in the minimap").toBeGreaterThan(1);

  // Today's look: every rect is named by class, carries no inline colour, and resolves its
  // fill from the token - which still holds the colour the canvas used to pass inline.
  const before = await nodes.evaluateAll((rects) => {
    const root = getComputedStyle(document.documentElement);
    return {
      token: root.getPropertyValue("--canvas-minimap-node").trim(),
      classed: rects.every((rect) => rect.classList.contains("workflow-minimap-node")),
      inline: rects.map((rect) => (rect as SVGRectElement).style.fill).filter(Boolean),
      fills: [...new Set(rects.map((rect) => getComputedStyle(rect).fill))],
    };
  });
  expect(before.token).toBe("#76849b");
  expect(before.classed, "every minimap rect carries the token-driven class").toBe(true);
  expect(before.inline, "no minimap rect has an inline fill a skin could not override").toEqual([]);
  expect(before.fills).toEqual(["rgb(118, 132, 155)"]);
  const mask = minimap.locator("path.react-flow__minimap-mask");
  await expect(mask).toHaveCSS("fill", "rgba(240, 240, 240, 0.6)");
  await shoot(minimap, "minimap-default");

  // Mark the live elements, so the assertions below can tell a repaint of these rects from a
  // remount that drew new ones.
  await nodes.evaluateAll((rects) => {
    for (const rect of rects) (rect as Element & { __tokenProbe?: true }).__tokenProbe = true;
  });

  // What a skin does: override tokens on :root. Nothing in React is told about it.
  await dashboard.evaluate(() => {
    const root = document.documentElement.style;
    root.setProperty("--canvas-minimap-node", "rgb(201, 52, 168)");
    root.setProperty("--canvas-minimap-fail", "rgb(12, 190, 214)");
    root.setProperty("--canvas-minimap-mask", "rgba(20, 40, 60, 0.5)");
  });

  await expect(nodes.first()).toHaveCSS("fill", "rgb(201, 52, 168)");
  const after = await nodes.evaluateAll((rects) => ({
    sameElements: rects.every((rect) => (rect as Element & { __tokenProbe?: true }).__tokenProbe === true),
    fills: [...new Set(rects.map((rect) => getComputedStyle(rect).fill))],
  }));
  expect(after.sameElements, "the repaint reached the mounted rects; nothing remounted").toBe(true);
  expect(after.fills).toEqual(["rgb(201, 52, 168)"]);
  expect(await nodes.count()).toBe(count);
  await expect(mask).toHaveCSS("fill", "rgba(20, 40, 60, 0.5)");

  // A failed node takes the fail token through the same rule. The class is what
  // `minimapNodeClassName` gives a node whose runtime class names a failure.
  const failed = nodes.first();
  await failed.evaluate((rect) => rect.classList.add("is-fail"));
  await expect(failed).toHaveCSS("fill", "rgb(12, 190, 214)");
  await failed.evaluate((rect) => rect.classList.remove("is-fail"));
  await shoot(minimap, "minimap-token-override");

  // Removing the override returns the mounted minimap to the default look.
  await dashboard.evaluate(() => {
    const root = document.documentElement.style;
    root.removeProperty("--canvas-minimap-node");
    root.removeProperty("--canvas-minimap-fail");
    root.removeProperty("--canvas-minimap-mask");
  });
  await expect(nodes.first()).toHaveCSS("fill", "rgb(118, 132, 155)");
  await expect(mask).toHaveCSS("fill", "rgba(240, 240, 240, 0.6)");
});
