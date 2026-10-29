import { mkdirSync } from "node:fs";
import { basename } from "node:path";

import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";

const EVIDENCE = artifactsDir("trust-batch-add");

/**
 * Trust adds many repositories at once, and an add grants the defaults.
 *
 * The page is two panes side by side: "Add repositories" picks any number of the workspace's
 * checkouts (or a typed path) and adds them in one batch, and "Trusted" is the matrix with a
 * filter of its own. Every repository an add writes gets Foreman, Workflows and GitHub
 * Inspector, and never YOLO merges. Each claim is asserted against the daemon's own stored
 * allowlists as well as the cells, because a pill that flips without the route is a lie.
 *
 * Twin repositories are opted in so the picker holds four rows, two of which share a name -
 * the case where the row has to say which is which. Nothing here dispatches, so no agent
 * binary runs and no model tokens are spent.
 */

test.use({ daemonEnv: { MC_E2E_TWIN_REPOS: "1" } });

async function shoot(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/trust-batch-add/${name}.png`);
}

/** One subsystem's stored repository allowlist, read straight from the daemon. */
async function allowlist(baseURL: string, route: string): Promise<string[]> {
  const res = await fetch(`${baseURL}/api/${route}/config`);
  return ((await res.json()) as { repoAllowlist: string[] }).repoAllowlist;
}

const GRANTED = ["Foreman sends live", "Workflows act", "GitHub Inspector posts reviews"];

test("several picked repositories are added in one batch with every grant but YOLO", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.setViewportSize({ width: 1440, height: 900 });
  await dashboard.goto(`${daemon.baseURL}/#/settings/trust`);

  const addPane = dashboard.getByRole("group", { name: "Add repositories" });
  const table = dashboard.getByRole("table", { name: "Repository trust grants" });
  const addButton = addPane.getByRole("button", { name: /^Add/ });

  // Both panes, and the button that adds, are on screen without scrolling anything.
  await expect(addPane).toBeInViewport();
  await expect(table.getByText("Repository", { exact: true })).toBeInViewport();
  await expect(addButton).toBeInViewport({ ratio: 1 });
  await expect(addButton).toHaveText("Add repositories");
  await expect(addButton).toBeDisabled();
  // The legend says what an add writes before anything is picked.
  await expect(addPane.getByText("New repositories get")).toBeVisible();
  await expect(addPane.getByText("YOLO merges off")).toBeVisible();

  const checkboxes = addPane.getByRole("checkbox");
  await expect(checkboxes).toHaveCount(4);
  await expect(addPane.getByText("4 available")).toBeVisible();

  // Search narrows the list by name, and Select all shown picks exactly what it shows. The
  // two `shared-lib` rows say which folder each lives in.
  const search = addPane.getByRole("searchbox", { name: "Search repositories to add" });
  await search.fill("shared");
  await expect(checkboxes).toHaveCount(2);
  await expect(addPane.getByText("alpha", { exact: true })).toBeVisible();
  await expect(addPane.getByText("beta", { exact: true })).toBeVisible();
  await addPane.getByRole("button", { name: "Select all shown" }).click();
  await expect(addPane.getByText("2 selected")).toBeVisible();

  // Picks survive a search that hides them, so a batch can be built from several searches.
  await search.fill("");
  await expect(checkboxes).toHaveCount(4);
  await addPane.getByRole("checkbox", { name: `Select ${daemon.repo}` }).check();
  await expect(addPane.getByText("3 selected")).toBeVisible();
  await expect(addButton).toHaveText("Add 3 repositories");
  await shoot(dashboard, "picked-three");

  await addButton.click();

  // One batch: all three rows arrive, tagged new, and the picker no longer offers them.
  await expect(table.locator(".trust-repo-path")).toHaveCount(3);
  await expect(table.getByText("new", { exact: true })).toHaveCount(3);
  await expect(checkboxes).toHaveCount(1);
  await expect(addPane.getByRole("checkbox", { name: `Select ${daemon.secondRepo}` }))
    .toBeVisible();
  await expect(addButton).toHaveText("Add repositories");

  // Every new row holds the three default grants and offers YOLO as a deliberate click.
  for (const grant of GRANTED) {
    await expect(table.getByRole("button", { name: new RegExp(`^Revoke: ${grant} for `) }))
      .toHaveCount(3);
  }
  await expect(table.getByRole("button", { name: /^Grant: YOLO merges for / })).toHaveCount(3);
  await expect(table.getByRole("button", { name: `Revoke: Foreman sends live for ${daemon.repo}` }))
    .toHaveAttribute("aria-pressed", "true");

  // And the daemon's own lists moved - three in each default-granted list, none in Shipping's.
  for (const route of ["foreman", "workflows", "inspector"]) {
    await expect
      .poll(async () => (await allowlist(daemon.baseURL, route)).length, {
        message: `${route} should hold the whole batch`,
      })
      .toBe(3);
    expect(await allowlist(daemon.baseURL, route)).toContain(daemon.repo);
  }
  expect(await allowlist(daemon.baseURL, "shipping")).toEqual([]);
  await shoot(dashboard, "added-three");

  // The trusted pane filters by name, and says so when nothing matches.
  const filter = dashboard.getByRole("searchbox", { name: "Filter trusted repositories" });
  await filter.fill("shared");
  await expect(table.locator(".trust-repo-path")).toHaveCount(2);
  await expect(table.locator(".trust-repo-path")).toHaveText(["shared-lib", "shared-lib"]);
  await shoot(dashboard, "filtered-trusted");
  await filter.fill("no-such-repo");
  await expect(table.locator(".trust-repo-path")).toHaveCount(0);
  await expect(dashboard.getByText("No trusted repositories match that filter.")).toBeVisible();
  await filter.fill("");
  await expect(table.locator(".trust-repo-path")).toHaveCount(3);

  // Survives a reload: the rows come from the allowlists, not from page state.
  await dashboard.reload();
  await expect(table.locator(".trust-repo-path")).toHaveCount(3);
  await expect(table.getByText("new", { exact: true })).toHaveCount(0);
});

test("a typed path is added with the defaults, and a path already trusted is refused", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.setViewportSize({ width: 1440, height: 900 });
  await dashboard.goto(`${daemon.baseURL}/#/settings/trust`);

  const addPane = dashboard.getByRole("group", { name: "Add repositories" });
  const table = dashboard.getByRole("table", { name: "Repository trust grants" });
  const path = addPane.getByRole("textbox", { name: "Repository path" });

  await path.fill(daemon.repo);
  await expect(addPane.getByRole("button", { name: "Add 1 repository" })).toBeEnabled();
  await path.press("Enter");

  await expect(table.locator(".trust-repo-path")).toHaveText([basename(daemon.repo)]);
  await expect(path).toHaveValue("");
  for (const grant of GRANTED) {
    await expect(table.getByRole("button", { name: `Revoke: ${grant} for ${daemon.repo}` }))
      .toBeVisible();
  }
  await expect(table.getByRole("button", { name: `Grant: YOLO merges for ${daemon.repo}` }))
    .toBeVisible();
  await expect.poll(() => allowlist(daemon.baseURL, "foreman")).toEqual([daemon.repo]);
  expect(await allowlist(daemon.baseURL, "shipping")).toEqual([]);

  // The same checkout again is refused rather than written twice, and the typed path stays
  // so it can be corrected.
  await path.fill(daemon.repo);
  await addPane.getByRole("button", { name: "Add 1 repository" }).click();
  await expect(addPane.getByText(`${daemon.repo} is already in the matrix.`)).toBeVisible();
  await expect(path).toHaveValue(daemon.repo);
  await expect(table.locator(".trust-repo-path")).toHaveCount(1);
  expect(await allowlist(daemon.baseURL, "foreman")).toEqual([daemon.repo]);
  await shoot(dashboard, "already-trusted");
});
