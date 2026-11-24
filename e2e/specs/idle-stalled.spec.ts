import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { INBOX_MESSAGES } from "../../src/shared/inbox.ts";
import type { Session, Task } from "../../src/shared/types.ts";
import type { ResidentProfile } from "../../src/shared/residents.ts";

/**
 * What is at stake: with the `idle-stalled` preview on, a session the daemon's idle stall rules
 * flag leaves the inbox and sits under a Stalled rule in the Idle column, between free and held.
 * Its card says what is open and what it last did, and carries the fix: Nudge sends the fixed
 * message through the real outbox, and Dismiss returns the card to free across a reload. With
 * the `inbox` preview on as well, the same stall is no Stuck row and no "to answer" figure, and
 * switching `idle-stalled` off with the page open puts it back in the inbox.
 *
 * Real daemon, real stall detector, real routes and the real built dashboard; the agents are the
 * suite's fakes. The idle rule's threshold is lowered to its one-minute floor and the spec waits
 * it out, as `inbox-stuck.spec.ts` does: the rule reads the session's in-memory `lastActivity`,
 * which is not stored, so there is no row to age instead.
 */

const EVIDENCE = artifactsDir("idle-stalled");

async function capture(target: Locator, name: string, page: Page): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await expect(page.locator(".tooltip")).toHaveCount(0, { timeout: 3000 }).catch(() => undefined);
  await target.screenshot({ path: join(EVIDENCE, `${name}.png`) });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/idle-stalled/${name}.png`);
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

async function setFlag(daemon: DaemonHandle, id: "inbox" | "idle-stalled", enabled: boolean): Promise<void> {
  const { config } = await api<{ config: { overrides: Record<string, boolean> } }>(
    daemon, "/api/feature-flags", { kind: "flag", id, enabled }, "PUT");
  expect(config.overrides[id]).toBe(enabled);
}

/** Dispatch one fake agent on a task and wait for its first turn to settle. */
async function dispatch(daemon: DaemonHandle, title: string): Promise<{ task: Task; session: Session }> {
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

/** The daemon's own answer first, so a failure separates "the rule never fired" from "never drawn". */
async function stalled(daemon: DaemonHandle, ...sessions: Session[]): Promise<void> {
  await expect.poll(async () => {
    const stalls = await api<Array<{ sessionId: string; kind: string }>>(daemon, "/api/away/stalls");
    return sessions.map((s) => stalls.find((stall) => stall.sessionId === s.id)?.kind ?? null);
  }, { timeout: 180_000, intervals: [2_000] }).toEqual(sessions.map(() => "unfinished-work"));
}

/**
 * Put the dashboard in the Board layout, where the Stalled card's facts and fixes are drawn. The
 * fixture pins Console; written to the daemon as `board-held-by-workflow.spec.ts` does it.
 */
async function useBoardLayout(page: Page, daemon: DaemonHandle): Promise<void> {
  const { config } = await api<{ config?: { layout?: string } }>(daemon, "/api/ui/config", { layout: "board" }, "PUT");
  expect(config?.layout, "the daemon accepted the Board layout").toBe("board");
  await page.reload();
  await expect(page.locator("main.board")).toBeVisible();
}

const idleColumn = (page: Page) => page.locator("main.board section.board-col.tone-idle");
const facts = (page: Page, session: Session) => page.getByRole("group", { name: `Why ${session.name} stalled` });
const toAnswer = (page: Page) => page.locator("button.pulse-seg", { hasText: "to answer" });

test("an idle stall sits in Idle's Stalled section with what is open and the fix in place", async ({ dashboard: page, daemon }) => {
  test.setTimeout(330_000);
  // The Stalled section alone, with the inbox preview off: its fixes must not need the inbox.
  await setFlag(daemon, "idle-stalled", true);
  await api(daemon, "/api/away", { detectStalls: true, stallUnfinishedMinutes: 1 }, "PUT");

  const a = await dispatch(daemon, "Fix the parser");
  const b = await dispatch(daemon, "Tidy the changelog");
  await stalled(daemon, a.session, b.session);
  await useBoardLayout(page, daemon);

  const idle = idleColumn(page);
  const rule = idle.locator(".fleet-section-stalled");
  await expect(rule).toBeVisible({ timeout: 15_000 });
  await expect(rule).toContainText("stalled");
  await expect(rule).toContainText("Went quiet with work still open.");
  await expect(rule.locator(".fleet-section-n")).toHaveText("2");
  await expect(idle.locator(".board-col-n.n-stalled")).toHaveText("2 stalled");

  // Each card says what is open and what it last did, and offers the fixes for open work.
  const factsA = facts(page, a.session);
  await expect(factsA).toContainText("Task");
  await expect(factsA).toContainText("Fix the parser");
  await expect(factsA).toContainText("Last");
  for (const name of ["Nudge", "Message…", "Mark done"]) {
    await expect(factsA.getByRole("button", { name, exact: true })).toBeVisible();
  }
  await expect(factsA.getByRole("button", { name: `Dismiss ${a.session.name} from Stalled` })).toBeVisible();
  await expect(idle.locator(".tile.is-stalled")).toHaveCount(2);
  // Nothing about it reaches the inbox with the inbox preview off.
  await expect(toAnswer(page)).toHaveCount(0);
  await capture(idle, "01-stalled-section", page);

  await api(daemon, "/api/feature-flags", { kind: "flag", id: "idle-rail-section-counts", enabled: true }, "PUT");
  await idle.locator(".tile.is-stalled").first().getByRole("button", { name: /^Open / }).press("Enter");
  const rail = page.locator("section.board-col.is-rail.tone-idle");
  const stalledHeading = rail.getByRole("button", { name: "stalled 2", exact: true });
  await expect(rail.locator("header").getByText("2 sessions", { exact: true })).toBeVisible();
  await expect(stalledHeading).toHaveAttribute("aria-expanded", "true");
  await expect(rail.locator(".rail-row.is-stalled")).toHaveCount(2);
  for (const session of [a.session, b.session]) {
    await expect(rail.getByRole("button", { name: session.name, exact: true })).toBeVisible();
  }
  await stalledHeading.click();
  await expect(stalledHeading).toHaveAttribute("aria-expanded", "false");
  await expect(rail.locator(".rail-row.is-stalled")).toHaveCount(0);
  await capture(rail, "04-stalled-rail-collapsed", page);
  await stalledHeading.click();
  await expect(rail.locator(".rail-row.is-stalled")).toHaveCount(2);
  await rail.getByRole("button", { name: "Back to the board" }).click();

  // Nudge puts the fixed text in the agent's conversation through the real outbox, and the
  // session moving takes its card out of the section.
  await factsA.getByRole("button", { name: "Nudge", exact: true }).click();
  await expect.poll(async () => {
    const served = await api<{ messages: Array<{ role: string; text: string }> }>(
      daemon, `/api/sessions/${encodeURIComponent(a.session.id)}/transcript`);
    return served.messages.some((m) => m.role === "user" && m.text.includes(INBOX_MESSAGES.nudge));
  }, { timeout: 30_000 }).toBe(true);
  await expect(factsA).toHaveCount(0, { timeout: 30_000 });

  // Dismiss returns B to the rest of Idle, and it stays there across a reload.
  const factsB = facts(page, b.session);
  await factsB.getByRole("button", { name: `Dismiss ${b.session.name} from Stalled` }).click();
  await expect(factsB).toHaveCount(0);
  await expect(idle.locator(".tile", { hasText: b.session.name })).toBeVisible();
  await page.reload();
  await expect(idleColumn(page).locator(".tile", { hasText: b.session.name })).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(6_000); // one stall poll, so a returning card would be drawn
  await expect(facts(page, b.session)).toHaveCount(0);
  await capture(idleColumn(page), "02-after-nudge-and-dismiss", page);
});

test("with the inbox on, an idle stall is no Stuck row until the Stalled preview is switched off", async ({ dashboard: page, daemon }) => {
  test.setTimeout(270_000);
  await setFlag(daemon, "inbox", true);
  await setFlag(daemon, "idle-stalled", true);
  await api(daemon, "/api/away", { detectStalls: true, stallUnfinishedMinutes: 1 }, "PUT");
  const a = await dispatch(daemon, "Fix the parser");
  await stalled(daemon, a.session);
  await useBoardLayout(page, daemon);

  await expect(facts(page, a.session)).toBeVisible({ timeout: 15_000 });
  // No Stuck row and nothing to answer: the card is where this stall is drawn.
  await expect(toAnswer(page)).toHaveCount(0);

  // Switched off with the page open, the same stall is an inbox row again and Idle draws none.
  await setFlag(daemon, "idle-stalled", false);
  await expect(facts(page, a.session)).toHaveCount(0, { timeout: 15_000 });
  await expect(idleColumn(page).locator(".fleet-section-stalled")).toHaveCount(0);
  await expect(toAnswer(page).locator(".pulse-n")).toHaveText("1", { timeout: 15_000 });
  const inbox = page.getByRole("dialog", { name: "Attention inbox" });
  await expect(async () => {
    if (!(await inbox.isVisible())) await toAnswer(page).click({ timeout: 3000 });
    await expect(inbox).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 45_000 });
  await expect(inbox.getByRole("region", { name: `${a.task.title} is stuck` })).toBeVisible();
});

test("a pinned resident's idle stall leaves the inbox for Idle's Stalled section", async ({ dashboard: page, daemon }) => {
  // The failure this guards: the fleet ordering kept a pinned resident at the top of its column
  // rather than under the Stalled rule, so while the preview was on its idle stall was either a
  // Stuck row (contrary to the request) or drawn nowhere. A stall outranks the pin now.
  test.setTimeout(330_000);
  await setFlag(daemon, "inbox", true);
  await setFlag(daemon, "idle-stalled", true);
  await api(daemon, "/api/away", { detectStalls: true, stallUnfinishedMinutes: 1 }, "PUT");

  // A resident pins to the top of its column by default, and the fixture places residents on the
  // fleet rather than in the drawer.
  const profile = await api<ResidentProfile>(daemon, "/api/residents/profiles", { settings: {
    identity: { name: "Pinned inspector" },
    instructions: { markdown: "Wait for your next scheduled inspection." },
    workspace: { defaultRepoRoot: daemon.repo },
    execution: { model: "claude-fable-5" },
    loop: { prompt: "Inspect again.", delaySeconds: 3600, minDelaySeconds: 1 },
  } });
  expect(profile.settings.board.pin).toBe(true);
  await api(daemon, `/api/residents/profiles/${profile.id}/launch`, {
    repoRoot: daemon.repo, requestId: "idle-stalled-pinned-resident",
  });
  let resident!: Session;
  await expect.poll(async () => {
    resident = (await api<Session[]>(daemon, "/api/sessions")).find((s) => s.task?.kind === "resident")!;
    return resident?.state;
  }, { timeout: 60_000 }).toBe("idle");

  // The resident's standing task never stalls on its own. An explicit queue item does.
  const queuePath = `/api/sessions/${encodeURIComponent(resident.id)}/queue`;
  const item = await api<{ id: string }>(daemon, queuePath, { intent: "Inspect the parser" });

  const a = await dispatch(daemon, "Fix the parser");
  await stalled(daemon, resident, a.session);
  await useBoardLayout(page, daemon);

  // Both stalls are Stalled cards: the resident left its pinned place for the section, with the
  // facts and fixes of a queue-only stall.
  await expect(facts(page, a.session)).toBeVisible({ timeout: 15_000 });
  const residentFactsCard = facts(page, resident);
  await expect(residentFactsCard).toBeVisible();
  await expect(residentFactsCard).toContainText("Queue");
  await expect(residentFactsCard).toContainText("1 open item");
  await expect(residentFactsCard.getByRole("button", { name: "Nudge", exact: true })).toBeVisible();
  await expect(residentFactsCard.getByRole("button", { name: `Dismiss ${resident.name} from Stalled` })).toBeVisible();
  await expect(idleColumn(page).locator(".tile.is-stalled")).toHaveCount(2);
  await expect(idleColumn(page).locator(".fleet-section-stalled .fleet-section-n")).toHaveText("2");
  await capture(idleColumn(page), "03-pinned-resident-in-stalled", page);

  // And neither is an inbox row: nothing is owed in the inbox.
  await page.waitForTimeout(6_000); // one stall poll, so a row that was coming would be drawn
  await expect(toAnswer(page)).toHaveCount(0);

  const queue = residentFactsCard.getByRole("button", { name: "Open queue" });
  await expect(queue).toHaveAccessibleDescription("Open this session's work queue");
  await queue.click();
  await expect(page.getByRole("tab", { name: /Work queue/ })).toHaveAttribute("aria-selected", "true");

  // Keep serving the last real poll while the live queue removal arrives over SSE.
  const reported = await api(daemon, "/api/away/stalls");
  await page.route("**/api/away/stalls", route => route.fulfill({ json: reported }));
  await api(daemon, `${queuePath}/${item.id}`, undefined, "DELETE");
  await expect(page.getByRole("region", { name: "Session stalled" })).toHaveCount(0);
  await page.getByRole("button", { name: "Back to the board" }).click();
  await expect(residentFactsCard).toHaveCount(0);
  await expect(idleColumn(page).locator(".fleet-section-stalled .fleet-section-n")).toHaveText("1");
});
