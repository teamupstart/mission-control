import { expect, test } from "../fixtures/test.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";

/**
 * A display item that ships OFF ships off on an UPGRADE, not only on a fresh profile.
 *
 * The mechanism that makes an item ship hidden is its id in `UI_CONFIG_DEFAULTS.
 * hiddenDisplayItems`, and that default reaches a record which stored no list at all - which
 * is a brand-new profile and nobody else. A stored list is the operator's OWN answer and is
 * handed back verbatim, because merging a default into it would make un-hiding an item
 * impossible. So every operator who has ever unchecked one card item carries a list that
 * cannot mention an id invented later, and `workflowDetails` would arrive switched ON for
 * exactly the people who use this panel most.
 *
 * `DISPLAY_ITEM_HIDDEN_SEEDS` plus the `hiddenDisplayItemsSeed` marker closes that: the ids
 * are added once, then never again, so checking the box afterwards sticks.
 *
 * Here rather than only in `test/` because the unit layers can prove the migration and
 * cannot prove the CONSEQUENCE. What an upgraded operator actually meets is a checkbox in
 * Settings and a card on the Board, and only a browser against a real daemon can read those.
 *
 * The legacy record is seeded straight into `app_config`, which is the one thing this suite
 * cannot produce for real: it is a row written by a build that no longer exists. Everything
 * downstream of the seed - the daemon's read, its migration, the HTTP GET, the dashboard's
 * hydration, the panel - is the real thing.
 */

/** The item under test, and a card item this operator is pretending to have hidden already. */
const ITEM = "Workflow details";
const THEIR_CHOICE = "Cost";

test("an upgraded profile that customised this panel still gets Workflow details off", async ({
  page,
  daemon,
}) => {
  /*
   * The record a pre-upgrade operator has: a layout they picked, and a hidden list they
   * wrote. No `hiddenDisplayItemsSeed`, because no build that could have written this row
   * had one - that absence is exactly what the migration reads as "never seeded".
   *
   * `cost` and not `worktree`: it has to be an item that predates this release AND is not in
   * the shipped default list, or the assertion below could not tell a preserved choice from
   * a default.
   */
  withDaemonDb(daemon, (db) => {
    db.prepare(
      `INSERT INTO app_config (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    ).run("ui", JSON.stringify({ layout: "board", hiddenDisplayItems: ["cost"] }));
  });

  // The raw `page` fixture, not `dashboard`: that one PUTs preferences of its own on the way
  // in, which would overwrite the very row this spec is about.
  await page.goto(`${daemon.baseURL}/#/settings/display`);
  const panel = page.locator('[data-anchor="display/board-card"]');
  await expect(panel).toBeVisible();

  // The claim, on the surface an operator would look at.
  await expect(panel.getByRole("checkbox", { name: ITEM, exact: true })).not.toBeChecked();
  // Their own answer survived the migration rather than being replaced by the default list.
  await expect(panel.getByRole("checkbox", { name: THEIR_CHOICE, exact: true }))
    .not.toBeChecked();
  // And an item that shipped hidden BEFORE the marker existed is not retroactively re-hidden:
  // there is no way to tell an operator who never had it from one who switched it on, so
  // seeding it would take away a cell somebody chose to keep.
  await expect(panel.getByRole("checkbox", { name: "Worktree", exact: true })).toBeChecked();

  // The preference is now the operator's to change, and it STICKS - the direction an
  // unconditional migration gets wrong, where the checkbox appears to work and then reverts.
  const setting = panel.getByRole("checkbox", { name: ITEM, exact: true });
  await setting.check();
  await expect(page.locator(".board-card-preview-stage")
    .getByRole("button", { name: "Show full workflow" })).toBeVisible();

  await page.reload();
  await expect(page.locator('[data-anchor="display/board-card"]')
    .getByRole("checkbox", { name: ITEM, exact: true })).toBeChecked();
  await expect(page.locator(".board-card-preview-stage")
    .getByRole("button", { name: "Show full workflow" })).toBeVisible();

  // And off again, still sticking, so the migration is genuinely one-shot in both directions.
  await page.locator('[data-anchor="display/board-card"]')
    .getByRole("checkbox", { name: ITEM, exact: true }).uncheck();
  await page.reload();
  await expect(page.locator('[data-anchor="display/board-card"]')
    .getByRole("checkbox", { name: ITEM, exact: true })).not.toBeChecked();
});
