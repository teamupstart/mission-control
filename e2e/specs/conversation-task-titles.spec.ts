import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Locator, Page } from "@playwright/test";

import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
import { expect, test } from "../fixtures/test.ts";

// A person reads an agent's conversation in the session detail, where tasks only ever appear
// by title. An agent that repeats a task id - one it got from `list_tasks`, or one the human
// pasted - leaves the reader a reference they cannot follow. The fake agent echoes every
// message it is sent, so a message citing two task ids gets a reply citing the same two: one
// task the dashboard holds, and one it never heard of, which only the daemon can name. The
// tests after it cover what an agent writes outside the conversation - its status line, its
// blocker and its questions - through the daemon routes its MCP tools post to.

const EVIDENCE = artifactsDir("conversation-task-titles");
const LIVE_TITLE = "Add the review verdict schema";
const ARCHIVED_TITLE = "Retire the legacy verdict table";

async function api<T>(daemon: DaemonHandle, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  return await response.json() as T;
}

/**
 * A finished task the dashboard does not hold, written behind the daemon's back.
 *
 * The same shape as a task evicted from the live board after finishing: the durable row
 * exists, and no `task_upsert` ever reached the browser. Copied from a real row so every
 * column carries a value the daemon itself wrote.
 */
function seedArchivedTask(daemon: DaemonHandle, fromId: string, title: string): string {
  const id = randomUUID();
  withDaemonDb(daemon, (db) => {
    db.exec("CREATE TEMP TABLE seeded AS SELECT * FROM tasks WHERE 0");
    db.prepare("INSERT INTO seeded SELECT * FROM tasks WHERE id = ?").run(fromId);
    db.prepare("UPDATE seeded SET id = ?, title = ?, status = 'done'").run(id, title);
    db.exec("INSERT INTO tasks SELECT * FROM seeded; DROP TABLE seeded;");
  });
  return id;
}

async function dispatch(page: Page, daemon: DaemonHandle, task: string): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  // RepoCombobox portals its list over the form. Close it before reaching fields below.
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(task);
  // Explicitly no post-work Workflow: this repo is not allowlisted for Live delivery.
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
}

/** The SDK driver's durable turn boundary, so the next message is not queued behind one. */
async function waitForDriverIdle(daemon: DaemonHandle, sessionId: string): Promise<void> {
  await expect.poll(async () => {
    const turnInProgress = withDaemonDb(daemon, (db) => {
      const row = db.prepare("SELECT turn_in_progress FROM sdk_sessions WHERE id = ?")
        .get(sessionId) as { turn_in_progress: number } | undefined;
      return row?.turn_in_progress ?? null;
    });
    const current = (await api<Array<{ id: string; state: string; pendingTurns: unknown[] }>>(daemon, "/api/sessions"))
      .find((session) => session.id === sessionId);
    return { turnInProgress, pendingTurns: current?.pendingTurns.length ?? null, state: current?.state ?? null };
  }).toEqual({ turnInProgress: 0, pendingTurns: 0, state: "idle" });
}

test("an agent's reply names other tasks by title, including one the dashboard no longer holds", async ({
  dashboard,
  daemon,
}) => {
  const live = await api<{ id: string }>(daemon, "/api/tasks", {
    repoRoot: daemon.repo,
    intent: "Create the verdict table.",
    title: LIVE_TITLE,
    backlog: true,
    workflowId: null,
  });
  const archivedId = seedArchivedTask(daemon, live.id, ARCHIVED_TITLE);
  const known = await api<Array<{ id: string }>>(daemon, "/api/tasks");
  expect(known.map((task) => task.id), "the dashboard's task list never hears of the seeded task")
    .not.toContain(archivedId);

  await dispatch(dashboard, daemon, "answer questions about the backlog");
  await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  const card = dashboard.locator(".console-detail");
  const reply = card.getByPlaceholder(/^Reply to this session/);
  await expect(reply).toBeEnabled();
  const [{ id: sessionId }] = await api<Array<{ id: string }>>(daemon, "/api/sessions");
  const assistant = (text: string): Locator =>
    card.locator(".turn-assistant").getByText(text, { exact: true });
  await expect(assistant("Mock reply to: answer questions about the backlog")).toBeVisible();
  await waitForDriverIdle(daemon, sessionId);

  const question = `Which tasks block you? ${live.id} and ${archivedId}`;
  await reply.fill(question);
  await reply.press("Enter");

  // The agent's words, with both ids shown as the titles a person knows the tasks by.
  const answered = assistant(`Mock reply to: Which tasks block you? "${LIVE_TITLE}" and "${ARCHIVED_TITLE}"`);
  await expect(answered).toBeVisible({ timeout: 20_000 });
  await waitForDriverIdle(daemon, sessionId);

  // An id written as a path names the task just the same - the dashboard has no task URLs -
  // while a checkout path keeps its id, so it still opens the file it names.
  const paths = `See /tasks/${archivedId} and /api/tasks/${live.id}/update in worktrees/${live.id}/notes.md`;
  await reply.fill(paths);
  await reply.press("Enter");
  await expect(assistant(
    `Mock reply to: See /tasks/"${ARCHIVED_TITLE}" and /api/tasks/"${LIVE_TITLE}"/update in worktrees/${live.id}/notes.md`,
  )).toBeVisible({ timeout: 20_000 });
  await waitForDriverIdle(daemon, sessionId);

  // A UUID in capitals is the same task: it is named, not shown.
  const shouted = `Is ${archivedId.toUpperCase()} done before ${live.id.toUpperCase()}?`;
  await reply.fill(shouted);
  await reply.press("Enter");
  await expect(assistant(`Mock reply to: Is "${ARCHIVED_TITLE}" done before "${LIVE_TITLE}"?`))
    .toBeVisible({ timeout: 20_000 });
  await waitForDriverIdle(daemon, sessionId);

  // However the id is dressed - a `task-` prefix included - it still names the task.
  const prefixed = `Task task-${live.id} is blocked by task_${archivedId}.`;
  await reply.fill(prefixed);
  await reply.press("Enter");
  await expect(assistant(`Mock reply to: Task task-"${LIVE_TITLE}" is blocked by task_"${ARCHIVED_TITLE}".`))
    .toBeVisible({ timeout: 20_000 });
  await waitForDriverIdle(daemon, sessionId);

  // Every reply on screen, the opener included, carries neither id outside that checkout path.
  const replies = (await card.locator(".turn-assistant").allInnerTexts()).join("\n")
    .replaceAll(`worktrees/${live.id}`, "worktrees/<checkout>")
    .toLowerCase();
  expect(replies).not.toContain(live.id);
  expect(replies).not.toContain(archivedId);
  // The human's own turn is theirs, and is shown exactly as they typed it.
  await expect(card.locator(".turn").getByText(question, { exact: true })).toBeVisible();

  await shoot(card, "conversation");
});

/** A live task, an archived one only the daemon knows, and an idle session to report from. */
async function reportingSession(dashboard: Page, daemon: DaemonHandle) {
  const live = await api<{ id: string }>(daemon, "/api/tasks", {
    repoRoot: daemon.repo,
    intent: "Create the verdict table.",
    title: LIVE_TITLE,
    backlog: true,
    workflowId: null,
  });
  const archivedId = seedArchivedTask(daemon, live.id, ARCHIVED_TITLE);
  await dispatch(dashboard, daemon, "report on the backlog");
  await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  const card = dashboard.locator(".console-detail");
  await expect(card.locator(".turn-assistant").first()).toBeVisible({ timeout: 30_000 });
  const session = await boundSession(daemon);
  await waitForDriverIdle(daemon, session.id);
  return { card, session, liveId: live.id, archivedId };
}

test("the status line an agent reports names tasks by title", async ({ dashboard, daemon }) => {
  const { card, session, liveId } = await reportingSession(dashboard, daemon);
  // What `report_status` posts, shown as the live row at the log's tail while the session works.
  await hook(daemon, session, "PreToolUse", { toolName: "Bash" });
  await mcp(daemon, "/mcp/status", { sessionId: session.id, activity: `Rebasing onto ${liveId}` }, 204);
  const progress = card.locator(".transcript-log .turn-progress");
  await expect(progress).toContainText(`Rebasing onto "${LIVE_TITLE}"`, { timeout: 15_000 });
  expect(await progress.innerText()).not.toContain(liveId);
  await shoot(card, "status-line");
});

test("the blocker an agent reports names tasks by title in every field", async ({ dashboard, daemon }) => {
  const { card, session, liveId, archivedId } = await reportingSession(dashboard, daemon);
  // What `report_blocker` posts.
  await mcp(daemon, "/mcp/blocker", {
    sessionId: session.id,
    kind: "dependency",
    reason: `Waiting for ${archivedId} to be reverted`,
    waitingOn: `whoever owns ${liveId}`,
    resumeWhen: `${liveId} merges`,
    details: `The schema in ${liveId} replaces the table ${archivedId} retired.`,
  }, 200);
  const band = card.getByRole("region", { name: "Session blocker" });
  const toggle = band.getByRole("button", { name: /^Blocked/ });
  await expect(toggle).toContainText(`Waiting for "${ARCHIVED_TITLE}" to be reverted`, { timeout: 15_000 });
  await toggle.click();
  await expect(band.getByText(`whoever owns "${LIVE_TITLE}"`, { exact: true })).toBeVisible();
  await expect(band.getByText(`"${LIVE_TITLE}" merges`, { exact: true })).toBeVisible();
  await band.getByText("Details", { exact: true }).click();
  await expect(band).toContainText(`The schema in "${LIVE_TITLE}" replaces the table "${ARCHIVED_TITLE}" retired.`);
  const shown = await band.innerText();
  for (const id of [liveId, archivedId]) expect(shown).not.toContain(id);
  await shoot(band, "blocker");
});

test("a question an agent asks names tasks by title in its title, question and options", async ({
  dashboard,
  daemon,
}) => {
  const { card, session, liveId, archivedId } = await reportingSession(dashboard, daemon);
  // What `request_input` posts.
  const question = `Should ${liveId} wait for ${archivedId}?`;
  await mcp(daemon, "/mcp/reviews", {
    cwd: session.cwd,
    kind: "input",
    title: question,
    body: question,
    decisions: [{
      id: "q",
      question,
      options: [
        { id: "wait", label: `Wait for ${archivedId}`, detail: `Holds ${liveId} back.` },
        { id: "go", label: `Ship ${liveId} now` },
      ],
    }],
  }, 200);
  await card.getByRole("button", { name: "to review" }).click();
  const modal = dashboard.getByRole("dialog", { name: "Review request" });
  await expect(modal).toBeVisible();
  await expect(modal.getByRole("group", { name: `Should "${LIVE_TITLE}" wait for "${ARCHIVED_TITLE}"?` }))
    .toBeVisible();
  await expect(modal.getByRole("radio", { name: new RegExp(`^Wait for "${ARCHIVED_TITLE}"`) })).toBeVisible();
  await expect(modal.getByRole("radio", { name: new RegExp(`^Ship "${LIVE_TITLE}" now`) })).toBeVisible();
  await expect(modal).toContainText(`Holds "${LIVE_TITLE}" back.`);
  const shown = await modal.innerText();
  for (const id of [liveId, archivedId]) expect(shown).not.toContain(id);
  await shoot(modal, "question");
});

test("a choice that names a task by id beside one naming it by title shows two distinct titles", async ({
  dashboard,
  daemon,
}) => {
  const { card, session, liveId } = await reportingSession(dashboard, daemon);
  // Valid as the agent sent it: the two labels differ. Titled, they would read the same.
  const question = "Which one should ship first?";
  await mcp(daemon, "/mcp/reviews", {
    cwd: session.cwd,
    kind: "input",
    title: question,
    body: question,
    decisions: [{
      id: "q",
      question,
      options: [
        { id: "by-id", label: liveId },
        { id: "by-title", label: `"${LIVE_TITLE}"` },
      ],
    }],
  }, 200);
  await card.getByRole("button", { name: "to review" }).click();
  const modal = dashboard.getByRole("dialog", { name: "Review request" });
  const group = modal.getByRole("group", { name: question });
  await expect(group).toBeVisible();
  await expect(group.getByRole("radio", { name: `"${LIVE_TITLE}" (2)`, exact: true })).toBeVisible();
  await expect(group.getByRole("radio", { name: `"${LIVE_TITLE}"`, exact: true })).toBeVisible();
  expect(await modal.innerText()).not.toContain(liveId);
  await shoot(modal, "colliding-choices");

  // The choice is recorded by its option id, so picking the numbered one answers as itself.
  await group.getByRole("radio", { name: `"${LIVE_TITLE}" (2)`, exact: true }).check();
  await modal.getByRole("button", { name: "Submit" }).click();
  await expect(modal).toBeHidden();
  await expect.poll(async () => {
    const reviews = await api<Array<{ title: string; status: string; selections?: Array<{ selected: string[] }> | null }>>(
      daemon,
      "/api/reviews",
    );
    return reviews.find((review) => review.title === question)?.selections?.[0]?.selected ?? null;
  }).toEqual(["by-id"]);
});

/** Save a gitignored screenshot of `target` when evidence capture is on. */
async function shoot(target: Locator, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await target.page().mouse.move(0, 0);
  await target.screenshot({ path: `${EVIDENCE}${name}.png`, animations: "disabled" });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/conversation-task-titles/${name}.png`);
}

interface BoundSession {
  id: string;
  agent: string;
  agentSessionId: string | null;
  cwd: string | null;
}

async function boundSession(daemon: DaemonHandle): Promise<BoundSession> {
  let found: BoundSession | undefined;
  await expect.poll(async () => {
    found = (await api<BoundSession[]>(daemon, "/api/sessions")).find((s) => s.agentSessionId !== null && s.cwd);
    return Boolean(found);
  }, { timeout: 30_000, message: "the dispatched session binds a conversation" }).toBe(true);
  return found!;
}

const token = (daemon: DaemonHandle): string => readFileSync(join(daemon.home, "token"), "utf8").trim();

/** Post to the daemon route an agent's MCP tool posts to, as the agent's MCP child does. */
async function mcp(daemon: DaemonHandle, path: string, body: Record<string, unknown>, status: number): Promise<void> {
  const res = await fetch(`${daemon.baseURL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": token(daemon) },
    body: JSON.stringify({ env: {}, ...body }),
  });
  expect(res.status, `${path}: ${await res.clone().text()}`).toBe(status);
}

/** A real hook over the real ingest route, on the agent's own conversation id. */
async function hook(
  daemon: DaemonHandle,
  session: BoundSession,
  event: "PreToolUse" | "Stop",
  extra: Record<string, unknown> = {},
): Promise<void> {
  const res = await fetch(`${daemon.baseURL}/hooks/${event}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": token(daemon) },
    body: JSON.stringify({ agent: session.agent, sessionId: session.agentSessionId, cwd: session.cwd, env: {}, ...extra }),
  });
  expect(res.status, await res.clone().text()).toBe(204);
}
