import { appendFileSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Session, Task } from "../../src/shared/types.ts";
import { VOICE_REQUIRED_FLAGS } from "../../src/shared/voice.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
import { handOver, hasTmux, paneSession, PANE_AGENT_DAEMON, startPaneAgent } from "../fixtures/pane-agent.ts";
import { expect, test } from "../fixtures/test.ts";
import { say } from "../fixtures/voice.ts";

test.use({ ...PANE_AGENT_DAEMON, daemonEnv: { ...PANE_AGENT_DAEMON.daemonEnv,
  NODE_OPTIONS: "--import=" + new URL("../fixtures/spoken-proof-worker.mjs", import.meta.url).href,
} });
test.skip(!hasTmux(), "tmux is required for terminal pickup");

test("a terminal conversation restores late spoken receipts and rechecks rewritten native records", async ({ dashboard, daemon, request }) => {
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
    const line = (uuid: string, content: string, ts = Date.now()) => JSON.stringify({ type: "user", uuid,
      timestamp: new Date(ts).toISOString(), message: { role: "user", content } }) + "\n";
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

    // Lose only disclosure verification. Native messages keep arriving on the same open
    // panel, then the original row recovers its disclosure without another native write.
    const pauseProof = join(daemon.home, "pause-spoken-proof");
    writeFileSync(pauseProof, "");
    writeFileSync(path, readFileSync(path));
    await expect(actual.getByText("Spoken", { exact: true })).toHaveCount(0);
    await expect(actual).toContainText(payload);
    const progressWhileDeferred = "New terminal output while proof is unavailable";
    appendFileSync(path, line("while-proof-paused", progressWhileDeferred));
    await expect(dashboard.getByText(progressWhileDeferred, { exact: true })).toBeVisible();
    await actual.screenshot({ path: test.info().outputPath("unverified-spoken-frame.png") });
    unlinkSync(pauseProof);
    await expect(actual.getByText("Spoken", { exact: true })).toBeVisible({ timeout: 20_000 });
    await actual.getByText("What the agent received", { exact: true }).click();
    await expect(actual.locator(".review-received-text")).toHaveText(payload);
    await dashboard.mouse.move(0, 0);
    await dashboard.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await expect(dashboard.getByRole("tooltip")).toHaveCount(0);
    await actual.screenshot({ path: test.info().outputPath("recovered-spoken-disclosure.png") });

    const second = "inspect the green build";
    expect(await (await say(daemon, "Steve, " + second)).json()).toEqual({ accepted: true });
    await expect.poll(() => pane.turns().find(text => text.startsWith(second)), { timeout: 30_000 }).toContain("post a report");
    const secondPayload = pane.turns().find(text => text.startsWith(second))!;
    // More than one forward scan page. The binder has already passed the provisional
    // record by the time the runtime rewrites it, keeping the same inode and file size.
    const provisional = "inspect the black build";
    const filler = Array.from({ length: 65 }, (_, i) => JSON.stringify({ type: "user", uuid: "later-" + i,
      timestamp: new Date().toISOString(), padding: "x".repeat(9000), message: { role: "user", content: "Later turn " + i } })).join("\n") + "\n";
    appendFileSync(path, line("second-native", secondPayload.replace(second, provisional)) + filler);
    await expect(dashboard.locator("article.turn-user").filter({ hasText: provisional })).toBeVisible();
    writeFileSync(path, readFileSync(path, "utf8").replace(provisional, second));
    const green = dashboard.locator("article.turn-user:not(.pending-turn)").filter({ hasText: second });
    await expect(green.getByText("Spoken", { exact: true })).toBeVisible();
    if (process.env.MC_E2E_EVIDENCE === "1") {
      const dir = artifactsDir("voice-spoken-rewritten-suffix");
      mkdirSync(dir, { recursive: true });
      await green.getByText("What the agent received", { exact: true }).click();
      await expect(green.locator(".review-received-text")).toHaveText(secondPayload);
      await dashboard.mouse.move(0, 0);
      await dashboard.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await expect(dashboard.getByRole("tooltip")).toHaveCount(0);
      await green.screenshot({ path: join(dir, "rescanned.png") });
    }
    // Change the second record to the first one's words. Its reused ID is stale,
    // while the first record and its handoff prefix are still intact.
    writeFileSync(path, readFileSync(path, "utf8").replace(second, words) + "\n\n\n\n");
    await expect(actual).toHaveCount(2);
    await expect(actual.last()).toContainText("When you have finished this, post a report.");
    await expect(actual.last().getByText("Spoken", { exact: true })).toHaveCount(0);
    await expect(actual.first().getByText("Spoken", { exact: true })).toBeVisible();
    if (process.env.MC_E2E_EVIDENCE === "1") {
      const dir = artifactsDir("voice-spoken-rewritten-native");
      mkdirSync(dir, { recursive: true });
      await actual.last().screenshot({ path: join(dir, "rewritten.png") });
    }
    const progressText = "Build output continues while the transcript grows";
    let writes = 0;
    const writer = setInterval(() => {
      appendFileSync(path, ++writes === 2 ? line("live-progress", progressText) : "\n");
    }, 10);
    try {
      const progress = dashboard.locator("article.turn-user").filter({ hasText: progressText });
      await expect(progress).toBeVisible();
      await expect(actual.first().getByText("Spoken", { exact: true })).toBeVisible();
      if (process.env.MC_E2E_EVIDENCE === "1") {
        const dir = artifactsDir("voice-spoken-active-transcript");
        mkdirSync(dir, { recursive: true });
        await progress.screenshot({ path: join(dir, "growing.png") });
      }
    } finally {
      clearInterval(writer);
    }
    // The runtime has already confirmed this turn. A later binding must change the
    // existing frame even if the file never changes again and no one reopens the view.
    withDaemonDb(daemon, db => db.exec(`CREATE TRIGGER delay_native_binding BEFORE UPDATE OF message_id ON session_spoken_turns
      WHEN NEW.message_id IS NOT NULL BEGIN SELECT RAISE(ABORT, 'native binding delayed'); END`));
    const lateWords = "inspect the final build";
    expect(await (await say(daemon, "Steve, " + lateWords)).json()).toEqual({ accepted: true });
    await expect.poll(() => pane.turns().find(text => text.startsWith(lateWords)), { timeout: 30_000 }).toContain("post a report");
    const latePayload = pane.turns().find(text => text.startsWith(lateWords))!;
    await expect.poll(() => withDaemonDb(daemon, db => db.prepare(
      "SELECT runtime_confirmed_at FROM session_spoken_turns WHERE spoken_words = ?").get(lateWords)?.runtime_confirmed_at)).toBeTruthy();
    // The native writer flushes an older identical typed turn after the new handoff.
    appendFileSync(path, line("buffered-older", latePayload, Date.now() - 60_000) + line("late-native-binding", latePayload));
    const repeated = dashboard.locator("article.turn-user:not(.pending-turn)").filter({ hasText: lateWords });
    await expect(repeated).toHaveCount(2);
    const late = repeated.last();
    await expect(late).toContainText("When you have finished this, post a report.");
    await expect(late.getByText("Spoken", { exact: true })).toHaveCount(0);
    withDaemonDb(daemon, db => db.exec("DROP TRIGGER delay_native_binding"));
    await expect(late.getByText("Spoken", { exact: true })).toBeVisible();
    await expect(repeated.first().getByText("Spoken", { exact: true })).toHaveCount(0);
    await expect(repeated.first()).toContainText(latePayload);
    await late.getByText("What the agent received", { exact: true }).click();
    await expect(late.locator(".review-received-text")).toHaveText(latePayload);
    await repeated.first().screenshot({ path: test.info().outputPath("buffered-typed-turn.png") });
    await late.screenshot({ path: test.info().outputPath("matching-spoken-turn.png") });
    if (process.env.MC_E2E_EVIDENCE === "1") {
      const dir = artifactsDir("voice-spoken-late-binding");
      mkdirSync(dir, { recursive: true });
      await dashboard.mouse.move(0, 0);
      await late.screenshot({ path: join(dir, "bound.png") });
    }
    // Even identical bytes and native IDs on a replacement inode belong to another file.
    writeFileSync(path + ".next", readFileSync(path));
    renameSync(path + ".next", path);
    await expect(late.getByText("Spoken", { exact: true })).toHaveCount(0);
    await expect(late).toContainText(latePayload);
    await late.screenshot({ path: test.info().outputPath("reused-native-id.png") });

    const oversizedWords = "check the archived build";
    // The typed record already exists at handoff, even though its timestamp and payload
    // will be identical to the native delivery. Its author clock runs one minute ahead.
    const timestamp = Date.now() + 60_000;
    const expectedPayload = latePayload.replace(lateWords, oversizedWords);
    appendFileSync(path, line("archived-before-handoff", expectedPayload, timestamp));
    expect(await (await say(daemon, "Steve, " + oversizedWords)).json()).toEqual({ accepted: true });
    await expect.poll(() => pane.turns().find(text => text.startsWith(oversizedWords)), { timeout: 30_000 }).toContain("post a report");
    const oversizedPayload = pane.turns().find(text => text.startsWith(oversizedWords))!;
    expect(oversizedPayload).toBe(expectedPayload);
    const prefix = readFileSync(path, "utf8");
    const original = line("archived-original", oversizedPayload, timestamp);
    const copy = line("archived-typed-copy", oversizedPayload, timestamp + 1);
    appendFileSync(path, JSON.stringify({ ...JSON.parse(original), padding: "x".repeat(17 * 1024 * 1024) }) + "\n" + copy);
    const archived = dashboard.locator("article.turn-user:not(.pending-turn)").filter({ hasText: oversizedWords });
    await expect(archived.last()).toContainText(oversizedPayload);
    await expect(archived.getByText("Spoken", { exact: true })).toHaveCount(0);
    writeFileSync(path, prefix + original + copy);
    await expect(archived).toHaveCount(3);
    await expect(archived.nth(1).getByText("Spoken", { exact: true })).toBeVisible();
    await expect(archived.last()).toContainText(oversizedPayload);
    await expect(archived.last().getByText("Spoken", { exact: true })).toHaveCount(0);
    writeFileSync(path, prefix);
    await expect(archived).toHaveCount(1);
    await expect(archived).toContainText(oversizedPayload);
    await expect(archived.getByText("Spoken", { exact: true })).toHaveCount(0);
  } finally {
    pane.cleanup();
  }
});
