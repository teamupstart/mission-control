import { appendFileSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
import { say, voiceToken } from "../fixtures/voice.ts";
import type { ReviewItem, Session, Task } from "../../src/shared/types.ts";
import type { VoiceCard } from "../../src/shared/voice-routing.ts";
import { VOICE_REQUIRED_FLAGS } from "../../src/shared/voice.ts";

test("spoken words and the exact delivered payload in both conversation views", async ({ dashboard: page, daemon, request }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 1200 });
  for (const id of ["async-input", "inbox", "filed-plan-decisions", "task-hibernation", "voice"]) {
    expect((await request.put(`${daemon.baseURL}/api/feature-flags`, { data: { kind: "flag", id, enabled: true } })).ok()).toBe(true);
  }
  expect((await request.put(`${daemon.baseURL}/api/voice/config`, { data: { muted: false, cancelWindow: { enabled: true, seconds: 30 } } })).ok()).toBe(true);
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
  expect(await (await say(daemon, "Steve, resume the inspection", { id: "wake" })).json()).toEqual({ accepted: true });
  expect(await (await say(daemon, "Steve, check the result", { id: "after-wake" })).json()).toEqual({ accepted: true });
  for (const id of ["wake", "after-wake"]) {
    expect((await request.post(`${daemon.baseURL}/api/voice/cards/${id}/send-now`)).ok()).toBe(true);
    await expect.poll(async () => {
      const entries = (await (await request.get(`${daemon.baseURL}/api/voice/heard`)).json()).entries;
      return entries.find((entry: { id: string }) => entry.id === id)?.outcome;
    }).toBe("sent");
  }
  expect((await request.put(`${daemon.baseURL}/api/voice/config`, { data: { cancelWindow: { enabled: false } } })).ok()).toBe(true);
  await page.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row", { hasText: session.name }).first().click();
  await expect(page.getByText(/Mock reply to: resume the inspection/).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/Mock reply to: check the result/).first()).toBeVisible({ timeout: 30_000 });
  const title = "Which build should I inspect?";
  const filed = await request.post(`${daemon.baseURL}/mcp/reviews`, {
    headers: { "x-harness-token": voiceToken(daemon) },
    data: { env: {}, cwd: session.cwd, asyncCapable: true, kind: "input", title, body: title, snoozable: true },
  });
  expect(filed.ok(), await filed.text()).toBe(true);
  const ask = await filed.json();
  expect(ask.wait).toBe("message");
  // The fake CLI normally creates its file eagerly. Exercise delivery before a transcript exists.
  const nativePath = join(daemon.home, ".claude", "projects", session.cwd.replace(/[/.]/g, "-"), `${session.agentSessionId}.jsonl`);
  renameSync(nativePath, nativePath + ".before-spoken");
  withDaemonDb(daemon, db => db.exec(`CREATE TRIGGER delay_sdk_observation BEFORE UPDATE OF message_ts ON session_spoken_turns
    WHEN OLD.spoken_words = 'check the build' BEGIN SELECT RAISE(ABORT, 'SDK observation delayed'); END`));

  expect(await (await say(daemon, "Steve, check the build")).json()).toEqual({ accepted: true });
  await expect.poll(async () => (await (await request.get(`${daemon.baseURL}/api/voice/heard`)).json()).entries[0]?.outcome).toBe("sent");
  for (const view of ["chat", "terminal"]) {
    expect((await request.put(`${daemon.baseURL}/api/ui/config`, { data: { conversationView: view } })).ok()).toBe(true);
    const voice = (enabled: boolean) => request.put(`${daemon.baseURL}/api/feature-flags`, {
      data: { kind: "flag", id: "voice", enabled },
    });
    expect((await voice(false)).ok()).toBe(true);
    if (view === "terminal") {
      // Put the spoken turn on a history page. The native metadata occupies bytes, not screen space.
      const padding = "x".repeat(5800);
      const timestamp = new Date().toISOString();
      appendFileSync(nativePath, Array.from({ length: 110 }, (_, index) => JSON.stringify({
        type: "user", uuid: `later-${index}`, timestamp, padding,
        message: { role: "user", content: `Later native turn ${index}` },
      })).join("\n") + "\n");
    }
    await page.reload();
    await page.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row", { hasText: session.name }).first().click();
    const raw = page.getByRole("article").filter({ hasText: "check the build" })
      .filter({ hasText: "When you have finished this, post a report." });
    if (view === "terminal") {
      const older = page.getByRole("button", { name: "Load older messages" });
      await expect(older).toBeVisible();
      await expect(raw).toHaveCount(0);
      // Scrolling near the top loads history and removes the button before a click can land.
      await page.locator(".transcript-log").hover();
      await page.mouse.wheel(0, -100_000);
    }
    await expect(raw.first()).toBeVisible();
    await expect(raw.getByText("Spoken", { exact: true })).toHaveCount(0);
    expect((await voice(true)).ok()).toBe(true);
    const turn = page.getByRole("article").filter({ has: page.getByText("Spoken", { exact: true }), hasText: "check the build" });
    await expect(turn.getByText("check the build", { exact: true })).toBeVisible({ timeout: 30_000 });
    const payload = turn.locator(".review-received-text");
    await expect(payload).toBeHidden();
    const capture = async (state: string) => {
      if (process.env.MC_E2E_EVIDENCE !== "1") return;
      const dir = artifactsDir("voice-spoken-message-live-flag");
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
    if (process.env.MC_E2E_SDK_RECEIPT_EVIDENCE === "1" && view === "terminal") {
      const dir = artifactsDir("voice-spoken-sdk-observation");
      mkdirSync(dir, { recursive: true });
      await page.mouse.move(0, 0);
      await turn.screenshot({ path: join(dir, "write-unavailable.png") });
    }
  }
  const observation = () => withDaemonDb(daemon, db => db.prepare(
    "SELECT message_ts FROM session_spoken_turns WHERE spoken_words = 'check the build'").get()?.message_ts);
  expect(observation()).toBeNull();
  withDaemonDb(daemon, db => db.exec("DROP TRIGGER delay_sdk_observation"));
  await expect.poll(observation).toBeTruthy();
  const resident = await request.post(`${daemon.baseURL}/api/residents/profiles`, { data: { settings: {
    identity: { name: "Marlowe", description: "Reviews builds" }, persona: { personaId: "builtin:code-risk-reviewer" },
  } } });
  expect(resident.ok(), await resident.text()).toBe(true);
  expect(await (await say(daemon, "Marlowe, check the build")).json()).toEqual({ accepted: true });
  const feedback = page.getByRole("status").filter({ hasText: "Marlowe isn't running" });
  await expect(feedback).toBeVisible();
  if (process.env.MC_E2E_EVIDENCE === "1") {
    await feedback.screenshot({ path: join(artifactsDir("voice-spoken-message-live-flag"), "not-running.png") });
  }
});

test("an earlier spoken failure stays visible when a newer card updates in the same render", async ({ dashboard: page, daemon, request }) => {
  for (const id of [...VOICE_REQUIRED_FLAGS, "voice"]) {
    expect((await request.put(`${daemon.baseURL}/api/feature-flags`, { data: { kind: "flag", id, enabled: true } })).ok()).toBe(true);
  }
  expect((await request.put(`${daemon.baseURL}/api/voice/config`, { data: { muted: false, cancelWindow: { enabled: true, seconds: 30 } } })).ok()).toBe(true);
  const resident = await request.post(`${daemon.baseURL}/api/residents/profiles`, { data: { settings: {
    identity: { name: "Marlowe", description: "Reviews builds" }, persona: { personaId: "builtin:code-risk-reviewer" },
  } } });
  expect(resident.ok(), await resident.text()).toBe(true);

  const profile = await resident.json();
  const launch = await request.post(`${daemon.baseURL}/api/residents/profiles/${profile.id}/launch`, {
    data: { repoRoot: null, requestId: "voice-cancel-window" },
  });
  expect(launch.ok(), await launch.text()).toBe(true);
  let taskId: string | undefined;
  await expect.poll(async () => {
    const sessions = await (await request.get(`${daemon.baseURL}/api/sessions`)).json() as Session[];
    taskId = sessions.find(s => s.task?.kind === "resident")?.task?.id;
    return taskId;
  }, { timeout: 30_000 }).toBeTruthy();
  // Deliver two real daemon frames in one browser task, in their original order.
  await page.addInitScript(() => {
    const Native = window.EventSource;
    window.EventSource = class extends Native {
      constructor(url: string | URL, options?: EventSourceInit) {
        super(url, options);
        if (String(url) !== "/events") return;
        let earlier: string | undefined;
        this.addEventListener("message", event => {
          const frame = JSON.parse(event.data) as { type: string; card?: VoiceCard };
          if (frame.type !== "voice_card") return;
          if (frame.card?.id === "earlier" && frame.card.state === "not-running" && !earlier) {
            earlier = event.data;
            event.stopImmediatePropagation();
          } else if (frame.card?.id === "newer" && frame.card.state === "cancelled" && earlier) {
            this.dispatchEvent(new MessageEvent("message", { data: earlier }));
            earlier = undefined;
          }
        });
      }
    };
  });
  await page.reload();
  await expect(page.locator(".pulse")).not.toHaveClass(/is-down/);
  for (const id of ["earlier", "newer"]) {
    expect(await (await say(daemon, "Marlowe, check the build", { id })).json()).toEqual({ accepted: true });
  }
  const complete = await request.post(`${daemon.baseURL}/api/tasks/${taskId}/complete`, { data: { outcome: "Stood down" } });
  expect(complete.ok(), await complete.text()).toBe(true);
  expect((await request.post(`${daemon.baseURL}/api/voice/cards/earlier/send-now`)).ok()).toBe(true);
  expect((await request.post(`${daemon.baseURL}/api/voice/cards/newer/cancel`)).ok()).toBe(true);
  const feedback = page.getByRole("status").filter({ hasText: "Marlowe isn't running" });
  await expect(feedback).toBeVisible();
  if (process.env.MC_E2E_EVIDENCE === "1") {
    const dir = artifactsDir("voice-overlapping-cards-stopped-during-window");
    mkdirSync(dir, { recursive: true });
    await feedback.screenshot({ path: join(dir, "earlier-failure.png") });
  }
});

test("a spoken message waiting behind a compatible question moves from the visible queue into the conversation", async ({ dashboard: page, daemon, request }) => {
  const title = "Which release?";
  const created = await request.post(`${daemon.baseURL}/api/tasks`, { data: {
    repoRoot: daemon.repo, title: "Verify the release", intent: "Verify the release", callSign: "Steve",
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

  const headers = { "x-harness-token": voiceToken(daemon) };
  const flag = (id: string, enabled: boolean) => request.put(`${daemon.baseURL}/api/feature-flags`, {
    data: { kind: "flag", id, enabled },
  });
  expect((await flag("async-input", false)).ok()).toBe(true);
  const ask = await request.post(`${daemon.baseURL}/mcp/reviews`, { headers, data: {
    env: {}, sessionId: session.id, kind: "input", title, body: title, snoozable: true, asyncCapable: true, convertible: true,
  } });
  expect(ask.ok(), await ask.text()).toBe(true);
  const review = await ask.json();
  expect(review.wait).toBe("call");
  for (const id of [...VOICE_REQUIRED_FLAGS, "voice"]) expect((await flag(id, true)).ok()).toBe(true);
  expect((await request.put(`${daemon.baseURL}/api/voice/config`, { data: { muted: false, cancelWindow: { enabled: false } } })).ok()).toBe(true);

  await page.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row", { hasText: session.name }).first().click();
  expect(await (await say(daemon, "Steve, verify the release", { id: "convert-release" })).json()).toEqual({ accepted: true });
  // Phase 6 owns the confirmation card. This phase exposes the queued turn and delivered payload in the transcript.
  const queued = page.locator(".pending-turn").filter({ hasText: "verify the release" });
  await expect(queued.getByRole("status")).toHaveText("queued");
  await expect(queued.getByText("Spoken", { exact: true })).toBeVisible();
  const wait = await request.get(`${daemon.baseURL}/mcp/reviews/${review.id}/wait?convertible=1`, { headers });
  expect((await wait.json()).converted.receipt).toContain(review.id);
  await expect(queued).toHaveCount(0);
  const reply = page.getByText(/Mock reply to: verify the release/).first();
  await expect(reply).toBeVisible({ timeout: 30_000 });
  const spoken = page.getByRole("article").filter({ has: page.getByText("Spoken", { exact: true }), hasText: "verify the release" });
  await spoken.getByText("What the agent received", { exact: true }).click();
  await expect(spoken.locator(".review-received-text")).toContainText(`- ${review.id}: ${title}`);
  if (process.env.MC_E2E_EVIDENCE === "1") {
    const dir = artifactsDir("voice-question-conversion");
    mkdirSync(dir, { recursive: true });
    await reply.screenshot({ path: join(dir, "delivered-reply.png") });
  }
});

test("speech releases the SDK agent's own request_input call and reaches its next turn", async ({ dashboard: page, daemon, request }) => {
  const flag = (id: string, enabled: boolean) => request.put(`${daemon.baseURL}/api/feature-flags`, {
    data: { kind: "flag", id, enabled },
  });
  expect((await flag("async-input", false)).ok()).toBe(true);
  const created = await request.post(`${daemon.baseURL}/api/tasks`, { data: {
    repoRoot: daemon.repo, title: "Choose the toolchain", intent: "Choose the toolchain", callSign: "Steve",
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
  await page.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row", { hasText: session.name }).first().click();
  const detail = page.locator(".console-detail");
  const composer = detail.getByPlaceholder(/^Reply to this session/);
  await composer.fill("ask me which linter to use");
  await composer.press("Enter");
  let question: ReviewItem | undefined;
  await expect.poll(async () => {
    const reviews = await (await request.get(`${daemon.baseURL}/api/reviews`)).json() as ReviewItem[];
    question = reviews.find(r => r.sessionId === session.id && r.title === "Which linter?");
    return question?.status === "pending" && (question.waitMode ?? "call");
  }).toBe("call");

  for (const id of [...VOICE_REQUIRED_FLAGS, "voice"]) expect((await flag(id, true)).ok()).toBe(true);
  expect((await request.put(`${daemon.baseURL}/api/voice/config`, { data: { muted: false, cancelWindow: { enabled: false } } })).ok()).toBe(true);
  expect(await (await say(daemon, "Steve, inspect the toolchain", { id: "active-sdk-ask" })).json()).toEqual({ accepted: true });
  const receipt = detail.getByText(/request_input answered: Filed, not answered:/);
  await expect(receipt.first()).toContainText(`(review ${question!.id})`, { timeout: 30_000 });
  await expect(detail.getByText(/Mock reply to: inspect the toolchain/).first()).toBeVisible({ timeout: 30_000 });
});
