import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
import type { ResidentProfile } from "../../src/shared/residents.ts";
import type { Session, Task } from "../../src/shared/types.ts";

/**
 * What is at stake: with the `inbox` preview flag on, one rule names an agent on the inbox row
 * header, the review modal header and the question card, so the three agree; with it off each
 * prints the session name, exactly as before. A resident is named by its profile name, in its
 * board colour.
 *
 * Real daemon, real routes, real SSE and the real built dashboard. Questions are filed on the
 * channel the MCP `request_input` tool uses, the agents are the suite's fakes, and the flag is
 * switched through its own route while the page stays open.
 */

const EVIDENCE = artifactsDir("inbox");

async function capture(target: Locator, name: string, page: Page): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.mouse.move(0, 0);
  await expect(page.locator(".tooltip")).toHaveCount(0, { timeout: 3000 }).catch(() => undefined);
  await target.screenshot({ path: join(EVIDENCE, `${name}.png`) });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/inbox/${name}.png`);
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

const LINTER = "Which linter should this repo use?";

/** File a question the way the MCP `request_input` tool does. */
async function ask(daemon: DaemonHandle, cwd: string, question = LINTER): Promise<void> {
  const res = await fetch(`${daemon.baseURL}/mcp/reviews`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": token(daemon) },
    body: JSON.stringify({
      env: {},
      cwd,
      kind: "input",
      title: question,
      body: `${question}\n\nThe repo has no linter. CI runs Prettier only.`,
      decisions: [{
        id: "q",
        question,
        options: [{ id: "o0", label: "biome" }, { id: "o1", label: "eslint" }],
      }],
    }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
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

async function closeOverlay(page: Page, overlay: Locator): Promise<void> {
  await page.keyboard.press("Escape");
  await expect(overlay).toBeHidden();
}

/** The review modal for the session's questions, opened from its Console detail. */
async function openReview(page: Page): Promise<Locator> {
  await page.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  await page.locator(".console-detail").getByRole("button", { name: "to review" }).click();
  const modal = page.getByRole("dialog", { name: "Review request" });
  await expect(modal).toBeVisible();
  await expectContentClearsBorder(modal);
  return modal;
}

const rowHeader = (inbox: Locator) => inbox.locator("section.inbox-reviews .inbox-head strong");
const cardName = (scope: Locator) => scope.locator("section.review .review-head .review-agent");
const modalHeader = (modal: Locator) => modal.locator(".modal-head strong");

test("with the inbox flag on, the inbox row, the review modal and the question card all name the agent by its task title; off, by its session name", async ({ dashboard: page, daemon }) => {
  test.setTimeout(120_000);
  const title = "Add a linter to CI";
  const task = await api<Task>(daemon, "/api/tasks", {
    repoRoot: daemon.repo, title, intent: "add a linter to CI", kind: "ship", agent: "claude", runtime: "sdk", workflowId: null,
  });
  let session!: Session;
  await expect.poll(async () => {
    session = (await api<Session[]>(daemon, "/api/sessions")).find((s) => s.task?.id === task.id)!;
    return session?.agentSessionId ? session.state : null;
  }, { timeout: 60_000 }).toBe("idle");
  // A dispatch names its session from the task title, so rename it through its own route: the
  // two names must differ, or the test cannot tell which rule drew them.
  await api(daemon, `/api/sessions/${session.id}/rename`, { name: "lint-worker" });
  await expect.poll(async () =>
    (await api<Session[]>(daemon, "/api/sessions")).find((s) => s.id === session.id)?.name).toBe("lint-worker");
  session = (await api<Session[]>(daemon, "/api/sessions")).find((s) => s.id === session.id)!;
  expect(session.name).not.toBe(title);
  await ask(daemon, session.cwd!);
  await expect(page.locator("button.pulse-seg", { hasText: "to answer" }).locator(".pulse-n")).toHaveText("1");

  // Off: the session name, as before, and no name line on the card.
  let inbox = await openInbox(page);
  await expect(rowHeader(inbox)).toHaveText(session.name);
  await expect(cardName(inbox)).toHaveCount(0);
  await capture(inbox, "01-inbox-flag-off", page);
  await closeOverlay(page, inbox);
  let modal = await openReview(page);
  await expect(modalHeader(modal)).toHaveText(session.name);
  await expect(cardName(modal)).toHaveCount(0);
  await closeOverlay(page, modal);

  // On, with the page left open: every surface reads the task title.
  await setInbox(daemon, true);
  inbox = await openInbox(page);
  await expect(rowHeader(inbox)).toHaveText(title);
  await expect(cardName(inbox)).toHaveText(title);
  await expect(cardName(inbox)).not.toHaveClass(/agent-name-resident/);
  // The row's Dismiss is named after the row it removes, by the same name.
  await expect(inbox.getByRole("button", { name: `Dismiss ${title} from the inbox` })).toBeVisible();
  // No control appears for the spoken-hint seam until voice turns hints on.
  await expect(inbox.locator(".spoken-hint")).toHaveCount(0);
  await capture(inbox, "02-inbox-flag-on-task-title", page);
  await closeOverlay(page, inbox);
  modal = await openReview(page);
  await expect(modalHeader(modal)).toHaveText(title);
  await expect(cardName(modal)).toHaveText(title);
  await capture(modal, "03-modal-flag-on-task-title", page);
  await closeOverlay(page, modal);

  // Off again: back to the session name without a reload.
  await setInbox(daemon, false);
  inbox = await openInbox(page);
  await expect(rowHeader(inbox)).toHaveText(session.name);
  await expect(cardName(inbox)).toHaveCount(0);
});

type ToastWindow = Window & { toasts: Array<{ title: string; body?: string }> };

/**
 * Capture desktop alerts at the Notification API, as `notification-sound.spec.ts` does: a
 * headless browser has no OS notification centre to draw them, and the title handed to
 * `new Notification` is exactly the title the operator's desktop shows.
 */
async function captureAlerts(page: Page, daemon: DaemonHandle): Promise<void> {
  await api(daemon, "/api/ui/config", { alerts: { notifications: true, sound: false } }, "PUT");
  await page.addInitScript(() => {
    const toasts: ToastWindow["toasts"] = [];
    (window as ToastWindow).toasts = toasts;
    window.Notification = class {
      static permission = "granted";
      static requestPermission = async () => "granted";
      constructor(title: string, options: NotificationOptions = {}) { toasts.push({ title, body: options.body }); }
      close(): void {}
    } as unknown as typeof Notification;
  });
  await page.reload();
}

const toasts = (page: Page) => page.evaluate(() => (window as ToastWindow).toasts.map((t) => t.title));

test("with the inbox flag on, an alert's title names the agent the way its inbox row does", async ({ dashboard: page, daemon }) => {
  test.setTimeout(120_000);
  await captureAlerts(page, daemon);
  const title = "Add a linter to CI";
  const task = await api<Task>(daemon, "/api/tasks", {
    repoRoot: daemon.repo, title, intent: "add a linter to CI", kind: "ship", agent: "claude", runtime: "sdk", workflowId: null,
  });
  let session!: Session;
  await expect.poll(async () => {
    session = (await api<Session[]>(daemon, "/api/sessions")).find((s) => s.task?.id === task.id)!;
    return session?.agentSessionId ? session.state : null;
  }, { timeout: 60_000 }).toBe("idle");
  await api(daemon, `/api/sessions/${session.id}/rename`, { name: "lint-worker" });
  await expect.poll(async () =>
    (await api<Session[]>(daemon, "/api/sessions")).find((s) => s.id === session.id)?.name).toBe("lint-worker");

  // Off: the alert reads the task title, as it always has, while the inbox row reads the session
  // name. The two surfaces name one agent two ways.
  await ask(daemon, session.cwd!);
  await expect.poll(() => toasts(page)).toEqual([`${title} needs your answer`]);
  let inbox = await openInbox(page);
  await expect(rowHeader(inbox)).toHaveText("lint-worker");
  await closeOverlay(page, inbox);

  // On: a new question's alert and the inbox row name the agent the same way. A different
  // question, because the daemon folds a repeat of an open one into it rather than filing anew.
  await setInbox(daemon, true);
  await ask(daemon, session.cwd!, "Should CI fail on lint warnings?");
  await expect.poll(async () => (await toasts(page)).length).toBe(2);
  const [alert] = (await toasts(page)).slice(1);
  inbox = await openInbox(page);
  await expect(rowHeader(inbox)).toHaveText(title);
  expect(alert).toBe(`${title} needs your answer`);
  expect(alert!.startsWith(`${await rowHeader(inbox).textContent()} `)).toBe(true);

  if (process.env.MC_E2E_EVIDENCE === "1") {
    // Draw the captured alert on the page beside the inbox, so one image shows both. The text
    // is the title and body the dashboard handed to the Notification API, unchanged.
    await page.evaluate(() => {
      const toast = (window as ToastWindow).toasts.at(-1)!;
      const card = document.createElement("div");
      card.setAttribute("style", "position:fixed;top:12px;right:12px;z-index:2147483647;width:340px;padding:12px 14px;"
        + "border-radius:10px;background:#f4f4f5;color:#111;font:13px system-ui;box-shadow:0 6px 24px rgba(0,0,0,.45)");
      card.innerHTML = '<div style="font-size:11px;color:#666;margin-bottom:4px">Desktop notification, as handed to the Notification API</div>';
      const strong = document.createElement("strong");
      strong.textContent = toast.title;
      const body = document.createElement("div");
      body.textContent = toast.body ?? "";
      card.append(strong, body);
      document.body.append(card);
    });
    mkdirSync(EVIDENCE, { recursive: true });
    await page.screenshot({ path: join(EVIDENCE, "05-alert-title-matches-inbox.png") });
    // eslint-disable-next-line no-console
    console.log("CAPTURED e2e/.artifacts/inbox/05-alert-title-matches-inbox.png");
  }
});

const RESIDENT = "Linter watcher";

function waitingResidents(daemon: DaemonHandle): number {
  return withDaemonDb(daemon, (db) => (db.prepare(
    "SELECT COUNT(*) AS n FROM resident_runs WHERE ended_at IS NULL AND launch_state = 'launched' AND loop_state = 'waiting'",
  ).get() as { n: number }).n);
}

test("with the inbox flag on, a resident's question is named by its profile name in its board colour", async ({ dashboard: page, daemon }) => {
  test.setTimeout(120_000);
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
  await api(daemon, `/api/residents/profiles/${profile.id}/launch`, { repoRoot: daemon.repo, requestId: "launch-linter-watcher" });
  await expect.poll(() => waitingResidents(daemon), { timeout: 60_000 }).toBe(1);
  const resident = (await api<Session[]>(daemon, "/api/sessions")).find((s) => s.task)!;
  await ask(daemon, resident.cwd!);

  await setInbox(daemon, true);
  const inbox = await openInbox(page);
  const header = rowHeader(inbox);
  await expect(header).toHaveText(RESIDENT);
  await expect(header).toHaveClass(/agent-name-resident/);
  await expect(cardName(inbox)).toHaveText(RESIDENT);
  await expect(cardName(inbox)).toHaveClass(/agent-name-resident/);
  // Drawn in the board colour the profile chose, as the skin resolves it.
  const colours = await header.evaluate((el) => {
    const probe = document.createElement("span");
    probe.style.color = "var(--resident-violet)";
    el.parentElement!.appendChild(probe);
    const expected = getComputedStyle(probe).color;
    probe.remove();
    return { actual: getComputedStyle(el).color, card: getComputedStyle(el.closest("section")!.querySelector(".review-agent")!).color, expected };
  });
  expect(colours.actual).toBe(colours.expected);
  expect(colours.card).toBe(colours.expected);
  await capture(inbox, "04-inbox-resident-board-colour", page);
  await closeOverlay(page, inbox);

  await setInbox(daemon, false);
  const off = await openInbox(page);
  await expect(rowHeader(off)).toHaveText(resident.name);
  await expect(rowHeader(off)).not.toHaveClass(/agent-name-resident/);
  await expect(cardName(off)).toHaveCount(0);
});
