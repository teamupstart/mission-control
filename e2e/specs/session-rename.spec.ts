import { mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { settled } from "../fixtures/settle.ts";

/**
 * Clicking a session's title opens an inline box that renames it.
 *
 * The rename affordance was built when every session WAS a terminal pane: it moves the
 * multiplexer session's name (or an emulator tab's title) and lets the next discovery sweep
 * read it back onto the card, so it was gated on the presence of a pane handle. An SDK-runtime
 * session has `terminals: []` by construction, so once dispatch started producing those, the
 * title on the card a person actually looks at silently stopped being a click target - the
 * heading rendered as plain text, with no button inside it and no pencil.
 *
 * So the assertion that matters is structural: the heading CONTAINS a control. That is what a
 * person is reaching for when they click a title, it is what a screen reader announces as
 * actionable, and it is precisely what was missing.
 */

const TASK = "write a haiku about flexbox";
/** `deriveTitle` title-cases the intent - the synchronous name a fresh dispatch gets. */
const DERIVED_TITLE = "Write a Haiku About Flexbox";
const LONG_TASK =
  "compare the features of this application with the features of the competing application in a complete report";
const FULL_LONG_TITLE =
  "Compare the Features of This Application with the Features of the Competing Application in a Complete Report";
const EVIDENCE = "e2e/.artifacts/session-rename-full-tooltip";

async function dispatch(page: Page, daemon: DaemonHandle, task = TASK): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();

  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();

  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  // RepoCombobox portals its listbox over the Task field and reopens on every keystroke, so
  // dismissing it is what keeps the next fill from landing on a covered control. The combobox
  // stops the Escape itself, so the modal stays open.
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(task);
  await dialog.getByLabel("Kind").selectOption("ship");
  // Pinned rather than left on the dispatch default: this repo is not allowlisted for Live
  // Workflow delivery, so the default would refuse the dispatch and leave the modal open.
  await dialog
    .locator("select")
    .filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");

  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
}

async function useBoardLayout(page: Page, daemon: DaemonHandle): Promise<void> {
  const response = await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ layout: "board" }),
  });
  const body = (await response.json()) as { config?: { layout?: string } };
  expect(body.config?.layout, "the daemon accepted the Board layout").toBe("board");
  await page.reload();
  await expect(page.locator("main.board")).toBeVisible();
}

test("a shortened generated name keeps its full name in the tooltip", async ({
  dashboard,
  daemon,
}) => {
  await dispatch(dashboard, daemon, LONG_TASK);

  await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  const card = dashboard.locator(".console-detail");
  await expect(card).toContainText("Agent SDK", { timeout: 30_000 });

  const title = card.getByRole("heading").getByRole("button");
  await expect(title).toContainText("…");
  await title.hover();
  await expect(dashboard.locator(".tooltip")).toHaveText(`Rename "${FULL_LONG_TITLE}"`);

  await useBoardLayout(dashboard, daemon);
  const tile = dashboard.locator(".tile").first();
  const tileName = tile.locator(".tile-name");
  await expect(tileName).toContainText("…");
  await tileName.hover();
  await expect(dashboard.locator(".tooltip")).toHaveText(`Open ${FULL_LONG_TITLE}`);
  await expect(tile.locator(".tile-open")).toHaveAttribute("aria-label", `Open ${FULL_LONG_TITLE}`);

  if (process.env.MC_E2E_EVIDENCE) {
    mkdirSync(EVIDENCE, { recursive: true });
    await dashboard.screenshot({ path: `${EVIDENCE}/board-full-name-tooltip.png` });
  }
});

test("clicking an SDK session's title renames it, durably", async ({ dashboard, daemon }) => {
  await dispatch(dashboard, daemon);

  await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  const card = dashboard.locator(".console-detail");
  await expect(card).toContainText("Agent SDK", { timeout: 30_000 });

  // The card's only heading is its title. Selecting the button THROUGH it is what pins the
  // regression: on the broken build the heading is present and its text is right, and there is
  // simply no control inside it to click.
  const title = card.getByRole("heading").getByRole("button");
  await expect(title).toBeVisible();
  await expect(title).toHaveText(new RegExp(DERIVED_TITLE));
  await settled(title);
  await title.click();

  const box = card.getByLabel("Rename session");
  await expect(box).toBeVisible();
  // The editor opens on the current name, pre-selected, so a rename is an edit rather than a
  // retype. `toHaveValue`'s second parameter is options, not a message - so this says it here.
  await expect(box).toHaveValue(DERIVED_TITLE);
  await box.fill("renamed by hand");
  await box.press("Enter");

  // The editor closes only on a rename the server accepted - a refusal keeps it open with the
  // reason - so its disappearance is the acceptance, and the heading is the echo.
  await expect(box).toBeHidden();
  await expect(card.getByRole("heading")).toContainText("renamed by hand");

  // The name a person typed outlives the browser. An SDK session's name is otherwise DERIVED
  // on every read of its durable row, so without a column to put this in the reload below
  // brings the dispatch's title straight back.
  await dashboard.reload();
  await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  const reloaded = dashboard.locator(".console-detail");
  await expect(reloaded.getByRole("heading")).toContainText("renamed by hand");
  await expect(reloaded.getByRole("heading")).not.toContainText(DERIVED_TITLE);
});

test("an SDK session's title takes a name no terminal home could hold", async ({ dashboard, daemon }) => {
  // There is no target grammar to satisfy on this runtime - no tmux `session:window.pane` to
  // be parsed as - so the characters a multiplexer reserves are ordinary text here. This is
  // the half of the fix that would be lost by routing embedded renames through a backend's
  // name rules just because that is where rename already lived.
  await dispatch(dashboard, daemon);

  await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  const card = dashboard.locator(".console-detail");
  const title = card.getByRole("heading").getByRole("button");
  await expect(title).toBeVisible();
  await settled(title);
  await title.click();

  const box = card.getByLabel("Rename session");
  await box.fill("fix: the a.b parser $0");
  await box.press("Enter");

  await expect(box).toBeHidden();
  await expect(card.getByRole("heading")).toContainText("fix: the a.b parser $0");
});

test("Escape leaves an SDK session's title alone", async ({ dashboard, daemon }) => {
  await dispatch(dashboard, daemon);

  await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  const card = dashboard.locator(".console-detail");
  const title = card.getByRole("heading").getByRole("button");
  await expect(title).toBeVisible();
  await settled(title);
  await title.click();

  const box = card.getByLabel("Rename session");
  await box.fill("discarded");
  await box.press("Escape");

  await expect(box).toBeHidden();
  await expect(card).not.toContainText("discarded");
  await expect(card.getByRole("heading")).toContainText(DERIVED_TITLE);
});
