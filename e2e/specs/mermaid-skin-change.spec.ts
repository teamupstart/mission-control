import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Frame, Page, Route } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * A Mermaid diagram already on screen repaints when the skin changes under it.
 *
 * The renderer runs in a sandboxed frame that reads the palette once and consumes one request,
 * so a mounted diagram keeps its old colours unless `MermaidDiagram` remounts its frame for the
 * new skin. Settings is its own route, so the picker never changes the skin while a diagram is
 * mounted. The store can, though: the page loads in the skin the daemon held at that moment, and
 * the store's own fetch of the config replaces it when it arrives. This spec loads the page under
 * Default, holds that fetch while the diagram renders, stores Daylight meanwhile (as another tab
 * or browser would) and only then lets the fetch through.
 *
 * A fake agent is dispatched for a checkout to put the Markdown in; no tokens are spent.
 */

const EVIDENCE = artifactsDir("mermaid-skin-change");
const TASK = "verify Mermaid skin change";
const MARKDOWN_PATH = "docs/skin-diagram.md";
const MARKDOWN = ["# Skin", "", "```mermaid", "flowchart LR", "  Inbox[Inbox] --> Review[Review]", "```", ""].join("\n");

/** Each skin's `--panel-2`, which the renderer paints a node's body with. */
const NODE_FILL = { Default: "rgb(23, 28, 35)", Daylight: "rgb(240, 243, 247)" } as const;

async function shoot(page: Page, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/mermaid-skin-change/${name}.png`);
}

async function dispatch(page: Page, daemon: DaemonHandle): Promise<string> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(TASK);
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
  let cwd: string | null = null;
  await expect.poll(async () => {
    const sessions = (await (await fetch(`${daemon.baseURL}/api/sessions`)).json()) as { cwd: string | null }[];
    cwd = sessions[0]?.cwd ?? null;
    return cwd;
  }).not.toBeNull();
  return cwd!;
}

/** The renderer's frame for the first diagram, and what its document is painted with. */
async function rendered(page: Page): Promise<{ scheme: string; fill: string } | null> {
  const frame: Frame | undefined = page.frames().find((f) => f.url().includes("/mermaid-renderer.html"));
  if (!frame) return null;
  return frame.evaluate(() => {
    const shape = document.querySelector(".node rect, .node polygon, .node path");
    return shape ? { scheme: document.documentElement.style.colorScheme, fill: getComputedStyle(shape).fill } : null;
  }).catch(() => null);
}

test("a mounted Mermaid diagram re-renders in the new skin's scheme and palette", async ({ dashboard, daemon }) => {
  const cwd = await dispatch(dashboard, daemon);
  mkdirSync(join(cwd, "docs"), { recursive: true });
  writeFileSync(join(cwd, MARKDOWN_PATH), MARKDOWN);

  // Hold the store's fetch of the config, so the page stays in the Default it loaded with.
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const hold = async (route: Route): Promise<void> => {
    if (route.request().method() !== "GET") return route.fallback();
    await held;
    await route.continue();
  };
  await dashboard.route("**/api/ui/config", hold);
  await dashboard.reload();
  await expect(dashboard.locator("html")).not.toHaveAttribute("data-skin", /.*/);

  await dashboard
    .getByRole("navigation", { name: "Sessions" })
    .getByRole("button", { name: /Verify Mermaid Skin Change/i })
    .click();
  await dashboard.getByRole("tablist", { name: "Session detail" }).getByRole("tab", { name: /Files$/ }).click();
  await dashboard.getByRole("listbox", { name: "Session files" }).getByRole("option", { name: MARKDOWN_PATH }).click();

  const figure = dashboard.locator("article.file-markdown-preview").getByRole("figure", { name: "Mermaid diagram 1" });
  await expect(figure).toHaveAttribute("data-mermaid-state", "rendered");
  await expect.poll(() => rendered(dashboard)).toEqual({ scheme: "dark", fill: NODE_FILL.Default });
  // Mark the frame on screen, so a repaint inside it cannot pass for a fresh render.
  const frameElement = dashboard.locator('iframe[title="Mermaid diagram 1"]');
  await frameElement.evaluate((el) => { (el as Element & { __skinProbe?: true }).__skinProbe = true; });
  await shoot(dashboard, "mermaid-default");

  // Sample every frame across the change: whether the diagram's iframe is visible, whether it is
  // the replacement, and how many renders the page has heard of since. A replacement frame starts
  // in the renderer's initial dark scheme, so it must stay hidden until it reports its own render.
  await dashboard.evaluate(() => {
    type Sample = { skin: string | null; state: string | null; visible: boolean; fresh: boolean; renders: number };
    const samples: Sample[] = [];
    let renders = 0;
    window.addEventListener("message", (event) => {
      if ((event.data as { type?: unknown } | null)?.type === "mission:mermaid-rendered") renders += 1;
    });
    const tick = (): void => {
      const frame = document.querySelector('iframe[title="Mermaid diagram 1"]') as (HTMLIFrameElement & { __skinProbe?: true }) | null;
      samples.push({
        skin: document.documentElement.getAttribute("data-skin"),
        state: document.querySelector('figure[aria-label="Mermaid diagram 1"]')?.getAttribute("data-mermaid-state") ?? null,
        visible: frame !== null && getComputedStyle(frame).visibility === "visible",
        fresh: frame !== null && frame.__skinProbe !== true,
        renders,
      });
      if (samples.length < 900) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    Reflect.set(window, "__mermaidSamples", samples);
  });

  // ---- Daylight is stored elsewhere, and lands in this page while the diagram is mounted ----
  const stored = await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ skin: "daylight" }),
  });
  expect(stored.ok).toBe(true);
  release();
  await expect(dashboard.locator("html")).toHaveAttribute("data-skin", "daylight");
  await expect.poll(() => rendered(dashboard)).toEqual({ scheme: "light", fill: NODE_FILL.Daylight });
  await expect(figure).toHaveAttribute("data-mermaid-state", "rendered");
  expect(
    await frameElement.evaluate((el) => (el as Element & { __skinProbe?: true }).__skinProbe === true),
    "the diagram kept its old frame instead of rendering again for the new skin",
  ).toBe(false);
  // Exactly one frame for the one diagram: the old one was replaced, not left behind.
  await expect(dashboard.locator('iframe[title="Mermaid diagram 1"]')).toHaveCount(1);

  // ---- and no frame showed the replacement before it had rendered in Daylight ----
  type Sample = { skin: string | null; state: string | null; visible: boolean; fresh: boolean; renders: number };
  const samples = await dashboard.evaluate(() => Reflect.get(window, "__mermaidSamples") as Sample[]);
  const afterChange = samples.filter((sample) => sample.skin === "daylight");
  expect(afterChange.length, "no frame was sampled after the skin changed").toBeGreaterThan(0);
  expect(
    afterChange.filter((sample) => sample.visible && sample.fresh && sample.renders === 0),
    "the replacement frame was on screen before it rendered in the new skin - a dark slab",
  ).toEqual([]);
  expect(
    afterChange.some((sample) => sample.state === "loading" && !sample.visible),
    "the diagram never showed as re-rendering while its replacement loaded",
  ).toBe(true);
  await shoot(dashboard, "mermaid-daylight");
  await dashboard.unroute("**/api/ui/config", hold);
});
