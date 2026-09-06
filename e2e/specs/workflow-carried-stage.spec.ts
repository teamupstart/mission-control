import { mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * A stage the round did not run because an earlier round already passed it.
 *
 * The reported defect, in the operator's words: a workflow passes several stages, fails, is
 * restarted, and the next round skips what already passed - but the reader "has to go look at
 * the prior round to verify they passed already". The screenshot behind it is a continuation
 * segment (`Round 1 · evidence 2`) whose untouched stages all read amber `Waiting` and whose
 * members all read `Not started`: a promise that a stage is about to run, made about a stage
 * that never will.
 *
 * What shipped instead is the neutral treatment: the chip reads `Not re-run` and speaks only
 * for the round on screen, where nothing executed, and the pass it carries is claimed by a
 * provenance line that NAMES the earlier round and links straight to it. The tick on that line
 * is the only green on a carried stage, because it is a claim about a different round.
 *
 * Only a browser can prove the part that matters. `test/workflow-runs-model.test.ts` pins the
 * derivation and `test/workflow-ladder-inspector-only.test.ts` pins the rendered shape, but
 * neither can run a real session action to completion, take the continuation the daemon
 * creates from it, and then CLICK the provenance line to prove the proof is one press away -
 * which is the entire complaint being answered.
 *
 * No model tokens: every reviewer is answered by `e2e/fixtures/fake-agents.ts`, which returns a
 * schema-valid pass verdict for any Persona whose published guidance carries `E2E_PASS_VERDICT`,
 * and the action's turn is taken by the same fake CLI the dispatch launched.
 */

const NODE = {
  session: "session-node",
  auditor: "auditor-node",
  steward: "steward-node",
  join: "join-node",
  action: "action-node",
  followUp: "follow-up-node",
  end: "end-node",
};

/** The two reviewers whose pass is CARRIED, and the one that runs in the continuation. */
const REVIEWER = {
  auditor: "E2E carried auditor",
  steward: "E2E carried steward",
  followUp: "E2E follow-up reviewer",
};

const ACTION = "Tidy before the follow-up";
const PROMPT = "# Tidy the workspace\n\nRemove the stray scratch file and say so.\n";
const WORKFLOW = "E2E carried stage";
const EVIDENCE = artifactsDir("workflow-carried-stage");

/** The label the earlier round wears in the scrubber, and the one the carried line must cite. */
const SOURCE_ROUND = "Round 1 · evidence 1";

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

/** Attach the daemon's own log on a miss: server-side failures are invisible to a trace. */
async function withDaemonLog<T>(daemon: DaemonHandle, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (caught) {
    // eslint-disable-next-line no-console
    console.log(`DAEMON LOG TAIL:\n${daemon.readLog().split("\n").slice(-80).join("\n")}`);
    throw caught;
  }
}

async function dispatch(page: Page, daemon: DaemonHandle): Promise<string> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?")
    .fill("hold a session for the carried stage spec");
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();

  // IDLE, not merely alive: evidence capture aborts if the transcript moves under it, and the
  // dispatch's own seeded turn is still being answered right after the card appears.
  let sessionId = "";
  await expect
    .poll(async () => {
      const sessions = await api<Array<{ id: string; state: string }>>(daemon, "/api/sessions");
      const live = sessions.find((session) => session.state !== "exited");
      sessionId = live?.id ?? "";
      return live?.state ?? "";
    }, { message: "the dispatched session should settle before the workflow is bound" })
    .toBe("idle");
  return sessionId;
}

interface RunDetail {
  run: { status: string };
  submissions: Array<{ id: string; round: number; segment: number }>;
  attempts: Array<{ nodeId: string; state: string; submissionId: string }>;
}

const detail = (daemon: DaemonHandle, runId: string): Promise<RunDetail> =>
  api<RunDetail>(daemon, `/api/workflow-runs/${runId}`);

/**
 * A real run over `Session -> two Personas -> join -> action -> a third Persona -> join -> End`.
 *
 * The action is what splits the round into two evidence segments, and the shape either side of
 * it is the point: the two reviewers ABOVE it earned their pass against the evidence of segment
 * 1 and are never asked again, while the reviewer BELOW it runs against the evidence captured
 * after the turn. That is exactly the screenshot's situation, reduced to the smallest graph that
 * still produces it.
 *
 * A third Persona rather than a Check for the downstream stage, because a `test` Check's outcome
 * depends on what the fixture repository has configured and this spec's claim must not.
 */
async function seedCarriedRun(page: Page, daemon: DaemonHandle): Promise<string> {
  const sessionId = await dispatch(page, daemon);
  const personaId = async (name: string): Promise<string> =>
    (await api<{ id: string }>(daemon, "/api/personas", {
      name,
      guidanceMarkdown: `# ${name}\n\nE2E_PASS_VERDICT`,
    })).id;
  const auditor = await personaId(REVIEWER.auditor);
  const steward = await personaId(REVIEWER.steward);
  const followUp = await personaId(REVIEWER.followUp);
  const action = await api<{ id: string }>(daemon, "/api/session-actions", {
    name: ACTION,
    description: "Tidy the workspace before the follow-up review",
    promptMarkdown: PROMPT,
    // The only adapter this build can prove; `pull_request` remains unpublishable.
    completion: { kind: "session_turn" },
  });

  const workflow = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", {
    name: WORKFLOW,
    draft: {
      nodes: [
        { id: NODE.session, kind: "session", position: { x: 0, y: 0 } },
        { id: NODE.auditor, kind: "persona", personaId: auditor, position: { x: 220, y: 0 } },
        { id: NODE.steward, kind: "persona", personaId: steward, position: { x: 220, y: 140 } },
        { id: NODE.join, kind: "all_pass", position: { x: 440, y: 70 } },
        {
          id: NODE.action,
          kind: "session_action",
          sessionActionId: action.id,
          position: { x: 660, y: 70 },
        },
        { id: NODE.followUp, kind: "persona", personaId: followUp, position: { x: 880, y: 70 } },
        { id: NODE.end, kind: "end", outcome: "Approved", position: { x: 1100, y: 70 } },
      ],
      edges: [
        { id: "e-auditor", source: NODE.session, sourcePort: "submitted", target: NODE.auditor, targetPort: "activate" },
        { id: "e-steward", source: NODE.session, sourcePort: "submitted", target: NODE.steward, targetPort: "activate" },
        { id: "e-auditor-pass", source: NODE.auditor, sourcePort: "pass", target: NODE.join, targetPort: "result" },
        { id: "e-auditor-fail", source: NODE.auditor, sourcePort: "fail", target: NODE.join, targetPort: "result" },
        { id: "e-steward-pass", source: NODE.steward, sourcePort: "pass", target: NODE.join, targetPort: "result" },
        { id: "e-steward-fail", source: NODE.steward, sourcePort: "fail", target: NODE.join, targetPort: "result" },
        { id: "e-join-pass", source: NODE.join, sourcePort: "pass", target: NODE.action, targetPort: "activate" },
        { id: "e-join-fail", source: NODE.join, sourcePort: "fail", target: NODE.session, targetPort: "return_for_changes" },
        { id: "e-complete", source: NODE.action, sourcePort: "complete", target: NODE.followUp, targetPort: "activate" },
        // Straight to the terminus: an all-pass Join needs two distinct predecessors, and this
        // stage deliberately holds one reviewer.
        { id: "e-follow-pass", source: NODE.followUp, sourcePort: "pass", target: NODE.end, targetPort: "terminal" },
        { id: "e-follow-fail", source: NODE.followUp, sourcePort: "fail", target: NODE.session, targetPort: "return_for_changes" },
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
    // Live, because a Preview binding parks the action forever and no continuation is ever cut.
    deliveryMode: "live",
  });
  const submitted = await api<{ run: { id: string } }>(
    daemon,
    `/api/workflow-bindings/${binding.id}/submit`,
    { requestId: "e2e-carried-stage" },
  );
  const runId = submitted.run.id;

  // Polled on the action attempt CLOSING rather than on a second submission row appearing: the
  // continuation reserves its segment BEFORE it captures, so a poll on `submissions.length`
  // wins the moment the row is reserved and reads the run mid-capture.
  await withDaemonLog(daemon, async () => {
    await expect
      .poll(async () => (await detail(daemon, runId)).attempts
        .find((attempt) => attempt.nodeId === NODE.action)?.state,
      { message: "the action's turn should finish and cut a continuation", timeout: 180_000 })
      .toBe("completed");
  });
  await withDaemonLog(daemon, async () => {
    await expect
      .poll(async () => (await detail(daemon, runId)).run.status,
        { message: "the follow-up reviewer should approve and finish the run", timeout: 120_000 })
      .toBe("completed");
  });

  // The durable shape the reading below depends on, asserted before any of it is read: two
  // segments in ONE round, the carried reviewers' only attempts in the first, and the follow-up
  // reviewer's only attempt in the second.
  const finished = await detail(daemon, runId);
  const [parent, child] = finished.submissions;
  expect(finished.submissions).toHaveLength(2);
  expect(parent!.segment).toBe(0);
  expect(child!.segment).toBe(1);
  expect(child!.round).toBe(parent!.round);
  for (const nodeId of [NODE.auditor, NODE.steward]) {
    const own = finished.attempts.filter((attempt) => attempt.nodeId === nodeId);
    expect(own).toHaveLength(1);
    expect(own[0]!.submissionId).toBe(parent!.id);
  }
  const follow = finished.attempts.filter((attempt) => attempt.nodeId === NODE.followUp);
  expect(follow).toHaveLength(1);
  expect(follow[0]!.submissionId).toBe(child!.id);

  return runId;
}

test("a carried stage names the round it passed in, and goes there in one press", async ({
  dashboard,
  daemon,
}) => {
  test.setTimeout(360_000);
  // Live delivery is two real gates: the machine-wide switch, and this exact repository named.
  await api(daemon, "/api/workflows/config", {
    liveEnabled: true,
    repoAllowlist: [daemon.repo],
  }, "PUT");

  const runId = await seedCarriedRun(dashboard, daemon);
  await dashboard.goto(`${daemon.baseURL}/#/runs/${runId}`);

  // ONE tile for the one repair round, with its two captures listed in the tray below it:
  // the continuation cost no repair budget, and a second tile beside the first is how the
  // strip used to claim it had. The `Round 1 · evidence N` wording survives where it belongs
  // - on the carried line below that cites the round it inherited from.
  const scrubber = dashboard.getByRole("group", { name: "Select a round" });
  await expect(scrubber.locator(".wf-run-round-name")).toHaveText(["Round 1"]);
  await expect(scrubber.locator(".wf-run-round-count")).toHaveText("2 evidence");
  const snapshots = dashboard.getByRole("group", { name: "Select evidence in round 1" });
  await expect(snapshots.locator(".wf-run-tray-chip")).toHaveCount(2);
  // The run opens on the newest segment, which is the one holding the carried stage.
  await expect(snapshots.getByRole("button", { name: /evidence 2/ }))
    .toHaveAttribute("aria-pressed", "true");

  const carriedStage = dashboard.locator(".wf-pipeline-stage")
    .filter({ hasText: REVIEWER.auditor });
  await expect(carriedStage).toHaveCount(1);

  // THE REGRESSION. This chip read amber `Waiting` and these rows read `Not started` - a stage
  // announcing itself as about to run, in the one round that will never run it.
  await expect(carriedStage.locator(".wf-pipeline-stage-head .wf-pipeline-status"))
    .toHaveText("Not re-run");
  for (const name of [REVIEWER.auditor, REVIEWER.steward]) {
    const member = carriedStage.locator("li.wf-pipeline-reviewer").filter({ hasText: name });
    await expect(member.locator(".wf-pipeline-status")).toHaveText("Not re-run");
  }
  // And it is NEUTRAL, never the pass tone: nothing in this round executed, so a green chip
  // would credit the stage with work this segment never gave it.
  await expect(carriedStage.locator(".wf-pipeline-stage-head .wf-pipeline-status"))
    .toHaveClass(/workflow-stopped/);

  // The ACTION is not carried, and that is the boundary worth pinning. It keeps its own
  // lifecycle word, because an action judges nothing and must never be handed a pass
  // vocabulary - and because this segment exists precisely because it completed. A carried
  // treatment here would answer "did it pass?" about the one node that never passes anything.
  const actionRow = dashboard.locator("li.wf-pipeline-reviewer").filter({ hasText: ACTION });
  await expect(actionRow.locator(".wf-pipeline-status")).toHaveText("Complete");
  await expect(actionRow.locator(".wf-pipeline-status")).not.toHaveClass(/workflow-stopped/);
  if (process.env.MC_E2E_EVIDENCE) {
    // eslint-disable-next-line no-console
    console.log(`OBSERVED the carried stage reads "Not re-run" in ${"Round 1 · evidence 2"}, neutral rather than green`);
  }

  // The answer to "did it pass, and where do I see it?" is ON the card, naming the round.
  const provenance = carriedStage.getByRole("button", {
    name: `Passed in ${SOURCE_ROUND}. Show that round.`,
  });
  await expect(provenance).toBeVisible();
  await expect(provenance).toContainText(`Passed in ${SOURCE_ROUND}`);
  if (process.env.MC_E2E_EVIDENCE) {
    mkdirSync(EVIDENCE, { recursive: true });
    await dashboard.screenshot({ path: `${EVIDENCE}01-carried-stage-run-view.png`, fullPage: true });
    // eslint-disable-next-line no-console
    console.log("CAPTURED e2e/.artifacts/workflow-carried-stage/01-carried-stage-run-view.png");
    // The strip on its own, at the scale the chip and the provenance line are actually read.
    // The full page above proves the placement; this is the frame a reviewer can judge the
    // treatment on - grey chip, dimmed card, one green tick.
    await dashboard.locator(".wf-pipeline-strip")
      .screenshot({ path: `${EVIDENCE}01a-carried-stage-strip.png` });
    // eslint-disable-next-line no-console
    console.log("CAPTURED e2e/.artifacts/workflow-carried-stage/01a-carried-stage-strip.png");
  }

  // ...and it is one PRESS from the proof, which is the whole complaint. Before this the reader
  // had to leave the round, find the earlier one in the scrubber, and read it there.
  await provenance.click();
  await expect(snapshots.getByRole("button", { name: /evidence 1/ }))
    .toHaveAttribute("aria-pressed", "true");
  // ...and the chip it left is released, so the tray names one open capture and not two.
  await expect(snapshots.locator(".wf-run-tray-chip[aria-pressed='true']")).toHaveCount(1);
  // The same stage, in the round that earned it, showing the outcome the line promised.
  await expect(carriedStage.locator(".wf-pipeline-stage-head .wf-pipeline-status"))
    .toHaveText("All passed");
  for (const name of [REVIEWER.auditor, REVIEWER.steward]) {
    const member = carriedStage.locator("li.wf-pipeline-reviewer").filter({ hasText: name });
    await expect(member.locator(".wf-pipeline-status")).toHaveText("Passed");
  }
  // Nothing is carried in the round that ran everything, so the line is gone rather than
  // pointing a reader at the round they are already reading.
  await expect(carriedStage.getByRole("button", { name: /Show that round/ })).toHaveCount(0);
  if (process.env.MC_E2E_EVIDENCE) {
    await dashboard.screenshot({ path: `${EVIDENCE}02-source-round-proof.png`, fullPage: true });
    // eslint-disable-next-line no-console
    console.log(`CAPTURED e2e/.artifacts/workflow-carried-stage/02-source-round-proof.png`);
  }
});

test("the Board card shows what was carried and still points at the active stage", async ({
  dashboard,
  daemon,
}) => {
  test.setTimeout(360_000);
  await api(daemon, "/api/workflows/config", {
    liveEnabled: true,
    repoAllowlist: [daemon.repo],
  }, "PUT");

  await seedCarriedRun(dashboard, daemon);

  await api(daemon, "/api/ui/config", { layout: "board" }, "PUT");
  await dashboard.setViewportSize({ width: 1440, height: 900 });
  await dashboard.goto(`${daemon.baseURL}/#/fleet`);
  await dashboard.reload();

  const peek = dashboard.locator(".wf-tile-peek");
  await expect(peek).toBeVisible();

  // The whole-pipeline default keeps the carried stage visible and neutral instead of spending
  // a separate summary line on it. The stage's accessible status retains the semantic boundary:
  // it was not re-run in this round, while its completed width is shown with the carried hatch.
  const carried = peek.getByRole("img", { name: "Stage 1: Not re-run" });
  await expect(carried).toBeVisible();
  await expect(carried).toHaveClass(/workflow-stopped/);
  await expect(carried).toHaveClass(/is-degraded/);

  // The active caption and current marker still point at the downstream reviewer, not the
  // attempt-less carried stage that used to sort ahead of it as amber waiting work.
  const followUp = peek.getByRole("img", { name: `${REVIEWER.followUp}: Passed` });
  await expect(followUp).toHaveClass(/is-now/);
  await expect(peek.locator(".wf-stage-caption strong")).toHaveText(REVIEWER.followUp);
  await expect(carried).not.toHaveClass(/is-now/);
  if (process.env.MC_E2E_EVIDENCE) {
    mkdirSync(EVIDENCE, { recursive: true });
    await dashboard.screenshot({ path: `${EVIDENCE}03-board-card-carried.png`, fullPage: true });
    // eslint-disable-next-line no-console
    console.log("CAPTURED e2e/.artifacts/workflow-carried-stage/03-board-card-carried.png");
  }
});
