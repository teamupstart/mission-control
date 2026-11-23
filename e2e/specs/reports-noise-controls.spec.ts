import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import { DEFAULT_REPORT_GUIDANCE, type ReportItem } from "../../src/shared/reports.ts";
import type { Session, Task } from "../../src/shared/types.ts";

/**
 * What is at stake: when agent reports get chatty, the operator has three controls, and none of
 * them loses a report.
 *
 * - **Report guidance**, edited in Settings > Reports, is what the daemon hands the next session's
 *   `post_report` tool; Reset to default puts the shipped text back.
 * - **Mute** on a report card takes that agent's rows out of the inbox and the to read figure and
 *   stops its later notifications, without marking anything read: Settings lists it, and Unmute
 *   brings every waiting report back. A notification raised before the mute still opens its report,
 *   on its own under "Opened from a notification", with no Mute control on it.
 * - **Mark all read** on the Reports heading clears exactly what was listed.
 *
 * Real daemon, real routes, real SSE and the real built dashboard. Reports are posted on the MCP
 * tool's own channel, the session's working and stopping arrive through the real hook ingest, the
 * agents are the suite's fakes, and only the OS notification constructor is stubbed - it records
 * each toast and keeps it so the test can click it the way a person would.
 */

const EVIDENCE = artifactsDir("reports-noise-controls");

async function capture(target: Locator | Page, name: string, page: Page): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await expect(page.locator(".tooltip")).toHaveCount(0, { timeout: 3000 }).catch(() => undefined);
  await target.screenshot({ path: join(EVIDENCE, `${name}.png`) });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/reports-noise-controls/${name}.png`);
}

type ToastWindow = Window & {
  __toasts: Array<{ title: string; body: string; tag: string }>;
  __toastByTag: Record<string, { onclick: (() => void) | null }>;
};

/** Record every desktop notification the app raises, and keep each so it can be clicked. */
async function captureToasts(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as ToastWindow;
    w.__toasts = [];
    w.__toastByTag = {};
    class FakeNotification {
      onclick: (() => void) | null = null;
      static permission = "granted";
      static requestPermission = async (): Promise<string> => "granted";
      constructor(title: string, options?: { body?: string; tag?: string }) {
        w.__toasts.push({ title, body: options?.body ?? "", tag: options?.tag ?? "" });
        w.__toastByTag[options?.tag ?? ""] = this;
      }
      close(): void {}
    }
    (window as unknown as { Notification: unknown }).Notification = FakeNotification;
  });
}

const toasts = (page: Page) => page.evaluate(() => (window as unknown as ToastWindow).__toasts);
const toastTags = async (page: Page) => (await toasts(page)).map((t) => t.tag);
/** Click a toast already raised, as the OS would on a person's click. */
const clickToast = (page: Page, reportId: string) =>
  page.evaluate((tag) => (window as unknown as ToastWindow).__toastByTag[tag]?.onclick?.(), `report:${reportId}`);

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

/** What the MCP child reads as it starts: the guidance in force, with the machine token. */
async function toolGuidance(daemon: DaemonHandle): Promise<string> {
  const res = await fetch(`${daemon.baseURL}/mcp/reports/guidance`, { headers: { "x-harness-token": token(daemon) } });
  expect(res.status).toBe(200);
  return (await res.json() as { guidance: string }).guidance;
}

/** The session's working and stopping, through the real hook ingest. */
async function hook(daemon: DaemonHandle, session: Session, event: "PreToolUse" | "Stop"): Promise<void> {
  const res = await fetch(`${daemon.baseURL}/hooks/${event}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": token(daemon) },
    body: JSON.stringify({
      agent: session.agent, sessionId: session.agentSessionId, cwd: session.cwd, env: {}, toolName: "Bash",
    }),
  });
  expect(res.status, await res.clone().text()).toBe(204);
}

async function stateOf(daemon: DaemonHandle, id: string): Promise<string | undefined> {
  return (await api<Session[]>(daemon, "/api/sessions")).find((s) => s.id === id)?.state;
}

/** Post a report the way the MCP `post_report` tool does: mid-turn, from the session's checkout. */
async function post(daemon: DaemonHandle, session: Session, body: Record<string, unknown>): Promise<ReportItem> {
  const res = await fetch(`${daemon.baseURL}/mcp/reports`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": token(daemon) },
    body: JSON.stringify({ env: {}, cwd: session.cwd, ...body }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json() as { report: ReportItem }).report;
}

async function report(daemon: DaemonHandle, id: string): Promise<ReportItem> {
  return (await api<{ report: ReportItem }>(daemon, `/api/reports/${id}`)).report;
}

/** Post while working, then stop: the report is stamped back, which is what raises its toast. */
async function postAndStop(daemon: DaemonHandle, session: Session, body: Record<string, unknown>): Promise<ReportItem> {
  await hook(daemon, session, "PreToolUse");
  await expect.poll(() => stateOf(daemon, session.id)).toBe("working");
  const posted = await post(daemon, session, body);
  await hook(daemon, session, "Stop");
  await expect.poll(async () => (await report(daemon, posted.id)).announcedAs).toBe("back");
  return posted;
}

/** One idle agent for a task titled `title`, which is the name its reports carry. */
async function agent(daemon: DaemonHandle, title: string): Promise<Session> {
  const task = await api<Task>(daemon, "/api/tasks", {
    repoRoot: daemon.repo, title, intent: title.toLowerCase(), kind: "ship", agent: "claude", runtime: "sdk", workflowId: null,
  });
  let session!: Session;
  await expect.poll(async () => {
    session = (await api<Session[]>(daemon, "/api/sessions")).find((s) => s.task?.id === task.id)!;
    return session?.agentSessionId ? session.state : null;
  }, { timeout: 60_000 }).toBe("idle");
  return session;
}

/** Notifications on and the flag on; the page reloaded so the toast stub is in place. */
async function ready(page: Page, daemon: DaemonHandle): Promise<void> {
  await captureToasts(page);
  await api(daemon, "/api/ui/config", { alerts: { notifications: true, sound: false } }, "PUT");
  await setInbox(daemon, true);
  await page.reload();
  await expect(page.getByRole("button", { name: "Dispatch", exact: true })).toBeVisible({ timeout: 30_000 });
}

const inboxOf = (page: Page) => page.getByRole("dialog", { name: "Attention inbox" });
const toRead = (page: Page) => page.locator("button.pulse-seg", { hasText: "to read" });
const band = (inbox: Locator) => inbox.getByRole("region", { name: "Opened from a notification" });

async function openInbox(page: Page): Promise<Locator> {
  const inbox = inboxOf(page);
  await expect(async () => {
    if (!(await inbox.isVisible())) await toRead(page).click({ timeout: 3000 });
    await expect(inbox).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 45_000 });
  await expectContentClearsBorder(inbox);
  return inbox;
}

async function closeInbox(page: Page): Promise<void> {
  await inboxOf(page).getByRole("button", { name: "Close (esc)" }).click();
  await expect(inboxOf(page)).toHaveCount(0);
}

async function openSettingsReports(page: Page, daemon: DaemonHandle): Promise<Locator> {
  await page.goto(`${daemon.baseURL}/#/settings/reports`);
  const panel = page.getByRole("region", { name: "Reports", exact: true });
  await expect(panel).toBeVisible({ timeout: 30_000 });
  return panel;
}

test("report guidance saved in Settings is what the next session's tool is given, and Reset puts the default back", async ({ dashboard: page, daemon }) => {
  await setInbox(daemon, true);
  const panel = await openSettingsReports(page, daemon);
  const box = panel.getByRole("textbox", { name: "Report guidance" });
  await expect(box).toHaveValue(DEFAULT_REPORT_GUIDANCE);
  await expect(panel.getByText("Do not post progress here; use report_status for that.", { exact: false })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Reset to default" })).toBeDisabled();

  const custom = "Only post a report when a pull request is ready for review, and say which one.";
  await box.fill(custom);
  await panel.getByRole("button", { name: "Save", exact: true }).click();
  await expect(panel.getByRole("status")).toHaveText("Saved. Sessions started from now on use this guidance.");
  await expect.poll(() => toolGuidance(daemon)).toBe(custom);
  await capture(panel, "01-guidance-saved", page);

  // Stored by the daemon, not the page: a reload reads it back.
  await page.reload();
  const reread = page.getByRole("region", { name: "Reports", exact: true });
  await expect(reread.getByRole("textbox", { name: "Report guidance" })).toHaveValue(custom);

  // Over the limit cannot be saved.
  await reread.getByRole("textbox", { name: "Report guidance" }).fill("x".repeat(2001));
  await expect(reread.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await expect(reread.getByText("2,001 / 2,000")).toBeVisible();

  await reread.getByRole("button", { name: "Reset to default" }).click();
  await expect(reread.getByRole("textbox", { name: "Report guidance" })).toHaveValue(DEFAULT_REPORT_GUIDANCE);
  await expect.poll(() => toolGuidance(daemon)).toBe(DEFAULT_REPORT_GUIDANCE);
});

test("mute from the card: the row and to read go, a later report stays silent and unlisted, Settings lists it, and Unmute brings both back", async ({ dashboard: page, daemon }) => {
  test.setTimeout(180_000);
  const name = "Chase the flaky deploy";
  const session = await agent(daemon, name);
  await ready(page, daemon);

  const first = await postAndStop(daemon, session, { title: "Deploy flake narrowed down", body: "It is the DNS cache." });
  await expect.poll(() => toastTags(page)).toContain(`report:${first.id}`);
  await expect(toRead(page).locator(".pulse-n")).toHaveText("1");

  const inbox = await openInbox(page);
  const row = inbox.getByRole("region", { name: `Reports from ${name}` });
  await row.getByRole("button", { name: "Deploy flake narrowed down" }).click();
  const mute = row.getByRole("button", { name: `Mute ${name}'s reports` });
  await expect(mute).toBeVisible();
  await capture(inbox, "02-mute-on-card", page);
  await mute.click();

  // Hidden, not read: the row and the figure go, and the report is still unread.
  await expect(row).toHaveCount(0);
  await expect(inbox.getByRole("heading", { name: "Reports", exact: true })).toHaveCount(0);
  await expect(toRead(page)).toHaveCount(0);
  expect((await report(daemon, first.id)).readAt).toBeNull();
  await closeInbox(page);

  // A muted agent still posts, and its report is stamped, but it raises no notification.
  const second = await postAndStop(daemon, session, { title: "Deploy flake fixed", body: "Pinned the resolver." });
  // The stamp is in; give the dashboard every chance to (wrongly) raise it.
  await page.waitForTimeout(1500);
  expect(await toastTags(page)).not.toContain(`report:${second.id}`);
  await expect(toRead(page)).toHaveCount(0);

  // Settings lists the muted agent, by the name its reports carried.
  const panel = await openSettingsReports(page, daemon);
  const muted = panel.getByRole("list", { name: "Muted agents" });
  await expect(muted.getByText(name, { exact: true })).toBeVisible();
  await capture(panel, "03-settings-muted-agents", page);
  await panel.getByRole("button", { name: `Unmute ${name}` }).click();
  await expect(panel.getByText("No agent is muted. Mute one from its report card in the inbox.")).toBeVisible();

  // Both reports were waiting all along, so both come back.
  await page.goto(`${daemon.baseURL}/#/`);
  await expect(toRead(page).locator(".pulse-n")).toHaveText("2", { timeout: 30_000 });
  const back = await openInbox(page);
  const returned = back.getByRole("region", { name: `Reports from ${name}` });
  await expect(returned.getByRole("button", { name: "Deploy flake narrowed down" })).toBeVisible();
  await expect(returned.getByRole("button", { name: "Deploy flake fixed" })).toBeVisible();
});

test("a notification raised before the mute still opens its report, on its own, without Mute, and changes no figure", async ({ dashboard: page, daemon }) => {
  test.setTimeout(180_000);
  const loudName = "Refactor the parser";
  const quietName = "Audit the lockfile";
  const loud = await agent(daemon, loudName);
  const quiet = await agent(daemon, quietName);
  await ready(page, daemon);

  // Quiet's report stays listed throughout, so the to read figure has something to hold steady.
  await post(daemon, quiet, { title: "Lockfile audit done", body: "Nothing to change." });
  const earlier = await postAndStop(daemon, loud, { title: "Parser plan ready", body: "Split the **lexer** first." });
  await expect.poll(() => toastTags(page)).toContain(`report:${earlier.id}`);
  await expect(toRead(page).locator(".pulse-n")).toHaveText("2");

  // Mute the loud agent from its card.
  const inbox = await openInbox(page);
  const row = inbox.getByRole("region", { name: `Reports from ${loudName}` });
  await row.getByRole("button", { name: "Parser plan ready" }).click();
  await row.getByRole("button", { name: `Mute ${loudName}'s reports` }).click();
  await expect(row).toHaveCount(0);
  await expect(toRead(page).locator(".pulse-n")).toHaveText("1");
  await closeInbox(page);

  // Now the earlier notification is clicked.
  await clickToast(page, earlier.id);
  const opened = inboxOf(page);
  await expect(opened).toBeVisible();
  await expectContentClearsBorder(opened);
  const pinned = band(opened);
  await expect(pinned.getByRole("button", { name: "Parser plan ready" })).toHaveAttribute("aria-expanded", "true");
  await expect(pinned.getByText("Split the", { exact: false })).toBeVisible();
  await expect(pinned.getByRole("button", { name: /^Mute / })).toHaveCount(0);
  await expect(pinned.getByText(`${loudName}'s reports are muted`, { exact: false })).toBeVisible();
  await expect(pinned.getByText("Unmute in Settings > Reports.", { exact: false })).toBeVisible();
  // No Reports row for the muted agent, the other agent still listed, and the click changed no figure.
  await expect(opened.getByRole("region", { name: `Reports from ${loudName}` })).toHaveCount(0);
  await expect(opened.getByRole("region", { name: `Reports from ${quietName}` })).toBeVisible();
  await expect(opened.locator(".modal-head")).toContainText("1 to read");
  await expect(toRead(page).locator(".pulse-n")).toHaveText("1");
  expect((await report(daemon, earlier.id)).readAt).toBeNull();
  await capture(opened, "04-earlier-notification-after-mute", page);
});

test("Mark all read with reports from two agents clears the section and the figure, and only what was listed", async ({ dashboard: page, daemon }) => {
  test.setTimeout(180_000);
  const ada = await agent(daemon, "Profile the importer");
  const bea = await agent(daemon, "Tidy the changelog");
  await ready(page, daemon);
  const a = await post(daemon, ada, { title: "Importer profile", body: "Most time is spent in JSON parsing." });
  const b = await post(daemon, bea, { title: "Changelog tidy plan", body: "Three duplicate entries." });
  await expect(toRead(page).locator(".pulse-n")).toHaveText("2", { timeout: 30_000 });
  // The top bar before the click, undimmed: the "2 to read" figure.
  await capture(page.locator("header.topbar"), "05a-top-bar-before", page);

  const inbox = await openInbox(page);
  await expect(inbox.getByRole("region", { name: "Reports from Profile the importer" })).toBeVisible();
  await expect(inbox.getByRole("region", { name: "Reports from Tidy the changelog" })).toBeVisible();
  const markAll = inbox.getByRole("button", { name: "Mark all read" });
  await expect(markAll).toHaveCount(1);
  await capture(inbox, "05-mark-all-read", page);
  await markAll.click();

  await expect(inbox.getByRole("heading", { name: "Reports", exact: true })).toHaveCount(0);
  await expect(inbox.getByRole("region", { name: /^Reports from / })).toHaveCount(0);
  await expect(inbox.locator(".modal-head")).not.toContainText("to read");
  await expect(toRead(page)).toHaveCount(0);
  // The result, with the top bar in frame: no Reports section, and no to read figure.
  await capture(page, "06-mark-all-read-cleared", page);
  // And the top bar with the inbox closed, undimmed: the to read figure is gone.
  await closeInbox(page);
  await expect(toRead(page)).toHaveCount(0);
  await capture(page.locator("header.topbar"), "06a-top-bar-after", page);
  for (const id of [a.id, b.id]) expect((await report(daemon, id)).readBy).toBe("mark-all");

  // A report that arrives afterwards was never listed when the button was pressed, so it waits.
  const late = await post(daemon, ada, { title: "Importer fix", body: "Streamed the parse." });
  await expect(toRead(page).locator(".pulse-n")).toHaveText("1");
  expect((await report(daemon, late.id)).readAt).toBeNull();
});

test("Mark all read clears a Reports section of 1,001 reports with one click, in requests the route accepts", async ({ dashboard: page, daemon }) => {
  test.setTimeout(240_000);
  const name = "Sweep the flaky tests";
  const sweeper = await agent(daemon, name);
  await ready(page, daemon);
  const ids: string[] = [];
  for (let n = 0; n < 1001; n++) ids.push((await post(daemon, sweeper, { title: `Flaky test ${n + 1}`, body: "Quarantined." })).id);
  await expect(toRead(page).locator(".pulse-n")).toHaveText("1001", { timeout: 60_000 });

  // Every request the button sends, as the browser sent it.
  const sent: Array<{ status: number; ids: number }> = [];
  page.on("requestfinished", async (request) => {
    if (!request.url().endsWith("/api/reports/read-all")) return;
    const body = request.postDataJSON() as { ids: string[] };
    sent.push({ status: (await request.response())!.status(), ids: body.ids.length });
  });

  const inbox = await openInbox(page);
  const row = inbox.getByRole("region", { name: `Reports from ${name}` });
  await expect(row).toContainText("1001 to read");
  await capture(page, "07-mark-all-read-1001-before", page);
  await inbox.getByRole("button", { name: "Mark all read" }).click();

  await expect(row).toHaveCount(0, { timeout: 60_000 });
  await expect(inbox.getByRole("heading", { name: "Reports", exact: true })).toHaveCount(0);
  await expect(inbox.getByRole("alert")).toHaveCount(0);
  await expect(toRead(page)).toHaveCount(0);
  await capture(page, "07-mark-all-read-1001-cleared", page);
  // Batched under the route's bound, every batch accepted, every listed id sent once.
  await expect.poll(() => sent.length).toBe(2);
  expect(sent).toEqual([{ status: 200, ids: 1000 }, { status: 200, ids: 1 }]);
  const history = await api<{ reports: ReportItem[] }>(daemon, `/api/sessions/${encodeURIComponent(sweeper.id)}/reports`);
  expect(history.reports).toHaveLength(1001);
  expect(history.reports.every((report) => report.readBy === "mark-all")).toBe(true);
});

test("a refused Mark all read says why in the Reports section and leaves every report listed, counted and unread", async ({ dashboard: page, daemon }) => {
  test.setTimeout(180_000);
  const name = "Triage the nightly failures";
  const triager = await agent(daemon, name);
  await ready(page, daemon);
  const first = await post(daemon, triager, { title: "Nightly failure one", body: "A timeout in the importer." });
  const second = await post(daemon, triager, { title: "Nightly failure two", body: "A flaky snapshot." });
  await expect(toRead(page).locator(".pulse-n")).toHaveText("2", { timeout: 30_000 });

  // The daemon stays real; only this one request is answered with a refusal, as a daemon that
  // could not store it would answer.
  const refusal = "Mission Control could not mark these reports read: the database is busy";
  let refused = 0;
  await page.route("**/api/reports/read-all", async (route) => {
    refused++;
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: refusal }) });
  });

  const inbox = await openInbox(page);
  const row = inbox.getByRole("region", { name: `Reports from ${name}` });
  await inbox.getByRole("button", { name: "Mark all read" }).click();

  // The reason, under the Reports heading.
  await expect(inbox.getByRole("alert")).toHaveText(refusal);
  expect(refused).toBe(1);
  // Nothing left: the row, its two reports, the section's figure and the top bar's all stay.
  await expect(inbox.getByRole("heading", { name: "Reports", exact: true })).toBeVisible();
  await expect(row).toContainText("2 to read");
  await expect(row.getByRole("button", { name: "Nightly failure one" })).toBeVisible();
  await expect(row.getByRole("button", { name: "Nightly failure two" })).toBeVisible();
  await expect(inbox.locator(".modal-head")).toContainText("2 to read");
  await expect(toRead(page).locator(".pulse-n")).toHaveText("2");
  for (const id of [first.id, second.id]) expect((await report(daemon, id)).readAt).toBeNull();
  await capture(page, "08-mark-all-read-refused", page);

  // Let the request through: the same button clears the section, and the refusal line goes.
  await page.unroute("**/api/reports/read-all");
  await inbox.getByRole("button", { name: "Mark all read" }).click();
  await expect(row).toHaveCount(0);
  await expect(inbox.getByRole("alert")).toHaveCount(0);
  await expect(toRead(page)).toHaveCount(0);
  for (const id of [first.id, second.id]) expect((await report(daemon, id)).readBy).toBe("mark-all");
});

test("report guidance that cannot be read says so, and a refused save says why and is never shown as saved", async ({ dashboard: page, daemon }) => {
  await setInbox(daemon, true);
  // The read fails: the panel says so and offers no editor to save from.
  await page.route("**/api/reports/guidance", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "boom" }) });
  });
  const unreadable = await openSettingsReports(page, daemon);
  await expect(unreadable.getByText("The report guidance could not be read.")).toBeVisible();
  await expect(unreadable.getByRole("textbox", { name: "Report guidance" })).toHaveCount(0);
  await expect(unreadable.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
  await capture(unreadable, "09-guidance-unreadable", page);
  await page.unroute("**/api/reports/guidance");

  // The read works again; now the save is refused.
  await page.reload();
  const panel = page.getByRole("region", { name: "Reports", exact: true });
  const box = panel.getByRole("textbox", { name: "Report guidance" });
  await expect(box).toHaveValue(DEFAULT_REPORT_GUIDANCE);
  const refusal = "Only the operator can open, mark read, reply to, follow up, publish or mute reports, or change their guidance";
  await page.route("**/api/reports/guidance", async (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    await route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: refusal }) });
  });
  const attempted = "Post a report for every commit you make.";
  await box.fill(attempted);
  await panel.getByRole("button", { name: "Save", exact: true }).click();
  await expect(panel.getByRole("alert")).toHaveText(refusal);
  // Not saved: no Saved line, the words stay in the box to try again, and the daemon still
  // hands new sessions the default.
  await expect(panel.getByRole("status")).toHaveCount(0);
  await expect(box).toHaveValue(attempted);
  await expect(panel.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
  expect(await toolGuidance(daemon)).toBe(DEFAULT_REPORT_GUIDANCE);
  // Evidence only: the clicked Save's tooltip would cover the refusal in the screenshot.
  if (process.env.MC_E2E_EVIDENCE === "1") await page.addStyleTag({ content: ".tooltip { display: none !important; }" });
  await capture(panel, "10-guidance-save-refused", page);

  // Let it through: the same Save stores it.
  await page.unroute("**/api/reports/guidance");
  await panel.getByRole("button", { name: "Save", exact: true }).click();
  await expect(panel.getByRole("status")).toHaveText("Saved. Sessions started from now on use this guidance.");
  await expect(panel.getByRole("alert")).toHaveCount(0);
  await expect.poll(() => toolGuidance(daemon)).toBe(attempted);
});

test("a refused Mute says why on the card and leaves the report listed; a refused Unmute says why and leaves the agent muted", async ({ dashboard: page, daemon }) => {
  test.setTimeout(180_000);
  const name = "Watch the release branch";
  const watcher = await agent(daemon, name);
  await ready(page, daemon);
  const posted = await post(daemon, watcher, { title: "Release branch is green", body: "All checks passed." });
  await expect(toRead(page).locator(".pulse-n")).toHaveText("1", { timeout: 30_000 });
  const mutes = async () => (await api<{ mutes: Array<{ authorKey: string }> }>(daemon, "/api/reports/mutes")).mutes;

  // Mute is refused.
  const muteRefusal = "Mission Control could not mute these reports: the database is busy";
  await page.route("**/api/reports/mutes", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: muteRefusal }) });
  });
  const inbox = await openInbox(page);
  const row = inbox.getByRole("region", { name: `Reports from ${name}` });
  await row.getByRole("button", { name: "Release branch is green" }).click();
  await row.getByRole("button", { name: `Mute ${name}'s reports` }).click();
  await expect(row.getByRole("alert")).toHaveText(muteRefusal);
  // Nothing was muted: the row, its report, its Mute control and both figures stay.
  await expect(row.getByRole("button", { name: `Mute ${name}'s reports` })).toBeVisible();
  await expect(row).toContainText("1 to read");
  await expect(toRead(page).locator(".pulse-n")).toHaveText("1");
  expect(await mutes()).toEqual([]);
  expect((await report(daemon, posted.id)).readAt).toBeNull();
  await capture(inbox, "11-mute-refused", page);

  // Let it through: the same control mutes, and the row leaves.
  await page.unroute("**/api/reports/mutes");
  await row.getByRole("button", { name: `Mute ${name}'s reports` }).click();
  await expect(row).toHaveCount(0);
  expect((await mutes()).map((mute) => mute.authorKey)).toEqual([posted.author.key]);
  await closeInbox(page);

  // Unmute is refused.
  const unmuteRefusal = "Mission Control could not unmute these reports: the database is busy";
  await page.route("**/api/reports/mutes/*", async (route) => {
    if (route.request().method() !== "DELETE") return route.fallback();
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: unmuteRefusal }) });
  });
  const panel = await openSettingsReports(page, daemon);
  const list = panel.getByRole("list", { name: "Muted agents" });
  await expect(list.getByText(name, { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: `Unmute ${name}` }).click();
  await expect(panel.getByRole("alert")).toHaveText(unmuteRefusal);
  // Still muted: listed here, enabled to try again, kept by the daemon, and its report unlisted.
  await expect(list.getByText(name, { exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: `Unmute ${name}` })).toBeEnabled();
  expect((await mutes()).map((mute) => mute.authorKey)).toEqual([posted.author.key]);
  await capture(panel, "12-unmute-refused", page);

  // Let it through: the same control unmutes, and the report is listed again.
  await page.unroute("**/api/reports/mutes/*");
  await panel.getByRole("button", { name: `Unmute ${name}` }).click();
  await expect(panel.getByText("No agent is muted. Mute one from its report card in the inbox.")).toBeVisible();
  await expect(panel.getByRole("alert")).toHaveCount(0);
  expect(await mutes()).toEqual([]);
  await page.goto(`${daemon.baseURL}/#/`);
  await expect(toRead(page).locator(".pulse-n")).toHaveText("1", { timeout: 30_000 });
});

test("Unmute for an agent another window already unmuted is no error: no alert, and the list says nobody is muted", async ({ dashboard: page, daemon }) => {
  test.setTimeout(180_000);
  const name = "Follow the deploy queue";
  const follower = await agent(daemon, name);
  await ready(page, daemon);
  const posted = await post(daemon, follower, { title: "Deploy queue drained", body: "Nothing waiting." });
  await api(daemon, "/api/reports/mutes", { authorKey: posted.author.key });
  const mutes = async () => (await api<{ mutes: Array<{ authorKey: string }> }>(daemon, "/api/reports/mutes")).mutes;

  const panel = await openSettingsReports(page, daemon);
  const list = panel.getByRole("list", { name: "Muted agents" });
  await expect(list.getByText(name, { exact: true })).toBeVisible();

  // Another window unmutes first: as this window's Unmute reaches the daemon, the agent has just
  // been unmuted there, so the real route answers 404 "that author is not muted".
  const answers: number[] = [];
  await page.route("**/api/reports/mutes/*", async (route) => {
    if (route.request().method() !== "DELETE") return route.fallback();
    const other = await fetch(`${daemon.baseURL}/api/reports/mutes/${encodeURIComponent(posted.author.key)}`, { method: "DELETE" });
    expect(other.status).toBe(200);
    const response = await route.fetch();
    answers.push(response.status());
    await route.fulfill({ response });
  });
  await panel.getByRole("button", { name: `Unmute ${name}` }).click();

  await expect.poll(() => answers).toEqual([404]);
  // The outcome asked for is the outcome there is: no refusal, and nobody muted.
  await expect(panel.getByText("No agent is muted. Mute one from its report card in the inbox.")).toBeVisible();
  await expect(panel.getByRole("alert")).toHaveCount(0);
  expect(await mutes()).toEqual([]);
  await capture(panel, "13-unmute-already-unmuted", page);
  // And the agent's report is listed again.
  await page.unroute("**/api/reports/mutes/*");
  await page.goto(`${daemon.baseURL}/#/`);
  await expect(toRead(page).locator(".pulse-n")).toHaveText("1", { timeout: 30_000 });
});
