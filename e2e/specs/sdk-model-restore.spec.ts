import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Session } from "../../src/shared/types.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
import { expect, test } from "../fixtures/test.ts";

test.use({ daemonEnv: {
  MC_E2E_CODEX_EFFORT: "medium",
  MC_E2E_CODEX_THREAD_ID: "01999999-0000-7000-8000-000000000001",
  MISSION_RUNTIME_META_POLL_MS: "400",
} });

for (const { agent, initial, selected } of [
  { agent: "claude", initial: "claude-opus-5", selected: "claude-opus-5-5" },
  { agent: "codex", initial: "gpt-5.6-sol", selected: "gpt-6.1-sol" },
] as const) {
  for (const stop of ["shutdown", "crash"] as const) {
    test(`${agent} keeps the upgraded model after ${stop} and daemon restart`, async ({ dashboard, daemon }) => {
      await dashboard.getByRole("button", { name: "Dispatch" }).click();
      const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
      await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
      await dashboard.keyboard.press("Escape");
      await dialog.getByPlaceholder("What should this agent do?").fill("prove the model survives restart");
      await dialog.getByRole("combobox", { name: /^Agent/ }).selectOption(agent);
      await dialog.getByRole("combobox", { name: /^Model/ }).selectOption(initial);
      await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
      await expectContentClearsBorder(dialog);
      await dialog.getByRole("button", { name: "Dispatch now" }).click();
      await expect(dialog).toBeHidden();

      const live = async (): Promise<Session | undefined> =>
        (await (await dashboard.request.get(`${daemon.baseURL}/api/sessions`)).json())[0];
      await expect.poll(async () => (await live())?.state).toBe("idle");
      const before = (await live())!;
      await expect.poll(async () => (await live())?.meta?.modelId).toBe(initial);
      // Exercise the production model route with the exact id, including a model newer
      // than the fixture catalog. Catalog contents must not rewrite a saved selection.
      const changed = await dashboard.request.post(`${daemon.baseURL}/api/sessions/${encodeURIComponent(before.id)}/model`, {
        data: { model: selected },
      });
      expect(changed.ok(), await changed.text()).toBe(true);
      expect((await live())?.configuredModel).toBe(selected);

      // No turn has used the new choice yet: recovery must use the durable selection,
      // even though the transcript still describes the older model.
      // Closing the app also closes its renderer's SSE connection. An open stream
      // would keep server.close() waiting during the graceful shutdown case.
      await dashboard.goto("about:blank");
      await daemon[stop]();
      const saved = withDaemonDb(daemon, db => db.prepare(
        "SELECT model, status, agent_session_id FROM sdk_sessions WHERE id = ?",
      ).get(before.id));
      expect(saved).toEqual({
        model: selected,
        status: stop === "shutdown" ? "suspended" : "running",
        agent_session_id: before.agentSessionId,
      });
      await daemon.restart();
      await expect.poll(async () => {
        const session = await live();
        return [session?.id, session?.agentSessionId, session?.configuredModel, session?.state];
      }).toEqual([before.id, before.agentSessionId, selected, "idle"]);

      await dashboard.goto(`${daemon.baseURL}/#/fleet`);
      await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
      const detail = dashboard.locator(".console-detail");
      const chip = detail.getByRole("button", { name: /^Model:/ });
      await expect(chip).toHaveAccessibleName(new RegExp(`^Model: ${selected.replaceAll(".", "\\.")}`));
      const reply = detail.getByPlaceholder(/^Reply to this session/);
      await reply.fill("use the saved model after restart");
      await reply.press("Enter");
      await expect(detail.locator(".turn").getByText("Mock reply to: use the saved model after restart", { exact: true })).toBeVisible();
      await expect(detail.getByText(/^Queued\. Press Up Arrow/)).toBeHidden();
      await expect.poll(async () => (await live())?.meta?.modelId).toBe(selected);
      await expect.poll(async () => (await live())?.state).toBe("idle");
      await expect(chip).toHaveAccessibleName(`Model: ${selected}. Change model for this session`);
      if (process.env.MC_E2E_EVIDENCE === "1") {
        const dir = artifactsDir("sdk-model-restore");
        mkdirSync(dir, { recursive: true });
        await dashboard.mouse.move(0, 0);
        await detail.screenshot({ path: join(dir, `${agent}-${stop}-restored-model.png`) });
      }
    });
  }
}
