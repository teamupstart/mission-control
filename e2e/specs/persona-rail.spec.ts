import { mkdirSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * The Persona detail screen, rebuilt on the Rail direction.
 *
 * Four faults, and each one is a browser fact rather than a markup shape:
 *
 * - the rail listed every Persona flat, so the ones that ship with the build read as things
 *   you wrote. It now groups them, and a row has to OPEN from either group;
 * - Save, Copy Markdown, Download .md and Duplicate were four equal-weight links beside
 *   Archive. One verb is promoted and the rest are behind a menu - and that menu is the
 *   first dismissible surface these screens have had, so whether Escape closes it WITHOUT
 *   also leaving the page is a real question about two listeners and one keystroke. Only a
 *   browser can answer it;
 * - the five-field metadata block never said whether a value was this Persona's or the
 *   app's. Chips do, and the assertion that matters is the round trip: change it in the
 *   popover, save, reload, and find the same answer;
 * - on a built-in, Save was permanently disabled and Duplicate was the only verb that did
 *   anything.
 *
 * `test/persona-editor-render.test.ts` pins every one of those as markup and pure data. What
 * it cannot do is press a key, open a popover, or come back after a reload.
 *
 * No agent is launched and none is needed: the Library authors, it does not run.
 */

const EVIDENCE = artifactsDir("persona-rail");

interface SeededPersona {
  id: string;
  name: string;
  builtin: boolean;
  archivedAt: number | null;
}

async function api<T>(daemon: DaemonHandle, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as T;
}

/** One Persona of the operator's, beside whatever this build ships. */
async function seedPersona(daemon: DaemonHandle): Promise<string> {
  const persona = await api<{ id: string }>(daemon, "/api/personas", {
    name: "Rail reviewer",
    description: "Reads the diff and says whether it holds.",
    guidanceMarkdown: "# Rail reviewer\n\nJudge the change.",
  });
  return persona.id;
}

const hash = (page: Page) => page.evaluate(() => location.hash);
const sidebar = (page: Page) => page.getByRole("complementary", { name: "Persona library" });
const nameField = (page: Page) => page.locator("section.persona-fields").getByLabel("Name");
const menuButton = (page: Page) => page.getByRole("button", { name: "More Persona actions" });
/** An interactive property chip, by the property it carries. Its value is its own text. */
const chip = (page: Page, property: string): Locator =>
  page.getByRole("button", { name: new RegExp(`^${property}\\b`) });
/**
 * A read-only chip. Not a control and so not a role: it is a key and a value in a `span`,
 * which is what "readout, not a setting" means when it is drawn honestly.
 */
const readout = (page: Page, property: string): Locator =>
  page.locator("span.lib-chip", { hasText: new RegExp(`^${property}`) });

/**
 * Photograph a state this spec has already asserted on, inside the test that asserted it, so
 * the picture and the measurement cannot drift apart. Behind `MC_E2E_EVIDENCE`, like every
 * other capture in this suite.
 */
async function shoot(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  // Tooltip portals a bubble under a resting pointer that outlives the move by its own fade.
  await page.mouse.move(0, 0);
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/persona-rail/${name}.png`);
}

test("the rail separates what ships from what you wrote, and a Persona opens from each group", async ({
  dashboard,
  daemon,
}) => {
  await seedPersona(daemon);
  const personas = await api<SeededPersona[]>(daemon, "/api/personas");
  const shipped = personas.find((persona) => persona.builtin);
  expect(shipped, "this build ships no built-in Personas to group").toBeTruthy();
  const shippedCount = personas.filter((persona) => persona.builtin).length;

  await dashboard.goto(`${daemon.baseURL}/#/library/personas`);
  const rail = sidebar(dashboard);
  await expect(rail).toBeVisible();

  // Each head counts the rows drawn beneath it. `Yours 1` is the one an operator reads to
  // learn that the rest were never theirs.
  await expect(rail.getByRole("heading", { name: new RegExp(`^Built-in\\s+${shippedCount}$`) }))
    .toBeVisible();
  await expect(rail.getByRole("heading", { name: /^Yours\s+1$/ })).toBeVisible();

  // The sub-label is the resolved runner and model - the fact that tells two reviewers
  // apart - rather than the description, which on the shipped roles restates the title.
  const mine = rail.getByRole("button", { name: /Rail reviewer/ });
  await expect(mine).toContainText(/\w+ · \S+/);
  await expect(mine).not.toContainText("Reads the diff and says whether it holds.");
  await shoot(dashboard, "01-rail-groups");

  // A row opens from either group, which is the whole reason the grouping is allowed to
  // reorder the list at all.
  await rail.getByRole("button", { name: new RegExp(shipped!.name) }).click();
  await expect(nameField(dashboard)).toHaveValue(shipped!.name);
  await mine.click();
  await expect(nameField(dashboard)).toHaveValue("Rail reviewer");

  // Import and the archived filter moved below the list rather than away: everything that
  // was in the path between the heading and the rows is still reachable.
  await expect(rail.getByRole("button", { name: "Import .md" })).toBeVisible();
  await expect(rail.getByRole("button", { name: /^Archived/ })).toBeVisible();
  await expect(rail.getByLabel("Absolute path of a Markdown file on this machine")).toBeVisible();
});

test("the overflow menu holds the other verbs, and Escape closes it without leaving the page", async ({
  dashboard,
  daemon,
}) => {
  const personaId = await seedPersona(daemon);
  await dashboard.goto(`${daemon.baseURL}/#/library/personas/${personaId}`);
  await expect(nameField(dashboard)).toHaveValue("Rail reviewer");

  // Shut, the menu's rows are not on the page at all - which is the point, and also why the
  // absence below is worth asserting: it is made present first, three lines down.
  const menu = dashboard.getByRole("menu", { name: "More Persona actions" });
  await expect(menu).toHaveCount(0);

  await menuButton(dashboard).click();
  await expect(menu).toBeVisible();
  for (const label of ["Copy Markdown", "Download .md", "Duplicate", "Archive"]) {
    await expect(menu.getByRole("menuitem", { name: label })).toBeVisible();
  }
  await shoot(dashboard, "02-overflow-menu");

  /*
   * The keystroke this phase could most easily have broken. Two things want Escape here:
   * the menu, and Phase 1's page ladder. The menu answers it in React and marks the press
   * handled, so the ladder stands down - one press closes the menu and the page stays put.
   */
  await dashboard.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect.poll(() => hash(dashboard)).toBe(`#/library/personas/${personaId}`);

  // And the ladder is still live underneath it, rather than having been spent.
  await dashboard.keyboard.press("Escape");
  await expect.poll(() => hash(dashboard)).toBe("#/library");
});

test("a property chip opens its control, and the override it takes survives a save and a reload", async ({
  dashboard,
  daemon,
}) => {
  const personaId = await seedPersona(daemon);
  await dashboard.goto(`${daemon.baseURL}/#/library/personas/${personaId}`);
  await expect(nameField(dashboard)).toHaveValue("Rail reviewer");

  // Nothing is overridden yet, and the row says so without being opened - which is the one
  // question the five-field block it replaced could not answer at a glance.
  await expect(readout(dashboard, "source")).toHaveText(/app defaults/);

  await chip(dashboard, "provider").click();
  const popover = dashboard.getByRole("group", { name: "Provider override" });
  await expect(popover).toBeVisible();
  await shoot(dashboard, "03-provider-chip-open");

  // The control is the one that was in the metadata block, not a reimplementation of it.
  await popover.getByRole("combobox", { name: "Provider override" }).selectOption("codex");
  await dashboard.keyboard.press("Escape");
  await expect(popover).toHaveCount(0);

  // Read straight off the shut chip row: the provider is now this Persona's, and the
  // read-only `source` chip has stopped saying the app decided it.
  await expect(chip(dashboard, "provider")).toContainText("Codex");
  await expect(readout(dashboard, "source")).toHaveText(/this Persona/);

  await dashboard.getByRole("button", { name: "Save" }).click();
  await expect(dashboard.locator("article.persona-editor p.workflow-eyebrow"))
    .toHaveText("Revision 2");

  // The round trip is the assertion. A chip that only redrew its own state would pass every
  // line above and still have written nothing.
  await dashboard.reload();
  await expect(nameField(dashboard)).toHaveValue("Rail reviewer");
  await expect(chip(dashboard, "provider")).toContainText("Codex");
  await expect(readout(dashboard, "source")).toHaveText(/this Persona/);
  await shoot(dashboard, "04-provider-overridden");

  /*
   * And the chip stops claiming Escape the moment it is shut. Closing returns focus TO the
   * chip, so a popover that answered the key whenever focus was inside it left the PAGE's
   * Escape dead for as long as that chip kept focus - Phase 1's contract, undone by this
   * phase's first dismissible surface. Two presses: one for the popover, one for the page.
   */
  await chip(dashboard, "provider").click();
  await dashboard.keyboard.press("Escape");
  await expect(popover).toHaveCount(0);
  await dashboard.keyboard.press("Escape");
  await expect.poll(() => hash(dashboard)).toBe("#/library");
});

test("a built-in promotes Duplicate and offers no Save at all", async ({ dashboard, daemon }) => {
  const personaId = await seedPersona(daemon);
  const personas = await api<SeededPersona[]>(daemon, "/api/personas");
  const shipped = personas.find((persona) => persona.builtin);
  expect(shipped, "this build ships no built-in Personas").toBeTruthy();

  // Present first, so its absence below is a fact about built-ins rather than about the
  // selector.
  await dashboard.goto(`${daemon.baseURL}/#/library/personas/${personaId}`);
  await expect(nameField(dashboard)).toHaveValue("Rail reviewer");
  await expect(dashboard.getByRole("button", { name: "Save" })).toBeVisible();

  // Reached through the rail rather than the address bar, which is both the real path and
  // the only one that works: the route seeds the selection as this surface MOUNTS, and a
  // hash change while it is already up is the rail's business, not the router's.
  await sidebar(dashboard).getByRole("button", { name: new RegExp(shipped!.name) }).click();
  await expect(nameField(dashboard)).toHaveValue(shipped!.name);

  /*
   * Save used to sit here first in the row, permanently disabled, on every shipped
   * Persona - which reads as "the thing you want, unavailable" when the thing you want is
   * two controls to its right and perfectly available. There is no revision this editor
   * could write, so it does not offer one.
   */
  await expect(dashboard.getByRole("button", { name: "Save" })).toHaveCount(0);
  const duplicate = dashboard.getByRole("button", { name: "Duplicate to edit" });
  await expect(duplicate).toBeVisible();
  await expect(nameField(dashboard)).toHaveAttribute("readonly", "");
  await shoot(dashboard, "05-builtin-promotes-duplicate");

  // And it does what it says: an editable copy, which is the only path from a built-in to a
  // Persona of your own.
  await duplicate.click();
  await expect(nameField(dashboard)).toHaveValue(`${shipped!.name} copy`);
  await expect(nameField(dashboard)).not.toHaveAttribute("readonly", "");
  await expect(dashboard.getByRole("button", { name: "Save" })).toBeEnabled();
});
