import { mkdirSync } from "node:fs";

import type { Page } from "@playwright/test";

import { artifactsDir } from "../fixtures/artifacts.ts";
import { expect, test } from "../fixtures/test.ts";

/**
 * Settings → Models: Foreman's four roles and the GitHub Inspector's review, on one page.
 *
 * Three claims, and only a browser can make any of them.
 *
 * FIRST, each Foreman role runs on a provider of its own. The markup layer can see five
 * selects; what it cannot see is whether choosing Codex in the Review row travels through
 * `PUT /api/foreman/config`, survives `setForemanConfig`'s top-level spread without taking a
 * sibling with it, and comes back on a fresh load as a change to THAT row alone. A patch that
 * round-tripped a stale blob renders identically until something else is quietly reverted, so
 * this reloads and reads the neighbours back.
 *
 * SECOND, the controls really left their old panels. A pointer beside a still-rendered select
 * would be the worst of both: two surfaces writing one blob, and search with two places to
 * send one operator. Asserted as an absence in the browser, where an absence is checkable.
 *
 * THIRD, ⌘K still finds them. The index entries were re-pointed to another category with new
 * anchors, and a search hit that scrolls nowhere is worse than no hit - the operator concludes
 * the setting is gone. That is the whole chord-to-category-to-scroll path, and no unit test
 * touches more than one link of it.
 *
 * NO AGENT IS DISPATCHED. This is the settings page against a daemon - no binary runs and no
 * model tokens are spent. Every control is reached by role and accessible name; there is no
 * `data-testid` in these panels to reach for.
 */

const EVIDENCE = artifactsDir("settings-foreman-inspector-models");

/**
 * `into` scrolls a group into frame first. The settings body is its own scroller inside a
 * fixed-height app shell, so a `fullPage` screenshot is still one viewport of the TOP of the
 * page - which for these groups is the background jobs and nothing this phase changed.
 */
async function shoot(page: Page, name: string, into?: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  if (into) {
    await page.locator(`[data-anchor="${into}"]`).scrollIntoViewIfNeeded();
    await expect(page.locator(`[data-anchor="${into}"]`)).toBeVisible();
  }
  // `Tooltip` portals a bubble over whatever is being photographed once anything is hovered.
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${EVIDENCE}${name}.png`, animations: "disabled" });
  // oxlint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/settings-foreman-inspector-models/${name}.png`);
}

/** Every Foreman role's provider select, by the accessible name its row gives it. */
const ROLE_PROVIDERS = [
  "Foreman Review provider",
  "Foreman Verify provider",
  "Foreman Triage provider",
  "Foreman Backlog provider",
] as const;

/**
 * Land on the panel and wait for the daemon's answer.
 *
 * Every control renders disabled until its hook has both the config and the status - the
 * page's way of refusing to present shipped defaults as the daemon's state - so "enabled" is
 * the honest readiness signal here, not a timeout.
 */
async function openModels(page: Page, baseURL: string): Promise<void> {
  await page.goto(`${baseURL}/#/settings/models`);
  await expect(page.getByRole("combobox", { name: "Foreman Review provider" })).toBeEnabled();
  await expect(page.getByRole("combobox", { name: "Foreman Review model" })).toBeEnabled();
}

test("every app-owned model call is on one page, in its own group", async ({
  dashboard,
  daemon,
}) => {
  // The claim the page makes: "what is this app spending, and on whose account?" answered in
  // one screen. Enumerated here so a group that silently stops rendering is a failure rather
  // than a quieter page.
  await openModels(dashboard, daemon.baseURL);

  await expect(dashboard.getByRole("radio", { name: "Claude Code" })).toBeChecked();
  await expect(dashboard.getByRole("combobox", { name: "Goal provider" })).toBeVisible();
  await expect(dashboard.getByRole("combobox", { name: "Foreman provider" })).toBeVisible();
  for (const name of ROLE_PROVIDERS) {
    await expect(dashboard.getByRole("combobox", { name })).toBeVisible();
  }
  await expect(dashboard.getByRole("combobox", { name: "Inspector Review provider" }))
    .toBeVisible();
  await expect(
    dashboard.getByRole("table", { name: /GitHub Inspector's review call/ }),
  ).toBeVisible();
  await shoot(dashboard, "01-one-page", "models/foreman");
});

test("two Foreman roles run on different providers, and only those roles move", async ({
  dashboard,
  daemon,
}) => {
  await openModels(dashboard, daemon.baseURL);

  // Every role starts inheriting, and the option says what it inherits FROM - which for a
  // Foreman role is Foreman's own All roles value, not the app-wide picker. One extra rung
  // than a background job has, and the one an operator would otherwise have to guess.
  for (const name of ROLE_PROVIDERS) {
    await expect(dashboard.getByRole("combobox", { name })).toHaveValue("");
    await expect(
      dashboard.getByRole("combobox", { name }).getByRole("option").first(),
    ).toHaveText("Inherit - Claude Code");
  }

  // The split this phase exists for: the deep pair somewhere different from the cheap pair.
  await dashboard.getByRole("combobox", { name: "Foreman Review provider" }).selectOption("codex");
  await dashboard.getByRole("combobox", { name: "Foreman Verify provider" }).selectOption("codex");

  await openModels(dashboard, daemon.baseURL);
  await expect(dashboard.getByRole("combobox", { name: "Foreman Review provider" })).toHaveValue("codex");
  await expect(dashboard.getByRole("combobox", { name: "Foreman Verify provider" })).toHaveValue("codex");
  // The other two did not follow. Before this, one provider governed all four by construction.
  await expect(dashboard.getByRole("combobox", { name: "Foreman Triage provider" })).toHaveValue("");
  await expect(dashboard.getByRole("combobox", { name: "Foreman Backlog provider" })).toHaveValue("");

  // ...and each row's model catalog followed its OWN provider, which is the point of choosing
  // one: a row on Codex offering Claude ids would be a picker that can only store a bad pair.
  await expect(
    dashboard.getByRole("combobox", { name: "Foreman Review model" })
      .getByRole("option", { name: /GPT-5\.6/ }).first(),
  ).toBeAttached();
  await expect(
    dashboard.getByRole("combobox", { name: "Foreman Triage model" })
      .getByRole("option", { name: /Haiku/ }).first(),
  ).toBeAttached();

  // The daemon agrees about what it would spawn, per role - which is the fact the whole page
  // is a readout of, and the one a panel drawing its own optimistic guess cannot vouch for.
  const status = await (await fetch(`${daemon.baseURL}/api/foreman/status`)).json();
  expect(status.roleRunners.review.id).toBe("codex");
  expect(status.roleRunners.triage.id).toBe("claude");
  expect(status.models.review.id).toBe("gpt-5.6-sol");
  expect(status.models.triage.id).toBe("claude-haiku-4-5");
  await shoot(dashboard, "02-roles-split-across-providers", "models/foreman");
});

test("Foreman's group provider moves the inheriting roles and pins the ones with a model", async ({
  dashboard,
  daemon,
}) => {
  // The bug that existed BEFORE this phase, from the other side. Foreman's panel used to clear
  // all four model boxes on this click, which is a deletion of choices nobody asked to lose.
  // What replaces it is the pin: the outgoing provider is written onto any role carrying a
  // model, so the model keeps working and the roles still inheriting follow the move.
  await openModels(dashboard, daemon.baseURL);

  await dashboard.getByRole("combobox", { name: "Foreman Review model" }).selectOption("claude-opus-5");
  await openModels(dashboard, daemon.baseURL);
  await expect(dashboard.getByRole("combobox", { name: "Foreman Review model" })).toHaveValue(
    "claude-opus-5",
  );

  await dashboard.getByRole("combobox", { name: "Foreman provider" }).selectOption("codex");
  await openModels(dashboard, daemon.baseURL);

  await expect(dashboard.getByRole("combobox", { name: "Foreman provider" })).toHaveValue("codex");
  await expect(
    dashboard.getByRole("combobox", { name: "Foreman Review model" }),
    "Foreman's provider select wiped a pinned model - the behaviour this phase removed",
  ).toHaveValue("claude-opus-5");
  await expect(dashboard.getByRole("combobox", { name: "Foreman Review provider" })).toHaveValue("claude");
  // A role with nothing to preserve was not converted into a pinned one, and follows the move.
  await expect(dashboard.getByRole("combobox", { name: "Foreman Triage provider" })).toHaveValue("");
  await expect(
    dashboard.getByRole("combobox", { name: "Foreman Triage provider" }).getByRole("option").first(),
  ).toHaveText("Inherit - Codex");
  await shoot(dashboard, "03-group-change-pins-outgoing", "models/foreman");
});

test("a Foreman role's own provider change resets only that role's stranded model, and says so", async ({
  dashboard,
  daemon,
}) => {
  await openModels(dashboard, daemon.baseURL);

  await dashboard.getByRole("combobox", { name: "Foreman Review model" }).selectOption("claude-opus-5");
  await dashboard.getByRole("combobox", { name: "Foreman Verify model" }).selectOption("claude-sonnet-5");
  await openModels(dashboard, daemon.baseURL);

  // The row's OWN provider is a statement about that row, so its model has to follow. Codex
  // has no `claude-opus-5`, so the pin goes back to Inherit rather than being handed to a
  // provider that cannot run it - and the row says which id it dropped, in the same paint.
  await dashboard.getByRole("combobox", { name: "Foreman Review provider" }).selectOption("codex");
  await expect(dashboard.getByText(/claude-opus-5 isn't offered by this provider/)).toBeVisible();

  await openModels(dashboard, daemon.baseURL);
  await expect(dashboard.getByRole("combobox", { name: "Foreman Review model" })).toHaveValue("");
  // Resolved through the new provider's DEEP default, not its cheap one: substituting Haiku
  // for an Opus the operator asked for would downgrade the judgement while reporting only
  // that an id was dropped.
  await expect(
    dashboard.getByRole("combobox", { name: "Foreman Review model" }).getByRole("option").first(),
  ).toHaveText(/Default - gpt-5\.6-sol/);
  // The neighbour is untouched. A blanket clear and a targeted reset differ only here.
  await expect(dashboard.getByRole("combobox", { name: "Foreman Verify model" })).toHaveValue(
    "claude-sonnet-5",
  );
  await shoot(dashboard, "04-role-provider-reset-says-so", "models/foreman");
});

test("the Inspector's review row is here, and its Inherit follows the app-wide picker", async ({
  dashboard,
  daemon,
}) => {
  // The regression this phase fixes, from the browser: an unset Inspector provider resolved to
  // a literal `claude`, so it was the one subsystem that ignored the app-wide setting. Now the
  // row's Inherit option names what it will actually get, and the daemon agrees.
  await openModels(dashboard, daemon.baseURL);

  // Named for its group, because Foreman calls one of its four roles "Review" too and this
  // page now carries both - an operator reading either control alone has to know whose it is.
  const provider = dashboard.getByRole("combobox", { name: "Inspector Review provider" });
  await expect(provider).toHaveValue("");

  await dashboard.getByRole("radio", { name: "Codex" }).check();
  await openModels(dashboard, daemon.baseURL);

  const status = await (await fetch(`${daemon.baseURL}/api/inspector/status`)).json();
  expect(
    status.runner.id,
    "an unset Inspector provider ignored the app-wide picker, as it did before this phase",
  ).toBe("codex");
  expect(status.model.id).toBe("gpt-5.6-sol");
  await shoot(dashboard, "05-inspector-inherits-app-wide", "models/inspector");
});

test("moving the app-wide provider updates the groups that inherit it, with no reload", async ({
  dashboard,
  daemon,
}) => {
  // Three blobs, three hooks, one page - and the app-wide radio changes what the other two
  // will spawn with while nothing tells them to look again. Every row below it is a readout
  // of a resolution the daemon performed, so a stale one does not merely lag: it prints the
  // OLD provider's default model id as this row's answer, which is the single thing the page
  // exists to state. Asserted with no reload, because a reload hides exactly this.
  await openModels(dashboard, daemon.baseURL);
  await expect(
    dashboard.getByRole("combobox", { name: "Foreman Review provider" })
      .getByRole("option").first(),
  ).toHaveText("Inherit - Claude Code");

  await dashboard.getByRole("radio", { name: "Codex" }).check();

  for (const name of ROLE_PROVIDERS) {
    await expect(
      dashboard.getByRole("combobox", { name }).getByRole("option").first(),
    ).toHaveText("Inherit - Codex");
  }
  await expect(
    dashboard.getByRole("combobox", { name: "Foreman Review model" }).getByRole("option").first(),
  ).toHaveText(/Default - gpt-5\.6-sol/);
  await expect(
    dashboard.getByRole("combobox", { name: "Inspector Review provider" })
      .getByRole("option").first(),
  ).toHaveText("Inherit - Codex");
  await shoot(dashboard, "06-app-wide-reaches-both-groups", "models/foreman");
});

test("a role's pinned model survives an app-wide provider change, in the browser", async ({
  dashboard,
  daemon,
}) => {
  // The sequence the pinning rule exists for, walked the way an operator reaches it: never
  // touch Foreman's provider or the role's, save a Claude Review model, then move the app-wide
  // radio. Nothing writes Foreman's blob on that last step, so the pin has to have been
  // recorded when the MODEL was saved or the role inherits Codex and the resolver replaces the
  // operator's model with a Codex default - a changed model, and a changed account, with no
  // edit to that role at all.
  await openModels(dashboard, daemon.baseURL);
  await dashboard.getByRole("combobox", { name: "Foreman Review model" })
    .selectOption("claude-opus-5");

  await dashboard.getByRole("radio", { name: "Codex" }).check();
  await openModels(dashboard, daemon.baseURL);

  await expect(dashboard.getByRole("combobox", { name: "Foreman Review model" }))
    .toHaveValue("claude-opus-5");
  await expect(
    dashboard.getByRole("combobox", { name: "Foreman Review provider" }),
    "the provider the model was chosen under was never recorded",
  ).toHaveValue("claude");
  // The roles with nothing pinned did follow the move, which is the other half of the rule.
  await expect(dashboard.getByRole("combobox", { name: "Foreman Triage provider" }))
    .toHaveValue("");
  await expect(
    dashboard.getByRole("combobox", { name: "Foreman Triage provider" }).getByRole("option").first(),
  ).toHaveText("Inherit - Codex");

  // And the daemon spawns what the row says, rather than a substitute it had to pick.
  const status = await (await fetch(`${daemon.baseURL}/api/foreman/status`)).json();
  expect(status.models.review.id).toBe("claude-opus-5");
  expect(status.models.review.unsupported).toBe(null);
  expect(status.roleRunners.review.id).toBe("claude");
  expect(status.roleRunners.triage.id).toBe("codex");
  await shoot(dashboard, "09-pinned-model-survives-app-wide", "models/foreman");
});

test("the Foreman and Inspector panels point here instead of keeping the controls", async ({
  dashboard,
  daemon,
}) => {
  // Two surfaces writing one blob is a lost update waiting for a second tab, and two anchors
  // for one control is a search that sends two operators to two places. The controls are gone
  // from both panels; only a signpost is left, and it navigates.
  await dashboard.goto(`${daemon.baseURL}/#/settings/foreman`);
  await expect(dashboard.getByRole("combobox", { name: "Review" })).toHaveCount(0);
  await expect(dashboard.locator(".sc-controls").getByRole("tab", { name: "Models" }))
    .toHaveCount(0);
  await dashboard.getByRole("button", { name: "Open them in Models →" }).click();
  await expect.poll(async () => dashboard.evaluate(() => location.hash)).toBe("#/settings/models");
  await expect(dashboard.locator('[data-anchor="models/foreman"]')).toHaveClass(/settings-flash/);

  await dashboard.goto(`${daemon.baseURL}/#/settings/inspector`);
  await expect(dashboard.getByRole("combobox", { name: /Review model/ })).toHaveCount(0);
  await dashboard.getByRole("button", { name: "Open it in Models →" }).click();
  await expect.poll(async () => dashboard.evaluate(() => location.hash)).toBe("#/settings/models");
  await expect(dashboard.locator('[data-anchor="models/inspector"]')).toHaveClass(/settings-flash/);
  await shoot(dashboard, "08-pointers-navigate");
});

test("a palette search for a Foreman model lands on the Models page and flashes its group", async ({
  dashboard,
  daemon,
}) => {
  // The anchors moved, so the index entries had to move with them. A hit that scrolls nowhere
  // is worse than no hit: the operator concludes the setting was removed. This is the whole
  // chord-to-category-to-scroll path, which no unit test can walk end to end.
  await dashboard.goto(`${daemon.baseURL}/#/fleet`);
  await dashboard.keyboard.press("Meta+k");
  await dashboard.getByRole("combobox", { name: "Search everything" }).fill("Foreman provider");
  await dashboard.getByRole("option", { name: /Foreman provider and models, setting/ }).click();

  await expect.poll(async () => dashboard.evaluate(() => location.hash)).toBe("#/settings/models");
  const target = dashboard.locator('[data-anchor="models/foreman"]');
  await expect(target).toBeVisible();
  await expect(target).toHaveClass(/settings-flash/);
  await expect(dashboard.getByRole("combobox", { name: "Foreman Review provider" })).toBeVisible();
  await shoot(dashboard, "07-palette-lands-on-models", "models/foreman");

  // The same for the Inspector's entry, whose id is unchanged so a stored keybinding survives.
  await expect(target).not.toHaveClass(/settings-flash/, { timeout: 5_000 });
  await dashboard.keyboard.press("Meta+k");
  await dashboard.getByRole("combobox", { name: "Search everything" }).fill("Inspector review model");
  await dashboard.getByRole("option", { name: /GitHub Inspector review model, setting/ }).click();
  await expect.poll(async () => dashboard.evaluate(() => location.hash)).toBe("#/settings/models");
  await expect(dashboard.locator('[data-anchor="models/inspector"]')).toHaveClass(/settings-flash/);
});
