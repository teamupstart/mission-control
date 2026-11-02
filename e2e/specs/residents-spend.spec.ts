import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import type { ResidentProfile } from "../../src/shared/residents.ts";

for (const [agent, model] of [
  ["codex", "gpt-6.1-sol"], ["codex", "gpt-6.1-terra"],
  ["claude", "claude-fable-5-1"], ["claude", "claude-opus-5-5"],
  ["claude", "claude-sonnet-5-5"], ["claude", "claude-haiku-5-5"],
  ["codex", "unpriced-future-model"],
] as const) {
  test(`${model}: profile spend guidance and recovery before save`, async ({ dashboard: page, daemon }) => {
    // Seed a saved model, including ids newer than the discovered catalog, without a cap.
    const created = await page.request.post(`${daemon.baseURL}/api/residents/profiles`, { data: { settings: {
      identity: { name: "Agent Wrangler" }, instructions: { markdown: "Watch the fleet." },
      execution: { agent, model }, loop: { spendCapUsd: null },
    } } });
    expect(created.ok(), await created.text()).toBe(true);
    const profile = await created.json() as ResidentProfile;
    await page.goto(`${daemon.baseURL}/#/residents/${profile.id}`);
    const editor = page.getByRole("region", { name: "Resident profile Agent Wrangler", exact: true });
    const select = editor.getByRole("combobox", { name: "Model", exact: true });
    const cap = editor.getByLabel("Spend per 24 hours (USD)", { exact: true });
    await cap.fill("20");
    if (model === "unpriced-future-model") {
      await expect(select.locator("option:checked")).toContainText("spend cap unavailable");
      await expect(cap).toHaveAttribute("aria-invalid", "true");
      await expect(cap).toHaveAccessibleDescription(/Spend cap unavailable.*unpriced-future-model/);
      await expect(select).toHaveAccessibleDescription(/Spend cap unavailable/);
      await expect(editor.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
      await editor.getByRole("button", { name: "Clear spend cap" }).scrollIntoViewIfNeeded();
      if (process.env.MC_E2E_EVIDENCE === "1") {
        mkdirSync(artifactsDir("residents-spend"), { recursive: true });
        await page.screenshot({ path: join(artifactsDir("residents-spend"), "unpriced-cap.png") });
        await page.locator("#resident-model-spend").scrollIntoViewIfNeeded();
        await page.screenshot({ path: join(artifactsDir("residents-spend"), "unpriced-model.png") });
      }
      await editor.getByRole("button", { name: "Clear spend cap" }).click();
      await expect(cap).toHaveValue("");
      await expect(cap).not.toHaveAttribute("aria-invalid", "true");
      await expect(select.locator("option:checked")).toContainText("spend cap unavailable");
      await expect(editor.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
      await editor.getByRole("button", { name: "Save", exact: true }).click();
      await expect(editor).toContainText("Revision 2");
      await expect(editor.getByRole("button", { name: "Launch" })).toBeEnabled();
      // Choosing a priced model is the other recovery and keeps the operator's cap.
      await cap.fill("20");
      await select.selectOption("gpt-6-sol");
      await expect(cap).toHaveValue("20");
      await expect(cap).not.toHaveAttribute("aria-invalid", "true");
    }
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await expect(editor).toContainText(model === "unpriced-future-model" ? "Revision 3" : "Revision 2");
    await expect(editor.getByRole("button", { name: "Launch" })).toBeEnabled();
    const stored = ((await (await page.request.get(`${daemon.baseURL}/api/residents/profiles`)).json()) as ResidentProfile[]).find(p => p.id === profile.id)!;
    expect(stored.settings.loop.spendCapUsd).toBe(20);
    if (model === "gpt-6.1-sol") {
      // Native compaction metadata belongs to the isolated fake Codex home.
      mkdirSync(join(daemon.home, ".codex"), { recursive: true });
      writeFileSync(join(daemon.home, ".codex/models_cache.json"), JSON.stringify({ models: [
        { slug: model, context_window: 500_000, effective_context_window_percent: 95 },
      ] }));
      await editor.getByRole("button", { name: "Launch" }).click();
      const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
      await expectContentClearsBorder(dialog);
      if (process.env.MC_E2E_EVIDENCE === "1") {
        mkdirSync(artifactsDir("residents-spend"), { recursive: true });
        await dialog.screenshot({ path: join(artifactsDir("residents-spend"), "sol-launch.png") });
      }
      await dialog.getByRole("button", { name: "Launch resident" }).click();
      await expect(dialog).toBeHidden();
      await expect.poll(async () => {
        const tasks = await (await page.request.get(`${daemon.baseURL}/api/tasks`)).json() as Array<{ kind: string; status: string }>;
        return tasks.find(t => t.kind === "resident")?.status;
      }).toBe("running");
      const live = page.getByRole("region", { name: "Live run of Agent Wrangler" });
      await expect(live).toBeVisible();
      if (process.env.MC_E2E_EVIDENCE === "1") {
        await live.screenshot({ path: join(artifactsDir("residents-spend"), "sol-running.png") });
      }
    }
  });
}

test("an inherited unpriced model names the resolved default and preserves the cap", async ({ dashboard: page, daemon }) => {
  const configured = await page.request.put(`${daemon.baseURL}/api/harnesses/config`, {
    data: { defaultModel: { codex: "unpriced-inherited-model" } },
  });
  expect(configured.ok()).toBe(true);
  await page.goto(`${daemon.baseURL}/#/residents/new`);
  const editor = page.getByRole("region", { name: "New resident profile" });
  await editor.getByLabel("Name", { exact: true }).fill("Inherited model");
  await editor.getByLabel("Profile instructions").fill("Watch the fleet.");
  await editor.getByRole("combobox", { name: "Harness" }).selectOption("codex");
  const model = editor.getByRole("combobox", { name: "Model", exact: true });
  await expect(model).toHaveValue("");
  await expect(model).toHaveAccessibleDescription(/Spend cap unavailable for unpriced-inherited-model/);
  await expect(editor.getByLabel("Spend per 24 hours (USD)", { exact: true })).toHaveValue("20");
  await expect(editor.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await model.selectOption("gpt-6-sol");
  await expect(editor.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
});


test.describe("unpriced live catalog choices", () => {
  test.use({ daemonEnv: { MC_E2E_CODEX_UNPRICED_CATALOG: "1" } });

  test("marks an unpriced live option before selection and shows adjacent guidance after selection", async ({ dashboard: page, daemon }) => {
    await page.goto(`${daemon.baseURL}/#/residents/new`);
    const editor = page.getByRole("region", { name: "New resident profile" });
    await editor.getByLabel("Name", { exact: true }).fill("Live catalog watcher");
    await editor.getByLabel("Profile instructions").fill("Watch the fleet.");
    await editor.getByRole("combobox", { name: "Harness" }).selectOption("codex");
    const model = editor.getByRole("combobox", { name: "Model", exact: true });
    const offered = model.getByRole("option", { name: "Unpriced live model", exact: false });

    // The fake Codex model/list response travels through the real daemon catalog route.
    // No saved profile or selected value can synthesize this option as a retained row.
    await expect(offered).toHaveText("Unpriced live model - Discovered test model. · spend cap unavailable");
    await expect(offered).toBeEnabled();
    await expect(model).not.toHaveValue("gpt-e2e-unpriced-live");
    await expect(offered).not.toContainText("not currently reported");
    const response = await page.request.get(`${daemon.baseURL}/api/harnesses/models?refresh=1`);
    expect(response.ok()).toBe(true);
    const catalog = await response.json();
    expect(catalog.codex.source).toBe("live");
    expect(catalog.codex.choices.some((choice: { id: string }) => choice.id === "gpt-e2e-unpriced-live")).toBe(true);

    await model.selectOption("gpt-e2e-unpriced-live");
    const execution = editor.getByRole("region", { name: "Harness, model and effort" });
    const guardrails = editor.getByRole("region", { name: "Loop and guardrails" });
    const modelGuidance = execution.getByRole("status").filter({ hasText: "Spend cap unavailable" });
    const capGuidance = guardrails.getByRole("status").filter({ hasText: "Spend cap unavailable" });
    await expect(modelGuidance).toContainText("Spend cap unavailable for gpt-e2e-unpriced-live");
    await expect(capGuidance).toContainText("Spend cap unavailable for gpt-e2e-unpriced-live");
    await expect(model).toHaveAccessibleDescription(/Spend cap unavailable for gpt-e2e-unpriced-live/);
    const cap = editor.getByLabel("Spend per 24 hours (USD)", { exact: true });
    await expect(cap).toHaveValue("20");
    await expect(cap).toHaveAccessibleDescription(/Spend cap unavailable for gpt-e2e-unpriced-live/);
    await expect(cap).toHaveAttribute("aria-invalid", "true");
    await expect(editor.getByRole("button", { name: "Save", exact: true })).toBeDisabled();

    if (process.env.MC_E2E_EVIDENCE === "1") {
      mkdirSync(artifactsDir("residents-spend"), { recursive: true });
      await modelGuidance.scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(artifactsDir("residents-spend"), "live-unpriced-model.png") });
      await guardrails.getByRole("button", { name: "Clear spend cap" }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(artifactsDir("residents-spend"), "live-unpriced-cap.png") });
    }
  });
});

for (const inherited of ["gpt-6-sol", "unpriced-delayed-default"]) {
  test(`pending default pricing blocks capped saves, then resolves ${inherited}`, async ({ dashboard: page, daemon }) => {
    expect((await page.request.put(`${daemon.baseURL}/api/harnesses/config`, {
      data: { defaultModel: { codex: inherited } },
    })).ok()).toBe(true);
    let release = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    await page.route("**/api/harnesses/config", async route => {
      await held;
      await route.continue();
    });
    try {
      await page.goto(`${daemon.baseURL}/#/residents/new`);
      const editor = page.getByRole("region", { name: "New resident profile" });
      await editor.getByLabel("Name", { exact: true }).fill("Pending defaults");
      await editor.getByLabel("Profile instructions").fill("Watch the fleet.");
      await editor.getByRole("combobox", { name: "Harness" }).selectOption("codex");
      const model = editor.getByRole("combobox", { name: "Model", exact: true });
      const cap = editor.getByLabel("Spend per 24 hours (USD)", { exact: true });
      const save = editor.getByRole("button", { name: "Save", exact: true });
      // The response stays held throughout these assertions, so retries cannot hide an unsafe save window.
      await expect(model).toHaveValue("");
      await expect(cap).toHaveValue("20");
      await expect(save).toBeDisabled();
      await expect(model).toHaveAccessibleDescription(/Checking spend cap availability for the harness default/);
      await expect(cap).toHaveAccessibleDescription(/Checking spend cap availability for the harness default/);
      const guidance = editor.getByRole("region", { name: "Harness, model and effort" }).getByRole("status")
        .filter({ hasText: "Checking spend cap availability" });
      await expect(guidance).toBeVisible();
      if (process.env.MC_E2E_EVIDENCE === "1" && inherited === "unpriced-delayed-default") {
        mkdirSync(artifactsDir("residents-spend"), { recursive: true });
        await guidance.scrollIntoViewIfNeeded();
        await page.screenshot({ path: join(artifactsDir("residents-spend"), "pending-default-model.png") });
      }
      release();
      if (inherited === "gpt-6-sol") {
        await expect(save).toBeEnabled();
        await expect(model).not.toHaveAccessibleDescription(/Checking spend cap availability/);
        await save.click();
        await expect(page.getByRole("region", { name: "Resident profile Pending defaults", exact: true })).toContainText("Revision 1");
      } else {
        await expect(model).toHaveAccessibleDescription(/Spend cap unavailable for unpriced-delayed-default/);
        await expect(cap).toHaveAccessibleDescription(/Spend cap unavailable for unpriced-delayed-default/);
        await expect(save).toBeDisabled();
        await expect(cap).toHaveValue("20");
      }
    } finally {
      release();
      await page.unroute("**/api/harnesses/config");
    }
  });
}

for (const failure of ["http", "network"] as const) {
  test(`${failure} failure loading default pricing keeps field guidance and explicit recoveries`, async ({ dashboard: page, daemon }) => {
    expect((await page.request.put(`${daemon.baseURL}/api/harnesses/config`, {
      data: { defaultModel: { codex: "unpriced-failed-default" } },
    })).ok()).toBe(true);
    await page.route("**/api/harnesses/config", route => failure === "http"
      ? route.fulfill({ status: 503, json: { error: "Unavailable" } })
      : route.abort("failed"));
    await page.goto(`${daemon.baseURL}/#/residents/new`);
    const editor = page.getByRole("region", { name: "New resident profile" });
    await editor.getByLabel("Name", { exact: true }).fill("Failed defaults");
    await editor.getByLabel("Profile instructions").fill("Watch the fleet.");
    await editor.getByRole("combobox", { name: "Harness" }).selectOption("codex");
    const model = editor.getByRole("combobox", { name: "Model", exact: true });
    const cap = editor.getByLabel("Spend per 24 hours (USD)", { exact: true });
    const save = editor.getByRole("button", { name: "Save", exact: true });
    await expect(model).toHaveAccessibleDescription(/Could not check spend cap availability for the harness default/);
    await expect(cap).toHaveAccessibleDescription(/Could not check spend cap availability for the harness default/);
    await expect(model).toHaveValue("");
    await expect(cap).toHaveValue("20");
    await expect(save).toBeDisabled();
    const guardrails = editor.getByRole("region", { name: "Loop and guardrails" });
    await expect(guardrails.getByRole("status")).toContainText("Could not check spend cap availability");
    if (process.env.MC_E2E_EVIDENCE === "1" && failure === "http") {
      mkdirSync(artifactsDir("residents-spend"), { recursive: true });
      await guardrails.getByRole("button", { name: "Clear spend cap" }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(artifactsDir("residents-spend"), "failed-default-cap.png") });
    }
    await guardrails.getByRole("button", { name: "Clear spend cap" }).click();
    await expect(cap).toHaveValue("");
    await expect(save).toBeEnabled();
    await cap.fill("20");
    await expect(save).toBeDisabled();
    await model.selectOption("gpt-6-sol");
    await expect(save).toBeEnabled();
    await expect(model).not.toHaveAccessibleDescription(/Could not check spend cap availability/);
    await expect(cap).toHaveValue("20");
    await save.click();
    await expect(page.getByRole("region", { name: "Resident profile Failed defaults", exact: true })).toContainText("Revision 1");
  });
}
