import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";

import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";

/**
 * Settings → Workflows: the check-command table, now that the commands live somewhere else.
 *
 * Nothing about this panel changed. That is precisely what needs proving. Commands moved out
 * of the `workflows` `app_config` blob and into a daemon-owned catalog with its own tables,
 * revisions and routes, and the panel keeps writing the whole legacy config object through
 * `PUT /api/workflows/config` as it always did. Between those two facts sits a compatibility
 * adapter, and if it is wrong the failure is silent in exactly the way that matters: the row
 * still appears on screen - the panel renders what it just sent - while the daemon stores
 * nothing, and every Check node skips forever.
 *
 * So each assertion here is made twice, once through the browser and once against the
 * daemon's OWN catalog route. The unit layer can prove the adapter maps a list; only this can
 * prove the control an operator actually clicks reaches it.
 *
 * The one visible consequence of the move is also pinned: the list is now ordered by slot and
 * path rather than by whatever order rows happened to be appended in. Deterministic, and
 * asserted so a later change to that order is a decision rather than an accident.
 *
 * Nothing here dispatches, so no agent binary is launched and no model tokens are spent.
 */

interface CommandView {
  slot: string;
  defaultCommand: string[] | null;
  overrides: Array<{ repoRoot: string; command: string[] }>;
  revision: number;
}

/** The daemon's own catalog, read straight from it rather than off the screen. */
async function catalog(baseURL: string): Promise<CommandView[]> {
  const res = await fetch(`${baseURL}/api/workflow-commands`);
  return (await res.json()) as CommandView[];
}

const slotOf = (views: CommandView[], slot: string): CommandView =>
  views.find((view) => view.slot === slot)!;

async function openWorkflowSettings(page: Page, baseURL: string): Promise<void> {
  await page.goto(`${baseURL}/#/settings/workflows`);
  await expect(page.getByText("Check commands", { exact: true })).toBeVisible();
}

/** The panel's add row: repository (or subdirectory), slot, command line. */
async function addCommand(
  page: Page,
  path: string,
  slot: string,
  command: string,
): Promise<void> {
  await page.getByRole("combobox", { name: "Repository path" }).fill(path);
  await page.getByLabel("Slot").selectOption(slot);
  await page.getByLabel("Command to run").fill(command);
  await page.getByRole("button", { name: "Add command" }).click();
}

const rows = (page: Page) => page.locator(".wf-settings-check-list li");

test("the Settings table still lists, adds and removes, and every write lands in the catalog", async ({
  dashboard,
  daemon,
}) => {
  // Precondition, asserted rather than assumed: a fresh daemon projects all four slots and
  // configures none of them. Every claim below is about a change of state.
  const opening = await catalog(daemon.baseURL);
  expect(opening.map((view) => view.slot)).toEqual(["test", "lint", "typecheck", "build"]);
  expect(opening.every((view) => view.overrides.length === 0)).toBe(true);

  await openWorkflowSettings(dashboard, daemon.baseURL);
  await expect(dashboard.getByText("No commands yet - every Check node will skip and pass."))
    .toBeVisible();

  // The typed line is split into an argv and shown back BEFORE anything is stored, because
  // there is no shell in this path and the split is the daemon's own: the quoted pair is ONE
  // argument, and an operator can only trust that by seeing it numbered.
  await dashboard.getByLabel("Command to run").fill('npm run test -- --grep "a b"');
  await expect(dashboard.locator(".wf-settings-check-preview"))
    .toContainText("6. a b");

  await addCommand(dashboard, daemon.repo, "test", "npm test");
  await expect(rows(dashboard)).toHaveCount(1);
  await expect(rows(dashboard).first()).toContainText(basename(daemon.repo));
  await expect(rows(dashboard).first()).toContainText("npm test");

  // The daemon's catalog moved - not just the list. This is the assertion the panel's own
  // optimistic render cannot make on its own behalf.
  await expect
    .poll(async () => slotOf(await catalog(daemon.baseURL), "test").overrides, {
      message: "Add command should reach the Command catalog through the legacy config route",
    })
    .toEqual([{ repoRoot: daemon.repo, command: ["npm", "test"] }]);

  // A subdirectory override, which is the capability the free-text combobox exists for, and
  // a second slot beside it. The directory has to exist on disk: the panel resolves the typed
  // path to its repository before storing it, which is what makes `/repo/packages/web` a
  // storable override rather than a path that silently collapses to `/repo`.
  const nested = join(daemon.repo, "packages", "web");
  mkdirSync(nested, { recursive: true });
  await addCommand(dashboard, nested, "test", "pnpm -C . test");
  await addCommand(dashboard, daemon.repo, "lint", "npm run lint");
  await expect(rows(dashboard)).toHaveCount(3);

  await expect
    .poll(async () => {
      const views = await catalog(daemon.baseURL);
      return {
        test: slotOf(views, "test").overrides.map((entry) => entry.repoRoot),
        lint: slotOf(views, "lint").overrides.map((entry) => entry.repoRoot),
      };
    })
    .toEqual({
      test: [daemon.repo, nested],
      lint: [daemon.repo],
    });

  // The visible order: slot registry order first, then path. The old field was an
  // append-ordered array whose order no surface displayed, so this is strictly more legible
  // than what it replaces - and pinned so changing it stays a decision.
  await expect(rows(dashboard).nth(0)).toContainText("npm test");
  await expect(rows(dashboard).nth(1)).toContainText("pnpm -C . test");
  await expect(rows(dashboard).nth(2)).toContainText("npm run lint");

  // Remove is the other half of the adapter: the panel sends a SHORTER whole list, and the
  // catalog has to read that as a deletion rather than merging it.
  await rows(dashboard).nth(1).getByRole("button", { name: "Remove" }).click();
  await expect(rows(dashboard)).toHaveCount(2);
  await expect
    .poll(async () => slotOf(await catalog(daemon.baseURL), "test").overrides.length)
    .toBe(1);

  // And it survives a reload, which is the difference between stored and merely rendered.
  await dashboard.reload();
  await expect(dashboard.getByText("Check commands", { exact: true })).toBeVisible();
  await expect(rows(dashboard)).toHaveCount(2);
});

test("a global default is invisible to the old table and survives everything it saves", async ({
  dashboard,
  daemon,
}) => {
  // The catalog's new capability, and the reason the legacy projection carries overrides
  // only: a machine-wide default names no repository, so there is no honest row for it in a
  // table whose first column IS a repository. Inventing one would tell this panel a default
  // is an override, and its next save would write that fiction back as one.
  const before = slotOf(await catalog(daemon.baseURL), "typecheck");
  const written = await dashboard.request.put(
    `${daemon.baseURL}/api/workflow-commands/typecheck`,
    {
      data: {
        expectedRevision: before.revision,
        defaultCommand: ["npm", "run", "typecheck"],
        overrides: [],
      },
    },
  );
  expect(written.ok(), await written.text()).toBe(true);

  await openWorkflowSettings(dashboard, daemon.baseURL);
  await expect(dashboard.getByText("No commands yet - every Check node will skip and pass."))
    .toBeVisible();

  // Now save through the old form. It knows nothing about defaults, so it must not be able
  // to clear one.
  await addCommand(dashboard, daemon.repo, "lint", "npm run lint");
  await expect(rows(dashboard)).toHaveCount(1);
  await expect
    .poll(async () => slotOf(await catalog(daemon.baseURL), "typecheck").defaultCommand)
    .toEqual(["npm", "run", "typecheck"]);
});
