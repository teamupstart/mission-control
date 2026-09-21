import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Session, Task } from "../../src/shared/types.ts";
import type { TerminalBoundaryState } from "../fixtures/terminal-boundary.ts";
import { test, expect } from "../fixtures/test.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";

// Compile the production daemon with scripted terminal/OS I/O only. Dispatch,
// correlation, Registry, persistence, routes and SSE remain the real implementation.
test.use({ daemonEnv: {
  MC_E2E_TERMINAL_BOUNDARY: "1", MISSION_POLL_MS: "100",
  MISSION_DISPATCH_HOOK_READY_MS: "50", MISSION_DISPATCH_SETTLE_MS: "0",
} });

test("a Ghostty dispatch keeps its task name through tab rewrites and daemon restart", async ({ dashboard, daemon }) => {
  await dashboard.goto(`${daemon.baseURL}/#/settings`);
  await dashboard.getByRole("tab", { name: /Harnesses/ }).click();
  await dashboard.getByRole("combobox", {
    name: "Session runtime for dispatched Claude Code sessions",
  }).selectOption("terminal");
  await dashboard.getByRole("button", { name: /Terminal preference for Claude Code/ }).click();
  await dashboard.getByRole("menu", { name: "Choose a terminal for dispatched Claude Code sessions" })
    .getByRole("menuitemradio", { name: /Ghostty/ }).click();
  await dashboard.goto(`${daemon.baseURL}/#/fleet`);

  await dashboard.getByRole("button", { name: "Dispatch" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await expectContentClearsBorder(dialog);
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await dashboard.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill("fix the ghostty parser");
  await dialog.getByLabel("Kind").selectOption("ship");
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  const created = dashboard.waitForResponse((response) =>
    response.url().endsWith("/api/tasks") && response.request().method() === "POST",
  );
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  const response = await created;
  expect(response.ok()).toBe(true);
  const task = await response.json() as Task;
  await expect(dialog).toBeHidden();
  const getTask = async (): Promise<Task | undefined> =>
    ((await (await fetch(`${daemon.baseURL}/api/tasks`)).json()) as Task[]).find((row) => row.id === task.id);
  await expect.poll(async () => (await getTask())?.status, { timeout: 30_000 }).toBe("running");
  const running = (await getTask())!;
  expect(running.sessionId).toBeTruthy();
  expect(running.homeBackend).toBe("ghostty");
  expect(running.terminalResourceId).toBe("emulator:ghostty:fixture-surface");
  expect(running.terminalLaunch).toEqual({ resourceId: running.terminalResourceId, sessionId: running.sessionId });

  const statePath = join(daemon.home, "terminal-boundary.json");
  const terminal = JSON.parse(readFileSync(statePath, "utf8")) as TerminalBoundaryState;
  expect(terminal.requestedTitle).toBe(running.homeName);
  expect(terminal.tabTitle).not.toBe(running.title);
  expect(terminal.cwd).toBe(running.worktreePath);
  const input = join(daemon.home, "terminal-input.txt");
  await expect.poll(() => existsSync(input) && readFileSync(input, "utf8").includes(task.intent)).toBe(true);

  const row = dashboard.getByRole("navigation", { name: "Sessions" })
    .locator("button.rail-row", { hasText: running.title });
  // This assertion fails if dispatch/Registry naming falls back to the terminal's title.
  await expect(row).toBeVisible();
  await row.click();
  const heading = dashboard.locator(".detail-title-line > h2");
  await expect(heading).toHaveText(running.title);
  await expect(heading.getByRole("button")).toHaveCount(0);
  await heading.click();
  await expect(dashboard.getByLabel("Rename session")).toHaveCount(0);

  const rewritten = "agent replaced the terminal title";
  writeFileSync(`${statePath}.tmp`, JSON.stringify({ ...terminal, tabTitle: rewritten }));
  renameSync(`${statePath}.tmp`, statePath);
  const getSession = async (): Promise<Session | undefined> =>
    ((await (await fetch(`${daemon.baseURL}/api/sessions`)).json()) as Session[])
      .find((session) => session.id === running.sessionId);
  await expect.poll(async () => (await getSession())?.terminals.find((handle) => handle.kind === "emulator")?.paneId)
    .toBe("fixture-surface");
  expect((await getSession())?.name).toBe(running.title);
  await expect(heading).toHaveText(running.title);

  // A failed inventory while the process survives must retain its exact launch address,
  // task state and worktree through a daemon restart.
  writeFileSync(`${statePath}.tmp`, JSON.stringify({ ...terminal, tabTitle: rewritten, inventory: "unavailable" }));
  renameSync(`${statePath}.tmp`, statePath);
  await daemon.crash();
  await daemon.restart();
  await dashboard.reload();
  await expect.poll(async () => (await getTask())?.status).toBe("running");
  await expect(row).toBeVisible();
  await row.click();
  await expect(heading).toHaveText(running.title);
  await expect(heading.getByRole("button")).toHaveCount(0);
  expect((await getTask())?.worktreePath).toBe(running.worktreePath);
  expect((await getTask())?.terminalResourceId).toBe(running.terminalResourceId);
  const nonce = "retained-target-after-inventory-failure";
  const sent = await fetch(`${daemon.baseURL}/api/sessions/${encodeURIComponent(running.sessionId!)}/send`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: nonce, submit: false, origin: "human" }),
  });
  expect(sent.ok).toBe(true);
  await expect.poll(() => readFileSync(input, "utf8").includes(nonce)).toBe(true);

  if (process.env.MC_E2E_EVIDENCE) {
    mkdirSync("e2e/.artifacts/terminal-session-name", { recursive: true });
    await dashboard.mouse.move(0, 0);
    await dashboard.screenshot({ path: "e2e/.artifacts/terminal-session-name/ghostty-dispatch-console.png" });
  }

  const layout = await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ layout: "board" }),
  });
  expect(layout.ok).toBe(true);
  await dashboard.reload();
  await expect(dashboard.locator("main.board")).toBeVisible();
  const tile = dashboard.locator("main.board .tile").filter({ hasText: running.title });
  await expect(tile.locator(".tile-name")).toHaveText(running.title);
  if (process.env.MC_E2E_EVIDENCE) {
    mkdirSync("e2e/.artifacts/terminal-session-name", { recursive: true });
    await dashboard.mouse.move(0, 0);
    await dashboard.screenshot({ path: "e2e/.artifacts/terminal-session-name/ghostty-dispatch.png" });
  }
});

test("an external Ghostty session sharing a pane cwd has no writable destination", async ({ dashboard, daemon }) => {
  writeFileSync(join(daemon.home, "terminal-boundary.json"), JSON.stringify({
    cwd: daemon.repo, requestedTitle: "", tabTitle: "an unrelated shell at the same cwd",
    argv: ["/bin/sh", "/unrelated-wrapper"], startedAt: Date.now(),
  } satisfies TerminalBoundaryState));
  await dashboard.goto(`${daemon.baseURL}/#/fleet`);
  const row = dashboard.getByRole("navigation", { name: "Sessions" })
    .locator("button.rail-row", { hasText: "claude 900002" });
  await expect(row).toBeVisible();
  await row.click();
  await expect(dashboard.getByPlaceholder("No pane to send to")).toBeDisabled();
  expect(existsSync(join(daemon.home, "terminal-input.txt"))).toBe(false);
  if (process.env.MC_E2E_EVIDENCE) {
    mkdirSync("e2e/.artifacts/terminal-session-name", { recursive: true });
    await dashboard.screenshot({ path: "e2e/.artifacts/terminal-session-name/ghostty-unverified.png" });
  }
});

test("continuing an SDK task in Ghostty retains the returned launch target", async ({ dashboard, daemon }) => {
  const response = await fetch(`${daemon.baseURL}/api/tasks`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ repoRoot: daemon.repo, title: "Continue in Ghostty", intent: "Wait for another instruction",
      agent: "claude", kind: "ship", workflowId: null }),
  });
  expect(response.ok).toBe(true);
  const filed = await response.json() as Task;
  const getTask = async () => ((await (await fetch(`${daemon.baseURL}/api/tasks`)).json()) as Task[])
    .find((task) => task.id === filed.id)!;
  await expect.poll(async () => (await getTask()).status).toBe("running");
  const embedded = (await getTask()).sessionId!;
  await dashboard.goto(`${daemon.baseURL}/#/fleet`);
  await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  const chooser = dashboard.locator(".conv-launch").getByRole("button", { name: /Claude Code/ });
  await expect(chooser).toBeEnabled();
  await chooser.click();
  const handoff = dashboard.waitForResponse((r) => r.url().endsWith(`/api/sessions/${encodeURIComponent(embedded)}/launch`));
  await dashboard.getByRole("menuitem", { name: /Ghostty/ }).click();
  expect((await handoff).ok()).toBe(true);
  await expect.poll(async () => (await getTask()).terminalLaunch?.resourceId)
    .toBe("emulator:ghostty:fixture-surface");
  const continued = await getTask();
  expect(continued.sessionId).not.toBe(embedded);
  expect(continued.terminalLaunch?.sessionId).toBe(continued.sessionId);
  await dashboard.getByRole("navigation", { name: "Sessions" })
    .getByRole("button", { name: /^Continue in Ghostty running/ }).click();
  await expect(dashboard.getByPlaceholder("No pane to send to")).toHaveCount(0);
  const nonce = "handoff-to-exact-ghostty-uuid";
  // This fake has no readiness hooks, so the Chat composer correctly queues new turns.
  // Exercise the terminal write route directly, as in the native UUID acknowledgement probe.
  const sent = await fetch(`${daemon.baseURL}/api/sessions/${encodeURIComponent(continued.sessionId!)}/send`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: nonce, submit: false, origin: "human" }),
  });
  expect(sent.ok).toBe(true);
  const input = join(daemon.home, "terminal-input.txt");
  await expect.poll(() => existsSync(input) && readFileSync(input, "utf8").includes(nonce)).toBe(true);
  if (process.env.MC_E2E_EVIDENCE) {
    mkdirSync("e2e/.artifacts/terminal-session-name", { recursive: true });
    await dashboard.mouse.move(0, 0);
    await dashboard.screenshot({ path: "e2e/.artifacts/terminal-session-name/ghostty-handoff.png" });
  }
});
