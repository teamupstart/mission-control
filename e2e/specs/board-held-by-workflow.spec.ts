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

  await expect(idle.locator(".fleet-section-free .fleet-section-n")).toHaveText("1");
  await expect(idle.locator(".fleet-section-held .fleet-section-n")).toHaveText("1");
  await expect(idle.locator(".board-col-head").getByText(/\d+ (free|held)/)).toHaveCount(0);

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

test("At the top of Idle shows the blocked frame and the Idle section counts", async ({
  dashboard,
  daemon,
}) => {
  // Free and Held each show their own count alongside the Blocked frame at the top of Idle.
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
  await expect(idle.locator(".fleet-section-free .fleet-section-n")).toHaveText("1");
  await expect(idle.locator(".fleet-section-held .fleet-section-n")).toHaveText("1");
  await expect(idle.locator(".board-col-head .board-col-n")).toHaveText(["1 blocked"]);

  await shoot(dashboard, "idle-split-with-blocked-frame");

  await api(daemon, "/api/feature-flags", { kind: "flag", id: "idle-rail-section-counts", enabled: true }, "PUT");
  await frame.locator(".tile.is-blocked").click();
  await dashboard.setViewportSize({ width: 700, height: 800 });
  const rail = dashboard.locator("section.board-col.is-rail.tone-idle");
  const header = rail.locator("header");
  await expect(header.getByText("3 sessions", { exact: true })).toBeVisible();
  await expect(header.getByText("1 blocked", { exact: true })).toHaveCount(0);
  const blockedHeading = rail.getByRole("button", { name: "blocked 1", exact: true });
  const blockedRow = rail.getByRole("button", { name: await sessionName(daemon, blocked), exact: true });
  await expect(blockedHeading).toHaveAttribute("aria-expanded", "true");
  await expect(blockedRow).toHaveAttribute("aria-current", "true");
  await blockedHeading.click();
  await expect(blockedHeading).toHaveAttribute("aria-expanded", "false");
  await expect(blockedRow).toHaveCount(0);
  await shoot(dashboard, "idle-rail-blocked-collapsed");
  await blockedHeading.click();
  await expect(blockedRow).toBeVisible();
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
  await expect(idle.locator(".fleet-section-held .fleet-section-n")).toHaveText("1");
  await expect(idle.locator(".board-col-head").getByText(/\d+ held/)).toHaveCount(0);
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

test("the conversation Idle rail puts counts on expandable sections", async ({ dashboard, daemon }) => {
  const free = await dispatchIdleAgent(dashboard, daemon, "free for section counts");
  const held = await dispatchIdleAgent(dashboard, daemon, "held for section counts");
  const runId = await openRunOn(daemon, held, "section-counts");
  await useBoardLayout(dashboard, daemon);

  const idle = dashboard.locator("section.board-col.tone-idle");
  const freeName = await sessionName(daemon, free);
  await idle.locator(".tile").filter({ hasText: freeName }).click();
  const rail = dashboard.locator("section.board-col.is-rail.tone-idle");
  await expect(rail.locator("header")).toContainText("1 held");
  await dashboard.setViewportSize({ width: 700, height: 800 });

  const setSectionCounts = (enabled: boolean) => api(
    daemon, "/api/feature-flags", { kind: "flag", id: "idle-rail-section-counts", enabled }, "PUT",
  );
  await setSectionCounts(true);
  const header = rail.locator("header");
  await expect(header.getByText("2 sessions", { exact: true })).toBeVisible();
  await expect(header.getByText("1 held", { exact: true })).toHaveCount(0);
  await expect(header.getByRole("button", { name: "Back to the board" })).toBeInViewport();
  const freeSection = rail.getByRole("button", { name: "free 1", exact: true });
  const heldSection = rail.getByRole("button", { name: "held by a workflow 1", exact: true });
  await expect(freeSection).toHaveAttribute("aria-expanded", "true");
  await expect(heldSection).toHaveAttribute("aria-expanded", "false");
  await expect(rail.locator(".rail-row")).toHaveCount(1);
  await freeSection.focus();
  await dashboard.keyboard.press("Tab");
  await dashboard.keyboard.press("Tab");
  const detailBody = dashboard.locator(".cdetail .detail-body");
  const freeRow = rail.getByRole("button", { name: freeName, exact: true });
  await expect(freeRow).toBeFocused();
  await dashboard.keyboard.press("Tab");
  await expect(detailBody).toBeFocused();
  await dashboard.keyboard.press("Escape");
  await expect(freeRow).toBeFocused();
  // SDK sessions have no writable terminal pane. The mode shortcut still consumes the
  // key, keeping focus on the row instead of moving to the previous control.
  await freeRow.press("Shift+Tab");
  await expect(freeRow).toBeFocused();
  await expect(freeRow).toHaveAttribute("aria-keyshortcuts", "Home");
  await dashboard.keyboard.press("Home");
  await expect(freeSection).toBeFocused();
  await dashboard.keyboard.press("ArrowDown");
  await expect(heldSection).toBeFocused();
  await dashboard.keyboard.press("Enter");
  await expect(heldSection).toHaveAttribute("aria-expanded", "true");
  await dashboard.keyboard.press("Tab");
  await dashboard.keyboard.press("Tab");
  await expect(rail.locator(".rail-row.is-held")).toBeFocused();
  await dashboard.keyboard.press("Home");
  await expect(heldSection).toBeFocused();
  await shoot(dashboard, "idle-rail-section-counts");
  await heldSection.click();
  await expect(rail.locator(".rail-row.is-held")).toHaveCount(0);
  // Held follows Free in fleet order. Down would select the hidden held session if it
  // were still in the keyboard navigation list.
  await freeRow.press("ArrowDown");
  await expect(freeRow).toHaveAttribute("aria-current", "true");
  await expect(heldSection).toHaveAttribute("aria-expanded", "false");

  await header.getByRole("button", { name: "Back to the board" }).click();
  const heldName = await sessionName(daemon, held);
  await idle.getByRole("button", { name: `Open ${heldName}`, exact: true }).press("Enter");
  const heldRow = rail.getByRole("button", { name: heldName, exact: true });
  await expect(heldSection).toHaveAttribute("aria-expanded", "true");
  await expect(heldRow).toHaveAttribute("aria-current", "true");
  await shoot(dashboard, "idle-rail-reopened-held");
  await heldSection.click();
  await expect(heldSection).toHaveAttribute("aria-expanded", "false");
  await expect(heldRow).toHaveCount(0);
  await detailBody.focus();
  await dashboard.keyboard.press("Escape");
  await expect(heldSection).toBeFocused();
  await header.getByRole("button", { name: "Back to the board" }).click();
  await idle.getByRole("button", { name: `Open ${heldName}`, exact: true }).press("Enter");
  await expect(heldSection).toHaveAttribute("aria-expanded", "true");
  await expect(heldRow).toHaveAttribute("aria-current", "true");

  // A real workflow update moves the held session into Free over SSE.
  await heldRow.focus();
  await api(daemon, `/api/workflow-runs/${runId}/cancel`, { requestId: "section-counts-release" });
  await expect(rail.getByRole("button", { name: "free 2", exact: true })).toBeVisible();
  await expect(heldSection).toHaveCount(0);
  await expect(rail.locator(".rail-row")).toHaveCount(2);
  await expect(heldRow).toBeFocused();

  await setSectionCounts(false);
  await expect(header.getByText("2 sessions", { exact: true })).toHaveCount(0);
  await expect(rail.getByRole("button", { name: "free 2", exact: true })).toHaveCount(0);
});

for (const focused of ["row", "heading"] as const) {
  test(`the Idle rail focuses the destination heading when a focused ${focused} disappears`, async ({
    dashboard, daemon,
  }) => {
    const free = await dispatchIdleAgent(dashboard, daemon, "keep reading this free session");
    const held = await dispatchIdleAgent(dashboard, daemon, "move into the collapsed section");
    const run = await openRunOn(daemon, held, "collapsed-destination");
    await api(daemon, "/api/feature-flags", { kind: "flag", id: "idle-rail-section-counts", enabled: true }, "PUT");
    await useBoardLayout(dashboard, daemon);

    const freeName = await sessionName(daemon, free);
    const heldName = await sessionName(daemon, held);
    const idle = dashboard.locator("section.board-col.tone-idle");
    await idle.getByRole("button", { name: `Open ${freeName}`, exact: true }).press("Enter");
    const rail = dashboard.locator("section.board-col.is-rail.tone-idle");
    await rail.getByRole("button", { name: "free 1", exact: true }).click();
    const heldHeading = rail.getByRole("button", { name: "held by a workflow 1", exact: true });
    if (focused === "row") {
      await heldHeading.click();
      await rail.getByRole("button", { name: heldName, exact: true }).focus();
    } else {
      await heldHeading.focus();
    }

    await api(daemon, `/api/workflow-runs/${run}/cancel`, { requestId: "release-to-collapsed-section" });
    const targetHeading = rail.getByRole("button", { name: "free 2", exact: true });
    await expect(targetHeading).toHaveAttribute("aria-expanded", "false");
    await expect(targetHeading).toBeFocused();
    await expect(rail.getByRole("button", { name: heldName, exact: true })).toHaveCount(0);
    await expect(dashboard.locator(".cdetail .detail-head")).toContainText(freeName);
  });
}

test("the Idle rail scrolls a focused row into view after a live status move", async ({ dashboard, daemon }) => {
  const free = await dispatchIdleAgent(dashboard, daemon, "keep reading this free session");
  await dispatchIdleAgent(dashboard, daemon, "second free session");
  const held = await dispatchIdleAgent(dashboard, daemon, "alpha moved session");
  const run = await openRunOn(daemon, held, "scroll-destination");
  await api(daemon, "/api/feature-flags", { kind: "flag", id: "idle-rail-section-counts", enabled: true }, "PUT");
  await useBoardLayout(dashboard, daemon);

  const freeName = await sessionName(daemon, free);
  const heldName = await sessionName(daemon, held);
  const idle = dashboard.locator("section.board-col.tone-idle");
  await idle.getByRole("button", { name: `Open ${freeName}`, exact: true }).press("Enter");
  await dashboard.setViewportSize({ width: 700, height: 320 });
  const rail = dashboard.locator("section.board-col.is-rail.tone-idle");
  await rail.getByRole("button", { name: "held by a workflow 1", exact: true }).click();
  const row = rail.getByRole("button", { name: heldName, exact: true });
  const freeHeading = rail.getByRole("button", { name: "free 2", exact: true });
  await freeHeading.click();
  await row.focus();
  await expect(freeHeading).not.toBeInViewport({ ratio: 0.75 });
  await dashboard.locator(".cdetail .detail-body").focus();
  await dashboard.keyboard.press("Escape");
  await expect(freeHeading).toBeFocused();
  await expect(freeHeading).toBeInViewport({ ratio: 0.95 });
  await freeHeading.click();

  await row.focus();
  await expect(row).toBeInViewport({ ratio: 0.95 });

  await api(daemon, `/api/workflow-runs/${run}/cancel`, { requestId: "release-to-offscreen-row" });
  await expect(rail.getByRole("button", { name: "free 3", exact: true })).toHaveCount(1);
  await expect(row).toBeFocused();
  await expect(row).toBeInViewport({ ratio: 0.95 });
});

test("the Idle rail keeps focus in the rail when a focused session starts working", async ({ dashboard, daemon }) => {
  const free = await dispatchIdleAgent(dashboard, daemon, "keep this conversation open");
  const leaving = await dispatchIdleAgent(dashboard, daemon, "start working from Idle");
  await api(daemon, "/api/feature-flags", { kind: "flag", id: "idle-rail-section-counts", enabled: true }, "PUT");
  await useBoardLayout(dashboard, daemon);

  const freeName = await sessionName(daemon, free);
  const leavingName = await sessionName(daemon, leaving);
  const idle = dashboard.locator("section.board-col.tone-idle");
  await idle.getByRole("button", { name: `Open ${freeName}`, exact: true }).press("Enter");
  const rail = dashboard.locator("section.board-col.is-rail.tone-idle");
  const row = rail.getByRole("button", { name: leavingName, exact: true });
  await row.focus();
  await expect(row).toBeFocused();

  await api(daemon, `/api/sessions/${encodeURIComponent(leaving)}/send`, {
    text: "hold the current turn open for queued review setup",
    submit: true,
  });
  await expect(row).toHaveCount(0);
  await expect(rail.getByRole("button", { name: "free 1", exact: true })).toBeFocused();
  await expect(dashboard.locator(".cdetail .detail-head")).toContainText(freeName);
});
