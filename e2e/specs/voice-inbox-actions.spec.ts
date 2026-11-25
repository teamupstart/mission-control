import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { APIResponse, Page, Route } from "@playwright/test";
import type { ReportItem, ReportMute } from "../../src/shared/reports.ts";
import type { Session, Task } from "../../src/shared/types.ts";
import type { OpenCardsReport } from "../../src/shared/voice-answers.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { expect, test } from "../fixtures/test.ts";
import { captureCard, postCachePlan, runningAgent, setupCards } from "../fixtures/voice-cards.ts";
import { say, voiceToken } from "../fixtures/voice.ts";
import { serveStallPoll } from "../fixtures/stall-poll.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import { INBOX_MESSAGES } from "../../src/shared/inbox.ts";

async function postReport(daemon: DaemonHandle, session: Session, title: string, file?: string): Promise<ReportItem> {
  const response = await fetch(daemon.baseURL + "/mcp/reports", { method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": voiceToken(daemon) },
    body: JSON.stringify({ cwd: session.cwd, env: {}, title, body: "Build the native addon before the tests.", file }),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()).report;
}

async function storedReport(daemon: DaemonHandle, id: string): Promise<ReportItem> {
  return (await (await fetch(daemon.baseURL + "/api/reports/" + id)).json()).report;
}

async function openReportCard(page: Page, report: ReportItem) {
  const dialog = page.getByRole("dialog", { name: "Attention inbox" });
  if (!await dialog.isVisible()) await page.locator("button.pulse-seg", { hasText: "to read" }).click();
  await expectContentClearsBorder(dialog);
  const card = dialog.getByRole("article", { name: "Report: " + report.title });
  await card.getByRole("button", { name: report.title }).click();
  return card;
}

test("Steve's Nudge runs from Report focus, Open report runs from Stuck focus, and Mark read still cancels", async ({ dashboard: page, daemon }) => {
  test.setTimeout(120_000);
  await setupCards(page, daemon, 2);
  const steve = await runningAgent(page, daemon, "Steve");
  writeFileSync(join(steve.cwd!, "diagnosis.md"), "# Build failure diagnosed\nBuild the native addon before the tests.");
  const report = await postReport(daemon, steve, "Build failure diagnosed", "diagnosis.md");
  await serveStallPoll(page, () => [{ sessionId: steve.id, kind: "silent-working", fingerprint: "silent-1", reason: "Working but silent for 12m", forMs: 720000,
    facts: { kind: "silent-working", activity: "Running npm test", quietSince: 0 } }]);
  const dialog = page.getByRole("dialog", { name: "Attention inbox" });
  const row = dialog.locator(".inbox-stuck");
  const focusReported = (id: string) => page.waitForResponse(response => {
    if (!response.ok() || !response.url().endsWith("/api/voice/open-cards")) return false;
    const { cards, focused } = response.request().postDataJSON() as OpenCardsReport;
    return focused && cards.some(c => c.id === report.id) && cards.some(c => c.id === steve.id)
      && cards.some(c => c.id === id && c.focused);
  });
  const reportFocused = focusReported(report.id);
  const card = await openReportCard(page, report);
  await reportFocused;
  await expect(card.locator(".vh-foot q")).toHaveText(["Steve, mark read", "Steve, open report", "Steve, publish as scout", "Steve, mute reports", "Steve, …"]);
  await expect(card.locator(".vh-foot")).toHaveCSS("border-top-style", "dashed");
  await captureCard(card, "report-voice-foot");
  await say(daemon, "Steve, nudge");
  await expect(row.getByRole("status")).toHaveText("Nudge sent.");
  await captureCard(dialog, "cross-card-nudge");
  await expect.poll(async () => {
    const response = await page.request.get(daemon.baseURL + "/api/sessions/" + encodeURIComponent(steve.id) + "/transcript");
    return (await response.json()).messages.some((m: { text: string; role: string }) => m.role === "user" && m.text.includes(INBOX_MESSAGES.nudge));
  }).toBe(true);
  expect((await storedReport(daemon, report.id)).readAt).toBeNull();
  const stuckFocused = focusReported(steve.id);
  await row.getByRole("textbox", { name: "Message Steve" }).focus();
  await stuckFocused;
  await say(daemon, "Steve, open report");
  const reader = page.getByRole("dialog", { name: "Report document: Build failure diagnosed" });
  await expectContentClearsBorder(reader);
  await reader.getByRole("button", { name: "Close" }).click();
  await expect(reader).toBeHidden();
  await say(daemon, "Steve, mark read");
  await expect(page.getByRole("button", { name: "Run now" })).toBeVisible();
  await say(daemon, "cancel");
  expect((await storedReport(daemon, report.id)).readAt).toBeNull();
  const markRead = page.waitForResponse(response => response.url().endsWith(`/api/reports/${report.id}/read`) && response.request().method() === "POST");
  await say(daemon, "Steve, mark read");
  expect((await markRead).status()).toBe(200);
  expect((await storedReport(daemon, report.id)).readBy).toBe("mark-read");
  await expect(row.locator(".vh-foot")).toContainText("Steve, nudge");
  // The busy fake agent also offers Stop alongside Nudge, as in the approved foot line.
  expect((await page.request.post(daemon.baseURL + "/api/sessions/" + encodeURIComponent(steve.id) + "/send", {
    data: { text: "hold the current turn open for queued review setup", submit: true },
  })).ok()).toBe(true);
  await expect(row.locator(".vh-foot q")).toHaveText(["Steve, nudge", "Steve, stop", "Steve, …"]);
  await captureCard(row, "stuck-voice-foot");
  await say(daemon, "Steve, stop");
  await expect(row.getByRole("button", { name: "Interrupt" })).toBeHidden();
  await say(daemon, "reply, run the focused check");
  await expect(row.getByRole("status")).toHaveText("Message sent.");
});

test("named plan fills and submit use the visible plan while Steve's Report has focus", async ({ dashboard: page, daemon }) => {
  await setupCards(page, daemon, 1);
  const steve = await runningAgent(page, daemon, "Steve");
  const planId = await postCachePlan(daemon, steve);
  const report = await postReport(daemon, steve, "Review notes");
  const dialog = page.getByRole("dialog", { name: "Attention inbox" });
  const form = dialog.locator(".review-plan-decisions");
  await page.locator("button.pulse-seg", { hasText: "to answer" }).click();
  await expect(form).toBeVisible();
  const focused = page.waitForResponse(r => {
    if (!r.ok() || !r.url().endsWith("/api/voice/open-cards")) return false;
    const { cards } = r.request().postDataJSON() as OpenCardsReport;
    return cards.some(c => c.id === planId) && cards.some(c => c.id === report.id && c.focused);
  });
  const card = await openReportCard(page, report);
  await card.getByRole("textbox").focus();
  await expect(card.getByRole("textbox")).toBeFocused();
  await focused;
  await say(daemon, "Steve, first one B, second one A, third one A");
  await expect(form.locator(".pd-ord.is-voice")).toHaveCount(3);
  await expect(card.getByRole("textbox")).toBeFocused();
  await captureCard(form, "named-plan-from-report-focus");
  await say(daemon, "Steve, first one A");
  await say(daemon, "Steve, submit");
  await expect.poll(async () => {
    const response = await page.request.get(daemon.baseURL + "/api/reviews/" + planId);
    const review = await response.json();
    return [review.status, review.selections?.map((answer: { selected: string[] }) => answer.selected)];
  }).toEqual(["answered", [["a"], ["a"], ["a"]]]);
  expect((await storedReport(daemon, report.id)).readAt).toBeNull();
});

test("an unavailable named Publish action leaves the focused report unread and sends no reply", async ({ dashboard: page, daemon }) => {
  await setupCards(page, daemon, 1);
  const steve = await runningAgent(page, daemon, "Steve");
  const report = await postReport(daemon, steve, "Report without a document");
  const replies: string[] = [];
  page.on("request", request => {
    if (request.url().endsWith(`/api/reports/${report.id}/reply`)) replies.push(request.postData() ?? "");
  });
  const focused = page.waitForResponse(r => r.ok() && r.url().endsWith("/api/voice/open-cards") &&
    (r.request().postDataJSON() as OpenCardsReport).cards.some(c => c.id === report.id && c.focused));
  const card = await openReportCard(page, report);
  await expect(card.getByRole("button", { name: "Publish as scout" })).toHaveCount(0);
  await card.getByRole("textbox").focus();
  await focused;
  await say(daemon, "Steve, publish as scout");
  const notice = page.getByRole("status").filter({ hasText: "The inbox action is no longer available." });
  await expect(notice).toBeVisible();
  await captureCard(notice, "unavailable-publish-notice");
  await expect(card.getByRole("textbox")).toHaveValue("");
  expect((await storedReport(daemon, report.id)).readAt).toBeNull();
  expect(replies).toEqual([]);
});

test("turning off Plan forms by voice in Settings preserves manual answers while spoken Mark read still works", async ({ dashboard: page, daemon }) => {
  await page.setViewportSize({ width: 1920, height: 1400 });
  await setupCards(page, daemon, 1);
  const steve = await runningAgent(page, daemon, "Steve");
  const planId = await postCachePlan(daemon, steve);
  const toAnswer = page.locator("button.pulse-seg", { hasText: "to answer" });
  const dialog = page.getByRole("dialog", { name: "Attention inbox" });
  const form = dialog.locator(".review-plan-decisions");
  const manual = form.getByRole("radio", { name: /SQLite/ });
  await toAnswer.click();
  await expectContentClearsBorder(dialog);
  await expect(form.locator(".pd-ord")).toHaveText(["1st", "2nd", "3rd"]);
  await manual.check();
  await dialog.getByRole("button", { name: "Close (esc)" }).click();
  await expect(dialog).toBeHidden();

  await page.getByRole("button", { name: /^Settings\b/ }).click();
  await page.getByRole("tablist", { name: "Settings categories" }).getByRole("tab", { name: "Voice" }).click();
  const toggle = page.getByRole("checkbox", { name: "Plan forms by voice" });
  await expect(toggle).toBeEnabled();
  await expect(toggle).toBeChecked();
  const saved = page.waitForResponse(r => r.url().endsWith("/api/voice/config") && r.request().method() === "PUT" &&
    r.request().postDataJSON().planFormsByVoice === false);
  await toggle.uncheck();
  expect((await saved).ok()).toBe(true);
  await expect(toggle).not.toBeChecked();
  await page.getByRole("button", { name: "← Fleet" }).click();

  await toAnswer.click();
  await expect(manual).toBeChecked();
  await expect(form.locator(".pd-ord, .pd-key, .vh-foot")).toHaveCount(0);
  await say(daemon, "Steve, first one B, second one A");
  await expect(page.getByRole("status").filter({ hasText: /Queued for Steve|Held for Steve|Sent to Steve/ })).toBeVisible();
  await expect(manual).toBeChecked();
  await expect(form.getByRole("radio", { checked: true })).toHaveCount(1);

  writeFileSync(join(steve.cwd!, "build-notes.md"), "# Build notes\nBuild the native addon before the tests.");
  const report = await postReport(daemon, steve, "Native build notes", "build-notes.md");
  const reportOpen = page.waitForResponse(r => r.url().endsWith("/api/voice/open-cards") && r.ok() &&
    (r.request().postDataJSON() as OpenCardsReport).cards.some(c => c.id === report.id));
  const reportCard = await openReportCard(page, report);
  await reportOpen;
  const foot = reportCard.locator(".vh-foot");
  await expect(foot).toHaveText("Say Steve, mark read, Steve, open report, Steve, publish as scout or Steve, mute reports. Steve, … sends a reply.");
  await reportCard.scrollIntoViewIfNeeded();
  await expect(reportCard).toBeInViewport({ ratio: 1 });
  const lines = await foot.locator("span").evaluate(el => {
    const range = document.createRange();
    range.selectNodeContents(el);
    return new Set(Array.from(range.getClientRects(), rect => Math.round(rect.top))).size;
  });
  expect(lines).toBe(1);
  await captureCard(reportCard, "open-report-complete-hint");
  await say(daemon, "Steve, mark read");
  await expect(reportCard).toBeHidden();
  expect((await storedReport(daemon, report.id)).readBy).toBe("mark-read");

  await expect(manual).toBeChecked();
  await expect(form.getByRole("radio", { checked: true })).toHaveCount(1);
  await expect(form.getByRole("button", { name: "Submit", exact: true })).toBeDisabled();
  expect((await (await page.request.get(daemon.baseURL + "/api/reviews/" + planId)).json()).status).toBe("pending");
  await captureCard(form, "plan-voice-setting-off");
});

test("an expired Mark read claim reports failure and cannot invoke the button; a fresh claim uses the card's refusal handler", async ({ dashboard: page, daemon }) => {
  await setupCards(page, daemon, 1);
  const steve = await runningAgent(page, daemon, "Steve");
  const report = await postReport(daemon, steve, "Read claim");
  const card = await openReportCard(page, report);
  await expect(card.locator(".vh-foot")).toContainText("Steve, mark read");
  let claim: Route | undefined;
  await page.route("**/api/voice/inbox-actions/*/claim", route => { claim = route; }, { times: 1 });
  let writes = 0;
  await page.route(`**/api/reports/${report.id}/read`, route => {
    writes++;
    return route.fulfill({ status: 409, json: { error: "Report read refused by the fixture" } });
  });
  await say(daemon, "Steve, mark read");
  await expect.poll(() => !!claim).toBe(true);
  const failure = page.getByRole("status").filter({ hasText: "The inbox action is no longer available." });
  await expect(failure).toHaveClass(/vc-failed/, { timeout: 10_000 });
  await expect(failure).toBeVisible();
  await captureCard(failure, "expired-inbox-claim");
  const late = page.waitForResponse(response => response.url() === claim!.request().url());
  await claim!.continue();
  expect((await late).status()).toBe(409);
  expect(writes).toBe(0);
  expect((await storedReport(daemon, report.id)).readAt).toBeNull();

  await say(daemon, "Steve, mark read");
  await expect(card.getByRole("alert")).toHaveText("Report read refused by the fixture");
  expect(writes).toBe(1);
});

test("closing a Report while its accepted Mark read claim is in flight fails the voice action and leaves the report unread", async ({ dashboard: page, daemon }) => {
  await setupCards(page, daemon, 1);
  const steve = await runningAgent(page, daemon, "Steve");
  const report = await postReport(daemon, steve, "Close during Mark read");
  const card = await openReportCard(page, report);
  await expect(card.locator(".vh-foot")).toContainText("Steve, mark read");
  const accepted = Promise.withResolvers<{ route: Route; response: APIResponse }>();
  await page.route("**/api/voice/inbox-actions/*/claim", async route => {
    // Let the real daemon grant the claim, but hold its response on the way back to the dashboard.
    accepted.resolve({ route, response: await route.fetch() });
  }, { times: 1 });
  const writes: string[] = [];
  page.on("request", request => {
    if (request.method() === "POST" && request.url().endsWith(`/api/reports/${report.id}/read`)) writes.push(request.url());
  });
  await say(daemon, "Steve, mark read");
  const { route, response } = await accepted.promise;
  expect(response.status()).toBe(200);
  const outcome = async () => (await (await page.request.get(daemon.baseURL + "/api/voice/heard")).json()).entries[0].outcome;
  expect(await outcome()).toBe("pending");
  await page.getByRole("dialog", { name: "Attention inbox" }).getByRole("button", { name: "Close (esc)" }).click();
  await expect(card).toBeHidden();
  const completion = page.waitForResponse(res => res.url() === route.request().url().replace(/\/claim$/, "/complete"));
  await route.fulfill({ response });
  const receipt = await completion;
  expect(receipt.status()).toBe(200);
  expect(receipt.request().postDataJSON()).toEqual({ invoked: false });
  const failure = page.getByRole("status").filter({ hasText: "The inbox action is no longer available." });
  await expect(failure).toHaveClass(/vc-failed/);
  expect(await outcome()).toBe("failed");
  expect(writes).toEqual([]);
  expect((await storedReport(daemon, report.id)).readAt).toBeNull();
  await captureCard(page, "closed-report-claim");
});

test("spoken Publish as scout archives the attachment, Reply delivers its words, and Mute hides the author's unread report", async ({ dashboard: page, daemon }) => {
  await setupCards(page, daemon, 1);
  const steve = await runningAgent(page, daemon, "Steve");
  writeFileSync(join(steve.cwd!, "scout.md"), "# Build diagnosis\n\nBuild the native addon first.");
  const report = await postReport(daemon, steve, "Publish build diagnosis", "scout.md");
  const card = await openReportCard(page, report);
  await expect(card.locator(".vh-foot")).toContainText("Steve, publish as scout");
  await say(daemon, "Steve, publish as scout");
  await expect(card.getByRole("status").filter({ hasText: "Published" })).toBeVisible({ timeout: 30_000 });
  const published = await storedReport(daemon, report.id);
  expect(published.publishedArchiveKey).toBeTruthy();
  expect(published.readAt).toBeNull();

  const reply = "Please verify the native build";
  await say(daemon, "reply, " + reply);
  await expect(card).toBeHidden();
  expect((await storedReport(daemon, report.id)).readBy).toBe("reply");
  await expect.poll(async () => {
    const { messages } = await (await fetch(daemon.baseURL + "/api/sessions/" + encodeURIComponent(steve.id) + "/transcript")).json();
    return messages.some((m: { role: string; text: string }) => m.role === "user" && m.text.includes(report.id) && m.text.includes(reply));
  }).toBe(true);

  const next = await postReport(daemon, steve, "Further build notes");
  const nextCard = await openReportCard(page, next);
  await expect(nextCard.locator(".vh-foot")).toContainText("Steve, mute reports");
  await say(daemon, "Steve, mute reports");
  await expect(nextCard).toBeHidden();
  const { mutes } = await (await fetch(daemon.baseURL + "/api/reports/mutes")).json();
  expect(mutes.map((mute: ReportMute) => mute.authorKey)).toContain(next.author.key);
  expect((await storedReport(daemon, next.id)).readAt).toBeNull();
});

test("Steve's Mark read invokes the open report from the task's previous session", async ({ dashboard: page, daemon }) => {
  await setupCards(page, daemon, 1);
  const first = await runningAgent(page, daemon, "Steve");
  const prior = await postReport(daemon, first, "First session results");
  const taskPath = daemon.baseURL + "/api/tasks/" + first.task!.id;
  const requeued = await page.request.post(taskPath + "/requeue", { data: {} });
  expect(requeued.ok(), await requeued.text()).toBe(true);
  const dispatched = await page.request.post(taskPath + "/dispatch", { data: { overrideDisabled: true } });
  expect(dispatched.ok(), await dispatched.text()).toBe(true);
  let current!: Session;
  await expect.poll(async () => {
    const sessions: Session[] = await (await page.request.get(daemon.baseURL + "/api/sessions")).json();
    current = sessions.find(s => s.task?.id === first.task!.id && s.id !== first.id)!;
    return current?.agentSessionId && current.state;
  }, { timeout: 60_000 }).toBe("idle");
  const latest = await postReport(daemon, current, "Second session results");
  expect(latest.author.key).not.toBe(prior.author.key);
  const observed = page.waitForResponse(r => r.ok() && r.url().endsWith("/api/voice/open-cards") &&
    (r.request().postDataJSON() as OpenCardsReport).cards.some(c => c.id === prior.id && c.kind === "report" && c.actions?.includes("mark-read")));
  const card = await openReportCard(page, prior);
  await expect(card.locator(".vh-foot")).toContainText("Steve, mark read");
  await observed;
  const read = page.waitForResponse(r => r.url().endsWith(`/api/reports/${prior.id}/read`) && r.request().method() === "POST");
  await say(daemon, "Steve, mark read");
  expect((await read).ok()).toBe(true);
  await expect(card).toBeHidden();
  expect((await storedReport(daemon, prior.id)).readBy).toBe("mark-read");
  expect((await storedReport(daemon, latest.id)).readAt).toBeNull();
});

test("dictated follow-up instructions start a new task for an ended session's report", async ({ dashboard: page, daemon }) => {
  await setupCards(page, daemon, 1);
  const steve = await runningAgent(page, daemon, "Steve");
  const report = await postReport(daemon, steve, "Repair the build");
  const complete = await page.request.post(daemon.baseURL + "/api/tasks/" + steve.task!.id + "/complete", { data: { outcome: "Diagnosed" } });
  expect(complete.ok(), await complete.text()).toBe(true);
  const card = await openReportCard(page, report);
  await expect(card.getByRole("textbox", { name: "Instructions for the follow-up task" })).toBeVisible();
  const instructions = "Rebuild the addon and verify the tests";
  await say(daemon, "reply, " + instructions);
  await expect.poll(async () => (await storedReport(daemon, report.id)).readBy, { timeout: 30_000 }).toBe("follow-up");
  const { followUpTaskId } = await storedReport(daemon, report.id);
  const tasks: Task[] = await (await fetch(daemon.baseURL + "/api/tasks")).json();
  const followUp = tasks.find(t => t.id === followUpTaskId);
  expect(followUpTaskId).toBeTruthy();
  expect(followUpTaskId).not.toBe(steve.task!.id);
  expect(followUp?.intent).toContain(instructions);
  expect(followUp?.intent).toContain(report.body);
});
