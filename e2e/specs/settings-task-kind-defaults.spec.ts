import { mkdirSync } from "node:fs";

import type { Locator, Page } from "@playwright/test";

import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { expect, test } from "../fixtures/test.ts";

/**
 * Settings → Models → Task kinds: a dispatched `plan` running on a different harness and
 * model from a `ship`, chosen once here rather than overridden by hand on every dispatch.
 *
 * Three claims, and only a browser can make any of them.
 *
 * FIRST, the grid writes what it appears to write. A row is four controls over a nested
 * record merged twice - per kind, and per field inside a kind - which is exactly the class of
 * bug that renders identically when it is wrong: a replacing write leaves the neighbouring
 * rows looking untouched in the optimistic DOM the panel just painted, and only a reload
 * against the daemon's own state says otherwise. So this reloads.
 *
 * SECOND, the choice REACHES the dispatch form. That is the whole point of the feature -
 * "chosen once, instead of overridden by hand on every dispatch" - and the form is where an
 * operator finds out whether it worked. The Agent select has to move when the Kind changes,
 * and the Model option has to name the row as its source rather than saying a bare "Default"
 * that is now about a different tier.
 *
 * THIRD, a choice made BY HAND is never reverted by a later kind switch. The form already
 * follows that rule for After work, and a control that silently undoes an operator's click a
 * moment after they make it is the failure this guards.
 *
 * NO AGENT IS DISPATCHED. The settings page and the dispatch modal are driven against a real
 * daemon; the modal is opened, read and closed. No binary runs, faked or otherwise, and no
 * model tokens are spent. Every control is reached by role and accessible name; there is no
 * `data-testid` to reach for.
 */

const EVIDENCE = artifactsDir("settings-task-kind-defaults");

async function shoot(page: Page, name: string, target?: Locator): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  // `Tooltip` portals a bubble over whatever is being photographed once anything is hovered.
  await page.mouse.move(0, 0);
  // The grid sits below two other groups on a long page, so a viewport shot of the settings
  // route photographs the background jobs above it and none of the subject. Scrolled and framed
  // on the thing the assertion beside it just proved.
  if (target) await target.scrollIntoViewIfNeeded();
  await (target ?? page).screenshot({ path: `${EVIDENCE}${name}.png`, animations: "disabled" });
  // oxlint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/settings-task-kind-defaults/${name}.png`);
}

/** The Task kinds group, which is what every settings frame here is a frame of. */
function kindsGroup(page: Page): Locator {
  return page.locator('[data-anchor="models/task-kinds"]');
}

/**
 * Land on the Models category and wait for the daemon's answer.
 *
 * Every control in the grid renders disabled until the harnesses config has landed - the
 * panel's way of refusing to present shipped defaults as the daemon's state - so "enabled" is
 * the honest readiness signal here rather than a timeout.
 */
async function openModels(page: Page, baseURL: string): Promise<void> {
  await page.goto(`${baseURL}/#/settings/models`);
  await expect(page.getByRole("combobox", { name: "Agent for plan tasks" })).toBeEnabled();
}

/** The text of a `<select>`'s chosen option - a collapsed select renders none. */
function selectedLabel(select: Locator): Promise<string> {
  return select.evaluate(
    (el) => (el as HTMLSelectElement).selectedOptions[0]?.textContent?.trim() ?? "",
  );
}

/** Open the dispatch modal on a settled form. */
async function openDispatch(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function kindDefaults(daemon: DaemonHandle): Promise<Record<string, {
  agent: string | null;
  model: string | null;
  effort: string | null;
}>> {
  const config = await (await fetch(`${daemon.baseURL}/api/harnesses/config`)).json();
  return config.kindDefaults;
}

test("a kind's row is written per field, and its neighbours are left alone", async ({
  dashboard,
  daemon,
}) => {
  await openModels(dashboard, daemon.baseURL);

  // Everything starts inheriting - an untouched installation dispatches exactly as it did
  // before this key existed.
  await expect(dashboard.getByRole("combobox", { name: "Agent for plan tasks" })).toHaveValue("");
  await expect(dashboard.getByRole("combobox", { name: "Agent for ship tasks" })).toHaveValue("");

  // A row that inherits its agent cannot pin a model, and the control says why rather than
  // sitting greyed out with no reason - which reads as a bug.
  const planModel = dashboard.getByRole("combobox", { name: "Model for plan tasks" });
  await expect(planModel).toBeDisabled();
  // Carried as the control's accessible description, which is where every explanation in this
  // app lives - a native `title` never fires on focus, so a keyboard user would never meet the
  // one sentence that explains why the box is greyed out.
  await expect(planModel).toHaveAccessibleDescription(/a model belongs to one harness/);
  await shoot(dashboard, "01-inheriting-rows", kindsGroup(dashboard));

  // Choose a harness for `plan`, and the Model cell becomes available - narrowed to what that
  // harness actually offers.
  await dashboard.getByRole("combobox", { name: "Agent for plan tasks" }).selectOption("codex");
  await expect(planModel).toBeEnabled();
  await planModel.selectOption("gpt-5.6-sol");
  await dashboard.getByRole("combobox", { name: "Effort for plan tasks" }).selectOption("high");

  // Read it back off a fresh load rather than believing the optimistic paint: the per-field
  // merge is invisible in the DOM the panel drew, and only the daemon's own state can say
  // whether the effort write took the agent beside it with it.
  await openModels(dashboard, daemon.baseURL);
  await expect(dashboard.getByRole("combobox", { name: "Agent for plan tasks" })).toHaveValue("codex");
  await expect(dashboard.getByRole("combobox", { name: "Model for plan tasks" })).toHaveValue("gpt-5.6-sol");
  await expect(dashboard.getByRole("combobox", { name: "Effort for plan tasks" })).toHaveValue("high");

  // The kind nobody touched is untouched. A replacing write differs from a per-kind merge
  // exactly here and nowhere a screenshot could show.
  await expect(dashboard.getByRole("combobox", { name: "Agent for ship tasks" })).toHaveValue("");
  await expect(dashboard.getByRole("combobox", { name: "Model for ship tasks" })).toBeDisabled();
  const stored = await kindDefaults(daemon);
  expect(stored.plan).toEqual({ agent: "codex", model: "gpt-5.6-sol", effort: "high" });
  expect(stored.ship).toEqual({ agent: null, model: null, effort: null });
  await shoot(dashboard, "02-plan-configured", kindsGroup(dashboard));

  // Moving the row's own agent strands its model, so the model follows rather than being left
  // as a pair the daemon would refuse. Claude has no `gpt-5.6-sol`.
  await dashboard.getByRole("combobox", { name: "Agent for plan tasks" }).selectOption("claude");
  await openModels(dashboard, daemon.baseURL);
  await expect(dashboard.getByRole("combobox", { name: "Agent for plan tasks" })).toHaveValue("claude");
  await expect(
    dashboard.getByRole("combobox", { name: "Model for plan tasks" }),
    "an agent change left a model belonging to the harness it just left",
  ).toHaveValue("");
  // The effort survives it: the levels are one shared vocabulary, so "plan with high" is not
  // a statement about a harness the way a model id is.
  await expect(dashboard.getByRole("combobox", { name: "Effort for plan tasks" })).toHaveValue("high");
});

test("the dispatch form follows the kind, and names the row as the source", async ({
  dashboard,
  daemon,
}) => {
  await openModels(dashboard, daemon.baseURL);
  await dashboard.getByRole("combobox", { name: "Agent for plan tasks" }).selectOption("codex");
  await dashboard.getByRole("combobox", { name: "Model for plan tasks" }).selectOption("gpt-5.6-sol");
  await expect
    .poll(async () => (await kindDefaults(daemon)).plan.model)
    .toBe("gpt-5.6-sol");

  await dashboard.getByRole("button", { name: "← Fleet" }).click();
  const dialog = await openDispatch(dashboard);
  const agent = dialog.getByRole("combobox", { name: "Agent", exact: true });
  const kind = dialog.getByRole("combobox", { name: "Kind", exact: true });
  const model = dialog.getByRole("combobox", { name: "Model", exact: true });

  // A fresh form opens on `ship`, which has no row - so nothing has moved.
  await expect(kind).toHaveValue("ship");
  await expect(agent).toHaveValue("claude");

  // Choosing the kind moves the harness under it. This is the feature: an operator asking for
  // a plan does not also have to remember which harness they decided plans run on.
  await kind.selectOption("plan");
  await expect(agent, "choosing plan should move the Agent select to the configured harness")
    .toHaveValue("codex");
  // ...and the Model option names the TIER it came from. A bare "Default" here would be
  // confidently stating the wrong source - the harness default is no longer what applies.
  await expect
    .poll(() => selectedLabel(model), {
      message: "the model option should name the kind row it is reading",
    })
    .toContain("Default for plan");
  await shoot(dashboard, "03-dispatch-follows-kind", dialog);

  // Back to a kind with no row, and the form goes back to the inherited harness.
  await kind.selectOption("ship");
  await expect(agent).toHaveValue("claude");
  await expect.poll(() => selectedLabel(model)).not.toContain("Default for");
});

test("an agent chosen by hand is never reverted by a later kind switch", async ({
  dashboard,
  daemon,
}) => {
  await openModels(dashboard, daemon.baseURL);
  await dashboard.getByRole("combobox", { name: "Agent for plan tasks" }).selectOption("codex");
  await expect.poll(async () => (await kindDefaults(daemon)).plan.agent).toBe("codex");

  await dashboard.getByRole("button", { name: "← Fleet" }).click();
  const dialog = await openDispatch(dashboard);
  const agent = dialog.getByRole("combobox", { name: "Agent", exact: true });
  const kind = dialog.getByRole("combobox", { name: "Kind", exact: true });

  // The operator says pi, explicitly, and then changes their mind about the kind. The form
  // must not quietly put the kind's harness back over a choice made a moment earlier - the
  // rule After work already follows with its stash.
  await agent.selectOption("pi");
  await kind.selectOption("plan");
  await expect(agent, "a kind switch reverted an agent the operator had picked by hand")
    .toHaveValue("pi");
  await shoot(dashboard, "04-hand-picked-agent-survives", dialog);
});
