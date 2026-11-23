import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import { writeGhPullRequests } from "../fixtures/fake-agents.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
import type { ResidentProfile } from "../../src/shared/residents.ts";
import type { ReviewItem, Session, Task } from "../../src/shared/types.ts";

/**
 * What is at stake: with the `async-input` preview flag on, an agent files a question and keeps
 * working. Wherever the question appears, the operator must be able to see whether its agent is
 * still working past it or has stopped on it, and what it is doing meanwhile: on the question
 * card, in the inbox's order, on the state badge, in the conversation (including how the question
 * ended, a merge closure among them), on Remind me later, and in the Residents drawer.
 *
 * Real daemon, real routes, real SSE and the real built dashboard. Questions are posted on the
 * exact channel the MCP `request_input` tool uses, with the `asyncCapable` marker it sends, and
 * the agents are the suite's fakes, so no model tokens are spent.
 */

const EVIDENCE = artifactsDir("async-input-dashboard");
const HELD_TURN = "E2E_HOLD_TURN_UNTIL_RELEASED";

async function capture(target: Locator | Page, name: string, page: Page): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  // A focused control keeps its tooltip open; blur it so the capture shows only the surface.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.mouse.move(0, 0);
  await expect(page.locator(".tooltip")).toHaveCount(0, { timeout: 3000 }).catch(() => undefined);
  await target.screenshot({ path: join(EVIDENCE, `${name}.png`) });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/async-input-dashboard/${name}.png`);
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

async function enableAsyncInput(daemon: DaemonHandle): Promise<void> {
  const { config } = await api<{ config: { overrides: Record<string, boolean> } }>(
    daemon, "/api/feature-flags", { kind: "flag", id: "async-input", enabled: true }, "PUT");
  expect(config.overrides["async-input"]).toBe(true);
}

function linterQuestion(question: string): Record<string, unknown> {
  return {
    kind: "input",
    title: question,
    body: `${question}\n\nThe repo has no linter. CI runs Prettier only.`,
    snoozable: true,
    decisions: [{
      id: "q",
      question,
      allowOther: true,
      options: [
        { id: "o0", label: "biome", detail: "lint + format in one fast binary" },
        { id: "o1", label: "eslint", detail: "type-aware rules", recommended: true },
      ],
    }],
  };
}

type Filed = { id: string; wait: "call" | "message" };

/** Ask the way the MCP `request_input` tool does. `asyncCapable: false` is an older MCP child. */
async function ask(daemon: DaemonHandle, cwd: string, body: Record<string, unknown>, asyncCapable = true): Promise<Filed> {
  const res = await fetch(`${daemon.baseURL}/mcp/reviews`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": token(daemon) },
    body: JSON.stringify({ env: {}, cwd, ...(asyncCapable ? { asyncCapable: true } : {}), ...body }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return await res.json() as Filed;
}

async function sessionFor(daemon: DaemonHandle, taskId: string): Promise<Session | undefined> {
  return (await api<Session[]>(daemon, "/api/sessions")).find((s) => s.task?.id === taskId);
}

/** Dispatch a task and wait until its agent is in `state`. */
async function dispatch(daemon: DaemonHandle, title: string, intent: string, state: "working" | "idle"): Promise<Session> {
  const task = await api<Task>(daemon, "/api/tasks", {
    repoRoot: daemon.repo, title, intent, kind: "ship", agent: "claude", runtime: "sdk", workflowId: null,
  });
  let session!: Session;
  await expect.poll(async () => {
    session = (await sessionFor(daemon, task.id))!;
    return session?.agentSessionId ? session.state : null;
  }, { timeout: 60_000 }).toBe(state);
  return session;
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

/** Focus a session's conversation from the Console rail. */
async function openSession(page: Page, session: Session): Promise<Locator> {
  await page.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row", { hasText: session.name }).first().click();
  const detail = page.locator(".console-detail");
  await expect(detail).toContainText(session.name);
  return detail;
}

/** The inbox row of one session's questions. */
const inboxRow = (inbox: Locator, session: Session): Locator =>
  inbox.locator("section.inbox-reviews").filter({ has: inbox.page().locator(".inbox-head strong", { hasText: session.name }) });

const LINTER = "Which linter should this repo use?";
const PARSER = "Should the parser keep its old name?";
const MEANWHILE = "proceeding with eslint; the config is one file";

test("a question says whether its agent is still working or has stopped, on the card, the badge, the inbox order and the conversation", async ({ dashboard: page, daemon }) => {
  test.setTimeout(150_000);
  await enableAsyncInput(daemon);
  // One agent holds its turn open (working when it asks); the other has finished its turn.
  const busy = await dispatch(daemon, "Add a linter to CI", `${HELD_TURN} add a linter to CI`, "working");
  const stuck = await dispatch(daemon, "Rename the parser", "rename the parser", "idle");

  const linter = await ask(daemon, busy.cwd!, { ...linterQuestion(LINTER), meanwhile: MEANWHILE });
  expect(linter.wait).toBe("message");
  // Asked later, so oldest-first alone would list it second.
  const parser = await ask(daemon, stuck.cwd!, linterQuestion(PARSER));
  expect(parser.wait).toBe("message");
  await expect(page.locator("button.pulse-seg", { hasText: "to answer" }).locator(".pulse-n")).toHaveText("2");

  // The inbox: the stopped session leads, and each card says which state its agent is in.
  let inbox = await openInbox(page);
  const rows = inbox.locator("section.inbox-reviews .inbox-head strong");
  await expect(rows).toHaveText([stuck.name, busy.name]);
  const busyCard = inboxRow(inbox, busy);
  await expect(busyCard.locator(".review-wait")).toContainText("Still working");
  await expect(busyCard.locator(".review-wait")).toContainText(`Meanwhile ${MEANWHILE}`);
  await expect(busyCard.locator(".review-wait")).toContainText(/asked (just now|\d+s ago)/);
  await expect(inboxRow(inbox, stuck).locator(".review-wait")).toContainText("Stopped, waiting on this answer");
  await capture(inbox, "01-inbox-stopped-first", page);
  // The row's own Dismiss says the agent keeps working rather than that it keeps waiting.
  // Every action's words follow the same status as the card: the working agent keeps working, and
  // the stopped one has stopped.
  await expect(busyCard.getByRole("button", { name: `Dismiss ${busy.name} from the inbox` }))
    .toHaveAccessibleDescription(/The agent keeps working and the questions stay open/);
  await expect(busyCard.getByRole("button", { name: /Remind me later/ }))
    .toHaveAccessibleDescription(/The agent keeps working, and this question comes back to you later/);
  await expect(inboxRow(inbox, stuck).getByRole("button", { name: `Dismiss ${stuck.name} from the inbox` }))
    .toHaveAccessibleDescription(/The agent has stopped on them and the questions stay open/);
  await expect(inboxRow(inbox, stuck).getByRole("button", { name: /Remind me later/ }))
    .toHaveAccessibleDescription(/The agent has stopped on it and hears nothing unless you choose a provisional option or Hold/);
  await closeOverlay(page, inbox);

  // The badge of the working session: its questions, in the working tone, opening them.
  const detail = await openSession(page, busy);
  const badge = detail.locator(".detail-head .badge").first();
  await expect(badge).toHaveText(/1 question open/);
  await expect(badge).toHaveClass(/badge-working/);
  await expect(badge).not.toHaveClass(/badge-attention/);
  await capture(page, "02-working-badge", page);
  await badge.click();
  const modal = page.getByRole("dialog", { name: "Review request" });
  await expect(modal).toBeVisible();
  await expectContentClearsBorder(modal);
  await expect(modal.locator(".review-wait")).toContainText("Still working");
  await capture(modal, "03-modal-still-working", page);
  await closeOverlay(page, modal);

  // The conversation records the question where it was asked, with a way to answer it.
  const asked = detail.getByRole("note", { name: `Asked: ${LINTER}` });
  await expect(asked).toContainText(MEANWHILE);
  // The rest of the question beneath its heading: here, the context it was filed with.
  await expect(asked.locator(".review-asked-question")).toHaveText("The repo has no linter. CI runs Prettier only.");
  await expect(asked).toContainText("Open, not answered yet");
  await expect(asked.locator(".review-asked-status")).toHaveText("Still working");
  await capture(asked, "04-conversation-asked-open", page);
  await asked.getByRole("button", { name: "Answer" }).click();
  await expect(modal).toBeVisible();
  await closeOverlay(page, modal);

  // The agent runs out of work: the badge turns amber and the card says it has stopped.
  writeFileSync(join(daemon.recordDir, "e2e-release-held-turn"), "");
  await expect(badge).toHaveText(/waiting on your answer/, { timeout: 30_000 });
  await expect(badge).toHaveClass(/badge-attention/);
  await expect(asked.locator(".review-asked-status")).toHaveText("Stopped, waiting on this answer");
  await capture(asked, "04b-conversation-asked-stopped", page);
  inbox = await openInbox(page);
  await expect(inboxRow(inbox, busy).locator(".review-wait")).toContainText("Stopped, waiting on this answer");
  await expect(inboxRow(inbox, busy).locator(".review-wait")).not.toContainText(MEANWHILE);
  await capture(inbox, "05-inbox-both-stopped", page);

  // Answered from the inbox: the conversation keeps the Asked entry and adds the answer.
  await inboxRow(inbox, busy).getByRole("radio", { name: /eslint/ }).check();
  await inboxRow(inbox, busy).getByRole("button", { name: /^Submit/ }).click();
  await expect(inboxRow(inbox, busy)).toHaveCount(0);
  await closeOverlay(page, inbox);
  await expect(asked).toContainText("Answered");
  await expect(asked.getByRole("button", { name: "Answer" })).toHaveCount(0);
  await expect(asked.locator(".review-asked-status")).toHaveCount(0);
  await expect(detail.locator(".review-answer")).toContainText(LINTER);
  await asked.scrollIntoViewIfNeeded();
  await capture(page, "06-conversation-answered", page);
});

test("the Sitrep offers Review for a session stopped on a filed question, and a Board tile names a working session's open question without turning amber", async ({ dashboard: page, daemon }) => {
  test.setTimeout(150_000);
  await enableAsyncInput(daemon);
  const busy = await dispatch(daemon, "Add a linter to CI", `${HELD_TURN} add a linter to CI`, "working");
  const stuck = await dispatch(daemon, "Rename the parser", "rename the parser", "idle");
  expect((await ask(daemon, busy.cwd!, { ...linterQuestion(LINTER), meanwhile: MEANWHILE })).wait).toBe("message");
  expect((await ask(daemon, stuck.cwd!, linterQuestion(PARSER))).wait).toBe("message");
  await expect.poll(async () => (await sessionFor(daemon, stuck.task!.id))?.openQuestions).toBe(1);
  await expect.poll(async () => (await sessionFor(daemon, stuck.task!.id))?.pendingReviews).toBe(0);
  await expect(page.locator("button.pulse-seg", { hasText: "to answer" }).locator(".pulse-n")).toHaveText("2");

  // The Sitrep's Needs you row: a session whose only ask is a filed question still offers Review,
  // and Review opens that question.
  const sitrep = page.getByRole("dialog", { name: "Sitrep" });
  await expect(async () => {
    if (!(await sitrep.isVisible())) await page.keyboard.press("Shift+P");
    await expect(sitrep).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 30_000 });
  const needsYou = sitrep.locator(".report-section").filter({ has: page.getByRole("heading", { name: /^Needs you/ }) });
  const stuckRow = needsYou.locator(".report-row", { hasText: "Rename the parser" });
  await expect(stuckRow).toContainText("waiting on your answer");
  // Still working, so it is not in Needs you at all.
  await expect(needsYou.locator(".report-row", { hasText: "Add a linter to CI" })).toHaveCount(0);
  await capture(sitrep, "12-sitrep-review", page);
  await stuckRow.getByRole("button", { name: "Review", exact: true }).click();
  await expect(sitrep).toBeHidden();
  const modal = page.getByRole("dialog", { name: "Review request" });
  await expect(modal).toBeVisible();
  await expectContentClearsBorder(modal);
  await expect(modal).toContainText(PARSER);
  await expect(modal.locator(".review-wait")).toContainText("Stopped, waiting on this answer");
  await closeOverlay(page, modal);

  // The Board: the working tile carries the question as a flag in the working tone; the stopped
  // one is amber and carries the same flag.
  const layout = await api<{ config?: { layout?: string } }>(daemon, "/api/ui/config", { layout: "board" }, "PUT");
  expect(layout.config?.layout).toBe("board");
  await page.reload();
  await expect(page.locator("main.board")).toBeVisible();
  const busyTile = page.locator(".tile").filter({ hasText: "Add a linter to CI" });
  const stuckTile = page.locator(".tile").filter({ hasText: "Rename the parser" });
  await expect(busyTile.locator(".tile-flag.tf-question")).toHaveText("1 question open");
  await expect(busyTile).toHaveClass(/tone-working/);
  await expect(busyTile).not.toHaveClass(/\battention\b/);
  await expect(stuckTile.locator(".tile-flag.tf-question")).toHaveText("1 question open");
  await expect(stuckTile).toHaveClass(/tone-attention/);
  await capture(page, "13-board-question-flags", page);
});

test("Remind me later starts on Keep doing what it said for an agent that never waited, and sends it nothing", async ({ dashboard: page, daemon }) => {
  test.setTimeout(120_000);
  await enableAsyncInput(daemon);
  const session = await dispatch(daemon, "Add a linter to CI", "add a linter to CI", "idle");
  const filed = await ask(daemon, session.cwd!, { ...linterQuestion(LINTER), meanwhile: MEANWHILE });
  expect(filed.wait).toBe("message");

  const inbox = await openInbox(page);
  const card = inboxRow(inbox, session);
  // This agent finished its turn, so it has stopped on the question: nothing claims it keeps working.
  await expect(card.locator(".review-wait")).toContainText("Stopped, waiting on this answer");
  await expect(card.getByRole("button", { name: /Remind me later/ }))
    .toHaveAccessibleDescription(/The agent has stopped on it and hears nothing unless you choose a provisional option or Hold/);
  await expect(card.getByRole("button", { name: `Dismiss ${session.name} from the inbox` }))
    .toHaveAccessibleDescription(/The agent has stopped on them/);
  await card.getByRole("button", { name: /Remind me later/ }).click();
  const sheet = card.getByRole("group", { name: "Remind me later" });
  const keepDoing = sheet.getByRole("radio", { name: /Keep doing what it said/ });
  await expect(keepDoing).toBeChecked();
  await expect(sheet).toContainText(`It said "${MEANWHILE}". It has since stopped. Nothing is sent to it`);
  await expect(sheet.getByRole("button", { name: /^Remind me / }))
    .toHaveAccessibleDescription("Park this question; the agent stays stopped unless you choose a provisional option or Hold");
  await expect(sheet).not.toContainText("Use your best judgment");
  await capture(card, "07-remind-later-sheet", page);
  await sheet.getByRole("button", { name: /^Remind me / }).click();

  const snoozed = inbox.getByRole("region", { name: `Snoozed: ${LINTER}` });
  await expect(snoozed).toContainText("Meanwhile: keep doing what it said");
  await capture(snoozed, "08-snoozed-row", page);
  await expect.poll(async () => (await api<ReviewItem[]>(daemon, "/api/reviews")).find((r) => r.id === filed.id)?.status).toBe("snoozed");
  // Nothing is owed to the agent: no "carry on" message was queued for this question.
  const snoozeRow = () => withDaemonDb(daemon, (db) => ({ ...db.prepare(
    "SELECT snooze_instruction_owed_at AS owed, snooze_mode AS mode FROM reviews WHERE id = ?",
  ).get(filed.id) as { owed: number | null; mode: string | null } }));
  expect(snoozeRow()).toEqual({ owed: null, mode: null });

  // That silent snooze told the agent nothing, so when the question comes back the Meanwhile
  // choice is offered again, and choosing Hold now does reach the agent.
  await snoozed.getByRole("button", { name: "Answer now" }).click();
  await expect(snoozed).toHaveCount(0);
  await card.getByRole("button", { name: /Remind me later/ }).click();
  const again = card.getByRole("group", { name: "Remind me later" });
  await expect(again).not.toContainText("keeps doing what you chose last time");
  await again.getByRole("radio", { name: /Hold work that depends on this/ }).check();
  await again.getByRole("button", { name: /^Remind me / }).click();
  await expect(inbox.getByRole("region", { name: `Snoozed: ${LINTER}` })).toContainText("Meanwhile: hold work that depends on this");
  await expect.poll(() => snoozeRow().mode).toBe("hold");
  expect(snoozeRow().owed).not.toBeNull();
});

test("a merge's closure is recorded in the conversation for a filed question and for a snoozed call-mode question, and survives a reload", async ({ dashboard: page, daemon }) => {
  test.setTimeout(150_000);
  await enableAsyncInput(daemon);
  await api(daemon, "/api/shipping/config", { closeSessionAfterMerge: false }, "PUT");
  const session = await dispatch(daemon, "Ship the linter", "add a linter to CI", "idle");

  const filed = await ask(daemon, session.cwd!, { ...linterQuestion(LINTER), meanwhile: MEANWHILE });
  expect(filed.wait).toBe("message");
  // An older MCP child: the question waits in the call, and the operator snoozes it.
  const callMode = await ask(daemon, session.cwd!, linterQuestion(PARSER), false);
  expect(callMode.wait).toBe("call");
  await api(daemon, `/api/reviews/${callMode.id}/snooze`, { delay: "1h", meanwhile: { mode: "judgment" } });

  const detail = await openSession(page, session);
  await expect(detail.getByRole("note", { name: `Asked: ${LINTER}` })).toContainText("Open, not answered yet");
  await expect(detail.getByRole("note", { name: `Snoozed: ${PARSER}` })).toBeVisible();

  const cwd = session.cwd!;
  const git = (...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
  git("switch", "-c", "feat/linter");
  writeFileSync(join(cwd, "lint.txt"), "eslint\n");
  git("add", "lint.txt");
  git("-c", "user.name=e2e", "-c", "user.email=e2e@example.invalid", "commit", "-qm", "Add a linter");
  const prUrl = "https://github.com/acme/mission-e2e/pull/1610";
  writeGhPullRequests(daemon.home, [{
    cwd, number: 1610, url: prUrl, state: "MERGED", createdAt: new Date().toISOString(),
    mergedAt: new Date().toISOString(), headRefOid: git("rev-parse", "HEAD"), headRefName: git("branch", "--show-current"),
  }]);
  const hook = async (event: string, extra = {}) => {
    const response = await fetch(`${daemon.baseURL}/hooks/${event}`, {
      method: "POST", headers: { "content-type": "application/json", "x-harness-token": token(daemon) },
      body: JSON.stringify({ agent: session.agent, sessionId: session.agentSessionId, cwd, env: {}, ...extra }),
    });
    expect(response.status).toBe(204);
  };
  await hook("PostToolUse", { toolName: "Bash", prCreated: true, prUrl, prUrls: [prUrl] });
  await expect.poll(async () => (await api<Session[]>(daemon, "/api/sessions")).find((s) => s.id === session.id)?.prState,
    { timeout: 30_000 }).toBe("merged");
  await hook("Stop");

  await expect.poll(async () => {
    const reviews = await api<ReviewItem[]>(daemon, "/api/reviews");
    return [filed.id, callMode.id].map((id) => {
      const review = reviews.find((r) => r.id === id);
      return review && `${review.status}:${review.closedReason ?? ""}`;
    });
  }, { timeout: 30_000 }).toEqual(["orphaned:merged", "orphaned:merged"]);

  const askedEntry = detail.getByRole("note", { name: `Asked: ${LINTER}` });
  const closedEntry = detail.getByRole("note", { name: `Closed: ${PARSER}` });
  await expect(askedEntry).toContainText("Closed unanswered: pull request merged");
  await expect(askedEntry.getByRole("button", { name: "Answer" })).toHaveCount(0);
  await expect(closedEntry).toContainText("Closed unanswered: pull request merged");
  await expect(closedEntry.locator(".review-asked-question")).toHaveText("The repo has no linter. CI runs Prettier only.");
  // In place of its Snoozed entry, not beside it.
  await expect(detail.getByRole("note", { name: `Snoozed: ${PARSER}` })).toHaveCount(0);
  await capture(page, "09-merge-closure", page);

  // The live half is gone after a reload; the history route alone still carries both closures.
  await page.reload();
  const reloaded = await openSession(page, session);
  await expect(reloaded.getByRole("note", { name: `Asked: ${LINTER}` })).toContainText("Closed unanswered: pull request merged");
  await expect(reloaded.getByRole("note", { name: `Closed: ${PARSER}` })).toContainText("Closed unanswered: pull request merged");
  await capture(page, "10-merge-closure-after-reload", page);

  // Flag off: a question that waited inside its call was never in the conversation before this
  // feature, so its closure leaves with the flag. The filed question stays: it exists only because
  // the flag was on, and the plan keeps such questions answerable after the flag is turned off.
  const { config } = await api<{ config: { overrides: Record<string, boolean> } }>(
    daemon, "/api/feature-flags", { kind: "flag", id: "async-input", enabled: false }, "PUT");
  expect(config.overrides["async-input"]).toBe(false);
  await expect(reloaded.getByRole("note", { name: `Closed: ${PARSER}` })).toHaveCount(0);
  await expect(reloaded.getByRole("note", { name: `Asked: ${LINTER}` })).toContainText("Closed unanswered: pull request merged");
  await page.reload();
  const flagOff = await openSession(page, session);
  await expect(flagOff.getByRole("note", { name: `Asked: ${LINTER}` })).toBeVisible();
  await expect(flagOff.getByRole("note", { name: `Closed: ${PARSER}` })).toHaveCount(0);
  await capture(page, "14-merge-closure-flag-off", page);
});

// ---- the Residents drawer ----

const RESIDENT = "Linter watcher";

function waitingResidents(daemon: DaemonHandle): number {
  return withDaemonDb(daemon, (db) => (db.prepare(
    "SELECT COUNT(*) AS n FROM resident_runs WHERE ended_at IS NULL AND launch_state = 'launched' AND loop_state = 'waiting'",
  ).get() as { n: number }).n);
}

test("the Residents drawer lists a working resident's question under Needs you without turning it amber", async ({ dashboard: page, daemon }) => {
  test.setTimeout(120_000);
  await enableAsyncInput(daemon);
  const personas = await api<Array<{ id: string; name: string }>>(daemon, "/api/personas");
  const profile = await api<ResidentProfile>(daemon, "/api/residents/profiles", { settings: {
    identity: { name: RESIDENT },
    persona: { personaId: personas.find((p) => p.name === "Code Risk Reviewer")!.id },
    workspace: { defaultRepoRoot: daemon.repo },
    execution: { model: "claude-fable-5" },
    // A long cadence keeps the resident between steps rather than iterating under the test.
    loop: { delaySeconds: 3600, minDelaySeconds: 60, maxDelaySeconds: 3600 },
  } });
  await api(daemon, `/api/residents/profiles/${profile.id}/launch`, { repoRoot: daemon.repo, requestId: "launch-linter-watcher" });
  await expect.poll(() => waitingResidents(daemon), { timeout: 60_000 }).toBe(1);

  const config = { residentPlacement: "drawer", residentDrawerPinned: false, layout: "board" };
  await api(daemon, "/api/ui/config", config, "PUT");
  await page.evaluate((next) => {
    const raw = JSON.parse(window.localStorage.getItem("mission-control.ui") ?? "{}") as Record<string, unknown>;
    window.localStorage.setItem("mission-control.ui", JSON.stringify({ ...raw, ...next }));
  }, config);
  await page.goto(`${daemon.baseURL}/#/fleet`);
  await page.reload();
  await page.getByRole("button", { name: "Residents - 1 live", exact: true }).click();
  const drawer = page.getByRole("complementary", { name: "Residents", exact: true });
  const card = drawer.getByRole("listitem").filter({ has: page.getByRole("button", { name: new RegExp(`^${RESIDENT}, `) }) });
  await expect(card).toBeVisible();
  const residentId = await card.getAttribute("data-resident-card");
  const resident = (await api<Session[]>(daemon, "/api/sessions")).find((s) => s.id === residentId)!;

  // At work on its standing task.
  const prompt = await fetch(`${daemon.baseURL}/hooks/UserPromptSubmit`, {
    method: "POST", headers: { "content-type": "application/json", "x-harness-token": token(daemon) },
    body: JSON.stringify({ agent: resident.agent, cwd: resident.cwd, sessionId: resident.agentSessionId ?? resident.id, env: {}, prompt: "carry on" }),
  });
  expect(prompt.status).toBe(204);
  await expect(card.getByRole("button", { name: `${RESIDENT}, working` })).toBeVisible();

  const filed = await ask(daemon, resident.cwd!, linterQuestion(LINTER));
  expect(filed.wait).toBe("message");
  const needsYou = drawer.getByRole("list", { name: "Residents that need you" });
  await expect(needsYou.getByRole("button", { name: new RegExp(`^${RESIDENT}, working$`) })).toBeVisible();
  await expect(needsYou.getByRole("list", { name: `${RESIDENT} is asking` }).getByRole("button", { name: new RegExp(LINTER.replace("?", "\\?")) }))
    .toBeVisible();
  await expect(needsYou.getByRole("listitem").first()).not.toHaveClass(/needs-you/);
  await capture(page, "11-drawer-working-resident-question", page);

  // Its ask row opens the question, with the resident read as still working.
  await needsYou.getByRole("list", { name: `${RESIDENT} is asking` }).getByRole("button").first().click();
  const modal = page.getByRole("dialog", { name: "Review request" });
  await expect(modal).toBeVisible();
  await expectContentClearsBorder(modal);
  await expect(modal.locator(".review-wait")).toContainText("Still working");
  await closeOverlay(page, modal);

  // Its turn ends: an unpaused resident still reads as working, because it wakes on its own cadence.
  const stop = await fetch(`${daemon.baseURL}/hooks/Stop`, {
    method: "POST", headers: { "content-type": "application/json", "x-harness-token": token(daemon) },
    body: JSON.stringify({ agent: resident.agent, cwd: resident.cwd, sessionId: resident.agentSessionId ?? resident.id, env: {} }),
  });
  expect(stop.status).toBe(204);
  const residentCard = drawer.getByRole("listitem").filter({ has: page.getByRole("button", { name: new RegExp(`^${RESIDENT}, `) }) });
  await expect(residentCard.getByRole("button", { name: new RegExp(`^${RESIDENT}, idle$`) })).toBeVisible({ timeout: 30_000 });
  await expect(residentCard).not.toHaveClass(/needs-you/);

  // Paused from its own card, it will not wake to act on the question: it has stopped on it, so
  // the drawer turns it amber and the question says so.
  await residentCard.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(residentCard.getByRole("button", { name: "Resume", exact: true })).toBeVisible();
  await expect(residentCard).toHaveClass(/needs-you/);
  // The Pause button's tooltip outlives its swap to Resume; a hover and leave on Resume closes it.
  await residentCard.getByRole("button", { name: "Resume", exact: true }).hover();
  await page.mouse.move(0, 0);
  await capture(page, "15-drawer-paused-resident-question", page);
  await residentCard.getByRole("list", { name: `${RESIDENT} is asking` }).getByRole("button").first().click();
  await expect(modal).toBeVisible();
  await expect(modal.locator(".review-wait")).toContainText("Stopped, waiting on this answer");
  await expect(modal.getByRole("button", { name: /Remind me later/ }))
    .toHaveAccessibleDescription(/The agent has stopped on it/);
  await capture(modal, "16-paused-resident-card-stopped", page);
});
