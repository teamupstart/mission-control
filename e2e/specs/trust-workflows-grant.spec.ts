import { mkdirSync } from "node:fs";
import { basename } from "node:path";

import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";

const EVIDENCE = artifactsDir("trust-workflows-grant");

/**
 * The Workflows grant, as a Trust column.
 *
 * Workflows' `repoAllowlist` used to be edited by an inline list on the Workflows settings
 * panel, which left the loudest grant in the app - the one that types into a live agent's
 * composer, and the one that runs branch-authored code on disk - invisible from the table
 * that claims to hold "every grant that lets Mission Control act outside this app". It is a
 * column now, and the panel shows a count and a link.
 *
 * Driven through the browser because every claim here spans layers no other test layer
 * crosses: a cell click has to reach `PUT /api/workflows/config` with the WHOLE config blob
 * intact (the other three columns patch, this one does not), the daemon's stored allowlist
 * has to actually move, and a second settings panel has to agree about the count. The render
 * tests pin markup shape against a stubbed state and cannot see any of that.
 *
 * Nothing here dispatches, so no agent binary is launched and no model tokens are spent.
 */

/**
 * Photograph a state this spec has already asserted on.
 *
 * Inside the asserting test rather than in a staged capture spec, on `library.spec.ts`'s
 * rule: the point of the picture is that the assertions around it passed on the same run,
 * so the image and the measurement cannot drift apart. A staged screenshot of the Trust
 * matrix would be exactly the artifact that keeps looking correct after the grant stops
 * reaching the daemon.
 *
 * Behind `MC_E2E_EVIDENCE` like every other capture in this suite: an ordinary
 * `npm run test:e2e` would rewrite the binaries for no added signal.
 */
async function shoot(
  page: Page,
  name: string,
  { preserveHover = false }: { preserveHover?: boolean } = {},
): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  if (preserveHover) {
    // This capture is the tooltip itself. Moving the pointer or resizing first would dismiss
    // the exact visual state the surrounding assertions just proved was present.
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${EVIDENCE}${name}.png` });
    // eslint-disable-next-line no-console
    console.log(`CAPTURED e2e/.artifacts/trust-workflows-grant/${name}.png`);
    return;
  }
  const original = page.viewportSize() ?? { width: 1280, height: 720 };
  // Off every control first: `Tooltip` portals a bubble under a resting pointer, and the
  // cells being photographed are exactly what the pointer was last clicking.
  await page.mouse.move(0, 0);
  // Wide enough that the six grid tracks are at their intended widths rather than at
  // whatever the default viewport squeezes them to - the column layout is the thing on
  // trial in half of these captures.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${EVIDENCE}${name}.png`, fullPage: true });
  await page.setViewportSize(original);
  await page.waitForTimeout(150);
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/trust-workflows-grant/${name}.png`);
}

/** The stored Workflow config, read straight from the daemon rather than off the screen. */
async function storedConfig(
  baseURL: string,
): Promise<{ repoAllowlist: string[]; checksEnabled: boolean; liveEnabled: boolean }> {
  const res = await fetch(`${baseURL}/api/workflows/config`);
  return (await res.json()) as {
    repoAllowlist: string[];
    checksEnabled: boolean;
    liveEnabled: boolean;
  };
}

/** Open a settings category by its hash route and wait for the panel to be on screen. */
async function openSettings(page: Page, category: string, heading: RegExp): Promise<void> {
  await page.goto(`${page.url().split("#")[0]}#/settings/${category}`);
  await expect(page.getByText(heading).first()).toBeVisible();
}

/** Put `repo` in the matrix by typing its path into the add row. Grants nothing. */
async function stageRepo(page: Page, repo: string): Promise<void> {
  await page.getByRole("combobox", { name: /search repos or type a path/i }).fill(repo);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(
    page.getByRole("table", { name: "Repository trust grants" }).locator(".trust-repo-path"),
  ).toHaveText(basename(repo));
}

test("repository labels use directory names and reveal full paths on hover", async ({
  dashboard,
  daemon,
}) => {
  await openSettings(dashboard, "trust", /Every grant that lets Mission Control act outside/);
  await stageRepo(dashboard, daemon.repo);

  const label = dashboard
    .getByRole("table", { name: "Repository trust grants" })
    .locator(".trust-repo-path");
  await expect(label).toHaveText(basename(daemon.repo));
  await expect(label).toHaveAccessibleDescription(daemon.repo);

  await label.hover();
  const tooltip = dashboard.locator(".tooltip");
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toHaveText(daemon.repo);
  await shoot(dashboard, "repository-path-tooltip", { preserveHover: true });
});

test("warning lists disambiguate repositories that share a directory name", async ({
  dashboard,
  daemon,
}) => {
  const repos = ["/workspaces/one/api", "/workspaces/two/api"];
  const current = await storedConfig(daemon.baseURL);
  const saved = await dashboard.request.put(`${daemon.baseURL}/api/workflows/config`, {
    data: { ...current, checksEnabled: true, repoAllowlist: repos },
  });
  expect(saved.ok(), await saved.text()).toBe(true);

  await openSettings(dashboard, "trust", /Every grant that lets Mission Control act outside/);
  const warning = dashboard.locator("p.trust-arm-note");
  await expect(warning).toBeVisible();
  await expect(warning).toContainText(repos[0]);
  await expect(warning).toContainText(repos[1]);
  await expect(warning).not.toContainText("in api, api");
  await shoot(dashboard, "colliding-repository-warning");
});

test("granting the Workflows cell writes the daemon's workflow allowlist", async ({
  dashboard,
  daemon,
}) => {
  // Precondition, asserted rather than assumed: the grant ships empty, so a pass below
  // cannot come from a repo that was already allowlisted.
  expect((await storedConfig(daemon.baseURL)).repoAllowlist).toEqual([]);

  await openSettings(dashboard, "trust", /Every grant that lets Mission Control act outside/);
  await stageRepo(dashboard, daemon.repo);

  // Staged and ungranted: the cell offers to grant, which is the "adding is configuration,
  // enabling is consent" rule stated as a control rather than as prose.
  const cell = dashboard.getByRole("button", {
    name: `Grant: Workflows act for ${daemon.repo}`,
  });
  await expect(cell).toBeVisible();
  await expect(cell).toHaveAttribute("aria-pressed", "false");
  expect((await storedConfig(daemon.baseURL)).repoAllowlist).toEqual([]);

  await cell.click();

  // The daemon's own stored list moved - not just the pill.
  await expect
    .poll(async () => (await storedConfig(daemon.baseURL)).repoAllowlist, {
      message: "the cell click should reach PUT /api/workflows/config",
    })
    .toEqual([daemon.repo]);
  await expect(
    dashboard.getByRole("button", { name: `Revoke: Workflows act for ${daemon.repo}` }),
  ).toHaveAttribute("aria-pressed", "true");

  await shoot(dashboard, "matrix-workflows-granted");
});

test("the grant survives the round trip without flattening the rest of the config", async ({
  dashboard,
  daemon,
}) => {
  // Workflows' route is a PUT of the WHOLE blob, unlike the three columns that patch. A cell
  // click that spread a stale or default config would silently reset the switches beside it -
  // the failure this test exists for, and one the pill would look perfectly healthy after.
  const before = await storedConfig(daemon.baseURL);

  await openSettings(dashboard, "trust", /Every grant that lets Mission Control act outside/);
  await stageRepo(dashboard, daemon.repo);
  await dashboard
    .getByRole("button", { name: `Grant: Workflows act for ${daemon.repo}` })
    .click();

  await expect
    .poll(async () => (await storedConfig(daemon.baseURL)).repoAllowlist)
    .toEqual([daemon.repo]);

  const after = await storedConfig(daemon.baseURL);
  expect(after.liveEnabled).toBe(before.liveEnabled);
  expect(after.checksEnabled).toBe(before.checksEnabled);
});

test("the Workflows panel reports the grant count and links back to Trust", async ({
  dashboard,
  daemon,
}) => {
  await openSettings(dashboard, "trust", /Every grant that lets Mission Control act outside/);
  await stageRepo(dashboard, daemon.repo);
  await dashboard
    .getByRole("button", { name: `Grant: Workflows act for ${daemon.repo}` })
    .click();
  await expect
    .poll(async () => (await storedConfig(daemon.baseURL)).repoAllowlist)
    .toEqual([daemon.repo]);

  await openSettings(dashboard, "workflows", /Review workflows run Personas/);

  // A count, and the singular reads correctly - the whole reason the count is the object of
  // the clause rather than its subject.
  await expect(dashboard.getByText("Workflows may act in 1 repository")).toBeVisible();
  // And no second editor for the same stored list, which is the state the move rules out.
  await expect(dashboard.getByRole("button", { name: "Add repository" })).toBeHidden();

  await shoot(dashboard, "workflows-panel-grant-summary");

  await dashboard.getByRole("button", { name: "Manage in Trust" }).click();
  await expect(
    dashboard.getByRole("button", { name: `Revoke: Workflows act for ${daemon.repo}` }),
  ).toBeVisible();
});

test("armed Command execution flags the granted cell, and Turn Commands off clears it", async ({
  dashboard,
  daemon,
}) => {
  await openSettings(dashboard, "trust", /Every grant that lets Mission Control act outside/);
  await stageRepo(dashboard, daemon.repo);
  await dashboard
    .getByRole("button", { name: `Grant: Workflows act for ${daemon.repo}` })
    .click();
  await expect
    .poll(async () => (await storedConfig(daemon.baseURL)).repoAllowlist)
    .toEqual([daemon.repo]);

  // Granted but disarmed: no command can run, so the matrix stays quiet. Amber on an inert
  // grant is exactly how a table teaches an operator to stop reading its warnings.
  await expect(dashboard.getByText(/Workflow Commands are on/)).toBeHidden();

  // Arm checks from the Workflows panel, through its confirm dialog - the same path an
  // operator takes, so the consent copy is on screen when the grant becomes live.
  //
  // `click()`, never `check()`: the box does NOT flip on the click, and that is the feature.
  // The switch is consent-gated, so it stays unchecked until the modal is accepted, and
  // `check()` fails the interaction as "clicking did not change its state". Asserted below
  // rather than only worked around, because a box that armed itself before the dialog was
  // read would be the actual regression here.
  await openSettings(dashboard, "workflows", /Review workflows run Personas/);
  // The switch is the console's `ConsoleSwitch` now, like Live delivery beside it: the
  // checkbox is `appearance: none` under a track span, so the label is what an operator hits
  // and the checkbox is what the assertions read.
  const checks = dashboard.getByRole("checkbox", { name: "Allow workflow Commands" });
  const checksSwitch = dashboard.locator('.sc-card[data-anchor="workflows/checks"] label.sc-switch');
  await checksSwitch.click();
  await expect(checks).not.toBeChecked();
  // The consent sentence that names what is actually being authorized - not "runs a command"
  // but "runs THIS BRANCH's code". Matched on the modal's own wording, which is deliberately
  // not the wording of the standing warning the panel shows once the switch is on.
  await expect(dashboard.getByText(/executes branch-authored code/)).toBeVisible();
  await dashboard.getByRole("button", { name: "Allow Commands" }).click();
  await expect(checks).toBeChecked();
  await expect
    .poll(async () => (await storedConfig(daemon.baseURL)).checksEnabled)
    .toBe(true);

  await openSettings(dashboard, "trust", /Every grant that lets Mission Control act outside/);

  // Now the footnote flies, names the repository, and refuses to claim a sandbox. Matched on
  // the paragraph's own opening text rather than on "branch-authored code", which is wrapped
  // in a `<strong>` and would resolve the locator to that span - and a span that cannot
  // contain the repo path would fail the naming assertion for the wrong reason.
  const note = dashboard.getByText(/Workflow Commands are on/);
  await expect(note).toBeVisible();
  await expect(note).toContainText("branch-authored code");
  await expect(note).toContainText("It is not a sandbox");
  await expect(note).toContainText(basename(daemon.repo));
  await expect(note).not.toContainText(daemon.repo);

  await shoot(dashboard, "checks-armed-footnote");

  // The offered fix works from here, without a trip back to the other panel.
  await dashboard.getByRole("button", { name: "Turn Commands off" }).click();
  await expect
    .poll(async () => (await storedConfig(daemon.baseURL)).checksEnabled, {
      message: "Turn Commands off should disarm the switch on the Workflows config",
    })
    .toBe(false);
  await expect(dashboard.getByText(/Workflow Commands are on/)).toBeHidden();

  // Disarming the switch is not revoking the grant: the repo may still take Live deliveries,
  // which is the distinction the single column has to keep legible.
  expect((await storedConfig(daemon.baseURL)).repoAllowlist).toEqual([daemon.repo]);
});

test("the armed-Commands warning survives the config poll failing", async ({
  dashboard,
  daemon,
}) => {
  // The failure this exists for, driven end to end rather than argued about.
  //
  // `useWorkflowSettings` replaces its config with null on ANY read that fails - the
  // deliberate "unknown, not off" rule - and the first cut of this feature read the arming
  // straight off that config. So five seconds after the daemon went quiet, the amber saying
  // a workflow may execute branch-authored code retired itself, in all three places at
  // once, while the daemon's stored config was untouched and still armed.
  //
  // Only a browser can catch it: the poll, the null, the re-render and the three surfaces
  // are four separate layers, and every unit test around them passes with the bug in place.
  await openSettings(dashboard, "trust", /Every grant that lets Mission Control act outside/);
  await stageRepo(dashboard, daemon.repo);
  await dashboard
    .getByRole("button", { name: `Grant: Workflows act for ${daemon.repo}` })
    .click();
  await expect
    .poll(async () => (await storedConfig(daemon.baseURL)).repoAllowlist)
    .toEqual([daemon.repo]);

  await openSettings(dashboard, "workflows", /Review workflows run Personas/);
  await dashboard.locator('.sc-card[data-anchor="workflows/checks"] label.sc-switch').click();
  await dashboard.getByRole("button", { name: "Allow Commands" }).click();
  await expect
    .poll(async () => (await storedConfig(daemon.baseURL)).checksEnabled)
    .toBe(true);

  await openSettings(dashboard, "trust", /Every grant that lets Mission Control act outside/);
  await expect(dashboard.getByText(/Workflow Commands are on/)).toBeVisible();
  // The rail dot agrees before the daemon goes away, so the assertion after it is a change
  // rather than a state that was never there.
  const dot = dashboard.getByRole("img", { name: /Trust needs a look/ });
  await expect(dot).toBeVisible();

  // Now the daemon stops answering for this route only. Aborting rather than 500ing, so the
  // fetch rejects exactly as an unreachable daemon makes it reject.
  await dashboard.route("**/api/workflows/config", (route) => route.abort());

  // Past one full 5s poll interval, so a config read has certainly failed and landed.
  await expect
    .poll(
      async () =>
        dashboard.getByText(/were .*on.* at the last reading|Workflow Commands are on/).count(),
      { timeout: 15_000, message: "some armed-Commands warning must survive the failed poll" },
    )
    .toBeGreaterThan(0);

  // The specific shape: it degrades to the unconfirmed sentence rather than vanishing, and
  // it stops naming repositories it can no longer read.
  await expect(dashboard.getByText(/at the last reading/)).toBeVisible();
  await expect(dashboard.getByText(/nothing here has been disarmed/)).toBeVisible();
  // And the rail dot has NOT gone dark, which was the headline regression.
  await expect(dot).toBeVisible();

  // The daemon never disarmed anything - only our ability to read it lapsed.
  expect((await storedConfig(daemon.baseURL)).checksEnabled).toBe(true);
});
