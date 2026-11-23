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
 * What is at stake: the operator chooses which kinds of item notify, and a report notification
 * says who is back and opens that report.
 *
 * An agent posts a report mid-turn. When it stops within the grace period the toast reads
 * "<name>'s back: <title>"; when it keeps working, "<name> posted a report: <title>". Clicking the
 * toast opens the inbox at that report - in its row when the Reports section lists it, and on its
 * own under "Opened from a notification" when it does not (reports unlisted, or already read). A
 * replaced report opens the report that replaced it. With the `inbox` flag off at the click, the
 * toast only focuses the window. "Agent reports notify" off silences the toast and leaves the row;
 * "Agent reports are listed in the inbox" off removes the section and the to read figure and
 * leaves the toast. While away nothing interrupts and the digest names who posted.
 *
 * Real daemon, real routes, real SSE and the real built dashboard. Reports are posted on the MCP
 * tool's own channel, the session's working and stopping arrive through the real hook ingest, the
 * agents are the suite's fakes, and only the OS notification constructor is stubbed - it records
 * each toast and keeps it so the test can click it the way a person would.
 */

const EVIDENCE = artifactsDir("inbox-notifications-conversation");

async function capture(target: Locator | Page, name: string, page: Page): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await expect(page.locator(".tooltip")).toHaveCount(0, { timeout: 3000 }).catch(() => undefined);
  await target.screenshot({ path: join(EVIDENCE, `${name}.png`) });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/inbox-notifications-conversation/${name}.png`);
}

type ToastWindow = Window & {
  __toasts: Array<{ title: string; body: string; tag: string }>;
  __toastByTag: Record<string, { onclick: (() => void) | null }>;
  __stream: EventSource;
  __reconnect: () => Promise<void>;
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
    // The dashboard's own stream, kept so a test can model a reconnect: the REAL daemon's next
    // snapshot is forwarded into the existing hook, exactly as `notification-sound.spec.ts` does.
    const NativeEventSource = window.EventSource;
    window.EventSource = class extends NativeEventSource {
      constructor(url: string | URL, options?: EventSourceInit) {
        super(url, options);
        if (String(url) === "/events") w.__stream = this;
      }
    };
    w.__reconnect = () => new Promise<void>((resolve, reject) => {
      w.__stream.close();
      w.__stream.dispatchEvent(new Event("error"));
      const replacement = new NativeEventSource("/events");
      replacement.onerror = () => { replacement.close(); reject(new Error("reconnect failed")); };
      replacement.onmessage = (event) => {
        if (JSON.parse(event.data).type !== "snapshot") return;
        w.__stream.dispatchEvent(new Event("open"));
        w.__stream.dispatchEvent(new MessageEvent("message", { data: event.data }));
        replacement.close();
        resolve();
      };
    });
  });
}

const toasts = (page: Page) => page.evaluate(() => (window as unknown as ToastWindow).__toasts);
const toastTitles = async (page: Page) => (await toasts(page)).map((t) => t.title);

/**
 * Evidence only: draw rows into a panel on the page and capture it. A desktop notification is OS
 * chrome no screenshot of the page can reach, so the notifications are shown as the exact title
 * and body the dashboard handed the Notification API, read from the recording stub.
 */
async function captureRows(
  page: Page,
  name: string,
  heading: string,
  rows: Array<{ title: string; body: string; note: string }>,
): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  await page.evaluate(({ heading, rows }) => {
    const panel = document.createElement("section");
    panel.id = "e2e-evidence-panel";
    panel.style.cssText = "position:fixed;top:16px;right:16px;z-index:2147483647;width:440px;"
      + "font:13px system-ui;background:#1f2430;color:#e8eaf0;border:1px solid #3a4152;border-radius:10px;"
      + "padding:10px 12px;box-shadow:0 8px 24px rgba(0,0,0,.4)";
    const head = document.createElement("div");
    head.textContent = heading;
    head.style.cssText = "font-size:11px;opacity:.7;margin-bottom:6px";
    panel.append(head);
    for (const row of rows) {
      const item = document.createElement("div");
      item.style.cssText = "padding:6px 0;border-top:1px solid #3a4152";
      const title = document.createElement("strong");
      title.textContent = row.title;
      const body = document.createElement("div");
      body.textContent = row.body;
      body.style.opacity = ".85";
      const note = document.createElement("div");
      note.textContent = row.note;
      note.style.cssText = "font-size:11px;opacity:.55";
      item.append(title, body, note);
      panel.append(item);
    }
    document.body.append(panel);
  }, { heading, rows });
  await capture(page.locator("#e2e-evidence-panel"), name, page);
  await page.evaluate(() => document.getElementById("e2e-evidence-panel")?.remove());
}
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

async function startWorking(daemon: DaemonHandle, session: Session): Promise<void> {
  await hook(daemon, session, "PreToolUse");
  await expect.poll(() => stateOf(daemon, session.id)).toBe("working");
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

async function announced(daemon: DaemonHandle, id: string): Promise<string | null> {
  return (await api<{ report: ReportItem }>(daemon, `/api/reports/${id}`)).report.announcedAs;
}

/** Post while working, then stop: the report is stamped back. */
async function postAndStop(daemon: DaemonHandle, session: Session, body: Record<string, unknown>): Promise<ReportItem> {
  await startWorking(daemon, session);
  const report = await post(daemon, session, body);
  await hook(daemon, session, "Stop");
  await expect.poll(() => announced(daemon, report.id)).toBe("back");
  return report;
}

/** Notifications on, the flag on, one idle agent; the page reloaded so the toast stub is in place. */
async function setup(page: Page, daemon: DaemonHandle, title: string): Promise<Session> {
  await captureToasts(page);
  await api(daemon, "/api/ui/config", { alerts: { notifications: true, sound: false } }, "PUT");
  await setInbox(daemon, true);
  const task = await api<Task>(daemon, "/api/tasks", {
    repoRoot: daemon.repo, title, intent: title.toLowerCase(), kind: "ship", agent: "claude", runtime: "sdk", workflowId: null,
  });
  let session!: Session;
  await expect.poll(async () => {
    session = (await api<Session[]>(daemon, "/api/sessions")).find((s) => s.task?.id === task.id)!;
    return session?.agentSessionId ? session.state : null;
  }, { timeout: 60_000 }).toBe("idle");
  await page.reload();
  await expect(page.getByRole("button", { name: "Dispatch", exact: true })).toBeVisible({ timeout: 30_000 });
  return session;
}

async function flipSwitch(page: Page, name: string, to: boolean): Promise<Locator> {
  await page.getByRole("button", { name: /^Alerts & away mode/ }).click();
  const panel = page.getByRole("dialog", { name: "Alert settings" });
  const control = panel.getByRole("switch", { name, exact: true });
  await expect(control).toBeVisible();
  if ((await control.getAttribute("aria-checked")) !== String(to)) await control.click();
  await expect(control).toHaveAttribute("aria-checked", String(to));
  return panel;
}

const inboxOf = (page: Page) => page.getByRole("dialog", { name: "Attention inbox" });
const toRead = (page: Page) => page.locator("button.pulse-seg", { hasText: "to read" });
const band = (inbox: Locator) => inbox.getByRole("region", { name: "Opened from a notification" });

test("a report toast says who is back or still working, opens its row, and its switch silences only it", async ({ dashboard: page, daemon }) => {
  test.setTimeout(180_000);
  const name = "Diagnose the flaky build";
  const session = await setup(page, daemon, name);

  const panel = await flipSwitch(page, "Agent reports notify", true);
  await expect(panel.getByText("What notifies you")).toBeVisible();
  for (const label of [
    "Blocking questions notify", "Questions filed while working notify", "Agent reports notify",
    "Agent reports are listed in the inbox", "Stuck sessions notify",
  ]) await expect(panel.getByRole("switch", { name: label, exact: true })).toHaveAttribute("aria-checked", "true");
  await capture(panel, "01-what-notifies-you", page);
  await page.keyboard.press("Escape");

  const back = await postAndStop(daemon, session, { title: "Build failure diagnosed", body: "The cache key ignored the lockfile." });
  await expect.poll(() => toastTitles(page)).toContain(`${name}'s back: Build failure diagnosed`);
  expect((await toasts(page)).find((t) => t.tag === `report:${back.id}`)?.body).toBe("The cache key ignored the lockfile.");

  await clickToast(page, back.id);
  const inbox = inboxOf(page);
  await expect(inbox).toBeVisible();
  await expectContentClearsBorder(inbox);
  const row = inbox.getByRole("region", { name: `Reports from ${name}` });
  await expect(row.getByRole("button", { name: "Build failure diagnosed" })).toHaveAttribute("aria-expanded", "true");
  await expect(row.getByText("The cache key ignored the lockfile.")).toBeVisible();
  await expect(band(inbox)).toHaveCount(0);
  await capture(inbox, "02-toast-opens-row", page);
  await expect.poll(async () => (await api<{ report: ReportItem }>(daemon, `/api/reports/${back.id}`)).report.openedAt).not.toBeNull();
  expect((await api<{ report: ReportItem }>(daemon, `/api/reports/${back.id}`)).report.readAt).toBeNull();
  await page.keyboard.press("Escape");
  await expect(inbox).toBeHidden();

  await startWorking(daemon, session);
  const working = await post(daemon, session, { title: "Halfway through the audit", body: "Two of five packages checked." });
  await expect.poll(() => announced(daemon, working.id), { timeout: 40_000 }).toBe("working");
  await expect.poll(() => toastTitles(page)).toContain(`${name} posted a report: Halfway through the audit`);
  await captureRows(page, "08-notification-wording", "Desktop notifications the dashboard raised (Notification API title and body)",
    (await toasts(page)).filter((t) => t.tag === `report:${back.id}` || t.tag === `report:${working.id}`)
      .map((t) => ({ title: t.title, body: t.body, note: `tag ${t.tag}` })));
  await hook(daemon, session, "Stop");

  // "Agent reports notify" off: no toast, and the report is still listed.
  await flipSwitch(page, "Agent reports notify", false);
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await api<{ config: { alerts: { notify: { reports: boolean } } } }>(daemon, "/api/ui/config"))
    .config.alerts.notify.reports).toBe(false);
  const raised = (await toasts(page)).length;
  const quiet = await postAndStop(daemon, session, { title: "Quiet findings", body: "Nothing urgent." });
  await expect(toRead(page).locator(".pulse-n")).toHaveText("3");
  // The stamp has landed (asserted above); give its event time to reach this window before
  // asserting that nothing was raised for it.
  await page.waitForTimeout(3000);
  expect((await toasts(page)).length).toBe(raised);
  expect(await toastTitles(page)).not.toContain(`${name}'s back: Quiet findings`);
  await toRead(page).click();
  await expect(inbox.getByRole("region", { name: `Reports from ${name}` }).getByRole("button", { name: quiet.title })).toBeVisible();
});

test("with reports unlisted the toast still arrives and opens its report on its own; read and replaced reports open too", async ({ dashboard: page, daemon }) => {
  test.setTimeout(180_000);
  const name = "Audit the dependency tree";
  const session = await setup(page, daemon, name);

  await flipSwitch(page, "Agent reports are listed in the inbox", false);
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await api<{ config: { alerts: { reportsInInbox: boolean } } }>(daemon, "/api/ui/config"))
    .config.alerts.reportsInInbox).toBe(false);

  const unlisted = await postAndStop(daemon, session, { title: "Two unmaintained packages", body: "left-pad and is-odd." });
  await expect.poll(() => toastTitles(page)).toContain(`${name}'s back: Two unmaintained packages`);
  await expect(toRead(page)).toHaveCount(0);

  // Out of the inbox, still in its conversation: the entry where it was posted, unread.
  await page.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  const detail = page.locator(".console-detail");
  const entry = detail.getByRole("note", { name: "Report: Two unmaintained packages" });
  await expect(entry).toBeVisible({ timeout: 30_000 });
  await expect(entry).toContainText("Waiting to be read");
  await expect(entry.getByRole("button", { name: "Mark read" })).toBeVisible();
  await expect(toRead(page)).toHaveCount(0);
  expect((await api<{ report: ReportItem }>(daemon, `/api/reports/${unlisted.id}`)).report.readAt).toBeNull();
  await capture(page, "09-unlisted-report-in-conversation", page);

  await clickToast(page, unlisted.id);
  const inbox = inboxOf(page);
  await expect(inbox).toBeVisible();
  const pinned = band(inbox);
  await expect(pinned.getByRole("heading", { name: "Opened from a notification" })).toBeVisible();
  await expect(pinned.getByRole("button", { name: "Two unmaintained packages" })).toHaveAttribute("aria-expanded", "true");
  await expect(pinned.getByText("left-pad and is-odd.")).toBeVisible();
  await expect(inbox.locator("h4.inbox-section", { hasText: /^Reports$/ })).toHaveCount(0);
  await expect(inbox.locator(".modal-head")).not.toContainText("to read");
  await expectContentClearsBorder(inbox);
  await capture(inbox, "03-unlisted-opens-band", page);
  expect((await api<{ report: ReportItem }>(daemon, `/api/reports/${unlisted.id}`)).report.readAt).toBeNull();
  await page.keyboard.press("Escape");
  await expect(inbox).toBeHidden();

  // Listed again, the inbox reopened from its to read figure has no band: it belonged to the
  // click that opened it. The report is in its row, still unread.
  await flipSwitch(page, "Agent reports are listed in the inbox", true);
  await page.keyboard.press("Escape");
  await expect(toRead(page).locator(".pulse-n")).toHaveText("1");
  await toRead(page).click();
  await expect(inbox).toBeVisible();
  await expect(band(inbox)).toHaveCount(0);
  await expect(inbox.getByRole("region", { name: `Reports from ${name}` })
    .getByRole("button", { name: "Two unmaintained packages" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(inbox).toBeHidden();

  // Unlisted again: Mark read works from the band.
  await flipSwitch(page, "Agent reports are listed in the inbox", false);
  await page.keyboard.press("Escape");
  await expect(toRead(page)).toHaveCount(0);
  await clickToast(page, unlisted.id);
  await expect(inbox).toBeVisible();
  await band(inbox).getByRole("button", { name: "Mark read" }).click();
  await expect.poll(async () => (await api<{ report: ReportItem }>(daemon, `/api/reports/${unlisted.id}`)).report.readBy).toBe("mark-read");
  // The band itself shows it read: Mark read closes the card, and reopened it offers no second one.
  const toggle = band(inbox).getByRole("button", { name: "Two unmaintained packages" });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(band(inbox).getByText("Read", { exact: true })).toBeVisible();
  await expect(band(inbox).getByRole("button", { name: "Mark read" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(inbox).toBeHidden();

  // Listed again. A report already read: clicking its earlier toast draws it in the band.
  await flipSwitch(page, "Agent reports are listed in the inbox", true);
  await page.keyboard.press("Escape");
  await clickToast(page, unlisted.id);
  await expect(inbox).toBeVisible();
  await expect(band(inbox).getByRole("article", { name: "Report: Two unmaintained packages" })).toBeVisible();
  await expect(band(inbox).getByText("left-pad and is-odd.")).toBeVisible();
  await expect(band(inbox).getByText("Read", { exact: true })).toBeVisible();
  await capture(inbox, "04-read-report-opens-band", page);
  await page.keyboard.press("Escape");
  await expect(inbox).toBeHidden();

  // Replaced: the first report's toast opens the replacement's row, never the first's text.
  const first = await postAndStop(daemon, session, { title: "Upgrade plan draft", body: "DRAFT-BODY: bump everything." });
  await expect.poll(() => toastTitles(page)).toContain(`${name}'s back: Upgrade plan draft`);
  await startWorking(daemon, session);
  const second = await post(daemon, session, { title: "Upgrade plan final", body: "Bump three, drop two.", replaces: first.id });
  expect(second.version).toBe(2);
  await clickToast(page, first.id);
  await expect(inbox).toBeVisible();
  const row = inbox.getByRole("region", { name: `Reports from ${name}` });
  await expect(row.getByRole("button", { name: "Upgrade plan final" })).toHaveAttribute("aria-expanded", "true");
  await expect(row.getByText("Bump three, drop two.")).toBeVisible();
  await expect(inbox.getByRole("button", { name: "Upgrade plan draft" })).toHaveCount(0);
  await expect(inbox.getByText("DRAFT-BODY", { exact: false })).toHaveCount(0);
  await capture(inbox, "05-replaced-opens-replacement", page);
  await page.keyboard.press("Escape");
  await expect(inbox).toBeHidden();

  // The flag off at the click: the toast only focuses the window.
  await setInbox(daemon, false);
  await expect(page.locator("button.pulse-seg", { hasText: "to read" })).toHaveCount(0);
  await clickToast(page, first.id);
  await page.waitForTimeout(1000);
  await expect(inbox).toBeHidden();
});

test("a notification whose report this window no longer holds is fetched, and a failed lookup says so", async ({ dashboard: page, daemon }) => {
  test.setTimeout(150_000);
  const name = "Profile the slow build";
  const session = await setup(page, daemon, name);
  const report = await postAndStop(daemon, session, { title: "Linker is the bottleneck", body: "LTO doubles link time." });
  await expect.poll(() => toastTitles(page)).toContain(`${name}'s back: Linker is the bottleneck`);

  // Read elsewhere, then the stream drops and comes back: the reconnect snapshot carries only
  // reports still waiting, so this window no longer holds the notified one.
  await api(daemon, `/api/reports/${report.id}/read`, {});
  await expect(toRead(page)).toHaveCount(0);
  await page.evaluate(() => (window as unknown as ToastWindow).__reconnect());

  // The daemon's answer fails: the click opens the inbox and says the report could not be loaded.
  let lookups = 0;
  await page.route(`**/api/reports/${report.id}`, async (route) => {
    lookups++;
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "boom" }) });
  });
  await clickToast(page, report.id);
  const inbox = inboxOf(page);
  await expect(inbox).toBeVisible();
  await expect(band(inbox).getByRole("alert")).toHaveText("This report could not be loaded.");
  expect(lookups).toBe(1);
  await capture(inbox, "07-failed-lookup", page);
  await page.keyboard.press("Escape");
  await expect(inbox).toBeHidden();

  // The same click with the daemon answering: the fetched report is drawn in the band, marked read.
  await page.unroute(`**/api/reports/${report.id}`);
  await clickToast(page, report.id);
  await expect(inbox).toBeVisible();
  await expect(band(inbox).getByRole("article", { name: "Report: Linker is the bottleneck" })).toBeVisible();
  await expect(band(inbox).getByText("LTO doubles link time.")).toBeVisible();
  await expect(band(inbox).getByText("Read", { exact: true })).toBeVisible();
  await expect(band(inbox).getByRole("alert")).toHaveCount(0);
});

test("a report stamped while the page is still loading Away mode waits for it: quiet while away, delivered at the desk", async ({ dashboard: page, daemon }) => {
  test.setTimeout(150_000);
  const name = "Bisect the regression";
  const session = await setup(page, daemon, name);

  /** Reload with the Away mode read held back, so the event stream is ready first. */
  async function reloadHoldingAway(): Promise<() => void> {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    // Replace any earlier hold; nothing is waiting on it by now. Once released, the gate stays
    // open, so later reads pass straight through.
    await page.unroute("**/api/away");
    await page.route("**/api/away", async (route) => {
      if (route.request().method() === "GET") await gate;
      await route.continue();
    });
    await page.reload();
    await expect(page.getByRole("button", { name: "Dispatch", exact: true })).toBeVisible({ timeout: 30_000 });
    // The button's name says "away" only once the daemon's answer is in; it has not arrived.
    await expect(page.getByRole("button", { name: /^Alerts & away mode - away$/ })).toHaveCount(0);
    return release;
  }

  // Away: a report stamped before the page knows it must not interrupt, before or after it learns.
  await api(daemon, "/api/away", { away: true }, "PUT");
  await startWorking(daemon, session);
  const whileAway = await post(daemon, session, { title: "Culprit is commit 4f2a", body: "Found by bisect." });
  let release = await reloadHoldingAway();
  await expect(toRead(page).locator(".pulse-n")).toHaveText("1");
  await hook(daemon, session, "Stop");
  await expect.poll(() => announced(daemon, whileAway.id)).toBe("back");
  await page.waitForTimeout(2000);
  expect((await toasts(page)).some((t) => t.tag === `report:${whileAway.id}`)).toBe(false);
  release();
  await expect(page.getByRole("button", { name: /^Alerts & away mode - away$/ })).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(2000);
  expect((await toasts(page)).some((t) => t.tag === `report:${whileAway.id}`)).toBe(false);

  // At the desk: the same gap, and the report notifies as soon as Away mode is known to be off.
  await api(daemon, "/api/away", { away: false }, "PUT");
  await startWorking(daemon, session);
  const atDesk = await post(daemon, session, { title: "Fix is a one-liner", body: "Revert the cache flag." });
  release = await reloadHoldingAway();
  await expect(toRead(page).locator(".pulse-n")).toHaveText("2");
  await hook(daemon, session, "Stop");
  await expect.poll(() => announced(daemon, atDesk.id)).toBe("back");
  await page.waitForTimeout(2000);
  expect((await toasts(page)).some((t) => t.tag === `report:${atDesk.id}`), "it waits for Away mode").toBe(false);
  release();
  await expect.poll(() => toastTitles(page), { timeout: 15_000 }).toContain(`${name}'s back: Fix is a one-liner`);
});

test("at the desk, a report posted while this window was disconnected keeps its own notification on reconnect", async ({ dashboard: page, daemon }) => {
  test.setTimeout(150_000);
  const name = "Chase the timeout";
  const session = await setup(page, daemon, name);

  await page.evaluate(() => {
    const w = window as unknown as ToastWindow;
    w.__stream.close();
    w.__stream.dispatchEvent(new Event("error"));
  });
  await expect(page.locator(".pulse")).toHaveClass(/is-down/);
  const report = await postAndStop(daemon, session, { title: "Timeout is the proxy", body: "The proxy closes idle sockets at 60 s." });

  await page.evaluate(() => (window as unknown as ToastWindow).__reconnect());
  await expect(page.locator(".pulse")).not.toHaveClass(/is-down/);
  // Named and worded like any report notification, not folded into the generic catch-up.
  await expect.poll(() => toastTitles(page), { timeout: 15_000 }).toContain(`${name}'s back: Timeout is the proxy`);
  const raised = await toasts(page);
  expect(raised.find((t) => t.tag === `report:${report.id}`)?.body).toBe("The proxy closes idle sockets at 60 s.");
  expect(raised.some((t) => t.tag === "reconnect-catchup")).toBe(false);
  await clickToast(page, report.id);
  const inbox = inboxOf(page);
  await expect(inbox).toBeVisible();
  await expect(inbox.getByRole("region", { name: `Reports from ${name}` })
    .getByRole("button", { name: "Timeout is the proxy" })).toHaveAttribute("aria-expanded", "true");
});

test("a report stamped after Away mode ended elsewhere, while this window still reads it as on, notifies once the window learns", async ({ dashboard: page, daemon }) => {
  test.setTimeout(150_000);
  const name = "Shrink the bundle";
  const session = await setup(page, daemon, name);
  await api(daemon, "/api/away", { away: true }, "PUT");
  await expect(page.getByRole("button", { name: /^Alerts & away mode - away$/ })).toBeVisible({ timeout: 15_000 });

  // This window's next polls keep answering "away", as a poll that has not come round yet would.
  const stale = await api<Record<string, unknown>>(daemon, "/api/away");
  let stalePolls = true;
  await page.route("**/api/away", async (route) => {
    if (route.request().method() === "GET" && stalePolls) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(stale) });
      return;
    }
    await route.continue();
  });

  // Away mode ends from another device, then a report is posted and stamped at the desk.
  await api(daemon, "/api/away", { away: false }, "PUT");
  const report = await postAndStop(daemon, session, { title: "Moment.js is the bulk", body: "Swap it for date-fns." });
  expect((await api<{ report: ReportItem }>(daemon, `/api/reports/${report.id}`)).report.countedInDigestAt).toBeNull();
  await page.waitForTimeout(6000); // at least one poll answered with the stale state
  expect((await toasts(page)).some((t) => t.tag === `report:${report.id}`), "held while the window reads away").toBe(false);

  // The window learns Away mode is off: the held report was in no digest, so it notifies now.
  stalePolls = false;
  await expect(page.getByRole("button", { name: /^Alerts & away mode - away$/ })).toHaveCount(0, { timeout: 15_000 });
  await expect.poll(() => toastTitles(page), { timeout: 15_000 }).toContain(`${name}'s back: Moment.js is the bulk`);
});

test("a report held while away and counted by the digest stays quiet on return, even before the window hears the mark", async ({ dashboard: page, daemon }) => {
  test.setTimeout(150_000);
  const name = "Tune the slow query";
  const session = await setup(page, daemon, name);
  await page.getByRole("button", { name: /^Alerts & away mode/ }).click();
  await page.getByRole("switch", { name: "Away mode" }).click();
  await expect(page.getByRole("switch", { name: "Away mode" })).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");

  // Stamped while away, live in this window: its notification is held, and the report stays unread.
  const report = await postAndStop(daemon, session, { title: "Missing index on runs.task_id", body: "Add it." });
  await expect(toRead(page).locator(".pulse-n")).toHaveText("1");
  await page.waitForTimeout(2000);
  expect((await toasts(page)).some((t) => t.tag === `report:${report.id}`)).toBe(false);

  // The event stream drops, so the digest's mark on this report cannot reach the window before it
  // releases what it held: only the daemon knows the digest counted it.
  await page.evaluate(() => {
    const w = window as unknown as ToastWindow;
    w.__stream.close();
    w.__stream.dispatchEvent(new Event("error"));
  });
  await expect(page.locator(".pulse")).toHaveClass(/is-down/);
  await page.getByRole("button", { name: /^Alerts & away mode/ }).click();
  await page.getByRole("switch", { name: "Away mode" }).click();
  await expect(page.getByRole("switch", { name: "Away mode" })).toHaveAttribute("aria-checked", "false");
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await api<{ report: ReportItem }>(daemon, `/api/reports/${report.id}`)).report.countedInDigestAt)
    .not.toBeNull();
  await page.waitForTimeout(3000);
  expect((await toasts(page)).some((t) => t.tag === `report:${report.id}`), "the digest counted it: no second announcement").toBe(false);
});

test("a report stamped while away and this window was disconnected stays quiet when it reconnects after the digest", async ({ dashboard: page, daemon }) => {
  test.setTimeout(150_000);
  const name = "Trace the memory leak";
  const session = await setup(page, daemon, name);

  await page.getByRole("button", { name: /^Alerts & away mode/ }).click();
  await page.getByRole("switch", { name: "Away mode" }).click();
  await expect(page.getByRole("switch", { name: "Away mode" })).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");

  // The window's stream drops while away; the report is posted and stamped without it hearing.
  await page.evaluate(() => {
    const w = window as unknown as ToastWindow;
    w.__stream.close();
    w.__stream.dispatchEvent(new Event("error"));
  });
  await expect(page.locator(".pulse")).toHaveClass(/is-down/);
  const report = await postAndStop(daemon, session, { title: "Leak is in the cache", body: "Entries are never evicted." });
  await expect.poll(async () => (await api<{ rollup: string }>(daemon, "/api/away/buffer")).rollup, { timeout: 30_000 })
    .toContain(`1 report waiting: ${name}`);

  // Back at the desk: Away mode and the digest travel over HTTP, not the dropped stream.
  await page.getByRole("button", { name: /^Alerts & away mode/ }).click();
  await page.getByRole("switch", { name: "Away mode" }).click();
  await expect(page.getByRole("switch", { name: "Away mode" })).toHaveAttribute("aria-checked", "false");
  await page.keyboard.press("Escape");
  const digest = page.locator(".away-digest");
  await expect(digest).toBeVisible({ timeout: 60_000 });
  await expect(digest.locator(".away-digest-rollup")).toContainText(`1 report waiting: ${name}`);

  // Then the stream comes back: the snapshot is the first this window hears of the stamped report.
  await page.evaluate(() => (window as unknown as ToastWindow).__reconnect());
  await expect(page.locator(".pulse")).not.toHaveClass(/is-down/);
  await expect(toRead(page).locator(".pulse-n")).toHaveText("1");
  await page.waitForTimeout(3000);
  expect((await toasts(page)).filter((t) => t.tag === `report:${report.id}` || t.tag === "reconnect-catchup")).toEqual([]);
  // What kept it quiet: the daemon stored that the digest counted it.
  expect((await api<{ report: ReportItem }>(daemon, `/api/reports/${report.id}`)).report.countedInDigestAt).not.toBeNull();
});

test("while away a report does not interrupt, and the return digest counts the reports waiting as you return", async ({ dashboard: page, daemon }) => {
  test.setTimeout(180_000);
  const name = "Sweep the flaky tests";
  const session = await setup(page, daemon, name);
  const buffered = async () => (await api<{ rollup: string; lines: string[] }>(daemon, "/api/away/buffer"));

  await page.getByRole("button", { name: /^Alerts & away mode/ }).click();
  const awaySwitch = page.getByRole("switch", { name: "Away mode" });
  await awaySwitch.click();
  await expect(awaySwitch).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");

  // Announced while away: buffered for the digest, no toast.
  const read = await postAndStop(daemon, session, { title: "Three flaky tests fixed", body: "All were timing races." });
  await expect.poll(async () => (await buffered()).rollup, { timeout: 30_000 }).toContain(`1 report waiting: ${name}`);
  expect(await toastTitles(page)).not.toContain(`${name}'s back: Three flaky tests fixed`);
  expect((await toasts(page)).some((t) => t.tag === `report:${read.id}`)).toBe(false);

  // Read while still away (from another window): it stops counting, in the preview and the digest.
  await api(daemon, `/api/reports/${read.id}/read`, {});
  await expect.poll(async () => (await buffered()).rollup, { timeout: 30_000 }).not.toContain("report waiting");

  // Posted just before coming back, still inside its 20-second grace period, so not yet announced.
  await startWorking(daemon, session);
  const late = await post(daemon, session, { title: "One more flake found", body: "The retry test races the clock." });
  expect(await announced(daemon, late.id)).toBeNull();

  await page.getByRole("button", { name: /^Alerts & away mode/ }).click();
  await page.getByRole("switch", { name: "Away mode" }).click();
  await expect(page.getByRole("switch", { name: "Away mode" })).toHaveAttribute("aria-checked", "false");
  // Returned before the late report's stamp, which is when the window closed.
  expect(await announced(daemon, late.id)).toBeNull();
  await page.keyboard.press("Escape");
  const digest = page.locator(".away-digest");
  await expect(digest).toBeVisible({ timeout: 60_000 });
  await expect(digest.locator(".away-digest-rollup")).toContainText(`1 report waiting: ${name}`);
  await expect(digest).toContainText(`${name} posted a report: One more flake found`);
  await expect(digest).not.toContainText("Three flaky tests fixed");
  await capture(digest, "06-away-digest-names-who-posted", page);
  expect(await toastTitles(page)).not.toContain(`${name}'s back: Three flaky tests fixed`);
  await expect(toRead(page).locator(".pulse-n")).toHaveText("1");

  // Before its stamp lands: the page reloads, and a second, short away window opens and closes.
  // Neither may forget that the first digest already counted it.
  await page.reload();
  await expect(toRead(page).locator(".pulse-n")).toHaveText("1", { timeout: 30_000 });
  for (const on of [true, false]) {
    await page.getByRole("button", { name: /^Alerts & away mode/ }).click();
    const again = page.getByRole("switch", { name: "Away mode" });
    await again.click();
    await expect(again).toHaveAttribute("aria-checked", String(on));
    await page.keyboard.press("Escape");
  }
  expect(await announced(daemon, late.id), "still unannounced after the reload and the second window").toBeNull();
  // Settled back at the desk: the daemon says so, the control says so, and the tab's own return
  // request has finished, so nothing still holds reports on this tab's side.
  await expect.poll(async () => (await api<{ away: boolean }>(daemon, "/api/away")).away).toBe(false);
  await expect(page.getByRole("button", { name: /^Alerts & away mode - (on|muted)$/ })).toBeVisible();
  await page.waitForTimeout(1500);

  // Its stamp lands now, after you are back, while this window's stream is down: it reaches the
  // window only in the reconnect snapshot. The digest already counted it, so neither the live
  // path nor the reconnect catch-up raises a toast.
  await page.evaluate(() => {
    const w = window as unknown as ToastWindow;
    w.__stream.close();
    w.__stream.dispatchEvent(new Event("error"));
  });
  await expect(page.locator(".pulse")).toHaveClass(/is-down/);
  await hook(daemon, session, "Stop");
  await expect.poll(() => announced(daemon, late.id)).toBe("back");
  await page.evaluate(() => (window as unknown as ToastWindow).__reconnect());
  await expect(page.locator(".pulse")).not.toHaveClass(/is-down/);
  await page.waitForTimeout(3000);
  expect((await toasts(page)).filter((t) => t.tag === `report:${late.id}` || t.tag === "reconnect-catchup")).toEqual([]);

  // A report posted after you came back still notifies as usual, on a live stream again.
  await page.reload();
  await expect(toRead(page).locator(".pulse-n")).toHaveText("1", { timeout: 30_000 });
  const after = await postAndStop(daemon, session, { title: "Back at the desk", body: "Posted after the return." });
  await expect.poll(() => toastTitles(page)).toContain(`${name}'s back: Back at the desk`);
  expect((await toasts(page)).some((t) => t.tag === `report:${after.id}`)).toBe(true);
});
