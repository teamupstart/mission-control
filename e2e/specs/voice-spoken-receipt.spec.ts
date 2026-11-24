import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Session, Task } from "../../src/shared/types.ts";
import { VOICE_REQUIRED_FLAGS } from "../../src/shared/voice.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
import { handOver, hasTmux, paneSession, PANE_AGENT_DAEMON, startPaneAgent } from "../fixtures/pane-agent.ts";
import { expect, test } from "../fixtures/test.ts";
import { say } from "../fixtures/voice.ts";

test.use(PANE_AGENT_DAEMON);
test.skip(!hasTmux(), "tmux is required for terminal pickup");

test("an open terminal conversation restores Spoken when its delivery receipt commits after the native turn", async ({ dashboard, daemon, request }) => {
  test.setTimeout(90_000);
  const pane = startPaneAgent(daemon, { turns: true, prefix: "mc-spoken-receipt" });
  try {
    const id = await paneSession(daemon, pane);
    for (const flag of [...VOICE_REQUIRED_FLAGS, "voice"]) {
      expect((await request.put(daemon.baseURL + "/api/feature-flags", { data: { kind: "flag", id: flag, enabled: true } })).ok()).toBe(true);
    }
    expect((await request.put(daemon.baseURL + "/api/voice/config", { data: { muted: false, cancelWindow: { enabled: false } } })).ok()).toBe(true);
    const created = await request.post(daemon.baseURL + "/api/tasks", { data: {
      repoRoot: daemon.repo, title: "Check the terminal receipt", intent: "Inspect a build", callSign: "Steve",
      kind: "ship", agent: "claude", workflowId: null, backlog: true,
    } });
    expect(created.ok(), await created.text()).toBe(true);
    await handOver(daemon, (await created.json() as Task).id, id);
    const sessions = await (await request.get(daemon.baseURL + "/api/sessions")).json() as Session[];
    const session = sessions.find(s => s.id === id)!;
    expect(session.runtime).toBe("terminal");
    const path = session.transcriptPath!;
    const line = (uuid: string, content: string) => JSON.stringify({ type: "user", uuid,
      timestamp: new Date().toISOString(), message: { role: "user", content } }) + "\n";
    writeFileSync(path, line("before", "Before the spoken instruction"));
    await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").filter({ hasText: session.name }).first().click();
    await expect(dashboard.getByText("Before the spoken instruction", { exact: true })).toBeVisible();
    withDaemonDb(daemon, db => db.exec(`CREATE TRIGGER delay_spoken_receipt BEFORE DELETE ON pending_turns
      WHEN OLD.spoken_words IS NOT NULL BEGIN SELECT RAISE(ABORT, 'receipt deliberately delayed'); END`));
    const words = "inspect the red build";
    expect(await (await say(daemon, "Steve, " + words)).json()).toEqual({ accepted: true });
    await expect.poll(() => pane.turns().find(text => text.startsWith(words)), { timeout: 30_000 }).toContain("post a report");
    const payload = pane.turns().find(text => text.startsWith(words))!;
    appendFileSync(path, line("spoken-native", payload));
    const actual = dashboard.locator("article.turn-user:not(.pending-turn)").filter({ hasText: words });
    await expect(actual).toContainText("When you have finished this, post a report.");
    await expect(actual.getByText("Spoken", { exact: true })).toHaveCount(0);
    withDaemonDb(daemon, db => db.exec("DROP TRIGGER delay_spoken_receipt"));
    await expect(actual.getByText("Spoken", { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(actual).toHaveCount(1);
    await actual.getByText("What the agent received", { exact: true }).click();
    await expect(actual.locator(".review-received-text")).toHaveText(payload);
    if (process.env.MC_E2E_EVIDENCE === "1") {
      const dir = artifactsDir("voice-spoken-delayed-receipt");
      mkdirSync(dir, { recursive: true });
      await dashboard.mouse.move(0, 0);
      await dashboard.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await expect(dashboard.getByRole("tooltip")).toHaveCount(0);
      await actual.screenshot({ path: join(dir, "confirmed.png") });
    }

    const second = "inspect the green build";
    expect(await (await say(daemon, "Steve, " + second)).json()).toEqual({ accepted: true });
    await expect.poll(() => pane.turns().find(text => text.startsWith(second)), { timeout: 30_000 }).toContain("post a report");
    const secondPayload = pane.turns().find(text => text.startsWith(second))!;
    appendFileSync(path, line("second-native", secondPayload));
    const green = dashboard.locator("article.turn-user:not(.pending-turn)").filter({ hasText: second });
    await expect(green.getByText("Spoken", { exact: true })).toBeVisible();
    // Rewrite the first native record in place, preserving its UUID and changing its words
    // to another recorded payload. Reopen the transcript to inspect those actual bytes.
    writeFileSync(path, readFileSync(path, "utf8").replace(words, second));
    await dashboard.reload();
    await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").filter({ hasText: session.name }).first().click();
    await expect(green).toHaveCount(2);
    await expect(green.first()).toContainText("When you have finished this, post a report.");
    await expect(green.first().getByText("Spoken", { exact: true })).toHaveCount(0);
    await expect(green.last().getByText("Spoken", { exact: true })).toBeVisible();
    if (process.env.MC_E2E_EVIDENCE === "1") {
      const dir = artifactsDir("voice-spoken-rewritten-native");
      mkdirSync(dir, { recursive: true });
      await green.first().screenshot({ path: join(dir, "rewritten.png") });
    }
  } finally {
    pane.cleanup();
  }
});
