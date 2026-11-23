import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import type { Session } from "../../src/shared/types.ts";
import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";

test.use({ daemonEnv: { MC_E2E_CODEX_EFFORT: "medium", MISSION_RUNTIME_META_POLL_MS: "200" } });

for (const family of ["sol", "terra"]) {
  test(`${family} model observation survives large outputs without reverting to an older turn`, async ({ dashboard, daemon }) => {
    const older = `gpt-5.6-${family}`;
    const newer = `gpt-6.1-${family}`;
    await dashboard.getByRole("button", { name: "Dispatch" }).click();
    const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
    await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
    await dashboard.keyboard.press("Escape");
    await dialog.getByPlaceholder("What should this agent do?").fill("exercise model continuity");
    await dialog.getByRole("combobox", { name: /^Agent/ }).selectOption("codex");
    await dialog.getByRole("combobox", { name: /^Model/ }).selectOption(older);
    await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
    await expectContentClearsBorder(dialog);
    await dialog.getByRole("button", { name: "Dispatch now" }).click();
    await expect(dialog).toBeHidden();
    const live = async (): Promise<Session> => (await (await dashboard.request.get(`${daemon.baseURL}/api/sessions`)).json())[0];
    await expect.poll(async () => (await live())?.state, { timeout: 30_000 }).toBe("idle");
    await expect.poll(async () => (await live()).meta?.modelId).toBe(older);
    const session = await live();
    const output = JSON.stringify({ type: "response_item", payload: { type: "function_call_output", output: "x".repeat(300_000) } }) + "\n";
    appendFileSync(session.transcriptPath!, output);

    // Use the real model-control route for a newer id absent from the fixture's catalog.
    // Model-picker clicks themselves are covered in model-chip-sdk.spec.ts.
    const changed = await dashboard.request.post(`${daemon.baseURL}/api/sessions/${encodeURIComponent(session.id)}/model`, {
      data: { model: newer },
    });
    expect(changed.ok(), await changed.text()).toBe(true);
    await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
    const detail = dashboard.locator(".console-detail");
    const chip = detail.getByRole("button", { name: /^Model:/ });
    // A growing rewrite keeps the old inode and both end windows, but changes the
    // observed turn outside the tail. The pending badge must become confirmed.
    const previous = readFileSync(session.transcriptPath!, "utf8");
    const rewritten = previous.replaceAll(JSON.stringify(older), JSON.stringify(newer));
    expect(rewritten).not.toBe(previous);
    const inode = statSync(session.transcriptPath!).ino;
    writeFileSync(session.transcriptPath!, rewritten + JSON.stringify({ type: "event_msg", payload: {
      type: "token_count", info: { last_token_usage: { total_tokens: 50 }, model_context_window: 1000 },
    } }) + "\n");
    expect(statSync(session.transcriptPath!).ino).toBe(inode);
    await expect.poll(async () => (await live()).meta?.contextTokens).toBe(50);
    await expect(chip).toHaveAccessibleName(`Model: ${newer}. Change model for this session`);
    expect((await live()).meta?.modelId).toBe(newer);
    const composer = detail.getByPlaceholder(/^Reply to this session/);
    await composer.fill("use the selected model for the next turn");
    await composer.press("Enter");
    await expect(detail.getByText("Mock reply to: use the selected model for the next turn", { exact: true })).toBeVisible();
    await expect.poll(async () => (await live()).meta?.modelId).toBe(newer);
    await expect.poll(async () => (await live()).state).toBe("idle");
    await expect(chip).toHaveAccessibleName(`Model: ${newer}. Change model for this session`);

    // The newest turn now falls outside BOTH old read windows. Fresh token records
    // prove the poller has consumed each append before we assert model continuity.
    for (const contextTokens of [100, 200, 300]) {
      appendFileSync(session.transcriptPath!, output + JSON.stringify({ type: "event_msg", payload: {
        type: "token_count", info: { last_token_usage: { total_tokens: contextTokens }, model_context_window: 1000 },
      } }) + "\n");
      await expect.poll(async () => (await live()).meta?.contextTokens).toBe(contextTokens);
      expect((await live()).meta?.modelId).toBe(newer);
      await expect(chip).toHaveAccessibleName(`Model: ${newer}. Change model for this session`);
      await expect(chip.locator(".rt-think-next")).toHaveCount(0);
    }
    // The fake resumes into a fresh log. Supply the retained conversation behind
    // its new identity header to exercise the cold reader as a real resume does.
    const history = readFileSync(session.transcriptPath!, "utf8");
    await daemon.crash();
    await daemon.restart();
    await expect.poll(async () => (await live())?.transcriptPath).not.toBe(session.transcriptPath);
    await expect.poll(async () => Boolean((await live())?.transcriptPath)).toBe(true);
    appendFileSync((await live()).transcriptPath!, history.slice(history.indexOf("\n") + 1));
    await expect.poll(async () => (await live()).meta?.modelId).toBe(newer);
    expect((await live()).configuredModel).toBe(newer);
    await dashboard.reload();
    await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
    await expect(chip).toHaveAccessibleName(`Model: ${newer}. Change model for this session`);
    if (process.env.MC_E2E_EVIDENCE) {
      mkdirSync(artifactsDir("model-continuity"), { recursive: true });
      await dashboard.mouse.move(0, 0);
      await detail.screenshot({ path: `${artifactsDir("model-continuity")}${family}.png` });
    }
  });
}
