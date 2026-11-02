import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import type { Session, Task, TaskDependency } from "../../src/shared/types.ts";
import type { ManagedPlanRevision } from "../../src/shared/managed-plans.ts";
import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";

async function post(daemon: DaemonHandle, path: string, body: object) {
  const res = await fetch(`${daemon.baseURL}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect(res.ok, await res.clone().text()).toBe(true);
  return res.json();
}
async function create(daemon: DaemonHandle, title: string, extra: object = {}): Promise<Task> {
  return post(daemon, "/api/tasks", { repoRoot: daemon.repo, title, intent: title, backlog: true, workflowId: null, enabled: false, ...extra });
}
async function editor(page: Page, daemon: DaemonHandle, title: string) {
  await fetch(`${daemon.baseURL}/api/ui/config`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ layout: "board" }) });
  await page.reload();
  await page.locator(".bl-card", { hasText: title }).getByRole("button", { name: title, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Edit a backlog task" });
  await expect(dialog).toBeVisible();
  await expectContentClearsBorder(dialog);
  return dialog;
}
function edge(title: string, satisfiedAt: number | null, type: "task" | "session" = "session"): TaskDependency {
  const common = { title, satisfiedAt, selectedAt: 1, episodeId: "old-episode", agentSessionId: null, branch: null, prUrl: null };
  return type === "task" ? { ...common, type, taskId: title, sessionId: null } : { ...common, type, sessionId: title };
}
async function shoot(page: Page, name: string) {
  if (!process.env.MC_E2E_EVIDENCE) return;
  const dir = artifactsDir("backlog-dependencies");
  mkdirSync(dir, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 1200 });
  await page.mouse.move(0, 0);
  await page.getByRole("dialog", { name: "Edit a backlog task" }).screenshot({ path: `${dir}${name}.png` });
}

async function savedPlan(daemon: DaemonHandle, local = false) {
  if (local) {
    const config = await fetch(`${daemon.baseURL}/api/skills/config`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ planStorage: "local" }) });
    expect(config.ok, await config.clone().text()).toBe(true);
  }
  const source = await create(daemon, "Planning origin", { backlog: false, kind: local ? "plan" : "ship" });
  let session!: Session;
  await expect.poll(async () => {
    const sessions = await (await fetch(`${daemon.baseURL}/api/sessions`)).json() as Session[];
    session = sessions.find(s => s.task?.id === source.id)!;
    return Boolean(session?.agentSessionId && session.state === "idle");
  }).toBe(true);
  const response = await fetch(`${daemon.baseURL}/mcp/plans/save`, { method: "POST", headers: { "content-type": "application/json", "x-harness-token": readFileSync(join(daemon.home, "token"), "utf8").trim() }, body: JSON.stringify({
    env: {}, sessionId: session.id, cwd: session.cwd, repoSlot: "repo-01", slug: "dependency-plan", requestId: randomUUID(), expectedRevision: 0,
    files: [{ name: "plan.md", content: "# Dependency plan" }, { name: "plan.html", content: "<h1>Dependency plan</h1>" }],
  }) });
  expect(response.ok, await response.clone().text()).toBe(true);
  const { manifest } = await response.json() as ManagedPlanRevision;
  const input = { repoKey: manifest.repoKey, planId: manifest.planId, revision: manifest.revision, files: ["plan.md"] };
  return { source, session, input };
}

test("saved merge status survives missing task and session sources, while unresolved sources stay unavailable", async ({ dashboard, daemon }) => {
  const task = await create(daemon, "Review dependency status");
  const dependencies = [edge("Completed session", 10), edge("Completed task", 10, "task"), edge("Missing session", null)];
  await daemon.crash();
  withDaemonDb(daemon, db => db.prepare("UPDATE tasks SET dependencies = ? WHERE id = ?").run(JSON.stringify(dependencies), task.id));
  await daemon.restart();
  const dialog = await editor(dashboard, daemon, task.title);
  await expect(dialog.locator(".dep-chips")).toContainText("Completed session (merged)");
  await expect(dialog.locator(".dep-chips")).toContainText("Completed task (merged)");
  await expect(dialog.locator(".dep-chips")).toContainText("Missing session (unavailable)");
  await dialog.getByRole("button", { name: "Remove dependency: Missing session" }).click();
  await expect(dialog.getByRole("button", { name: "Dispatch now" })).toBeEnabled();
  await shoot(dashboard, "durable-merged-status");
});

test("a pinned revision protects its exact merged origin but permits unrelated removal and saving", async ({ dashboard, daemon }) => {
  const { source, session, input } = await savedPlan(daemon);
  const task = await create(daemon, "Implement pinned plan", { dependencies: [{ type: "task", taskId: source.id }], planInputs: [input] });
  // Model a recorded merge followed by source-session disappearance. The daemon restarts
  // over this isolated persisted state; all editor reads and writes use production routes.
  await daemon.crash();
  withDaemonDb(daemon, db => {
    db.prepare("UPDATE tasks SET dependencies = ? WHERE id = ?").run(JSON.stringify([...task.dependencies.map(d => ({ ...d, satisfiedAt: 10 })), edge("Optional completed work", 10)]), task.id);
    db.prepare("UPDATE tasks SET status = 'done', session_id = NULL WHERE id = ?").run(source.id);
    db.prepare("DELETE FROM sdk_sessions WHERE id = ?").run(session.id);
  });
  await daemon.restart();
  const dialog = await editor(dashboard, daemon, task.title);
  const required = dialog.getByRole("button", { name: "Remove dependency: Planning origin" });
  await expect(required).toBeDisabled();
  await expect(dialog.locator(".dep-chips")).toContainText("Planning origin (merged)");
  await expect(dialog).toContainText("Required by pinned plan dependency-plan revision 1");
  await expect(dialog).toContainText("exact originating work episode");
  await expect(dialog.getByRole("link", { name: "dependency-plan revision 1" })).toHaveAttribute("href", `/?plan=${input.planId}&revision=1`);
  await dialog.getByRole("button", { name: "Remove dependency: Optional completed work" }).click();
  await shoot(dashboard, "pinned-origin-protected");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  const saved = (await (await fetch(`${daemon.baseURL}/api/tasks`)).json() as Task[]).find(t => t.id === task.id)!;
  expect(saved.dependencies).toHaveLength(1);
  expect(saved.planInputs).toEqual([input]);
  const invalid = await fetch(`${daemon.baseURL}/api/tasks/${task.id}/update`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ dependencies: [] }) });
  expect(invalid.ok).toBe(false);
  expect(await invalid.text()).toContain("revision 1");
});

test("a rejected pre-dispatch save keeps the draft and never dispatches; a launch rejection says it was saved", async ({ dashboard, daemon }) => {
  const task = await create(daemon, "Save before launching");
  const dialog = await editor(dashboard, daemon, task.title);
  await dialog.getByPlaceholder("What should this agent do?").fill("Edited intent");
  await dashboard.route(`**/api/tasks/${task.id}/update`, route => route.fulfill({ status: 409, json: { error: "Pinned plan revision changed" } }));
  let dispatches = 0;
  await dashboard.route(`**/api/tasks/${task.id}/dispatch`, route => { dispatches++; return route.fulfill({ status: 409, json: { error: "Launch unavailable" } }); });
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog.locator(".dispatch-error")).toContainText("Could not save task: Pinned plan revision changed");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog.locator(".dispatch-error")).toContainText("Could not save task; dispatch was not attempted: Pinned plan revision changed");
  expect(dispatches).toBe(0);
  await expect(dialog.getByPlaceholder("What should this agent do?")).toHaveValue("Edited intent");
  await shoot(dashboard, "save-rejected-before-dispatch");
  await dashboard.unroute(`**/api/tasks/${task.id}/update`);
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog.locator(".dispatch-error")).toContainText("saved, but Launch unavailable");
  expect(dispatches).toBe(1);
});


for (const removed of ["origin", "artifact"] as const) {
  test(`a pinned plan with two valid prerequisites permits removing the ${removed} and protects the remaining prerequisite`, async ({ dashboard, daemon }) => {
    const { source, input } = await savedPlan(daemon, true);
    const task = await create(daemon, "Choose a publication prerequisite", {
      planInputs: [input],
      dependencies: [
        { type: "task", taskId: source.id },
        { type: "plan", repoKey: input.repoKey, planId: input.planId, revision: input.revision },
      ],
    });
    const dialog = await editor(dashboard, daemon, task.title);
    const names = { origin: "Remove dependency: Planning origin", artifact: "Remove dependency: dependency-plan revision 1 publication" };
    const remaining = removed === "origin" ? "artifact" : "origin";
    const remove = dialog.getByRole("button", { name: names[removed] });
    const keep = dialog.getByRole("button", { name: names[remaining] });
    await expect(remove).toBeEnabled();
    await expect(keep).toBeEnabled();
    await remove.click();
    await expect(remove).toHaveCount(0);
    await expect(keep).toBeDisabled();
    await expect(dialog.locator(".dep-requirement")).toContainText("Required by pinned plan dependency-plan revision 1");
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toBeHidden();
    const saved = (await (await fetch(`${daemon.baseURL}/api/tasks`)).json() as Task[]).find(t => t.id === task.id)!;
    expect(saved.dependencies).toHaveLength(1);
    expect(saved.dependencies[0]).toMatchObject(remaining === "origin"
      ? { type: "task", taskId: source.id, episodeId: task.dependencies.find(d => d.type === "task")!.episodeId }
      : { type: "plan", repoKey: input.repoKey, planId: input.planId, revision: input.revision });
    expect(saved.planInputs).toEqual([input]);
    const reopened = await editor(dashboard, daemon, task.title);
    await expect(reopened.getByRole("button", { name: names[removed] })).toHaveCount(0);
    await expect(reopened.getByRole("button", { name: names[remaining] })).toBeDisabled();
    await expect(reopened.locator(".dep-requirement")).toContainText("Required by pinned plan dependency-plan revision 1");
    await shoot(dashboard, `last-prerequisite-after-removing-${removed}`);
  });
}

test("failed prerequisite guidance shows an error and disables dependency removal", async ({ dashboard, daemon }) => {
  const { source, input } = await savedPlan(daemon);
  const optional = await create(daemon, "Optional prerequisite");
  const task = await create(daemon, "Review unavailable guidance", {
    planInputs: [input], dependencies: [{ type: "task", taskId: source.id }, { type: "task", taskId: optional.id }],
  });
  const initial = await editor(dashboard, daemon, task.title);
  await expect(initial.getByRole("button", { name: "Remove dependency: Optional prerequisite" })).toBeEnabled();
  await initial.getByRole("button", { name: "Cancel" }).click();
  await expect(initial).toBeHidden();
  let guidanceRequests = 0;
  await dashboard.route(`**/api/tasks/${task.id}/plan-dependencies`, route => {
    guidanceRequests++;
    return route.fulfill({ status: 503, json: { error: "Guidance temporarily unavailable" } });
  });
  const dialog = await editor(dashboard, daemon, task.title);
  const notices = dialog.locator(".dep-requirement");
  await expect(notices).toHaveCount(2);
  for (const notice of await notices.all()) {
    await expect(notice).toBeVisible();
    await expect(notice).toHaveText("Could not verify pinned plan prerequisites. Reopen the editor to retry.");
  }
  expect(guidanceRequests).toBeGreaterThan(0);
  await expect(dialog.getByRole("button", { name: "Remove dependency: Planning origin" })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Remove dependency: Optional prerequisite" })).toBeDisabled();
  await shoot(dashboard, "prerequisite-guidance-unavailable");
});
