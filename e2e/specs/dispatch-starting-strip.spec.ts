import { mkdirSync } from "node:fs";

import type { Locator, Page } from "@playwright/test";

import { artifactsDir } from "../fixtures/artifacts.ts";
import { expect, test } from "../fixtures/test.ts";

const EVIDENCE = artifactsDir("dispatch-starting-strip");

/**
 * Capture what a reviewer cannot get from `1 passed`.
 *
 * This spec asserts a state that exists for a few seconds and then deletes itself, so the
 * frames are the only way to see that the placeholder is legible, sits where the real cards
 * will go, and leaves nothing behind. Behind `MC_E2E_EVIDENCE` like every other capture in
 * this suite: an ordinary run writes nothing, because `screenshot` is configured
 * `on-failure` and a passing run that littered would make a failure's frames hard to find.
 *
 * The cursor is parked at the origin first - a stray hover paints a control the operator was
 * not touching, and that is exactly the kind of difference that makes two runs' frames
 * disagree for no reason.
 */
async function shoot(page: Page, name: string, target?: Locator): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await (target ?? page).screenshot({ path: `${EVIDENCE}${name}.png`, animations: "disabled" });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/dispatch-starting-strip/${name}.png`);
}

/** Narrate a state the frames alone cannot prove was ASSERTED rather than merely photographed. */
function observed(line: string): void {
  if (!process.env.MC_E2E_EVIDENCE) return;
  // eslint-disable-next-line no-console
  console.log(`OBSERVED ${line}`);
}

/**
 * The gap this covers: a dispatched task used to be drawn NOWHERE until its session existed.
 *
 * `POST /api/tasks` inserts the row and broadcasts `task_upsert` synchronously, but the
 * agent's session does not arrive until the title has been summarised by a model, a worktree
 * has been provisioned and the terminal home has been discovered. Measured on the configured
 * provider that is 4.5-7.7s, and longer on a cold worktree-pool slot that has to run the
 * repository's setup command first. For that whole window `backlogTasks` had already stopped
 * matching the task and every other surface on the page reads `session.task`, which is still
 * null - so the operator pressed Dispatch and watched nothing happen, which reads as a
 * dropped dispatch rather than as work starting.
 *
 * WHY THIS IS NOT RACY, which is the only interesting thing about the timing here. The strip
 * is driven by `task_upsert`, and the daemon emits that event BEFORE it writes the HTTP
 * response (`registry.upsertTask` is synchronous and runs inside `tasks.create`, which the
 * route calls before `c.json(task)`). So by the time `waitForResponse` resolves, the browser
 * has already been told about the task. The only thing this races is the session BINDING,
 * which cannot happen until a real worktree has been cut and a real agent process has been
 * spawned and discovered - orders of magnitude longer than one loopback round trip.
 *
 * Only the model is fake, per this suite's standing rule: the dispatch cuts a real worktree
 * and spawns a real (faked) agent binary, so the states asserted here are the real ones.
 */
test("a dispatched task is visible while it provisions, then hands over to its session card", async ({
  dashboard,
  daemon,
}) => {
  const intent = "Rename the flexbox helper and update its callers.";
  const title = "Rename the flexbox helper";

  await dashboard.getByRole("button", { name: "Dispatch" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();

  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  // RepoCombobox portals its list over the form. Close it before reaching the fields below.
  await dashboard.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(intent);

  // Pin the post-work Workflow to none. Left on "Dispatch default" the daemon's configured
  // workflow refuses this launch with a 409 - it requires Workflows Live mode and an
  // allowlisted repository, neither of which this disposable daemon has. Nothing here is
  // about workflows, so take them out of the picture rather than provision them.
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");

  // An explicit title, deliberately. Leaving it blank is the other real path, but it makes
  // the assertion below depend on how long a headless model call takes to fail against a
  // fake binary - which is a timing assumption, not a behaviour. The strip does not care
  // where the title came from, so pin the behaviour and not the provider.
  await dialog.getByRole("button", { name: /^Backlog details/ }).click();
  await dialog.getByPlaceholder("summarized from the task if left blank").fill(title);

  const created = dashboard.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/tasks",
  );
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  const response = await created;
  expect(response.ok(), `dispatching answered ${response.status()}`).toBe(true);

  // The task exists and is provisioning: dispatched, with nothing to stand on yet.
  const task = (await response.json()) as { status?: string; sessionId?: string | null };
  expect(task).toMatchObject({ status: "dispatching", sessionId: null });

  // The consequence a person actually sees. Selected by the section's accessible name and
  // the text it renders, per this suite's no-`data-testid` rule.
  const strip = dashboard.getByRole("region", { name: "Starting" });
  await expect(strip).toBeVisible();
  const row = strip.getByRole("listitem").filter({ hasText: title });
  await expect(row).toBeVisible();
  await expect(row).toContainText("Starting…");
  observed(
    `a dispatched task with no session yet is drawn in the Starting strip: "${title}", Starting…`,
  );

  // And the page does not contradict it. The fleet's empty state used to render directly
  // under this row, telling the operator "No agent sessions detected. Start a ... session in
  // a terminal pane" in the seconds after they asked for exactly that - two answers to one
  // question, on one screen. Caught by looking at the captured frame, which is the whole
  // reason this spec takes one.
  await expect(dashboard.getByText("No agent sessions detected")).toBeHidden();
  observed("the fleet's empty state stood down while the dispatch was starting");
  // Two frames of the same moment on purpose. The page shot answers "where does this land,
  // and does the fleet still read correctly with it there"; the element shot is the one a
  // reviewer can actually read the row in.
  await shoot(dashboard, "starting-page");
  await shoot(dashboard, "starting-strip", strip);

  // The handover, which is the half that keeps this from becoming a card that never leaves:
  // the session arrives, the real card takes the task, and the placeholder withdraws. The
  // strip removes itself from the page entirely once its last row is gone.
  const card = dashboard.locator(".card", { hasText: title });
  await expect(card).toBeVisible({ timeout: 60_000 });
  await expect(strip).toBeHidden();
  observed(
    "the session bound: the real card took the task and the Starting strip removed itself",
  );
  await shoot(dashboard, "handover-page");
});
