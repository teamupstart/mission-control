import { mkdirSync } from "node:fs";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";

const OPUS = "claude-opus-5-5";
const FABLE = "claude-fable-5-1";

test("Claude's installed models reach Settings and Dispatch as canonical model ids", async ({ dashboard, daemon }) => {
  await dashboard.goto(`${daemon.baseURL}/#/settings`);
  await dashboard.getByRole("tab", { name: /Harnesses/ }).click();
  const model = dashboard.getByRole("combobox", { name: "Default model for dispatched Claude Code sessions" });
  await expect(model.locator(`option[value="${OPUS}"]`)).toHaveText("Opus 5.5");
  await expect(model.locator(`option[value="${FABLE}"]`)).toHaveText("Fable 5.1");
  await expect(model.locator('option[value="default"]')).toHaveCount(0);
  await expect(model.locator('option[value="opusplan"]')).toHaveCount(0);
  await model.selectOption(OPUS);
  await expect.poll(async () => {
    const response = await dashboard.request.get(`${daemon.baseURL}/api/harnesses/config`);
    return ((await response.json()) as { defaultModel: { claude: string | null } }).defaultModel.claude;
  }).toBe(OPUS);

  await dashboard.getByRole("button", { name: "← Fleet" }).click();
  await dashboard.getByRole("button", { name: "Dispatch" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  const dispatchModel = dialog.getByLabel("Model");
  await expect(dispatchModel.locator(`option[value="${OPUS}"]`)).toContainText("Opus 5.5");
  await expect(dispatchModel.locator(`option[value="${FABLE}"]`)).toContainText("Fable 5.1");
  await dispatchModel.selectOption(OPUS);
  await expect(dispatchModel).toHaveValue(OPUS);
  if (process.env.MC_E2E_EVIDENCE) {
    const dir = artifactsDir("claude-model-catalog");
    mkdirSync(dir, { recursive: true });
    await dialog.screenshot({ path: `${dir}opus-5-5-dispatch.png`, animations: "disabled" });
  }
});
