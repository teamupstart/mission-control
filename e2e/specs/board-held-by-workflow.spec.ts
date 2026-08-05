import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import type { Page } from "@playwright/test";

const EVIDENCE = fileURLToPath(new URL("../../docs/evidence/board-held/", import.meta.url));

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
  console.log(`CAPTURED docs/evidence/board-held/${name}.png`);
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
    .toContainText("it sends the next round on its own");

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
