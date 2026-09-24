import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Session } from "../../src/shared/types.ts";
import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import { meta, mkSession } from "../../test/helpers/session-fixture.ts";

test.use({ actionTimeout: 15_000, daemonEnv: {
  MC_E2E_CODEX_EFFORT: "medium",
  MC_E2E_CODEX_HELD_TURN_MS: "14000",
  MISSION_RUNTIME_META_POLL_MS: "400",
  MISSION_PI_EXTENSION: resolve("dist/pi-extension/index.js"),
} });

const cases = [
  { agent: "claude", initial: "claude-opus-5", next: "claude-sonnet-5" },
  { agent: "codex", initial: "gpt-6-astra", next: "gpt-5.6-sol" },
  { agent: "pi", initial: "amazon-bedrock/deepseek.v3.2", next: "amazon-bedrock/anthropic.claude-sonnet-4-5-20250929-v1:0" },
] as const;

test("configured SDK models stay selected until metadata confirms them in Console and Board", async ({ dashboard, daemon }) => {
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
  } finally {
    await reader.cancel();
  }
  const snapshot = JSON.parse(text.split("\n").find((line) => line.startsWith("data: "))!.slice(6));
  const session = mkSession({
    id: "sdk:awaiting-model", name: "Awaiting model confirmation", runtime: "sdk", agent: "claude",
    cwd: daemon.repo, repoRoot: daemon.repo, gitRoot: daemon.repo,
    configuredModel: "claude-opus-5", meta: null,
  });
  await dashboard.route("**/events", (route) => route.fulfill({
    contentType: "text/event-stream", body: `data: ${JSON.stringify({ ...snapshot, sessions: [session] })}\n\n`,
  }));
  for (const layout of ["console", "board"] as const) {
    expect((await dashboard.request.put(`${daemon.baseURL}/api/ui/config`, { data: { layout } })).ok()).toBe(true);
    for (const modelId of [undefined, null, "claude-sonnet-5", "claude-opus-5"] as const) {
      session.meta = modelId === undefined ? null : meta({ modelId, model: "Opus 5", longContext: false });
      await dashboard.reload();
      if (layout === "console") await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
      const chip = dashboard.locator(layout === "console" ? ".console-detail" : ".tile").getByRole("button", { name: /^Model:/ });
      const pending = modelId !== "claude-opus-5";
      await expect(chip).toHaveAccessibleName(`Model: claude-opus-5${pending ? ". Selected for future responses" : ""}. Change model for this session`);
      await expect(chip.locator(".rt-think-next")).toHaveCount(pending ? 1 : 0);
      if (modelId === undefined && process.env.MC_E2E_EVIDENCE) {
        mkdirSync(artifactsDir("model-chip-sdk"), { recursive: true });
        await dashboard.screenshot({ path: `${artifactsDir("model-chip-sdk")}metadata-pending-${layout}.png` });
      }
      await chip.click();
      const menu = dashboard.getByRole("menu", { name: "Session model" });
      await expect(menu.getByRole("menuitemradio").filter({ has: dashboard.getByText("claude-opus-5", { exact: true }) })).toHaveAttribute("aria-checked", "true");
      await dashboard.keyboard.press("Escape");
    }
  }
});

for (const { agent, initial, next } of cases) {
  test(`${agent} SDK model dropdown changes the next turn and stays selected across views`, async ({ dashboard, daemon }) => {
    if (agent === "pi") {
      const installed = await dashboard.request.post(`${daemon.baseURL}/api/setup/install`, { data: { id: "pi-integration" } });
      expect(installed.ok(), await installed.text()).toBe(true);
      expect((await dashboard.request.put(`${daemon.baseURL}/api/harnesses/config`, {
        data: { sessionRuntime: { pi: "sdk" } },
      })).ok()).toBe(true);
      await dashboard.reload();
    }
    const defaults = await (await dashboard.request.get(`${daemon.baseURL}/api/harnesses/config`)).json();
    await dashboard.getByRole("button", { name: "Dispatch" }).click();
    const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
    await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
    await dashboard.keyboard.press("Escape");
    await dialog.getByPlaceholder("What should this agent do?").fill("exercise the model dropdown");
    await dialog.getByRole("combobox", { name: /^Agent/ }).selectOption(agent);
    await dialog.getByRole("combobox", { name: /^Model/ }).selectOption(initial);
    await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
    await expectContentClearsBorder(dialog);
    await dialog.getByRole("button", { name: "Dispatch now" }).click();
    await expect(dialog).toBeHidden();
    const row = dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first();
    await expect(row.locator(".rail-state")).toHaveText("idle", { timeout: 30_000 });
    await row.click();
    const detail = dashboard.locator(".console-detail");
    const chip = detail.getByRole("button", { name: /^Model:/ });
    const live = async (): Promise<Session> => (await (await dashboard.request.get(`${daemon.baseURL}/api/sessions`)).json())[0];
    await expect.poll(async () => (await live()).meta?.modelId).toBe(initial);
    const id = (await live()).id;
    const endpoint = `**/api/sessions/${encodeURIComponent(id)}/model`;
    const menu = dashboard.getByRole("menu", { name: "Session model" });
    const option = (model: string) => menu.getByRole("menuitemradio").filter({ has: dashboard.getByText(model, { exact: true }) });

    await chip.click();
    await expect(option(initial)).toHaveAttribute("aria-checked", "true");
    await expect(option(initial)).toHaveAccessibleDescription(/^Set this session's model to /);
    await dashboard.keyboard.press("ArrowDown");
    await expect(menu.locator('[role="menuitemradio"]:focus')).toHaveCount(1);
    await dashboard.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(chip).toBeFocused();

    // A rejected HTTP write leaves the previous choice visible and the menu available to retry.
    await dashboard.route(endpoint, async (route) => route.fulfill({
      status: 409, contentType: "application/json", body: JSON.stringify({ ok: false, error: "model unavailable" }),
    }));
    await chip.click();
    await option(next).click();
    await expect(menu.getByRole("alert")).toHaveText("model unavailable");
    await expect(option(initial)).toHaveAttribute("aria-checked", "true");
    expect((await live()).configuredModel).toBe(initial);
    await dashboard.unroute(endpoint);
    await dashboard.keyboard.press("Escape");

    await expect(menu).toBeHidden();
    await expect(detail).toBeVisible();
    await expect(chip).toBeFocused();

    if (agent === "claude") {
      // The supervisor tests inject the database fault. Here, preserve the real accepted
      // selection/SSE and substitute its partial-acceptance response to exercise recovery.
      let attempts = 0;
      await dashboard.route(endpoint, async (route) => {
        const response = await route.fetch();
        expect(response.ok()).toBe(true);
        if (++attempts <= 2) await route.fulfill({
          status: 409, contentType: "application/json", body: JSON.stringify({
            ok: false, error: "The model changed in this session but could not be saved. A restart may use the previous model. Retry the selection to save it.",
          }),
        });
        else await route.fulfill({ response });
      });
      await chip.click();
      await option(next).click();
      await expect(menu.getByRole("alert")).toContainText("could not be saved");
      await expect(option(next)).toHaveAttribute("aria-checked", "true");
      await option(next).click();
      await expect(menu.getByRole("alert")).toContainText("A restart may use the previous model");
      await expect(option(next)).toHaveAttribute("aria-checked", "true");
      await option(next).click();
      await expect(menu).toBeHidden();
      expect(attempts).toBe(3);
      await dashboard.unroute(endpoint);
      await chip.click();
      await option(initial).click();
      await expect(menu).toBeHidden();
    }

    if (agent === "codex") {
      const composer = detail.getByPlaceholder(/^Reply to this session/);
      await composer.fill("hold the current turn open");
      await composer.press("Enter");
      await expect(row.locator(".rail-state")).toHaveText("working");
    }
    await chip.click();
    if (process.env.MC_E2E_EVIDENCE) {
      mkdirSync(artifactsDir("model-chip-sdk"), { recursive: true });
      await dashboard.mouse.move(0, 0);
      await dashboard.screenshot({ path: `${artifactsDir("model-chip-sdk")}${agent}-dropdown.png` });
    }
    await option(next).click();
    await expect(menu).toBeHidden();
    await expect(chip).toHaveAccessibleName(`Model: ${next}. Selected for future responses. Change model for this session`);
    expect((await live()).meta?.modelId).toBe(initial);
    await dashboard.reload();
    await row.click();
    await expect(chip).toHaveAccessibleName(`Model: ${next}. Selected for future responses. Change model for this session`);
    await expect(row.locator(".rail-state")).toHaveText("idle", { timeout: 30_000 });
    const composer = detail.getByPlaceholder(/^Reply to this session/);
    await composer.fill("run on the selected model");
    await composer.press("Enter");
    await expect.poll(async () => (await live()).meta?.modelId).toBe(next);
    await expect(chip).toHaveAccessibleName(`Model: ${next}. Change model for this session`);
    await expect(row.locator(".rail-state")).toHaveText("idle");
    expect(await (await dashboard.request.get(`${daemon.baseURL}/api/harnesses/config`)).json()).toEqual(defaults);

    expect((await dashboard.request.put(`${daemon.baseURL}/api/ui/config`, { data: { layout: "board" } })).ok()).toBe(true);
    await dashboard.reload();
    const boardChip = dashboard.locator(".tile").getByRole("button", { name: /^Model:/ });
    await expect(boardChip).toHaveAccessibleName(`Model: ${next}. Change model for this session`);
    await boardChip.click();
    await expect(option(next)).toHaveAttribute("aria-checked", "true");
    await option(initial).click();
    await expect(menu).toBeHidden();
    await expect(boardChip).toHaveAccessibleName(`Model: ${initial}. Selected for future responses. Change model for this session`);
    if (process.env.MC_E2E_EVIDENCE) {
      await boardChip.blur();
      await dashboard.mouse.move(0, 0);
      await dashboard.screenshot({ path: `${artifactsDir("model-chip-sdk")}${agent}-board-selected.png` });
    }
  });
}
