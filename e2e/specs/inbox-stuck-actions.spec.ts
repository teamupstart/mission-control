import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page, Request } from "@playwright/test";
import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import { INBOX_MESSAGES } from "../../src/shared/inbox.ts";
import type { Stall, StallFacts } from "../../src/shared/stall.ts";
import type { Session, Task } from "../../src/shared/types.ts";

/**
 * What is at stake: every control on a Stuck row does what it says when it is clicked. The
 * rendering tests prove which controls a row draws; this proves each one's handler sends the
 * request it should and that its effect lands - Interrupt stops the turn, Nudge and Tell it to
 * push put their fixed words in the agent's conversation, Continue asks a parked run's session
 * for its next turn, Reply sends what was typed, and
 * Resubmit asks for the run the row names. A failed action shows its error under the row. And
 * a stall whose facts change while its sentence stays the same redraws the row.
 *
 * `inbox-stuck.spec.ts` proves the real detector feeds this section, waiting out its
 * one-minute floor. Here the browser's copy of `/api/away/stalls` is SERVED by the spec, so
 * each rule's row can be put in front of one real, live session in turn without waiting four
 * minutes for four rules. Every action then goes to the real daemon and the real fake agent,
 * except Resubmit: there is no parked run behind a served stall, so its replies are scripted
 * too, and what this proves for it is the request the card sends and what it does with the
 * answer.
 */

const EVIDENCE = artifactsDir("inbox-stuck");

/** A picture of one row as the operator sees it, under `MC_E2E_EVIDENCE=1`. */
async function capture(target: Locator, name: string, page: Page): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await expect(page.locator(".tooltip")).toHaveCount(0, { timeout: 3000 }).catch(() => undefined);
  await target.screenshot({ path: join(EVIDENCE, `${name}.png`) });
  console.log(`CAPTURED e2e/.artifacts/inbox-stuck/${name}.png`);
}

async function api<T>(daemon: DaemonHandle, path: string, body?: unknown, method?: string): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  return await response.json() as T;
}

async function setInbox(daemon: DaemonHandle, enabled: boolean): Promise<void> {
  const { config } = await api<{ config: { overrides: Record<string, boolean> } }>(
    daemon, "/api/feature-flags", { kind: "flag", id: "inbox", enabled }, "PUT");
  expect(config.overrides.inbox).toBe(enabled);
}

async function sessionState(daemon: DaemonHandle, id: string): Promise<string | undefined> {
  return (await api<Session[]>(daemon, "/api/sessions")).find((s) => s.id === id)?.state;
}

/** Whether the agent's served transcript holds a user turn containing `text`. */
async function heard(daemon: DaemonHandle, id: string, text: string): Promise<boolean> {
  const served = await api<{ messages: Array<{ role: string; text: string }> }>(
    daemon, `/api/sessions/${encodeURIComponent(id)}/transcript`);
  return served.messages.some((m) => m.role === "user" && m.text.includes(text));
}

async function openInbox(page: Page): Promise<Locator> {
  const inbox = page.getByRole("dialog", { name: "Attention inbox" });
  const button = page.locator("button.pulse-seg", { hasText: "to answer" });
  await expect(async () => {
    if (!(await inbox.isVisible())) await button.click({ timeout: 3000 });
    await expect(inbox).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 45_000 });
  await expectContentClearsBorder(inbox);
  return inbox;
}

function stall(sessionId: string, reason: string, facts: StallFacts, fingerprint: string): Stall {
  return { sessionId, kind: facts.kind, forMs: 21 * 60_000, reason, facts, fingerprint };
}

test("each Stuck control sends its request and lands its effect, a failure shows under the row, and a facts-only change redraws it", async ({ dashboard: page, daemon }) => {
  test.setTimeout(240_000);
  await setInbox(daemon, true);
  const task = await api<Task>(daemon, "/api/tasks", {
    repoRoot: daemon.repo, title: "Fix the parser", intent: "fix the parser", kind: "ship", agent: "claude", runtime: "sdk", workflowId: null,
  });
  let session!: Session;
  await expect.poll(async () => {
    session = (await api<Session[]>(daemon, "/api/sessions")).find((s) => s.task?.id === task.id)!;
    return session?.agentSessionId ? session.state : null;
  }, { timeout: 60_000 }).toBe("idle");
  const id = session.id;

  // The stall list the dashboard polls every five seconds, served from here.
  let served: Stall[] = [];
  await page.route("**/api/away/stalls", (route) => route.fulfill({ json: served }));
  const posts: Array<{ path: string; body: unknown }> = [];
  page.on("request", (request: Request) => {
    if (request.method() !== "POST") return;
    // Decoded: a session id carries a colon, which the request percent-encodes.
    const path = decodeURIComponent(new URL(request.url()).pathname);
    if (path.startsWith("/api/sessions/") || path.startsWith("/api/workflow-runs/")) {
      posts.push({ path, body: request.postDataJSON() });
    }
  });
  const sent = (suffix: string) => posts.filter((p) => p.path.endsWith(suffix));

  // Nothing is owed until the first stall is served, so the inbox is opened after that.
  const row = () => page.getByRole("dialog", { name: "Attention inbox" })
    .getByRole("region", { name: `${task.title} is stuck` });

  // 1. Silent while working: Interrupt stops the turn the agent is in.
  await api(daemon, `/api/sessions/${id}/send`, { text: "hold the current turn open for queued review setup", submit: true });
  await expect.poll(() => sessionState(daemon, id), { timeout: 15_000 }).toBe("working");
  served = [stall(id, "working but silent for 12m (last: Running npm test)",
    { kind: "silent-working", activity: "Running npm test", quietSince: 0 }, "silent-1")];
  await openInbox(page);
  await expect(row()).toContainText("Silent while working");
  await expect(row()).toContainText("Last activity: Running npm test");
  await capture(row(), "02-silent-working", page);
  await row().getByRole("button", { name: "Interrupt", exact: true }).click();
  await expect(row().getByRole("status")).toHaveText("Interrupted.");
  expect(sent(`/sessions/${id}/interrupt`)).toHaveLength(1);
  // Well inside the fifteen seconds the held turn would otherwise have run.
  await expect.poll(() => sessionState(daemon, id), { timeout: 8_000 }).toBe("idle");

  // 2. Nudge puts its fixed words in the agent's conversation.
  await row().getByRole("button", { name: "Nudge", exact: true }).click();
  await expect(row().getByRole("status")).toHaveText("Nudge sent.");
  expect(sent(`/sessions/${id}/inbox-message`).at(-1)?.body).toEqual({ kind: "nudge" });
  await expect.poll(() => heard(daemon, id, INBOX_MESSAGES.nudge), { timeout: 30_000 }).toBe(true);
  await expect.poll(() => sessionState(daemon, id), { timeout: 30_000 }).toBe("idle");

  // 3. An escalation's reply box sends exactly what was typed, as an ordinary message.
  served = [stall(id, "escalated to you 6m ago, still unanswered",
    { kind: "escalated", text: "Approve the migration?" }, "escalated-1")];
  await expect(row()).toContainText("Foreman escalated: Approve the migration?", { timeout: 15_000 });
  await capture(row(), "03-escalated", page);
  const reply = "Use the additive migration and keep the old column for a release";
  await row().getByRole("textbox", { name: `Reply to ${task.title}` }).fill(reply);
  await row().getByRole("button", { name: "Reply", exact: true }).click();
  await expect(row().getByRole("status")).toHaveText("Message sent.");
  expect(sent(`/sessions/${id}/send`).at(-1)?.body).toEqual({ text: reply, submit: true });
  await expect(row().getByRole("textbox", { name: `Reply to ${task.title}` })).toHaveValue("");
  await expect.poll(() => heard(daemon, id, reply), { timeout: 30_000 }).toBe(true);
  await expect.poll(() => sessionState(daemon, id), { timeout: 30_000 }).toBe("idle");

  // 3b. A draft typed while a reply is still sending survives that reply's success: only the
  //     words that were sent leave the box. The send is held until the new draft is typed, and
  //     then a second time with a draft that repeats the sent words exactly, which is kept too:
  //     what matters is that the operator typed after sending, not what they typed.
  let releaseSend!: () => void;
  const sendHeld = new Promise<void>((resolve) => { releaseSend = resolve; });
  await page.route("**/api/sessions/*/send", async (route) => {
    await sendHeld;
    await route.continue();
  });
  const box = row().getByRole("textbox", { name: `Reply to ${task.title}` });
  const firstReply = "Ship the additive migration first";
  const nextDraft = "Then drop the old column next release";
  await box.fill(firstReply);
  await row().getByRole("button", { name: "Reply", exact: true }).click();
  await expect.poll(() => sent(`/sessions/${id}/send`).at(-1)?.body).toEqual({ text: firstReply, submit: true });
  await box.fill(nextDraft);
  const replied = page.waitForResponse("**/api/sessions/*/send");
  releaseSend();
  expect((await replied).ok()).toBe(true);
  await expect(row().getByRole("status")).toHaveText("Message sent.");
  await expect(box).toHaveValue(nextDraft);
  await page.unroute("**/api/sessions/*/send");
  await expect.poll(() => heard(daemon, id, firstReply), { timeout: 30_000 }).toBe(true);
  await expect.poll(() => sessionState(daemon, id), { timeout: 30_000 }).toBe("idle");

  let releaseRepeat!: () => void;
  const repeatHeld = new Promise<void>((resolve) => { releaseRepeat = resolve; });
  await page.route("**/api/sessions/*/send", async (route) => {
    await repeatHeld;
    await route.continue();
  });
  const repeated = "Confirm the column drop";
  await box.fill(repeated);
  await row().getByRole("button", { name: "Reply", exact: true }).click();
  await expect.poll(() => sent(`/sessions/${id}/send`).at(-1)?.body).toEqual({ text: repeated, submit: true });
  // Retyped from empty to the identical words while the send is pending.
  await box.fill("");
  await box.pressSequentially(repeated);
  const repeatReplied = page.waitForResponse("**/api/sessions/*/send");
  releaseRepeat();
  expect((await repeatReplied).ok()).toBe(true);
  await expect(row().getByRole("status")).toHaveText("Message sent.");
  await expect(box).toHaveValue(repeated);
  await page.unroute("**/api/sessions/*/send");
  await expect.poll(() => heard(daemon, id, repeated), { timeout: 30_000 }).toBe(true);
  await expect.poll(() => sessionState(daemon, id), { timeout: 30_000 }).toBe("idle");
  await box.fill("");

  // 4. A run waiting for a pushed head, with unpushed commits: Tell it to push.
  served = [stall(id, "idle 21m - No-Mistakes Review is waiting for a pushed head and 2 commits on fix/parser have not been pushed", {
    kind: "workflow-parked", runId: "run-e2e", workflowName: "No-Mistakes Review",
    status: "waiting_for_new_head", round: 2, resubmittable: false, unpushedCommits: 2, externalSource: null,
  }, "parked-head")];
  await expect(row()).toContainText("2 commits on this branch have not been pushed", { timeout: 15_000 });
  await expect(row().getByRole("button", { name: "Resubmit" })).toHaveCount(0);
  await capture(row(), "04-parked-push", page);
  await row().getByRole("button", { name: "Tell it to push", exact: true }).click();
  // Starting the turn retires this idle stall. Follow the request into the real transcript.
  await expect.poll(() => sent(`/sessions/${id}/inbox-message`).at(-1)?.body).toEqual({ kind: "push" });
  await expect.poll(() => heard(daemon, id, INBOX_MESSAGES.push), { timeout: 30_000 }).toBe(true);

  // 5. A self-resuming round that stalled: nothing to resubmit and nothing to push, so the row
  //    asks for the session's next turn with Continue.
  await expect.poll(() => sessionState(daemon, id), { timeout: 30_000 }).toBe("idle");
  served = [stall(id, "idle 21m - No-Mistakes Review repair round 2 never reopened", {
    kind: "workflow-parked", runId: "run-e2e", workflowName: "No-Mistakes Review",
    status: "waiting_for_session", round: 2, resubmittable: false, unpushedCommits: 0, externalSource: null,
  }, "parked-auto")];
  await expect(row()).toContainText("Missing step: the session's next turn, which reopens No-Mistakes Review round 2.", { timeout: 15_000 });
  await expect(row().getByRole("button", { name: "Resubmit" })).toHaveCount(0);
  await expect(row().getByRole("button", { name: "Tell it to push" })).toHaveCount(0);
  await capture(row(), "05-parked-next-turn", page);
  await row().getByRole("button", { name: "Continue", exact: true }).click();
  await expect.poll(() => sent(`/sessions/${id}/inbox-message`).at(-1)?.body).toEqual({ kind: "continue" });
  await expect.poll(() => heard(daemon, id, INBOX_MESSAGES.continue), { timeout: 30_000 }).toBe(true);

  // 6. A resubmittable run: Resubmit asks for the run the row names. Its first answer is a
  //    refusal, which is shown under the row; the retry succeeds and clears it.
  let resubmits = 0;
  // Set to hold a reply until the spec releases it, to land a response after the stall changed.
  let held: Promise<void> | null = null;
  await page.route("**/api/workflow-runs/*/resubmit", async (route) => {
    resubmits += 1;
    const count = resubmits;
    if (held) await held;
    return count === 1
      ? route.fulfill({ status: 409, json: { error: "The run left waiting_for_session before the resubmission" } })
      : route.fulfill({ status: 200, json: { idempotent: false } });
  });
  served = [stall(id, "idle 21m - No-Mistakes Review repair round 2 never reopened", {
    kind: "workflow-parked", runId: "run-e2e", workflowName: "No-Mistakes Review",
    status: "waiting_for_session", round: 2, resubmittable: true, unpushedCommits: 0, externalSource: null,
  }, "parked-session")];
  await expect(row()).toContainText("Missing step: a resubmission to reopen No-Mistakes Review round 2.", { timeout: 15_000 });
  await expect(row().getByRole("button", { name: "Tell it to push" })).toHaveCount(0);
  await row().getByRole("button", { name: "Resubmit", exact: true }).click();
  await expect(row().getByRole("alert")).toHaveText("The run left waiting_for_session before the resubmission");
  await expect(row().getByRole("status")).toHaveCount(0);
  const request = sent("/workflow-runs/run-e2e/resubmit").at(-1)?.body as { requestId?: string; resubmitUnchanged?: boolean };
  expect(request.resubmitUnchanged).toBe(false);
  expect(request.requestId).toEqual(expect.any(String));
  await row().getByRole("button", { name: "Resubmit", exact: true }).click();
  await expect(row().getByRole("status")).toHaveText("Resubmitted the run.");
  await expect(row().getByRole("alert")).toHaveCount(0);
  expect(sent("/workflow-runs/run-e2e/resubmit")).toHaveLength(2);

  // 7. A run an ensemble started: only its source can submit again, so the row offers no
  //    Resubmit and no Continue and says who must act. A different stall than the one above,
  //    so the earlier Resubmit's feedback is cleared from the row.
  served = [stall(id, "idle 21m - No-Mistakes Review repair round 2 never reopened", {
    kind: "workflow-parked", runId: "run-external", workflowName: "No-Mistakes Review",
    status: "waiting_for_session", round: 2, resubmittable: false, unpushedCommits: 0, externalSource: "ensemble",
  }, "parked-external")];
  await expect(row()).toContainText("Missing step: the ensemble that started No-Mistakes Review must submit again.", { timeout: 15_000 });
  await expect(row().getByRole("status")).toHaveCount(0);
  await expect(row().getByRole("button", { name: "Resubmit" })).toHaveCount(0);
  await expect(row().getByRole("button", { name: "Continue" })).toHaveCount(0);
  await expect(row().getByRole("button", { name: "Open run", exact: true })).toBeVisible();
  await capture(row(), "06-parked-external", page);

  // 8. A refused action's error does not outlive its stall: fail a Resubmit, then serve a
  //    different stall, and the error is gone from the row.
  served = [stall(id, "idle 21m - No-Mistakes Review repair round 3 never reopened", {
    kind: "workflow-parked", runId: "run-e2e", workflowName: "No-Mistakes Review",
    status: "waiting_for_session", round: 3, resubmittable: true, unpushedCommits: 0, externalSource: null,
  }, "parked-round-3")];
  resubmits = 0;
  await row().getByRole("button", { name: "Resubmit", exact: true }).click({ timeout: 15_000 });
  await expect(row().getByRole("alert")).toHaveText("The run left waiting_for_session before the resubmission");

  // 9. A result that arrives after its stall was replaced is not shown under the new one. The
  //    Resubmit reply is held while the next poll serves a different stall, then released as a
  //    refusal: the new row shows neither that error nor a success line, and its controls are
  //    not left disabled by the request that no longer concerns it.
  served = [stall(id, "idle 21m - No-Mistakes Review repair round 4 never reopened", {
    kind: "workflow-parked", runId: "run-e2e", workflowName: "No-Mistakes Review",
    status: "waiting_for_session", round: 4, resubmittable: true, unpushedCommits: 0, externalSource: null,
  }, "parked-round-4")];
  await expect(row()).toContainText("round 4 never reopened", { timeout: 15_000 });
  await expect(row().getByRole("alert")).toHaveCount(0);
  let release!: () => void;
  held = new Promise<void>((resolve) => { release = resolve; });
  resubmits = 0;
  const before = sent("/workflow-runs/run-e2e/resubmit").length;
  await row().getByRole("button", { name: "Resubmit", exact: true }).click();
  await expect.poll(() => sent("/workflow-runs/run-e2e/resubmit").length).toBe(before + 1);
  await expect(row().getByRole("button", { name: "Resubmit", exact: true })).toBeDisabled();
  const reason = "idle 21m with work unfinished";
  served = [stall(id, reason, { kind: "unfinished-work", task: { id: task.id, title: task.title }, queueOpen: 0 }, "open-1")];
  await expect(row()).toContainText('Open: the task "Fix the parser".', { timeout: 15_000 });
  await expect(row().getByRole("button", { name: "Continue", exact: true })).toBeEnabled();
  const answered = page.waitForResponse("**/api/workflow-runs/run-e2e/resubmit");
  release();
  held = null;
  expect((await answered).status()).toBe(409);
  // Give the settled request its chance to write, then check that it did not.
  await page.waitForTimeout(500);
  await expect(row().getByRole("alert")).toHaveCount(0);
  await expect(row().getByRole("status")).toHaveCount(0);
  await expect(row().getByRole("button", { name: "Continue", exact: true })).toBeEnabled();

  // 10. A facts-only change: the sentence stays the same, the fingerprint and the open work do
  //    not, and the row redraws what is open.
  served = [stall(id, reason, { kind: "unfinished-work", task: { id: task.id, title: task.title }, queueOpen: 2 }, "open-2")];
  await expect(row()).toContainText('Open: the task "Fix the parser" and 2 open queue items.', { timeout: 15_000 });
  await expect(row()).toContainText(reason);

  // 11. A request that dies on the network shows an error under the row and leaves its controls
  //     usable, rather than holding them disabled with nothing said.
  served = [stall(id, "working but silent for 30m", { kind: "silent-working", activity: null, quietSince: 0 }, "silent-2")];
  await expect(row()).toContainText("Silent while working", { timeout: 15_000 });
  await page.route("**/api/sessions/*/inbox-message", (route) => route.abort("connectionreset"));
  await row().getByRole("button", { name: "Nudge", exact: true }).click();
  await expect(row().getByRole("alert")).not.toHaveText("");
  await expect(row().getByRole("button", { name: "Nudge", exact: true })).toBeEnabled();
  await page.unroute("**/api/sessions/*/inbox-message");

  // 12. Open session leaves the inbox and focuses that session's detail.
  await row().getByRole("button", { name: "Open session", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Attention inbox" })).toBeHidden();
  await expect(page.locator(".console-detail")).toContainText(session.name);
});
