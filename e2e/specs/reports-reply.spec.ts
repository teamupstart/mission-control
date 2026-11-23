import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import type { ReportItem } from "../../src/shared/reports.ts";
import type { ResidentProfile } from "../../src/shared/residents.ts";
import type { Session, Task } from "../../src/shared/types.ts";

/**
 * What is at stake: a report appears in its agent's conversation where it was posted, and the
 * operator answers it from its inbox card. A reply reaches the agent as the operator's own message
 * naming and restating the report, takes it out of to read, and its conversation entry then reads
 * "Replied to". When the session has ended the card offers Start a follow-up task instead, which
 * dispatches a NEW task (the old session is never resumed) and clears the report once it has
 * been dispatched. A resident that is not running gets a line and a relaunch hint, not a control.
 *
 * Real daemon, real routes, real SSE and the real built dashboard. Reports are posted on the
 * exact channel the MCP `post_report` tool uses, and every agent, the follow-up's included, is
 * the suite's fake: no model tokens are spent.
 */

const EVIDENCE = artifactsDir("reports-reply");

async function capture(target: Locator | Page, name: string, page: Page): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.mouse.move(0, 0);
  await expect(page.locator(".tooltip")).toHaveCount(0, { timeout: 3000 }).catch(() => undefined);
  await target.screenshot({ path: join(EVIDENCE, `${name}.png`) });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/reports-reply/${name}.png`);
}

const token = (daemon: DaemonHandle) => readFileSync(join(daemon.home, "token"), "utf8").trim();

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

/** Post a report the way the MCP `post_report` tool does. */
async function report(daemon: DaemonHandle, cwd: string, body: Record<string, unknown>): Promise<ReportItem> {
  const res = await fetch(`${daemon.baseURL}/mcp/reports`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": token(daemon) },
    body: JSON.stringify({ env: {}, cwd, ...body }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json() as { report: ReportItem }).report;
}

const history = async (daemon: DaemonHandle, sessionId: string) =>
  (await api<{ reports: ReportItem[] }>(daemon, `/api/sessions/${sessionId}/reports`)).reports;

const toRead = (page: Page) => page.locator("button.pulse-seg", { hasText: "to read" });

async function openInbox(page: Page): Promise<Locator> {
  const inbox = page.getByRole("dialog", { name: "Attention inbox" });
  await expect(async () => {
    if (!(await inbox.isVisible())) await toRead(page).click({ timeout: 3000 });
    await expect(inbox).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 45_000 });
  await expectContentClearsBorder(inbox);
  return inbox;
}

async function startSession(daemon: DaemonHandle, title: string): Promise<{ task: Task; session: Session }> {
  const task = await api<Task>(daemon, "/api/tasks", {
    repoRoot: daemon.repo, title, intent: title.toLowerCase(), kind: "ship", agent: "claude", runtime: "sdk", workflowId: null,
  });
  let session!: Session;
  await expect.poll(async () => {
    session = (await api<Session[]>(daemon, "/api/sessions")).find((s) => s.task?.id === task.id)!;
    return session?.agentSessionId ? session.state : null;
  }, { timeout: 60_000 }).toBe("idle");
  return { task, session };
}

test("a report is answered from its card: a reply reaches the agent, and a follow-up starts a new task once the session has ended", async ({ dashboard: page, daemon }) => {
  test.setTimeout(240_000);
  const title = "Diagnose the flaky build";
  const { task, session } = await startSession(daemon, title);
  await setInbox(daemon, true);
  await page.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  const detail = page.locator(".console-detail");
  await expect(detail).toBeVisible();

  // The report is an entry in the conversation where it was posted, waiting to be read.
  const first = await report(daemon, session.cwd!, {
    title: "Build failure diagnosed",
    body: "The **cache key** ignored the lockfile, so CI restored stale modules.",
  });
  const entry = detail.getByRole("note", { name: "Report: Build failure diagnosed" });
  await expect(entry).toBeVisible({ timeout: 30_000 });
  await expect(entry).toContainText("Waiting to be read");
  await expect(entry.getByRole("button", { name: "Mark read" })).toBeVisible();

  // The entry is behind the `inbox` flag: off, it leaves the open conversation; on again, it
  // returns. Neither needs a reload.
  let navigations = 0;
  page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) navigations++; });
  await setInbox(daemon, false);
  await expect(entry).toHaveCount(0, { timeout: 30_000 });
  await expect(detail.locator(".report-entry")).toHaveCount(0);
  await capture(detail.locator(".transcript-log"), "00-flag-off-no-entry", page);
  await setInbox(daemon, true);
  await expect(entry).toBeVisible({ timeout: 30_000 });
  await expect(entry).toContainText("Waiting to be read");
  expect(navigations, "the entry went and came back without a reload").toBe(0);

  await entry.getByRole("button", { name: "Build failure diagnosed" }).click();
  await expect(entry.locator(".agent-report-body strong", { hasText: "cache key" })).toBeVisible();
  await capture(entry, "01-conversation-entry-waiting", page);

  // The inbox shows the same report open (one open report on screen), with a reply box.
  let inbox = await openInbox(page);
  let card = inbox.getByRole("article", { name: "Report: Build failure diagnosed" });
  const box = card.getByRole("textbox", { name: `Reply to ${title}` });
  await expect(box).toBeVisible();
  await expect(card.getByRole("button", { name: "Start a follow-up task" })).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Send reply" })).toBeDisabled();
  await box.fill("Good find. Key the cache on the lockfile hash and open a PR.");
  await capture(card, "02-inbox-reply-box", page);
  await card.getByRole("button", { name: "Send reply" }).click();

  // It leaves to read, and the agent receives the operator's message naming the report.
  await expect(toRead(page)).toHaveCount(0, { timeout: 30_000 });
  await expect(inbox.getByRole("article", { name: "Report: Build failure diagnosed" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(inbox).toBeHidden();
  const delivered = detail.locator("article.turn-user .turn-text").filter({ hasText: "Reply to your report 'Build failure diagnosed'" });
  await expect(delivered.first()).toBeVisible({ timeout: 60_000 });
  await expect(delivered.first()).toContainText(`(${first.id}), posted`);
  await expect(delivered.first()).toContainText("Key the cache on the lockfile hash and open a PR.");
  await expect(entry).toContainText("Replied to");
  await expect(entry.getByRole("button", { name: "Mark read" })).toHaveCount(0);
  expect((await history(daemon, session.id)).find((r) => r.id === first.id)?.readBy).toBe("reply");
  await capture(entry, "03a-conversation-entry-replied", page);
  await capture(detail.locator(".transcript-log"), "03-conversation-reply-delivered", page);

  // A second report, then the session ends. It is never resumed: the card offers a follow-up.
  const second = await report(daemon, session.cwd!, {
    title: "Flaky test traced", body: "The retry loop races the clock.",
  });
  await expect(toRead(page).locator(".pulse-n")).toHaveText("1");
  await api(daemon, `/api/tasks/${task.id}/complete`, { outcome: "Diagnosed" });
  await expect.poll(async () => (await api<Session[]>(daemon, "/api/sessions")).some((s) => s.id === session.id && s.state !== "exited"),
    { timeout: 60_000 }).toBe(false);
  // Ending a session never clears its reports.
  await expect(toRead(page).locator(".pulse-n")).toHaveText("1");

  inbox = await openInbox(page);
  card = inbox.getByRole("article", { name: "Report: Flaky test traced" });
  await card.getByRole("button", { name: "Flaky test traced" }).click();
  await expect(card.getByRole("textbox", { name: `Reply to ${title}` })).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Send reply" })).toHaveCount(0);
  await expect(card).toContainText("never resumed");
  const followUp = card.getByRole("textbox", { name: "Instructions for the follow-up task" });
  await followUp.fill("Fix the race in the retry loop.");
  await capture(card, "04-inbox-follow-up-offered", page);
  await card.getByRole("button", { name: "Start a follow-up task" }).click();

  // A new task, in the same repository, running: the old session stays ended.
  await expect(toRead(page)).toHaveCount(0, { timeout: 30_000 });
  let followed!: ReportItem;
  await expect.poll(async () => {
    followed = (await history(daemon, session.id)).find((r) => r.id === second.id)!;
    return followed.readBy;
  }, { timeout: 30_000 }).toBe("follow-up");
  expect(followed.followUpTaskId).not.toBeNull();
  const followUpTask = (await api<Task[]>(daemon, "/api/tasks")).find((t) => t.id === followed.followUpTaskId)!;
  expect(followUpTask.title).toBe("Follow up: Flaky test traced");
  expect(followUpTask.repoRoot).toBe(task.repoRoot);
  expect(followUpTask.intent.startsWith("Fix the race in the retry loop.")).toBe(true);
  expect(followUpTask.intent).toContain("The retry loop races the clock.");
  await expect.poll(async () => {
    const live = (await api<Session[]>(daemon, "/api/sessions")).find((s) => s.task?.id === followUpTask.id);
    return live ? live.id !== session.id && live.state !== "exited" : false;
  }, { timeout: 60_000 }).toBe(true);
  await page.keyboard.press("Escape");
  await expect(inbox).toBeHidden();
  // The follow-up session is on the rail; the report's entry belongs to the session that posted it.
  await expect(page.getByRole("navigation", { name: "Sessions" }).getByText("Follow up: Flaky test traced").first()).toBeVisible({ timeout: 30_000 });
  await capture(page, "05-follow-up-task-running", page);

  // The operator cancels that follow-up task. It answers nothing now, so the report is back in to
  // read, and its card offers the instructions box for a new follow-up (no Retry: there is no
  // task left to retry).
  await api(daemon, `/api/tasks/${followUpTask.id}/cancel`, {});
  await expect(toRead(page).locator(".pulse-n")).toHaveText("1", { timeout: 30_000 });
  await expect.poll(async () => (await history(daemon, session.id)).find((r) => r.id === second.id)?.followUpTaskId ?? null,
    { timeout: 30_000 }).toBeNull();
  inbox = await openInbox(page);
  card = inbox.getByRole("article", { name: "Report: Flaky test traced" });
  await card.getByRole("button", { name: "Flaky test traced" }).click();
  await expect(card.getByRole("textbox", { name: "Instructions for the follow-up task" })).toBeVisible();
  await expect(card.getByRole("button", { name: "Start a follow-up task" })).toBeDisabled();
  await expect(card.getByRole("button", { name: "Retry" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(inbox).toBeHidden();
});

test("a refused reply stays on its card with the draft, and a follow-up whose dispatch is held is retried on the same task", async ({ dashboard: page, daemon }) => {
  test.setTimeout(240_000);
  const title = "Trace the slow build";
  const { task, session } = await startSession(daemon, title);
  await setInbox(daemon, true);
  const posted = await report(daemon, session.cwd!, { title: "Slow build traced", body: "The test shards wait on one runner." });

  // A reply the daemon refuses: the reason is shown beneath the card, the words stay in the box,
  // and the report is still waiting to be read.
  let inbox = await openInbox(page);
  let card = inbox.getByRole("article", { name: "Report: Slow build traced" });
  await card.getByRole("button", { name: "Slow build traced" }).click();
  const box = card.getByRole("textbox", { name: `Reply to ${title}` });
  const tooLong = `Split the shards. ${"x".repeat(4_000)}`;
  await box.fill(tooLong);
  await card.getByRole("button", { name: "Send reply" }).click();
  await expect(card.getByRole("alert")).toHaveText("a reply can be at most 4000 characters");
  await expect(box).toHaveValue(tooLong);
  await expect(card.getByRole("button", { name: "Send reply" })).toBeEnabled();
  await expect(toRead(page).locator(".pulse-n")).toHaveText("1");
  expect((await history(daemon, session.id)).find((r) => r.id === posted.id)?.readAt).toBeNull();
  await capture(card, "07-reply-refused", page);
  await page.keyboard.press("Escape");
  await expect(inbox).toBeHidden();

  // The session ends, and Pause all holds every launch: the follow-up task is created but its
  // dispatch is refused, so the card says so and offers Retry, and the report stays unread.
  await api(daemon, `/api/tasks/${task.id}/complete`, { outcome: "Traced" });
  await expect.poll(async () => (await api<Session[]>(daemon, "/api/sessions")).some((s) => s.id === session.id && s.state !== "exited"),
    { timeout: 60_000 }).toBe(false);
  await api(daemon, "/api/pause/fleet", {});
  try {
    inbox = await openInbox(page);
    card = inbox.getByRole("article", { name: "Report: Slow build traced" });
    await card.getByRole("textbox", { name: "Instructions for the follow-up task" }).fill("Split the shards across runners.");
    await card.getByRole("button", { name: "Start a follow-up task" }).click();
    await expect(card).toContainText("Follow-up task created but not started.");
    await expect(card.getByRole("alert")).toContainText("everything is paused");
    const retry = card.getByRole("button", { name: "Retry" });
    await expect(retry).toBeVisible();
    await expect(retry).toHaveAttribute("data-inbox-action", "follow-up");
    await expect(card.getByRole("button", { name: "Start a follow-up task" })).toHaveCount(0);
    await expect(toRead(page).locator(".pulse-n")).toHaveText("1");
    const held = (await history(daemon, session.id)).find((r) => r.id === posted.id)!;
    expect(held.readAt).toBeNull();
    expect(held.followUpTaskId).not.toBeNull();
    const followUps = async () => (await api<Task[]>(daemon, "/api/tasks")).filter((t) => t.title === "Follow up: Slow build traced");
    expect((await followUps()).map((t) => [t.id, t.status])).toEqual([[held.followUpTaskId, "backlog"]]);
    await capture(card, "08-follow-up-held-retry", page);

    // Resumed, Retry dispatches that same task: no second task, the report leaves to read, and
    // the new session starts.
    await api(daemon, "/api/pause/fleet/resume", {});
    await retry.click();
    await expect(toRead(page)).toHaveCount(0, { timeout: 30_000 });
    await expect.poll(async () => (await history(daemon, session.id)).find((r) => r.id === posted.id)?.readBy, { timeout: 30_000 })
      .toBe("follow-up");
    expect((await history(daemon, session.id)).find((r) => r.id === posted.id)?.followUpTaskId).toBe(held.followUpTaskId);
    expect((await followUps()).map((t) => t.id)).toEqual([held.followUpTaskId]);
    await expect.poll(async () => {
      const live = (await api<Session[]>(daemon, "/api/sessions")).find((s) => s.task?.id === held.followUpTaskId);
      return live ? live.id !== session.id && live.state !== "exited" : false;
    }, { timeout: 60_000 }).toBe(true);
  } finally {
    await fetch(`${daemon.baseURL}/api/pause/fleet/resume`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  }
});

test("a conversation whose report history read fails retries it, and the entry appears without a reload", async ({ dashboard: page, daemon }) => {
  test.setTimeout(150_000);
  const title = "Audit the cache keys";
  const { session } = await startSession(daemon, title);
  await setInbox(daemon, true);
  // Read before the conversation opens, so the live stream (which keeps only reports waiting to
  // be read) never carries it: the history route is the entry's only source.
  const posted = await report(daemon, session.cwd!, { title: "Cache keys audited", body: "Two keys ignore the lockfile." });
  await api(daemon, `/api/reports/${posted.id}/read`, {});
  await expect(toRead(page)).toHaveCount(0, { timeout: 30_000 });
  await setInbox(daemon, false);

  // The first history read fails as a transient server error; every later one goes through.
  let reads = 0;
  await page.route(`**/api/sessions/${encodeURIComponent(session.id)}/reports`, async (route) => {
    reads += 1;
    if (reads === 1) {
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "history unavailable" }) });
      return;
    }
    await route.continue();
  });
  let navigations = 0;
  page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) navigations++; });

  await page.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  const detail = page.locator(".console-detail");
  await expect(detail).toBeVisible();
  const entry = detail.getByRole("note", { name: "Report: Cache keys audited" });
  await setInbox(daemon, true);

  // The failed read leaves no entry; the retry brings it in.
  await expect.poll(() => reads, { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
  await expect(entry).toHaveCount(0);
  await expect(entry).toBeVisible({ timeout: 30_000 });
  await expect(entry).toContainText("Read");
  expect(reads, "the history was read again after the failure").toBeGreaterThanOrEqual(2);
  expect(navigations, "no reload").toBe(0);
  await page.unroute(`**/api/sessions/${encodeURIComponent(session.id)}/reports`);
});

test("a reply being written survives the agent replacing its report, and the new version stays open", async ({ dashboard: page, daemon }) => {
  test.setTimeout(150_000);
  const title = "Profile the slow query";
  const { session } = await startSession(daemon, title);
  await setInbox(daemon, true);
  const first = await report(daemon, session.cwd!, { title: "Slow query found", body: "The orders join scans every row." });

  const inbox = await openInbox(page);
  await inbox.getByRole("article", { name: "Report: Slow query found" }).getByRole("button", { name: "Slow query found" }).click();
  const draft = "Add the index, then measure again.";
  await inbox.getByRole("article", { name: "Report: Slow query found" }).getByRole("textbox", { name: `Reply to ${title}` }).fill(draft);

  // The agent corrects its report while the operator is still typing.
  const second = await report(daemon, session.cwd!, { title: "Slow query fixed", body: "Indexed orders.customer_id.", replaces: first.id });
  const replaced = inbox.getByRole("article", { name: "Report: Slow query fixed" });
  await expect(replaced).toBeVisible();
  await expect(inbox.getByRole("article", { name: "Report: Slow query found" })).toHaveCount(0);
  // The new version is the open one, and the words are still there.
  await expect(replaced.getByRole("button", { name: "Slow query fixed" })).toHaveAttribute("aria-expanded", "true");
  await expect(replaced.getByRole("textbox", { name: `Reply to ${title}` })).toHaveValue(draft);

  // A reply aimed at the replaced version is refused, pointing at the new one.
  const stale = await fetch(`${daemon.baseURL}/api/reports/${first.id}/reply`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: draft }),
  });
  expect(stale.status).toBe(409);
  expect((await stale.json() as { error: string }).error).toBe(`This report was replaced by ${second.id}. Reply to that version instead.`);

  // The older version can still be read from its conversation entry while the newer one waits:
  // opening it on purpose keeps it open, rather than jumping to its replacement.
  await page.keyboard.press("Escape");
  await expect(inbox).toBeHidden();
  await page.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  const detail = page.locator(".console-detail");
  const olderEntry = detail.getByRole("note", { name: "Report: Slow query found" });
  await expect(olderEntry).toContainText("Replaced by a later version", { timeout: 30_000 });
  await olderEntry.getByRole("button", { name: "Slow query found" }).click();
  await expect(olderEntry.getByText("The orders join scans every row.")).toBeVisible();
  // Long enough for any redirect to the successor to have happened; none may.
  await page.waitForTimeout(1_500);
  await expect(olderEntry.getByRole("button", { name: "Slow query found" })).toHaveAttribute("aria-expanded", "true");
  await expect(olderEntry.getByText("The orders join scans every row.")).toBeVisible();

  // Back in the inbox, the newer card still holds the words typed before the replacement.
  await openInbox(page);
  await replaced.getByRole("button", { name: "Slow query fixed" }).click();
  await expect(replaced.getByRole("textbox", { name: `Reply to ${title}` })).toHaveValue(draft);

  // Sent from the card, it answers the new version and the draft is cleared.
  await replaced.getByRole("button", { name: "Send reply" }).click();
  await expect(toRead(page)).toHaveCount(0, { timeout: 30_000 });
  expect((await history(daemon, session.id)).find((r) => r.id === second.id)?.readBy).toBe("reply");
  await page.keyboard.press("Escape");
  await expect(inbox).toBeHidden();
});

const RESIDENT = "Report watcher";

test("a resident that is not running gets a line and a relaunch hint instead of a reply box", async ({ dashboard: page, daemon }) => {
  test.setTimeout(150_000);
  const personas = await api<Array<{ id: string; name: string }>>(daemon, "/api/personas");
  const profile = await api<ResidentProfile>(daemon, "/api/residents/profiles", { settings: {
    identity: { name: RESIDENT },
    persona: { personaId: personas.find((p) => p.name === "Code Risk Reviewer")!.id },
    workspace: { defaultRepoRoot: daemon.repo },
    execution: { model: "claude-fable-5" },
    board: { colorId: "violet" },
    // A long cadence keeps the resident between steps rather than iterating under the test.
    loop: { delaySeconds: 3600, minDelaySeconds: 60, maxDelaySeconds: 3600 },
  } });
  await api(daemon, `/api/residents/profiles/${profile.id}/launch`, { repoRoot: daemon.repo, requestId: "launch-report-watcher" });
  await expect.poll(() => withDaemonDb(daemon, (db) => (db.prepare(
    "SELECT COUNT(*) AS n FROM resident_runs WHERE ended_at IS NULL AND launch_state = 'launched' AND loop_state = 'waiting'",
  ).get() as { n: number }).n), { timeout: 60_000 }).toBe(1);
  const resident = (await api<Session[]>(daemon, "/api/sessions")).find((s) => s.task)!;
  await setInbox(daemon, true);
  const posted = await report(daemon, resident.cwd!, { title: "Two risky migrations", body: "Both drop a column." });
  expect(posted.author.residentProfileId).toBe(profile.id);

  // Running, the card offers a reply box addressed to the resident.
  let inbox = await openInbox(page);
  let card = inbox.getByRole("article", { name: "Report: Two risky migrations" });
  await card.getByRole("button", { name: "Two risky migrations" }).click();
  await expect(card.getByRole("textbox", { name: `Reply to ${RESIDENT}` })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(inbox).toBeHidden();

  // Stopped, the card says so and where to launch it, as text: no box, no follow-up.
  await api(daemon, `/api/sessions/${resident.id}/kill`, {});
  await expect.poll(async () => (await api<Session[]>(daemon, "/api/sessions")).some((s) => s.id === resident.id && s.state !== "exited"),
    { timeout: 60_000 }).toBe(false);
  inbox = await openInbox(page);
  card = inbox.getByRole("article", { name: "Report: Two risky migrations" });
  await expect(card).toContainText(`${RESIDENT} isn't running.`);
  await expect(card).toContainText("launch it again from the Residents drawer");
  await expect(card.getByRole("textbox")).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Send reply" })).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Start a follow-up task" })).toHaveCount(0);
  // Reading it needs no running agent.
  await expect(card.getByRole("button", { name: "Mark read" })).toBeVisible();
  await capture(card, "06-resident-not-running", page);
});
