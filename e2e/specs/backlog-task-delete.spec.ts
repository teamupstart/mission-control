import { mkdirSync } from "node:fs";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import type { Locator, Page } from "@playwright/test";

const EVIDENCE = artifactsDir("backlog-task-delete");

/**
 * A frame of the state the assertion beside it just proved, behind `MC_E2E_EVIDENCE` so an
 * ordinary run does not rewrite a binary for no added signal. What a picture adds here is
 * the half the DOM cannot carry: that the danger-side button reads as a danger-side button
 * rather than as one more ghost verb in a row of four.
 */
async function shoot(page: Page, name: string, target?: Locator): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  // The dialog is taller than the 720px default viewport and its BODY is what scrolls, so an
  // element screenshot at that size crops the footer away - which is the one part of this
  // dialog these frames exist to show. Grown for the capture and put straight back, so the
  // assertions around it keep running at the size every other spec uses.
  const restore = page.viewportSize();
  await page.setViewportSize({ width: 1280, height: 1100 });
  // Off every control first: `Tooltip` portals a bubble under a resting pointer.
  await page.mouse.move(0, 0);
  await (target ?? page).screenshot({ path: `${EVIDENCE}${name}.png` });
  if (restore) await page.setViewportSize(restore);
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/backlog-task-delete/${name}.png`);
}

/**
 * Deleting a shelved task from the form that wrote it.
 *
 * The backlog card is the door into the editor, and until now the editor was a door with no
 * bin behind it: every verb in that footer kept the task, so an operator who opened a card,
 * read it, and decided it was dead had to close the modal, know that a Sitrep panel exists,
 * open it, find the same row again, and delete it there. The delete route was never the
 * problem - `DELETE /api/tasks/:id` has always worked - the problem was that the only button
 * wired to it lived on a surface you had to already know about.
 *
 * Driven through the browser because nothing below this layer can see the claim. The route
 * tests prove the daemon removes a row, `renderToStaticMarkup` proves a footer contains a
 * button, and neither can say that pressing that button removes that card: the card leaves
 * over an SSE frame that the markup test has no daemon to emit and the route test has no DOM
 * to receive.
 *
 * No agent is launched by any test in this file - tasks are seeded straight into the backlog
 * and never dispatched - so nothing here spends model tokens.
 */

/** Seed a task into the backlog and hand back its id. */
async function seedBacklogTask(
  daemon: DaemonHandle,
  title: string,
  intent: string,
): Promise<string> {
  const response = await fetch(`${daemon.baseURL}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // The title is given rather than left to the daemon's titler, so the card this spec
    // then looks for is the card this spec named.
    body: JSON.stringify({ repoRoot: daemon.repo, title, intent, backlog: true }),
  });
  expect(response.ok, `seeding "${title}" answered ${response.status}`).toBe(true);
  const task = (await response.json()) as { id?: string };
  expect(task.id, "the daemon returned the seeded task").toBeTruthy();
  return task.id!;
}

/** Every task title the daemon will currently admit to holding. */
async function taskTitles(daemon: DaemonHandle): Promise<string[]> {
  const response = await fetch(`${daemon.baseURL}/api/tasks`);
  expect(response.ok, `/api/tasks answered ${response.status}`).toBe(true);
  return ((await response.json()) as Array<{ title?: string | null }>).map((t) => t.title ?? "");
}

/** The Board, which is the only layout that draws the backlog as a column of cards. */
async function useBoardLayout(page: Page, daemon: DaemonHandle): Promise<void> {
  const response = await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ layout: "board" }),
  });
  const body = (await response.json()) as { config?: { layout?: string } };
  expect(body.config?.layout, "the daemon accepted the Board layout").toBe("board");
  await page.reload();
  await expect(page.locator("main.board")).toBeVisible();
}

/** Open a backlog card's editor through the control a keyboard can reach: its title. */
async function openEditor(page: Page, title: string): Promise<Locator> {
  const card = page.locator(".bl-card", { hasText: title });
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: title }).click();
  const dialog = page.getByRole("dialog", { name: "Edit a backlog task" });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("deleting a backlog task from its editor takes the card off the board", async ({
  dashboard,
  daemon,
}) => {
  const doomed = "Retire the legacy poller";
  const keeper = "Keep the nightly sweep";
  await seedBacklogTask(daemon, doomed, "Rip out the poller and its dead config.");
  await seedBacklogTask(daemon, keeper, "Leave this one alone.");
  await useBoardLayout(dashboard, daemon);

  const column = dashboard.locator("section.board-backlog");
  await expect(column.locator(".board-col-n")).toHaveText("2");

  const dialog = await openEditor(dashboard, doomed);
  // The form really is over the doomed task and not merely over some task, so the deletion
  // below is attributable: a modal opened on the wrong row would delete the wrong row and
  // every assertion after it would still be about "one card fewer".
  await expect(dialog.getByPlaceholder("What should this agent do?")).toHaveValue(
    "Rip out the poller and its dead config.",
  );

  await shoot(dashboard, "01-editor-footer", dialog);

  const deletion = dashboard.waitForResponse(
    (r) => r.request().method() === "DELETE" && /\/api\/tasks\//.test(r.url()),
  );
  await dialog.getByRole("button", { name: "Delete" }).click();

  // The click reached the route the Sitrep row has always used.
  expect((await deletion).status(), "the daemon accepted the delete").toBe(200);
  // The modal closes on its own - there is no row left for it to be a form over.
  await expect(dialog).toBeHidden();
  // And the card leaves the board over `task_remove`, with no reload: this is the whole
  // point of deleting from here rather than from a panel two clicks away.
  await expect(dashboard.locator(".bl-card", { hasText: doomed })).toHaveCount(0);
  await expect(column.locator(".board-col-n")).toHaveText("1");

  // The neighbour is untouched, which is what makes this a delete rather than a purge.
  await expect(dashboard.locator(".bl-card", { hasText: keeper })).toBeVisible();
  await shoot(dashboard, "02-card-gone", dashboard.locator("section.board-backlog"));

  // Durably gone, not merely gone from this browser. A card removed from the DOM while the
  // row survives is the failure that would reappear on the next reload.
  await expect.poll(() => taskTitles(daemon)).toEqual([keeper]);
});

test("a refused delete keeps the modal open and says why", async ({ dashboard, daemon }) => {
  // The daemon refuses to remove a task that is running or whose worktree will not reclaim,
  // and the modal's job is to render that answer verbatim and stay put over a task that
  // still exists. Reaching a genuine refusal would mean launching an agent and racing its
  // state; the refusal itself is the daemon's own wording, fulfilled here, because what is
  // under test is what the FORM does with an answer it did not like.
  const title = "Refuse to leave";
  await seedBacklogTask(daemon, title, "This one answers 409.");
  await useBoardLayout(dashboard, daemon);

  await dashboard.route("**/api/tasks/*", async (route) => {
    if (route.request().method() !== "DELETE") return route.fallback();
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "cancel the task before removing it" }),
    });
  });

  const dialog = await openEditor(dashboard, title);
  await dialog.getByRole("button", { name: "Delete" }).click();

  // The reason lands where every other refusal from this form lands, above the buttons.
  await expect(dialog.locator(".dispatch-error")).toHaveText("cancel the task before removing it");
  // Still open, still over the task, and still offering the same button to press again -
  // a modal that closed here would leave the operator believing the task was gone.
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Delete" })).toBeEnabled();
  await expect(dashboard.locator(".bl-card", { hasText: title })).toBeVisible();
  expect(await taskTitles(daemon)).toEqual([title]);
  await shoot(dashboard, "03-refusal-stays-open", dialog);
});

test("the new-task dispatch modal offers no Delete", async ({ dashboard, daemon }) => {
  // An absence is only worth asserting where the thing could have been present, so this
  // test earns its negative first: the same footer, in the same build, in the same browser,
  // one mode over. Without the editor half below, a Delete that never rendered anywhere -
  // or one deleted from the codebase tomorrow - would pass this test unchanged.
  const title = "Prove Delete can appear";
  await seedBacklogTask(daemon, title, "Opened only to show the footer's danger side.");
  await useBoardLayout(dashboard, daemon);

  const editor = await openEditor(dashboard, title);
  await expect(editor.getByRole("button", { name: "Delete" })).toHaveCount(1);
  await editor.getByRole("button", { name: "Cancel" }).click();
  await expect(editor).toBeHidden();

  // Now the create path, where there is no row behind the form to delete. A Delete here
  // could only mean "discard what I typed" - which is what Clear, one button away, says.
  await dashboard.getByRole("button", { name: "Dispatch" }).first().click();
  const dispatch = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dispatch).toBeVisible();
  await expect(dispatch.getByRole("button", { name: "Add to backlog" })).toBeVisible();
  await expect(dispatch.getByRole("button", { name: "Delete" })).toHaveCount(0);
  await expect(dispatch.locator(".btn-danger-ghost")).toHaveCount(0);
  await shoot(dashboard, "04-dispatch-footer-has-none", dispatch);

  // Nothing was dispatched or deleted along the way.
  expect(await taskTitles(daemon)).toEqual([title]);
});
