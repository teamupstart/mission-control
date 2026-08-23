import { mkdirSync } from "node:fs";

import type { Page } from "@playwright/test";

import { artifactsDir } from "../fixtures/artifacts.ts";
import { expect, test } from "../fixtures/test.ts";

/**
 * Settings → Models: a provider per background job, and the end of the blanket clear.
 *
 * Two claims, and only a browser can make either of them.
 *
 * FIRST, the five jobs each have a provider of their own. The markup layer can see five
 * selects; what it cannot see is whether picking Codex in one row travels through
 * `PUT /api/llm/config`, is merged per key by `setLlmConfig`, and comes back on the next
 * status read as a change to THAT row and nothing else. Per-key merging is exactly the kind
 * of thing that renders identically when it is wrong - a replacing write leaves the four
 * neighbours looking untouched in the DOM the panel optimistically drew, and only a reload
 * against the daemon's own state says otherwise. So this reloads.
 *
 * SECOND, changing the app-wide radio no longer wipes the model boxes. That was one line in
 * a click handler; its removal is not visible in any component's markup, because the
 * behaviour being asserted is the ABSENCE of a write. The only way to see it is to pin a
 * model, move the radio, and read the box back off a fresh load.
 *
 * NO AGENT IS DISPATCHED. This is the settings page against a daemon - no binary runs and no
 * model tokens are spent. Every control is reached by role and accessible name; there is no
 * `data-testid` in the panel to reach for.
 */

const EVIDENCE = artifactsDir("settings-background-job-providers");

async function shoot(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  // `Tooltip` portals a bubble over whatever is being photographed once anything is hovered.
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${EVIDENCE}${name}.png`, animations: "disabled" });
  // oxlint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/settings-background-job-providers/${name}.png`);
}

/** Every job's provider select, by the accessible name its row gives it. */
const PROVIDERS = [
  "Task title provider",
  "Goal provider",
  "Away digest provider",
  "Workflow context provider",
  "Ensemble evaluation provider",
] as const;

/**
 * Land on the panel and wait for the daemon's answer.
 *
 * Every control renders disabled until `useLlm` has both the config and the status - the
 * panel's way of refusing to present shipped defaults as the daemon's state - so "enabled" is
 * the honest readiness signal here, not a timeout.
 */
async function openModels(page: Page, baseURL: string): Promise<void> {
  await page.goto(`${baseURL}/#/settings/models`);
  await expect(page.getByRole("combobox", { name: "Goal provider" })).toBeEnabled();
}

test("each background job picks its own provider, and the app-wide radio clears nothing", async ({
  dashboard,
  daemon,
}) => {
  await openModels(dashboard, daemon.baseURL);

  // Every job starts inheriting, and says WHAT it inherits rather than only that it does.
  for (const name of PROVIDERS) {
    await expect(dashboard.getByRole("combobox", { name })).toHaveValue("");
  }
  await expect(
    dashboard.getByRole("combobox", { name: "Goal provider" }).getByRole("option").first(),
  ).toHaveText("Inherit - Claude Code");
  await shoot(dashboard, "01-all-inherited");

  // One job leaves the app-wide answer behind. The write goes to the daemon, so read it back
  // off a fresh load rather than believing the panel's optimistic paint.
  await dashboard.getByRole("combobox", { name: "Goal provider" }).selectOption("codex");
  await openModels(dashboard, daemon.baseURL);
  await expect(dashboard.getByRole("combobox", { name: "Goal provider" })).toHaveValue("codex");

  // The other four did not move. This is the per-key merge, asserted from the browser: a
  // replacing write would have cleared nothing visible in the optimistic DOM and everything
  // here.
  for (const name of PROVIDERS.filter((p) => p !== "Goal provider")) {
    await expect(dashboard.getByRole("combobox", { name })).toHaveValue("");
  }

  // ...and the Goal row's model catalog followed its provider, which is the point of choosing
  // one: a row on Codex offering Claude ids would be a picker that can only store a bad pair.
  const goalModel = dashboard.getByRole("combobox", { name: "Goal model" });
  await expect(goalModel.getByRole("option", { name: /GPT-5\.6/ }).first()).toBeAttached();
  await expect(dashboard.getByRole("combobox", { name: "Task title model" })
    .getByRole("option", { name: /Haiku/ }).first()).toBeAttached();
  await shoot(dashboard, "02-goal-on-codex");

  // A model pinned on a row that is following the app-wide provider.
  await dashboard
    .getByRole("combobox", { name: "Away digest model" })
    .selectOption("claude-sonnet-5");
  await openModels(dashboard, daemon.baseURL);
  await expect(dashboard.getByRole("combobox", { name: "Away digest model" })).toHaveValue(
    "claude-sonnet-5",
  );

  // Move the app-wide radio. Before this change every model box was wiped on this click.
  await dashboard.getByRole("radio", { name: "Codex" }).check();
  await openModels(dashboard, daemon.baseURL);
  await expect(dashboard.getByRole("radio", { name: "Codex" })).toBeChecked();
  await expect(
    dashboard.getByRole("combobox", { name: "Away digest model" }),
    "the app-wide radio wiped a pinned model - the behaviour this phase removed",
  ).toHaveValue("claude-sonnet-5");
  // Pinning a model pinned its provider, so the pinned row keeps running on Claude while the
  // rows still on Inherit follow the radio to Codex.
  await expect(dashboard.getByRole("combobox", { name: "Away digest provider" })).toHaveValue(
    "claude",
  );
  await expect(dashboard.getByRole("combobox", { name: "Task title provider" })).toHaveValue("");
  await expect(
    dashboard.getByRole("combobox", { name: "Task title model" }).getByRole("option").first(),
  ).toHaveText(/Default - gpt-5\.6-luna/);
  await shoot(dashboard, "03-pinned-model-survives-app-wide-change");
});

test("a row's own provider change resets only that row's stranded model, and says so", async ({
  dashboard,
  daemon,
}) => {
  await openModels(dashboard, daemon.baseURL);

  // Two rows pinned to Claude models, so the second can prove the reset is not a wipe.
  await dashboard.getByRole("combobox", { name: "Goal model" }).selectOption("claude-sonnet-5");
  await dashboard
    .getByRole("combobox", { name: "Task title model" })
    .selectOption("claude-opus-5");
  await openModels(dashboard, daemon.baseURL);
  await expect(dashboard.getByRole("combobox", { name: "Goal model" })).toHaveValue(
    "claude-sonnet-5",
  );

  // The row's OWN provider is a statement about that row, so its model has to follow. Codex
  // has no `claude-sonnet-5`, so the pin goes back to Inherit rather than being handed to a
  // provider that cannot run it - and the row says which id it dropped, in the same paint.
  await dashboard.getByRole("combobox", { name: "Goal provider" }).selectOption("codex");
  await expect(dashboard.getByText(/claude-sonnet-5 isn't offered by this provider/)).toBeVisible();
  await shoot(dashboard, "04-row-provider-reset-says-so");

  await openModels(dashboard, daemon.baseURL);
  await expect(dashboard.getByRole("combobox", { name: "Goal provider" })).toHaveValue("codex");
  await expect(dashboard.getByRole("combobox", { name: "Goal model" })).toHaveValue("");
  // Resolved through the new provider's own cheap default rather than left holding a Claude id.
  await expect(
    dashboard.getByRole("combobox", { name: "Goal model" }).getByRole("option").first(),
  ).toHaveText(/Default - gpt-5\.6-luna/);

  // The neighbour is untouched. A blanket clear and a targeted reset differ only here.
  await expect(dashboard.getByRole("combobox", { name: "Task title model" })).toHaveValue(
    "claude-opus-5",
  );
});

test("choosing Inherit judges the model against the app-wide provider, not the one abandoned", async ({
  dashboard,
  daemon,
}) => {
  // The asymmetric case, and the one the two tests above cannot reach: going back to Inherit
  // is also a change of this row's provider, and the provider it changes TO is the app-wide
  // one - not the override being dropped. Judging the pinned model against the override meant
  // the row kept a Codex model while storing `runners[job] = ""`, so the pair persisted
  // mismatched and only the resolution guard downstream kept it off a runner. A panel that
  // writes a pair it already knows is wrong is not made right by something else catching it.
  await openModels(dashboard, daemon.baseURL);

  // App-wide stays Claude throughout. One row goes to Codex and pins a Codex model.
  await expect(dashboard.getByRole("radio", { name: "Claude Code" })).toBeChecked();
  await dashboard.getByRole("combobox", { name: "Goal provider" }).selectOption("codex");
  await dashboard.getByRole("combobox", { name: "Goal model" }).selectOption("gpt-5.6-sol");
  await openModels(dashboard, daemon.baseURL);
  await expect(dashboard.getByRole("combobox", { name: "Goal model" })).toHaveValue("gpt-5.6-sol");

  // The option has to say where Inherit actually goes. Labelled from the row's own override it
  // read "Inherit - Codex", which is the single thing selecting it will not do.
  await expect(
    dashboard.getByRole("combobox", { name: "Goal provider" }).getByRole("option").first(),
  ).toHaveText("Inherit - Claude Code");

  await dashboard.getByRole("combobox", { name: "Goal provider" }).selectOption("");
  await expect(dashboard.getByText(/gpt-5\.6-sol isn't offered by this provider/)).toBeVisible();

  await openModels(dashboard, daemon.baseURL);
  await expect(dashboard.getByRole("combobox", { name: "Goal provider" })).toHaveValue("");
  await expect(
    dashboard.getByRole("combobox", { name: "Goal model" }),
    "an Inherit row kept a model belonging to the provider it just left",
  ).toHaveValue("");
  await expect(
    dashboard.getByRole("combobox", { name: "Goal model" }).getByRole("option").first(),
  ).toHaveText(/Default - claude-haiku-4-5/);
  await shoot(dashboard, "05-inherit-judged-against-app-wide");
});
