import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import { TASK_STATUSES, type TaskStatus } from "../../src/shared/types.ts";
import { mkSession, mkTaskSummary } from "../../test/helpers/session-fixture.ts";

// The lifecycle contract exercises the real daemon and SQLite. This browser matrix
// injects their task-status projections through SSE, including the brief provisioning
// state, to check which controls the built Sitrep renders and opens.
test("Sitrep offers completion and cancellation only for active task statuses", async ({ dashboard, daemon }) => {
  const stream = await fetch(`${daemon.baseURL}/events`);
  expect(stream.ok).toBe(true);
  const reader = stream.body!.getReader();
  let text = "";
  const decoder = new TextDecoder();
  try {
    while (!text.includes("\n\n")) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("SSE closed before its snapshot");
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    await reader.cancel();
  }
  const data = text.split("\n").find((line) => line.startsWith("data: "))!;
  const snapshot = JSON.parse(data.slice(6));
  const expected = {
    backlog: false, dispatching: true, running: true, done: false, cancelled: false, failed: false,
  } satisfies Record<TaskStatus, boolean>;
  expect(Object.keys(expected).sort()).toEqual([...TASK_STATUSES].sort());
  const sessions = TASK_STATUSES.map((status) => mkSession({
    id: `session-${status}`,
    agentSessionId: `agent-${status}`,
    name: `Status ${status}`,
    cwd: daemon.repo,
    repoRoot: daemon.repo,
    gitBranch: null,
    activity: null,
    task: mkTaskSummary({ id: `task-${status}`, status, title: `Task ${status}` }),
  }));
  await dashboard.route("**/events", (route) => route.fulfill({
    contentType: "text/event-stream",
    body: `data: ${JSON.stringify({ ...snapshot, sessions })}\n\n`,
  }));
  await dashboard.reload();
  await expect(dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row"))
    .toHaveCount(TASK_STATUSES.length);
  await dashboard.keyboard.press("Shift+P");
  const sitrep = dashboard.getByRole("dialog", { name: "Sitrep" });
  await expect(sitrep).toBeVisible();
  await expectContentClearsBorder(sitrep);

  for (const status of TASK_STATUSES) {
    const row = sitrep.locator(".report-row", { hasText: `Task ${status}` });
    await expect(row).toBeVisible();
    await expect(row.getByRole("button", { name: "Cancel", exact: true })).toHaveCount(expected[status] ? 1 : 0);
    await expect(row.getByRole("button", { name: "Mark done…", exact: true })).toHaveCount(expected[status] ? 1 : 0);
    if (expected[status]) {
      await row.getByRole("button", { name: "Mark done…", exact: true }).click();
      const outcome = row.getByPlaceholder("outcome, e.g. opened PR #123");
      await expect(outcome).toBeVisible();
      await outcome.press("Escape");
      await expect(sitrep).toBeHidden();
      await dashboard.keyboard.press("Shift+P");
      await expect(sitrep).toBeVisible();
      await row.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(row.getByRole("button", { name: "Confirm cancel", exact: true })).toBeVisible();
      await row.getByRole("button", { name: "✕", exact: true }).click();
    }
  }
  const evidence = artifactsDir("active-task-policy");
  mkdirSync(evidence, { recursive: true });
  await dashboard.mouse.move(0, 0);
  await sitrep.screenshot({ path: join(evidence, "status-controls.png") });
});
