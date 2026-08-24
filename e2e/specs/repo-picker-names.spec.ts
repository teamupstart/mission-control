import { mkdirSync } from "node:fs";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";

/**
 * What the repo picker's dropdown actually READS as.
 *
 * The bug this pins is a legibility one and it is only visible with a real dropdown open in
 * a real viewport: every row drew its full absolute path, the portalled list is exactly as
 * wide as the input that opened it, and every checkout in a workspace shares a long leading
 * prefix - so the ellipsis landed after the shared part and before the directory name, and a
 * list of eight repos came back as eight rows of `/Users/jordanma…`. The one fact that tells
 * two rows apart was the one fact being cut.
 *
 * Only this layer can see it. `test/repo-combobox-filter.test.ts` pins the pure labelling
 * rule, but no assertion on a string can see that the widget draws what that rule returns,
 * that the full path is still reachable, or that clicking a row named `demo-repo` writes an
 * absolute path into the field. `renderToStaticMarkup` cannot help either: this list only
 * exists once the input has focus, and it renders through a body-level portal.
 *
 * Both callers are checked, because the control is shared and the report came from the one
 * that is not the dispatch modal: Settings -> Task sources, adding a source.
 *
 * No model tokens: nothing here dispatches, sweeps, or launches an agent.
 */

const EVIDENCE = artifactsDir("repo-picker-names");

// Only this file wants a colliding pair of checkouts in the workspace - see `daemon.ts` for
// why that is opt-in. `test.use` is file-scoped, so the two tests that never look at the pair
// pay for it too; that is cheaper than giving the fixture a second opt-in axis.
test.use({ daemonEnv: { MC_E2E_TWIN_REPOS: "1" } });

test("the repo dropdown names checkouts by folder, and still writes the full path", async ({
  page,
  daemon,
}) => {
  await page.goto(daemon.baseURL);
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();

  // Focus opens the list, with nothing typed, which is the state the report screenshotted.
  const field = dialog.getByPlaceholder("search repos or type a path…");
  await field.click();
  const list = page.getByRole("listbox");
  await expect(list).toBeVisible();

  // The two repositories every daemon fixture seeds, named the way an operator refers to
  // them out loud. `exact` is the assertion: before this change the accessible name of each
  // row was its whole path, so a name match on the folder alone found nothing.
  await expect(list.getByRole("option", { name: "demo-repo", exact: true })).toBeVisible();
  await expect(list.getByRole("option", { name: "second-repo", exact: true })).toBeVisible();

  // And NOTHING in the list is a path - not one row, not one line of one row. Asserted over
  // every row rather than the two named above, so a regression that reintroduces a path
  // anywhere is caught even as the fixture's repo set grows. This is the assertion a first
  // pass would have failed: it drew the parent DIRECTORY under a colliding name, which under
  // this suite's temp root is `/private/var/folders/…/workspace/alpha`.
  const drawn = await list.getByRole("option").allInnerTexts();
  expect(drawn.length).toBeGreaterThan(1);
  expect(drawn.filter((row) => row.includes("/"))).toEqual([]);

  // The path did not become unreachable, it moved: the row describes itself with it, which
  // is what the hover tooltip paints and what a screen reader announces.
  await expect(list.getByRole("option", { name: "demo-repo", exact: true })).toHaveAccessibleDescription(
    daemon.repo,
  );

  if (process.env.MC_E2E_EVIDENCE) {
    mkdirSync(EVIDENCE, { recursive: true });
    await page.screenshot({ path: `${EVIDENCE}dispatch-repo-dropdown.png` });
    // oxlint-disable-next-line no-console
    console.log(`CAPTURED e2e/.artifacts/repo-picker-names/dispatch-repo-dropdown.png`);
  }

  // Picking by the short name still selects the repo by its absolute path - the compaction
  // is presentation, and the value this widget writes is unchanged.
  await list.getByRole("option", { name: "demo-repo", exact: true }).click();
  await expect(field).toHaveValue(daemon.repo);
});

test("two checkouts sharing a name each say which one they are", async ({ page, daemon }) => {
  const [alpha, beta] = daemon.twinRepos ?? [];
  expect(alpha && beta, "the twin checkouts should have been seeded for this file").toBeTruthy();

  await page.goto(daemon.baseURL);
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  const field = dialog.getByPlaceholder("search repos or type a path…");
  await field.fill("shared-lib");

  // A name is not an identity here, so each row carries ONE MORE FOLDER NAME - `alpha` and
  // `beta`, not the directories they stand for. That distinction is the whole reason this
  // test exists under a temp root: these checkouts live at
  // `/private/var/folders/1c/…/workspace/alpha/shared-lib`, so a hint that printed the parent
  // directory would put every character this widget was fixed to remove back on the row.
  // Asserted as accessible NAME rather than by reading the DOM, because that is what a person
  // hears and what makes the two rows distinguishable to anything but a mouse.
  const list = page.getByRole("listbox");
  await expect(list.getByRole("option")).toHaveCount(2);
  await expect(list.getByRole("option").first()).toHaveAccessibleName("shared-lib alpha");
  await expect(list.getByRole("option").last()).toHaveAccessibleName("shared-lib beta");
  expect((await list.getByRole("option").allInnerTexts()).filter((r) => r.includes("/"))).toEqual(
    [],
  );

  // And the hint costs the row HEIGHT, never the name's width. A first pass laid the two
  // side by side and produced `fileserve…  ~/wo…` in a settings column - both halves cut,
  // which is worse than the path this replaced. Only a laid-out browser can see it: the
  // name element must be as wide as the text it holds, with nothing clipped.
  const name = list.getByRole("option").first().locator(".combobox-option-name");
  const clipped = await name.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
  expect(clipped, "the repository name must never be truncated to make room for its hint").toBe(
    false,
  );

  if (process.env.MC_E2E_EVIDENCE) {
    mkdirSync(EVIDENCE, { recursive: true });
    await page.screenshot({ path: `${EVIDENCE}colliding-names.png` });
    // oxlint-disable-next-line no-console
    console.log(`CAPTURED e2e/.artifacts/repo-picker-names/colliding-names.png`);
  }

  // Still one full absolute path per row, and still the value picking one writes.
  await expect(list.getByRole("option").first()).toHaveAccessibleDescription(alpha);
  await expect(list.getByRole("option").last()).toHaveAccessibleDescription(beta);
  await list.getByRole("option").last().click();
  await expect(field).toHaveValue(beta);
});

test("the task sources add form gets the same named rows", async ({ page, daemon }) => {
  await page.goto(`${daemon.baseURL}/#/settings/task-sources`);
  await page.getByRole("button", { name: "Add source" }).click();

  const field = page.getByPlaceholder("search repos or type a path…");
  await field.click();
  const list = page.getByRole("listbox");
  await expect(list.getByRole("option", { name: "demo-repo", exact: true })).toBeVisible();
  expect((await list.getByRole("option").allInnerTexts()).filter((r) => r.includes("/"))).toEqual(
    [],
  );

  // The colliding pair is asserted HERE too, and not only in the dispatch modal, because this
  // is the caller the report came from and it is the narrow one: the settings column gives
  // this field a fraction of the modal's width, so it is where a hint that cost the name its
  // room, or one that fell back to a path, shows up first. Same two rows, same two folder
  // names, no path on either.
  const twins = list.getByRole("option", { name: /^shared-lib / });
  await expect(twins).toHaveCount(2);
  await expect(twins.first()).toHaveAccessibleName("shared-lib alpha");
  await expect(twins.last()).toHaveAccessibleName("shared-lib beta");

  if (process.env.MC_E2E_EVIDENCE) {
    mkdirSync(EVIDENCE, { recursive: true });
    await page.screenshot({ path: `${EVIDENCE}task-sources-repo-dropdown.png` });
    // oxlint-disable-next-line no-console
    console.log(`CAPTURED e2e/.artifacts/repo-picker-names/task-sources-repo-dropdown.png`);
  }

  await list.getByRole("option", { name: "demo-repo", exact: true }).click();
  await expect(field).toHaveValue(daemon.repo);
});
