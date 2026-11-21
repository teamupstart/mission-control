import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import type { Page } from "@playwright/test";

const EVIDENCE = artifactsDir("board-held");

/**
 * A picture of the split column, gated behind `MC_E2E_EVIDENCE` so an ordinary run does not
 * rewrite a binary for no added signal. Taken inside the regression test rather than in a
 * staged capture spec, because what makes the picture worth anything is that the assertions
 * around it passed on the same run.
 */
async function shoot(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  // Off every control first: `Tooltip` portals a bubble under a resting pointer.
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/board-held/${name}.png`);
}

/**
 * The board's idle column, split into the agents you can dispatch to and the ones an open
 * workflow run is holding.
 *
 * The bug this covers is one only a browser can see. A session bound to a live run finishes its
 * turn and goes `idle` - correctly, the agent really is doing nothing - so the board filed it
 * beside genuinely free agents and counted it as capacity. Every other layer would have said the
 * feature worked: `stateDisplay` returns `idle` and is right to, the run summary reaches the
 * browser and is right to, and each in isolation is exactly what it should be. It is only where
 * the two MEET, in a rendered column with a count on it, that "5 idle" is a lie.
 *
 * So the run here is real: dispatched agent, published workflow, bound, submitted, and polled
 * until the daemon parks it in a non-terminal status. Nothing is stubbed into the browser -
 * the section rule appears because an SSE frame said a run was open.
 *
 * The negative at the end is the half that would rot silently. A run that has FINISHED must
 * release its session back to `free`, and a spec that only ever asserted the held state would
 * pass forever against a board that never let anything go.
 */

async function api<T>(
  daemon: DaemonHandle,
  path: string,
  body?: unknown,
  method?: string,
): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as T;
}

/**
 * Dispatch one agent and wait for it to settle.
 *
 * `__none` on the workflow selector matters: the dispatch modal can arm a workflow itself, and
 * a run started that way would make the held state arrive before the test had said anything
 * about it. This spec binds its own run, explicitly, after the session is already idle.
 */
async function dispatchIdleAgent(page: Page, daemon: DaemonHandle, goal: string): Promise<string> {
  // Snapshot the fleet FIRST and wait for an id that was not in it. Matching on the goal text
  // instead looked plausible and silently returned the first session twice, because the daemon
  // does not necessarily echo the dispatch prompt back as `goal.text` - which made a two-agent
  // test assert against one agent listed twice.
  const before = new Set(
    (await api<Array<{ id: string }>>(daemon, "/api/sessions")).map((s) => s.id),
  );

  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(goal);
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();

  let sessionId = "";
  await expect.poll(async () => {
    const sessions = await api<Array<{ id: string; state: string }>>(daemon, "/api/sessions");
    const fresh = sessions.find((s) => !before.has(s.id) && s.state !== "exited");
    sessionId = fresh?.id ?? "";
    return fresh?.state ?? "";
  }, { timeout: 60_000 }).toBe("idle");
  return sessionId;
}

/** A session's current display name, which is what the tile's accessible name is built from. */
async function sessionName(daemon: DaemonHandle, id: string): Promise<string> {
  const sessions = await api<Array<{ id: string; name: string }>>(daemon, "/api/sessions");
  return sessions.find((s) => s.id === id)!.name;
}

/** Publish a one-reviewer workflow whose persona fails, so a submitted run parks and stays open. */
async function openRunOn(daemon: DaemonHandle, sessionId: string, label: string): Promise<string> {
  const persona = await api<{ id: string }>(daemon, "/api/personas", {
    name: `Holder ${label}`,
    // The fake agent answers this marker with a failing verdict, which returns the run to the
    // session and leaves it in `waiting_for_session` - open, and stable enough to assert against.
    guidanceMarkdown: `# Holder ${label}\n\nE2E_FAIL_VERDICT`,
  });
  const workflow = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", {
    name: `Holding ${label}`,
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
    daemon,
    `/api/workflows/${workflow.workflow.id}/publish`,
    { expectedDraftRevision: 1 },
  );
  const binding = await api<{ id: string }>(daemon, "/api/workflow-bindings", {
    workflowVersionId: published.version.id,
    sessionId,
    deliveryMode: "preview",
  });
  const submitted = await api<{ run: { id: string } }>(
    daemon,
    `/api/workflow-bindings/${binding.id}/submit`,
    { requestId: `e2e-held-${label}` },
  );
  await expect.poll(
    async () =>
      (await api<{ run: { status: string } }>(daemon, `/api/workflow-runs/${submitted.run.id}`))
        .run.status,
    { timeout: 60_000 },
  ).toBe("waiting_for_session");
  return submitted.run.id;
}

/**
 * Put the dashboard in the Board layout.
 *
 * Written to the daemon rather than `localStorage`, because the web store hydrates from
 * `GET /api/ui/config` at boot and overwrites the local cache. The reload is what makes it take.
 */
async function useBoardLayout(page: Page, daemon: DaemonHandle): Promise<void> {
  const response = await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ layout: "board" }),
  });
  const body = (await response.json()) as { config?: { layout?: string } };
  expect(body.config?.layout, "the daemon accepted the Board layout").toBe("board");
  await page.reload();
  await expect(page.locator("main.board")).toBeVisible();
}

test("the idle column separates the agents you can dispatch to from the ones a run holds", async ({
  dashboard,
  daemon,
}) => {
  const freeGoal = "stay free for the board";
  const heldGoal = "get held by a run";
  const free = await dispatchIdleAgent(dashboard, daemon, freeGoal);
  const held = await dispatchIdleAgent(dashboard, daemon, heldGoal);
  expect(free, "two distinct sessions").not.toBe(held);

  await useBoardLayout(dashboard, daemon);
  const idle = dashboard.locator("section.board-col.tone-idle");

  // Before any run exists, the column is one kind of thing and says so with one number.
  await expect(idle.locator(".board-col-n")).toHaveText(["2"]);
  await expect(idle.locator(".fleet-section")).toHaveCount(0);

  await openRunOn(daemon, held, "one");

  // The rule arrives over SSE, with no reload: the run summary landing is what splits the column.
  await expect(idle.locator(".fleet-section-held")).toBeVisible();
  await expect(idle.locator(".fleet-section-free")).toBeVisible();
  await expect(idle.locator(".fleet-section-held")).toContainText("held by a workflow");
  await expect(idle.locator(".fleet-section-held"))
    .toContainText("Open its run for the current step and available actions");

  // The count stops being a single number that means neither thing. This is the assertion the
  // whole change exists for: 2 sessions, and only 1 of them can take work.
  await expect(idle.locator(".board-col-n")).toHaveText(["1 free", "1 held"]);

  // Free above the rule, held below it - the order the arrow keys walk, since `orderSessions`
  // decides both. Identified by the tile's accessible name rather than by position alone, so
  // "the held one moved to the bottom" cannot pass by both tiles happening to be the same one.
  const tiles = idle.locator(".tile");
  await expect(tiles).toHaveCount(2);
  await expect(tiles.nth(0).locator(".tile-open"))
    .toHaveAttribute("aria-label", `Open ${await sessionName(daemon, free)}`);
  await expect(tiles.nth(1).locator(".tile-open"))
    .toHaveAttribute("aria-label", `Open ${await sessionName(daemon, held)}`);
  await expect(tiles.nth(0)).not.toHaveClass(/is-held/);
  await expect(tiles.nth(1)).toHaveClass(/is-held/);

  // And the held tile carries its own answer, for when the rule has scrolled off the top.
  await expect(tiles.nth(1).locator(".tile-held")).toHaveText("held");
  await expect(tiles.nth(0).locator(".tile-held")).toHaveCount(0);

  await shoot(dashboard, "idle-column-split");
});

test("At the top of Idle counts the blocked frame in a split idle header", async ({
  dashboard,
  daemon,
}) => {
  // The split head counts the Idle group's own free and held agents. With the Blocked frame drawn
  // at the top of Idle, its cards sit in the same column, so the head has to count them too or a
  // held agent beside them makes the frame vanish from the column's numbers.
  await dispatchIdleAgent(dashboard, daemon, "stay free beside the frame");
  const held = await dispatchIdleAgent(dashboard, daemon, "get held beside the frame");
  const blocked = await dispatchIdleAgent(dashboard, daemon, "get blocked into the frame");
  await openRunOn(daemon, held, "frame");
  const token = readFileSync(join(daemon.home, "token"), "utf8").trim();
  const reported = await fetch(`${daemon.baseURL}/mcp/blocker`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": token },
    body: JSON.stringify({
      env: {},
      sessionId: blocked,
      kind: "dependency",
      reason: "waiting on the platform migration",
      waitingOn: "the platform team",
      resumeWhen: "The migration merges",
    }),
  });
  expect(reported.status, await reported.clone().text()).toBe(200);

  await api(daemon, "/api/ui/config", { blockedPlacement: "idle" }, "PUT");
  await useBoardLayout(dashboard, daemon);
  const idle = dashboard.locator("section.board-col.tone-idle");
  const frame = idle.getByRole("group", { name: "Blocked" });
  await expect(frame.locator(".tile.is-blocked")).toHaveCount(1);
  await expect(idle.locator(".fleet-section-held")).toBeVisible();
  await expect(idle.locator(".board-col-head .board-col-n")).toHaveText(["1 blocked", "1 free", "1 held"]);

  await shoot(dashboard, "idle-split-with-blocked-frame");
});

test("a held tile refuses the backlog drop a free tile still offers", async ({
  dashboard,
  daemon,
}) => {
  // The drop is a reset: `dropTaskOnSession` hands the card over with `reset: true`, which
  // would yank a held agent out from under its run. `canAcceptTask` takes the tile's run for
  // exactly this reason, so the held tile must not light up, must not hint, and must not
  // accept - while its free neighbour keeps the whole affordance.
  await dispatchIdleAgent(dashboard, daemon, "stay free for the drop");
  const held = await dispatchIdleAgent(dashboard, daemon, "get held before the drop");
  await openRunOn(daemon, held, "drop");
  await api(daemon, "/api/tasks", {
    repoRoot: daemon.repo,
    title: "Hand me to someone",
    intent: "A card to drag at the idle column.",
    backlog: true,
  });

  await useBoardLayout(dashboard, daemon);
  const idle = dashboard.locator("section.board-col.tone-idle");
  await expect(idle.locator(".fleet-section-held")).toBeVisible();
  const card = dashboard.locator(".bl-card", { hasText: "Hand me to someone" });
  await expect(card).toBeVisible();

  // A real HTML5 dragstart with a real DataTransfer, so the drag runs exactly the handler a
  // person's drag runs - which tiles may accept is board STATE, and stubbing it would test
  // the stub.
  const dataTransfer = await dashboard.evaluateHandle(() => new DataTransfer());
  await card.dispatchEvent("dragstart", { dataTransfer });

  const tiles = idle.locator(".tile");
  await expect(tiles).toHaveCount(2);
  await expect(tiles.nth(0)).toHaveClass(/can-drop/);
  await expect(tiles.nth(0).locator(".tile-drop-hint")).toHaveText("↳ drop to hand this over");
  await expect(tiles.nth(1)).toHaveClass(/is-held/);
  await expect(tiles.nth(1)).not.toHaveClass(/can-drop/);
  await expect(tiles.nth(1).locator(".tile-drop-hint")).toHaveCount(0);

  // Ending the drag clears the one affordance that was offered.
  await card.dispatchEvent("dragend", { dataTransfer });
  await expect(idle.locator(".tile.can-drop")).toHaveCount(0);
});

test("the console rail draws the same rule, since the ordering it renders is shared", async ({
  dashboard,
  daemon,
}) => {
  // `orderSessions` sorts held sessions last within `idle` for EVERY layout, which is what keeps
  // the arrow keys and the screen agreeing. The rail therefore reorders whether or not it
  // explains itself, and an unexplained reorder is worse than none - so the rule follows the
  // ordering across the board's drill-in morph rather than living on the board alone.
  await dispatchIdleAgent(dashboard, daemon, "stay free for the rail");
  const held = await dispatchIdleAgent(dashboard, daemon, "get held for the rail");
  await openRunOn(daemon, held, "rail");

  const response = await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ layout: "console" }),
  });
  expect(((await response.json()) as { config?: { layout?: string } }).config?.layout).toBe("console");
  await dashboard.reload();

  const rail = dashboard.getByRole("navigation", { name: "Sessions" });
  await expect(rail).toBeVisible();
  await expect(rail.locator(".fleet-section-free")).toBeVisible();
  await expect(rail.locator(".fleet-section-held")).toContainText("held by a workflow");
  // The rail is denser than a board column, so it keeps the label and drops the sentence.
  await expect(rail.locator(".fleet-section-why")).toBeHidden();

  // The group count splits like the board head's - "idle 2" over one held agent reads as
  // two free ones - and the held ROW carries its own mark, because the rail scrolls the
  // section label away soonest of any surface.
  await expect(rail.locator(".rail-group-split .n-free")).toHaveText("1 free");
  await expect(rail.locator(".rail-group-split .n-held")).toHaveText("1 held");
  const heldRow = rail.locator(".rail-row.is-held");
  await expect(heldRow).toHaveCount(1);
  await expect(heldRow.locator(".rail-held")).toHaveText("held");

  await shoot(dashboard, "rail-held-split");

  // The board's drilled-in column is the SAME RailRow rendering at the same width, so it must
  // read the same way: label kept, sentence dropped. Reached by actually drilling in, because
  // the claim is about a surface a person arrives at, not about a selector.
  await useBoardLayout(dashboard, daemon);
  const idle = dashboard.locator("section.board-col.tone-idle");
  await expect(idle.locator(".fleet-section-why")).toBeVisible();
  // The click lands on the tile ROOT: the labelled `.tile-open` button is the keyboard half
  // of the open gesture and deliberately takes no pointer events.
  await idle.locator(".tile").first().click();
  const drilled = dashboard.locator("section.board-col.is-rail");
  await expect(drilled).toBeVisible();
  await expect(drilled.locator(".fleet-section-held")).toContainText("held by a workflow");
  await expect(drilled.locator(".fleet-section-why")).toBeHidden();
  // The drilled-in rows are the same RailRow, so the held row is marked here too.
  await expect(drilled.locator(".rail-row.is-held .rail-held")).toHaveText("held");
});

test("a run that reaches a terminal status releases its session back to free", async ({
  dashboard,
  daemon,
}) => {
  // The half that would rot unnoticed: `workflowRunIsOpen` is the only thing between "held" and
  // "free", and a board that never released anything would pass a held-only spec forever.
  const held = await dispatchIdleAgent(dashboard, daemon, "get held then released");
  const runId = await openRunOn(daemon, held, "two");

  await useBoardLayout(dashboard, daemon);
  const idle = dashboard.locator("section.board-col.tone-idle");
  await expect(idle.locator(".fleet-section-held")).toBeVisible();
  await expect(idle.locator(".board-col-n")).toHaveText(["1 held"]);
  // Every session in the column is held, so there is no free side and no rule labelling one.
  await expect(idle.locator(".fleet-section-free")).toHaveCount(0);

  await api(daemon, `/api/workflow-runs/${runId}/cancel`, { requestId: "e2e-release" });
  await expect
    .poll(
      async () =>
        (await api<{ run: { status: string } }>(daemon, `/api/workflow-runs/${runId}`)).run.status,
      { timeout: 30_000 },
    )
    .toBe("cancelled");

  // Closed run, released session: back to one count, no rules, no tag.
  await expect(idle.locator(".board-col-n")).toHaveText(["1"]);
  await expect(idle.locator(".fleet-section")).toHaveCount(0);
  await expect(idle.locator(".tile-held")).toHaveCount(0);
  await expect(idle.locator(".tile.is-held")).toHaveCount(0);
});

test("workflow hold details identify the next actor without creating a session blocker", async ({ dashboard, daemon }) => {
  const id = await dispatchIdleAgent(dashboard, daemon, "Explain my workflow hold");
  const runId = await openRunOn(daemon, id, "explanation");
  await useBoardLayout(dashboard, daemon);
  await expect(dashboard.getByLabel("Workflow holds")).toHaveCount(0);
  await api(daemon, "/api/feature-flags", { kind: "flag", id: "workflow-hold-details", enabled: true }, "PUT");
  const holds = dashboard.getByLabel("Workflow holds");
  await expect(holds).toContainText("Review feedback is ready in preview");
  await expect(holds).toContainText("Action needed · Operator");
  await expect(dashboard.locator(".fleet-section-held")).toContainText("See each session for who acts next.");
  await expect(holds.getByRole("link")).toHaveAttribute("href", `#/runs/${runId}`);
  await holds.getByRole("link").hover();
  await expect(dashboard.locator(".tooltip").filter({ hasText: "Open this workflow run" })).toBeVisible();
  const session = (await api<Array<{ id: string; blocker: unknown }>>(daemon, "/api/sessions")).find(s => s.id === id)!;
  expect(session.blocker ?? null).toBeNull();
  await shoot(dashboard, "hold-operator");
  await holds.getByRole("link").click();
  await expect(dashboard).toHaveURL(new RegExp(`/runs/${runId}`));
  await dashboard.goBack();
  await expect(holds).toContainText("Action needed · Operator");

  // An independent blocker survives workflow completion. Use the real MCP route and live SSE.
  const token = readFileSync(join(daemon.home, "token"), "utf8").trim();
  const response = await fetch(`${daemon.baseURL}/mcp/blocker`, {
    method: "POST", headers: { "content-type": "application/json", "x-harness-token": token },
    body: JSON.stringify({ env: {}, sessionId: id, kind: "dependency", reason: "Waiting for platform approval",
      waitingOn: "Platform team", resumeWhen: "Platform approves" }),
  });
  expect(response.status).toBe(200);
  await expect(dashboard.locator(".tile.is-blocked")).toContainText("Waiting for platform approval");
  await expect(holds).toContainText("Action needed · Operator");
  await api(daemon, `/api/workflow-runs/${runId}/cancel`, { requestId: "cancel-explanation" });
  await expect(holds).toHaveCount(0);
  await expect(dashboard.locator(".tile.is-blocked")).toContainText("Waiting for platform approval");
  expect((await api<Array<{ id: string; blocker: unknown }>>(daemon, "/api/sessions")).find(s => s.id === id)?.blocker).toBeTruthy();
});

test("Fleet renders distinct Inspector, sibling and automated waits from live summary updates", async ({ dashboard, daemon }) => {
  const id = await dispatchIdleAgent(dashboard, daemon, "Different workflow waits");
  const runId = await openRunOn(daemon, id, "states");
  await api(daemon, "/api/feature-flags", { kind: "flag", id: "workflow-hold-details", enabled: true }, "PUT");
  // Real initial snapshot, scripted subsequent summary frames: no real GitHub review or model call.
  await dashboard.addInitScript(() => {
    const Native = window.EventSource;
    window.EventSource = class extends Native {
      constructor(url: string | URL, options?: EventSourceInit) {
        super(url, options);
        if (String(url) === "/events") (window as Window & { holdStream?: EventSource }).holdStream = this;
      }
    };
  });
  await useBoardLayout(dashboard, daemon);
  const { summary } = await api<{ summary: import("../../src/shared/workflow.ts").WorkflowRunSummary }>(daemon, `/api/workflow-runs/${runId}`);
  const update = async (run: typeof summary) => dashboard.evaluate(message => {
    const stream = (window as Window & { holdStream: EventSource }).holdStream;
    stream.close();
    stream.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "workflow_run_upsert", run: message }) }));
  }, run);
  await update({ ...summary, status: "waiting_for_pr", phase: "inspector_unadopted_pr", gateWaitReason: "unadopted_pr" });
  const holds = dashboard.getByLabel("Workflow holds");
  await expect(holds).toContainText("has not adopted");
  await expect(holds).toContainText("Action needed · Operator");
  await update({ ...summary, id: "sibling-wait", repoRoot: "/repos/backend", deliveryHold: {
    runId, deliveryId: "owner-packet", repoRoot: "/repos/frontend", kind: "persona_feedback", state: "delivered",
  } });
  await expect(holds).toContainText("Queued behind frontend");
  await expect(holds.getByRole("link", { name: /Open owning run/ })).toHaveAttribute("href", `#/runs/${runId}`);
  await holds.getByRole("link", { name: /Open owning run/ }).hover();
  await expect(dashboard.locator(".tooltip").filter({ hasText: "Open the workflow run holding this session" })).toBeVisible();
  // Even a retained Inspector reason cannot override an active review's current phase.
  await update({ ...summary, id: "healthy-review", repoRoot: "/repos/tools", status: "running", phase: "persona_review",
    gateWaitReason: "findings", activePersonaNames: ["Test Auditor"] });
  await expect(holds).toContainText("Review in progress: Test Auditor");
  await expect(holds).toContainText("In progress · Workflow");
  await shoot(dashboard, "hold-distinct-reasons");
  await update({ ...summary, id: "sibling-wait", repoRoot: "/repos/backend", status: "completed" });
  await expect(holds).not.toContainText("Queued behind");
  await update({ ...summary, status: "waiting_for_inspector", phase: "inspector_review", gateWaitReason: "review_pending" });
  await expect(holds).toContainText("In progress · GitHub Inspector");
  await shoot(dashboard, "hold-automated-progress");

  // Stored reasons outside the known vocabulary must not masquerade as healthy work.
  const currentHold = holds.locator(`a[href="#/runs/${runId}"]`);
  await update({ ...summary, deliveryMode: "live", resumptionPolicy: "auto",
    resumption: { reason: "future_operator_wait", round: summary.round, resumesItself: true } });
  await expect(currentHold).toContainText("unrecognized resumption condition");
  await expect(currentHold).toContainText("Action needed · Operator");
  await expect(currentHold).not.toContainText("In progress");
  await update({ ...summary, deliveryMode: "live", resumptionPolicy: "auto",
    resumption: { reason: "binding_inactive", round: summary.round, resumesItself: true } });
  await expect(currentHold).toContainText("no longer attached to a live session");
  await expect(currentHold).toContainText("Action needed · Operator");
  await expect(currentHold).not.toContainText("Waiting · Session");
  await shoot(dashboard, "hold-exhaustive-wait-actors");

  // The independent blocker's owner is the next actor, not the waiting session.
  const token = readFileSync(join(daemon.home, "token"), "utf8").trim();
  const reported = await fetch(`${daemon.baseURL}/mcp/blocker`, {
    method: "POST", headers: { "content-type": "application/json", "x-harness-token": token },
    body: JSON.stringify({ env: {}, sessionId: id, kind: "dependency", reason: "Waiting for platform approval",
      waitingOn: "Platform team", resumeWhen: "Platform approves" }),
  });
  expect(reported.status).toBe(200);
  const blocked = (await api<import("../../src/shared/types.ts").Session[]>(daemon, "/api/sessions")).find(s => s.id === id)!;
  await dashboard.evaluate(session => {
    (window as Window & { holdStream: EventSource }).holdStream.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify({ type: "session_upsert", session }) }));
  }, blocked);
  await update({ ...summary, deliveryMode: "live", resumptionPolicy: "auto",
    resumption: { reason: "session_blocked", round: summary.round, resumesItself: true } });
  await expect(holds).toContainText("Waiting · Platform team");
  await expect(holds).not.toContainText("Waiting · Session");
  await shoot(dashboard, "hold-blocker-owner");
  await update({ ...summary, deliveryMode: "preview", resumptionPolicy: "auto",
    resumption: { reason: "session_blocked", round: summary.round, resumesItself: false } });
  await expect(holds).toContainText("Waiting · Platform team");
  await expect(holds).not.toContainText("Action needed · Operator");
  await shoot(dashboard, "hold-preview-blocker-owner");
  await dashboard.evaluate(session => {
    (window as Window & { holdStream: EventSource }).holdStream.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify({ type: "session_upsert", session: { ...session, blocker: null } }) }));
  }, blocked);
  await expect(holds).toContainText("Waiting · Blocker owner");
  expect((await api<import("../../src/shared/types.ts").Session[]>(daemon, "/api/sessions")).find(s => s.id === id)?.blocker)
    .toEqual(blocked.blocker);

  await update({ ...summary, status: "waiting_for_action", deliveryMode: "live", actionWait: "awaiting_send" });
  await expect(currentHold).toContainText("Next: Mission Control sends the authorized instruction");
  await expect(currentHold).toContainText("In progress · Workflow");
  await expect(currentHold).not.toContainText("In progress · Session");
  await shoot(dashboard, "hold-live-action-delivery");
  await update({ ...summary, status: "waiting_for_action", deliveryMode: "preview", actionWait: "awaiting_send" });
  await expect(holds).toContainText("The instruction is ready in preview; send it to the session from the run.");
  await expect(holds).toContainText("Action needed · Operator");
  await shoot(dashboard, "hold-preview-action");
  await update({ ...summary, status: "waiting_for_action", deliveryMode: "preview", actionWait: "awaiting_pickup" });
  await expect(holds).toContainText("Sent. Waiting for the session to pick the instruction up.");
  await expect(holds).not.toContainText("Action needed · Operator");
  await expect(holds).toContainText("In progress · Session");

  // A reconnect snapshot restores daemon truth; the same explanation appears in the Console rail.
  await api(daemon, "/api/ui/config", { layout: "console" }, "PUT");
  await dashboard.reload();
  await expect(holds).toContainText("Action needed · Operator");
  await shoot(dashboard, "hold-console");
  await api(daemon, "/api/feature-flags", { kind: "flag", id: "workflow-hold-details", enabled: false }, "PUT");
  await expect(holds).toHaveCount(0);
});
