import type { Locator, Page } from "@playwright/test";

/**
 * How a browser test drives the Conductor settings panel.
 *
 * The panel is a directory beside a detail pane: the repository list is paged and opens on
 * what Conductor manages, and one repository's switch, facts and actions live in the pane
 * beside it rather than in its row. So "switch this repository on" is two steps - pick the
 * row, then move the control - and four specs need the same two.
 *
 * Here rather than copied into each of them, and here rather than in `conductor.ts`: that
 * file is deliberately free of `@playwright/test` so `test/` can import its seeding half,
 * and these are page helpers. Nothing in this module selects by `data-testid`; rows, tiles
 * and the pane are reached by role and accessible name, which is what keeps those names
 * honest.
 */

/** The paged directory column. */
export function conductorDirectory(page: Page): Locator {
  return page.getByRole("list", { name: "Conductor repositories" });
}

/** The pane the directory drives - one repository's whole setup. */
export function conductorDetail(page: Page): Locator {
  return page.getByRole("region", { name: "Selected repository" });
}

/**
 * The directory's ROWS.
 *
 * Never "the buttons in the directory": the empty state offers a button of its own (widen
 * the filter), and counting that as a row is how a "no rows are drawn" assertion passes
 * while saying nothing.
 */
export function conductorRows(page: Page): Locator {
  return conductorDirectory(page).locator("button.conductor-row");
}

/**
 * What the directory says when it has no rows.
 *
 * A sibling of the list rather than a child of it - a `role="list"` may only hold list
 * items - so it is reached on its own rather than through the list.
 */
export function conductorDirectoryEmpty(page: Page): Locator {
  return page.locator(".conductor-directory-empty");
}

/** One filter tile, by the label under its count. The tiles ARE the filter. */
export function conductorTile(page: Page, label: string): Locator {
  return page.getByRole("button", { name: new RegExp(`^\\d+ ${label}$`) });
}

/**
 * One directory row, by the checkout it names.
 *
 * A row is named by its leaf and the directory it sits in, not by its whole absolute path -
 * the path would spend a 300px row on a prefix every repository in a workspace shares - so
 * this matches on the leaf, which is what a person reads the row by too.
 */
export function conductorRepoRow(page: Page, repoRoot: string): Locator {
  const leaf = repoRoot.replace(/\/+$/, "").split("/").pop() ?? repoRoot;
  return conductorDirectory(page).getByRole("button", { name: new RegExp(escapeRe(leaf)) });
}

/** One labelled fact in the detail pane - "Registered with Conductor", "Dispatch ready". */
export function conductorFact(page: Page, label: string): Locator {
  return conductorDetail(page).locator("p.conductor-fact", { hasText: label });
}

/** Open a repository in the detail pane. */
export async function selectConductorRepo(page: Page, repoRoot: string): Promise<void> {
  await conductorRepoRow(page, repoRoot).click();
}

/**
 * Flip the selected repository's observation switch.
 *
 * The click goes to the `<label>` rather than to the checkbox, because the switch's track
 * is drawn over its input - so the label is both what a person clicks and the only target
 * whose click reaches the native control.
 */
export async function toggleConductorObservation(page: Page): Promise<void> {
  await conductorDetail(page).locator("label.sc-switch").click();
}

/** Pick a repository and flip its observation switch, which is the pair almost every use is. */
export async function observeConductorRepo(page: Page, repoRoot: string): Promise<void> {
  await selectConductorRepo(page, repoRoot);
  await toggleConductorObservation(page);
}

export function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
