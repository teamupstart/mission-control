import { mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";

// A paused Goal has an exit (docs/plans/foreman-stuck-goal-recovery, phase 3).
//
// The fake `claude` answers every goal classification with `initial`, which the refiner turns
// into `unclear` for any later instruction: the deterministic way to stall a session's Goal
// with "needs more context". From there only a person can end the pause, and this spec drives
// that through the browser - the Goal line names the exit, the Foreman drawer offers it, and
// the click resolves the instruction as steering without touching the objective.

const OBJECTIVE = "Ship the accept objective control";
const FOLLOW_UP = "make the heading bold as well";
const EXIT = "Open Foreman intent to accept the objective as is.";
test.use({ daemonEnv: { MISSION_GOAL_POLL_MS: "20", MISSION_GOAL_REFRESH_MS: "20" } });

interface Goal {
  objective: string | null;
  objectiveVersion: number;
  promptRevision: number;
  resolvedPromptRevision: number;
  relationship: string | null;
  rationale: string | null;
  pendingPrompts: unknown[];
}

async function api<T>(daemon: DaemonHandle, path: string): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`);
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

/** Dispatch one agent from the modal, and wait for its opening instruction to be classified. */
async function dispatch(page: Page, daemon: DaemonHandle): Promise<string> {
  await page.getByRole("button", { name: "Dispatch", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  // The repo combobox portals its listbox over the fields below; Escape closes only the list.
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(OBJECTIVE);
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();

  let sessionId = "";
  await expect.poll(async () => {
    const sessions = await api<Array<{ id: string; state: string }>>(daemon, "/api/sessions");
    const live = sessions.find((session) => session.state !== "exited");
    sessionId = live?.id ?? "";
    return live?.state ?? "";
  }, { message: "the dispatched session should settle" }).toBe("idle");
  await expect.poll(async () => (await api<Goal>(daemon, `/api/sessions/${sessionId}/goal`)).resolvedPromptRevision,
    { message: "the opening instruction should become the objective" }).toBe(1);
  return sessionId;
}

/** Wait for the follow-up's turn to finish, so every capture of it has landed. */
async function settled(daemon: DaemonHandle, sessionId: string): Promise<void> {
  await expect.poll(async () => {
    const sessions = await api<Array<{ id: string; state: string; pendingTurns: unknown[] }>>(daemon, "/api/sessions");
    const session = sessions.find((item) => item.id === sessionId)!;
    const row = withDaemonDb(daemon, (db) =>
      db.prepare("SELECT turn_in_progress FROM sdk_sessions WHERE id = ?").get(sessionId)) as { turn_in_progress: number };
    return session.state === "idle" && session.pendingTurns.length === 0 && row.turn_in_progress === 0;
  }, { message: "the follow-up turn should complete" }).toBe(true);
}

test("Accept objective as is ends a paused Goal without changing the objective", async ({ dashboard, daemon }) => {
  const sessionId = await dispatch(dashboard, daemon);
  const before = await api<Goal>(daemon, `/api/sessions/${sessionId}/goal`);
  expect(before.objective).toBe(OBJECTIVE);

  await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  const detail = dashboard.locator(".console-detail");
  const reply = detail.getByPlaceholder(/^Reply to this session/);
  await expect(reply).toBeEnabled();
  await reply.fill(FOLLOW_UP);
  await reply.press("Enter");
  await settled(daemon, sessionId);

  // The follow-up is judged `unclear`: resolved, but automatic wrap-up stays paused.
  let paused = before;
  await expect.poll(async () => {
    paused = await api<Goal>(daemon, `/api/sessions/${sessionId}/goal`);
    return paused.promptRevision >= 2
      && paused.resolvedPromptRevision === paused.promptRevision
      && paused.relationship === "unclear";
  }, { message: "the follow-up should stall the Goal as unclear" }).toBe(true);

  // The Goal line's paused hover names its exit.
  const goalLine = detail.locator("p.goal");
  await expect(goalLine).toHaveClass(/goal-unclear/);
  await expect(goalLine).toHaveAccessibleDescription(new RegExp(EXIT.replace(/\./g, "\\.")));

  await detail.getByRole("button", { name: "Foreman intent", exact: true }).click();
  const drawer = dashboard.locator(".foreman-drawer");
  const reading = drawer.locator(".fd-intent-reading");
  await expect(reading.locator(".fd-intent-relation")).toHaveText("needs more context");
  const accept = drawer.getByRole("button", { name: "Accept objective as is", exact: true });
  await expect(accept).toBeVisible();
  await expect(accept).toHaveAccessibleDescription(
    "Record the pending instructions as steering and let Foreman judge completion against this objective",
  );
  if (process.env.MC_E2E_EVIDENCE) {
    const dir = artifactsDir("goal-accept-objective");
    mkdirSync(dir, { recursive: true });
    await drawer.screenshot({ path: `${dir}paused.png` });
  }

  await accept.click();

  // The drawer reads the confirmed contract at once, and the exit is gone with the pause.
  await expect(reading.locator(".fd-intent-relation")).toHaveText("steering");
  await expect(reading).toContainText("Accepted by you: the current objective is the completion contract.");
  await expect(accept).toHaveCount(0);
  await expect(drawer.locator(".fd-intent-objective")).toHaveText(OBJECTIVE);
  await expect(drawer.locator(".fd-intent-version")).toHaveText(`objective v${before.objectiveVersion}`);
  await expect(drawer.getByRole("alert")).toHaveCount(0);

  const after = await api<Goal>(daemon, `/api/sessions/${sessionId}/goal`);
  expect(after.relationship).toBe("steer");
  expect(after.resolvedPromptRevision).toBe(after.promptRevision);
  expect(after.promptRevision).toBe(paused.promptRevision);
  expect(after.pendingPrompts).toEqual([]);
  expect(after.objective).toBe(before.objective);
  expect(after.objectiveVersion).toBe(before.objectiveVersion);
  expect(after.rationale).toMatch(/^Accepted by you:/);

  // The card heard it over the stream: the Goal line is no longer paused.
  await expect(goalLine).not.toHaveClass(/goal-unclear|goal-resolving/);
  await expect(goalLine).not.toHaveAccessibleDescription(new RegExp(EXIT.replace(/\./g, "\\.")));
  if (process.env.MC_E2E_EVIDENCE) {
    const dir = artifactsDir("goal-accept-objective");
    await drawer.screenshot({ path: `${dir}accepted.png` });
  }
});

// A ten-minute refresh window lets the opening instruction classify (its first claim is
// immediate) and then holds the follow-up unclassified, so the Goal stays "reconciling" for
// as long as this case needs: the other paused state, and the one a transport failure leaves.
test.describe("while the latest instruction is still reconciling", () => {
  test.use({ daemonEnv: { MISSION_GOAL_POLL_MS: "20", MISSION_GOAL_REFRESH_MS: "600000" } });

  test("a failed or unreachable accept keeps the pause and the control, and a retry succeeds", async ({ dashboard, daemon }) => {
    const sessionId = await dispatch(dashboard, daemon);
    const before = await api<Goal>(daemon, `/api/sessions/${sessionId}/goal`);

    await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
    const detail = dashboard.locator(".console-detail");
    const reply = detail.getByPlaceholder(/^Reply to this session/);
    await expect(reply).toBeEnabled();
    await reply.fill(FOLLOW_UP);
    await reply.press("Enter");
    await settled(daemon, sessionId);
    const pending = await api<Goal>(daemon, `/api/sessions/${sessionId}/goal`);
    expect(pending.resolvedPromptRevision).toBeLessThan(pending.promptRevision);

    // The resolving hover names the same exit as the unclear one.
    const goalLine = detail.locator("p.goal");
    await expect(goalLine).toHaveClass(/goal-resolving/);
    await expect(goalLine).toHaveAccessibleDescription(
      new RegExp(`reconciling the latest instruction with this objective\\) ${EXIT.replace(/\./g, "\\.")}`),
    );

    await detail.getByRole("button", { name: "Foreman intent", exact: true }).click();
    const drawer = dashboard.locator(".foreman-drawer");
    const reading = drawer.locator(".fd-intent-reading");
    await expect(reading.locator(".fd-intent-relation")).toHaveText("reconciling");
    const accept = drawer.getByRole("button", { name: "Accept objective as is", exact: true });

    const ACCEPT_ROUTE = `**/api/sessions/${encodeURIComponent(sessionId)}/goal/accept`;

    // The request never reaches the daemon: `fetch` itself rejects. `acceptGoal` must turn
    // that into a refusal rather than throw past the drawer, so the pause and the control stay.
    await dashboard.route(ACCEPT_ROUTE, (route) => route.abort("failed"));
    await accept.click();
    await expect(drawer.getByRole("alert")).toHaveText(/^The objective was not accepted: Failed to fetch\.$/);
    await expect(reading.locator(".fd-intent-relation")).toHaveText("reconciling");
    await expect(reading).toContainText("Automatic wrap-up is paused until this instruction is classified.");
    await expect(accept).toBeEnabled();
    await expect(goalLine).toHaveClass(/goal-resolving/);
    const afterAbort = await api<Goal>(daemon, `/api/sessions/${sessionId}/goal`);
    expect(afterAbort.resolvedPromptRevision).toBe(pending.resolvedPromptRevision);
    expect(afterAbort.pendingPrompts).toEqual(pending.pendingPrompts);
    await dashboard.unroute(ACCEPT_ROUTE);

    // The daemon refuses once; nothing about the pause may change.
    await dashboard.route(ACCEPT_ROUTE, (route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "injected failure" }) }),
    );
    await accept.click();
    await expect(drawer.getByRole("alert")).toHaveText("The objective was not accepted: injected failure.");
    await expect(reading.locator(".fd-intent-relation")).toHaveText("reconciling");
    await expect(reading).toContainText("Automatic wrap-up is paused until this instruction is classified.");
    await expect(accept).toBeEnabled();
    await expect(goalLine).toHaveClass(/goal-resolving/);
    const untouched = await api<Goal>(daemon, `/api/sessions/${sessionId}/goal`);
    expect(untouched.resolvedPromptRevision).toBe(pending.resolvedPromptRevision);
    expect(untouched.pendingPrompts).toEqual(pending.pendingPrompts);
    if (process.env.MC_E2E_EVIDENCE) {
      const dir = artifactsDir("goal-accept-objective");
      mkdirSync(dir, { recursive: true });
      await dashboard.mouse.move(0, 0);
      await drawer.screenshot({ path: `${dir}failed.png` });
    }

    // The same control, pressed again against the real route, ends the pause.
    await dashboard.unroute(ACCEPT_ROUTE);
    await accept.click();
    await expect(reading.locator(".fd-intent-relation")).toHaveText("steering");
    await expect(drawer.getByRole("alert")).toHaveCount(0);
    await expect(accept).toHaveCount(0);
    const after = await api<Goal>(daemon, `/api/sessions/${sessionId}/goal`);
    expect(after.resolvedPromptRevision).toBe(after.promptRevision);
    expect(after.objective).toBe(before.objective);
    expect(after.objectiveVersion).toBe(before.objectiveVersion);
    await expect(goalLine).not.toHaveClass(/goal-unclear|goal-resolving/);
  });
  test("a goal read that started before the accept cannot put the pause back", async ({ dashboard, daemon }) => {
    const sessionId = await dispatch(dashboard, daemon);
    await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
    const detail = dashboard.locator(".console-detail");
    const reply = detail.getByPlaceholder(/^Reply to this session/);
    await expect(reply).toBeEnabled();
    await reply.fill(FOLLOW_UP);
    await reply.press("Enter");
    await settled(daemon, sessionId);
    const stale = await api<Goal>(daemon, `/api/sessions/${sessionId}/goal`);
    expect(stale.resolvedPromptRevision).toBeLessThan(stale.promptRevision);

    await detail.getByRole("button", { name: "Foreman intent", exact: true }).click();
    const drawer = dashboard.locator(".foreman-drawer");
    const relation = drawer.locator(".fd-intent-reading .fd-intent-relation");
    await expect(relation).toHaveText("reconciling");
    const accept = drawer.getByRole("button", { name: "Accept objective as is", exact: true });

    // The accept's own server event moves the drawer's refresh stamp, which starts a goal read.
    // Hold the accept's answer until that read is in flight, then answer the read with the
    // paused record it would have seen a moment earlier - after the accept has been applied.
    let readStarted!: () => void;
    const readSeen = new Promise<void>((resolve) => { readStarted = resolve; });
    let acceptAnswered!: () => void;
    const acceptDelivered = new Promise<void>((resolve) => { acceptAnswered = resolve; });
    // Only the first read and the first accept are held. (Not `{ times: 1 }`: that drops the
    // route as soon as it matches, which lets a held request continue to the daemon.)
    const base = `**/api/sessions/${encodeURIComponent(sessionId)}`;
    let heldRead = false;
    await dashboard.route(`${base}/goal`, async (route) => {
      if (heldRead) return route.continue();
      heldRead = true;
      readStarted();
      await acceptDelivered;
      await expect(relation).toHaveText("steering");
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(stale) });
    });
    let heldAccept = false;
    await dashboard.route(`${base}/goal/accept`, async (route) => {
      if (heldAccept) return route.continue();
      heldAccept = true;
      const response = await route.fetch();
      await readSeen;
      await route.fulfill({ response });
      acceptAnswered();
    });

    const staleRead = dashboard.waitForEvent("requestfinished", (request) =>
      new URL(request.url()).pathname === `/api/sessions/${encodeURIComponent(sessionId)}/goal`);
    await accept.click();
    await staleRead;
    // Let the late read's promise chain and React's commit run before judging the drawer.
    await dashboard.evaluate(() => new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 50)))));
    await expect(relation).toHaveText("steering");
    await expect(accept).toHaveCount(0);
    await expect(drawer.locator(".fd-intent-reading")).toContainText("Accepted by you:");
  });
});
