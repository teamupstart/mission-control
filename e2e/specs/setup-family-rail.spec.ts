import type { Page } from "@playwright/test";

import { homeRelative, type SetupChecksSnapshot } from "../../src/shared/setup-catalog.ts";
import { expect, test } from "../fixtures/test.ts";
import { expectRowStatus, openSetupFamily, setupRow } from "../fixtures/setup-panel.ts";

/**
 * Setup reads one family at a time through a rail.
 *
 * The point of this layer for this panel: a rail is the one shape where "the row is on the
 * page" and "the row is rendered at all" stop being the same statement. Markup assertions
 * cannot see an unmount, and the panel's deep links, its guided tour, and its Re-check all
 * cross that line. So these drive real clicks against a real daemon reading a real machine.
 */

test.describe.configure({ timeout: 120_000 });
test.use({ daemonEnv: { MC_E2E_GH_STARTS_MISSING: "1" }, setupReminder: true });

const FAMILIES = ["Agent CLIs", "Terminals", "GitHub", "Claude Code extensions", "Pipelines"];

function railItem(page: Page, family: string) {
  return page.getByRole("button", { name: new RegExp(`^${family}(:|$)`) });
}

test("the rail selects one family at a time and unmounts the rest", async ({ page, daemon }) => {
  await page.goto(`${daemon.baseURL}/#/settings/setup`);
  await expect(page.getByRole("heading", { name: "Setup", exact: true })).toBeVisible();

  // Every family stays reachable from every other one. This is the whole trade the rail
  // makes: five names always visible, one family's rows at a time.
  const rail = page.getByRole("navigation", { name: "Setup families" });
  await expect(rail).toBeVisible();
  await expect(page.locator(".setup-panel")).toHaveCSS("max-width", "1060px");
  for (const family of FAMILIES) await expect(railItem(page, family)).toBeVisible();

  // GitHub holds the only required gap in this fixture, so that is where it opens.
  await expectRowStatus(page, "dependency-gh-cli", "Missing");
  await expect(railItem(page, "GitHub")).toHaveAttribute("aria-current", "true");

  // Switching family replaces the rows rather than scrolling to them. `toHaveCount(0)` is
  // the assertion that matters and the one no markup test can make: the GitHub rows are gone
  // from the document, not merely off screen.
  await openSetupFamily(page, "agents");
  await expect(page.locator("#setup-pane")).toContainText("Claude Code");
  await expect(setupRow(page, "dependency-gh-cli")).toHaveCount(0);
  await expect(railItem(page, "GitHub")).not.toHaveAttribute("aria-current", "true");

  await openSetupFamily(page, "pipelines");
  await expect(page.locator("#setup-pane")).toContainText("ai-conductor");
  await expect(setupRow(page, "dependency-claude-cli")).toHaveCount(0);
});

test("the verdict counts every check, not the family being read", async ({ page, daemon }) => {
  await page.goto(`${daemon.baseURL}/#/settings/setup`);
  const verdict = page.locator(".setup-verdict");
  await expect(verdict).toContainText("This machine is missing something required.");
  await expect(verdict).toContainText("required gap");

  // The tick meter and the sentence describe the machine, so reading one family must not
  // change either. A per-family count belongs on the rail item, and is there.
  const before = await verdict.innerText();
  const ticks = await page.locator(".setup-tick").count();
  await openSetupFamily(page, "pipelines");
  await expect(page.locator("#setup-pane")).toContainText("ai-conductor");
  expect(await verdict.innerText()).toBe(before);
  expect(await page.locator(".setup-tick").count()).toBe(ticks);
});

test("a Re-check that repairs the open family leaves the rail where it was", async ({
  page,
  daemon,
}) => {
  await page.goto(`${daemon.baseURL}/#/settings/setup`);
  await expectRowStatus(page, "dependency-gh-cli", "Missing");

  // The opening family is derived from where the gaps are, so repairing this one changes that
  // answer. Re-deriving it here would unmount the rows the operator is reading as a reward
  // for having fixed something, which is the regression this asserts against.
  daemon.installFakeGh();
  await page.getByRole("button", { name: "Re-check" }).click();
  await expectRowStatus(page, "dependency-gh-cli", "Ready");
  await expectRowStatus(page, "dependency-gh-auth", "Ready");
  await expect(railItem(page, "GitHub")).toHaveAttribute("aria-current", "true");

  // An explicit choice also survives a Re-check.
  await openSetupFamily(page, "agents");
  await expect(page.locator("#setup-pane")).toContainText("Claude Code");
  daemon.removeFakeGh();
  await page.getByRole("button", { name: "Re-check" }).click();
  // The rail's own count is what reports the regression from another family, without moving.
  // Both GitHub rows go with the CLI: authentication cannot be checked once gh is gone.
  await expect(railItem(page, "GitHub")).toContainText("0/2");
  await expect(railItem(page, "GitHub")).toHaveAttribute("aria-label", "GitHub: 0 of 2 ready");
  await expect(railItem(page, "Agent CLIs")).toHaveAttribute("aria-current", "true");
  await expect(setupRow(page, "dependency-gh-cli")).toHaveCount(0);
});

test("a satisfied row states its evidence relative to the home directory", async ({
  page,
  daemon,
}) => {
  // Compared against the daemon's own payload rather than a guessed path: the panel's claim
  // is "what the daemon reported, with its home written as ~", so the daemon is the oracle.
  // Whether the fake binaries this suite installs happen to sit under the home is then the
  // fixture's business, and this stays exact either way.
  const snapshot = await (await fetch(`${daemon.baseURL}/api/setup/checks`)).json() as SetupChecksSnapshot;
  expect(snapshot.home, "the snapshot carries this machine's home").toBeTruthy();

  const satisfied = snapshot.rows.filter((row) => row.status.state === "satisfied");
  expect(satisfied.length, "the fixture machine has something installed to report").toBeGreaterThan(0);
  const underHome = satisfied.filter((row) => row.status.evidence.startsWith(`${snapshot.home}/`));
  expect(underHome.length, "at least one probe resolves inside the home directory").toBeGreaterThan(0);

  await page.goto(`${daemon.baseURL}/#/settings/setup`);
  for (const row of underHome) {
    await openSetupFamily(page, row.family);
    const evidence = setupRow(page, `${row.rowId.source}-${row.rowId.id}`).locator(".setup-evidence");
    // Exactly the shortened string on screen...
    await expect(evidence).toHaveText(homeRelative(row.status.evidence, snapshot.home));
    expect(homeRelative(row.status.evidence, snapshot.home)).toMatch(/^~\//);
    // ...and the absolute one still reachable, through the shared Tooltip's description
    // rather than a native title, which this codebase does not use.
    await expect(evidence).not.toHaveAttribute("title", /./);
    const describedBy = await evidence.getAttribute("aria-describedby");
    expect(describedBy, "the shortened path keeps its absolute form described").toBeTruthy();
    expect(await page.locator(`#${describedBy}`).textContent()).toBe(row.status.evidence);
  }
});
