import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * The console detail's identity band, after it stopped repeating itself.
 *
 * Three claims, and none of them is checkable anywhere else in this repository. The
 * `renderToStaticMarkup` tests beside this one pin which element carries which class from a
 * session object handed to them; they cannot see a chip a person can reach, a popover that
 * opens, or which of two chips is drawn to the left of the other. Reading order is a laid-out
 * fact, and this is the only layer that lays anything out.
 *
 * - The permission mode leads `mode · model · context · cost` in the header, and the footer
 *   has given it up rather than keeping a second copy.
 * - The task pill draws a kind badge only for a `scout`, and drops the title the session's
 *   own name already carries.
 * - The objective reads under that name instead of in a band of its own above the transcript.
 *
 * Every dispatch here names its task explicitly. That is not decoration: with the Title
 * field blank the daemon asks the model for one, and the fake answers `E2E Mock Session` for
 * every prompt - so two dispatches in one fleet would be two identically named cards, and
 * "the ship card" would be whichever one the locator happened to reach first.
 */

/** The task the fleet is dispatched with; the Title field is what the card is named by. */
const SHIP = { title: "Ship the header band", intent: "tighten the console detail header" };
const SCOUT = { title: "Scout the header band", intent: "survey where the detail spends height" };

/** The daemon's loopback token, which the hook ingest route requires. */
function token(daemon: DaemonHandle): string {
  return readFileSync(join(daemon.home, "token"), "utf8").trim();
}

async function put(daemon: DaemonHandle, path: string, body: unknown): Promise<void> {
  const res = await fetch(`${daemon.baseURL}${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.ok, `PUT ${path} answered ${res.status}`).toBe(true);
}

interface FleetSession {
  id: string;
  name: string;
  agent: string;
  agentSessionId: string | null;
  cwd: string;
  runtime: string;
}

/** The dispatched SDK sessions this daemon has, once `count` of them have been adopted. */
async function sessions(daemon: DaemonHandle, count: number): Promise<FleetSession[]> {
  let found: FleetSession[] = [];
  await expect
    .poll(
      async () => {
        const all = (await (await fetch(`${daemon.baseURL}/api/sessions`)).json()) as FleetSession[];
        found = all.filter((s) => s.runtime === "sdk");
        return found.length;
      },
      { message: `${count} dispatched session(s) should reach the registry`, timeout: 30_000 },
    )
    .toBe(count);
  return found;
}

/**
 * Dispatch one agent from the real modal.
 *
 * `Escape` after the repo field is load-bearing rather than defensive: `RepoCombobox`
 * portals its listbox over the fields below it and opens on every keystroke, so without
 * dismissing it the next `fill` lands on a covered control. Its own Escape handler stops
 * propagation, so this closes the list and not the modal.
 */
async function dispatch(
  page: Page,
  daemon: DaemonHandle,
  task: { title: string; intent: string },
  kind: "ship" | "scout",
): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();

  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(task.intent);
  // Title lives inside the Backlog details fold, which a fresh dispatch opens closed. The
  // summary line is part of the control's accessible name, so this cannot be `exact`.
  await dialog.getByRole("button", { name: /Backlog details/ }).click();
  await dialog.getByPlaceholder("summarized from the task if left blank").fill(task.title);
  await dialog.getByRole("combobox", { name: "Kind", exact: true }).selectOption(kind);
  // Pinned rather than left at the daemon's configured default, which would be refused
  // here: this repo is not allowlisted for Workflows Live delivery, and the modal would
  // stay open with the refusal in it.
  await dialog
    .locator("select")
    .filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");

  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
}

/** Switch to the console and select `name` in the rail, returning the detail pane. */
async function openDetail(page: Page, daemon: DaemonHandle, name: string): Promise<Locator> {
  await put(daemon, "/api/ui/config", { layout: "console" });
  await page.reload();

  const rail = page.getByRole("navigation", { name: "Sessions" });
  await expect(rail).toBeVisible();
  await rail.getByRole("button", { name }).first().click();

  const detail = page.locator(".cdetail");
  await expect(detail.getByRole("heading", { name })).toBeVisible();
  return detail;
}

test("the permission mode leads the header cluster and the footer has given it up", async ({
  dashboard,
  daemon,
}) => {
  await dispatch(dashboard, daemon, SHIP, "ship");
  await sessions(daemon, 1);
  const detail = await openDetail(dashboard, daemon, SHIP.title);

  const head = detail.locator("header.detail-head");
  const foot = detail.locator("footer.detail-foot");

  // A dispatched Claude session is armed in `auto` (`permissionModes.onDispatch`), so the
  // chip's accessible name is the posture itself - which is the whole reason it earns a
  // place beside the facts that follow from it.
  const mode = head.getByRole("button", { name: "auto" });
  await expect(mode).toBeVisible();

  // Reachable, not merely present: it is the live picker that moved up here, not a static
  // copy of its label. The popover names itself, so this is a role-and-name assertion.
  await mode.click();
  await expect(dashboard.getByRole("menu", { name: "Permission mode" })).toBeVisible();
  await dashboard.keyboard.press("Escape");
  await expect(dashboard.getByRole("menu", { name: "Permission mode" })).toBeHidden();

  // Present first, then absent. The chip is rendered on this very page - the assertion above
  // just clicked it - so a count of zero in the footer is the move, not a selector that
  // never matched anything.
  await expect(head.locator(".mode")).toHaveCount(1);
  await expect(foot.locator(".mode")).toHaveCount(0);

  // The order the plan is about, measured rather than asserted about markup: the posture is
  // drawn to the LEFT of the model it governs. Nothing else in this repository can say this.
  const model = head.locator(".rt-model");
  await expect(model).toBeVisible();
  const modeBox = await mode.boundingBox();
  const modelBox = await model.boundingBox();
  expect(modeBox, "the mode chip should be laid out").not.toBeNull();
  expect(modelBox, "the model pill should be laid out").not.toBeNull();
  expect(modeBox!.x, "the mode chip should lead the runtime cluster").toBeLessThan(modelBox!.x);
});

test("the kind badge is a scout's alone, and the pill stops repeating the session's name", async ({
  dashboard,
  daemon,
}) => {
  // Both kinds in one fleet, so present and absent are one comparison in one browser state
  // rather than two runs a reader has to hold side by side.
  await dispatch(dashboard, daemon, SHIP, "ship");
  await dispatch(dashboard, daemon, SCOUT, "scout");
  await sessions(daemon, 2);

  const cards = dashboard.locator("article.card");
  await expect(cards).toHaveCount(2);
  const shipCard = cards.filter({ has: dashboard.getByRole("heading", { name: SHIP.title }) });
  const scoutCard = cards.filter({ has: dashboard.getByRole("heading", { name: SCOUT.title }) });

  for (const [layout, ship, scout] of [["card", shipCard, scoutCard]] as const) {
    await expect(scout.locator(".task-chip .task-kind"), `${layout}: a scout says so`)
      .toHaveText("scout");
    await expect(ship.locator(".task-chip"), `${layout}: the ship pill is still drawn`)
      .toBeVisible();
    await expect(ship.locator(".task-chip .task-kind"), `${layout}: and says nothing`)
      .toHaveCount(0);
    // The title the header already carries is not repeated inside the pill.
    await expect(ship.locator(".task-chip"), `${layout}: no duplicate title`)
      .not.toContainText(SHIP.title);
    await expect(scout.locator(".task-chip"), `${layout}: no duplicate title`)
      .not.toContainText(SCOUT.title);
  }

  // The same two facts on the other layout that draws this pill. A rule applied to the card
  // alone would look right here and be wrong one click away.
  const scoutDetail = await openDetail(dashboard, daemon, SCOUT.title);
  await expect(scoutDetail.locator(".task-chip .task-kind")).toHaveText("scout");

  await dashboard.getByRole("navigation", { name: "Sessions" })
    .getByRole("button", { name: SHIP.title })
    .first()
    .click();
  const shipDetail = dashboard.locator(".cdetail");
  await expect(shipDetail.getByRole("heading", { name: SHIP.title })).toBeVisible();
  await expect(shipDetail.locator(".task-chip")).toBeVisible();
  await expect(shipDetail.locator(".task-chip .task-kind")).toHaveCount(0);
  await expect(shipDetail.locator(".task-chip")).not.toContainText(SHIP.title);
});

test("the objective reads under the session's name instead of above the transcript", async ({
  dashboard,
  daemon,
}) => {
  await dispatch(dashboard, daemon, SHIP, "ship");
  const [session] = await sessions(daemon, 1);
  const detail = await openDetail(dashboard, daemon, SHIP.title);

  // The fake SDK speaks the agent protocol but does not run the machine-installed Claude
  // hooks, so the prompt event a real turn sends is supplied here. It is a real hook join on
  // the agent's own conversation id, not a fixture write behind the registry's back - which
  // is what makes the objective on screen the daemon's, established the way it always is.
  const objective = "Give the conversation back the height the header was spending";
  const hook = await fetch(`${daemon.baseURL}/hooks/UserPromptSubmit`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": token(daemon) },
    body: JSON.stringify({
      agent: session.agent,
      sessionId: session.agentSessionId,
      cwd: session.cwd,
      env: {},
      prompt: objective,
    }),
  });
  expect(hook.status, await hook.clone().text()).toBe(204);

  // Under the name, in the identity block - the durable fact reading with the other durable
  // facts. `.detail-title` is the block; the heading and the objective are both inside it.
  const identity = detail.locator(".detail-title");
  await expect(identity.getByRole("heading", { name: SHIP.title })).toBeVisible();
  await expect(identity.locator(".goal")).toHaveText(objective);

  // And no longer in a band of its own above the transcript. The same selector matched one
  // element in the assertion above, so zero here is the relocation rather than a typo.
  await expect(detail.locator(".detail-conv > .goal")).toHaveCount(0);

  // The band above the transcript kept its other leading children, and `.transcript` is
  // still a DIRECT child of `.detail-conv` - shipped CSS and `pane-dialog-scroll.test.ts`
  // both select through that combinator, so no wrapper may appear where the objective was.
  await expect(detail.locator(".detail-conv > .transcript")).toHaveCount(1);
});
