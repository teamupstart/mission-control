import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";

test.use({ daemonEnv: { MISSION_PI_EXTENSION: resolve("dist/pi-integration/extension.js") } });

test("Pi OAuth failure stays visible after reload and the session accepts a retry", async ({ dashboard, daemon }) => {
  const installed = await dashboard.request.post(`${daemon.baseURL}/api/setup/install`, {
    data: { id: "pi-integration" },
  });
  expect(installed.ok(), await installed.text()).toBe(true);
  expect((await dashboard.request.put(`${daemon.baseURL}/api/harnesses/config`, {
    data: { sessionRuntime: { pi: "sdk" } },
  })).ok()).toBe(true);
  await dashboard.getByRole("button", { name: "Dispatch" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await dashboard.keyboard.press("Escape");
  await dialog.getByRole("combobox", { name: "Kind", exact: true }).selectOption("chat");
  await dialog.getByRole("textbox", { name: "What would you like to talk about?" }).fill("PI_OAUTH_FAILURE");
  await dialog.getByLabel("Agent").selectOption("pi");
  await dialog.getByRole("combobox", { name: /^Model/ }).selectOption("anthropic/claude-sonnet-5");
  await expectContentClearsBorder(dialog);
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(async () => {
    const tasks = await (await dashboard.request.get(`${daemon.baseURL}/api/tasks`)).json();
    return tasks.find((task: { kind: string }) => task.kind === "chat")?.status;
  }).toBe("running");
  await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  const detail = dashboard.locator(".console-detail");
  const failure = detail.getByText(/Pi turn failed: OAuth auth derivation failed/).first();
  await expect(failure).toBeVisible();
  await expect(detail).not.toContainText("synthetic-secret");
  await dashboard.reload();
  await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  await expect(failure).toBeVisible();
  const dir = artifactsDir("pi-oauth-failure");
  if (process.env.MC_E2E_EVIDENCE === "1") {
    mkdirSync(dir, { recursive: true });
    await dashboard.screenshot({ path: join(dir, "failed-turn.png") });
  }
  const composer = detail.getByPlaceholder(/^Reply to this session/);
  await composer.fill("retry after provider repair");
  await composer.press("Enter");
  await expect(detail.getByText(/pi answered: retry after provider repair/)).toBeVisible();
  await expect(failure).toBeVisible();
});
