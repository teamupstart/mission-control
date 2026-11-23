import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { dispatchedSdkHookIdentity } from "../fixtures/sdk-hook-identity.ts";

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
 * Each skin this file covers is a row in `SKINS` below; a later skin adds its row. The skins
 * that change a font or add decoration are also held to Default's chrome geometry, measured in
 * the same page, so a display face or a glow that moved the topbar, the Line or the Dispatch
 * button fails here rather than on an operator's screen.
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
  Paper: { id: "paper", bg: "rgb(242, 235, 222)", fg: "rgb(42, 35, 24)", scheme: "light", minimap: "rgb(108, 95, 74)" },
  Blueprint: { id: "blueprint", bg: "rgb(11, 37, 71)", fg: "rgb(238, 245, 255)", scheme: "dark", minimap: "rgb(118, 132, 155)" },
  "Neon Dusk": { id: "neon-dusk", bg: "rgb(18, 10, 31)", fg: "rgb(244, 236, 255)", scheme: "dark", minimap: "rgb(118, 132, 155)" },
} as const;

/** The skins that go beyond colour - a display face, a backdrop, a glow - and so must be shown
 *  to leave the layout where Default put it. */
const DECORATED_SKINS = ["Paper", "Blueprint", "Neon Dusk"] as const;

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

/** Where the fleet's fixed chrome sits, to the pixel, and whether any of it is cut off. */
async function chrome(page: Page): Promise<{
  topbar: { width: number; height: number; overflows: boolean };
  line: { width: number; height: number; top: number };
  dispatch: { x: number; y: number; width: number; height: number; clipped: boolean; inside: boolean };
}> {
  const topbar = page.getByRole("banner");
  const line = page.getByRole("navigation", { name: "The Line" });
  const dispatch = page.getByRole("button", { name: "Dispatch", exact: true });
  await expect(topbar).toBeVisible();
  await expect(line).toBeVisible();
  await expect(dispatch).toBeVisible();
  const bar = await topbar.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { width: r.width, height: r.height, overflows: el.scrollWidth > el.clientWidth + 1 };
  });
  const strip = await line.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { width: r.width, height: r.height, top: r.top };
  });
  const button = await dispatch.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const header = el.closest("header")!.getBoundingClientRect();
    return {
      x: r.x,
      y: r.y,
      width: r.width,
      height: r.height,
      // Its label is cut if the content is wider than the box it was given.
      clipped: el.scrollWidth > el.clientWidth + 1,
      inside: r.left >= header.left && r.right <= header.right && r.right <= window.innerWidth,
    };
  });
  return { topbar: bar, line: strip, dispatch: button };
}

async function openDisplaySettings(page: Page): Promise<ReturnType<Page["getByRole"]>> {
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Display" }).click();
  const picker = page.getByRole("radiogroup", { name: "Skin" });
  await expect(picker).toBeVisible();
  return picker;
}

test("Paper, Blueprint and Neon Dusk each apply live, persist, and leave the topbar, the Line and Dispatch where Default put them", async ({
  page,
  daemon,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const seeded = await fetch(`${daemon.baseURL}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      repoRoot: daemon.repo,
      title: "Check the decorated skins",
      intent: "A card for the board to draw",
      backlog: true,
      enabled: false,
    }),
  });
  expect(seeded.ok, "the daemon should accept the backlog task").toBe(true);
  await page.goto(`${daemon.baseURL}/#/fleet`);
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();
  const board = page.getByRole("main");
  await expect(board).toContainText("Check the decorated skins");
  await expectPainted(page, "Default");

  // Default's chrome is the yardstick: a skin may repaint it and refont its headings, and must
  // leave every one of these where it was.
  const yardstick = await chrome(page);
  expect(yardstick.topbar.overflows, "the topbar overflows under Default").toBe(false);
  expect(yardstick.dispatch.clipped || !yardstick.dispatch.inside, "Dispatch is cut off under Default").toBe(false);

  for (const name of DECORATED_SKINS) {
    const want = SKINS[name];
    await page.evaluate(() => {
      (window as Window & { __skinProbe?: true }).__skinProbe = true;
    });

    // ---- live, behind the still-open settings page ----
    const picker = await openDisplaySettings(page);
    await expect(picker.getByRole("radio")).toHaveCount(Object.keys(SKINS).length);
    await picker.getByRole("radio", { name, exact: true }).check();
    await expectPainted(page, name);
    await expect(picker.getByRole("radio", { name, exact: true })).toBeChecked();
    expect(
      await page.evaluate(() => (window as Window & { __skinProbe?: true }).__skinProbe === true),
      `picking ${name} reloaded the page`,
    ).toBe(true);
    await expect.poll(() => storedSkin(daemon.baseURL)).toBe(want.id);
    observed(`${name} applied live behind Settings and the daemon stored it`);

    // ---- persisted: a reload comes back in it ----
    await page.reload();
    await expectPainted(page, name);
    await expect(page.getByRole("radiogroup", { name: "Skin" }).getByRole("radio", { name, exact: true }))
      .toBeChecked();
    const settingsHeading = page.getByRole("heading", { name: "Settings", level: 2 });

    // ---- what makes this skin itself ----
    const root = await page.evaluate(() => {
      const css = getComputedStyle(document.documentElement);
      return {
        display: css.getPropertyValue("--font-display").trim(),
        held: css.getPropertyValue("--held").trim(),
        cost: css.getPropertyValue("--cost").trim(),
        foreman: css.getPropertyValue("--foreman").trim(),
        shell: getComputedStyle(document.body).backgroundImage,
      };
    });
    if (name === "Paper") {
      expect(root.display).toContain("Iowan Old Style");
      await expect(settingsHeading).toHaveCSS("font-family", /^"Iowan Old Style"/);
    }
    if (name === "Blueprint") {
      await expect(settingsHeading).toHaveCSS("font-family", /^ui-monospace/);
      await expect(settingsHeading).toHaveCSS("text-transform", "uppercase");
      // The drafting grid: two 20px line patterns on the shell itself.
      expect(root.shell.match(/linear-gradient/g)?.length).toBe(2);
      await expect(page.locator("body")).toHaveCSS("background-size", /20px 20px, 20px 20px/);
      // Rendered Markdown keeps its author's case, in both wrappers `<Markdown>` is rendered
      // into (`.markdown` everywhere, `.scouts-markdown` in the Scouts reader), while a chrome
      // heading beside them is upper-cased. Measured through this page's own cascade.
      const cases = await page.evaluate(() => {
        const probe = document.createElement("div");
        probe.innerHTML =
          '<h2>Chrome</h2><div class="markdown"><h2>Prose</h2></div><div class="scouts-markdown"><h3>Scout prose</h3></div>';
        document.body.append(probe);
        const [chrome, prose, scout] = [...probe.querySelectorAll("h2, h3")].map((h) => getComputedStyle(h).textTransform);
        probe.remove();
        return { chrome, prose, scout };
      });
      expect(cases).toEqual({ chrome: "uppercase", prose: "none", scout: "none" });
    }
    if (name === "Neon Dusk") {
      // --purple is magenta, so Foreman, cost and the held state all read it.
      expect([root.held, root.cost, root.foreman]).toEqual(["#ff6ad5", "#ff6ad5", "#ff6ad5"]);
      expect(root.shell).toContain("radial-gradient");
    }
    observed(`${name} survived a reload and carries its own face and decoration`);

    // ---- the board, and the chrome a font or a glow could have moved ----
    await page.getByRole("button", { name: "← Fleet" }).click();
    await expect(board).toContainText("Check the decorated skins");
    await expect(board).toHaveCSS("color", want.fg);
    await expectPainted(page, name);
    const backlogHead = board.getByRole("heading", { name: "Backlog", exact: true });
    const stageName = page.getByRole("navigation", { name: "The Line" }).locator(".ls-name").first();
    if (name === "Paper") {
      await expect(backlogHead).toHaveCSS("font-family", /^"Iowan Old Style"/);
      await expect(stageName).toHaveCSS("font-family", /^"Iowan Old Style"/);
    }
    if (name === "Blueprint") {
      await expect(backlogHead).toHaveCSS("font-family", /^ui-monospace/);
      await expect(stageName).toHaveCSS("font-family", /^ui-monospace/);
    }
    if (name === "Neon Dusk") {
      const dispatch = page.getByRole("button", { name: "Dispatch", exact: true });
      await expect(dispatch).toHaveCSS("background-image", /^linear-gradient\(90deg, rgb\(255, 106, 213\), rgb\(63, 208, 255\)\)$/);
      await expect(dispatch).toHaveCSS("color", SKINS["Neon Dusk"].bg);
    }

    const now = await chrome(page);
    expect(now.topbar.overflows, `the topbar overflows under ${name}`).toBe(false);
    expect(now.dispatch.clipped, `the Dispatch label is cut off under ${name}`).toBe(false);
    expect(now.dispatch.inside, `Dispatch left the topbar under ${name}`).toBe(true);
    expect(now.topbar.height, `${name} changed the topbar's height`).toBe(yardstick.topbar.height);
    expect(now.line, `${name} moved or resized the Line`).toEqual(yardstick.line);
    expect(
      { x: now.dispatch.x, y: now.dispatch.y, width: now.dispatch.width, height: now.dispatch.height },
      `${name} moved or resized the Dispatch button`,
    ).toEqual({ x: yardstick.dispatch.x, y: yardstick.dispatch.y, width: yardstick.dispatch.width, height: yardstick.dispatch.height });
    observed(
      `${name}: topbar ${now.topbar.height}px, Line ${now.line.height}px at ${now.line.top}px, ` +
        `Dispatch ${now.dispatch.width}x${now.dispatch.height}px at ${now.dispatch.x},${now.dispatch.y}, nothing clipped (Default: ` +
        `${yardstick.topbar.height}px, ${yardstick.line.height}px at ${yardstick.line.top}px, ` +
        `Dispatch ${yardstick.dispatch.width}x${yardstick.dispatch.height}px at ${yardstick.dispatch.x},${yardstick.dispatch.y})`,
    );
    await shoot(page, `${want.id}-board`);
  }
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

// ---- Neon Dusk's glows, in the states that light them ----

/** A box-shadow written in the page's own terms, computed the way the browser computes it, so
 *  a token-built shadow can be compared with a rendered one without restating colour maths. */
async function computedShadow(page: Page, shadow: string): Promise<string> {
  return page.evaluate((value) => {
    const probe = document.createElement("div");
    probe.style.boxShadow = value;
    document.body.append(probe);
    const out = getComputedStyle(probe).boxShadow;
    probe.remove();
    return out;
  }, shadow);
}

const shadowOf = (target: Locator): Promise<string> => target.evaluate((el) => getComputedStyle(el).boxShadow);

test.describe("Neon Dusk", () => {
  // A real permission prompt parks the opening turn; holding it open keeps the session blocked
  // (the same contract `attention-pills-agree.spec.ts` documents) rather than racing to idle.
  test.use({ daemonEnv: { MC_E2E_HOLD_FIRST_TURN: "1" } });

  test("its glow lights a tile and a Line stage that need you, the board cursor and a focused field, and keeps the rings already there", async ({
    page,
    daemon,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const stored = await fetch(`${daemon.baseURL}/api/ui/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ skin: "neon-dusk" }),
    });
    expect(stored.ok).toBe(true);
    // A parked backlog task: a queue nothing can start, which turns the Line's Backlog stage -
    // a stage that opens a drawer - amber (`line-strip.spec.ts` pins that rule).
    const parkedTask = await fetch(`${daemon.baseURL}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoRoot: daemon.repo, title: "A parked task", intent: "Holds the backlog amber", backlog: true, enabled: false }),
    });
    expect(parkedTask.ok).toBe(true);
    await page.goto(`${daemon.baseURL}/#/fleet`);
    await page.evaluate(() => window.localStorage.clear());
    await page.reload();
    await expectPainted(page, "Neon Dusk");

    // The shadows each state should draw, built from Neon Dusk's own tokens.
    const glow = await computedShadow(page, "var(--neon-glow)");
    const attentionGlow = await computedShadow(page, "var(--shadow), var(--neon-glow)");
    const cursorRing = await computedShadow(page, "0 0 0 2px color-mix(in oklab, var(--select) 65%, transparent)");
    const openRing = await computedShadow(page, "0 0 0 1px color-mix(in oklab, var(--working) 30%, transparent)");
    const fieldGlow = await computedShadow(page, "var(--neon-rim), var(--neon-glow)");
    expect(glow, "the glow token resolved to nothing").not.toBe("none");

    // ---- a fake agent on the board (no model, no tokens), then parked on a permission prompt ----
    await page.getByRole("button", { name: "Dispatch", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
    await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
    await page.keyboard.press("Escape");
    await dialog.getByPlaceholder("What should this agent do?").fill("check the neon glow");
    await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
    await dialog.getByRole("button", { name: "Dispatch now" }).click();
    await expect(dialog).toBeHidden();
    // Registered first: the hook is attributed through the SDK driver's native identity, which
    // exists only once the worktree is provisioned and the session is live.
    await expect
      .poll(async () => {
        const sessions = (await (await fetch(`${daemon.baseURL}/api/sessions`)).json()) as { runtime: string; agentSessionId: string | null }[];
        return sessions.some((session) => session.runtime === "sdk" && session.agentSessionId);
      }, { timeout: 60_000 })
      .toBe(true);
    const token = readFileSync(join(daemon.home, "token"), "utf8").trim();
    const parked = await fetch(`${daemon.baseURL}/hooks/Notification`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-harness-token": token },
      body: JSON.stringify({
        agent: "claude",
        ...(await dispatchedSdkHookIdentity(daemon)),
        env: {},
        message: "Claude needs your permission to use Bash",
      }),
    });
    expect(parked.status, "the daemon accepted the hook").toBe(204);

    const board = page.locator("main.board");
    const tile = board.locator(".tile").filter({ hasText: /check the neon glow/i });
    await expect(tile).toHaveClass(/\battention\b/);

    // ---- a tile that needs you glows, outside its own shadow ----
    await page.mouse.move(0, 0);
    await expect.poll(() => shadowOf(tile)).toBe(attentionGlow);
    observed(`an attention tile under Neon Dusk draws ${attentionGlow}`);

    // ---- the board cursor keeps its selection ring and gains the glow ----
    await board.click({ position: { x: 4, y: 4 } });
    await page.keyboard.press("ArrowDown");
    await expect(tile).toHaveClass(/\bselected\b/);
    await page.mouse.move(0, 0);
    await expect.poll(() => shadowOf(tile)).toContain(cursorRing);
    expect(await shadowOf(tile)).toContain(glow);
    observed("the selected tile keeps its 2px selection ring and gains the glow");
    await shoot(page, "neon-dusk-glow-board");
    await page.keyboard.press("Escape");

    // ---- a Line stage that needs you glows, and an open one keeps its drawer ring ----
    const line = page.getByRole("navigation", { name: "The Line" });
    const hot = line.getByRole("button", { name: /^Backlog,/ });
    await expect(hot).toHaveClass(/\btone-attention\b/);
    await expect(hot).toHaveAttribute("aria-expanded", "false");
    await page.mouse.move(0, 0);
    await expect.poll(() => shadowOf(hot)).toBe(glow);
    await hot.click();
    await expect(hot).toHaveAttribute("aria-expanded", "true");
    await expect(hot).toHaveClass(/\bis-open\b/);
    await page.mouse.move(0, 0);
    await expect.poll(() => shadowOf(hot)).toContain(openRing);
    expect(await shadowOf(hot)).toContain(glow);
    observed("an attention stage glows, and opened it keeps the ring that says its drawer is showing");
    await page.keyboard.press("Escape");

    // ---- a focused text field is rimmed and lit ----
    // The Dispatch form's repo field, which the form focuses as it opens: the topbar's own
    // filter has folded into an icon by now, because the pulse grew a "need you" segment and
    // the measured ladder made room for it, and guided mode keeps the task field for step two.
    await page.getByRole("button", { name: "Dispatch", exact: true }).click();
    const form = page.getByRole("dialog", { name: "Dispatch an agent" });
    const field = form.getByPlaceholder("search repos or type a path…");
    await field.focus();
    await expect(field).toBeFocused();
    await expect.poll(() => shadowOf(field)).toBe(fieldGlow);
    observed("the focused Dispatch repo field draws the magenta rim and glow");
    await shoot(page, "neon-dusk-glow-focus");
    await page.keyboard.press("Escape");
  });
});
