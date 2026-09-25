import { mkdirSync } from "node:fs";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import type { Locator, Page } from "@playwright/test";

const EVIDENCE = artifactsDir("backlog-bulk-edit");

/** A frame of the state just asserted, behind `MC_E2E_EVIDENCE` like every other spec. */
async function shoot(
  page: Page,
  name: string,
  target?: Locator,
  { holdPointer = false }: { holdPointer?: boolean } = {},
): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  // Off every control first, since a resting pointer portals a Tooltip - except mid-drag,
  // where moving the pointer would move the marquee being photographed.
  if (!holdPointer) await page.mouse.move(0, 0);
  await (target ?? page).screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/backlog-bulk-edit/${name}.png`);
}

/**
 * Selecting several backlog cards and editing or deleting them together.
 *
 * Driven through the browser because the claim spans every layer: a modifier click or a
 * marquee has to become a selection, the dialog has to send one bulk request, and every
 * card has to redraw from the `task_upsert` frames that request produces. No agent is
 * launched - every task is seeded straight into the backlog - so nothing spends tokens.
 */

interface Seeded {
  id: string;
  title: string;
}

async function seedBacklogTask(daemon: DaemonHandle, title: string): Promise<Seeded> {
  const response = await fetch(`${daemon.baseURL}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repoRoot: daemon.repo, title, intent: `${title}.`, backlog: true }),
  });
  expect(response.ok, `seeding "${title}" answered ${response.status}`).toBe(true);
  const task = (await response.json()) as { id: string };
  return { id: task.id, title };
}

interface TaskView {
  id: string;
  title: string;
  priority: string | null;
  labels: string[];
  enabled: boolean;
}

async function readTasks(daemon: DaemonHandle): Promise<TaskView[]> {
  const response = await fetch(`${daemon.baseURL}/api/tasks`);
  expect(response.ok).toBe(true);
  return (await response.json()) as TaskView[];
}

async function useBoardLayout(page: Page, daemon: DaemonHandle): Promise<void> {
  const response = await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ layout: "board" }),
  });
  const body = (await response.json()) as { config?: { layout?: string } };
  expect(body.config?.layout).toBe("board");
  await page.reload();
  await expect(page.locator("main.board")).toBeVisible();
}

const card = (page: Page, title: string): Locator => page.locator(".bl-card", { hasText: title });

test("shift-click selects a range, and the bulk edit changes every selected card", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.setViewportSize({ width: 1280, height: 900 });
  const titles = [
    "Fix flaky reconnect test",
    "Add retry budget to sweeps",
    "Document the Linear mapping",
    "Scout double-filed epics",
  ];
  for (const title of titles) await seedBacklogTask(daemon, title);
  await useBoardLayout(dashboard, daemon);
  const column = dashboard.locator("section.board-backlog");
  await expect(column.locator(".board-col-n")).toHaveText("4");

  // The checkbox starts the selection; a shift-click on a later card takes the range.
  await dashboard.getByRole("checkbox", { name: `Select "${titles[1]}"` }).click();
  await dashboard.getByRole("button", { name: titles[3], exact: true }).click({ modifiers: ["Shift"] });

  const bar = dashboard.getByRole("toolbar", { name: "Selected backlog tasks" });
  await expect(bar).toContainText("3 selected");
  for (const title of titles.slice(1)) {
    await expect(dashboard.getByRole("checkbox", { name: `Select "${title}"` })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  }
  await expect(dashboard.getByRole("checkbox", { name: `Select "${titles[0]}"` })).toHaveAttribute(
    "aria-checked",
    "false",
  );
  // A shift-click is a selection, never an open: no editor came up on the way.
  await expect(dashboard.getByRole("dialog", { name: "Edit a backlog task" })).toHaveCount(0);
  await shoot(dashboard, "01-range-selected", column);

  await bar.getByRole("button", { name: "Edit 3 tasks…" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Edit 3 backlog tasks" });
  await expect(dialog).toBeVisible();
  await expectContentClearsBorder(dialog);
  await expect(dialog.getByRole("button", { name: "Apply to 3 tasks" })).toBeDisabled();
  await expect(dialog.getByRole("list", { name: "Selected tasks" })).toContainText(titles[2]!);

  await dialog.getByLabel("Priority", { exact: true }).selectOption("blocker");
  await dialog.getByLabel("Add a label").fill("q4");
  await dialog.getByLabel("Add a label").press("Enter");
  await dialog.getByRole("radiogroup", { name: "Autopilot" }).getByRole("radio", { name: "Off" }).click();
  await expect(dialog).toContainText("3 fields on 3 tasks");
  await shoot(dashboard, "02-bulk-edit-dialog", dialog);

  const request = dashboard.waitForRequest(
    (r) => r.method() === "POST" && r.url().endsWith("/api/tasks/bulk-update"),
  );
  await dialog.getByRole("button", { name: "Apply to 3 tasks" }).click();
  expect((await request).postDataJSON()).toMatchObject({
    set: { priority: "blocker", enabled: false },
    labels: { add: ["q4"], remove: [] },
  });
  await expect(dialog).toBeHidden();

  // Every selected card redraws from the daemon's own frames, and the unselected one does not.
  for (const title of titles.slice(1)) {
    await expect(dashboard.getByLabel(`Priority for ${title}`)).toHaveValue("blocker");
    await expect(card(dashboard, title)).toContainText("q4");
    await expect(card(dashboard, title)).toContainText("autopilot will skip this");
  }
  await expect(dashboard.getByLabel(`Priority for ${titles[0]}`)).toHaveValue("");
  await expect(card(dashboard, titles[0]!)).not.toContainText("q4");
  await shoot(dashboard, "03-cards-updated", column);

  const stored = await readTasks(daemon);
  for (const task of stored) {
    const selected = titles.slice(1).includes(task.title);
    expect(task.priority).toBe(selected ? "blocker" : null);
    expect(task.labels).toEqual(selected ? ["q4"] : []);
    expect(task.enabled).toBe(!selected);
  }

  // Escape, from inside the column, clears the selection and takes the bar away.
  await dashboard.getByRole("checkbox", { name: `Select "${titles[1]}"` }).focus();
  await dashboard.keyboard.press("Escape");
  await expect(bar).toBeHidden();
});

test("dragging on empty column space selects the cards it crosses, then deletes them", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.setViewportSize({ width: 1280, height: 900 });
  const titles = ["Keep this sweep", "Retire the poller", "Drop the old flag"];
  for (const title of titles) await seedBacklogTask(daemon, title);
  await useBoardLayout(dashboard, daemon);

  const body = dashboard.locator("section.board-backlog .board-col-body");
  const bodyBox = (await body.boundingBox())!;
  const last = (await card(dashboard, titles[2]!).boundingBox())!;
  const middle = (await card(dashboard, titles[1]!).boundingBox())!;
  // From the column's side margin beside the last card, up into the middle one. The press
  // lands on the column body, not on a card, so it draws a marquee instead of lifting a
  // card. The margin and the gaps between cards are always there, even when the column is
  // full and has no empty space under its last card.
  await dashboard.mouse.move(bodyBox.x + 3, last.y + 12);
  await dashboard.mouse.down();
  await dashboard.mouse.move(bodyBox.x + 60, middle.y + middle.height / 2, { steps: 6 });
  await expect(dashboard.locator(".bl-marquee")).toBeVisible();
  await shoot(dashboard, "04-marquee", dashboard.locator("section.board-backlog"), {
    holdPointer: true,
  });
  await dashboard.mouse.up();
  await expect(dashboard.locator(".bl-marquee")).toHaveCount(0);

  const bar = dashboard.getByRole("toolbar", { name: "Selected backlog tasks" });
  await expect(bar).toContainText("2 selected");
  await expect(dashboard.getByRole("checkbox", { name: `Select "${titles[0]}"` })).toHaveAttribute(
    "aria-checked",
    "false",
  );

  // Delete asks first, in place, and only the confirmation reaches the daemon.
  await bar.getByRole("button", { name: "Delete…" }).click();
  await expect(bar).toContainText("Delete 2 tasks?");
  await shoot(dashboard, "05-delete-confirm", dashboard.locator("section.board-backlog"));
  const deletion = dashboard.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/api/tasks/bulk-delete"),
  );
  await bar.getByRole("button", { name: "Delete", exact: true }).click();
  expect((await deletion).status()).toBe(200);

  await expect(card(dashboard, titles[1]!)).toHaveCount(0);
  await expect(card(dashboard, titles[2]!)).toHaveCount(0);
  await expect(card(dashboard, titles[0]!)).toBeVisible();
  await expect(bar).toBeHidden();
  await expect.poll(async () => (await readTasks(daemon)).map((t) => t.title)).toEqual([titles[0]]);
});

test("a plain click still opens the card, and a refused bulk edit says which task stopped it", async ({
  dashboard,
  daemon,
}) => {
  const titles = ["Tighten cleanup grace", "Rename the sweep flag"];
  for (const title of titles) await seedBacklogTask(daemon, title);
  await useBoardLayout(dashboard, daemon);

  await dashboard.getByRole("button", { name: titles[0], exact: true }).click({ modifiers: ["ControlOrMeta"] });
  await dashboard.getByRole("button", { name: titles[1], exact: true }).click({ modifiers: ["ControlOrMeta"] });
  const bar = dashboard.getByRole("toolbar", { name: "Selected backlog tasks" });
  await expect(bar).toContainText("2 selected");

  // An ordinary click is unchanged by a selection: it opens that one task.
  await dashboard.getByRole("button", { name: titles[0], exact: true }).click();
  const editor = dashboard.getByRole("dialog", { name: "Edit a backlog task" });
  await expect(editor).toBeVisible();
  await editor.getByRole("button", { name: "Cancel" }).click();
  await expect(editor).toBeHidden();
  await expect(bar).toContainText("2 selected");

  // The daemon's refusal is rendered as-is and the dialog stays over the selection. The
  // refusal is fulfilled here, because reaching a real one means racing a task out of the
  // backlog; what is under test is what the dialog does with it.
  await dashboard.route("**/api/tasks/bulk-update", (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: `"${titles[1]}" is running, not in the backlog` }),
    }),
  );
  await bar.getByRole("button", { name: "Edit 2 tasks…" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Edit 2 backlog tasks" });
  await dialog.getByLabel("Priority", { exact: true }).selectOption("high");
  await dialog.getByRole("button", { name: "Apply to 2 tasks" }).click();
  await expect(dialog.getByRole("alert")).toHaveText(`"${titles[1]}" is running, not in the backlog`);
  await expect(dialog).toBeVisible();
  await shoot(dashboard, "06-refusal", dialog);

  // Escape closes the dialog and only the dialog: the selection it was opened over stays.
  await dialog.getByRole("button", { name: "Cancel" }).focus();
  await dashboard.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(bar).toContainText("2 selected");
});

test("a selected task that leaves the backlog while the dialog is open refuses the whole edit", async ({
  dashboard,
  daemon,
}) => {
  const survivor = await seedBacklogTask(daemon, "Keep the retry budget");
  const doomed = await seedBacklogTask(daemon, "Delete me mid-edit");
  await useBoardLayout(dashboard, daemon);

  await dashboard.getByRole("checkbox", { name: `Select "${survivor.title}"` }).click();
  await dashboard.getByRole("checkbox", { name: `Select "${doomed.title}"` }).click();
  const bar = dashboard.getByRole("toolbar", { name: "Selected backlog tasks" });
  await bar.getByRole("button", { name: "Edit 2 tasks…" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Edit 2 backlog tasks" });
  await expect(dialog).toBeVisible();

  // Someone else removes one of the selected tasks while the dialog is open.
  const removed = await fetch(`${daemon.baseURL}/api/tasks/${encodeURIComponent(doomed.id)}`, {
    method: "DELETE",
  });
  expect(removed.ok).toBe(true);
  await expect(card(dashboard, doomed.title)).toHaveCount(0);

  // The dialog stays over the selection it was opened for, and says it can no longer apply.
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("1 selected task has left the backlog", { exact: false })).toBeVisible();

  await dialog.getByLabel("Priority", { exact: true }).selectOption("blocker");
  const request = dashboard.waitForRequest(
    (r) => r.method() === "POST" && r.url().endsWith("/api/tasks/bulk-update"),
  );
  await dialog.getByRole("button", { name: "Apply to 2 tasks" }).click();
  // Both ids go to the daemon, not just the one still on the board.
  expect(((await request).postDataJSON() as { taskIds: string[] }).taskIds).toEqual([
    survivor.id,
    doomed.id,
  ]);
  await expect(
    dialog.getByText("A selected task was deleted while this dialog was open", { exact: false }),
  ).toBeVisible();
  await expect(dialog).toBeVisible();

  // Nothing landed on the task that was still there.
  await expect(dashboard.getByLabel(`Priority for ${survivor.title}`)).toHaveValue("");
  const stored = await readTasks(daemon);
  expect(stored.map((t) => [t.title, t.priority])).toEqual([[survivor.title, null]]);
});
