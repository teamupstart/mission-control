import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "../fixtures/test.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { settled } from "../fixtures/settle.ts";
import type { Session, Task } from "../../src/shared/types.ts";

// The fake otherwise mints its conversation id from its pid, which changes on restart.
test.use({ daemonEnv: { MC_E2E_CODEX_THREAD_ID: "01999999-7777-7000-8000-000000000001" } });

for (const agent of ["claude", "codex"] as const) {
  test(`a ${agent} resident without a repository survives restart and removes its workspace on Complete & close`, async ({ dashboard: page, daemon }) => {
    const evidence = artifactsDir(process.env.MC_E2E_RESIDENT_EVIDENCE_TOPIC ?? "residents-no-repo");
    if (process.env.MC_E2E_EVIDENCE) mkdirSync(evidence, { recursive: true });
    const read = async <T,>(path: string): Promise<T> => {
      const response = await fetch(`${daemon.baseURL}${path}`);
      expect(response.ok).toBeTruthy();
      return response.json() as Promise<T>;
    };
    const configured = await fetch(`${daemon.baseURL}/api/ui/config`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ groupBoardByRepo: true }) });
    expect(configured.ok).toBeTruthy();
    await page.goto(`${daemon.baseURL}/#/residents`);
    await page.getByRole("complementary", { name: "Resident profiles" }).getByRole("button", { name: "New" }).click();
    const name = `Repository-free ${agent}`;
    const editor = page.getByRole("region", { name: "New resident profile" });
    await editor.getByLabel("Name").fill(name);
    await editor.getByRole("combobox", { name: "Persona" }).selectOption({ label: "Code Risk Reviewer · built-in" });
    await editor.getByRole("combobox", { name: "Harness" }).selectOption(agent);
    // Exercise clearing an existing default in both the editor and Dispatch.
    await editor.getByLabel("Default repository").fill(daemon.repo);
    await page.keyboard.press("Escape");
    await editor.getByRole("button", { name: "No repository" }).click();
    await expect(editor.getByLabel("Default repository")).toHaveValue("");
    await editor.getByRole("button", { name: "No repository" }).hover();
    await expect(page.locator(".tooltip")).toHaveText("Clear the default repository for this resident profile");
    if (process.env.MC_E2E_EVIDENCE) await page.screenshot({ path: join(evidence, `${agent}-editor-tooltip.png`) });
    await editor.getByRole("button", { name: "Save" }).click();
    const saved = page.getByRole("region", { name: `Resident profile ${name}` });
    await saved.getByRole("button", { name: "Launch" }).click();
    const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
    await dialog.getByLabel("Repository").fill(daemon.repo);
    await page.keyboard.press("Escape");
    await dialog.getByRole("button", { name: "No repository" }).click();
    await expect(dialog.getByLabel("Repository")).toHaveValue("");
    await dialog.getByRole("button", { name: "No repository" }).hover();
    await expect(page.locator(".tooltip")).toHaveText("Launch in a private working directory without a repository");
    if (process.env.MC_E2E_EVIDENCE) await page.screenshot({ path: join(evidence, `${agent}-dispatch-tooltip.png`) });
    await expectContentClearsBorder(dialog);
    if (process.env.MC_E2E_EVIDENCE) {
      mkdirSync(evidence, { recursive: true });
      await dialog.screenshot({ path: join(evidence, `${agent}-dispatch.png`) });
    }
    await dialog.getByRole("button", { name: "Launch resident" }).click();
    await expect(dialog).toBeHidden({ timeout: 60_000 });
    const task = (await read<Task[]>("/api/tasks")).find((candidate) => candidate.kind === "resident")!;
    expect(task).toMatchObject({ status: "running", workspaceKind: "resident-workspace", worktreePath: null, branch: null, provider: null });
    expect(task.repoRoot).toContain("/residents/runs/");
    expect(existsSync(task.repoRoot)).toBeTruthy();
    const sentinel = join(task.repoRoot, "notes.txt");
    writeFileSync(sentinel, "Retain this while the run is alive.");
    const session = (await read<Session[]>("/api/sessions")).find((candidate) => candidate.id === task.sessionId)!;
    expect(session).toMatchObject({ cwd: task.repoRoot, repoRoot: null, gitRoot: null, gitBranch: null });
    const diff = await read<{ ok: boolean; patch: string }>(`/api/sessions/${session.id}/diff`);
    expect(diff).toMatchObject({ ok: false, patch: "" });
    const files = await read<{ files: Array<{ path: string }> }>(`/api/sessions/${session.id}/files`);
    expect(files.files).toContainEqual({ path: "notes.txt" });

    // A restart resumes a bound conversation. Launch acceptance precedes the driver's
    // binding event; crashing before it would correctly take the unresumable exit path.
    await expect.poll(async () => (await read<Session[]>("/api/sessions")).find((candidate) => candidate.id === session.id)?.agentSessionId).toBeTruthy();
    await daemon.crash();
    await daemon.restart();
    await expect.poll(async () => (await read<Session[]>("/api/sessions")).some((candidate) => candidate.id === session.id)).toBeTruthy();
    expect(existsSync(sentinel)).toBeTruthy();
    const restored = (await read<Session[]>("/api/sessions")).find((candidate) => candidate.id === session.id)!;
    expect(restored).toMatchObject({ cwd: task.repoRoot, repoRoot: null, gitRoot: null });
    await page.goto(`${daemon.baseURL}/#/fleet`);
    await page.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
    const card = page.locator(".console-detail");
    await expect(card.locator(".detail-sub")).toContainText("no repository");
    await expect(card.getByRole("tab", { name: "Diff" })).toHaveCount(0);
    await expect(card.getByRole("button", { name: /reset/i })).toHaveCount(0);
    await expect(page.locator(".rail-repo-group, .board-repo-head")).toHaveCount(0);
    await card.getByRole("tab", { name: "Files", exact: true }).click();
    await expect(card.getByRole("option", { name: "notes.txt", exact: true })).toBeVisible();
    await expect(card.getByRole("region", { name: "Managed plans" })).toHaveCount(0);
    await card.getByRole("tab", { name: "Conversation", exact: true }).click();
    if (process.env.MC_E2E_EVIDENCE) await card.screenshot({ path: join(evidence, `${agent}-running.png`) });
    const boardConfig = await fetch(`${daemon.baseURL}/api/ui/config`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ layout: "board" }) });
    expect(boardConfig.ok).toBeTruthy();
    await page.reload();
    await expect(page.locator(".tile .tile-branch")).toContainText("no repository");
    await expect(page.locator(".board-repo-head")).toHaveCount(0);
    if (process.env.MC_E2E_EVIDENCE) await page.screenshot({ path: join(evidence, `${agent}-board.png`) });
    const consoleConfig = await fetch(`${daemon.baseURL}/api/ui/config`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ layout: "console" }) });
    expect(consoleConfig.ok).toBeTruthy();
    await page.reload();
    await page.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
    const complete = card.getByRole("button", { name: "Complete" });
    await expect(complete).toBeVisible();
    await settled(complete);
    await complete.click();
    const closing = page.getByRole("dialog", { name: "Complete task and close session" });
    await expectContentClearsBorder(closing);
    await closing.getByRole("button", { name: "Complete & close" }).click();
    await expect(closing).toBeHidden();
    await expect.poll(async () => (await read<Task[]>("/api/tasks")).find((candidate) => candidate.id === task.id)?.status).toBe("done");
    await expect.poll(() => existsSync(task.repoRoot), { timeout: 30_000 }).toBeFalsy();
  });
}

for (const layout of ["console", "board"] as const) {
  test(`a pending repo-less resident describes its directory in the ${layout} placeholder`, async ({ dashboard: page, daemon }) => {
    const { mkTask } = await import("../../test/helpers/session-fixture.ts");
    const configured = await fetch(`${daemon.baseURL}/api/ui/config`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ layout }) });
    expect(configured.ok).toBeTruthy();
    const stream = await fetch(`${daemon.baseURL}/events`);
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    try {
      while (!text.includes("\n\n")) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error("SSE closed before its snapshot");
        text += decoder.decode(chunk.value, { stream: true });
      }
    } finally { await reader.cancel(); }
    const snapshot = JSON.parse(text.split("\n").find((line) => line.startsWith("data: "))!.slice(6));
    // Hold the brief pre-session projection while the browser inspects it. Launch and
    // cleanup run through the real daemon in the tests above; this case asserts its copy.
    const task = mkTask({ id: "pending-resident", title: "Starting resident", kind: "resident", workspaceKind: "resident-workspace", status: "dispatching", sessionId: null, worktreePath: null, branch: null, dispatchedAt: null });
    await page.route("**/events", (route) => route.fulfill({ contentType: "text/event-stream", body: `data: ${JSON.stringify({ ...snapshot, tasks: [task], sessions: [] })}\n\n` }));
    await page.reload();
    const row = page.getByRole("list", { name: "Starting" }).getByRole("listitem").filter({ hasText: "Starting resident" });
    await expect(row).toContainText("Preparing its working directory");
    await expect(row).toContainText("no repository");
    await expect(row).not.toContainText("Provisioning its worktree");
  });
}
