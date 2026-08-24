import { mkdirSync, readFileSync } from "node:fs";

import type { Locator, Page } from "@playwright/test";

import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { expect, test } from "../fixtures/test.ts";

// A plan session in repository A files implementation work in repository B.
//
// The route, dependency edge, SSE update, Board card, and editor are all real. Every agent
// process is the shared fake, so launching the plan session spends no model tokens. Invalid
// selectors are driven through the same authenticated write boundary and must leave no card.

test.use({ daemonEnv: { MC_E2E_TWIN_REPOS: "1" } });

const EVIDENCE = artifactsDir("cross-repo-plan-tasks");
const B_ONLY = "Implement the renderer in repository B";
const A_AND_B = "Implement the shared contract across A and B";

interface TaskRow {
  id: string;
  title: string;
  repoRoot: string;
  extraRepos: Array<{ repoRoot: string }>;
}

interface SessionRow {
  id: string;
  cwd: string;
  state: string;
  agentSessionId: string | null;
  hooksSeen: boolean;
  task: { id: string } | null;
}

async function json<T>(response: Response, context: string): Promise<T> {
  const body = await response.text();
  if (!response.ok) throw new Error(`${context} answered ${response.status}: ${body}`);
  return JSON.parse(body) as T;
}

async function enablePlanningSkills(daemon: DaemonHandle): Promise<void> {
  const response = await fetch(`${daemon.baseURL}/api/skills/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: true, skills: { "html-plans": true, "phased-plan": true } }),
  });
  expect(response.ok, "the planning skills should be enabled before the plan dispatch").toBe(true);
}

async function launchPlanSession(daemon: DaemonHandle): Promise<SessionRow> {
  const response = await fetch(`${daemon.baseURL}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      repoRoot: daemon.repo,
      title: "Plan work across repositories",
      intent: "Plan the repository B implementation from repository A.",
      kind: "plan",
      agent: "claude",
      workflowId: null,
      backlog: false,
    }),
  });
  const task = await json<TaskRow>(response, "plan dispatch");

  let session: SessionRow | undefined;
  await expect.poll(async () => {
    const sessions = await json<SessionRow[]>(
      await fetch(`${daemon.baseURL}/api/sessions`),
      "session list",
    );
    session = sessions.find((candidate) => candidate.task?.id === task.id);
    return session
      ? [
          session.agentSessionId !== null,
          session.hooksSeen,
          session.task?.id === task.id,
          session.state !== "exited",
        ]
      : null;
  }, { timeout: 60_000, message: "the fake plan agent should establish its repository A session" })
    .toEqual([true, true, true, true]);
  return session!;
}

async function createTask(
  daemon: DaemonHandle,
  session: SessionRow,
  body: Record<string, unknown>,
): Promise<Response> {
  const token = readFileSync(`${daemon.home}/token`, "utf8").trim();
  return fetch(`${daemon.baseURL}/mcp/v2/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": token },
    body: JSON.stringify({
      env: {},
      sessionId: session.id,
      cwd: session.cwd,
      repoRoot: session.cwd,
      intent: "Read the published phase files and implement only this phase.",
      dependsOnTaskIds: [],
      dependsOnCurrentSession: true,
      ...body,
    }),
  });
}

async function useBoardLayout(page: Page, daemon: DaemonHandle): Promise<void> {
  const response = await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ layout: "board" }),
  });
  expect(response.ok, "the daemon should accept the Board layout").toBe(true);
  await page.reload();
  await expect(page.locator("main.board")).toBeVisible();
}

async function openEditor(page: Page, title: string): Promise<Locator> {
  const card = page.locator(".bl-card", { hasText: title });
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: title, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Edit a backlog task" });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function shoot(page: Page, target: Locator, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await target.screenshot({ path: `${EVIDENCE}${name}.png`, animations: "disabled" });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/cross-repo-plan-tasks/${name}.png`);
}

test("a plan session creates dependency-gated B and A+B backlog cards", async ({
  dashboard,
  daemon,
}) => {
  await enablePlanningSkills(daemon);
  const planning = await launchPlanSession(daemon);

  const bOnly = await createTask(daemon, planning, {
    title: B_ONLY,
    targetRepository: daemon.secondRepo,
  });
  const bTask = await json<TaskRow>(bOnly, "repository B task creation");
  expect(bTask.repoRoot).toBe(daemon.secondRepo);
  expect(bTask.extraRepos).toEqual([]);

  const spanning = await createTask(daemon, planning, {
    title: A_AND_B,
    targetRepository: "second-repo",
    additionalRepositories: ["demo-repo"],
  });
  const spanningTask = await json<TaskRow>(spanning, "A+B task creation");
  expect(spanningTask.repoRoot).toBe(daemon.secondRepo);
  expect(spanningTask.extraRepos.map((entry) => entry.repoRoot)).toEqual([daemon.repo]);

  const invalid = await createTask(daemon, planning, {
    title: "Invalid selector must not appear",
    targetRepository: "not-a-local-repository",
  });
  expect(invalid.status).toBe(400);
  expect(await invalid.text()).toContain("use an absolute repository path");

  const ambiguous = await createTask(daemon, planning, {
    title: "Ambiguous selector must not appear",
    targetRepository: "shared-lib",
  });
  expect(ambiguous.status).toBe(409);
  const ambiguity = await ambiguous.text();
  expect(ambiguity).toContain("ambiguous");
  for (const candidate of daemon.twinRepos ?? []) expect(ambiguity).toContain(candidate);

  const tasks = await json<TaskRow[]>(await fetch(`${daemon.baseURL}/api/tasks`), "task list");
  expect(tasks.filter((task) => [B_ONLY, A_AND_B].includes(task.title))).toHaveLength(2);
  expect(tasks.some((task) => task.title.includes("selector must not appear"))).toBe(false);

  await useBoardLayout(dashboard, daemon);
  const bCard = dashboard.locator(".bl-card", { hasText: B_ONLY });
  await expect(bCard.getByRole("button", { name: "waiting for dependencies" })).toBeVisible();
  const spanningCard = dashboard.locator(".bl-card", { hasText: A_AND_B });
  await expect(spanningCard.getByText("2 repos", { exact: true })).toBeVisible();
  await expect(spanningCard.getByRole("button", { name: "waiting for dependencies" })).toBeVisible();
  await shoot(
    dashboard,
    dashboard.locator("section.board-backlog"),
    "dependency-gated-cross-repo-cards",
  );

  const bEditor = await openEditor(dashboard, B_ONLY);
  await expect(bEditor.getByPlaceholder("search repos or type a path…")).toHaveValue(daemon.secondRepo);
  await dashboard.keyboard.press("Escape");
  await expect(bEditor).toBeHidden();

  const spanningEditor = await openEditor(dashboard, A_AND_B);
  await expect(spanningEditor.getByPlaceholder("search repos or type a path…"))
    .toHaveValue(daemon.secondRepo);
  await expect(spanningEditor.getByRole("button", { name: `Detach repo: ${daemon.repo}` }))
    .toBeVisible();
  await expect(dashboard.getByText("Invalid selector must not appear")).toHaveCount(0);
  await expect(dashboard.getByText("Ambiguous selector must not appear")).toHaveCount(0);
  await shoot(dashboard, spanningEditor, "b-primary-with-a-attached");
});
