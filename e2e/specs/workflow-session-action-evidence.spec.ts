import { mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * The pull-request screenshots under `e2e/.artifacts/workflow-session-action-authoring/`.
 *
 * Behind `MC_E2E_EVIDENCE`, and gitignored, for `dispatch-and-converse.spec.ts`' reason: every
 * capture here carries a fresh worktree uuid and a relative timestamp, so an unconditional
 * run would rewrite five binaries on every `npm run test:e2e` for no added signal.
 *
 * A REAL daemon rather than a component fixture, because the thing worth photographing is the
 * whole surface an operator sees - the catalog arriving over SSE, a published version's stage
 * chain, and a live run parked on an action - and none of those exist in a props object. It
 * carries no operator data: the repository, the session and the actions are all seeded by
 * this file.
 *
 * Each capture is taken twice: at 1440 and at 720, the Electron window's own minimum width.
 * The narrow pass is the assertion that matters - it is where a stage strip, a four-field
 * editor and a three-pane builder have to stay reachable rather than merely not crash.
 */

const EVIDENCE = artifactsDir("workflow-session-action-authoring");
const PROMPT = "# Tidy the workspace\n\nRemove the stray scratch file and say so.\n";

async function api<T>(daemon: DaemonHandle, path: string, body?: unknown, method?: string): Promise<T> {
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

async function shoot(page: Page, name: string): Promise<void> {
  mkdirSync(EVIDENCE, { recursive: true });
  // Off every control first. `Tooltip` portals a visible bubble on hover, and a capture taken
  // with the pointer resting where the last click left it covers the thing being photographed.
  await page.mouse.move(0, 0);
  for (const [suffix, width] of [["wide", 1440], ["narrow", 720]] as const) {
    await page.setViewportSize({ width, height: 900 });
    // One frame for the layout to settle after the resize; the strip re-measures its scroll.
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${EVIDENCE}${name}-${suffix}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

test("capture the authoring and run surfaces", async ({ dashboard, daemon }) => {
  test.skip(!process.env.MC_E2E_EVIDENCE, "set MC_E2E_EVIDENCE=1 to regenerate the screenshots");
  test.setTimeout(360_000);

  const action = await api<{ id: string }>(daemon, "/api/session-actions", {
    name: "Tidy the workspace",
    description: "Remove the stray scratch files before review",
    promptMarkdown: PROMPT,
    completion: { kind: "session_turn" },
  });
  await api(daemon, "/api/session-actions", {
    name: "Push the branch",
    description: "Commit and push what was reviewed",
    promptMarkdown: "# Push\n\nPush the branch.\n",
    requiredSkillId: "pull-request",
    completion: { kind: "session_turn" },
  });
  const persona = await api<{ id: string }>(daemon, "/api/personas", {
    name: "Intent Conformance",
    guidanceMarkdown: "# Judge\n\nE2E_PASS_VERDICT\n",
    runner: null,
    model: null,
  });

  // 1. The library: a built-in beside two operator rows, and one open in the editor.
  await dashboard.goto(`${daemon.baseURL}/#/workflows/actions`);
  await dashboard.getByRole("button", { name: /Tidy the workspace/ }).click();
  await expect(dashboard.locator(".wf-action-editor")).toBeVisible();
  await shoot(dashboard, "01-actions-library");

  // 1b. The revision conflict, mid-recovery. Photographed rather than described because the
  //     claim is about what an operator can SEE at the moment two tabs disagree: their own
  //     text still in the editor, the revision that overtook them named, and all three ways
  //     out offered rather than the two that cannot land an edit on this row.
  const promptEditor = dashboard.locator(".wf-action-editor-host .cm-content");
  await promptEditor.click();
  await dashboard.keyboard.press("ControlOrMeta+a");
  await promptEditor.pressSequentially("# My unsaved instruction");
  await expect(dashboard.locator(".wf-state.dirty")).toHaveText("Unsaved changes");
  // The other tab saves first, touching a DIFFERENT field - which is what makes the reapply
  // below a merge rather than an overwrite.
  await api(daemon, `/api/session-actions/${action.id}`, {
    expectedRevision: 1,
    description: "edited in another tab",
  }, "PATCH");
  await expect(dashboard.locator(".wf-state.conflict")).toContainText("r2");
  await shoot(dashboard, "01b-conflict-recovery");

  // Left resolved, so the frames that follow are not photographed through a stale banner.
  await dashboard.getByRole("button", { name: "Reload latest" }).click();
  await expect(dashboard.locator(".wf-state.conflict")).toHaveCount(0);

  const workflow = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", {
    name: "Ship it",
    draft: {
      nodes: [
        { id: "s", kind: "session", position: { x: 0, y: 0 } },
        { id: "p", kind: "persona", personaId: persona.id, position: { x: 240, y: 0 } },
        { id: "a", kind: "session_action", sessionActionId: action.id, position: { x: 480, y: 0 } },
        { id: "c", kind: "check", slot: "test", position: { x: 720, y: 0 } },
        { id: "e", kind: "end", outcome: "Approved", position: { x: 960, y: 0 } },
      ],
      edges: [
        { id: "e1", source: "s", sourcePort: "submitted", target: "p", targetPort: "activate" },
        { id: "e2", source: "p", sourcePort: "pass", target: "a", targetPort: "activate" },
        { id: "e3", source: "p", sourcePort: "fail", target: "s", targetPort: "return_for_changes" },
        { id: "e4", source: "a", sourcePort: "complete", target: "c", targetPort: "activate" },
        { id: "e5", source: "c", sourcePort: "pass", target: "e", targetPort: "terminal" },
        { id: "e6", source: "c", sourcePort: "fail", target: "s", targetPort: "return_for_changes" },
      ],
    },
    completionPolicy: { kind: "inspector", onFindings: "restart_workflow", missingPrAction: "wait" },
  });

  // 2. The pipeline, at both ends of a strip too wide for one screen: the action stage among
  //    its neighbours, and the fixed Inspector footer past End.
  await dashboard.goto(`${daemon.baseURL}/#/workflows`);
  await dashboard.getByRole("button", { name: /Ship it/ }).click();
  await expect(dashboard.locator(".wf-pipeline-strip")).toBeVisible();
  await shoot(dashboard, "02-pipeline-action-stage");
  await dashboard.locator(".wf-pipeline-strip").evaluate((el) => { el.scrollLeft = el.scrollWidth; });
  await shoot(dashboard, "03-pipeline-inspector-footer");

  // 3. The graph: the node's one `complete` port, and the rail that repoints and removes it.
  await dashboard.getByRole("button", { name: "Graph", exact: true }).click();
  await dashboard.locator('[data-node-kind="session_action"]').click();
  await shoot(dashboard, "04-graph-action-node");

  // 4. A live run parked on the action, which is the state the run vocabulary exists for.
  await api(daemon, "/api/workflows/config", { liveEnabled: true, repoAllowlist: [daemon.repo] }, "PUT");
  await dashboard.goto(`${daemon.baseURL}/#/fleet`);
  await dashboard.getByRole("button", { name: "Dispatch" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await dashboard.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill("hold a session for the evidence run");
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  let sessionId = "";
  await expect.poll(async () => {
    const sessions = await api<Array<{ id: string; state: string }>>(daemon, "/api/sessions");
    const live = sessions.find((session) => session.state !== "exited");
    sessionId = live?.id ?? "";
    return live?.state ?? "";
  }, { timeout: 120_000 }).toBe("idle");

  const version = await api<{ version: { id: string } }>(
    daemon,
    `/api/workflows/${workflow.workflow.id}/publish`,
    { expectedDraftRevision: 1 },
  );
  const binding = await api<{ id: string }>(daemon, "/api/workflow-bindings", {
    workflowVersionId: version.version.id,
    sessionId,
    // Preview, so the run parks on `awaiting_send` and holds still for a photograph. Live
    // would race the fake agent's own turn.
    deliveryMode: "preview",
  });
  const run = await api<{ run: { id: string } }>(
    daemon,
    `/api/workflow-bindings/${binding.id}/submit`,
    { requestId: "evidence" },
  );
  await expect.poll(
    async () => (await api<{ run: { status: string } }>(daemon, `/api/workflow-runs/${run.run.id}`)).run.status,
    { timeout: 120_000 },
  ).toBe("waiting_for_action");

  await dashboard.goto(`${daemon.baseURL}/#/runs/${run.run.id}`);
  await expect(dashboard.locator("article.wf-run-action")).toBeVisible();
  await shoot(dashboard, "05-run-waiting-on-action");

  // 5. The Board ladder, where the same run is read as one vertical chain.
  await api(daemon, "/api/ui/config", { layout: "board" }, "PUT");
  await dashboard.goto(`${daemon.baseURL}/#/fleet`);
  await dashboard.reload();
  await dashboard.getByRole("button", { name: "Show full workflow" }).click();
  await expect(dashboard.locator(".wf-ladder-rung.is-fixed")).toBeVisible();
  await shoot(dashboard, "06-board-ladder");

  // 6. The published snapshot, after the live action has moved on AND been retired. This is
  //    the surface that proves immutability, and it can only be photographed by making the
  //    catalog disagree with the version first: edit the action, then archive it, then read
  //    back a version that still holds neither change.
  await api(daemon, `/api/session-actions/${action.id}`, {
    expectedRevision: 2,
    promptMarkdown: "# Tidy the workspace\n\nRewritten AFTER the version was published.\n",
  }, "PATCH");
  await api(daemon, `/api/session-actions/${action.id}`, { expectedRevision: 3 }, "DELETE");

  // Back off the Board, so the builder rail is on screen rather than the tile columns.
  await api(daemon, "/api/ui/config", { layout: "grid" }, "PUT");
  await dashboard.goto(`${daemon.baseURL}/#/workflows`);
  await dashboard.reload();
  await dashboard.getByRole("button", { name: /Ship it/ }).click();
  await dashboard.getByRole("button", { name: /Version 1/ }).click();
  const snapshot = dashboard.locator("details.workflow-version-persona")
    .filter({ hasText: "Tidy the workspace" });
  await snapshot.locator("summary").click();
  // Both indicators at once: the source's text moved on, and the source is gone from the
  // catalog. Neither reached the version.
  await expect(snapshot).toContainText("outdated");
  await expect(snapshot).toContainText("archived source");
  await expect(snapshot.locator("pre")).toContainText("Remove the stray scratch file and say so.");
  await snapshot.scrollIntoViewIfNeeded();
  await shoot(dashboard, "07-published-snapshot-outdated");
});

/**
 * A run that actually FINISHED its action, which the capture above cannot be.
 *
 * That one binds Preview on purpose, so it parks at `awaiting_send` and holds still long
 * enough to photograph the wait vocabulary. The price is that it can never show the other
 * half of the model: a completed turn, the fresh evidence it captured, and the second segment
 * living inside the same repair round. This is a Live binding, driven to completion.
 *
 * Its own test rather than more steps on the one above, because each test gets its own daemon
 * and this one needs a session that is free to pick an instruction up rather than one already
 * parked on a Preview packet.
 */
test("capture a completed continuation", async ({ dashboard, daemon }) => {
  test.skip(!process.env.MC_E2E_EVIDENCE, "set MC_E2E_EVIDENCE=1 to regenerate the screenshots");
  test.setTimeout(360_000);

  // Live delivery is two gates and both are real: the machine-wide switch, and this exact
  // repository being named.
  await api(daemon, "/api/workflows/config", {
    liveEnabled: true,
    repoAllowlist: [daemon.repo],
  }, "PUT");

  const action = await api<{ id: string }>(daemon, "/api/session-actions", {
    name: "Tidy the workspace",
    description: "Remove the stray scratch files before review",
    promptMarkdown: PROMPT,
    completion: { kind: "session_turn" },
  });

  await dashboard.goto(`${daemon.baseURL}/#/fleet`);
  await dashboard.getByRole("button", { name: "Dispatch" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await dashboard.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill("hold a session for the continuation");
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  // IDLE, not merely alive: evidence capture aborts if the transcript moves under it, and the
  // dispatch's own seeded turn is still being answered right after the card appears.
  let sessionId = "";
  await expect.poll(async () => {
    const sessions = await api<Array<{ id: string; state: string }>>(daemon, "/api/sessions");
    const live = sessions.find((session) => session.state !== "exited");
    sessionId = live?.id ?? "";
    return live?.state ?? "";
  }, { timeout: 120_000 }).toBe("idle");

  // A downstream Check, so the frame shows what the continuation is FOR: a stage that runs
  // against the evidence captured after the action, not the evidence above it.
  const workflow = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", {
    name: "Tidy then check",
    draft: {
      nodes: [
        { id: "s", kind: "session", position: { x: 0, y: 0 } },
        { id: "a", kind: "session_action", sessionActionId: action.id, position: { x: 240, y: 0 } },
        { id: "c", kind: "check", slot: "test", position: { x: 480, y: 0 } },
        { id: "e", kind: "end", outcome: "Approved", position: { x: 720, y: 0 } },
      ],
      edges: [
        { id: "e1", source: "s", sourcePort: "submitted", target: "a", targetPort: "activate" },
        { id: "e2", source: "a", sourcePort: "complete", target: "c", targetPort: "activate" },
        { id: "e3", source: "c", sourcePort: "pass", target: "e", targetPort: "terminal" },
        { id: "e4", source: "c", sourcePort: "fail", target: "s", targetPort: "return_for_changes" },
      ],
    },
  });
  const version = await api<{ version: { id: string } }>(
    daemon,
    `/api/workflows/${workflow.workflow.id}/publish`,
    { expectedDraftRevision: 1 },
  );
  const binding = await api<{ id: string }>(daemon, "/api/workflow-bindings", {
    workflowVersionId: version.version.id,
    sessionId,
    deliveryMode: "live",
  });
  const run = await api<{ run: { id: string } }>(
    daemon,
    `/api/workflow-bindings/${binding.id}/submit`,
    { requestId: "evidence-continuation" },
  );

  // Polled on the action attempt CLOSING rather than on the child row appearing: the
  // continuation reserves its segment before it captures, so a poll on `submissions.length`
  // wins the moment the row is reserved and photographs the run mid-capture.
  await expect.poll(async () => {
    const detail = await api<{ attempts: Array<{ nodeId: string; state: string }> }>(
      daemon,
      `/api/workflow-runs/${run.run.id}`,
    );
    return detail.attempts.find((attempt) => attempt.nodeId === "a")?.state;
  }, { timeout: 180_000 }).toBe("completed");

  await dashboard.goto(`${daemon.baseURL}/#/runs/${run.run.id}`);
  // Two entries under ONE repair round, and the sentence saying the second cost no round.
  await expect(dashboard.getByRole("group", { name: "Select a round" }).locator(".wf-run-round-name"))
    .toHaveText(["Round 1 · evidence 1", "Round 1 · evidence 2"]);
  await expect(dashboard.locator(".wf-run-notice"))
    .toContainText("does not spend a repair round");
  await shoot(dashboard, "08-completed-continuation");

  // 9. The shipped Pull Request action, read-only.
  //
  //    The two fields it exists for are visible together - its required skill and the
  //    completion it promises - and both are disabled, because a built-in has no save.
  await dashboard.goto(`${daemon.baseURL}/#/workflows/actions`);
  await dashboard.getByRole("button", { name: /Pull Request/ }).click();
  await expect(dashboard.locator(".wf-state.builtin")).toBeVisible();
  await shoot(dashboard, "09-builtin-pull-request-action");

  // 10. No-Mistakes Review v8, scrolled to where its claim lives.
  //
  //     The Pull Request stage, then End, then the fixed Inspector footer, in that order. That
  //     ordering IS the feature: the action opens the pull request and reaches End, and the
  //     Inspector reviews it afterwards. A capture that showed the footer looking finished the
  //     moment the action completed would be the misreading to catch.
  await dashboard.goto(`${daemon.baseURL}/#/workflows`);
  await dashboard.getByRole("button", { name: /No-Mistakes Review/ }).click();
  await expect(dashboard.locator(".wf-pipeline-strip")).toBeVisible();
  await dashboard.locator(".wf-pipeline-strip").evaluate((el) => { el.scrollLeft = el.scrollWidth; });
  await expect(dashboard.locator("li.wf-pipeline-reviewer").filter({ hasText: "Pull Request" }))
    .toBeVisible();
  await shoot(dashboard, "10-no-mistakes-v8-pull-request-stage");
});
