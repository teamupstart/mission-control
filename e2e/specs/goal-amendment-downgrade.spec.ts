import { mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

// A reply that picks one of the options a session offered used to come back from the goal
// model as an "amendment" whose objective did not keep the current one as its prefix. The
// refiner stamped it unclear and latched it: the drawer said wrap-up was paused, the Goal line
// said so too, and a bound Workflow was never reached. It now resolves as steering. The fake
// agent answers `amend` with a non-prefixed objective whenever the instruction carries the
// E2E_AMEND_SHRINK marker, so the real refiner, registry and drawer are what this drives.

const REQUEST = "Ship the stuck goal recovery feature";
const PICK = "E2E_AMEND_SHRINK pick option B";
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

async function goalOf(daemon: DaemonHandle, sessionId: string): Promise<Goal> {
  const response = await fetch(`${daemon.baseURL}/api/sessions/${sessionId}/goal`);
  expect(response.ok, "the goal route should answer").toBe(true);
  return (await response.json()) as Goal;
}

/** Dispatch one agent from the modal and wait for its opening objective to resolve. */
async function dispatch(page: Page, daemon: DaemonHandle): Promise<string> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await expectContentClearsBorder(dialog);
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(REQUEST);
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();

  let sessionId = "";
  await expect.poll(async () => {
    const response = await fetch(`${daemon.baseURL}/api/sessions`);
    const sessions = (await response.json()) as Array<{ id: string; state: string }>;
    const live = sessions.find((session) => session.state !== "exited");
    sessionId = live?.id ?? "";
    return live?.state ?? "";
  }, { message: "the dispatched session should settle" }).toBe("idle");
  await expect.poll(async () => (await goalOf(daemon, sessionId)).resolvedPromptRevision,
    { message: "the opening objective should resolve" }).toBe(1);
  return sessionId;
}

test("an amendment that drops the objective resolves as steering and leaves wrap-up unpaused", async ({ dashboard, daemon }) => {
  const sessionId = await dispatch(dashboard, daemon);
  const opening = await goalOf(daemon, sessionId);
  expect(opening.objective).toBe(REQUEST);

  await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  const detail = dashboard.locator(".console-detail");
  const reply = detail.getByPlaceholder(/^Reply to this session/);
  await expect(reply).toBeEnabled();
  await reply.fill(PICK);
  await reply.press("Enter");

  await expect.poll(async () => {
    const goal = await goalOf(daemon, sessionId);
    return goal.promptRevision >= 2 && goal.resolvedPromptRevision === goal.promptRevision
      ? goal.relationship
      : "pending";
  }, { message: "the misread amendment should resolve rather than latch" }).toBe("steer");
  const resolved = await goalOf(daemon, sessionId);
  expect(resolved.objective, "steering must not adopt the proposed objective").toBe(REQUEST);
  expect(resolved.objectiveVersion).toBe(opening.objectiveVersion);
  expect(resolved.pendingPrompts).toEqual([]);
  expect(resolved.rationale).toMatch(/^Treated as steering: /);

  // The Goal line no longer tells the person automatic wrap-up is paused.
  const goalLine = detail.locator("p.goal");
  await expect(goalLine).toHaveText(REQUEST);
  await expect(goalLine).toHaveAccessibleDescription(REQUEST);
  await expect(goalLine).not.toHaveAccessibleDescription(/paused/);

  await dashboard.getByRole("button", { name: "Foreman intent", exact: true }).click();
  const drawer = dashboard.locator(".foreman-drawer");
  await expect(drawer).toBeVisible();
  const intent = drawer.locator("section.fd-intent");
  await expect(intent.locator(".fd-intent-relation")).toHaveText("steering");
  await expect(intent.locator(".fd-intent-objective")).toHaveText(REQUEST);
  await expect(intent.locator(".fd-intent-version")).toHaveText(`objective v${opening.objectiveVersion}`);
  await expect(intent.locator(".fd-intent-reading")).toContainText(
    "Treated as steering: the proposed amendment did not retain the current objective.",
  );
  await expect(intent).not.toContainText("Automatic wrap-up is paused");
  await expect(intent).not.toContainText("needs more context");

  if (process.env.MC_E2E_EVIDENCE) {
    const dir = artifactsDir("goal-amendment-downgrade");
    mkdirSync(dir, { recursive: true });
    await dashboard.mouse.move(0, 0);
    await drawer.screenshot({ path: `${dir}foreman-intent-steering.png` });
  }
});
