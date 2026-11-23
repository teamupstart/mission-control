import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Locator, Page } from "@playwright/test";

import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import { handOver, hasTmux, PANE_AGENT_DAEMON, paneSession, sessionIdle, startPaneAgent } from "../fixtures/pane-agent.ts";
import { expect, test } from "../fixtures/test.ts";

/**
 * Task shaping's route stage, from the Dispatch button to the after-work prompt.
 *
 * A selector and a router are real `command` processes (`e2e/fixtures/fake-shaper.mjs`). The
 * router routes one skill for during the work and one for after it. The worker's first prompt
 * carries "Skills for this task" after the task context; once the work is submitted to a
 * workflow, Mission Control itself prompts the after-work skill, which reaches the session as a
 * later user turn led by its invocation; and the context viewer lists both skills and says the
 * after-work one was prompted.
 *
 * No model tokens: the agent is the suite's fake Claude, and both shapers answer from a script.
 */

const SHAPER = fileURLToPath(new URL("../fixtures/fake-shaper.mjs", import.meta.url));
const EVIDENCE = artifactsDir("task-shaping-route");

async function shoot(page: Page, name: string, target?: Locator): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await (target ?? page).screenshot({ path: `${EVIDENCE}${name}.png`, animations: "disabled" });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/task-shaping-route/${name}.png`);
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

/** The flag on, and one enabled `command` shaper per entry. Registration stores each off, so each is switched on. */
async function registerShapers(daemon: DaemonHandle, shapers: Array<{ id: string; label: string; stage: string; args: string[] }>): Promise<void> {
  await api(daemon, "/api/feature-flags", { kind: "flag", id: "task-shaping", enabled: true }, "PUT");
  await api(daemon, "/api/shaping", { kind: "settings", limits: { deadlineMs: 60_000 } }, "PUT");
  for (const shaper of shapers) {
    await api(daemon, "/api/shaping", {
      kind: "upsert",
      shaper: {
        id: shaper.id, label: shaper.label, stage: shaper.stage, timeoutMs: 30_000,
        transport: { type: "command", command: process.execPath, args: [SHAPER, ...shaper.args] },
      },
    }, "PUT");
    await api(daemon, "/api/shaping", { kind: "enable", id: shaper.id, enabled: true }, "PUT");
  }
}

/** Every user turn the fake Claude recorded under this daemon's home, in the order it wrote them. */
function recordedUserTurns(daemon: DaemonHandle): string[] {
  const root = join(daemon.home, ".claude", "projects");
  if (!existsSync(root)) return [];
  const turns: string[] = [];
  for (const project of readdirSync(root)) {
    for (const file of readdirSync(join(root, project)).filter((name) => name.endsWith(".jsonl"))) {
      for (const line of readFileSync(join(root, project, file), "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line) as { type?: string; message?: { content?: unknown } };
          if (record.type !== "user") continue;
          const content = record.message?.content;
          turns.push(typeof content === "string" ? content : JSON.stringify(content));
        } catch {
          // A line still being written; the next poll reads it whole.
        }
      }
    }
  }
  return turns;
}

/** A published workflow that ends as soon as the session submits: the after-work step, and nothing more. */
async function publishedWorkflow(daemon: DaemonHandle): Promise<string> {
  const created = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", {
    name: "Finish",
    bindingDefaults: { triggerMode: "manual", deliveryMode: "preview", maxRepairRounds: 1 },
    draft: {
      nodes: [
        { id: "session", kind: "session", position: { x: 0, y: 0 } },
        { id: "end", kind: "end", outcome: "Complete", position: { x: 220, y: 0 } },
      ],
      edges: [{ id: "complete", source: "session", sourcePort: "submitted", target: "end", targetPort: "terminal" }],
    },
  });
  const published = await api<{ version: { id: string } }>(daemon, `/api/workflows/${created.workflow.id}/publish`, { expectedDraftRevision: 1 });
  return published.version.id;
}

test("a routed skill reaches turn one, the after-work skill is prompted once the work is submitted, and the viewer shows both", async ({ dashboard, daemon }) => {
  await registerShapers(daemon, [
    { id: "guidance-service", label: "Guidance service", stage: "select", args: ["ok"] },
    { id: "skill-router", label: "Skill router", stage: "route", args: ["route", "lint-fix:during,wrap-notes:after-work"] },
  ]);
  await api(daemon, "/api/ui/config", { layout: "console" }, "PUT");
  await dashboard.reload();
  await expect(dashboard.getByRole("button", { name: "Dispatch" })).toBeVisible();

  const title = "Retry the ledger sync";
  const intent = "Make the ledger sync retry safely.";
  await dashboard.getByRole("button", { name: "Dispatch" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await dashboard.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(intent);
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dialog.getByRole("button", { name: /^Backlog details/ }).click();
  await dialog.getByPlaceholder("summarized from the task if left blank").fill(title);
  const created = dashboard.waitForResponse((response) =>
    response.request().method() === "POST" && new URL(response.url()).pathname === "/api/tasks");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  const task = await (await created).json() as { id: string };
  await expect(dialog).toBeHidden();

  // Turn one: the task context, then "Skills for this task" naming each routed skill and when.
  const turnOne = () => recordedUserTurns(daemon).find((turn) => turn.includes(intent)) ?? "";
  await expect.poll(turnOne, { timeout: 60_000 }).toMatch(
    /Make the ledger sync retry safely\.[\s\S]*## Task context[\s\S]*## Skills for this task[\s\S]*- `\/lint-fix` - during the work: use this skill when it applies\.[\s\S]*- `\/wrap-notes` - after the work: do not use it yet\./,
  );
  // Nothing has prompted the after-work skill yet.
  expect(recordedUserTurns(daemon).some((turn) => turn.startsWith("/wrap-notes"))).toBe(false);

  let sessionId = "";
  await expect.poll(async () => {
    const current = (await api<Array<{ id: string; status: string; sessionId: string | null }>>(daemon, "/api/tasks"))
      .find((entry) => entry.id === task.id);
    sessionId = current?.status === "running" ? current.sessionId ?? "" : "";
    return sessionId;
  }, { timeout: 60_000 }).not.toBe("");
  await expect.poll(async () => (await api<Array<{ id: string; state: string }>>(daemon, "/api/sessions"))
    .find((session) => session.id === sessionId)?.state, { timeout: 60_000 }).toBe("idle");

  // The person submits the work to a workflow: its after-work step starts.
  const versionId = await publishedWorkflow(daemon);
  const binding = await api<{ id: string }>(daemon, "/api/workflow-bindings", {
    workflowVersionId: versionId, sessionId, deliveryMode: "preview", maxRepairRounds: 1,
  });
  await api(daemon, `/api/workflow-bindings/${binding.id}/submit`, { requestId: "e2e-task-shaping-route" });

  // Mission Control prompts it as a later user turn, led by the skill's invocation, once.
  const prompted = () => recordedUserTurns(daemon).filter((turn) => turn.startsWith("/wrap-notes"));
  await expect.poll(() => prompted().length, { timeout: 60_000 }).toBe(1);
  const turns = recordedUserTurns(daemon);
  expect(turns.findIndex((turn) => turn.startsWith("/wrap-notes"))).toBeGreaterThan(turns.findIndex((turn) => turn.includes(intent)));
  expect(prompted()[0]).toContain("The work is complete");
  expect(prompted()[0]).not.toContain("lint-fix");

  // Task reads carry the skills and the prompt.
  await expect.poll(async () => (await api<{ afterWork: { state: string } | null }>(daemon, `/api/tasks/${task.id}/shaping`)).afterWork?.state,
    { timeout: 30_000 }).toBe("delivered");
  const read = (await api<Array<{ id: string; shaping?: { skills?: Array<{ name: string; state: string }> } }>>(daemon, "/api/tasks"))
    .find((entry) => entry.id === task.id);
  expect(read?.shaping?.skills?.map((skill) => [skill.name, skill.state])).toEqual([["lint-fix", "announced"], ["wrap-notes", "announced"]]);

  // The viewer: both skills, each with when, its router and its state, and the after-work one prompted.
  const rail = dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row", { hasText: title });
  await rail.click();
  const chip = dashboard.locator(".console-detail").getByRole("button", { name: "Context: 2 entries, 2 skills", exact: true });
  await expect(chip).toBeVisible({ timeout: 30_000 });
  await shoot(dashboard, "route-chip", dashboard.locator(".console-detail"));
  await chip.click();
  const viewer = dashboard.getByRole("dialog", { name: "Context this session received" });
  await expect(viewer).toBeVisible();
  const skills = viewer.getByRole("region", { name: "Skills for this task" });
  await expect(skills.getByRole("listitem", { name: "lint-fix: Announced" })).toContainText("during the work · routed by Skill router · not verified");
  const wrap = skills.getByRole("listitem", { name: "wrap-notes: Announced" });
  await expect(wrap).toContainText("after the work");
  await expect(wrap).toContainText("e2e/wrap-notes");
  await expect(wrap.getByRole("note")).toContainText(/^Prompted/);
  await expect(viewer.getByRole("region", { name: "Delivered in turn one" })).toContainText("## Skills for this task");
  await expectContentClearsBorder(viewer);
  await shoot(dashboard, "route-viewer", viewer);
  await viewer.getByRole("button", { name: "Close" }).click();
  await expect(viewer).toBeHidden();
});

interface ShapingRead { summary: { at: number; sessionId: string }; afterWork: { state: string; createdAt: number } | null }

/** The person submits the work: the after-work step starts. Returns the binding, removed before the next handover. */
async function submitWork(daemon: DaemonHandle, versionId: string, sessionId: string, requestId: string): Promise<string> {
  const binding = await api<{ id: string }>(daemon, "/api/workflow-bindings", {
    workflowVersionId: versionId, sessionId, deliveryMode: "preview", maxRepairRounds: 1,
  });
  await api(daemon, `/api/workflow-bindings/${binding.id}/submit`, { requestId });
  return binding.id;
}

test("an after-work prompt queued while task shaping is on is never delivered once the flag is turned off", async ({ daemon }) => {
  await registerShapers(daemon, [
    { id: "skill-router", label: "Skill router", stage: "route", args: ["route", "wrap-notes:after-work"] },
  ]);
  // Turn one stays open until this spec releases it, so the session is busy when the prompt is queued.
  const intent = "E2E_HOLD_TURN_UNTIL_RELEASED Tidy the retry worker's logging.";
  const task = await api<{ id: string }>(daemon, "/api/tasks", {
    repoRoot: daemon.repo, title: "Tidy logging", intent, kind: "ship", agent: "claude", workflowId: null,
  });
  let sessionId = "";
  await expect.poll(async () => {
    const current = (await api<Array<{ id: string; status: string; sessionId: string | null }>>(daemon, "/api/tasks"))
      .find((entry) => entry.id === task.id);
    sessionId = current?.status === "running" ? current.sessionId ?? "" : "";
    return sessionId;
  }, { timeout: 60_000 }).not.toBe("");
  await expect.poll(async () => (await api<Array<{ id: string; state: string }>>(daemon, "/api/sessions"))
    .find((session) => session.id === sessionId)?.state, { timeout: 60_000 }).toBe("working");
  await expect.poll(() => recordedUserTurns(daemon).some((turn) => turn.includes("## Skills for this task")), { timeout: 30_000 }).toBe(true);

  // A binding is keyed by the conversation (`noteKeyFor`), and one made before the agent reports
  // its conversation id is paused as `conversation_changed` the moment that id arrives, so the
  // submit below would meet an inactive binding. Wait for the id, as the idle waits elsewhere do.
  await expect.poll(async () => (await api<Array<{ id: string; agentSessionId: string | null }>>(daemon, "/api/sessions"))
    .find((session) => session.id === sessionId)?.agentSessionId ?? null, { timeout: 30_000 }).not.toBeNull();

  // The work is submitted while the turn is still running: the prompt waits in the outbox.
  const versionId = await publishedWorkflow(daemon);
  const binding = await api<{ id: string }>(daemon, "/api/workflow-bindings", {
    workflowVersionId: versionId, sessionId, deliveryMode: "preview", maxRepairRounds: 1,
  });
  await api(daemon, `/api/workflow-bindings/${binding.id}/submit`, { requestId: "e2e-route-flag-off" });
  const outbox = async () => (await api<Array<{ id: string; pendingTurns?: Array<{ id: string }> }>>(daemon, "/api/sessions"))
    .find((session) => session.id === sessionId)?.pendingTurns?.filter((turn) => turn.id.startsWith("shaping-after-work:")).length ?? 0;
  await expect.poll(async () => (await api<{ afterWork: { state: string } | null }>(daemon, `/api/tasks/${task.id}/shaping`)).afterWork?.state,
    { timeout: 30_000 }).toBe("queued");
  expect(await outbox()).toBe(1);

  // Task shaping is turned off, and then the turn ends and the session goes idle.
  await api(daemon, "/api/feature-flags", { kind: "flag", id: "task-shaping", enabled: false }, "PUT");
  writeFileSync(join(daemon.recordDir, "e2e-release-held-turn"), "");
  await expect.poll(async () => (await api<Array<{ id: string; state: string }>>(daemon, "/api/sessions"))
    .find((session) => session.id === sessionId)?.state, { timeout: 30_000 }).toBe("idle");
  // The outbox drops it rather than sending it, and the agent never receives it.
  await expect.poll(outbox, { timeout: 30_000 }).toBe(0);
  // Longer than the outbox's idle settle window, so a delivery would have landed by now.
  await new Promise((done) => setTimeout(done, 4_000));
  expect(recordedUserTurns(daemon).filter((turn) => turn.startsWith("/wrap-notes")), "nothing is delivered with the flag off").toEqual([]);
  // The record, read once the flag is back on, says why.
  await api(daemon, "/api/feature-flags", { kind: "flag", id: "task-shaping", enabled: true }, "PUT");
  const read = await api<{ afterWork: { state: string; reason: string | null } | null }>(daemon, `/api/tasks/${task.id}/shaping`);
  expect(read.afterWork).toMatchObject({ state: "not_delivered", reason: "Task shaping was turned off before the prompt was delivered." });
});

test.describe("handed over to a running agent", () => {
  // A discovered terminal agent is the only kind a task can be handed to; see `fixtures/pane-agent.ts`.
  test.use(PANE_AGENT_DAEMON);
  test.skip(!hasTmux(), "tmux is not installed on this machine");

  test("a task handed to the same agent twice gets its own after-work prompt for each launch", async ({ daemon }) => {
    await registerShapers(daemon, [
      { id: "skill-router", label: "Skill router", stage: "route", args: ["route", "wrap-notes:after-work"] },
    ]);
    const pane = startPaneAgent(daemon, { prefix: "mc-e2e-route", turns: true });
    try {
      const sessionId = await paneSession(daemon, pane);

      const intent = "Tidy the retry worker's logging.";
      const task = await api<{ id: string }>(daemon, "/api/tasks", {
        repoRoot: daemon.repo, title: "Tidy logging", intent, kind: "ship", agent: "claude", workflowId: null, backlog: true,
      });
      const versionId = await publishedWorkflow(daemon);
      const launches = () => pane.turns().filter((turn) => turn.includes(intent) && turn.includes("## Skills for this task"));
      const prompts = () => pane.turns().filter((turn) => turn.startsWith("/wrap-notes"));
      const shaping = () => api<ShapingRead>(daemon, `/api/tasks/${task.id}/shaping`);

      // Launch one, through the handover: turn one names the routed skill, and once the work is
      // submitted the after-work step prompts it.
      await handOver(daemon, task.id, sessionId);
      await expect.poll(() => launches().length, { timeout: 60_000 }).toBe(1);
      const first = (await shaping()).summary;
      expect(first.sessionId).toBe(sessionId);
      await sessionIdle(daemon, sessionId);
      const firstBinding = await submitWork(daemon, versionId, sessionId, "e2e-route-handover-1");
      await expect.poll(() => prompts().length, { timeout: 60_000 }).toBe(1);
      await expect.poll(async () => (await shaping()).afterWork?.state, { timeout: 30_000 }).toBe("delivered");

      // Back to the backlog and handed to the SAME agent again: a second launch into one session.
      await api(daemon, `/api/workflow-bindings/${firstBinding}`, undefined, "DELETE");
      await api(daemon, `/api/tasks/${task.id}/requeue`, {});
      await sessionIdle(daemon, sessionId);
      await handOver(daemon, task.id, sessionId);
      await expect.poll(() => launches().length, { timeout: 60_000 }).toBe(2);
      const second = (await shaping()).summary;
      expect(second.sessionId).toBe(sessionId);
      expect(second.at).toBeGreaterThan(first.at);
      expect((await shaping()).afterWork, "the earlier launch's prompt is not this launch's record").toBeNull();

      // Its own after-work prompt, after its own turn one, and recorded as its own.
      await sessionIdle(daemon, sessionId);
      await submitWork(daemon, versionId, sessionId, "e2e-route-handover-2");
      await expect.poll(() => prompts().length, { timeout: 60_000 }).toBe(2);
      const turns = pane.turns();
      const secondLaunch = turns.findLastIndex((turn) => turn.includes(intent) && turn.includes("## Skills for this task"));
      expect(turns.findLastIndex((turn) => turn.startsWith("/wrap-notes"))).toBeGreaterThan(secondLaunch);
      await expect.poll(async () => {
        const read = await shaping();
        return read.afterWork && read.afterWork.createdAt >= second.at ? read.afterWork.state : null;
      }, { timeout: 30_000 }).toBe("delivered");
    } finally {
      pane.cleanup();
    }
  });

  test("a handover back to the same agent whose record cannot be written shows no earlier context, even after a restart", async ({ dashboard, daemon }) => {
    await registerShapers(daemon, [
      { id: "guidance-service", label: "Guidance service", stage: "select", args: ["ok"] },
    ]);
    await api(daemon, "/api/ui/config", { layout: "console" }, "PUT");
    const pane = startPaneAgent(daemon, { prefix: "mc-e2e-stale-record", turns: true });
    try {
      const sessionId = await paneSession(daemon, pane);
      // A title no other spec's agent carries: discovery sees every tmux pane on the machine, and
      // a handover renames the session after its task.
      const title = "Refuse a stale handover record";
      const task = await api<{ id: string }>(daemon, "/api/tasks", {
        repoRoot: daemon.repo, title, intent: "Keep the ledger retry quiet.", kind: "ship", agent: "claude", workflowId: null, backlog: true,
      });
      const shapingRoute = async () => (await fetch(`${daemon.baseURL}/api/tasks/${task.id}/shaping`)).status;
      const taskRead = async () => (await api<Array<{ id: string; sessionId: string | null; shaping?: unknown }>>(daemon, "/api/tasks"))
        .find((entry) => entry.id === task.id);
      const detail = dashboard.locator(".console-detail");
      const contextChip = detail.getByRole("button", { name: /^Context/ });
      const openSession = async () => {
        await dashboard.reload();
        await expect(dashboard.getByRole("button", { name: "Dispatch" })).toBeVisible();
        await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row", { hasText: title }).click();
        await expect(detail).toContainText(title, { timeout: 30_000 });
      };

      // The first handover's context chip is shown for the session it reached.
      await handOver(daemon, task.id, sessionId);
      await expect.poll(shapingRoute, { timeout: 30_000 }).toBe(200);
      await openSession();
      await expect(contextChip).toBeVisible({ timeout: 30_000 });
      await shoot(dashboard, "same-session-handover-before", detail);

      // Back to the backlog, then handed to the SAME agent while SQLite refuses the new record.
      await api(daemon, `/api/tasks/${task.id}/requeue`, {});
      await sessionIdle(daemon, sessionId);
      withDaemonDb(daemon, (db) => db.exec(
        `CREATE TRIGGER e2e_refuse_shaping BEFORE UPDATE OF shaping ON tasks WHEN NEW.id = '${task.id}'
         BEGIN SELECT RAISE(ABORT, 'disk refused the shaping record'); END;`,
      ));
      await handOver(daemon, task.id, sessionId);
      // The earlier delivery's record is still on disk, naming this same session, under an id the
      // binding no longer carries. Nothing has cleared it.
      const row = withDaemonDb(daemon, (db) => db.prepare(
        `SELECT session_id, shaping_delivery, json_extract(shaping, '$.sessionId') AS recordSession,
                json_extract(shaping, '$.deliveryId') AS recordDelivery FROM tasks WHERE id = ?`,
      ).get(task.id) as { session_id: string; shaping_delivery: string; recordSession: string; recordDelivery: string });
      expect(row.session_id).toBe(sessionId);
      expect(row.recordSession, "the earlier record still names this session").toBe(sessionId);
      expect(row.shaping_delivery, "but the binding carries this delivery's id").not.toBe(row.recordDelivery);
      expect(await shapingRoute()).toBe(404);
      expect((await taskRead())?.shaping).toBeUndefined();
      await openSession();
      await expect(contextChip).toHaveCount(0);

      // The daemon restarts with nothing in memory and nothing left to retry.
      await daemon.crash();
      withDaemonDb(daemon, (db) => db.exec("DROP TRIGGER e2e_refuse_shaping"));
      await daemon.restart();
      await expect.poll(async () => (await api<Array<{ id: string }>>(daemon, "/api/sessions")).some((session) => session.id === sessionId),
        { timeout: 60_000 }).toBe(true);
      expect((await taskRead())?.sessionId).toBe(sessionId);
      expect(await shapingRoute(), "the route serves no earlier delivery's text").toBe(404);
      expect((await taskRead())?.shaping, "task reads carry no earlier record").toBeUndefined();
      await openSession();
      await expect(contextChip, "the session shows no earlier context chip").toHaveCount(0);
      await shoot(dashboard, "same-session-handover-after-restart", detail);
    } finally {
      pane.cleanup();
    }
  });
});
