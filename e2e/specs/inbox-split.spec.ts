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
 * What is at stake: with the `inbox-split` preview on, the attention inbox is one list and a detail
 * pane. Every question and report is its own row; the selected one is drawn in the pane by the
 * card the stacked inbox uses; settling it (an answer, Mark read) opens the next one on its own;
 * J steps down the list; the tabs filter it; and below 800 px the list and the pane stack with a
 * back button. With the flag off the stacked inbox is unchanged.
 *
 * Real daemon, real routes, real SSE and the built dashboard. Questions are filed and reports
 * posted on the exact channels the MCP tools use, and the agent is the suite's fake.
 */

const EVIDENCE = artifactsDir("inbox-split");

async function capture(target: Locator | Page, name: string, page: Page): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await target.screenshot({ path: join(EVIDENCE, `${name}.png`) });
  console.log(`CAPTURED e2e/.artifacts/inbox-split/${name}.png`);
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

async function setFlag(daemon: DaemonHandle, id: string, enabled: boolean): Promise<void> {
  const { config } = await api<{ config: { overrides: Record<string, boolean> } }>(
    daemon, "/api/feature-flags", { kind: "flag", id, enabled }, "PUT");
  expect(config.overrides[id]).toBe(enabled);
}

/** File a question the way the MCP `request_input` tool does. */
async function ask(daemon: DaemonHandle, cwd: string, question: string): Promise<string> {
  const res = await fetch(`${daemon.baseURL}/mcp/reviews`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": token(daemon) },
    body: JSON.stringify({ env: {}, cwd, kind: "input", title: question, body: question, snoozable: true }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json() as { id: string }).id;
}

/** Post a report the way the MCP `post_report` tool does. */
async function report(daemon: DaemonHandle, cwd: string, title: string, body: string, replaces?: string): Promise<ReportItem> {
  const res = await fetch(`${daemon.baseURL}/mcp/reports`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": token(daemon) },
    body: JSON.stringify({ env: {}, cwd, title, body, ...(replaces ? { replaces } : {}) }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json() as { report: ReportItem }).report;
}

async function openInbox(page: Page): Promise<Locator> {
  const inbox = page.getByRole("dialog", { name: "Attention inbox" });
  const toAnswer = page.locator("button.pulse-seg", { hasText: "to answer" });
  await expect(async () => {
    if (!(await inbox.isVisible())) await toAnswer.click({ timeout: 3000 });
    await expect(inbox).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 45_000 });
  return inbox;
}

test("the split inbox selects, moves on after an answer and a Mark read, filters, and stacks when narrow", async ({ dashboard: page, daemon }) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1400, height: 900 });
  const title = "Pick the linter";
  const task = await api<Task>(daemon, "/api/tasks", {
    repoRoot: daemon.repo, title, intent: "pick a linter", kind: "ship", agent: "claude", runtime: "sdk", workflowId: null,
  });
  let session!: Session;
  await expect.poll(async () => {
    session = (await api<Session[]>(daemon, "/api/sessions")).find((s) => s.task?.id === task.id)!;
    return session?.agentSessionId ? session.state : null;
  }, { timeout: 60_000 }).toBe("idle");

  await setFlag(daemon, "inbox", true);
  await setFlag(daemon, "inbox-split", true);
  await ask(daemon, session.cwd!, "Which linter should this repo use?");
  await ask(daemon, session.cwd!, "Should CI fail on warnings?");
  const audit = await report(daemon, session.cwd!, "Dependency audit done", "Three advisories, one at runtime.");

  const inbox = await openInbox(page);
  await expectContentClearsBorder(inbox);
  const list = inbox.getByRole("listbox", { name: "Inbox items" });
  const pane = inbox.getByRole("region", { name: "Selected item" });
  await expect(inbox.getByRole("tab", { name: /All/ })).toHaveAttribute("aria-selected", "true");
  await expect(list.getByRole("option")).toHaveCount(3);
  await expect(list.getByRole("group", { name: "Questions from agents" }).getByRole("option")).toHaveCount(2);
  await expect(list.getByRole("group", { name: "Reports" }).getByRole("option")).toHaveCount(1);

  const first = list.getByRole("option", { name: /Which linter should this repo use\?/ });
  await expect(first).toHaveAttribute("aria-selected", "true");
  await expect(pane).toContainText("Which linter should this repo use?");
  await expect(pane).toContainText("1 of 2");
  await expect(pane.locator(".inbox-split-upnext")).toContainText("Should CI fail on warnings?");
  await capture(inbox, "01-question-selected", page);

  // J and K work from the tabs too, which sit outside the list and the pane.
  await inbox.getByRole("tab", { name: /All/ }).click();
  await page.keyboard.press("j");
  await expect(list.getByRole("option", { name: /Should CI fail on warnings\?/ })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("k");
  await expect(first).toHaveAttribute("aria-selected", "true");

  await pane.getByPlaceholder("Your answer…").fill("eslint");
  await pane.getByRole("button", { name: "Send answer" }).click();
  await expect(first).toHaveCount(0);
  const second = list.getByRole("option", { name: /Should CI fail on warnings\?/ });
  await expect(second).toHaveAttribute("aria-selected", "true");
  await expect(pane.getByRole("status")).toHaveText("Done. Moved on to the next item.");
  await expect(pane).toContainText("Should CI fail on warnings?");

  // J and K typed into the answer box are text, not navigation: the selection stays put.
  const answer = pane.getByPlaceholder("Your answer…");
  await answer.click();
  await page.keyboard.type("jkJK");
  await expect(answer).toHaveValue("jkJK");
  await expect(second).toHaveAttribute("aria-selected", "true");
  await answer.fill("");

  await pane.focus();
  await page.keyboard.press("j");
  const reportRow = list.getByRole("option", { name: /Dependency audit done/ });
  await expect(reportRow).toHaveAttribute("aria-selected", "true");
  await expect(reportRow.locator(".inbox-split-unread")).toBeVisible();
  await expect(pane).toContainText("Three advisories, one at runtime.");

  await page.keyboard.press("k");
  await expect(second).toHaveAttribute("aria-selected", "true");
  await expect(pane).toContainText("Should CI fail on warnings?");
  await page.keyboard.press("j");
  await expect(reportRow).toHaveAttribute("aria-selected", "true");
  await expect(pane).toContainText("Three advisories, one at runtime.");
  await capture(inbox, "02-report-selected", page);

  await report(daemon, session.cwd!, "Dependency audit updated", "Two advisories left after the bump.", audit.id);
  const replacedRow = list.getByRole("option", { name: /Dependency audit updated/ });
  await expect(replacedRow).toHaveAttribute("aria-selected", "true");
  await expect(reportRow).toHaveCount(0);
  await expect(pane).toContainText("Two advisories left after the bump.");
  await expect(pane.getByRole("button", { name: "Dependency audit updated" })).toHaveAttribute("aria-expanded", "true");
  await expect(pane.getByRole("button", { name: "Mark read" })).toBeVisible();
  await capture(inbox, "02b-report-replaced", page);

  await pane.getByRole("button", { name: "Mark read" }).click();
  await expect(replacedRow).toHaveCount(0);
  await expect(second).toHaveAttribute("aria-selected", "true");

  await inbox.getByRole("tab", { name: /To read/ }).click();
  await expect(list.getByRole("option")).toHaveCount(0);
  await expect(pane).toContainText("You are all clear.");
  await inbox.getByRole("tab", { name: /To answer/ }).click();
  await expect(second).toHaveAttribute("aria-selected", "true");

  await page.setViewportSize({ width: 700, height: 900 });
  await expect(pane).toBeVisible();
  await expect(list).toBeHidden();
  await pane.getByRole("button", { name: "‹ Inbox" }).click();
  await expect(list).toBeVisible();
  await expect(pane).toBeHidden();
  await second.click();
  await expect(pane).toBeVisible();
  await expect(pane).toContainText("Should CI fail on warnings?");
  await capture(inbox, "03-narrow-detail", page);

  await page.setViewportSize({ width: 1400, height: 900 });
  await setFlag(daemon, "inbox-split", false);
  await expect(inbox.getByRole("listbox", { name: "Inbox items" })).toHaveCount(0);
  await expect(inbox.locator("h4.inbox-section", { hasText: "Questions from agents" })).toBeVisible();
});

/** The fake Codex answers this by raising `request_user_input` and blocking on it: a parked menu. */
const ASK_TURN = "ask me which linter to use";

test("a parked menu is answered from the split pane, and its row leaves once the session has its answer", async ({ dashboard: page, daemon }) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1400, height: 900 });
  await setFlag(daemon, "inbox-split", true);

  // A real Codex SDK session (the suite's fake), asked the turn that raises its native form.
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dispatch = page.getByRole("dialog", { name: "Dispatch an agent" });
  await dispatch.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dispatch.getByPlaceholder("What should this agent do?").fill("answer a parked menu from the inbox");
  await dispatch.getByRole("combobox", { name: "Agent", exact: true }).selectOption("codex");
  await dispatch.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dispatch.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dispatch).toBeHidden();
  const rail = page.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first();
  await expect(rail.locator(".rail-state")).toHaveText("idle", { timeout: 20_000 });
  await rail.click();
  const card = page.locator(".console-detail");
  const composer = card.getByPlaceholder(/^Reply to this session/);
  await composer.fill(ASK_TURN);
  await composer.press("Enter");
  await expect(card.locator(".pane-dialog")).toContainText("Which linter?", { timeout: 30_000 });

  const inbox = await openInbox(page);
  await expectContentClearsBorder(inbox);
  const list = inbox.getByRole("listbox", { name: "Inbox items" });
  const pane = inbox.getByRole("region", { name: "Selected item" });
  const row = list.getByRole("group", { name: "Parked on a menu" }).getByRole("option");
  await expect(row).toHaveCount(1);
  await expect(row).toHaveAttribute("aria-selected", "true");
  const form = pane.locator(".pane-dialog");
  await expect(form).toContainText("Which linter?");
  await expect(pane).not.toContainText("Answered on the session card, not here");
  await capture(inbox, "04-parked-menu-in-pane", page);

  await form.getByRole("radio", { name: /eslint/ }).click();
  await form.getByRole("radio", { name: /tests/ }).click();
  await form.getByRole("button", { name: "Submit answers" }).click();

  await expect.poll(async () => {
    const sessions = await api<Session[]>(daemon, "/api/sessions");
    return sessions.find((s) => s.agent === "codex")?.paneDialog ?? null;
  }, { timeout: 30_000 }).toBeNull();
  await expect(row).toHaveCount(0, { timeout: 30_000 });
  await expect(form).toHaveCount(0);
  await expect(pane).toContainText("You are all clear.");
  await capture(inbox, "05-parked-menu-answered", page);
});

type ToastWindow = Window & { __toastByTag: Record<string, { onclick: (() => void) | null }>; __toastTags: string[] };

/** Record every desktop notification the app raises, and keep each so it can be clicked. */
async function captureToasts(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as ToastWindow;
    w.__toastTags = [];
    w.__toastByTag = {};
    class FakeNotification {
      onclick: (() => void) | null = null;
      static permission = "granted";
      static requestPermission = async (): Promise<string> => "granted";
      constructor(_title: string, options?: { tag?: string }) {
        w.__toastTags.push(options?.tag ?? "");
        w.__toastByTag[options?.tag ?? ""] = this;
      }
      close(): void {}
    }
    (window as unknown as { Notification: unknown }).Notification = FakeNotification;
  });
}

async function hook(daemon: DaemonHandle, session: Session, event: "PreToolUse" | "Stop"): Promise<void> {
  const res = await fetch(`${daemon.baseURL}/hooks/${event}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": token(daemon) },
    body: JSON.stringify({ agent: session.agent, sessionId: session.agentSessionId, cwd: session.cwd, env: {}, toolName: "Bash" }),
  });
  expect(res.status, await res.clone().text()).toBe(204);
}

test("a notification's report that loads while a question is selected becomes the selected row and opens in the pane", async ({ dashboard: page, daemon }) => {
  test.setTimeout(150_000);
  await captureToasts(page);
  await api(daemon, "/api/ui/config", { alerts: { notifications: true, sound: false } }, "PUT");
  await setFlag(daemon, "inbox", true);
  await setFlag(daemon, "inbox-split", true);
  await page.reload();
  await page.setViewportSize({ width: 1400, height: 900 });
  await expect(page.getByRole("button", { name: "Dispatch", exact: true })).toBeVisible({ timeout: 30_000 });

  const task = await api<Task>(daemon, "/api/tasks", {
    repoRoot: daemon.repo, title: "Plan the parser", intent: "plan the parser", kind: "ship", agent: "claude", runtime: "sdk", workflowId: null,
  });
  let session!: Session;
  await expect.poll(async () => {
    session = (await api<Session[]>(daemon, "/api/sessions")).find((s) => s.task?.id === task.id)!;
    return session?.agentSessionId ? session.state : null;
  }, { timeout: 60_000 }).toBe("idle");

  // A report posted mid-turn and stamped back when the turn stops, which is what raises its toast.
  await hook(daemon, session, "PreToolUse");
  await expect.poll(async () => (await api<Session[]>(daemon, "/api/sessions")).find((s) => s.id === session.id)?.state).toBe("working");
  const posted = await report(daemon, session.cwd!, "Parser plan ready", "Split the lexer first.");
  await hook(daemon, session, "Stop");
  await expect.poll(() => page.evaluate(() => (window as unknown as ToastWindow).__toastTags)).toContain(`report:${posted.id}`);
  // Read, so the inbox no longer lists it and its notification has to load it from the daemon.
  await api(daemon, "/api/reports/read-all", { ids: [posted.id] });
  await ask(daemon, session.cwd!, "Which parser generator?");

  const inbox = await openInbox(page);
  const list = inbox.getByRole("listbox", { name: "Inbox items" });
  const pane = inbox.getByRole("region", { name: "Selected item" });
  const question = list.getByRole("option", { name: /Which parser generator\?/ });
  await expect(question).toHaveAttribute("aria-selected", "true");

  await page.evaluate((tag) => (window as unknown as ToastWindow).__toastByTag[tag]?.onclick?.(), `report:${posted.id}`);
  const pinned = list.getByRole("group", { name: "Opened from a notification" }).getByRole("option");
  await expect(pinned).toHaveAttribute("aria-selected", "true");
  await expect(question).toHaveAttribute("aria-selected", "false");
  await expect(pane).toContainText("Split the lexer first.");
  await expect(pane.getByRole("button", { name: "Parser plan ready" })).toHaveAttribute("aria-expanded", "true");
  await expect(inbox.getByText("Loading the report...")).toHaveCount(0);
  await expect(inbox.getByText("This report could not be loaded.")).toHaveCount(0);
  await capture(inbox, "06-notification-report-selected", page);

  await hook(daemon, session, "PreToolUse");
  await expect.poll(async () => (await api<Session[]>(daemon, "/api/sessions")).find((s) => s.id === session.id)?.state).toBe("working");
  const listed = await report(daemon, session.cwd!, "Lexer split done", "The lexer is its own module now.");
  await hook(daemon, session, "Stop");
  await expect.poll(() => page.evaluate(() => (window as unknown as ToastWindow).__toastTags)).toContain(`report:${listed.id}`);
  const listedRow = list.getByRole("option", { name: /Lexer split done/ });
  await expect(listedRow).toHaveCount(1);
  await question.click();
  await expect(question).toHaveAttribute("aria-selected", "true");
  await page.evaluate((tag) => (window as unknown as ToastWindow).__toastByTag[tag]?.onclick?.(), `report:${listed.id}`);
  await expect(listedRow).toHaveCount(1);
  await expect(listedRow).toHaveAttribute("aria-selected", "true");
  await expect(list.getByRole("group", { name: "Reports" }).getByRole("option", { name: /Lexer split done/ })).toHaveCount(1);
  await expect(pane).toContainText("The lexer is its own module now.");
  await capture(inbox, "07-notification-listed-report-once", page);

  await report(daemon, session.cwd!, "Lexer split revised", "The lexer and the token table are both modules now.", listed.id);
  const revisedRow = list.getByRole("option", { name: /Lexer split revised/ });
  await expect(revisedRow).toHaveCount(1);
  await expect(listedRow).toHaveCount(0);
  await question.click();
  await expect(question).toHaveAttribute("aria-selected", "true");
  await page.evaluate((tag) => (window as unknown as ToastWindow).__toastByTag[tag]?.onclick?.(), `report:${listed.id}`);
  await expect(revisedRow).toHaveAttribute("aria-selected", "true");
  await expect(revisedRow).toHaveCount(1);
  await expect(pane).toContainText("The lexer and the token table are both modules now.");
  await expect(pane.getByRole("button", { name: "Lexer split revised" })).toHaveAttribute("aria-expanded", "true");
  await capture(inbox, "08-notification-earlier-version", page);

  const revisedToggle = pane.getByRole("button", { name: "Lexer split revised" });
  await revisedToggle.click();
  await expect(revisedToggle).toHaveAttribute("aria-expanded", "false");
  await expect(revisedRow).toHaveAttribute("aria-selected", "true");
  await expect(pane.getByRole("button", { name: "Mark read" })).toHaveCount(0);
  await page.evaluate((tag) => (window as unknown as ToastWindow).__toastByTag[tag]?.onclick?.(), `report:${listed.id}`);
  await expect(revisedRow).toHaveAttribute("aria-selected", "true");
  await expect(revisedToggle).toHaveAttribute("aria-expanded", "true");
  await expect(pane).toContainText("The lexer and the token table are both modules now.");
  await expect(pane.getByRole("button", { name: "Mark read" })).toBeVisible();
});
