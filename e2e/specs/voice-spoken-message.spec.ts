import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { say, voiceToken } from "../fixtures/voice.ts";
import type { Session, Task } from "../../src/shared/types.ts";

test("spoken words and the exact delivered payload in both conversation views", async ({ dashboard: page, daemon, request }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 1200 });
  for (const id of ["async-input", "inbox", "filed-plan-decisions", "task-hibernation", "voice"]) {
    expect((await request.put(`${daemon.baseURL}/api/feature-flags`, { data: { kind: "flag", id, enabled: true } })).ok()).toBe(true);
  }
  expect((await request.put(`${daemon.baseURL}/api/voice/config`, { data: { muted: false, cancelWindow: { enabled: false } } })).ok()).toBe(true);
  const created = await request.post(`${daemon.baseURL}/api/tasks`, { data: {
    repoRoot: daemon.repo, title: "Inspect the build", intent: "Inspect the build", callSign: "Steve",
    kind: "ship", agent: "claude", runtime: "sdk", workflowId: null,
  } });
  expect(created.ok(), await created.text()).toBe(true);
  const task = await created.json() as Task;
  let session!: Session;
  await expect.poll(async () => {
    const sessions = await (await request.get(`${daemon.baseURL}/api/sessions`)).json() as Session[];
    session = sessions.find(s => s.task?.id === task.id)!;
    return session?.agentSessionId && session.state;
  }, { timeout: 60_000 }).toBe("idle");
  const parked = await request.post(`${daemon.baseURL}/api/sessions/${session.id}/hibernate`);
  expect(parked.ok(), await parked.text()).toBe(true);
  expect(await (await say(daemon, "Steve, resume the inspection")).json()).toEqual({ accepted: true });
  await expect.poll(async () => {
    const entries = (await (await request.get(`${daemon.baseURL}/api/voice/heard`)).json()).entries;
    return entries[0]?.outcome;
  }).toBe("queued");
  await page.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row", { hasText: session.name }).first().click();
  await expect(page.getByText(/Mock reply to: resume the inspection/).first()).toBeVisible({ timeout: 30_000 });
  const title = "Which build should I inspect?";
  const filed = await request.post(`${daemon.baseURL}/mcp/reviews`, {
    headers: { "x-harness-token": voiceToken(daemon) },
    data: { env: {}, cwd: session.cwd, asyncCapable: true, kind: "input", title, body: title, snoozable: true },
  });
  expect(filed.ok(), await filed.text()).toBe(true);
  const ask = await filed.json();
  expect(ask.wait).toBe("message");
  expect(await (await say(daemon, "Steve, check the build")).json()).toEqual({ accepted: true });
  for (const view of ["chat", "terminal"]) {
    expect((await request.put(`${daemon.baseURL}/api/ui/config`, { data: { conversationView: view } })).ok()).toBe(true);
    await page.reload();
    await page.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row", { hasText: session.name }).first().click();
    const turn = page.getByRole("article").filter({ has: page.getByText("Spoken", { exact: true }), hasText: "check the build" });
    await expect(turn.getByText("check the build", { exact: true })).toBeVisible({ timeout: 30_000 });
    const payload = turn.locator(".review-received-text");
    await expect(payload).toBeHidden();
    const capture = async (state: string) => {
      if (process.env.MC_E2E_EVIDENCE !== "1") return;
      const dir = artifactsDir("voice-spoken-message");
      mkdirSync(dir, { recursive: true });
      await page.mouse.move(0, 0);
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await turn.evaluate(el => el.scrollIntoView({ block: "center" }));
      await expect(page.getByRole("tooltip")).toHaveCount(0);
      await turn.screenshot({ path: join(dir, `${view}-${state}.png`) });
    };
    await capture("closed");
    await turn.getByText("What the agent received", { exact: true }).click();
    await expect(payload).toHaveText(`check the build\n\nYour open questions:\n- ${ask.id}: ${title}\nWithdraw any question this message settles, with a reason.\n\nWhen you have finished this, post a report.`);
    // Match the existing review-answer disclosure in both conversation renderings.
    await expect(payload).toHaveCSS("padding", "8px 10px");
    await expect(payload).toHaveCSS("font-size", "12px");
    await expect(payload).toHaveCSS("white-space", "pre-wrap");
    await expect(turn.locator("summary")).toHaveCSS("font-size", "11px");
    await capture("open");
  }
  const resident = await request.post(`${daemon.baseURL}/api/residents/profiles`, { data: { settings: {
    identity: { name: "Marlowe", description: "Reviews builds" }, persona: { personaId: "builtin:code-risk-reviewer" },
  } } });
  expect(resident.ok(), await resident.text()).toBe(true);
  expect(await (await say(daemon, "Marlowe, check the build")).json()).toEqual({ accepted: true });
  const feedback = page.getByRole("status").filter({ hasText: "Marlowe isn't running. Nothing was sent. Relaunch the resident." });
  await expect(feedback).toBeVisible();
  if (process.env.MC_E2E_EVIDENCE === "1") {
    await feedback.screenshot({ path: join(artifactsDir("voice-spoken-message"), "not-running.png") });
  }
});
