import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";

import type { Page } from "@playwright/test";

import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
import { expect, test } from "../fixtures/test.ts";
import type { BacklogPlan } from "../../src/shared/types.ts";

// Foreman's dependency planner writes a reason per task and a note for the whole backlog,
// and the dashboard prints both verbatim. A person only ever sees tasks by title, so an id
// in that prose is a reference they cannot follow. The fake provider's marked reply cites
// ids on purpose, exactly as a model ignoring the prompt would; what reaches the screen is
// decided by the real worker, the daemon's plan route and the real dashboard.

const EVIDENCE = artifactsDir("backlog-planner-task-titles");

async function shoot(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${EVIDENCE}${name}.png`, animations: "disabled" });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/backlog-planner-task-titles/${name}.png`);
}

async function addTask(daemon: DaemonHandle, title: string, intent: string): Promise<string> {
  const response = await fetch(`${daemon.baseURL}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repoRoot: daemon.repo, intent, title, backlog: true, workflowId: null }),
  });
  expect(response.ok, `create task: ${response.status}`).toBeTruthy();
  return ((await response.json()) as { id: string }).id;
}

const ARCHIVED_TITLE = "Retire the legacy verdict table";

/** A finished task the board does not hold, copied from a real row behind the daemon's back. */
function seedArchivedTask(daemon: DaemonHandle, fromId: string, title: string): string {
  const id = randomUUID();
  withDaemonDb(daemon, (db) => {
    db.exec("CREATE TEMP TABLE seeded AS SELECT * FROM tasks WHERE 0");
    db.prepare("INSERT INTO seeded SELECT * FROM tasks WHERE id = ?").run(fromId);
    db.prepare("UPDATE seeded SET id = ?, title = ?, status = 'done'").run(id, title);
    db.exec("INSERT INTO tasks SELECT * FROM seeded; DROP TABLE seeded;");
  });
  return id;
}

async function readPlan(daemon: DaemonHandle): Promise<BacklogPlan | null> {
  const response = await fetch(`${daemon.baseURL}/api/backlog/plan`);
  expect(response.ok).toBeTruthy();
  return response.json();
}

test("Foreman's plan names other tasks by title, never by id, wherever the dashboard shows it", async ({
  dashboard,
  daemon,
}) => {
  const titles = new Map<string, string>();
  const first = await addTask(daemon, "Add the review verdict schema", "Create the verdict table. E2E_PLANNER_CITES_TASK_IDS");
  titles.set(first, "Add the review verdict schema");
  // A finished task outside the backlog, which no dependency declares: the second task's
  // intent only mentions it, and the planner repeats what it read.
  const archived = seedArchivedTask(daemon, first, ARCHIVED_TITLE);
  titles.set(archived, ARCHIVED_TITLE);
  titles.set(
    await addTask(
      daemon,
      "Wire verdicts into the ship gate",
      `Read verdicts before shipping; the old flow is ${archived}. E2E_PLANNER_CITES_TASK_IDS`,
    ),
    "Wire verdicts into the ship gate",
  );
  const configured = await fetch(`${daemon.baseURL}/api/foreman/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: true, mode: "dry-run", autoBacklog: true, runner: "claude" }),
  });
  expect(configured.ok).toBeTruthy();
  await daemon.startForeman();

  // The fake provider answered: the plan has an entry for both tasks and its edge.
  await expect.poll(async () => (await readPlan(daemon))?.entries.length ?? 0, { timeout: 45_000 })
    .toBe(2);
  const plan = (await readPlan(daemon))!;
  const foundation = plan.entries.find((entry) => entry.dependsOn.length === 0)!;
  const dependent = plan.entries.find((entry) => entry.dependsOn.length > 0)!;
  expect(dependent.dependsOn).toEqual([foundation.taskId]);
  const foundationTitle = titles.get(foundation.taskId)!;
  const dependentTitle = titles.get(dependent.taskId)!;

  // The Line: the next-up pill opens Foreman's reason for the task it would pick.
  const backlogStage = dashboard.getByRole("navigation", { name: "The Line" })
    .getByRole("button", { name: /^Backlog,/ });
  await backlogStage.click();
  const backlog = dashboard.getByRole("region", { name: "Backlog drawer" });
  await backlog.getByRole("button", { name: /^Next up:/ }).click();
  const why = dashboard.getByRole("dialog", { name: /^Why / });
  await expect(why).toContainText(`Unblocks "${dependentTitle}".`, { timeout: 20_000 });
  for (const id of titles.keys()) await expect(why).not.toContainText(id);
  await shoot(dashboard, "line-next-up-reason");

  // The Board: the backlog column prints the plan's note above the cards.
  const layout = await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ layout: "board" }),
  });
  expect(layout.ok).toBeTruthy();
  await dashboard.reload();
  await expect(dashboard.locator("main.board")).toBeVisible();
  const note = dashboard.locator(".bl-plan-note");
  await expect(note).toHaveText(
    `"${foundationTitle}" goes first; "${dependentTitle}" build on it. See "${ARCHIVED_TITLE}".`,
    { timeout: 20_000 },
  );
  for (const id of titles.keys()) await expect(note).not.toContainText(id);
  await shoot(dashboard, "board-plan-note");
});
