import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import type { ReportItem } from "../../src/shared/reports.ts";
import type { Session, Task } from "../../src/shared/types.ts";

/**
 * What is at stake: an agent posts a report with `post_report` and carries on, and the operator
 * reads it. The top bar shows a separate "to read" figure; the inbox lists the report under
 * Reports, after Stuck finalizations and right before Snoozed; opening it changes no figure;
 * Mark read clears it; a replacing report takes the earlier one's place with "updated 1 time";
 * and nothing about the session turns amber. With the `inbox` flag off none of it shows, and the
 * tool's channel refuses.
 *
 * Real daemon, real routes, real SSE and the real built dashboard. Reports are posted on the
 * exact channel the MCP `post_report` tool uses (`/mcp/reports` with the daemon token and the
 * session's own checkout), the agents are the suite's fakes, and the flag is switched through its
 * own route while the page stays open.
 */

const EVIDENCE = artifactsDir("reports");

async function capture(target: Locator | Page, name: string, page: Page): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.mouse.move(0, 0);
  await expect(page.locator(".tooltip")).toHaveCount(0, { timeout: 3000 }).catch(() => undefined);
  await target.screenshot({ path: join(EVIDENCE, `${name}.png`) });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/reports/${name}.png`);
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
async function postReport(daemon: DaemonHandle, cwd: string, body: Record<string, unknown>): Promise<Response> {
  return await fetch(`${daemon.baseURL}/mcp/reports`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": token(daemon) },
    body: JSON.stringify({ env: {}, cwd, ...body }),
  });
}

async function report(daemon: DaemonHandle, cwd: string, body: Record<string, unknown>): Promise<ReportItem> {
  const res = await postReport(daemon, cwd, body);
  expect(res.status, await res.clone().text()).toBe(200);
  const answer = await res.json() as { report: ReportItem; receipt: string };
  expect(answer.receipt).toContain(`Report ${answer.report.id} posted to your operator's inbox`);
  return answer.report;
}

/** File a snoozable question the way the MCP `request_input` tool does. */
async function ask(daemon: DaemonHandle, cwd: string, question: string): Promise<string> {
  const res = await fetch(`${daemon.baseURL}/mcp/reviews`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": token(daemon) },
    body: JSON.stringify({ env: {}, cwd, kind: "input", title: question, body: question, snoozable: true }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json() as { id: string }).id;
}

const toRead = (page: Page) => page.locator("button.pulse-seg", { hasText: "to read" });

async function openInboxFromToRead(page: Page): Promise<Locator> {
  const inbox = page.getByRole("dialog", { name: "Attention inbox" });
  await expect(async () => {
    if (!(await inbox.isVisible())) await toRead(page).click({ timeout: 3000 });
    await expect(inbox).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 45_000 });
  await expectContentClearsBorder(inbox);
  return inbox;
}

test("a posted report is read from the inbox: to read, open, reload, replace, Mark read, and never amber", async ({ dashboard: page, daemon }) => {
  test.setTimeout(150_000);
  const title = "Diagnose the flaky build";
  const task = await api<Task>(daemon, "/api/tasks", {
    repoRoot: daemon.repo, title, intent: "diagnose the flaky build", kind: "ship", agent: "claude", runtime: "sdk", workflowId: null,
  });
  let session!: Session;
  await expect.poll(async () => {
    session = (await api<Session[]>(daemon, "/api/sessions")).find((s) => s.task?.id === task.id)!;
    return session?.agentSessionId ? session.state : null;
  }, { timeout: 60_000 }).toBe("idle");
  await page.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  const detail = page.locator(".console-detail");
  await expect(detail).toBeVisible();

  // Flag off: the tool's channel refuses with the feature named, and no figure appears.
  const refused = await postReport(daemon, session.cwd!, { title: "Too early", body: "b" });
  expect(refused.status).toBe(404);
  expect((await refused.json() as { feature?: string }).feature).toBe("inbox");
  await setInbox(daemon, true);

  const first = await report(daemon, session.cwd!, {
    title: "Build failure diagnosed",
    body: "The **cache key** ignored the lockfile, so CI restored stale modules.",
    url: "https://github.com/example/repo/pull/42",
  });
  await expect(toRead(page).locator(".pulse-n")).toHaveText("1");
  // A report is something to read, never something owed: no amber, no need you, no to answer.
  await expect(page.locator(".pulse-seg", { hasText: "need you" })).toHaveCount(0);
  await expect(page.locator(".pulse-seg", { hasText: "to answer" })).toHaveCount(0);
  await expect(detail.locator(".badge-attention")).toHaveCount(0);
  const live = (await api<Session[]>(daemon, "/api/sessions")).find((s) => s.id === session.id)!;
  expect(live.pendingReviews).toBe(0);
  expect(live.state).not.toBe("awaiting_input");
  await capture(page.locator("header.topbar"), "01-topbar-to-read", page);

  // The inbox lists it under Reports, collapsed to its title, the agent's name and its age.
  let inbox = await openInboxFromToRead(page);
  await expect(inbox.locator("h4.inbox-section", { hasText: "Reports" })).toBeVisible();
  await expect(inbox.locator(".modal-head")).toContainText("1 to read");
  let row = inbox.getByRole("region", { name: `Reports from ${title}` });
  const toggle = row.getByRole("button", { name: "Build failure diagnosed" });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(row.getByRole("article", { name: "Report: Build failure diagnosed" })).toContainText(title);
  await expect(row.getByRole("button", { name: "Mark read" })).toHaveCount(0);
  // A report row has no Dismiss: Mark read is how it leaves.
  await expect(row.getByRole("button", { name: /^Dismiss/ })).toHaveCount(0);
  await capture(inbox, "02-inbox-report-collapsed", page);

  // Opening shows the body, the link and Mark read, records the first open, and clears nothing.
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(row.locator(".agent-report-body strong", { hasText: "cache key" })).toBeVisible();
  await expect(row.getByRole("link", { name: "https://github.com/example/repo/pull/42" })).toBeVisible();
  await expect(row.getByRole("button", { name: "Mark read" })).toBeVisible();
  await expect(toRead(page).locator(".pulse-n")).toHaveText("1");
  await expect.poll(async () => (await api<{ reports: ReportItem[] }>(daemon, `/api/sessions/${session.id}/reports`))
    .reports.find((r) => r.id === first.id)?.openedAt ?? null).not.toBeNull();
  await capture(inbox, "03-inbox-report-open", page);
  await page.keyboard.press("Escape");
  await expect(inbox).toBeHidden();

  // After a reload it is still waiting to be read.
  await page.reload();
  await expect(toRead(page).locator(".pulse-n")).toHaveText("1", { timeout: 30_000 });
  inbox = await openInboxFromToRead(page);
  row = inbox.getByRole("region", { name: `Reports from ${title}` });
  await expect(row.getByRole("button", { name: "Build failure diagnosed" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(inbox).toBeHidden();

  // A replacing report takes the first one's place: one row, one figure, "updated 1 time".
  const second = await report(daemon, session.cwd!, {
    title: "Build failure fixed", body: "Keyed the cache on the lockfile hash.", replaces: first.id,
  });
  expect(second.version).toBe(2);
  inbox = await openInboxFromToRead(page);
  row = inbox.getByRole("region", { name: `Reports from ${title}` });
  await expect(row.getByRole("article")).toHaveCount(1);
  await expect(row.getByRole("article", { name: "Report: Build failure fixed" })).toContainText("updated 1 time");
  await expect(row.getByRole("button", { name: "Build failure diagnosed" })).toHaveCount(0);
  await expect(toRead(page).locator(".pulse-n")).toHaveText("1");

  // With a snoozed question also present, Reports is drawn directly above Snoozed.
  const question = "Should the cache also key on the Node version?";
  const questionId = await ask(daemon, session.cwd!, question);
  await api(daemon, `/api/reviews/${questionId}/snooze`, { delay: "1h", meanwhile: { mode: "judgment" } });
  await expect(inbox.getByRole("region", { name: `Snoozed: ${question}` })).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => inbox.locator("h4.inbox-section").allTextContents()).toEqual(["Reports", "Snoozed"]);
  await capture(inbox, "04-inbox-replaced-above-snoozed", page);

  // Mark read clears the row and the figure, and it stays read.
  await row.getByRole("button", { name: "Build failure fixed" }).click();
  await row.getByRole("button", { name: "Mark read" }).click();
  await expect(inbox.getByRole("region", { name: `Reports from ${title}` })).toHaveCount(0);
  await expect(inbox.locator("h4.inbox-section", { hasText: "Reports" })).toHaveCount(0);
  await expect(toRead(page)).toHaveCount(0);
  const history = (await api<{ reports: ReportItem[] }>(daemon, `/api/sessions/${session.id}/reports`)).reports;
  expect(history.map((r) => [r.id, r.version, r.supersededBy, r.readBy])).toEqual([
    [first.id, 1, second.id, null],
    [second.id, 2, null, "mark-read"],
  ]);
  await capture(inbox, "05-inbox-after-mark-read", page);
  await page.keyboard.press("Escape");
  await expect(inbox).toBeHidden();
  await expect(detail.locator(".badge-attention")).toHaveCount(0);
});

test("with the inbox flag off a stored report shows nothing, and turning it on brings it back without a reload", async ({ dashboard: page, daemon }) => {
  test.setTimeout(120_000);
  const title = "Audit the dependency tree";
  const task = await api<Task>(daemon, "/api/tasks", {
    repoRoot: daemon.repo, title, intent: "audit the dependency tree", kind: "ship", agent: "claude", runtime: "sdk", workflowId: null,
  });
  let session!: Session;
  await expect.poll(async () => {
    session = (await api<Session[]>(daemon, "/api/sessions")).find((s) => s.task?.id === task.id)!;
    return session?.agentSessionId ? session.state : null;
  }, { timeout: 60_000 }).toBe("idle");
  await setInbox(daemon, true);
  await report(daemon, session.cwd!, { title: "Two unmaintained packages", body: "left-pad and is-odd." });
  await expect(toRead(page).locator(".pulse-n")).toHaveText("1");

  let navigations = 0;
  page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) navigations++; });
  await setInbox(daemon, false);
  await expect(toRead(page)).toHaveCount(0);
  const refused = await postReport(daemon, session.cwd!, { title: "Hidden", body: "b" });
  expect(refused.status).toBe(404);
  await capture(page.locator("header.topbar"), "06-flag-off-no-figure", page);

  await setInbox(daemon, true);
  await expect(toRead(page).locator(".pulse-n")).toHaveText("1");
  const inbox = await openInboxFromToRead(page);
  await expect(inbox.getByRole("region", { name: `Reports from ${title}` })
    .getByRole("button", { name: "Two unmaintained packages" })).toBeVisible();
  expect(navigations, "the figure came back without a reload").toBe(0);
});

test("a refused Mark read keeps the report and says why beneath it; trying again clears it", async ({ dashboard: page, daemon }) => {
  test.setTimeout(120_000);
  const title = "Profile the slow query";
  const task = await api<Task>(daemon, "/api/tasks", {
    repoRoot: daemon.repo, title, intent: "profile the slow query", kind: "ship", agent: "claude", runtime: "sdk", workflowId: null,
  });
  let session!: Session;
  await expect.poll(async () => {
    session = (await api<Session[]>(daemon, "/api/sessions")).find((s) => s.task?.id === task.id)!;
    return session?.agentSessionId ? session.state : null;
  }, { timeout: 60_000 }).toBe("idle");
  await setInbox(daemon, true);
  const posted = await report(daemon, session.cwd!, { title: "Missing index on orders.created_at", body: "Add the index." });
  await expect(toRead(page).locator(".pulse-n")).toHaveText("1");

  const inbox = await openInboxFromToRead(page);
  const row = inbox.getByRole("region", { name: `Reports from ${title}` });
  const card = row.getByRole("article", { name: "Report: Missing index on orders.created_at" });
  await card.getByRole("button", { name: "Missing index on orders.created_at" }).click();

  // The daemon refuses this one Mark read. Scripted in the browser because a refusal is what is
  // under test here, and every other request still goes to the real daemon.
  const refusal = "The report store is busy. Try again.";
  const readPath = `**/api/reports/${posted.id}/read`;
  await page.route(readPath, (route) => route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: refusal }) }));
  await card.getByRole("button", { name: "Mark read" }).click();
  await expect(card.getByRole("alert")).toHaveText(refusal);
  await expect(card).toBeVisible();
  await expect(card.getByRole("button", { name: "Mark read" })).toBeVisible();
  await expect(toRead(page).locator(".pulse-n")).toHaveText("1");
  expect((await api<{ reports: ReportItem[] }>(daemon, `/api/sessions/${session.id}/reports`)).reports[0]!.readAt).toBeNull();
  await capture(inbox, "07-inbox-mark-read-refused", page);

  // Trying again, with the daemon answering, clears the reason and the report.
  await page.unroute(readPath);
  await card.getByRole("button", { name: "Mark read" }).click();
  await expect(row).toHaveCount(0);
  await expect(inbox.getByRole("alert")).toHaveCount(0);
  await expect(toRead(page)).toHaveCount(0);
  expect((await api<{ reports: ReportItem[] }>(daemon, `/api/sessions/${session.id}/reports`)).reports[0]!.readBy).toBe("mark-read");
});
