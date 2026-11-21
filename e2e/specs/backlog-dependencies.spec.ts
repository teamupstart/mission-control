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
import { writeGhPullRequests } from "../fixtures/fake-agents.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";

async function post(daemon: DaemonHandle, path: string, body: object) {
  const res = await fetch(`${daemon.baseURL}${path}`, { method: "POST", headers: { "content-type": "application/json", ...(path.startsWith("/mcp/") ? { "x-harness-token": readFileSync(join(daemon.home, "token"), "utf8").trim() } : {}) }, body: JSON.stringify(body) });
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
  await page.setViewportSize({ width: 1440, height: ["revision-change-awaiting-preview", "revision-change-launch-retry", "revision-change-unreachable", "revision-change-editing-guard", "revision-change-ready-dispatch", "revision-change-missing-merge-proof", "revision-change-timeout"].includes(name) || name.startsWith("revision-change-http-") ? 2200 : 1200 });
  await page.mouse.move(0, 0);
  const target = name.startsWith("revision-change-preview") ? page.locator(".pinned-plan-change")
    : name === "revision-change-live-snapshot" ? page.locator(".field").filter({ has: page.locator(".pinned-plan-change") })
    : page.getByRole("dialog", { name: "Edit a backlog task" });
  await target.screenshot({ path: `${dir}${name}.png` });
}

async function savedPlan(daemon: DaemonHandle, local = false, slug = "dependency-plan") {
  if (local) {
    const config = await fetch(`${daemon.baseURL}/api/skills/config`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ planStorage: "local" }) });
    expect(config.ok, await config.clone().text()).toBe(true);
  }
  const source = await create(daemon, slug === "dependency-plan" ? "Planning origin" : "Replacement origin", { backlog: false, kind: local ? "plan" : "ship" });
  let session!: Session;
  await expect.poll(async () => {
    const sessions = await (await fetch(`${daemon.baseURL}/api/sessions`)).json() as Session[];
    session = sessions.find(s => s.task?.id === source.id)!;
    return Boolean(session?.agentSessionId && session.state === "idle");
  }).toBe(true);
  const response = await fetch(`${daemon.baseURL}/mcp/plans/save`, { method: "POST", headers: { "content-type": "application/json", "x-harness-token": readFileSync(join(daemon.home, "token"), "utf8").trim() }, body: JSON.stringify({
    env: {}, sessionId: session.id, cwd: session.cwd, repoSlot: "repo-01", slug, requestId: randomUUID(), expectedRevision: 0,
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
  await expect(dialog.getByRole("link", { name: "dependency-plan revision 1" })).toHaveAccessibleDescription("Open pinned plan revision 1 in a new tab");
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


for (const episode of ["current", "historical", "late-opened"] as const) {
  test(`manual Complete leaves the override unchecked and a later ${episode} merge releases its dependent`, async ({ dashboard, daemon }) => {
  const source = await create(daemon, "Late merged prerequisite", { backlog: false });
  await expect.poll(async () => {
    const sessions = await (await fetch(`${daemon.baseURL}/api/sessions`)).json() as Session[];
    return sessions.some(s => s.task?.id === source.id && s.agentSessionId && s.state === "idle");
  }).toBe(true);
  const dependent = await create(daemon, "Waiting for shipped work", { dependencies: [{ type: "task", taskId: source.id }] });
  const prCreatedAt = new Date().toISOString();
  await dashboard.reload();
  await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  await dashboard.locator(".console-detail").getByRole("button", { name: "Complete" }).click();
  const complete = dashboard.getByRole("dialog", { name: "Complete task and close session" });
  await expectContentClearsBorder(complete);
  await expect(complete.getByRole("checkbox", { name: /Unblock/ })).not.toBeChecked();
  await complete.getByRole("button", { name: "Complete & close" }).click();
  await expect(complete).toBeHidden();
  const read = async (id: string): Promise<Task> => {
    const tasks = await (await fetch(`${daemon.baseURL}/api/tasks`)).json() as Task[];
    return tasks.find(task => task.id === id)!;
  };
  await expect.poll(async () => (await read(source.id)).status).toBe("done");
  expect((await read(dependent.id)).dependencies[0]!.satisfiedAt).toBeNull();
  const before = await read(source.id);
  const dialog = await editor(dashboard, daemon, dependent.title);
  await expect(dialog.getByRole("button", { name: "Waiting for dependencies" })).toBeDisabled();
  const url = "https://github.com/acme/demo-repo/pull/1303";
  writeGhPullRequests(daemon.home, [{ cwd: daemon.repo, url, number: 1303, state: "MERGED",
    createdAt: episode === "late-opened" ? new Date().toISOString() : prCreatedAt, mergedAt: new Date().toISOString(), headRefOid: "a".repeat(40) }]);
  // Discovery is disabled in the fixture, so seed the branch observation that a real
  // session leaves behind. No PR URL or merge evidence is seeded: the real poller must
  // discover and verify both after restart with the session already closed.
  await daemon.crash();
  withDaemonDb(daemon, db => {
    db.prepare("UPDATE task_work_episode_bindings SET branch = ? WHERE task_id = ?")
      .run("feat/late-prerequisite", source.id);
    db.prepare("UPDATE session_work_episodes SET branch = ? WHERE session_id = (SELECT session_id FROM task_work_episode_bindings WHERE task_id = ?)")
      .run("feat/late-prerequisite", source.id);
    if (episode === "late-opened") {
      // Stand in for the pre-completion branch observation while fixture discovery is disabled.
      // The server regression separately exercises capture, freeze, and rollover of this SHA.
      db.prepare("UPDATE task_work_episode_bindings SET work_head_sha = ? WHERE task_id = ?")
        .run("a".repeat(40), source.id);
    }
    if (episode === "historical") {
      db.prepare(`INSERT INTO historical_task_work_episode_bindings
        (task_id, episode_id, session_id, agent_session_id, branch, pr_url, pr_head_sha, merged_at, bound_at, updated_at, ended_at)
        SELECT task_id, episode_id, session_id, agent_session_id, branch, pr_url, pr_head_sha, merged_at, bound_at, updated_at, ?
        FROM task_work_episode_bindings WHERE task_id = ?`).run(before.completedAt, source.id);
      db.prepare("UPDATE tasks SET dependencies = ? WHERE id = ?")
        .run(JSON.stringify(dependent.dependencies.map(edge => ({ ...edge, branch: "feat/late-prerequisite" }))), dependent.id);
      db.prepare(`UPDATE session_work_episodes SET episode_id = episode_id || '-next', branch = 'main'
        WHERE session_id = (SELECT session_id FROM task_work_episode_bindings WHERE task_id = ?)`).run(source.id);
      db.prepare("UPDATE task_work_episode_bindings SET episode_id = episode_id || '-next', branch = 'main' WHERE task_id = ?")
        .run(source.id);
    }
  });
  await daemon.restart();
  await expect.poll(async () => (await read(dependent.id)).dependencies[0]!.satisfiedAt).not.toBeNull();
  expect((await read(dependent.id)).dependencies[0]!.prUrl).toBe(url);
  const after = await read(source.id);
  expect([after.outcome, after.outcomeUrl, after.completedAt]).toEqual([before.outcome, before.outcomeUrl, before.completedAt]);
  const healed = await editor(dashboard, daemon, dependent.title);
  await expect(healed.locator(".dep-chips")).toContainText("Late merged prerequisite (merged)");
  await expect(healed.getByRole("button", { name: "Dispatch now" })).toBeEnabled();
  await shoot(dashboard, `manual-complete-late-${episode}-merge`);
});
}

for (const retained of [true, false]) test("change pinned revision previews and atomically saves the exact replacement with retained origin: " + retained, async ({ dashboard, daemon }) => {
  const old = await savedPlan(daemon);
  const replacement = await savedPlan(daemon, false, "replacement-plan");
  await post(daemon, "/mcp/plans/save", {
    env: {}, sessionId: replacement.session.id, cwd: replacement.session.cwd, repoSlot: "repo-01",
    planId: replacement.input.planId, slug: "replacement-plan", requestId: randomUUID(), expectedRevision: 1,
    files: [{ name: "plan.md", content: "# Approved replacement" }, { name: "plan.html", content: "<h1>Approved replacement</h1>" },
      { name: "implementation.md", content: "# Implement the approved replacement" },
      { name: "implementation.html", content: "<h1>Implement the approved replacement</h1>" }],
  });
  replacement.input = { ...replacement.input, revision: 2, files: ["implementation.md"] };
  const optional = await create(daemon, "Implementation prerequisite");
  const task = await create(daemon, "Repin implementation", {
    planInputs: [old.input], dependencies: [{ type: "task", taskId: old.source.id },
      ...(retained ? [{ type: "task", taskId: replacement.source.id }] : []), { type: "task", taskId: optional.id }],
  });
  await daemon.crash();
  withDaemonDb(daemon, db => {
    db.prepare("UPDATE tasks SET dependencies = ? WHERE id = ?").run(JSON.stringify(task.dependencies.map(edge =>
      edge.type === "task" && edge.taskId === replacement.source.id ? { ...edge, satisfiedAt: 10 } : edge)), task.id);
    db.prepare("UPDATE tasks SET status = 'done', session_id = NULL WHERE id = ?").run(replacement.source.id);
    db.prepare("DELETE FROM sdk_sessions WHERE id = ?").run(replacement.session.id);
    db.prepare("UPDATE task_work_episode_bindings SET merged_at = 10, pr_url = ? WHERE task_id = ?").run("https://github.com/acme/demo-repo/pull/1568", replacement.source.id);
  });
  await daemon.restart();
  let dialog = await editor(dashboard, daemon, task.title);
  await expect(dialog.getByRole("button", { name: "Change pinned revision" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  const flag = await fetch(daemon.baseURL + "/api/feature-flags", { method: "PUT",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "flag", id: "pinned-plan-change", enabled: true }) });
  expect(flag.ok).toBe(true);
  dialog = await editor(dashboard, daemon, task.title);
  await expect(dialog.getByRole("button", { name: "Change pinned revision" })).toHaveAccessibleDescription("Choose an exact replacement plan revision and preview its prerequisites");
  await dialog.getByRole("button", { name: "Change pinned revision" }).click();
  await expect(dialog.getByRole("button", { name: "Preview revision change" })).toHaveAccessibleDescription("Validate the selected revision and show changes without saving");
  await expect(dialog.getByRole("button", { name: "Cancel revision change" })).toHaveAccessibleDescription("Discard the revision selection and keep the saved pin");
  await expect(dialog.getByLabel("Revision", { exact: true })).toHaveValue("");
  await dialog.getByLabel("Plan ID", { exact: true }).fill(replacement.input.planId);
  await dialog.getByLabel("Revision", { exact: true }).fill("999");
  await dialog.getByRole("button", { name: "Preview revision change" }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await dialog.getByLabel("Revision", { exact: true }).fill(String(replacement.input.revision));
  await dialog.getByLabel(/^Markdown files/).fill(" ,  " + replacement.input.files.join(" , , ") + " , ");
  await dialog.getByRole("button", { name: "Preview revision change" }).click();
  const preview = dialog.getByRole("region", { name: "Pinned revision preview" });
  const expectPreviewPins = async () => {
    const oldPin = preview.locator("p").filter({ hasText: /^Old:/ });
    const newPin = preview.locator("p").filter({ hasText: /^New:/ });
    await expect(oldPin).toHaveText("Old: " + old.input.planId + " revision 1 · plan.md");
    await expect(newPin).toHaveText("New: " + replacement.input.planId + " revision 2 · implementation.md");
    await expect(oldPin.getByRole("link")).toHaveAccessibleDescription("Open the currently pinned plan revision in a new tab");
    await expect(newPin.getByRole("link")).toHaveAccessibleDescription("Open the selected replacement revision in a new tab");
    await expect(oldPin.getByRole("link")).toHaveAttribute("href", "/?plan=" + old.input.planId + "&revision=1");
    await expect(newPin.getByRole("link")).toHaveAttribute("href", "/?plan=" + replacement.input.planId + "&revision=2");
  };
  await expectPreviewPins();
  await expect(preview).toContainText("Remove: Planning origin");
  await expect(preview).toContainText(retained ? "Replacement origin (merged/published)" : "Add: Replacement origin");
  await expect(preview).toContainText("Implementation prerequisite (waiting)");
  const read = async () => (await (await fetch(daemon.baseURL + "/api/tasks")).json() as Task[]).find(t => t.id === task.id)!;
  expect((await read()).planInputs).toEqual([old.input]);
  await expectContentClearsBorder(dialog);
  await shoot(dashboard, "revision-change-preview-" + retained);
  await dialog.getByRole("button", { name: "Cancel revision change" }).click();
  expect((await read()).planInputs).toEqual([old.input]);
  await dialog.getByRole("button", { name: "Change pinned revision" }).click();
  await dialog.getByRole("button", { name: "Preview revision change" }).click();
  await expect(preview).toBeVisible();
  await expectPreviewPins();
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  const saved = await read();
  expect(saved.planInputs).toEqual([replacement.input]);
  expect(saved.dependencies.map(edge => edge.type === "task" ? edge.taskId : "").sort()).toEqual([replacement.source.id, optional.id].sort());
  expect(saved.dependencies.find(edge => edge.type === "task" && edge.taskId === replacement.source.id)!.satisfiedAt).toBe(10);
  expect(saved.dependencies.find(edge => edge.type === "task" && edge.taskId === optional.id)).toEqual(task.dependencies.at(-1));
  dialog = await editor(dashboard, daemon, task.title);
  await expect(dialog.getByRole("link", { name: "replacement-plan revision 2" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Remove dependency: Replacement origin" })).toBeDisabled();
  await shoot(dashboard, "revision-change-saved-" + retained);
});

test("a completed replacement without merge proof explains the exact episode and leaves the saved task unchanged", async ({ dashboard, daemon }) => {
  const old = await savedPlan(daemon);
  const replacement = await savedPlan(daemon, false, "replacement-plan");
  const task = await create(daemon, "Keep the original pin", {
    planInputs: [old.input], dependencies: [{ type: "task", taskId: old.source.id }],
  });
  await daemon.crash();
  const episode = withDaemonDb(daemon, db => {
    db.prepare("UPDATE tasks SET status = 'done', session_id = NULL WHERE id = ?").run(replacement.source.id);
    db.prepare("DELETE FROM sdk_sessions WHERE id = ?").run(replacement.session.id);
    return db.prepare("SELECT episode_id, merged_at, pr_url FROM task_work_episode_bindings WHERE task_id = ?")
      .get(replacement.source.id) as { episode_id: string; merged_at: number | null; pr_url: string | null };
  });
  expect(episode.merged_at).toBeNull();
  expect(episode.pr_url).toBeNull();
  await daemon.restart();
  const flag = await fetch(daemon.baseURL + "/api/feature-flags", { method: "PUT",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "flag", id: "pinned-plan-change", enabled: true }) });
  expect(flag.ok).toBe(true);
  const dialog = await editor(dashboard, daemon, task.title);
  const read = async () => (await (await fetch(daemon.baseURL + "/api/tasks")).json() as Task[]).find(t => t.id === task.id)!;
  const before = await read();
  await dialog.getByRole("button", { name: "Change pinned revision" }).click();
  await dialog.getByLabel("Plan ID", { exact: true }).fill(replacement.input.planId);
  await dialog.getByLabel("Revision", { exact: true }).fill(String(replacement.input.revision));
  await dialog.getByRole("button", { name: "Preview revision change" }).click();
  await expect(dialog.getByRole("alert")).toHaveText(`Completed replacement origin "${replacement.source.title}" has no merge proof for work episode ${episode.episode_id}. Select a revision with verified merge proof.`);
  await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Waiting for dependencies" })).toBeDisabled();
  expect(await read()).toEqual(before);
  await dialog.getByRole("textbox", { name: /^Title/ }).focus();
  await expect(dashboard.getByRole("tooltip")).toHaveCount(0);
  await shoot(dashboard, "revision-change-missing-merge-proof");
});

test("a validated replacement enables dispatch using its merged dependencies without sending raw edits", async ({ dashboard, daemon }) => {
  const old = await savedPlan(daemon);
  const replacement = await savedPlan(daemon, false, "replacement-plan");
  const task = await create(daemon, "Dispatch the replacement plan", {
    planInputs: [old.input], dependencies: [{ type: "task", taskId: old.source.id }, { type: "task", taskId: replacement.source.id }],
  });
  await daemon.crash();
  withDaemonDb(daemon, db => {
    db.prepare("UPDATE tasks SET dependencies = ? WHERE id = ?").run(JSON.stringify(task.dependencies.map(edge =>
      edge.type === "task" && edge.taskId === replacement.source.id ? { ...edge, satisfiedAt: 10 } : edge)), task.id);
  });
  await daemon.restart();
  const flag = await fetch(daemon.baseURL + "/api/feature-flags", { method: "PUT",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "flag", id: "pinned-plan-change", enabled: true }) });
  expect(flag.ok).toBe(true);
  const dialog = await editor(dashboard, daemon, task.title);
  const read = async () => (await (await fetch(daemon.baseURL + "/api/tasks")).json() as Task[]).find(t => t.id === task.id)!;
  const before = await read();
  await expect(dialog.getByRole("button", { name: "Waiting for dependencies" })).toBeDisabled();
  await dialog.getByRole("button", { name: "Change pinned revision" }).click();
  await dialog.getByLabel("Plan ID", { exact: true }).fill(replacement.input.planId);
  await dialog.getByLabel("Revision", { exact: true }).fill(String(replacement.input.revision));
  await dialog.getByRole("button", { name: "Preview revision change" }).click();
  await expect(dialog.getByRole("region", { name: "Pinned revision preview" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Dispatch now" })).toBeEnabled();
  expect(await read()).toEqual(before);
  await dialog.getByRole("button", { name: "Cancel revision change" }).click();
  await expect(dialog.getByRole("button", { name: "Waiting for dependencies" })).toBeDisabled();
  await dialog.getByRole("button", { name: "Change pinned revision" }).click();
  await dialog.getByRole("button", { name: "Preview revision change" }).click();
  await expect(dialog.getByRole("button", { name: "Dispatch now" })).toBeEnabled();
  await dialog.getByRole("textbox", { name: /^Title/ }).focus();
  await expect(dashboard.getByRole("tooltip")).toHaveCount(0);
  await shoot(dashboard, "revision-change-ready-dispatch");
  let patch: Record<string, unknown> | undefined;
  let dispatched: Task | undefined;
  await dashboard.route(`**/api/tasks/${task.id}/update`, route => {
    patch = route.request().postDataJSON();
    return route.continue();
  });
  await dashboard.route(`**/api/tasks/${task.id}/dispatch`, async route => {
    dispatched = await read();
    await route.fulfill({ json: { ok: true } });
  });
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
  expect(patch).toHaveProperty("planInputChange");
  expect(patch).not.toHaveProperty("dependencies");
  expect(patch).not.toHaveProperty("planInputs");
  expect(dispatched!.planInputs).toEqual([replacement.input]);
  expect(dispatched!.dependencies).toEqual([before.dependencies[1]]);
});

async function revisionEditor(page: Page, daemon: DaemonHandle, episode: "same" | "later" | "merged" = "same", prerequisites: Task[] = []) {
  const origin = await savedPlan(daemon);
  const task = await create(daemon, "Review staged revision", {
    planInputs: [origin.input], dependencies: [{ type: "task", taskId: origin.source.id },
      ...prerequisites.map(prerequisite => ({ type: "task", taskId: prerequisite.id }))],
  });
  await post(daemon, "/mcp/plans/save", {
    env: {}, sessionId: origin.session.id, cwd: origin.session.cwd, repoSlot: "repo-01",
    planId: origin.input.planId, slug: "dependency-plan", requestId: randomUUID(), expectedRevision: 1,
    files: [{ name: "plan.md", content: "# Revised plan" }, { name: "plan.html", content: "<h1>Revised plan</h1>" }],
  });
  if (episode !== "same") {
    // The old pin belongs to a completed episode; revision two belongs to the source's
    // current, unmerged episode. The task ID deliberately stays the same across both.
    await daemon.crash();
    withDaemonDb(daemon, db => {
      if (episode === "later") db.prepare("UPDATE managed_plan_revisions SET episode_id = ? WHERE plan_id = ? AND revision = 1")
        .run("previous-episode", origin.input.planId);
      db.prepare("UPDATE tasks SET dependencies = ? WHERE id = ?").run(JSON.stringify(task.dependencies.map(edge => ({
        ...edge, ...(episode === "later" ? { episodeId: "previous-episode" } : {}),
        satisfiedAt: 10, prUrl: "https://github.com/acme/demo-repo/pull/1",
      }))), task.id);
    });
    await daemon.restart();
  }
  const flag = await fetch(daemon.baseURL + "/api/feature-flags", { method: "PUT",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "flag", id: "pinned-plan-change", enabled: true }) });
  expect(flag.ok).toBe(true);
  const dialog = await editor(page, daemon, task.title);
  await dialog.getByRole("button", { name: "Change pinned revision" }).click();
  await dialog.getByLabel("Revision", { exact: true }).fill("2");
  const read = async () => (await (await fetch(daemon.baseURL + "/api/tasks")).json() as Task[]).find(t => t.id === task.id)!;
  return { dialog, task, read };
}

test("revision preview shows replacement episodes and merge status for the same source task", async ({ dashboard, daemon }) => {
  const { dialog, task, read } = await revisionEditor(dashboard, daemon, "later");
  await dialog.getByRole("button", { name: "Preview revision change" }).click();
  const preview = dialog.getByRole("region", { name: "Pinned revision preview" });
  await expect(preview.locator("p").filter({ hasText: /^Remove:/ }))
    .toHaveText("Remove: Planning origin (episode previous-episode, merged/published)");
  await expect(preview.locator("p").filter({ hasText: /^Add:/ }))
    .toHaveText(`Add: Planning origin (episode ${task.dependencies[0]!.episodeId}, waiting)`);
  await expect(preview.locator("p").filter({ hasText: /^Retain:/ })).toHaveText("Retain: None");
  await expect(dialog.getByRole("button", { name: "Waiting for dependencies" })).toBeDisabled();
  await shoot(dashboard, "revision-change-preview-new-episode");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toBeHidden();
  const saved = await read();
  expect(saved.planInputs![0]!.revision).toBe(2);
  expect(saved.dependencies[0]!.episodeId).toBe(task.dependencies[0]!.episodeId);
  expect(saved.dependencies[0]!.satisfiedAt).toBeNull();
});

test("Revert discards a staged pin and its preview before a later Save", async ({ dashboard, daemon }) => {
  const { dialog, read } = await revisionEditor(dashboard, daemon);
  const before = await read();
  await dialog.getByRole("button", { name: "Preview revision change" }).click();
  await expect(dialog.getByRole("region", { name: "Pinned revision preview" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Revert" })).toBeEnabled();
  await dialog.getByRole("textbox", { name: /^Title/ }).fill("Also revert this title");
  await dialog.getByRole("button", { name: "Revert" }).click();
  await expect(dialog.getByRole("textbox", { name: /^Title/ })).toHaveValue(before.title);
  await expect(dialog.getByRole("region", { name: "Pinned revision preview" })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Revert" })).toBeDisabled();
  await dialog.getByRole("button", { name: "Change pinned revision" }).click();
  await expect(dialog.getByLabel("Revision", { exact: true })).toHaveValue("");
  await dialog.getByRole("button", { name: "Cancel revision change" }).click();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(await read()).toEqual(before);
});

test("typing during a successful pin save retains the new draft with the saved dependencies", async ({ dashboard, daemon }) => {
  const { dialog, task, read } = await revisionEditor(dashboard, daemon);
  const replacement = await savedPlan(daemon, false, "replacement-plan");
  await dialog.getByLabel("Plan ID", { exact: true }).fill(replacement.input.planId);
  await dialog.getByLabel("Revision", { exact: true }).fill("1");
  await dialog.getByRole("button", { name: "Preview revision change" }).click();
  await expect(dialog.getByRole("region", { name: "Pinned revision preview" })).toBeVisible();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const requested = new Promise<void>(resolve => { started = resolve; });
  const saves: Record<string, unknown>[] = [];
  await dashboard.route(`**/api/tasks/${task.id}/update`, async route => {
    const patch = route.request().postDataJSON();
    if (!patch.previewOnly) {
      saves.push(patch);
      if (saves.length === 1) { started(); await held; }
    }
    await route.continue();
  });
  try {
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await requested;
    await dialog.getByRole("textbox", { name: /^Title/ }).fill("Newer title typed during save");
    await dialog.getByPlaceholder("What should this agent do?").fill("Newer intent typed during save");
  } finally { release(); }
  await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
  await expect(dialog.getByRole("button", { name: "Change pinned revision" })).toBeEnabled();
  await expect(dialog.getByRole("textbox", { name: /^Title/ })).toHaveValue("Newer title typed during save");
  const savedPin = await read();
  expect(savedPin.planInputs).toEqual([replacement.input]);
  expect(savedPin.dependencies.map(edge => edge.type === "task" ? edge.taskId : null)).toEqual([replacement.source.id]);
  expect(savedPin.title).toBe(task.title);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(saves).toHaveLength(2);
  expect(saves[1]).not.toHaveProperty("dependencies");
  expect(saves[1]).not.toHaveProperty("planInputChange");
  const saved = await read();
  expect(saved.title).toBe("Newer title typed during save");
  expect(saved.intent).toBe("Newer intent typed during save");
  expect(saved.planInputs).toEqual(savedPin.planInputs);
  expect(saved.dependencies).toEqual(savedPin.dependencies);
});

test("collapsing backlog details preserves the selected revision, pending request, and staged preview", async ({ dashboard, daemon }) => {
  const { dialog, read } = await revisionEditor(dashboard, daemon, "merged");
  const before = await read();
  const fold = dialog.getByRole("button", { name: /^Backlog details/ });
  await fold.click();
  await expect(dialog.getByLabel("Revision", { exact: true })).toBeHidden();
  await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await fold.click();
  await expect(dialog.getByLabel("Revision", { exact: true })).toHaveValue("2");

  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const requested = new Promise<void>(resolve => { started = resolve; });
  await dashboard.route(`**/api/tasks/${before.id}/update`, async route => {
    if (route.request().postDataJSON().previewOnly) { started(); await held; }
    await route.continue();
  });
  try {
    await dialog.getByRole("button", { name: "Preview revision change" }).click();
    await requested;
    await fold.click();
    await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  } finally { release(); }
  await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
  await fold.click();
  const preview = dialog.getByRole("region", { name: "Pinned revision preview" });
  await expect(preview).toBeVisible();
  const previewText = await preview.innerText();
  await fold.click();
  await expect(preview).toBeHidden();
  await fold.click();
  await expect(dialog.getByLabel("Revision", { exact: true })).toHaveValue("2");
  await expect(preview).toBeVisible();
  expect(await preview.innerText()).toBe(previewText);
  expect(await read()).toEqual(before);
  await dialog.getByRole("textbox", { name: /^Title/ }).focus();
  await shoot(dashboard, "revision-change-preview-refolded");
  await dialog.getByRole("button", { name: "Cancel revision change" }).click();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(await read()).toEqual(before);
});

test("a stalled revision preview times out and releases Cancel without saving", async ({ dashboard, daemon }) => {
  const { dialog, read } = await revisionEditor(dashboard, daemon, "merged");
  const before = await read();
  await dashboard.route(`**/api/tasks/${before.id}/update`, route => {
    if (!route.request().postDataJSON().previewOnly) return route.continue();
    // No response: exercise the real browser deadline and fetch cancellation.
  });
  await dialog.getByRole("button", { name: "Preview revision change" }).click();
  await expect(dialog.getByRole("button", { name: "Cancel revision change" })).toBeDisabled();
  await expect(dialog.getByRole("alert")).toHaveText("Mission Control did not answer the preview within 15 seconds. Try again or cancel the revision change.", { timeout: 25_000 });
  await expect(dialog.getByRole("button", { name: "Cancel revision change" })).toBeEnabled();
  await expect(dialog.getByRole("button", { name: "Preview revision change" })).toBeEnabled();
  await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Dispatch now", exact: true })).toBeDisabled();
  expect(await read()).toEqual(before);
  await dialog.getByRole("textbox", { name: /^Title/ }).focus();
  await shoot(dashboard, "revision-change-timeout");
  await dialog.getByRole("button", { name: "Cancel revision change" }).click();
  await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
  await expect(dialog.getByRole("button", { name: "Dispatch now", exact: true })).toBeEnabled();
  expect(await read()).toEqual(before);
});

test("an unpreviewed revision blocks Save and dispatch until previewed or cancelled", async ({ dashboard, daemon }) => {
  const { dialog, read } = await revisionEditor(dashboard, daemon, "merged");
  const before = await read();
  let writes = 0;
  dashboard.on("request", request => {
    if (request.method() !== "POST") return;
    const path = new URL(request.url()).pathname;
    if (path === `/api/tasks/${before.id}/dispatch`
      || (path === `/api/tasks/${before.id}/update` && !request.postDataJSON().previewOnly)) writes++;
  });
  const save = dialog.getByRole("button", { name: "Save", exact: true });
  const launch = dialog.getByRole("button", { name: "Dispatch now", exact: true });
  await expect(save).toBeDisabled();
  await expect(launch).toBeDisabled();
  await expect(save).toHaveAccessibleDescription("Preview or cancel the revision change before saving or dispatching");
  await shoot(dashboard, "revision-change-awaiting-preview");
  await dashboard.keyboard.press("ControlOrMeta+Enter");
  await expect(dialog).toBeVisible();
  expect(writes).toBe(0);
  expect(await read()).toEqual(before);
  await dialog.getByRole("button", { name: "Preview revision change" }).click();
  await expect(dialog.getByRole("region", { name: "Pinned revision preview" })).toBeVisible();
  await expect(save).toBeEnabled();
  await expect(launch).toBeEnabled();
  await dialog.getByLabel("Revision", { exact: true }).fill("999");
  await expect(save).toBeDisabled();
  await expect(launch).toBeDisabled();
  await dialog.getByRole("button", { name: "Preview revision change" }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(save).toBeDisabled();
  await dialog.getByRole("button", { name: "Cancel revision change" }).click();
  await expect(save).toBeEnabled();
  await expect(launch).toBeEnabled();
  await save.click();
  await expect(dialog).toBeHidden();
  expect(writes).toBe(0);
  expect(await read()).toEqual(before);
});

test("a failed preview request shows the connection error and keeps Save and dispatch blocked", async ({ dashboard, daemon }) => {
  const { dialog, read } = await revisionEditor(dashboard, daemon, "merged");
  const before = await read();
  let rejectedPreviews = 0;
  await dashboard.route(`**/api/tasks/${before.id}/update`, route => {
    if (route.request().postDataJSON().previewOnly) {
      rejectedPreviews++;
      return route.abort("failed");
    }
    return route.continue();
  });

  const preview = dialog.getByRole("button", { name: "Preview revision change" });
  await preview.click();
  await expect(dialog.getByRole("alert")).toHaveText("Could not reach Mission Control");
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(preview).toBeEnabled();
  await expect(dialog.getByRole("region", { name: "Pinned revision preview" })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Dispatch now", exact: true })).toBeDisabled();
  expect(rejectedPreviews).toBe(1);
  expect(await read()).toEqual(before);
  await shoot(dashboard, "revision-change-unreachable");
});

for (const failure of [
  { status: 500, contentType: "text/html", body: "<html><body>Internal server error</body></html>" },
  { status: 502, contentType: "text/plain", body: "" },
]) test(`a non-JSON HTTP ${failure.status} preview error keeps Save and dispatch blocked`, async ({ dashboard, daemon }) => {
  const { dialog, read } = await revisionEditor(dashboard, daemon, "merged");
  const before = await read();
  await dashboard.route(`**/api/tasks/${before.id}/update`, route => {
    if (route.request().postDataJSON().previewOnly) return route.fulfill(failure);
    return route.continue();
  });

  const preview = dialog.getByRole("button", { name: "Preview revision change" });
  await preview.click();
  await expect(dialog.getByRole("alert")).toHaveText(`HTTP ${failure.status}`);
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(preview).toBeEnabled();
  await expect(dialog.getByRole("region", { name: "Pinned revision preview" })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Dispatch now", exact: true })).toBeDisabled();
  expect(await read()).toEqual(before);
  await shoot(dashboard, `revision-change-http-${failure.status}`);
});

test("Save and dependency edits wait for revision editing and its pending preview, including keyboard submission", async ({ dashboard, daemon }) => {
  const prerequisite = await create(daemon, "Retained prerequisite");
  const candidate = await create(daemon, "Another prerequisite");
  const { dialog, read } = await revisionEditor(dashboard, daemon, "same", [prerequisite]);
  const before = await read();
  const add = dialog.getByRole("combobox", { name: "Add dependency" });
  const remove = dialog.getByRole("button", { name: /^Remove dependency: Retained prerequisite/ });
  const mode = dialog.getByRole("group", { name: /^When to start after Retained prerequisite/ });
  await expect(add).toBeDisabled();
  await expect(remove).toBeDisabled();
  await expect(remove).toHaveAccessibleDescription("Cancel the revision change before editing dependencies.");
  await expect(mode.getByRole("button", { name: "Stack", exact: true })).toBeDisabled();
  await expect(mode.getByRole("button", { name: "After merge", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Preview revision change" })).toBeEnabled();
  await add.evaluate((select: HTMLSelectElement, id) => {
    select.value = `task:${id}`;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }, candidate.id);
  await expect(dialog.getByRole("button", { name: /^Remove dependency: Another prerequisite/ })).toHaveCount(0);
  expect(await read()).toEqual(before);
  await shoot(dashboard, "revision-change-editing-guard");
  await dialog.getByRole("button", { name: "Cancel revision change" }).click();
  await expect(add).toBeEnabled();
  await expect(remove).toBeEnabled();
  await expect(mode.getByRole("button", { name: "Stack", exact: true })).toBeEnabled();
  await expect(mode.getByRole("button", { name: "After merge", exact: true })).toBeEnabled();
  await dialog.getByRole("button", { name: "Change pinned revision" }).click();
  await expect(add).toBeDisabled();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const requested = new Promise<void>(resolve => { started = resolve; });
  let saves = 0;
  await dashboard.route(`**/api/tasks/${before.id}/update`, async route => {
    if (route.request().postDataJSON().previewOnly) { started(); await held; }
    else saves++;
    await route.continue();
  });
  try {
    await dialog.getByRole("button", { name: "Preview revision change" }).click();
    await requested;
    await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    await expect(add).toBeDisabled();
    await expect(remove).toBeDisabled();
    await expect(mode.getByRole("button", { name: "Stack", exact: true })).toBeDisabled();
    await expect(mode.getByRole("button", { name: "After merge", exact: true })).toBeDisabled();
    await dialog.getByRole("textbox", { name: /^Title/ }).fill("Title edited during preview");
    await dialog.getByPlaceholder("What should this agent do?").fill("Intent edited during preview");
    await expect(dialog.getByRole("button", { name: "Revert" })).toBeDisabled();
    await dialog.getByRole("button", { name: "Revert" }).evaluate((button: HTMLButtonElement) => button.click());
    await expect(dialog.getByRole("textbox", { name: /^Title/ })).toHaveValue("Title edited during preview");
    // A queued change event must also be refused by the handler, not just the DOM guard.
    await add.evaluate((select: HTMLSelectElement, id) => {
      select.value = `task:${id}`;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }, candidate.id);
    await expect(dialog.getByRole("button", { name: /^Remove dependency: Another prerequisite/ })).toHaveCount(0);
    await dashboard.keyboard.press("ControlOrMeta+Enter");
    await expect(dialog).toBeVisible();
    expect(saves).toBe(0);
    expect(await read()).toEqual(before);
  } finally { release(); }
  await expect(dialog.getByRole("region", { name: "Pinned revision preview" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Revert" })).toBeEnabled();
  await expect(dialog.getByRole("textbox", { name: /^Title/ })).toHaveValue("Title edited during preview");
  await expect(dialog.getByPlaceholder("What should this agent do?")).toHaveValue("Intent edited during preview");
  await expect(add).toBeDisabled();
  await dialog.getByRole("button", { name: "Cancel revision change" }).click();
  await expect(add).toBeEnabled();
  await expect(remove).toBeEnabled();
  await expect(mode.getByRole("button", { name: "Stack", exact: true })).toBeEnabled();
  await dialog.getByRole("button", { name: "Change pinned revision" }).click();
  await dialog.getByRole("button", { name: "Preview revision change" }).click();
  await expect(dialog.getByRole("region", { name: "Pinned revision preview" })).toBeVisible();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(saves).toBe(1);
  const saved = await read();
  expect(saved.planInputs![0]!.revision).toBe(2);
  expect(saved.dependencies).toEqual(before.dependencies);
  expect(saved.title).toBe("Title edited during preview");
  expect(saved.intent).toBe("Intent edited during preview");
});

test("revision preview keeps its returned snapshots when a retained prerequisite is satisfied live", async ({ dashboard, daemon }) => {
  const prerequisite = await create(daemon, "Retained prerequisite");
  const { dialog, read } = await revisionEditor(dashboard, daemon, "same", [prerequisite]);
  await dialog.getByRole("button", { name: "Preview revision change" }).click();
  const preview = dialog.getByRole("region", { name: "Pinned revision preview" });
  await expect(preview).toBeVisible();
  const beforeText = await preview.innerText();
  await expect(preview).toContainText("Retained prerequisite (waiting)");
  // Exercise a real task_upsert while the preview stays open. The explicit fixture
  // completion satisfies the edge through the same durable state used for a merge.
  await post(daemon, `/api/tasks/${prerequisite.id}/complete`, { outcome: "Prerequisite landed", satisfyDependents: true });
  await expect(dialog.locator(".dep-chips")).toContainText("Retained prerequisite (merged)");
  expect((await read()).dependencies.find(edge => edge.type === "task" && edge.taskId === prerequisite.id)!.satisfiedAt).not.toBeNull();
  expect(await preview.innerText()).toBe(beforeText);
  await expect(preview.locator("p").filter({ hasText: /^Remove:/ })).toHaveText("Remove: None");
  await expect(preview.locator("p").filter({ hasText: /^Add:/ })).toHaveText("Add: None");
  await shoot(dashboard, "revision-change-live-snapshot");
  // The unchanged preview is a snapshot, not permission to overwrite the live update.
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toContainText("Task changed; reopen the editor and preview again");
  expect((await read()).planInputs![0]!.revision).toBe(1);
});

test("a staged pin survives a rejected save and is consumed before retrying a rejected dispatch", async ({ dashboard, daemon }) => {
  const replacement = await savedPlan(daemon, false, "replacement-plan");
  const { dialog, read } = await revisionEditor(dashboard, daemon, "merged", [replacement.source]);
  const before = await read();
  await dialog.getByLabel("Plan ID", { exact: true }).fill(replacement.input.planId);
  await dialog.getByLabel("Revision", { exact: true }).fill(String(replacement.input.revision));
  await dialog.getByRole("textbox", { name: /^Title/ }).fill("Keep this title through launch retry");
  await dialog.getByRole("button", { name: "Preview revision change" }).click();
  await expect(dialog.getByRole("region", { name: "Pinned revision preview" })).toBeVisible();
  let saves = 0;
  await dashboard.route(`**/api/tasks/${before.id}/update`, route => {
    saves++;
    return saves === 1 ? route.fulfill({ status: 409, json: { error: "Save refused for retry test" } }) : route.continue();
  });
  let launches = 0;
  await dashboard.route(`**/api/tasks/${before.id}/dispatch`, route => {
    launches++;
    return route.fulfill(launches === 1
      ? { status: 409, json: { error: "Launch refused for retry test" } }
      : { json: { ok: true } });
  });
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toContainText("Could not save task; dispatch was not attempted");
  expect(launches).toBe(0);
  expect(await read()).toEqual(before);
  await expect(dialog.getByRole("region", { name: "Pinned revision preview" })).toBeVisible();
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toContainText("saved, but Launch refused for retry test");
  const saved = await read();
  expect(saved.planInputs).toEqual([replacement.input]);
  expect(saved.dependencies).toEqual([before.dependencies[1]]);
  await expect(dialog.getByRole("region", { name: "Pinned revision preview" })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: /^Remove dependency: Planning origin/ })).toHaveCount(0);
  await expect(dialog.getByRole("textbox", { name: /^Title/ })).toHaveValue("Keep this title through launch retry");
  await shoot(dashboard, "revision-change-launch-retry");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
  expect(saves).toBe(2);
  expect(launches).toBe(2);
  expect((await read()).dependencies).toEqual(saved.dependencies);
});
