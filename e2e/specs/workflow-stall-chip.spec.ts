import { mkdirSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";

// A stalled Foreman-complete binding is visible and actionable
// (docs/plans/foreman-stuck-goal-recovery, phase 4).
//
// A `foreman_complete` binding gets its run only from Foreman's claim, and Foreman claims only
// against a resolved goal. A session that has finished its work cycle while its latest
// instruction is unresolved is therefore a dead end, and before this the chip kept promising a
// review at completion. Here the chip says so, and the bind dialog offers the two ways forward.
//
// Both stalled shapes are produced deterministically, with no model tokens: the fake `claude`
// answers every goal classification with `initial`, which the refiner turns into `unclear` for
// a later instruction, and a ten-minute refresh window instead holds the follow-up unclassified.
// No Foreman worker runs in this suite, so nothing claims the binding behind the spec's back.

const EVIDENCE = artifactsDir("workflow-stall-chip");
const OBJECTIVE = "Ship the stalled workflow surface";
const FOLLOW_UP = "make the heading bold as well";
const WORKFLOW = "E2E stall chip";
const OTHER_WORKFLOW = "E2E stall chip other";
const STALL =
  `${WORKFLOW} v1 is waiting on this session's goal: Foreman cannot call the work complete `
  + "while the latest instruction is unresolved.";
const CHIP_STALL = `${STALL} Click for ways to proceed.`;
const CHIP_ARMED = `${WORKFLOW} v1 runs when this session's work is complete - click to change it`;

interface Goal {
  objective: string | null;
  promptRevision: number;
  resolvedPromptRevision: number;
  relationship: string | null;
}

interface SessionView {
  id: string;
  state: string;
  pendingTurns: unknown[];
  workCycle?: { generation: number; active: boolean; completedAt: number | null } | null;
}

async function api<T>(daemon: DaemonHandle, path: string, body?: unknown, method?: string): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

async function shoot(target: Page | Locator, page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await target.screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/workflow-stall-chip/${name}.png`);
}

/** Dispatch one agent with no workflow, and wait for its opening instruction to be the objective. */
async function dispatch(page: Page, daemon: DaemonHandle): Promise<string> {
  await page.getByRole("button", { name: "Dispatch", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(OBJECTIVE);
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();

  let sessionId = "";
  await expect.poll(async () => {
    const live = (await api<SessionView[]>(daemon, "/api/sessions")).find((s) => s.state !== "exited");
    sessionId = live?.id ?? "";
    return live?.state ?? "";
  }, { message: "the dispatched session should settle", timeout: 60_000 }).toBe("idle");
  await expect.poll(async () => (await api<Goal>(daemon, `/api/sessions/${sessionId}/goal`)).resolvedPromptRevision,
    { message: "the opening instruction should become the objective" }).toBe(1);
  return sessionId;
}

/** A published one-reviewer workflow whose reviewer passes, so a submitted run can finish. */
async function publishWorkflow(daemon: DaemonHandle, name = WORKFLOW): Promise<void> {
  const persona = await api<{ id: string }>(daemon, "/api/personas", {
    name: `${name} reviewer`,
    guidanceMarkdown: `# ${name} reviewer\n\nE2E_PASS_VERDICT`,
  });
  const workflow = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", {
    name,
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
  await api(daemon, `/api/workflows/${workflow.workflow.id}/publish`, { expectedDraftRevision: 1 });
}

/** Console layout, the one session's detail open. */
async function openConsoleDetail(page: Page, daemon: DaemonHandle): Promise<Locator> {
  await api(daemon, "/api/ui/config", { layout: "console" }, "PUT");
  await page.reload();
  await page.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  const detail = page.locator(".console-detail");
  await expect(detail.locator("header.detail-head")).toBeVisible();
  return detail;
}

/** Bind the published workflow with the Foreman complete trigger, from the `＋ workflow` chip. */
async function bindFromChip(page: Page, detail: Locator): Promise<Locator> {
  await detail.locator("header.detail-head").getByRole("button", { name: "＋ workflow" }).click();
  const dialog = page.getByRole("dialog", { name: "Bind workflow" });
  await dialog.getByRole("combobox", { name: "Published workflow" }).selectOption({ label: `${WORKFLOW} · v1` });
  await dialog.getByRole("combobox", { name: "Trigger" }).selectOption("foreman_complete");
  await dialog.getByRole("combobox", { name: "Delivery" }).selectOption("preview");
  await dialog.getByRole("button", { name: "Bind only" }).click();
  await expect(dialog).toBeHidden();
  const chip = detail.locator("header.detail-head").getByRole("button", { name: `${WORKFLOW} v1`, exact: true });
  await expect(chip).toBeVisible();
  await expect(chip).toHaveAccessibleDescription(CHIP_ARMED);
  return chip;
}

/** Send a plain follow-up and wait for its turn to finish and its work cycle to complete. */
async function followUp(daemon: DaemonHandle, detail: Locator, sessionId: string): Promise<void> {
  const reply = detail.getByPlaceholder(/^Reply to this session/);
  await expect(reply).toBeEnabled();
  await reply.fill(FOLLOW_UP);
  await reply.press("Enter");
  await expect.poll(async () => {
    const session = (await api<SessionView[]>(daemon, "/api/sessions")).find((s) => s.id === sessionId)!;
    const row = withDaemonDb(daemon, (db) =>
      db.prepare("SELECT turn_in_progress FROM sdk_sessions WHERE id = ?").get(sessionId)) as { turn_in_progress: number };
    const cycle = session.workCycle;
    return session.state === "idle" && session.pendingTurns.length === 0 && row.turn_in_progress === 0
      && Boolean(cycle && cycle.generation >= 1 && !cycle.active && cycle.completedAt !== null);
  }, { message: "the follow-up's turn should complete its work cycle", timeout: 60_000 }).toBe(true);
}

test.describe("a follow-up judged as needing more context", () => {
  test.use({ daemonEnv: { MISSION_GOAL_POLL_MS: "20", MISSION_GOAL_REFRESH_MS: "20" } });

  test("the chip names the stall and Accept objective as is clears it", async ({ dashboard, daemon }) => {
    await api(daemon, "/api/foreman/config", { enabled: true }, "PUT");
    const sessionId = await dispatch(dashboard, daemon);
    await publishWorkflow(daemon);
    // A second published workflow, so the dialog can be moved off the bound version.
    await publishWorkflow(daemon, OTHER_WORKFLOW);
    const detail = await openConsoleDetail(dashboard, daemon);
    const chip = await bindFromChip(dashboard, detail);

    await followUp(daemon, detail, sessionId);
    await expect.poll(async () => {
      const goal = await api<Goal>(daemon, `/api/sessions/${sessionId}/goal`);
      return goal.promptRevision >= 2 && goal.resolvedPromptRevision === goal.promptRevision
        && goal.relationship === "unclear";
    }, { message: "the follow-up should stall the goal as unclear" }).toBe(true);

    // The chip turns from a promise into a question, and keeps its accessible name.
    await expect(chip).toHaveClass(/\bstalled\b/);
    await expect(chip).toHaveAccessibleDescription(CHIP_STALL);
    await shoot(detail.locator("header.detail-head"), dashboard, "01-stalled-chip");

    await chip.click();
    const dialog = dashboard.getByRole("dialog", { name: "Bind workflow" });
    const notice = dialog.getByRole("status", { name: "Workflow waiting on the goal" });
    await expect(notice).toBeVisible();
    await expect(notice).toContainText(STALL);
    await expect(notice).not.toContainText("Click for ways to proceed");
    const accept = notice.getByRole("button", { name: "Accept objective as is", exact: true });
    await expect(accept).toBeEnabled();
    // The other way forward is the footer's existing submit, which the notice names. Exactly
    // one button by that name, so it stays unambiguous to a screen reader and to `getByRole`.
    await expect(notice).toContainText("Or use Submit bound version below");
    // "Needs more context" is a RESOLVED revision, so a manual run now would not be badged
    // unreconciled, and the notice must not promise that it would.
    await expect(notice).not.toContainText("unreconciled");
    await expect(dialog.getByRole("button", { name: "Submit bound version", exact: true })).toHaveCount(1);
    await expect(dialog.getByRole("button", { name: "Submit bound version", exact: true })).toBeEnabled();
    await expectContentClearsBorder(dialog);
    await shoot(dialog, dashboard, "02-dialog-notice");
    // Both ways forward in one picture: the dialog is taller than the default viewport, so
    // grow the page until its footer is on screen too, then put the viewport back.
    if (process.env.MC_E2E_EVIDENCE) {
      const viewport = dashboard.viewportSize();
      await dashboard.setViewportSize({ width: viewport?.width ?? 1280, height: 1600 });
      await expect(dialog.getByRole("button", { name: "Submit bound version", exact: true })).toBeInViewport();
      await expect(accept).toBeInViewport();
      await shoot(dashboard, dashboard, "02a-dialog-both-actions");
      if (viewport) await dashboard.setViewportSize(viewport);
    }

    // The notice speaks about the ARMED binding only. Choosing another version turns the
    // footer into a switch, so the notice must go; choosing the bound version brings it back.
    const version = dialog.getByRole("combobox", { name: "Published workflow" });
    await version.selectOption({ label: `${OTHER_WORKFLOW} · v1` });
    await expect(notice).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Switch and submit", exact: true })).toBeVisible();
    await version.selectOption({ label: `${WORKFLOW} · v1` });
    await expect(notice).toBeVisible();
    await expect(notice).toContainText(STALL);
    await expect(dialog.getByRole("button", { name: "Submit bound version", exact: true })).toHaveCount(1);

    // A failed accept says so, and leaves the stall and the control in place. First a request
    // that never reaches the daemon, then one the daemon refuses.
    const ACCEPT_ROUTE = `**/api/sessions/${encodeURIComponent(sessionId)}/goal/accept`;
    await dashboard.route(ACCEPT_ROUTE, (route) => route.abort("failed"));
    await accept.click();
    await expect(notice.getByRole("alert")).toHaveText(/^The objective was not accepted: Failed to fetch\.$/);
    await expect(notice).toContainText(STALL);
    await expect(accept).toBeEnabled();
    await dashboard.unroute(ACCEPT_ROUTE);
    await dashboard.route(ACCEPT_ROUTE, (route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "injected failure" }) }),
    );
    await accept.click();
    await expect(notice.getByRole("alert")).toHaveText("The objective was not accepted: injected failure.");
    await expect(notice).toContainText(STALL);
    await expect(accept).toBeEnabled();
    await expect(chip).toHaveClass(/\bstalled\b/);
    const refused = await api<Goal>(daemon, `/api/sessions/${sessionId}/goal`);
    expect(refused.relationship).toBe("unclear");
    await shoot(dialog, dashboard, "02b-dialog-accept-failed");
    await dashboard.unroute(ACCEPT_ROUTE);

    // The same control, against the real route, ends the stall.
    await accept.click();

    // The goal resolves as steering; the notice and the chip's stalled state go with it.
    await expect(notice).toHaveCount(0);
    await expect(dialog.getByRole("alert")).toHaveCount(0);
    const goal = await api<Goal>(daemon, `/api/sessions/${sessionId}/goal`);
    expect(goal.relationship).toBe("steer");
    expect(goal.resolvedPromptRevision).toBe(goal.promptRevision);
    expect(goal.objective).toBe(OBJECTIVE);
    await shoot(dialog, dashboard, "03-dialog-accepted");
    await dashboard.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(chip).not.toHaveClass(/\bstalled\b/);
    await expect(chip).toHaveAccessibleDescription(CHIP_ARMED);
  });
});

test.describe("a follow-up still reconciling", () => {
  test.use({ daemonEnv: { MISSION_GOAL_POLL_MS: "20", MISSION_GOAL_REFRESH_MS: "600000" } });

  test("Submit bound version beside the notice runs the binding and the run is marked unreconciled", async ({
    dashboard,
    daemon,
  }) => {
    await api(daemon, "/api/foreman/config", { enabled: true }, "PUT");
    const sessionId = await dispatch(dashboard, daemon);
    await publishWorkflow(daemon);
    const detail = await openConsoleDetail(dashboard, daemon);
    const chip = await bindFromChip(dashboard, detail);

    await followUp(daemon, detail, sessionId);
    const pending = await api<Goal>(daemon, `/api/sessions/${sessionId}/goal`);
    expect(pending.resolvedPromptRevision).toBeLessThan(pending.promptRevision);
    await expect(chip).toHaveClass(/\bstalled\b/);
    await expect(chip).toHaveAccessibleDescription(CHIP_STALL);

    await chip.click();
    const dialog = dashboard.getByRole("dialog", { name: "Bind workflow" });
    const notice = dialog.getByRole("status", { name: "Workflow waiting on the goal" });
    await expect(notice).toContainText(STALL);
    // Still reconciling: the run this submits WILL be badged, and the notice says so.
    await expect(notice).toContainText(
      "while the latest instruction is still reconciling, that run is marked unreconciled.",
    );
    await dialog.getByRole("button", { name: "Submit bound version", exact: true }).click();

    // The footer's own submit ran: the dialog closes on the new run, whose frozen ask is badged.
    await expect(dialog).toBeHidden();
    await expect(dashboard).toHaveURL(/#\/runs\/[^/?]+/);
    await dashboard.getByRole("tab", { name: /^Intent/ }).click();
    const pane = dashboard.getByRole("tabpanel", { name: /^Intent/ });
    const badge = pane.getByRole("note");
    await expect(badge).toHaveText("Ask frozen before the newest instruction was reconciled");
    await expect(badge).toHaveAttribute(
      "aria-label",
      new RegExp(`frozen at prompt revision ${pending.promptRevision} while the goal refiner had reconciled only up to revision ${pending.resolvedPromptRevision}`),
    );
    await shoot(pane, dashboard, "04-manual-run-unreconciled");
  });
});
