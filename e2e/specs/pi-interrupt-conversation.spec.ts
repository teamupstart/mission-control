import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";

test.use({ daemonEnv: { MISSION_PI_EXTENSION: resolve("dist/pi-extension/index.js") } });

// The real Pi driver writes through the vendor fake, then the real transcript reader and
// SSE feed both conversation renderings. No provider or operator session is touched.
for (const view of ["chat", "terminal"] as const) {
  test(`Pi interrupts remain visible in ${view}, with empty and partial responses`, async ({ dashboard, daemon }) => {
    const installed = await dashboard.request.post(`${daemon.baseURL}/api/setup/install`, {
      data: { id: "pi-integration" },
    });
    expect(installed.ok(), await installed.text()).toBe(true);
    expect((await dashboard.request.put(`${daemon.baseURL}/api/harnesses/config`, {
      data: { sessionRuntime: { pi: "sdk" } },
    })).ok()).toBe(true);
    expect((await dashboard.request.put(`${daemon.baseURL}/api/ui/config`, {
      data: { conversationView: view },
    })).ok()).toBe(true);
    await dashboard.reload();
    await dashboard.getByRole("button", { name: "Dispatch" }).click();
    const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
    await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
    await dashboard.keyboard.press("Escape");
    await dialog.getByPlaceholder("What should this agent do?").fill("Check Pi conversation interrupts");
    await dialog.getByLabel("Agent").selectOption("pi");
    await dialog.getByRole("combobox", { name: /^Model/ }).selectOption("amazon-bedrock/deepseek.v3.2");
    await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
    await expectContentClearsBorder(dialog);
    await dialog.getByRole("button", { name: "Dispatch now" }).click();
    await expect(dialog).toBeHidden();
    const row = dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first();
    await row.click();
    const detail = dashboard.locator(".console-detail");
    const composer = detail.getByPlaceholder(view === "chat" ? /^Reply to this session/ : /^Send the next instruction/);
    const marker = detail.getByText("[Request interrupted by user]", { exact: true });
    await expect(detail.getByText(/pi answered: Check Pi conversation interrupts/)).toBeVisible();
    for (const [index, prompt] of ["Wait SLOWLY", "Wait SLOWLY with PARTIAL output"].entries()) {
      await composer.fill(prompt);
      await composer.press("Enter");
      await expect(detail.locator("span.badge").first()).toHaveText("working");
      if (index === 0) await composer.press("Control+c");
      else await detail.getByRole("button", { name: /^interrupt\b/ }).click();
      await expect(marker).toHaveCount(index + 1);
      await expect(marker.last()).toBeVisible();
    }
    await expect(detail.getByText("Pi response before interruption", { exact: true })).toBeVisible();
    await composer.fill("carry on");
    await composer.press("Enter");
    await expect(detail.getByText("pi answered: carry on", { exact: false })).toBeVisible();
    await dashboard.reload();
    await row.click();
    await expect(marker).toHaveCount(2);
    await expect(detail.getByText("Pi response before interruption", { exact: true })).toBeVisible();
    await expect(detail.getByText("pi answered: carry on", { exact: false })).toBeVisible();
    if (process.env.MC_E2E_EVIDENCE === "1") {
      const dir = artifactsDir("pi-interrupt-conversation");
      mkdirSync(dir, { recursive: true });
      await dashboard.mouse.move(0, 0);
      await detail.screenshot({ path: join(dir, `${view}-interrupts.png`) });
    }
  });
}
