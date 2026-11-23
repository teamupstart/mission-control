import { mkdirSync } from "node:fs";
import { test, expect } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import { ForemanHealthTracker } from "../../src/server/foreman/health.ts";
import type { BacklogPlan } from "../../src/shared/types.ts";

test("Foreman groups repeated model errors in its warning popover and reports recovery", async ({ dashboard, daemon }) => {
  const post = async (path: string, body: unknown, method: "POST" | "PUT" = "POST") => {
    const response = await fetch(`${daemon.baseURL}${path}`, {
      method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    expect(response.ok, `${path}: ${await response.text()}`).toBeTruthy();
  };
  await post("/api/foreman/config", { enabled: true, mode: "live", autoBacklog: false }, "PUT");
  await post("/api/foreman/heartbeat", { workerId: "e2e-errors" });
  const tracker = new ForemanHealthTracker();
  const context = { operation: "review" as const, runner: "codex" as const, model: "gpt-5.6-terra" };
  const error = "Usage limit reached for this account. Check your plan and usage limits.";
  for (let i = 0; i < 128; i++) {
    tracker.failure({ ...context, session: { id: `s-${i % 6}`, name: `Review session ${i % 6 + 1}` } }, error);
  }
  const publish = () => post("/api/foreman/health", { workerId: "e2e-errors", health: tracker.snapshot() });
  await publish();
  const button = dashboard.getByRole("button", { name: /Foreman - the auto-responder/ });
  await expect(button).toContainText("1 issue", { timeout: 15_000 });
  await expect(button.getByText("1 issue", { exact: true })).toBeVisible();
  await expect(button).not.toContainText("128");
  await button.click();
  const popover = dashboard.getByRole("dialog", { name: "Foreman settings" });
  const errors = popover.getByRole("region", { name: "Foreman errors" });
  await expect(errors).toContainText(error);
  await expect(errors).toContainText("128 occurrences");
  await expect(errors).toContainText("6 sessions");
  await expect(errors).toContainText("codex");
  await expect(errors).toContainText("gpt-5.6-terra");
  await expect(errors).toContainText("Worker running");
  await expectContentClearsBorder(popover);
  await expect(errors.getByRole("button", { name: "Copy error" }))
    .toHaveAccessibleDescription("Copy this error and its provider and model to the clipboard");
  await expect(errors.getByRole("button", { name: "Open model settings" }))
    .toHaveAccessibleDescription("Choose the provider and model for each Foreman activity");
  await expect(errors.getByText("Show affected sessions", { exact: true }))
    .toHaveAccessibleDescription("Expand or collapse the sessions where this error was seen");
  await errors.getByText(/^First seen /).hover();
  await expect(dashboard.locator(".tooltip")).toContainText("First seen at ");
  if (process.env.MC_E2E_EVIDENCE) {
    const dir = artifactsDir("foreman-errors");
    mkdirSync(dir, { recursive: true });
    await dashboard.screenshot({ path: `${dir}timestamp-tooltip.png` });
  }
  await dashboard.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: daemon.baseURL });
  await errors.getByRole("button", { name: "Copy error" }).click();
  await expect(errors.getByRole("status")).toHaveText("Error copied");
  expect(await dashboard.evaluate(() => navigator.clipboard.readText())).toContain(error);
  if (process.env.MC_E2E_EVIDENCE) {
    const dir = artifactsDir("foreman-errors");
    mkdirSync(dir, { recursive: true });
    await dashboard.mouse.move(0, 0);
    await dashboard.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await dashboard.screenshot({ path: `${dir}grouped-error.png` });
  }
  await errors.getByText("Show affected sessions", { exact: true }).click();
  await expect(errors).toContainText("Review session 6");
  await dashboard.setViewportSize({ width: 960, height: 720 });
  await expect(button.getByText("1 issue", { exact: true })).toBeVisible();
  await expectContentClearsBorder(popover);
  const bounds = await popover.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(960);
  await dashboard.setViewportSize({ width: 1280, height: 720 });
  await errors.getByRole("button", { name: "Open model settings" }).click();
  await expect(dashboard).toHaveURL(/settings\/models/);

  // A successful heartbeat or another role does not hide this model failure.
  await post("/api/foreman/heartbeat", { workerId: "e2e-errors" });
  tracker.success({ ...context, operation: "verify" });
  await publish();
  await expect(button).toContainText("1 issue");
  await post("/api/foreman/config", { enabled: false }, "PUT");
  await button.click();
  await expect(errors).toContainText("Foreman is disabled");
  await post("/api/foreman/heartbeat/release", { workerId: "e2e-errors" });
  await expect(errors).toContainText("Showing the last worker report", { timeout: 15_000 });
  await button.click();
  await post("/api/foreman/heartbeat", { workerId: "e2e-errors" });
  tracker.success(context);
  await publish();
  await expect(button).not.toContainText("issue", { timeout: 15_000 });
  await button.click();
  await expect(popover.getByRole("region", { name: "Foreman errors" })).toHaveCount(0);
});

test("an operator dismisses Foreman errors, and a dismissed error returns when it happens again", async ({ dashboard, daemon }) => {
  const post = async (path: string, body: unknown, method: "POST" | "PUT" = "POST") => {
    const response = await fetch(`${daemon.baseURL}${path}`, {
      method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    expect(response.ok, `${path}: ${await response.text()}`).toBeTruthy();
  };
  await post("/api/foreman/config", { enabled: true, mode: "live", autoBacklog: false }, "PUT");
  await post("/api/foreman/heartbeat", { workerId: "e2e-dismiss" });
  const tracker = new ForemanHealthTracker();
  const triage = { operation: "triage" as const, runner: "claude" as const, model: "claude-haiku-4-5" };
  const review = { operation: "review" as const, runner: "codex" as const, model: "gpt-5.6-terra" };
  const timeout = "Error: Claude Agent SDK one-shot timed out";
  tracker.failure(review, "Usage limit reached for this account.");
  tracker.failure(triage, timeout);
  const publish = () => post("/api/foreman/health", { workerId: "e2e-dismiss", health: tracker.snapshot() });
  await publish();

  const button = dashboard.getByRole("button", { name: /Foreman - the auto-responder/ });
  await expect(button.getByText("2 issues", { exact: true })).toBeVisible({ timeout: 15_000 });
  await button.click();
  const popover = dashboard.getByRole("dialog", { name: "Foreman settings" });
  const errors = popover.getByRole("region", { name: "Foreman errors" });
  await expect(errors).toContainText("A dismissed error returns if it happens again.");
  await expect(errors.getByRole("button", { name: "Dismiss all" }))
    .toHaveAccessibleDescription("Hide every error below until it happens again");

  // The Electron renderer can refuse the async Clipboard API even after a click. Copy still
  // works through the shared synchronous fallback rather than failing with "Could not copy".
  await dashboard.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: daemon.baseURL });
  await dashboard.evaluate(() => {
    navigator.clipboard.writeText = () => Promise.reject(new DOMException("Write permission denied.", "NotAllowedError"));
  });
  const newest = errors.locator(".foreman-error-issue").first();
  await expect(newest).toContainText(timeout);
  await newest.getByRole("button", { name: "Copy error" }).click();
  await expect(newest.getByRole("status")).toHaveText("Error copied");
  expect(await dashboard.evaluate(() => navigator.clipboard.readText())).toContain(timeout);

  const dismiss = newest.getByRole("button", { name: "Dismiss", exact: true });
  await expect(dismiss).toHaveAccessibleDescription("Hide this error until it happens again");
  if (process.env.MC_E2E_EVIDENCE) {
    const dir = artifactsDir("foreman-errors");
    mkdirSync(dir, { recursive: true });
    await dashboard.mouse.move(0, 0);
    await dashboard.screenshot({ path: `${dir}dismiss-controls.png` });
  }
  // A refused dismissal says so and leaves the error in place, rather than hiding it locally.
  await dashboard.route("**/api/foreman/health/dismiss", (route) => route.fulfill({
    status: 500, contentType: "application/json", body: JSON.stringify({ error: "daemon unavailable" }),
  }));
  await dismiss.click();
  await expect(errors.getByRole("alert")).toHaveText("Could not dismiss. daemon unavailable");
  await expect(button.getByText("2 issues", { exact: true })).toBeVisible();
  await expect(newest).toContainText(timeout);
  await dashboard.unroute("**/api/foreman/health/dismiss");

  await dismiss.click();
  await expect(errors.getByRole("alert")).toHaveCount(0);
  await expect(button.getByText("1 issue", { exact: true })).toBeVisible();
  await expect(errors).not.toContainText(timeout);
  await expect(errors).toContainText("Usage limit reached for this account.");
  await expect(errors.getByRole("button", { name: "Dismiss all" })).toHaveCount(0);

  // The heartbeat republishes the same occurrence; that is not news and must not undo it.
  await publish();
  await post("/api/foreman/heartbeat", { workerId: "e2e-dismiss" });
  await dashboard.waitForTimeout(4_500);
  await expect(button.getByText("1 issue", { exact: true })).toBeVisible();

  // The same failure happening again is news: it comes back with its whole history.
  tracker.failure(triage, timeout);
  await publish();
  await expect(button.getByText("2 issues", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(errors).toContainText(timeout);
  await expect(errors.locator(".foreman-error-issue").first()).toContainText("2 occurrences");

  // The error recurs AFTER the popover drew it but before Dismiss all reaches the daemon. The
  // status poll is held on the reading on screen so the race is deterministic, not a timing bet.
  let held: string | null = null;
  await dashboard.route("**/api/foreman/status", async (route) => {
    if (held === null) return route.continue();
    return route.fulfill({ status: 200, contentType: "application/json", body: held });
  });
  held = await (await fetch(`${daemon.baseURL}/api/foreman/status`)).text();
  tracker.failure(triage, timeout);
  await publish();
  await errors.getByRole("button", { name: "Dismiss all" }).click();
  await expect(errors.getByRole("alert")).toHaveText(
    "Some errors happened again and were not dismissed. Review the latest occurrences, then dismiss them.");
  held = null;
  // Only the occurrence nobody saw is left, and it is on screen with its new count.
  await expect(button.getByText("1 issue", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(errors.locator(".foreman-error-issue").first()).toContainText("3 occurrences");
  await expect(errors).not.toContainText("Usage limit reached for this account.");
  if (process.env.MC_E2E_EVIDENCE) {
    await dashboard.mouse.move(0, 0);
    await dashboard.screenshot({ path: `${artifactsDir("foreman-errors")}recurred-before-dismiss.png` });
  }
  await dashboard.unroute("**/api/foreman/status");

  await errors.getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect(button).not.toContainText("issue", { timeout: 15_000 });
  await expect(popover.getByRole("region", { name: "Foreman errors" })).toHaveCount(0);
  if (process.env.MC_E2E_EVIDENCE) {
    await dashboard.mouse.move(0, 0);
    await dashboard.screenshot({ path: `${artifactsDir("foreman-errors")}dismissed-all.png` });
  }
});

test("a real worker surfaces provider failure and a single-task local plan cannot hide it", async ({ dashboard, daemon }) => {
  const addTask = async (title: string): Promise<string> => {
    const response = await fetch(`${daemon.baseURL}/api/tasks`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoRoot: daemon.repo, intent: title, title, backlog: true, workflowId: null }),
    });
    expect(response.ok, `create task: ${response.status}`).toBeTruthy();
    return ((await response.json()) as { id: string }).id;
  };
  const readPlan = async (): Promise<BacklogPlan | null> => {
    const response = await fetch(`${daemon.baseURL}/api/backlog/plan`);
    expect(response.ok).toBeTruthy();
    return response.json();
  };
  const firstTask = await addTask("E2E_FOREMAN_USAGE_LIMIT");
  const configured = await fetch(`${daemon.baseURL}/api/foreman/config`, {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: true, mode: "dry-run", autoBacklog: true, runner: "claude" }),
  });
  expect(configured.ok).toBeTruthy();
  await daemon.startForeman();
  const button = dashboard.getByRole("button", { name: /Foreman - the auto-responder/ });
  // The fake provider refuses this task's prompt. One task still succeeds because
  // planBacklog answers it locally, before any provider call can happen.
  await expect.poll(async () => (await readPlan())?.entries.map((entry) => entry.taskId), { timeout: 45_000 })
    .toEqual([firstTask]);
  const firstPlan = (await readPlan())!;
  await expect(button).not.toContainText("issue");
  const secondTask = await addTask("Another independent task");
  await expect(button).toContainText("1 issue", { timeout: 45_000 });
  await button.click();
  const errors = dashboard.getByRole("region", { name: "Foreman errors" });
  await expect(errors).toContainText("Usage limit reached for this account");
  await expect(errors).toContainText("Dependency planner error");
  await expect(errors).toContainText("Worker running");
  await expect(errors).toContainText("claude");
  if (process.env.MC_E2E_EVIDENCE) {
    const dir = artifactsDir("foreman-errors");
    mkdirSync(dir, { recursive: true });
    await dashboard.mouse.move(0, 0);
    await dashboard.screenshot({ path: `${dir}worker-usage-error.png` });
  }
  // A later one-task plan also makes no provider call. It must leave the received
  // error visible rather than claiming that account usage has recovered.
  const removed = await fetch(`${daemon.baseURL}/api/tasks/${secondTask}`, { method: "DELETE" });
  expect(removed.ok, await removed.text()).toBeTruthy();
  const retry = await fetch(`${daemon.baseURL}/api/foreman/planner/retry`, { method: "POST" });
  expect(retry.ok, await retry.text()).toBeTruthy();
  await expect.poll(async () => (await readPlan())?.generatedAt ?? 0, { timeout: 45_000 })
    .toBeGreaterThan(firstPlan.generatedAt);
  expect((await readPlan())!.entries.map((entry) => entry.taskId)).toEqual([firstTask]);
  await expect(button).toContainText("1 issue");
  await expect(errors).toContainText("Usage limit reached for this account");
  if (process.env.MC_E2E_EVIDENCE) {
    await dashboard.mouse.move(0, 0);
    await dashboard.screenshot({ path: `${artifactsDir("foreman-errors")}single-task-retains-error.png` });
  }
});
