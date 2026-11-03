import { mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";

/**
 * Picking a skin, end to end: a tile -> the preference store -> `<html data-skin>` -> every
 * token on the page -> a PUT the daemon keeps -> the next load.
 *
 * The other layers each see a piece. `skins.test.ts` proves the files and their contrast, the
 * markup test that the picker offers every registered skin, `skin-apply.test.ts` that the
 * module follows the store, and the Electron geometry test that a skin never moves the Line.
 * None of them can see the dashboard actually repaint behind a still-open settings page with
 * no reload, the daemon store the choice, or a mounted React Flow canvas pick it up. This can.
 *
 * Each skin this file covers is a row in `SKINS` below; a later skin adds its row.
 *
 * The raw `page` fixture rather than `dashboard`, which pins the Console layout: the board is
 * the shipped view and the one a skin is judged on. No agent is dispatched, so no binary runs
 * and no tokens are spent.
 */

const EVIDENCE = artifactsDir("settings-skins");

/** Each shipped skin's `--bg` and the minimap node fill it resolves, as computed colours. */
const SKINS = {
  Default: { id: null, bg: "rgb(10, 12, 15)", fg: "rgb(231, 235, 241)", scheme: "dark", minimap: "rgb(118, 132, 155)" },
  Daylight: { id: "daylight", bg: "rgb(245, 247, 250)", fg: "rgb(20, 26, 34)", scheme: "light", minimap: "rgb(91, 102, 118)" },
} as const;

const BUILTIN_BUTTON = /^No-Mistakes Review \(High Rigor\)\s*built-in\b/i;

function observed(what: string): void {
  if (!process.env.MC_E2E_EVIDENCE) return;
  // eslint-disable-next-line no-console
  console.log(`OBSERVED ${what}`);
}

async function shoot(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/settings-skins/${name}.png`);
}

/** The skin the page is painted in right now, read from the page rather than the store. */
async function painted(page: Page): Promise<{ skin: string | null; bg: string; fg: string; scheme: string }> {
  return page.evaluate(() => ({
    skin: document.documentElement.getAttribute("data-skin"),
    bg: getComputedStyle(document.body).backgroundColor,
    fg: getComputedStyle(document.body).color,
    scheme: document.documentElement.style.colorScheme,
  }));
}

async function expectPainted(page: Page, name: keyof typeof SKINS): Promise<void> {
  const want = SKINS[name];
  await expect.poll(() => painted(page)).toEqual({ skin: want.id, bg: want.bg, fg: want.fg, scheme: want.scheme });
}

async function storedSkin(baseURL: string): Promise<string> {
  const view = (await (await fetch(`${baseURL}/api/ui/config`)).json()) as { config: { skin: string } };
  return view.config.skin;
}

test("a skin repaints the dashboard behind Settings at once, persists, and a refused write is taken back", async ({
  page,
  daemon,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  // One backlog task, disabled so nothing dispatches it: an empty fleet draws its empty state
  // instead of the board, and the board is the surface a skin is judged on.
  const seeded = await fetch(`${daemon.baseURL}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      repoRoot: daemon.repo,
      title: "Check the Daylight skin",
      intent: "A card for the board to draw",
      backlog: true,
      enabled: false,
    }),
  });
  expect(seeded.ok, "the daemon should accept the backlog task").toBe(true);
  await page.goto(`${daemon.baseURL}/#/fleet`);
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();
  await expect(page.getByRole("button", { name: "Dispatch", exact: true })).toBeVisible();

  // ---- an untouched profile is today's look ----
  await expectPainted(page, "Default");
  expect(await storedSkin(daemon.baseURL)).toBe("default");

  // A marker that only survives if nothing reloads the page from here to the next reload.
  await page.evaluate(() => {
    (window as Window & { __skinProbe?: true }).__skinProbe = true;
  });
  const sameDocument = (): Promise<boolean> =>
    page.evaluate(() => (window as Window & { __skinProbe?: true }).__skinProbe === true);

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Display" }).click();
  const picker = page.getByRole("radiogroup", { name: "Skin" });
  await expect(picker).toBeVisible();
  await expect(picker.getByRole("radio")).toHaveCount(Object.keys(SKINS).length);
  await expect(picker.getByRole("radio", { name: "Default", exact: true })).toBeChecked();
  await expect(page.getByText("Applies the moment you pick it - the dashboard behind this page repaints live.")).toBeVisible();

  // ---- picking Daylight repaints live: no Save, no reload ----
  await picker.getByRole("radio", { name: "Daylight", exact: true }).check();
  await expectPainted(page, "Daylight");
  await expect(page.locator("html")).toHaveAttribute("data-skin", "daylight");
  await expect(picker.getByRole("radio", { name: "Daylight", exact: true })).toBeChecked();
  expect(await sameDocument(), "picking a skin reloaded the page").toBe(true);
  // The settings page itself is part of "the whole dashboard": the unselected tile sits on
  // Daylight's white --panel, not Default's graphite one.
  await expect(picker.locator("label").filter({ has: page.getByRole("radio", { name: "Default", exact: true }) }))
    .toHaveCSS("background-color", "rgb(255, 255, 255)");
  await expect.poll(() => storedSkin(daemon.baseURL)).toBe("daylight");
  // And the daemon now serves the document in it, so even a profile with no cache paints it first.
  const served = await (await fetch(`${daemon.baseURL}/`)).text();
  expect(served).toContain('<html lang="en" data-skin="daylight" style="color-scheme: light">');
  expect(served).toContain('<meta name="mission-skin" content="daylight" />');
  observed("Daylight applied live behind Settings and the daemon stored it");
  await shoot(page, "daylight-settings");

  // ---- a reload comes back in it, from the first paint ----
  await page.reload();
  await expectPainted(page, "Daylight");
  await expect(page.getByRole("radiogroup", { name: "Skin" }).getByRole("radio", { name: "Daylight", exact: true }))
    .toBeChecked();
  observed("Daylight survived a reload");

  // ---- a write the daemon refuses repaints back, so the picker never shows a skin not in force ----
  await page.route("**/api/ui/config", async (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "refused" }) });
  });
  const reloadedPicker = page.getByRole("radiogroup", { name: "Skin" });
  // `click`, not `check`: the refusal can roll the radio back before `check` re-reads it,
  // and the rolled-back state is exactly what this step asserts.
  await reloadedPicker.getByRole("radio", { name: "Default", exact: true }).click();
  await expectPainted(page, "Daylight");
  await expect(reloadedPicker.getByRole("radio", { name: "Daylight", exact: true })).toBeChecked();
  await page.unroute("**/api/ui/config");
  expect(await storedSkin(daemon.baseURL)).toBe("daylight");
  // And the daemon itself refuses an id this build does not ship.
  const unknown = await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ skin: "not-a-skin" }),
  });
  expect(unknown.status).toBe(400);
  expect(await storedSkin(daemon.baseURL)).toBe("daylight");
  observed("a refused write rolled the page back to Daylight, and an unknown id is a 400");

  // ---- Default is the absence of the attribute, and today's colours ----
  await reloadedPicker.getByRole("radio", { name: "Default", exact: true }).check();
  await expectPainted(page, "Default");
  await expect(page.locator("html")).not.toHaveAttribute("data-skin", /.*/);
  await expect.poll(() => storedSkin(daemon.baseURL)).toBe("default");

  // ---- the fleet board renders in the chosen skin ----
  await reloadedPicker.getByRole("radio", { name: "Daylight", exact: true }).check();
  await expectPainted(page, "Daylight");
  await page.getByRole("button", { name: "← Fleet" }).click();
  const board = page.getByRole("main");
  await expect(board).toBeVisible();
  await expect(board).toContainText("Check the Daylight skin");
  await expect(board).toHaveCSS("color", SKINS.Daylight.fg);
  await expectPainted(page, "Daylight");
  observed("the board renders in Daylight after leaving Settings");
  await shoot(page, "daylight-board");

  // A modal on the skin: the Dispatch form sits on Daylight's white panel.
  await page.getByRole("button", { name: "Dispatch", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await shoot(page, "daylight-dispatch-modal");
});

test("a workflow canvas minimap shows the skin chosen while it was off screen", async ({ page, daemon }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${daemon.baseURL}/#/fleet`);
  await page.evaluate(() => window.localStorage.clear());

  const openWorkflow = async (): Promise<ReturnType<Page["locator"]>> => {
    await page.goto(`${daemon.baseURL}/#/library`);
    await page.getByRole("button", { name: BUILTIN_BUTTON }).click();
    await page.getByRole("button", { name: "Graph", exact: true }).click();
    const minimap = page.getByRole("img", { name: "Workflow minimap" });
    await expect(minimap).toBeVisible();
    const node = minimap.locator("rect.react-flow__minimap-node").first();
    await expect(node).toBeAttached();
    return node;
  };

  const before = await openWorkflow();
  await expect(before).toHaveCSS("fill", SKINS.Default.minimap);

  // Settings is its own route, so the canvas is not on screen while the skin is chosen.
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Display" }).click();
  await page.getByRole("radiogroup", { name: "Skin" }).getByRole("radio", { name: "Daylight", exact: true }).check();
  await expectPainted(page, "Daylight");
  await expect.poll(() => storedSkin(daemon.baseURL)).toBe("daylight");

  const after = await openWorkflow();
  await expect(after).toHaveCSS("fill", SKINS.Daylight.minimap);
  expect(SKINS.Daylight.minimap).not.toBe(SKINS.Default.minimap);
  observed("the minimap node fill moved from Default's token to Daylight's");
  // The canvas sits below the workflow's settings in a scrolling pane; bring it on screen.
  await page.getByRole("img", { name: "Workflow minimap" }).scrollIntoViewIfNeeded();
  await shoot(page, "daylight-workflow-canvas");
});
