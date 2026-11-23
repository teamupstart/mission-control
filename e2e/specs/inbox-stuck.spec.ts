import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import { INBOX_MESSAGES } from "../../src/shared/inbox.ts";
import type { Session, Task } from "../../src/shared/types.ts";

/**
 * What is at stake: with the `inbox` preview flag on, a session the daemon's stall rules flag
 * gets a row in the inbox's Stuck section that says why and offers the fix in place, counts in
 * "to answer", leaves on its own when the session moves, and stays dismissed across a reload.
 * A row about a queue alone offers no Mark done, because there is no task to complete, and no
 * card offers Cancel.
 *
 * Real daemon, real stall detector, real routes and the real built dashboard; the agents are
 * the suite's fakes. The idle rule's threshold is lowered to its one-minute floor and the spec
 * waits it out, as `line-review-parked-run.spec.ts` does: the clock the rule reads is the
 * session's in-memory `lastActivity`, which is not stored in the database, so there is no row
 * to age instead.
 *
 * One reply is scripted. A queue-only stall needs a live session whose task is over while its
 * queue is open, and no route produces one from a dispatch: completing a task closes its
 * worktree session (`TaskManager.complete`), and a dispatch always cuts a worktree. So session B
 * really stalls on its open task, and the browser's copy of `/api/away/stalls` reports B's
 * facts as the daemon reports a queue-only stall (`detectStall`'s facts are pinned in
 * `test/stall.test.ts`). Everything the row then does goes through the real daemon.
 */

const EVIDENCE = artifactsDir("inbox-stuck");

async function capture(target: Locator, name: string, page: Page): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await expect(page.locator(".tooltip")).toHaveCount(0, { timeout: 3000 }).catch(() => undefined);
  await target.screenshot({ path: join(EVIDENCE, `${name}.png`) });
  // eslint-disable-next-line no-console
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

const toAnswer = (page: Page) => page.locator("button.pulse-seg", { hasText: "to answer" }).locator(".pulse-n");
const stuckRow = (inbox: Locator, name: string) => inbox.getByRole("region", { name: `${name} is stuck` });

test("a stalled session gets a Stuck row with the fix in place, and the row leaves when the fix lands", async ({ dashboard: page, daemon }) => {
  test.setTimeout(330_000);
  await setInbox(daemon, true);
  await api(daemon, "/api/away", { detectStalls: true, stallUnfinishedMinutes: 1 }, "PUT");

  // A: an open task, finished from the row. C: an open task, told to continue. B: drawn as a
  // queue-only stall (see the note above), so its row has no task to mark done.
  const a = await dispatch(daemon, "Fix the parser");
  const c = await dispatch(daemon, "Tidy the changelog");
  const b = await dispatch(daemon, "Drain the queue");
  await page.route("**/api/away/stalls", async (route) => {
    const response = await route.fetch();
    const stalls = await response.json() as Array<{ sessionId: string; facts?: unknown; fingerprint?: string }>;
    const facts = { kind: "unfinished-work", task: null, queueOpen: 1 };
    await route.fulfill({
      response,
      json: stalls.map((stall) => stall.sessionId === b.session.id
        ? { ...stall, facts, fingerprint: JSON.stringify(facts) }
        : stall),
    });
  });

  // The daemon's own answer first, so a failure separates "the rule never fired" from "the
  // dashboard never drew it".
  await expect.poll(async () => {
    const stalls = await api<Array<{ sessionId: string; kind: string }>>(daemon, "/api/away/stalls");
    return [a, b, c].map(({ session }) => stalls.find((s) => s.sessionId === session.id)?.kind ?? null);
  }, { timeout: 180_000, intervals: [2_000] }).toEqual(["unfinished-work", "unfinished-work", "unfinished-work"]);

  await expect(toAnswer(page)).toHaveText("3", { timeout: 15_000 });
  const inbox = await openInbox(page);
  await expect(inbox.locator("h4.inbox-section", { hasText: /^Stuck$/ })).toBeVisible();
  // One row per stuck session, never also drawn under Waiting on you.
  await expect(inbox.locator("h4.inbox-section", { hasText: "Waiting on you" })).toHaveCount(0);

  const rowA = stuckRow(inbox, a.task.title);
  await expect(rowA).toContainText("Idle with work open");
  await expect(rowA).toContainText(/idle \d+m with work unfinished/);
  await expect(rowA).toContainText('Open: the task "Fix the parser".');
  for (const name of ["Continue", "Mark done", "Open session"]) {
    await expect(rowA.getByRole("button", { name, exact: true })).toBeVisible();
  }
  await expect(rowA.getByRole("button", { name: `Dismiss ${a.task.title} from the inbox` })).toBeVisible();
  await expect(rowA.getByRole("textbox", { name: `Message ${a.task.title}` })).toBeVisible();

  const rowB = stuckRow(inbox, b.task.title);
  await expect(rowB).toContainText("Open: 1 open queue item. A queue's items are handled in the session.");
  await expect(rowB.getByRole("button", { name: "Continue", exact: true })).toBeVisible();
  await expect(rowB.getByRole("button", { name: "Open session", exact: true })).toBeVisible();
  await expect(rowB.getByRole("button", { name: "Mark done" })).toHaveCount(0);

  // No inbox card offers Cancel.
  await expect(inbox.getByRole("button", { name: /cancel/i })).toHaveCount(0);
  await capture(inbox, "01-stuck-section", page);

  // Dismiss holds across a reload, and leaves "to answer".
  await rowB.getByRole("button", { name: `Dismiss ${b.task.title} from the inbox` }).click();
  await expect(rowB).toHaveCount(0);
  await expect(toAnswer(page)).toHaveText("2");
  await page.reload();
  await expect(toAnswer(page)).toHaveText("2", { timeout: 15_000 });
  let reopened = await openInbox(page);
  await expect(stuckRow(reopened, b.task.title)).toHaveCount(0);

  // Continue puts the fixed text in the agent's conversation, and the session working again
  // takes its row away.
  const rowC = stuckRow(reopened, c.task.title);
  await rowC.getByRole("button", { name: "Continue", exact: true }).click();
  await expect.poll(async () => {
    const served = await api<{ messages: Array<{ role: string; text: string }> }>(
      daemon, `/api/sessions/${encodeURIComponent(c.session.id)}/transcript`);
    return served.messages.some((m) => m.role === "user" && m.text.includes(INBOX_MESSAGES.continue));
  }, { timeout: 30_000 }).toBe(true);
  await expect(rowC).toHaveCount(0, { timeout: 30_000 });
  await expect(toAnswer(page)).toHaveText("1", { timeout: 15_000 });

  // Mark done completes the task, and the row leaves.
  reopened = page.getByRole("dialog", { name: "Attention inbox" });
  if (!(await reopened.isVisible())) reopened = await openInbox(page);
  await stuckRow(reopened, a.task.title).getByRole("button", { name: "Mark done", exact: true }).click();
  await expect.poll(async () => (await api<Task[]>(daemon, "/api/tasks")).find((t) => t.id === a.task.id)?.status,
    { timeout: 15_000 }).toBe("done");
  await expect(stuckRow(reopened, a.task.title)).toHaveCount(0, { timeout: 30_000 });
  await expect(page.locator("button.pulse-seg", { hasText: "to answer" })).toHaveCount(0, { timeout: 15_000 });
});

test("with the inbox flag off a stalled session draws no Stuck row, and the fixed-message route refuses", async ({ dashboard: page, daemon }) => {
  test.setTimeout(240_000);
  await api(daemon, "/api/away", { detectStalls: true, stallUnfinishedMinutes: 1 }, "PUT");
  const a = await dispatch(daemon, "Fix the parser");
  await expect.poll(async () => {
    const stalls = await api<Array<{ sessionId: string }>>(daemon, "/api/away/stalls");
    return stalls.some((s) => s.sessionId === a.session.id);
  }, { timeout: 180_000, intervals: [2_000] }).toBe(true);
  // Long enough for the dashboard's 5s poll to have carried the stall in.
  await page.waitForTimeout(6_000);
  await expect(page.locator("button.pulse-seg", { hasText: "to answer" })).toHaveCount(0);
  const refused = await fetch(`${daemon.baseURL}/api/sessions/${a.session.id}/inbox-message`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "continue" }),
  });
  expect(refused.status).toBe(403);

  // Turned on with the page open, the same stall becomes a row.
  await setInbox(daemon, true);
  await expect(toAnswer(page)).toHaveText("1", { timeout: 15_000 });
  const inbox = await openInbox(page);
  await expect(stuckRow(inbox, a.task.title)).toBeVisible();
});

/**
 * One real workflow run parked in `waiting_for_session` that nothing reopens on its own: a
 * manual resumption policy and a Preview binding. Built as `line-review-parked-run.spec.ts`
 * builds it - a dispatched fake agent, a persona the fake reviewer always fails, and a
 * submission - so the run is the daemon's own, not a served stall.
 */
async function seedParkedRun(page: Page, daemon: DaemonHandle, name: string): Promise<{ runId: string; sessionId: string }> {
  const before = new Set((await api<Session[]>(daemon, "/api/sessions")).map((s) => s.id));
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(`park a ${name} run`);
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
  let sessionId = "";
  await expect.poll(async () => {
    const live = (await api<Session[]>(daemon, "/api/sessions")).find((s) => !before.has(s.id) && s.state !== "exited");
    sessionId = live?.id ?? "";
    return live?.state ?? "";
  }, { timeout: 60_000 }).toBe("idle");
  const persona = await api<{ id: string }>(daemon, "/api/personas", {
    name: `Strict reviewer ${name}`,
    guidanceMarkdown: `# Strict reviewer ${name}\n\nE2E_FAIL_VERDICT`,
  });
  const workflow = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", {
    name,
    resumptionPolicy: "manual",
    draft: {
      nodes: [
        { id: "session", kind: "session", position: { x: 0, y: 0 } },
        { id: "reviewer", kind: "persona", personaId: persona.id, position: { x: 220, y: 0 } },
        { id: "end", kind: "end", outcome: "Approved", position: { x: 440, y: 0 } },
      ],
      edges: [
        { id: "submit", source: "session", sourcePort: "submitted", target: "reviewer", targetPort: "activate" },
        { id: "pass", source: "reviewer", sourcePort: "pass", target: "end", targetPort: "terminal" },
        { id: "fail", source: "reviewer", sourcePort: "fail", target: "session", targetPort: "return_for_changes" },
      ],
    },
  });
  const published = await api<{ version: { id: string } }>(
    daemon, `/api/workflows/${workflow.workflow.id}/publish`, { expectedDraftRevision: 1 });
  const binding = await api<{ id: string }>(daemon, "/api/workflow-bindings", {
    workflowVersionId: published.version.id, sessionId, deliveryMode: "preview",
  });
  const submitted = await api<{ run: { id: string } }>(
    daemon, `/api/workflow-bindings/${binding.id}/submit`, { requestId: `e2e-stuck-${name}` });
  await expect.poll(async () => (await runOf(daemon, submitted.run.id)).status, { timeout: 60_000 })
    .toBe("waiting_for_session");
  return { runId: submitted.run.id, sessionId };
}

/** A run's status and round, from the run summaries (the detail carries no round). */
async function runOf(daemon: DaemonHandle, runId: string): Promise<{ status: string; round: number }> {
  const page = await api<{ items: Array<{ id: string; status: string; round: number }> }>(
    daemon, "/api/workflow-runs?limit=200");
  const run = page.items.find((item) => item.id === runId);
  if (!run) throw new Error(`run ${runId} is not in the run list`);
  return run;
}

test("Resubmit on a real parked run's Stuck row reopens that run through the daemon", async ({ dashboard: page, daemon }) => {
  test.setTimeout(330_000);
  await setInbox(daemon, true);
  await api(daemon, "/api/away", { detectStalls: true, stallUnfinishedMinutes: 1 }, "PUT");
  const { runId, sessionId } = await seedParkedRun(page, daemon, "Stuck review");
  const parked = await runOf(daemon, runId);

  // The real detector raises the stall, with the facts that make Resubmit the remedy.
  await expect.poll(async () => {
    const stalls = await api<Array<{ sessionId: string; kind: string; facts?: { resubmittable?: boolean } }>>(daemon, "/api/away/stalls");
    const mine = stalls.find((s) => s.sessionId === sessionId);
    return mine ? `${mine.kind}:${mine.facts?.resubmittable}` : null;
  }, { timeout: 180_000, intervals: [2_000] }).toBe("workflow-parked:true");

  const inbox = await openInbox(page);
  const row = inbox.getByRole("region").filter({ hasText: "Stuck review repair round" });
  await expect(row).toContainText("Workflow run parked");
  await expect(row).toContainText(`Missing step: a resubmission to reopen Stuck review round ${parked.round}.`);
  await expect(row.getByRole("button", { name: "Tell it to push" })).toHaveCount(0);
  await expect(row.getByRole("button", { name: "Continue" })).toHaveCount(0);
  await capture(row, "07-real-parked-resubmit", page);

  // Nothing changed since the round: the daemon refuses until someone confirms an unchanged
  // resubmission, which only the run's own page offers, so the row says to go there.
  await row.getByRole("button", { name: "Resubmit", exact: true }).click();
  await expect(row.getByRole("alert")).toHaveText(
    "The repository has not changed since round 1; confirm an unchanged resubmission to review it anyway. Open run to confirm it there.");
  expect((await runOf(daemon, runId)).round).toBe(parked.round);
  await capture(row, "08-real-parked-unchanged", page);

  // The session's fix lands in its checkout, as it does when an agent fixed the findings and
  // went quiet. Now Resubmit opens the next round.
  const cwd = (await api<Session[]>(daemon, "/api/sessions")).find((s) => s.id === sessionId)!.cwd!;
  writeFileSync(join(cwd, "stuck-fix.txt"), "the findings are fixed\n");
  execFileSync("git", ["-C", cwd, "add", "stuck-fix.txt"]);
  execFileSync("git", ["-C", cwd, "-c", "user.name=E2E", "-c", "user.email=e2e@example.invalid", "commit", "-q", "-m", "fix the findings"]);
  await row.getByRole("button", { name: "Resubmit", exact: true }).click();
  await expect(row.getByRole("status")).toHaveText("Resubmitted the run.", { timeout: 30_000 });
  await expect(row.getByRole("alert")).toHaveCount(0);

  // The daemon opened the next round on the same run.
  await expect.poll(async () => (await runOf(daemon, runId)).round, { timeout: 60_000 }).toBe(parked.round + 1);
  // And the session is no longer stuck on that round.
  await expect(inbox.getByRole("region").filter({ hasText: `Stuck review repair round ${parked.round} never reopened` }))
    .toHaveCount(0, { timeout: 30_000 });
});
