import { mkdirSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * Changing a built-in workflow's maximum repair rounds in place, without Duplicate.
 *
 * `test/builtin-workflow-round-limit.test.ts` pins the store and the route, and
 * `test/builtin-workflows-web.test.ts` pins that the rail renders exactly one live field. Only
 * a browser can see the number an operator types reach `PUT /api/workflows/:id/round-limit`,
 * come back on reload, show in both editing views, and leave every other control disabled.
 *
 * No model tokens: nothing here binds or runs the workflow.
 */

const EVIDENCE = artifactsDir("builtin-workflow-round-limit");
const BUILTIN = "No-Mistakes Review (High Rigor)";
// Anchor the built-in badge so a copy could never match.
const BUILTIN_BUTTON = /^No-Mistakes Review \(High Rigor\)\s*built-in\b/i;

async function shoot(target: Page | Locator, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await target.screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/builtin-workflow-round-limit/${name}.png`);
}

interface Defaults { triggerMode: string; deliveryMode: string; maxRepairRounds: number }
interface Detail {
  workflow: {
    id: string;
    name: string;
    description: string;
    draft: unknown;
    completionPolicy: unknown;
    evidenceReadinessPolicy: string;
    bindingDefaults: Defaults;
    shippedMaxRepairRounds?: number;
  };
  versions: Array<{ version: number; bindingDefaults: Defaults; completionPolicy: unknown }>;
}

async function builtinDetail(daemon: DaemonHandle): Promise<Detail> {
  const summaries = await (await fetch(`${daemon.baseURL}/api/workflows`)).json() as Array<{ id: string; name: string }>;
  const id = summaries.find((summary) => summary.name === BUILTIN)!.id;
  return await (await fetch(`${daemon.baseURL}/api/workflows/${encodeURIComponent(id)}`)).json() as Detail;
}

/** Everything the operator must NOT be able to change, as the daemon reports it. */
function lockedFields(detail: Detail) {
  const { maxRepairRounds: _rounds, ...otherDefaults } = detail.workflow.bindingDefaults;
  return {
    name: detail.workflow.name,
    description: detail.workflow.description,
    draft: detail.workflow.draft,
    completionPolicy: detail.workflow.completionPolicy,
    evidenceReadinessPolicy: detail.workflow.evidenceReadinessPolicy,
    otherDefaults,
    versions: detail.versions.map(({ version, completionPolicy, bindingDefaults }) => ({
      version,
      completionPolicy,
      triggerMode: bindingDefaults.triggerMode,
      deliveryMode: bindingDefaults.deliveryMode,
    })),
  };
}

test("a built-in workflow's repair rounds can be changed and saved, and nothing else can", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.setViewportSize({ width: 1440, height: 900 });
  const before = await builtinDetail(daemon);
  const shipped = before.workflow.bindingDefaults.maxRepairRounds;
  expect(before.workflow.shippedMaxRepairRounds).toBeUndefined();

  await dashboard.goto(`${daemon.baseURL}/#/workflows`);
  await dashboard.getByRole("button", { name: BUILTIN_BUTTON }).click();
  await expect(dashboard.getByRole("textbox", { name: "Name", exact: true })).toHaveValue(BUILTIN);
  await expect(dashboard.locator(".wf-state.builtin"))
    .toContainText("Only its maximum repair rounds can be changed here");

  const rail = dashboard.getByRole("complementary", { name: "Workflow settings and validation" });
  const rounds = rail.getByRole("spinbutton", { name: "Maximum repair rounds" });
  const save = rail.getByRole("button", { name: "Save rounds" });

  // Every other workflow setting stays read-only beside the one live field.
  await expect(rail.getByRole("textbox", { name: "Name", exact: true })).toBeDisabled();
  await expect(rail.getByRole("textbox", { name: "Description" })).toBeDisabled();
  for (const label of ["Default trigger", "Default delivery", "Evidence preflight", "Final gate"]) {
    await expect(rail.getByRole("combobox", { name: label })).toBeDisabled();
  }
  await expect(rounds).toBeEnabled();
  await expect(rounds).toHaveValue(String(shipped));
  await expect(rail).toContainText("The value this build ships.");
  await expect(save).toBeDisabled();
  await expect(rail.getByRole("button", { name: /^Reset to/ })).toHaveCount(0);

  // Out of range is refused on screen before anything is sent.
  await rounds.fill("0");
  await expect(rail.getByRole("alert")).toHaveText("Enter a whole number from 1 through 20.");
  await expect(save).toBeDisabled();

  const target = shipped + 3;
  await rounds.fill(String(target));
  await expect(save).toBeEnabled();
  const put = dashboard.waitForResponse((response) =>
    response.url().endsWith("/round-limit") && response.request().method() === "PUT");
  await save.click();
  expect((await put).status()).toBe(200);
  await expect(rail).toContainText(`Changed from the ${shipped} this build ships.`);
  await expect(rail.getByRole("button", { name: `Reset to ${shipped}` })).toBeVisible();
  await expect(save).toBeDisabled();
  await dashboard.mouse.move(0, 0);
  await shoot(rail, "saved-rounds");

  // The daemon stored the rounds on the definition and every version, and nothing else moved.
  const after = await builtinDetail(daemon);
  expect(after.workflow.bindingDefaults.maxRepairRounds).toBe(target);
  expect(after.workflow.shippedMaxRepairRounds).toBe(shipped);
  expect(after.versions.map((version) => version.bindingDefaults.maxRepairRounds))
    .toEqual(after.versions.map(() => target));
  expect(lockedFields(after)).toEqual(lockedFields(before));

  // The current version reports the same budget a new binding of it will start from.
  const newest = Math.max(...after.versions.map((version) => version.version));
  const history = dashboard.locator(".workflow-version-history");
  await history.getByRole("button", { name: new RegExp(`^Version ${newest}\\b`) }).click();
  await expect(history.locator("dl > div").filter({ hasText: "Maximum repair rounds" }))
    .toContainText(String(target));

  // A reload shows what the daemon stored, in both editing views.
  await dashboard.reload();
  await dashboard.getByRole("button", { name: BUILTIN_BUTTON }).click();
  await expect(rounds).toHaveValue(String(target));
  await dashboard.getByRole("button", { name: "Graph", exact: true }).click();
  const graphRail = dashboard.getByRole("complementary", { name: "Workflow properties and validation" });
  const graphRounds = graphRail.getByRole("spinbutton", { name: "Maximum repair rounds" });
  await expect(graphRounds).toHaveValue(String(target));
  await expect(graphRounds).toBeEnabled();
  await expect(graphRail.getByRole("textbox", { name: "Name", exact: true })).toBeDisabled();
  await shoot(graphRail, "graph-view-rounds");

  // Reset returns to the shipped value and stores no override.
  await graphRail.getByRole("button", { name: `Reset to ${shipped}` }).click();
  await expect(graphRounds).toHaveValue(String(shipped));
  await expect(graphRail.getByRole("button", { name: /^Reset to/ })).toHaveCount(0);
  await expect(graphRail).toContainText("The value this build ships.");
  const reset = await builtinDetail(daemon);
  expect(reset.workflow.bindingDefaults.maxRepairRounds).toBe(shipped);
  expect(reset.workflow.shippedMaxRepairRounds).toBeUndefined();
});

test("another built-in saves both accepted endpoints, 20 and 1, and reads each back", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.setViewportSize({ width: 1440, height: 900 });
  const name = "General Review";
  const button = /^General Review\s*built-in\b/i;
  const summaries = await (await fetch(`${daemon.baseURL}/api/workflows`)).json() as Array<{ id: string; name: string }>;
  const id = summaries.find((summary) => summary.name === name)!.id;
  const read = async () => (await (await fetch(`${daemon.baseURL}/api/workflows/${encodeURIComponent(id)}`)).json() as Detail);
  const shipped = (await read()).workflow.bindingDefaults.maxRepairRounds;

  await dashboard.goto(`${daemon.baseURL}/#/workflows`);
  await dashboard.getByRole("button", { name: button }).click();
  await expect(dashboard.getByRole("textbox", { name: "Name", exact: true })).toHaveValue(name);
  const rail = dashboard.getByRole("complementary", { name: "Workflow settings and validation" });
  const rounds = rail.getByRole("spinbutton", { name: "Maximum repair rounds" });

  for (const value of [20, 1]) {
    await rounds.fill(String(value));
    await expect(rail.getByRole("alert")).toHaveCount(0);
    const put = dashboard.waitForResponse((response) =>
      response.url().endsWith("/round-limit") && response.request().method() === "PUT");
    await rail.getByRole("button", { name: "Save rounds" }).click();
    expect((await put).status()).toBe(200);
    await expect(rail).toContainText(`Changed from the ${shipped} this build ships.`);
    const stored = await read();
    expect(stored.workflow.bindingDefaults.maxRepairRounds).toBe(value);
    expect(stored.versions.every((version) => version.bindingDefaults.maxRepairRounds === value)).toBe(true);

    await dashboard.reload();
    await dashboard.getByRole("button", { name: button }).click();
    await expect(rounds).toHaveValue(String(value));
  }
  await dashboard.mouse.move(0, 0);
  await shoot(rail, "general-review-min-rounds");

  // The other built-in was not touched by this one's saves.
  const noMistakes = await builtinDetail(daemon);
  expect(noMistakes.workflow.shippedMaxRepairRounds).toBeUndefined();
});

test("a save in flight blocks a second save or reset, even after switching views", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.setViewportSize({ width: 1440, height: 900 });
  const shipped = (await builtinDetail(daemon)).workflow.bindingDefaults.maxRepairRounds;
  // Seed an override so Reset is offered, then reopen on that state.
  const seeded = await fetch(
    `${daemon.baseURL}/api/workflows/${encodeURIComponent((await builtinDetail(daemon)).workflow.id)}/round-limit`,
    { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ maxRepairRounds: shipped + 2 }) },
  );
  expect(seeded.status).toBe(200);

  // Hold the next round-limit PUT open so the request is still in flight across a view switch.
  let puts = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await dashboard.route("**/round-limit", async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    puts += 1;
    await held;
    await route.continue();
  });

  await dashboard.goto(`${daemon.baseURL}/#/workflows`);
  await dashboard.getByRole("button", { name: BUILTIN_BUTTON }).click();
  const pipelineRail = dashboard.getByRole("complementary", { name: "Workflow settings and validation" });
  await expect(pipelineRail.getByRole("spinbutton", { name: "Maximum repair rounds" })).toHaveValue(String(shipped + 2));
  await pipelineRail.getByRole("spinbutton", { name: "Maximum repair rounds" }).fill(String(shipped + 7));
  await pipelineRail.getByRole("button", { name: "Save rounds" }).click();
  await expect(pipelineRail.getByRole("button", { name: "Saving…" })).toBeDisabled();

  // The Graph rail is a fresh field, and it still knows a request is in flight.
  await dashboard.getByRole("button", { name: "Graph", exact: true }).click();
  const graphRail = dashboard.getByRole("complementary", { name: "Workflow properties and validation" });
  await expect(graphRail.getByRole("button", { name: `Reset to ${shipped}` })).toBeDisabled();
  await expect(graphRail.getByRole("spinbutton", { name: "Maximum repair rounds" })).toBeDisabled();
  await graphRail.getByRole("button", { name: `Reset to ${shipped}` }).click({ force: true });

  release();
  await expect(graphRail.getByRole("spinbutton", { name: "Maximum repair rounds" })).toHaveValue(String(shipped + 7));
  await expect(graphRail.getByRole("button", { name: `Reset to ${shipped}` })).toBeEnabled();
  expect(puts, "exactly one request was sent while the first was in flight").toBe(1);
  expect((await builtinDetail(daemon)).workflow.bindingDefaults.maxRepairRounds).toBe(shipped + 7);
});
