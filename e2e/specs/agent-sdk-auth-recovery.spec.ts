import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { recordsIn } from "../fixtures/records.ts";

const EVIDENCE = artifactsDir("agent-sdk-auth-recovery");

async function api<T>(daemon: DaemonHandle, path: string): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`);
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  return await response.json() as T;
}

async function dispatch(page: Page, daemon: DaemonHandle): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill("start authenticated");
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
}

test("a Claude Agent SDK session reloads external login state on its next turn", async ({
  dashboard,
  daemon,
}) => {
  await dispatch(dashboard, daemon);

  const rail = dashboard.getByRole("navigation", { name: "Sessions" });
  await rail.locator("button.rail-row").first().click();
  const detail = dashboard.locator(".console-detail");
  const reply = detail.getByPlaceholder(/^Reply to this session/);
  const turn = (text: string) => detail.locator(".turn").getByText(text, { exact: true });

  await expect(turn("Mock reply to: start authenticated")).toBeVisible();
  await expect.poll(async () => {
    const [session] = await api<Array<{ id: string; state: string }>>(daemon, "/api/sessions");
    return session?.state;
  }).toBe("idle");
  const [before] = await api<Array<{ id: string; agentSessionId: string | null }>>(
    daemon,
    "/api/sessions",
  );
  expect(before?.agentSessionId).toBeTruthy();

  await reply.fill("E2E_EXPIRE_CLAUDE_AUTH");
  await reply.press("Enter");
  await expect(turn("Not logged in · Please run /login")).toBeVisible();
  await expect.poll(async () => {
    const [session] = await api<Array<{ state: string }>>(daemon, "/api/sessions");
    return session?.state;
  }).toBe("idle");

  // Stand in for `claude /login` in another terminal. The running fake cached the old state,
  // so only a new subprocess can observe this file.
  writeFileSync(join(daemon.recordDir, "claude-auth-restored"), "ok\n");

  const sdkInvocations = (): Array<{ argv: string[] }> =>
    recordsIn<{ argv: string[] }>(join(daemon.recordDir, "claude"))
      .filter((record) =>
        record.argv.includes("--input-format") && !record.argv.includes("--setting-sources="),
      );
  await reply.fill("continue after external login");
  await reply.press("Enter");
  await expect.poll(() => sdkInvocations().length).toBe(2);
  await expect(turn("Mock reply to: continue after external login")).toBeVisible();
  await expect(detail.getByText(/^Queued\. Press Up Arrow/)).toBeHidden();

  const [after] = await api<Array<{ id: string; agentSessionId: string | null }>>(
    daemon,
    "/api/sessions",
  );
  expect(after?.id).toBe(before?.id);
  expect(after?.agentSessionId).toBe(before?.agentSessionId);

  const resumed = sdkInvocations().find((record) =>
    record.argv.some((value) => value.startsWith("--resume=")),
  );
  expect(resumed?.argv.find((value) => value.startsWith("--resume=")))
    .toBe(`--resume=${before?.agentSessionId}`);

  if (process.env.MC_E2E_EVIDENCE === "1") {
    mkdirSync(EVIDENCE, { recursive: true });
    await detail.screenshot({ path: join(EVIDENCE, "external-login-recovery.png") });
    console.log("CAPTURED e2e/.artifacts/agent-sdk-auth-recovery/external-login-recovery.png");
  }
});
