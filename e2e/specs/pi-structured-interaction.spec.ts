import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { recordsIn } from "../fixtures/records.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";

test.use({ daemonEnv: { MC_E2E_PI_TRUST: "1" }, viewport: { width: 1280, height: 900 } });
const evidence = artifactsDir("pi-structured-interaction");

async function shoot(page: Page, name: string) {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(evidence, { recursive: true });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: join(evidence, `${name}.png`) });
}

function records<T>(daemon: DaemonHandle, kind: string): T[] {
  return recordsIn<T>(join(daemon.recordDir, "pi-sdk"), (file) => file.startsWith(`${kind}-`));
}

async function live(daemon: DaemonHandle) {
  const response = await fetch(`${daemon.baseURL}/api/sessions`);
  return await response.json() as Array<{ id: string; state: string; paneDialog?: { requestId: string }; prUrl: string | null }>;
}

async function dispatch(page: Page, daemon: DaemonHandle, prompt: string) {
  await page.goto(`${daemon.baseURL}/#/settings`);
  await page.getByRole("tab", { name: /Harnesses/ }).click();
  await page.getByRole("combobox", { name: "Session runtime for dispatched Pi sessions" }).selectOption("sdk");
  // A configured fixture remote is enough for local provenance matching. No GitHub call.
  execFileSync("git", ["remote", "add", "fixture", "https://github.com/test/pi-fixture.git"], { cwd: daemon.repo });
  await page.getByRole("button", { name: "← Fleet" }).click();
  await page.getByRole("button", { name: "Dispatch" }).click();
  const modal = page.getByRole("dialog", { name: "Dispatch an agent" });
  await modal.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await modal.getByPlaceholder("What should this agent do?").fill(prompt);
  await modal.getByLabel("Agent").selectOption("pi");
  await modal.getByRole("combobox", { name: /^Model/ }).selectOption("amazon-bedrock/deepseek.v3.2");
  await modal.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await expectContentClearsBorder(modal);
  await modal.getByRole("button", { name: "Dispatch now" }).click();
  await expect(modal).toBeHidden();
  await page.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  await expect(page.locator(".pd-prompt")).toContainText("Trust Pi project resources");
}

test("trust denial stays usable and all four structured questions preserve their values", async ({ dashboard, daemon }) => {
  await dispatch(dashboard, daemon, "PI_QUESTIONS");
  expect(records(daemon, "project-resources")).toHaveLength(0);
  const session = (await live(daemon))[0]!;
  const invited = await fetch(`${daemon.baseURL}/api/sessions/${session.id}/foreman-invite`, { method: "POST" });
  expect(invited.ok).toBe(true);
  const automated = await fetch(`${daemon.baseURL}/api/sessions/${session.id}/select-option`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ requestId: session.paneDialog!.requestId, number: 1, label: "Trust project", by: "foreman" }),
  });
  expect(automated.status).toBe(409);
  expect(await automated.json()).toMatchObject({ error: "Project trust requires the operator's decision" });
  expect(records(daemon, "project-resources")).toHaveLength(0);
  await shoot(dashboard, "trust-before-load");
  await dashboard.getByRole("button", { name: /Skip project resources/ }).click();
  await expect(dashboard.locator(".pd-prompt")).toHaveText("Choose a region");
  expect(records<{ loaded: boolean }>(daemon, "project-resources")[0]?.loaded).toBe(false);
  await dashboard.getByRole("button", { name: /2.*East/ }).click();
  await expect(dashboard.locator(".pd-prompt")).toContainText("Use the selected test region");
  await dashboard.getByRole("button", { name: /^1.*Yes/ }).click();
  await expect(dashboard.getByRole("textbox", { name: "Custom answer for Deployment name" })).toBeVisible();
  await dashboard.getByRole("button", { name: "Submit custom answer" }).click();
  const editor = dashboard.getByRole("textbox", { name: "Custom answer for Release notes" });
  await expect(editor).toHaveValue("First line\nSecond line");
  await editor.fill("  revised first\nsecond  \n");
  await dashboard.getByRole("button", { name: "Submit custom answer" }).scrollIntoViewIfNeeded();
  await shoot(dashboard, "multiline-editor");
  await dashboard.getByRole("button", { name: "Submit custom answer" }).click();
  await expect(dashboard.locator(".console-detail span.badge").first()).toHaveText("idle");
  expect(records(daemon, "answers")).toEqual([{ selected: "East", confirmed: true, input: "", edited: "  revised first\nsecond  \n" }]);
  await expect(dashboard.locator(".pd-prompt")).toHaveCount(0);
});

test("trust approval, timeout correlation, stop and managed queue controls use the shared session", async ({ dashboard, daemon }) => {
  // Keep this fixture focused on queue delivery, without the separate one-minute human
  // composer lease. The dedicated composer-presence spec covers that authorization gate.
  await dashboard.route("**/composer-activity", (route) => route.fulfill({ json: { ok: true } }));
  await dispatch(dashboard, daemon, "PI_TIMEOUT");
  await dashboard.getByRole("button", { name: /Trust project$/ }).click();
  await expect(dashboard.locator(".pd-prompt")).toHaveText("Repeated question");
  const session = (await live(daemon))[0]!;
  const oldId = session.paneDialog!.requestId;
  await expect.poll(async () => (await live(daemon))[0]?.paneDialog?.requestId).not.toBe(oldId);
  const stale = await fetch(`${daemon.baseURL}/api/sessions/${session.id}/select-option`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ requestId: oldId, number: 1, label: "Continue" }),
  });
  expect(stale.status).toBe(409);
  await dashboard.getByRole("button", { name: /1.*Continue/ }).click();
  await expect(dashboard.locator(".console-detail span.badge").first()).toHaveText("idle");
  expect(records<{ loaded: boolean }>(daemon, "project-resources")[0]?.loaded).toBe(true);
  const composer = dashboard.getByPlaceholder(/^Reply to this session/);
  await composer.fill("PI_BLOCK"); await composer.press("Enter");
  await expect(dashboard.locator(".pd-prompt")).toHaveText("Blocking extension question");
  await dashboard.getByRole("tab", { name: "Work queue" }).click();
  const queueInput = dashboard.getByPlaceholder(/Queue work for this session/);
  await expect(queueInput).toBeVisible();
  await queueInput.fill("Follow up after the extension question");
  await queueInput.press("Enter");
  await expect(dashboard.locator(".console-detail")).toContainText("Follow up after the extension question");
  await shoot(dashboard, "managed-queue-blocked-on-question");
  // The shared interrupt route cancels the UI request before Pi's abort settles the turn.
  const interrupted = await fetch(`${daemon.baseURL}/api/sessions/${session.id}/interrupt`, { method: "POST" });
  expect(interrupted.ok).toBe(true);
  await expect.poll(async () => (await live(daemon))[0]?.paneDialog).toBeNull();
  // Drive the same HTTP boundary as the worker, with its verifier replaced by a fixed
  // successful result. The Node integration test exercises the worker decision/apply loop.
  const queue = await (await fetch(`${daemon.baseURL}/api/sessions/${session.id}/queue`)).json() as { items: Array<{ id: string }> };
  const item = queue.items[0]!;
  const write = async (path: string, body: unknown, method: "POST" | "PUT" = "POST") => {
    const response = await fetch(`${daemon.baseURL}${path}`, { method,
      headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect(response.ok, `${path}: ${await response.clone().text()}`).toBe(true);
    return response;
  };
  const itemPath = `/api/sessions/${session.id}/queue/${item.id}`;
  await write(`/api/sessions/${session.id}/foreman-invite`, {});
  await write(`${itemPath}/state`, { state: "sending" }, "PUT");
  const delivery = await write(`/api/sessions/${session.id}/inject`, { text: "/skill:pull-request", origin: "foreman" });
  expect((await delivery.json()).delivery).toBe("started");
  const acknowledged = await write(`${itemPath}/sent`, { baseSha: null, transcriptAnchor: 0 });
  expect((await acknowledged.json()).state).toBe("in_progress");
  await expect.poll(async () => (await live(daemon))[0]?.state).toBe("idle");
  await write(`${itemPath}/state`, { state: "verified" }, "PUT");
  await expect(dashboard.locator(".console-detail").getByText("done", { exact: true })).toBeVisible();
  await shoot(dashboard, "managed-queue-completed");
  await dashboard.getByRole("tab", { name: "Conversation", exact: true }).click();
  await composer.fill("PI_CREATE_PR"); await composer.press("Enter");
  await expect.poll(async () => (await live(daemon))[0]?.prUrl).toBe("https://github.com/test/pi-fixture/pull/975");
  await expect(dashboard.getByRole("link", { name: /#975/ }).first()).toHaveAttribute("href", "https://github.com/test/pi-fixture/pull/975");
  await shoot(dashboard, "proven-pr");
});


test("reset cancels an extension question before rebinding the replacement", async ({ dashboard, daemon }) => {
  await dispatch(dashboard, daemon, "PI_BLOCK");
  await dashboard.getByRole("button", { name: /Trust project$/ }).click();
  await expect(dashboard.locator(".pd-prompt")).toHaveText("Blocking extension question");
  const old = (await live(daemon))[0]!;
  const requestId = old.paneDialog!.requestId;
  await dashboard.locator(".console-detail").getByRole("button", { name: /reset/ }).click();
  const reset = dashboard.getByRole("dialog", { name: "Reset session to origin" });
  await expectContentClearsBorder(reset);
  await reset.getByRole("button", { name: "Reset & clear" }).click();
  await expect(reset).toBeHidden();
  await expect(dashboard.locator(".pd-prompt")).toHaveCount(0);
  const composer = dashboard.getByPlaceholder(/^Reply to this session/);
  await composer.fill("PI_BLOCK"); await composer.press("Enter");
  await expect(dashboard.locator(".pd-prompt")).toHaveText("Blocking extension question");
  const stale = await fetch(`${daemon.baseURL}/api/sessions/${old.id}/submit-options`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ requestId, answers: [{ question: "Blocking extension question", labels: [], text: "late" }] }),
  });
  expect(stale.status).toBe(409);
  await dashboard.getByRole("textbox", { name: "Custom answer for Blocking extension question" }).fill("fresh answer");
  await dashboard.getByRole("button", { name: "Submit custom answer" }).click();
  await expect(dashboard.locator(".console-detail span.badge").first()).toHaveText("idle");
});

test("an unsupported UI method can report after its first diagnostic was throttled", async ({ dashboard, daemon }) => {
  // Keep diagnostics visible until the explicit interrupt through the shared slow-turn mode.
  await dispatch(dashboard, daemon, "PI_UNSUPPORTED SLOWLY");
  await dashboard.getByRole("button", { name: /Trust project$/ }).click();
  const detail = dashboard.locator(".console-detail");
  await expect(detail.getByText("Pi warning: Extension UI setWidget is unavailable in managed sessions", { exact: true })).toBeVisible();
  await shoot(dashboard, "unsupported-ui-retry");
  const session = (await live(daemon))[0]!;
  const interrupted = await fetch(`${daemon.baseURL}/api/sessions/${session.id}/interrupt`, { method: "POST" });
  expect(interrupted.ok).toBe(true);
  await expect(detail.locator("span.badge").first()).toHaveText("idle");
});
