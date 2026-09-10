import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Page } from "@playwright/test";

import { withDaemonDb } from "../fixtures/daemon-db.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { expect, test } from "../fixtures/test.ts";

/**
 * What a person sees when a Recurring Mission set to complete automatically finishes a run.
 *
 * The failure this covers was invisible from every other layer. Foreman concluded three
 * consecutive hourly runs of one mission and each task went `done` - and each agent stayed on
 * the fleet afterwards, holding its runtime and its whole context. One was still there more
 * than an hour and a half later, and one took a fresh prompt thirty-five minutes after its
 * conclusion, which reopened a run the operator had already watched finish.
 *
 * Only a browser against a real daemon can say the thing that actually matters here, because
 * the claim spans a route, a driver, an eviction and a card: the task reaches `done` AND the
 * session leaves the fleet, as one event rather than two. The `node:test` suite pins the
 * ledger's mechanics - the retry, the restart, the refusal - where a case costs milliseconds;
 * this pins the boundary the operator experiences.
 *
 * The dispatch is a real SDK-runtime session with a real child process, which is the runtime
 * an approval mission actually runs on. NO MODEL TOKENS ARE SPENT: every agent binary is
 * redirected at `e2e/fixtures/fake-agents.ts`, as everywhere in this suite.
 */

const AUTO_INTENT = "Read the approval queue and act on whatever is waiting";
const MANUAL_INTENT = "Read the review queue and leave the decision to a person";

interface StoredSchedule {
  id: string;
  name: string;
  completionPolicy: string | null;
}

interface TaskSnapshot {
  id: string;
  title: string;
  intent: string;
  status: string;
  outcome: string | null;
  sessionId: string | null;
  completedAt: number | null;
}

interface SessionSnapshot {
  id: string;
  agent: string;
  agentSessionId: string | null;
  cwd: string;
  state: string;
  workCycle: { logicalKey: string; generation: number; active: boolean; completedAt: number | null } | null;
}

async function api<T>(
  daemon: DaemonHandle,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: init?.method ?? (init?.body === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json" },
    ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

/** Save a mission, run it once now, and hand back the backlog task that run filed. */
async function fileOneRun(
  daemon: DaemonHandle,
  name: string,
  intent: string,
  completionPolicy: "auto-on-conclusion" | "manual",
): Promise<TaskSnapshot> {
  const mission = await api<StoredSchedule>(daemon, "/api/schedules", {
    body: {
      name,
      // Hourly, which is the cadence the reported failure ran on - and the reason a session
      // that outlives its own next occurrence matters at all.
      expression: "0 * * * *",
      timezone: "UTC",
      overlapPolicy: "skip-active",
      missedPolicy: "coalesce-latest",
      completionPolicy,
      template: { title: name, intent, repoRoot: daemon.repo, kind: "ship" },
    },
  });
  expect(mission.completionPolicy).toBe(completionPolicy);

  await api(daemon, `/api/schedules/${mission.id}/run-now`, { body: {} });
  const filed = await pollTask(daemon, intent, (task) => task.status === "backlog");
  // Pinned to no post-work Workflow, exactly as the Dispatch modal's "finish without a
  // Workflow" does. Left on the daemon's default the dispatch is refused in this fixture,
  // and this spec is about what happens AFTER a run concludes, not about workflow policy.
  await api(daemon, `/api/tasks/${filed.id}/update`, { body: { workflowId: null } });
  return filed;
}

async function pollTask(
  daemon: DaemonHandle,
  intent: string,
  ready: (task: TaskSnapshot) => boolean,
  timeout = 60_000,
): Promise<TaskSnapshot> {
  let last: TaskSnapshot | undefined;
  await expect
    .poll(
      async () => {
        last = (await api<TaskSnapshot[]>(daemon, "/api/tasks")).find((t) => t.intent === intent);
        return last ? ready(last) : false;
      },
      { message: `the mission task never reached the expected state: ${intent}`, timeout },
    )
    .toBe(true);
  return last!;
}

/** The live session running a task, once the daemon has bound one to it. */
async function sessionForTask(daemon: DaemonHandle, taskId: string): Promise<SessionSnapshot> {
  let bound: SessionSnapshot | undefined;
  await expect
    .poll(
      async () => {
        const task = (await api<TaskSnapshot[]>(daemon, "/api/tasks")).find((t) => t.id === taskId);
        if (!task?.sessionId) return null;
        bound = (await api<SessionSnapshot[]>(daemon, "/api/sessions")).find(
          (s) => s.id === task.sessionId,
        );
        return bound?.agentSessionId ?? null;
      },
      { message: "the dispatched mission run never bound a session", timeout: 60_000 },
    )
    .not.toBeNull();
  return bound!;
}

/**
 * End the agent's turn and record Foreman's own settled verdict against that generation.
 *
 * The real route, with the real consumption guards, because a hook that is not reached from
 * `POST /api/sessions/:id/queue/wrapup/prompted` is a feature that exists only in a test.
 * `empty` is the verdict the reported failure carried on all three runs: the session changed
 * nothing, so there is nothing to commit, push or open a pull request for.
 *
 * Retried rather than sent once, and the retry is the honest shape here. The daemon refuses a
 * consumption whose generation, resolved objective or report bucket has moved on since the
 * caller read them, and a freshly dispatched session settles all three asynchronously - the
 * conversation id, the goal's resolved revision and the completed cycle do not land on one
 * tick. So every attempt re-reads all of them, which is what Foreman itself does.
 */
async function concludeRun(daemon: DaemonHandle, session: SessionSnapshot): Promise<void> {
  const token = readFileSync(join(daemon.home, "token"), "utf8").trim();
  const stop = await fetch(`${daemon.baseURL}/hooks/Stop`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": token },
    body: JSON.stringify({
      agent: session.agent,
      sessionId: session.agentSessionId,
      cwd: session.cwd,
      env: {},
    }),
  });
  expect(stop.status, await stop.clone().text()).toBe(204);

  let refusal = "the verdict was never attempted";
  await expect
    .poll(
      async () => {
        const current = (await api<SessionSnapshot[]>(daemon, "/api/sessions")).find(
          (s) => s.id === session.id,
        );
        const cycle = current?.workCycle;
        if (!cycle || cycle.active || cycle.completedAt === null) {
          refusal = `the work cycle has not settled: ${JSON.stringify(cycle)}`;
          return 0;
        }
        const goal = await api<{
          objective: string;
          objectiveVersion: number;
          promptRevision: number;
          resolvedPromptRevision: number;
          relationship: string | null;
        }>(daemon, `/api/sessions/${session.id}/goal`);
        if (goal.resolvedPromptRevision !== goal.promptRevision || !goal.relationship) {
          refusal = `the objective has not resolved: ${JSON.stringify(goal)}`;
          return 0;
        }
        const response = await fetch(
          `${daemon.baseURL}/api/sessions/${session.id}/queue/wrapup/prompted`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              logicalKey: cycle.logicalKey,
              generation: cycle.generation,
              expectedIntent: {
                objective: goal.objective,
                objectiveVersion: goal.objectiveVersion,
                promptRevision: goal.promptRevision,
                episodeKey: `intent:${goal.objectiveVersion}:${goal.promptRevision}`,
              },
              decision: { outcome: "empty", summary: "the session changed nothing", gaps: [] },
            }),
          },
        );
        refusal = `${response.status}: ${await response.text()}`;
        return response.status;
      },
      {
        message: () => `Foreman's verdict was never accepted - last answer was ${refusal}`,
        timeout: 90_000,
      },
    )
    .toBe(200);
}

/** Whether the daemon still owes this task's session a close. */
function owedClosure(daemon: DaemonHandle, taskId: string): boolean {
  return withDaemonDb(daemon, (db) =>
    db.prepare(`SELECT task_id FROM task_session_closures WHERE task_id = ?`).get(taskId) !==
      undefined);
}

function railRows(page: Page) {
  return page.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row");
}

/** Open the Sitrep panel, re-pressing until the fleet-scoped chord is actually bound. */
async function openSitrep(page: Page) {
  await expect(page.getByRole("button", { name: "Dispatch" })).toBeVisible({ timeout: 60_000 });
  await expect(async () => {
    await page.keyboard.press("Shift+P");
    await expect(page.getByRole("dialog", { name: "Sitrep" })).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 60_000 });
  return page.getByRole("dialog", { name: "Sitrep" });
}

test("a concluded recurring mission run takes its agent off the fleet with it", async ({
  dashboard,
  daemon,
}) => {
  test.setTimeout(300_000);
  const filed = await fileOneRun(daemon, "Hourly approval sweep", AUTO_INTENT, "auto-on-conclusion");

  await api(daemon, `/api/tasks/${filed.id}/dispatch`, { body: {} });
  const session = await sessionForTask(daemon, filed.id);
  // The half that used to be permanent: the mission's agent is on the fleet, and a person can
  // see it there.
  await expect(railRows(dashboard).filter({ hasText: "Hourly approval sweep" })).toHaveCount(1, {
    timeout: 60_000,
  });

  await concludeRun(daemon, session);

  const done = await pollTask(daemon, AUTO_INTENT, (task) => task.status === "done");
  expect(done.outcome).toMatch(/^Foreman concluded this recurring mission run: /);
  expect(done.completedAt).not.toBeNull();

  // The whole point, and the assertion the reported failure would not have passed: the card
  // goes with the completion. The published guarantee is four minutes from the completion
  // instant on the row, so that is the budget this waits within rather than a round number.
  const budget = done.completedAt! + 240_000 - Date.now();
  expect(budget).toBeGreaterThan(0);
  await expect(railRows(dashboard)).toHaveCount(0, { timeout: budget });
  expect(
    (await api<SessionSnapshot[]>(daemon, "/api/sessions")).some((s) => s.id === session.id),
    "no live session may answer to the concluded run's id",
  ).toBe(false);
  expect(owedClosure(daemon, filed.id), "and the daemon owes nothing further").toBe(false);

  // Nothing was resurrected on the way through: the finished run is on the board as an
  // outcome, still carrying Foreman's own sentence about why it ended.
  const sitrep = await openSitrep(dashboard);
  const row = sitrep.locator(".report-row", { hasText: "Hourly approval sweep" });
  await expect(row).toContainText("done");
  await expect(row).toContainText("Foreman concluded this recurring mission run");
});

test("a mission left on manual keeps its agent, because nothing concluded its run", async ({
  dashboard,
  daemon,
}) => {
  test.setTimeout(300_000);
  const filed = await fileOneRun(daemon, "Hourly review sweep", MANUAL_INTENT, "manual");

  await api(daemon, `/api/tasks/${filed.id}/dispatch`, { body: {} });
  const session = await sessionForTask(daemon, filed.id);
  await expect(railRows(dashboard).filter({ hasText: "Hourly review sweep" })).toHaveCount(1, {
    timeout: 60_000,
  });

  // The same verdict, on the same route, against a mission whose runs are meant to be read by
  // a person. A decision Foreman produced is not on its own permission to end anything.
  await concludeRun(daemon, session);

  const still = await pollTask(daemon, MANUAL_INTENT, (task) => task.sessionId === session.id);
  expect(still.status).toBe("running");
  expect(owedClosure(daemon, filed.id)).toBe(false);
  // Given time to have gone if it were going to: the session is still the operator's.
  await dashboard.waitForTimeout(5_000);
  await expect(railRows(dashboard).filter({ hasText: "Hourly review sweep" })).toHaveCount(1);
  expect(
    (await api<SessionSnapshot[]>(daemon, "/api/sessions")).some((s) => s.id === session.id),
  ).toBe(true);
});
