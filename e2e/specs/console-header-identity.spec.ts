import { mkdirSync } from "node:fs";
import { join } from "node:path";

import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
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
 * - The task pill draws a kind badge only for a `scout`, drops the title the session's own
 *   name already carries, and is not drawn at all once it has neither.
 * - The objective reads under that name instead of in a band of its own above the transcript,
 *   clipped to one line so a full-length one cannot cost the header a second row.
 *
 * Every dispatch here names its task explicitly. That is not decoration: with the Title
 * field blank the daemon asks the model for one, and the fake answers `E2E Mock Session` for
 * every prompt - so two dispatches in one fleet would be two identically named cards, and
 * "the ship card" would be whichever one the locator happened to reach first.
 */

/** The task the fleet is dispatched with; the Title field is what the card is named by. */
const SHIP = { title: "Ship the header band", intent: "tighten the console detail header" };
const SCOUT = { title: "Scout the header band", intent: "survey where the detail spends height" };

const EVIDENCE = artifactsDir("console-header-identity");

/** One reviewer-facing frame, only when capture is asked for. */
async function shot(locator: Locator, name: string, observed: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await locator.screenshot({ path: join(EVIDENCE, `${name}.png`) });
  // eslint-disable-next-line no-console
  console.log(`OBSERVED ${observed}`);
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/console-header-identity/${name}.png`);
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

/**
 * The dispatched SDK sessions this daemon has, once `count` of them have bound a
 * conversation.
 *
 * Waiting for `agentSessionId` is not belt-and-braces. A goal row is keyed by that id, and
 * the accepted launch prompt is deliberately held until the binding lands. Reaching this
 * boundary means the objective can no longer be written under the synthetic session id and
 * silently disappear when the native key replaces it.
 */
async function sessions(daemon: DaemonHandle, count: number): Promise<FleetSession[]> {
  let found: FleetSession[] = [];
  await expect
    .poll(
      async () => {
        const all = (await (await fetch(`${daemon.baseURL}/api/sessions`)).json()) as FleetSession[];
        found = all.filter((s) => s.runtime === "sdk" && s.agentSessionId !== null);
        return found.length;
      },
      { message: `${count} dispatched session(s) should bind a conversation`, timeout: 30_000 },
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
  extraRepos: string[] = [],
): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();

  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  // Each attached repo needs its own Escape for the same reason the primary does.
  for (const repo of extraRepos) {
    await dialog.getByRole("button", { name: "Add another repo" }).click();
    await dialog.getByPlaceholder("repo to attach…").fill(repo);
    await page.keyboard.press("Escape");
    await dialog.getByRole("button", { name: "Attach repo" }).click();
  }
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

  // A scroll is not a dismissal. The conversation this chip sits above auto-scrolls whenever
  // the agent streams a line, so a picker that closed on scroll closed itself on exactly the
  // sessions an operator opens it on. It follows the chip instead.
  await dashboard.mouse.wheel(0, 120);
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

  await shot(head, "header-cluster", "the console header reads mode -> model -> cost");
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

  const rows = dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row");
  await expect(rows).toHaveCount(2);

  // The scout's detail pill has something to say, so it is drawn and says it. It does NOT
  // repeat the session's name, which is the heading directly above it.
  const scoutDetail = await openDetail(dashboard, daemon, SCOUT.title);
  await expect(scoutDetail.locator(".task-chip .task-kind")).toHaveText("scout");
  await expect(scoutDetail.locator(".task-chip")).not.toContainText(SCOUT.title);
  await shot(
    dashboard.locator("main.console"),
    "scout-kind-in-console",
    "the scout detail badges its kind without repeating its name",
  );

  // The ship session's pill has nothing left: `ship` is what every task is, and its title
  // is already the heading. So there is no bar at all rather than an empty one.
  const shipDetail = await openDetail(dashboard, daemon, SHIP.title);
  await expect(shipDetail.locator(".task-chip")).toHaveCount(0);

});

test("a silent pill does not take a multi-repo task's pull-request row with it", async ({
  dashboard,
  daemon,
}) => {
  // The pill's parts and the per-repo list are different rows, and only the pill went
  // conditional. A multi-repo ship task on the session it named, before anything has
  // merged, is the case where that distinction is load-bearing: the pill has nothing to
  // say and the row still has two repositories to name.
  await dispatch(dashboard, daemon, SHIP, "ship", [daemon.secondRepo]);
  await sessions(daemon, 1);

  await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  const card = dashboard.locator(".console-detail");
  await expect(card).toBeVisible();

  // The row is there, naming both repositories and each one's pull-request state.
  const repoRow = card.locator(".task-repo-prs");
  await expect(repoRow).toBeVisible();
  await expect(repoRow.locator(".task-repo-pr")).toHaveCount(2);
  await expect(repoRow).toContainText("no PR");

  // And the pill above it is absent rather than empty. Standing on its own is the intended
  // shape here: each chip in the row names its own repo, so the row says what it is without
  // a heading, and drawing the pill for it would put an empty stub over the top.
  await expect(card.locator(".task-chip")).toHaveCount(0);

  await shot(
    card,
    "multi-repo-row-without-a-pill",
    "a multi-repo card keeps its per-repo PR row with no empty pill above it",
  );
});

test("the objective reads under the session's name instead of above the transcript", async ({
  dashboard,
  daemon,
}) => {
  await dispatch(dashboard, daemon, SHIP, "ship");
  await sessions(daemon, 1);
  const detail = await openDetail(dashboard, daemon, SHIP.title);

  // Turn one came through the Agent SDK, so the accepted dispatch prompt itself is the
  // objective. This is also the browser regression for losing Goal when no terminal hook
  // exists: the fake SDK runs no machine-installed hooks at all.
  const objective = SHIP.intent;

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

  await shot(
    detail.locator("header.detail-head"),
    "objective-under-the-name",
    "the objective reads under the session name, in the identity block",
  );
  await shot(detail, "detail-pane", "the whole pane: identity band, tabs, transcript, footer");
});

test("a full-length objective clips to one line and does not cost the header a row", async ({
  dashboard,
  daemon,
}) => {
  // The risk this relocation carries, and the one no markup assertion can see. An objective
  // is bounded at 180 characters (`GOAL_MAX_CHARS`), which is about a thousand pixels of
  // text - and `.detail-head` wraps rather than shrinks, so an objective allowed to set the
  // identity block's intrinsic width would push every chip after it onto a second row. A
  // header that grew a row to save one is not the trade this change makes.
  const long =
    "Give the conversation back the height the console detail header was spending on constants, "
    + "duplicates and a control that had drifted into the footer where nobody ever looked for it";
  const task = { title: SHIP.title, intent: long };
  await dispatch(dashboard, daemon, task, "ship");
  await sessions(daemon, 1);
  const detail = await openDetail(dashboard, daemon, task.title);

  const head = detail.locator("header.detail-head");
  const headingBox = await detail.getByRole("heading", { name: SHIP.title }).boundingBox();
  const chipBefore = await head.locator(".rt-model").boundingBox();
  expect(headingBox, "the heading should be laid out").not.toBeNull();
  expect(chipBefore, "the model pill should be laid out").not.toBeNull();
  // Same row to begin with: this is the state the assertion below has to preserve.
  expect(Math.abs(chipBefore!.y - headingBox!.y)).toBeLessThan(24);

  const objective = detail.locator(".detail-title .goal");
  await expect(objective).toBeVisible();

  // One line, clipped rather than wrapped: the box is a single line tall and the text
  // inside it is wider than the box, which is what the ellipsis is drawn from.
  const line = await objective.boundingBox();
  expect(line, "the objective should be laid out").not.toBeNull();
  expect(line!.height, "the objective should take one line").toBeLessThan(24);
  const overflows = await objective.evaluate((el) => el.scrollWidth > el.clientWidth);
  expect(overflows, "a 180-character objective should be clipped, not wrapped").toBe(true);

  // And the chips it sits beside have not been pushed anywhere.
  const chipAfter = await head.locator(".rt-model").boundingBox();
  expect(chipAfter, "the model pill should still be laid out").not.toBeNull();
  expect(
    Math.abs(chipAfter!.y - headingBox!.y),
    "a long objective must not push the runtime cluster onto a second row",
  ).toBeLessThan(24);

  await shot(head, "long-objective-one-row", "a 180-character objective still fits one row");
});
