import { mkdirSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * Follow the review, as a browser sees it.
 *
 * The unit suite (`test/workflows-tour.test.ts`) already decides everything about this tour
 * that is data - thirteen stops, fourteen beats, which route and pane each stop asks for,
 * which run and session qualify, and every fallback clause. What only a browser can answer
 * is whether those routes mount the surfaces the stops point at, whether the two real
 * modals open and close under the tour without writing anything, and whether the stage
 * strip's resolved beats land on the stage the copy is about.
 *
 * NO MODEL TOKENS. The one live artifact this spec needs is a run of the built-in workflow,
 * produced exactly the way the Library tour's spec produces one: bind the shipped version
 * to a fake-backed session, submit once, and cancel - terminal in a moment, and no reviewer
 * is ever asked anything.
 */

const NO_MISTAKES = "builtin-workflow:no-mistakes-review";
const EVIDENCE = artifactsDir("workflows-tour");

async function shoot(target: Page | Locator, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await target.screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/workflows-tour/${name}.png`);
}

test.describe.configure({ timeout: 180_000 });

async function api<T>(
  daemon: DaemonHandle,
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

function step(page: Page, title: string): Locator {
  return page.getByRole("dialog", { name: title }).or(page.getByRole("status", { name: title }));
}

const hash = (page: Page): Promise<string> => page.evaluate(() => location.hash);

async function startFromPalette(page: Page): Promise<void> {
  const palette = page.getByRole("dialog", { name: "Search everything" });
  await page.keyboard.press("Meta+k");
  await expect(palette).toBeVisible();
  await palette.getByRole("combobox", { name: "Search everything" }).fill("Follow the review");
  await palette.getByRole("option", { name: /Start Follow the review tour, command/ }).click();
}

async function dispatchSession(page: Page, daemon: DaemonHandle, brief: string): Promise<string> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(brief);
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();

  let sessionId = "";
  await expect.poll(async () => {
    const sessions = await api<Array<{ id: string; state: string }>>(daemon, "/api/sessions");
    const session = sessions.find((candidate) => candidate.state !== "exited");
    sessionId = session?.id ?? "";
    return session?.state ?? "";
  }, { timeout: 60_000 }).toBe("idle");
  return sessionId;
}

/** A terminal run of the built-in against a live session: bind, submit once, cancel. */
async function seedTerminalRun(
  daemon: DaemonHandle,
  workflowVersionId: string,
  sessionId: string,
  requestId: string,
): Promise<string> {
  const binding = await api<{ id: string }>(daemon, "/api/workflow-bindings", {
    workflowVersionId,
    sessionId,
    deliveryMode: "preview",
  });
  const submitted = await api<{ run: { id: string } }>(
    daemon,
    `/api/workflow-bindings/${binding.id}/submit`,
    { requestId },
  );
  await api(daemon, `/api/workflow-runs/${submitted.run.id}/cancel`, {
    requestId: `${requestId}-cancel`,
  });
  await expect.poll(async () => (
    await api<{ run: { status: string } }>(daemon, `/api/workflow-runs/${submitted.run.id}`)
  ).run.status, { timeout: 60_000 }).toBe("cancelled");
  return submitted.run.id;
}

async function builtinVersionId(daemon: DaemonHandle): Promise<string> {
  const workflows = await api<Array<{ id: string; currentVersionId: string | null }>>(
    daemon,
    "/api/workflows",
  );
  const builtin = workflows.find((workflow) => workflow.id === NO_MISTAKES);
  expect(builtin?.currentVersionId, "this build ships no published No-Mistakes Review").toBeTruthy();
  return builtin!.currentVersionId!;
}

test("the palette starts the tour, and it walks the demonstration run even over real history", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.emulateMedia({ reducedMotion: "reduce" });
  await dashboard.setViewportSize({ width: 1440, height: 900 });
  await dashboard.goto(`${daemon.baseURL}/#/fleet`);

  // Real history on purpose: a live session with an armed binding (so the chip stops are
  // real), and a real terminal run of the built-in - which the tour must IGNORE, because
  // its run chapter is deterministic and always reads the seeded demonstration record.
  const sessionId = await dispatchSession(dashboard, daemon, "Sit for the workflows tour");
  const versionId = await builtinVersionId(daemon);
  const realRunId = await seedTerminalRun(daemon, versionId, sessionId, "workflows-tour-run");
  const bindingsBefore = (await api<unknown[]>(daemon, "/api/workflow-bindings")).length;

  await startFromPalette(dashboard);

  // 1. The centered opener, on the Runs page the whole tour returns to.
  let dialog = step(dashboard, "Work gets reviewed");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Step 1 of 13");
  await expect(dialog.getByText("Follow the review", { exact: true })).toBeVisible();
  await expect(dialog).toContainText("post-work verification");
  await expect.poll(() => hash(dashboard)).toBe("#/runs");
  await dialog.getByRole("button", { name: "Open Dispatch" }).click();

  // 2. The real Dispatch modal, spotlighting the After work field and its per-kind list.
  dialog = step(dashboard, "Dispatch picks the workflow");
  await expect(dialog).toContainText("Step 2 of 13");
  await expect(dashboard.getByRole("dialog", { name: "Dispatch an agent" })).toBeVisible();
  await expect(dashboard.locator(".dispatch-workflow")).toHaveCSS("outline-width", "2px");
  await expect(dialog).toContainText("No-Mistakes Review out of the box");
  await expect(dialog).toContainText("Bug Fix Review");
  await shoot(dashboard, "02-after-work");
  await dialog.getByRole("button", { name: "Open a session" }).click();

  // 3. The armed binding chip on the session the seed bound. The modal closed behind it.
  dialog = step(dashboard, "A binding pins the version");
  await expect(dialog).toContainText("Step 3 of 13");
  await expect(dashboard.getByRole("dialog", { name: "Dispatch an agent" })).toBeHidden();
  const chip = dashboard.locator(".workflow-bind-chip");
  await expect(chip).toHaveClass(/armed/);
  await expect(chip).toContainText("No-Mistakes Review");
  await expect(chip).toHaveCSS("outline-width", "2px");
  await dialog.getByRole("button", { name: "Open Bind workflow" }).click();

  // 4. The real Bind workflow dialog, read-only: Trigger, Delivery, and the rounds budget.
  dialog = step(dashboard, "Bind one yourself");
  await expect(dialog).toContainText("Step 4 of 13");
  const bindDialog = dashboard.getByRole("dialog", { name: "Bind workflow" });
  await expect(bindDialog).toBeVisible();
  await expect(bindDialog).toContainText("Immutable version binding");
  await expect(bindDialog.getByLabel("Session")).toBeDisabled();
  await shoot(dashboard, "04-bind-dialog");
  await dialog.getByRole("button", { name: "Open a run" }).click();

  // 5. The run's stage strip - on the DEMONSTRATION run, not the real one seeded above.
  dialog = step(dashboard, "A run walks its stages");
  await expect(dialog).toContainText("Step 5 of 13");
  await expect(bindDialog).toBeHidden();
  await expect.poll(() => hash(dashboard)).toContain("tour-demo");
  await expect(dashboard.locator(".wf-run-reader")).toContainText("Tour demo");
  const strip = dashboard.getByRole("group", { name: "Workflow run pipeline" });
  await expect(strip).toHaveCSS("outline-width", "2px");
  await shoot(dashboard, "05-run-pipeline");
  await dialog.getByRole("button", { name: "Next" }).click();

  // 6-7. The Evidence pane, then its readiness strip, on the frozen submission.
  dialog = step(dashboard, "Evidence is frozen first");
  await expect(dialog).toContainText("Step 6 of 13");
  await expect(dashboard.getByRole("tab", { name: /^Evidence/ }))
    .toHaveAttribute("aria-selected", "true");
  await expect(dashboard.getByRole("tabpanel")).toHaveCSS("outline-width", "2px");
  await dialog.getByRole("button", { name: "Next" }).click();

  dialog = step(dashboard, "Readiness comes before judges");
  await expect(dialog).toContainText("Step 7 of 13");
  const readiness = dashboard.locator(".wf-run-strip");
  await expect(readiness).toContainText("Readiness");
  await expect(readiness).toHaveCSS("outline-width", "2px");
  await dialog.getByRole("button", { name: "Next" }).click();

  // 8-9. Stage 1's command gate, then the first reviewer wave, resolved inside the strip.
  dialog = step(dashboard, "Commands fail fast");
  await expect(dialog).toContainText("Step 8 of 13");
  const firstStage = dashboard.locator(".wf-pipeline-slot").first();
  await expect(firstStage).toContainText("typecheck");
  await expect(firstStage).toHaveCSS("outline-width", "2px");
  await dialog.getByRole("button", { name: "Next" }).click();

  dialog = step(dashboard, "Personas judge the work");
  await expect(dialog).toContainText("Step 9 of 13");
  const judgeStage = dashboard.locator(".wf-pipeline-slot").nth(1);
  await expect(judgeStage).toContainText("Intent Conformance");
  await expect(judgeStage).toHaveCSS("outline-width", "2px");
  await dialog.getByRole("button", { name: "Next" }).click();

  // 10. The round scrubber, holding the seeded run's one round.
  dialog = step(dashboard, "Changes requested come back as rounds");
  await expect(dialog).toContainText("Step 10 of 13");
  const rounds = dashboard.getByRole("region", { name: "Rounds" });
  await expect(rounds).toContainText("Round 1");
  await expect(rounds).toHaveCSS("outline-width", "2px");
  await dialog.getByRole("button", { name: "Next" }).click();

  // 11. The stage holding the Pull Request action, found by its member kind.
  dialog = step(dashboard, "An action ships the pull request");
  await expect(dialog).toContainText("Step 11 of 13");
  const actionStage = dashboard
    .locator(".wf-pipeline-slot")
    .filter({ has: dashboard.locator(".is-session_action") });
  await expect(actionStage).toHaveCSS("outline-width", "2px");
  await dialog.getByRole("button", { name: "Open the final gate" }).click();

  // 12. Two beats of one gate: the fixed footer after End, then the Completion record -
  // which this cancelled run never earned, so the second beat says so instead of pointing
  // at a pane that is not offered.
  dialog = step(dashboard, "GitHub Inspector holds the door");
  await expect(dialog).toContainText("Step 12 of 13");
  const footer = dashboard.locator(".wf-pipeline-inspector");
  await expect(footer).toContainText("GitHub Inspector");
  await expect(footer).toHaveCSS("outline-width", "2px");
  await shoot(dashboard, "12-inspector-footer");
  await dialog.getByRole("button", { name: "Next" }).click();
  dialog = step(dashboard, "GitHub Inspector holds the door");
  await expect(dialog).toContainText("Step 12 of 13");
  await expect(dashboard.getByRole("tab", { name: /^Completion/ }))
    .toHaveAttribute("aria-selected", "true");
  await dialog.getByRole("button", { name: "Next" }).click();

  // 13. The state filter chips, and the tour hands the Runs page over.
  dialog = step(dashboard, "Where to watch");
  await expect(dialog).toContainText("Step 13 of 13");
  const chips = dashboard.getByRole("group", { name: "Filter runs by state" });
  await expect(chips.getByRole("button", { name: "Needs you" })).toBeVisible();
  await expect(chips).toHaveCSS("outline-width", "2px");
  await shoot(dashboard, "13-where-to-watch");
  await dialog.getByRole("button", { name: "Finish tour" }).click();

  await expect(dialog).toBeHidden();
  // The declared exit hands the Runs page over rather than replaying the snapshot route.
  // Focus is not asserted here: a palette start has a surviving invoker, and the engine
  // returns focus to it by design; `exit.focus` is only the landing when none survived.
  await expect.poll(() => hash(dashboard)).toContain("#/runs");

  // The tour added exactly the demonstration record - one run, one orphaned binding - and
  // touched nothing else: the real run is exactly as it was, and the dispatch it opened at
  // stop 2 never became a task.
  expect((await api<unknown[]>(daemon, "/api/workflow-bindings")).length).toBe(bindingsBefore + 1);
  const runs = await api<{ items?: Array<{ id: string }> } | Array<{ id: string }>>(
    daemon,
    "/api/workflow-runs",
  );
  const runList = Array.isArray(runs) ? runs : runs.items ?? [];
  expect(runList.length).toBe(2);
  expect(runList.some((run) => run.id.includes("tour-demo"))).toBe(true);
  const real = await api<{ run: { status: string } }>(daemon, `/api/workflow-runs/${realRunId}`);
  expect(real.run.status).toBe("cancelled");
});

test("an empty machine seeds the demonstration run, once, and walks it whole", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.emulateMedia({ reducedMotion: "reduce" });
  await dashboard.setViewportSize({ width: 1440, height: 900 });
  await dashboard.goto(`${daemon.baseURL}/#/settings/display`);
  await dashboard.getByRole("button", { name: "Start Follow the review tour" }).click();

  // The opener stands over the still-empty Runs page while the seed request is in flight.
  let dialog = step(dashboard, "Work gets reviewed");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Open Dispatch" }).click();

  // Dispatch always opens; the After work field needs no session.
  dialog = step(dashboard, "Dispatch picks the workflow");
  await expect(dashboard.getByRole("dialog", { name: "Dispatch an agent" })).toBeVisible();
  await dialog.getByRole("button", { name: "Open a session" }).click();

  // No session existed, so the tour started its own temporary conversation - the seeded
  // demo run deliberately fabricates none - and the chip stop spotlights its real desk.
  dialog = step(dashboard, "A binding pins the version");
  await expect(dialog).toContainText("Step 3 of 13");
  const chip = dashboard.locator(".workflow-bind-chip");
  await expect(chip).toBeVisible({ timeout: 60_000 });
  await expect(chip).toContainText("workflow");
  await expect(chip).toHaveCSS("outline-width", "2px");
  await shoot(dashboard, "22-preview-binding-chip");
  await dialog.getByRole("button", { name: "Open Bind workflow" }).click();

  dialog = step(dashboard, "Bind one yourself");
  const previewBindDialog = dashboard.getByRole("dialog", { name: "Bind workflow" });
  await expect(previewBindDialog).toBeVisible();
  await expect(previewBindDialog.getByLabel("Session")).toBeDisabled();
  await dialog.getByRole("button", { name: "Open a run" }).click();
  await expect(previewBindDialog).toBeHidden();

  // The daemon seeded its demonstration record, so the run chapter is REAL: a completed
  // No-Mistakes run named "Tour demo", every stage passed, and no session behind it.
  dialog = step(dashboard, "A run walks its stages");
  await expect(dialog).toContainText("Step 5 of 13");
  const strip = dashboard.getByRole("group", { name: "Workflow run pipeline" });
  await expect(strip).toBeVisible({ timeout: 30_000 });
  await expect(dashboard.getByRole("heading", { name: /No-Mistakes Review/ })).toBeVisible();
  // The reader header names the fabricated conversation by its durable session name.
  await expect(dashboard.locator(".wf-run-reader")).toContainText("Tour demo");
  await shoot(dashboard, "20-seeded-run-pipeline");
  await dialog.getByRole("button", { name: "Next" }).click();

  dialog = step(dashboard, "Evidence is frozen first");
  await expect(dashboard.getByRole("tab", { name: /^Evidence/ }))
    .toHaveAttribute("aria-selected", "true");
  await dialog.getByRole("button", { name: "Next" }).click();

  dialog = step(dashboard, "Readiness comes before judges");
  await expect(dashboard.locator(".wf-run-strip")).toContainText("Readiness");
  await dialog.getByRole("button", { name: "Next" }).click();

  // The seeded stage 1 records honest amber: its Commands were never executed.
  dialog = step(dashboard, "Commands fail fast");
  const firstStage = dashboard.locator(".wf-pipeline-slot").first();
  await expect(firstStage).toContainText("typecheck");
  await expect(firstStage).toContainText("Skipped");
  await dialog.getByRole("button", { name: "Next" }).click();

  dialog = step(dashboard, "Personas judge the work");
  const judgeStage = dashboard.locator(".wf-pipeline-slot").nth(1);
  await expect(judgeStage).toContainText("Intent Conformance");
  await expect(judgeStage).toContainText("Passed");
  await dialog.getByRole("button", { name: "Next" }).click();

  dialog = step(dashboard, "Changes requested come back as rounds");
  await expect(dashboard.getByRole("region", { name: "Rounds" })).toContainText("Round 1");
  await dialog.getByRole("button", { name: "Next" }).click();

  dialog = step(dashboard, "An action ships the pull request");
  await expect(
    dashboard.locator(".wf-pipeline-slot").filter({ has: dashboard.locator(".is-session_action") }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Open the final gate" }).click();

  // The seeded run carries a clean gate, so BOTH beats land: the strip's fixed footer,
  // then the real Completion pane.
  dialog = step(dashboard, "GitHub Inspector holds the door");
  await expect(dashboard.locator(".wf-pipeline-inspector")).toContainText("GitHub Inspector");
  await dialog.getByRole("button", { name: "Next" }).click();
  dialog = step(dashboard, "GitHub Inspector holds the door");
  await expect(dashboard.getByRole("tab", { name: /^Completion/ }))
    .toHaveAttribute("aria-selected", "true");
  await shoot(dashboard, "21-seeded-run-completion");
  await dialog.getByRole("button", { name: "Next" }).click();

  dialog = step(dashboard, "Where to watch");
  await expect(dashboard.getByRole("group", { name: "Filter runs by state" })).toBeVisible();
  await dialog.getByRole("button", { name: "Finish tour" }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => hash(dashboard)).toContain("#/runs");

  // Exactly one seeded run, no session and no task behind it, and the ask is idempotent:
  // a second seed answers with the same run rather than writing a sibling.
  const runs = await api<{ items?: Array<{ id: string; workflowId: string }> } | Array<{ id: string; workflowId: string }>>(
    daemon,
    "/api/workflow-runs",
  );
  const runList = Array.isArray(runs) ? runs : runs.items ?? [];
  expect(runList.length).toBe(1);
  expect(runList[0]!.workflowId).toBe(NO_MISTAKES);
  const again = await api<{ ok: boolean; runId: string; seeded: boolean }>(
    daemon,
    "/api/tours/workflows/seed-run",
    {},
  );
  expect(again.ok).toBe(true);
  expect(again.runId).toBe(runList[0]!.id);
  expect(again.seeded).toBe(false);

  // Finishing cleaned the temporary conversation up: its task is done, and no live session
  // remains on the fleet.
  await expect.poll(async () => {
    const tasks = await api<Array<{ title: string; status: string }>>(daemon, "/api/tasks");
    return tasks.map((task) => `${task.title}:${task.status}`);
  }, { timeout: 30_000 }).toEqual(["Tour conversation:done"]);
  await expect.poll(async () => (
    (await api<Array<{ state: string }>>(daemon, "/api/sessions"))
      .filter((session) => session.state !== "exited").length
  ), { timeout: 30_000 }).toBe(0);
});
