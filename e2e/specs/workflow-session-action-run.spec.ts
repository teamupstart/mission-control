import { mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * A published session action, executed end to end against a real daemon and a real session.
 *
 * This is the proof no other layer can give. The `node:test` runtime suite drives the real
 * Registry, store, engine and manager - but it stubs the pane, so the packet never leaves the
 * process. Here the dispatch cuts a real git worktree, the session is a real SDK-runtime
 * session with a real child process behind it, the action's instruction is really typed into
 * it through the real delivery path, and the continuation segment is captured from a real
 * `git` read of that worktree.
 *
 * Two things are being proved, and they are the two the phase turns on:
 *
 *  - LIVE types the exact authored instruction once, the session's turn is observed, and the
 *    run resumes downstream on a fresh child segment inside the same repair round;
 *  - PREVIEW prepares the identical packet and types NOTHING, however settled the session
 *    afterwards becomes.
 *
 * The action is a `session_turn` one, because that is the adapter this build can prove. A
 * `pull_request` graph is still refused at Publish, which `workflow-session-action.spec.ts`
 * pins beside its hidden-authoring assertions.
 */

const NODE = { session: "session-node", action: "action-node", end: "end-node" };
const PROMPT = "# Tidy the workspace\n\nRemove the stray scratch file and say so.\n";
const SHORTCUT_EVIDENCE = artifactsDir("board-workflow-shortcut");

/** Capture the two asserted Board states without rewriting evidence on an ordinary run. */
async function captureBoardShortcut(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(SHORTCUT_EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${SHORTCUT_EVIDENCE}${name}.png`, fullPage: true });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/board-workflow-shortcut/${name}.png`);
}

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

/** Dispatch one agent from the modal - the sanctioned way to get a live, bindable session. */
async function dispatch(page: Page, daemon: DaemonHandle): Promise<string> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill("hold a session for the action spec");
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();

  // IDLE, not merely alive: evidence capture aborts with `conversation_changed` if the
  // transcript moves under it, and the dispatch's seeded first turn is still being answered
  // right after the card appears.
  let sessionId = "";
  await expect
    .poll(async () => {
      const sessions = await api<Array<{ id: string; state: string }>>(daemon, "/api/sessions");
      const live = sessions.find((session) => session.state !== "exited");
      sessionId = live?.id ?? "";
      return live?.state ?? "";
    }, { message: "the dispatched session should settle to idle before evidence capture" })
    .toBe("idle");
  return sessionId;
}

interface RunHandle {
  runId: string;
  sessionId: string;
  actionName: string;
}

/**
 * Publish `Session -> action -> End`, bind the live session, and submit.
 *
 * Every step goes through the routes the dashboard uses. Nothing is seeded into SQLite: a
 * fixture that writes a row proves the row, not the path an operator takes to it.
 */
async function seedActionRun(
  page: Page,
  daemon: DaemonHandle,
  deliveryMode: "live" | "preview",
): Promise<RunHandle> {
  const sessionId = await dispatch(page, daemon);
  const actionName = `Tidy ${deliveryMode}`;
  const action = await api<{ id: string }>(daemon, "/api/session-actions", {
    name: actionName,
    description: "Tidy the workspace",
    promptMarkdown: PROMPT,
    // The only adapter this build can prove. `pull_request` remains unpublishable.
    completion: { kind: "session_turn" },
  });
  const workflow = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", {
    name: `E2E action run ${deliveryMode}`,
    draft: {
      nodes: [
        { id: NODE.session, kind: "session", position: { x: 0, y: 0 } },
        { id: NODE.action, kind: "session_action", sessionActionId: action.id, position: { x: 240, y: 0 } },
        { id: NODE.end, kind: "end", outcome: "Approved", position: { x: 480, y: 0 } },
      ],
      edges: [
        { id: "e-submit", source: NODE.session, sourcePort: "submitted", target: NODE.action, targetPort: "activate" },
        { id: "e-complete", source: NODE.action, sourcePort: "complete", target: NODE.end, targetPort: "terminal" },
      ],
    },
  });
  // The gate this phase opens: a `session_turn` graph publishes where a `pull_request` one
  // is still refused.
  const published = await api<{ version: { id: string } }>(
    daemon,
    `/api/workflows/${workflow.workflow.id}/publish`,
    { expectedDraftRevision: 1 },
  );
  const binding = await api<{ id: string }>(daemon, "/api/workflow-bindings", {
    workflowVersionId: published.version.id,
    sessionId,
    deliveryMode,
  });
  const submitted = await api<{ run: { id: string } }>(
    daemon,
    `/api/workflow-bindings/${binding.id}/submit`,
    { requestId: `e2e-action-${deliveryMode}` },
  );
  return { runId: submitted.run.id, sessionId, actionName };
}

interface RunDetail {
  run: { status: string; currentPhase: string };
  summary: { round: number; segment?: number; actionWait?: string | null };
  submissions: Array<{
    id: string;
    round: number;
    segment: number;
    parentSubmissionId: string | null;
    continuationNodeId: string | null;
    continuationNodeAttemptId: string | null;
  }>;
  attempts: Array<{ id: string; nodeId: string; state: string; submissionId: string }>;
  receipts: Array<{ submissionId: string; edgeId: string; sourceAttemptId: string }>;
  deliveries: Array<{ id: string; kind: string; state: string; payload: string; nodeAttemptId: string | null }>;
}

const detail = (daemon: DaemonHandle, runId: string): Promise<RunDetail> =>
  api<RunDetail>(daemon, `/api/workflow-runs/${runId}`);

/** Attach the daemon's own structured log on a miss: server-side failures are invisible to a trace. */
async function withDaemonLog<T>(daemon: DaemonHandle, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (caught) {
    // eslint-disable-next-line no-console
    console.log(`DAEMON LOG TAIL:\n${daemon.readLog().split("\n").slice(-80).join("\n")}`);
    throw caught;
  }
}

test("Live types the authored instruction once and resumes on a fresh child segment", async ({
  dashboard,
  daemon,
}) => {
  // Live delivery is two gates, and both are real: the machine-wide switch, and this exact
  // repository being named. Without the allowlist the packet is prepared and refused with
  // `live_not_authorized`, which is the correct behaviour and not the one under test.
  await api(daemon, "/api/workflows/config", {
    liveEnabled: true,
    repoAllowlist: [daemon.repo],
  }, "PUT");

  const { runId, sessionId, actionName } = await seedActionRun(dashboard, daemon, "live");

  await withDaemonLog(daemon, async () => {
    await expect
      .poll(async () => (await detail(daemon, runId)).deliveries
        .filter((item) => item.kind === "session_action" && item.state === "delivered").length,
      { message: "the action packet should be typed into the bound session", timeout: 60_000 })
      .toBe(1);
  });

  const sent = await detail(daemon, runId);
  const packet = sent.deliveries.find((item) => item.kind === "session_action")!;
  const waiting = sent.attempts.find((item) => item.nodeId === NODE.action)!;
  // Durably linked to the attempt that owns it, and carrying the exact authored Markdown
  // after a small envelope - not a summary the daemon composed.
  expect(packet.nodeAttemptId).toBe(waiting.id);
  expect(packet.payload).toContain(`Mission Control session action: ${actionName}`);
  expect(packet.payload.endsWith(PROMPT)).toBe(true);
  // Its own run status, so nothing mistakes an action turn for a parked repair round.
  expect(sent.run.status).toBe("waiting_for_action");
  expect(sent.run.currentPhase).toBe("session_action");

  // The real session really picks it up and finishes the turn, which is what the observer
  // waits for. Nothing here nudges the daemon: the pickup comes off the session's own
  // lifecycle, and the settle off `settledIdle`.
  // Polled on the action attempt CLOSING, not on the child row appearing. The continuation
  // reserves its segment before it captures - deliberately, so "exactly one child" is a
  // database fact rather than a promise about timing - so a poll on `submissions.length`
  // would win the moment the row is reserved and read the attempt mid-capture.
  await withDaemonLog(daemon, async () => {
    await expect
      .poll(async () => (await detail(daemon, runId)).attempts
        .find((item) => item.nodeId === NODE.action)?.state,
      { message: "the finished action turn should complete its attempt", timeout: 120_000 })
      .toBe("completed");
  });

  const continued = await detail(daemon, runId);
  const [parent, child] = continued.submissions;
  // A SEGMENT inside the same repair round, never a new round: an action spends no budget.
  expect(child!.round).toBe(parent!.round);
  expect(child!.segment).toBe(1);
  expect(parent!.segment).toBe(0);
  expect(child!.parentSubmissionId).toBe(parent!.id);
  expect(child!.continuationNodeId).toBe(NODE.action);
  expect(child!.continuationNodeAttemptId).toBe(waiting.id);
  expect(continued.summary.round).toBe(1);
  expect(continued.summary.segment).toBe(1);

  // ONE completed action attempt, still scoped to the parent evidence it ran against.
  const actionAttempts = continued.attempts.filter((item) => item.nodeId === NODE.action);
  expect(actionAttempts).toHaveLength(1);
  expect(actionAttempts[0]!.state).toBe("completed");
  expect(actionAttempts[0]!.submissionId).toBe(parent!.id);

  // Only the action's own `complete` route is seeded into the child, sourced from the parent's
  // attempt - the one deliberate cross-submission link - and Session is NOT re-submitted.
  const childReceipts = continued.receipts.filter((item) => item.submissionId === child!.id);
  expect(childReceipts.map((item) => item.edgeId)).toEqual(["e-complete"]);
  expect(childReceipts[0]!.sourceAttemptId).toBe(waiting.id);

  // Exactly one packet ever reached the pane, and the run finished past the action.
  expect(continued.deliveries.filter((item) => item.kind === "session_action")).toHaveLength(1);
  await expect
    .poll(async () => (await detail(daemon, runId)).run.status, { timeout: 60_000 })
    .toBe("completed");

  // And the instruction is really in that session's conversation, where the operator reads
  // it. The delivery row above proves the daemon wrote it; this proves the SESSION received
  // it, which is the difference between a packet sent and a packet delivered.
  await dashboard.goto(`${daemon.baseURL}/#/`);
  const card = dashboard.locator("article.card").first();
  await card.getByRole("button", { name: "Expand conversation" }).click();
  await expect(card.getByText("Remove the stray scratch file and say so.").first())
    .toBeVisible({ timeout: 40_000 });
  expect(sessionId).not.toBe("");

  // What the RUN VIEW makes of all that. Everything above is durable truth; this is the half
  // an operator reads, and it is the half that can lie by borrowing a reviewer's vocabulary.
  await dashboard.goto(`${daemon.baseURL}/#/runs/${runId}`);

  // Two entries under ONE repair round, named as evidence rather than as a second attempt at
  // the same thing. A scrubber that showed "Round 1, Round 2" would say the run had spent
  // half its repair budget on an action that spends none.
  const scrubber = dashboard.getByRole("group", { name: "Select a round" });
  await expect(scrubber.locator(".wf-run-round-name")).toHaveText([
    "Round 1 · evidence 1",
    "Round 1 · evidence 2",
  ]);
  await expect(dashboard.locator(".wf-run-notice"))
    .toContainText("does not spend a repair round");
  await expect(dashboard.locator(".wf-run-notice")).toContainText(`captured after ${actionName}`);

  // The stage reports that it FINISHED, never that it passed - it judged nothing.
  const strip = dashboard.locator(".wf-pipeline-strip");
  await expect(strip.locator("li.wf-pipeline-reviewer")).toContainText(actionName);
  await expect(strip.locator("li.wf-pipeline-reviewer .wf-pipeline-status")).toHaveText("Complete");

  // Its own card, under its own heading, carrying the exact instruction the version froze.
  // Filed under "Reviewer verdicts" it would promise a verdict that does not exist.
  const actionCard = dashboard.locator("article.wf-run-action");
  await expect(actionCard).toHaveCount(1);
  await expect(actionCard).toContainText(actionName);
  await expect(actionCard).toContainText("No required skill");
  await expect(actionCard).toContainText("Completes when session turn finishes");
  // A `<summary>`, not a button - `getByRole("button")` would never resolve it, and the
  // tooltip beside it is a `.tt-desc` span that `getByText` would match twice.
  await actionCard.locator("summary").click();
  await expect(actionCard.locator("pre")).toContainText("Remove the stray scratch file and say so.");

  // And the delivery section names what is in it rather than calling an action a repair.
  await expect(dashboard.getByRole("heading", { name: "Deliveries to the session" })).toBeVisible();
});

test("Preview prepares the identical packet and types nothing at all", async ({
  dashboard,
  daemon,
}) => {
  // Live is fully authorized, so nothing here is refused for want of consent. The ONLY
  // reason no text is typed is that the binding is Preview - which is the whole promise.
  await api(daemon, "/api/workflows/config", {
    liveEnabled: true,
    repoAllowlist: [daemon.repo],
  }, "PUT");

  const { runId, actionName } = await seedActionRun(dashboard, daemon, "preview");

  await withDaemonLog(daemon, async () => {
    await expect
      .poll(async () => (await detail(daemon, runId)).deliveries
        .filter((item) => item.kind === "session_action").length,
      { message: "Preview must still prepare the packet so an operator can read it", timeout: 60_000 })
      .toBe(1);
  });

  const prepared = await detail(daemon, runId);
  const packet = prepared.deliveries.find((item) => item.kind === "session_action")!;
  // Prepared, readable, byte-identical to what Live would send - and never sent.
  expect(packet.state).toBe("prepared");
  expect(packet.payload).toContain(`Mission Control session action: ${actionName}`);
  expect(packet.payload.endsWith(PROMPT)).toBe(true);
  expect(prepared.summary.actionWait).toBe("awaiting_send");

  // The session settles, repeatedly, with nothing to do. A Preview action must not complete
  // from activity nobody attributed to a packet it never received.
  await expect
    .poll(async () => {
      const sessions = await api<Array<{ id: string; state: string }>>(daemon, "/api/sessions");
      return sessions.find((session) => session.state !== "exited")?.state ?? "";
    }, { message: "the session should settle back to idle", timeout: 60_000 })
    .toBe("idle");
  await new Promise((resolve) => setTimeout(resolve, 20_000));

  const still = await detail(daemon, runId);
  expect(still.deliveries.find((item) => item.kind === "session_action")!.state).toBe("prepared");
  expect(still.submissions).toHaveLength(1);
  expect(still.attempts.find((item) => item.nodeId === NODE.action)!.state).toBe("waiting");
  expect(still.run.status).toBe("waiting_for_action");

  // The run view says what it is waiting FOR, in words that claim no progress the runtime has
  // not proven: "ready" is not "sent", and neither is a verdict. A generic "Waiting" chip here
  // - which is what routing an action through the reviewer table produces - would leave an
  // operator with no way to tell a Preview packet nobody sent from a turn in flight.
  await dashboard.goto(`${daemon.baseURL}/#/runs/${runId}`);
  const strip = dashboard.locator(".wf-pipeline-strip");
  await expect(strip.locator("li.wf-pipeline-reviewer .wf-pipeline-status"))
    .toHaveText("Ready to send");
  const actionCard = dashboard.locator("article.wf-run-action");
  await expect(actionCard)
    .toContainText("The instruction is ready and has not been sent to the session yet.");
  // One repair round, one evidence snapshot: no continuation happened, so the scrubber draws
  // no evidence suffix at all.
  await expect(dashboard.getByRole("group", { name: "Select a round" }).locator(".wf-run-round-name"))
    .toHaveText(["Round 1"]);
  // Never filed under the heading that promises a verdict. This graph holds no reviewer at all,
  // so the section says exactly that - and the action's name is nowhere in it. It used to be
  // asserted against `.wf-run-attempt`, which was populated by the Session and End nodes' own
  // structural attempts; those no longer render as verdict-less reviewer cards, so the claim is
  // made against the section itself rather than against cards that are gone.
  const verdicts = dashboard.locator("section.wf-run-section")
    .filter({ has: dashboard.getByRole("heading", { name: "Reviewer verdicts" }) });
  await expect(verdicts).toContainText("This workflow has no reviewers");
  // No card of any kind under that heading, which is the claim - the action has its own card in
  // "Session actions", and this section files nothing. Asserted on CARDS rather than on the
  // section's text because the join-and-gate packet below it prints the raw runtime JSON, action
  // name included, and that disclosure is not a verdict.
  await expect(verdicts.locator("article")).toHaveCount(0);
  await expect(dashboard.locator("article.wf-run-action")).toContainText(actionName);

  // And the conversation carries no trace of the instruction. This is the assertion the
  // Preview promise actually reduces to: not "the delivery row says prepared", but "nothing
  // reached the human's screen".
  await dashboard.goto(`${daemon.baseURL}/#/`);
  const card = dashboard.locator("article.card").first();
  await card.getByRole("button", { name: "Expand conversation" }).click();
  await expect(card.getByPlaceholder(/^Reply to this session/)).toBeEnabled();
  await expect(card.getByText("Remove the stray scratch file and say so.")).toHaveCount(0);
});

test("Board workflow controls expand in place and open the exact run", async ({
  dashboard,
  daemon,
}) => {
  // Park a real run on a Preview action so the Board has a stable active workflow to
  // disclose. Live is authorized to make Preview's lack of delivery an explicit choice,
  // not a refusal that could replace the state under test.
  await api(daemon, "/api/workflows/config", {
    liveEnabled: true,
    repoAllowlist: [daemon.repo],
  }, "PUT");
  const { runId } = await seedActionRun(dashboard, daemon, "preview");
  await expect
    .poll(async () => (await detail(daemon, runId)).summary.actionWait, {
      message: "the workflow should be parked where its Board card can disclose it",
      timeout: 60_000,
    })
    .toBe("awaiting_send");

  await api(daemon, "/api/ui/config", { layout: "board" }, "PUT");
  await dashboard.setViewportSize({ width: 1440, height: 900 });
  await dashboard.goto(`${daemon.baseURL}/#/fleet`);
  await dashboard.reload();

  const boardDetail = dashboard.locator(".board-detail");
  await expect(dashboard.getByRole("button", { name: "Show full workflow" })).toBeVisible();
  await expect(boardDetail).toHaveAttribute("aria-hidden", "true");

  // The first arrow only selects. `e` must stay inside that card and drive the same
  // aria-expanded transition as clicking Show full workflow.
  await dashboard.keyboard.press("ArrowRight");
  const tile = dashboard.locator(".tile.selected");
  await expect(tile).toBeVisible();
  await dashboard.keyboard.press("e");
  await expect(tile.getByRole("button", { name: "Collapse workflow" }))
    .toHaveAttribute("aria-expanded", "true");
  await expect(tile.locator(".wf-ladder-panel")).toBeVisible();
  await expect(boardDetail).toHaveAttribute("aria-hidden", "true");
  await captureBoardShortcut(dashboard, "01-expanded");

  // A second press returns to the compact preview and still does not drill in.
  await dashboard.keyboard.press("e");
  await expect(tile.getByRole("button", { name: "Show full workflow" }))
    .toHaveAttribute("aria-expanded", "false");
  await expect(boardDetail).toHaveAttribute("aria-hidden", "true");
  await captureBoardShortcut(dashboard, "02-collapsed");

  // Enter remains the explicit route to Conversation and the rest of session detail.
  await dashboard.keyboard.press("Enter");
  await expect(boardDetail).toHaveAttribute("aria-hidden", "false");
  await expect(boardDetail.getByRole("tab", { name: "Conversation" }))
    .toHaveAttribute("aria-selected", "true");

  // Cards gives its old conversation-expansion job to structural Enter as well. The first
  // press expands and moves focus into Reply; Escape hands focus back before Enter collapses.
  await api(daemon, "/api/ui/config", { layout: "grid" }, "PUT");
  await dashboard.reload();
  await expect(dashboard.locator("article.card")).toBeVisible();
  // The arrow is RE-PRESSED until something is selected, rather than pressed once and asserted.
  // A keystroke that lands between the reload's first paint and the window handler being attached
  // is simply lost, and the negative assertion below cannot retry an element into existence - so
  // that race read as "the card was expanded", which is not what failed. Idempotent with one card
  // in the fleet: right from the only card keeps selecting it. A BARRIER, not a mask - every
  // assertion after this still fails as loudly as it did.
  await expect.poll(async () => {
    await dashboard.keyboard.press("ArrowRight");
    return await dashboard.locator("article.card.selected").count();
  }, { message: "an arrow press should select the only card in the fleet" }).toBe(1);
  const card = dashboard.locator("article.card.selected");
  await expect(card).not.toHaveClass(/expanded/);
  await dashboard.keyboard.press("Enter");
  await expect(card).toHaveClass(/expanded/);
  await expect(card.getByPlaceholder(/^Reply to this session/)).toBeFocused();
  await dashboard.keyboard.press("Escape");
  await dashboard.keyboard.press("Enter");
  await expect(card).not.toHaveClass(/expanded/);

  // The compact workflow panel is the direct route to this durable run, while the separate
  // disclosure control above remains the in-place route. Return to Board to prove the click
  // neither drills into session detail nor lands on a merely related run in the Runs list.
  await api(daemon, "/api/ui/config", { layout: "board" }, "PUT");
  await dashboard.reload();
  const workflowRunLink = dashboard.getByRole("link", {
    name: /Open E2E action run preview v\d+ workflow run/,
  });
  const boardUrl = dashboard.url();
  await workflowRunLink.evaluate((link) => {
    const name = link.querySelector(".wf-tile-peek-name");
    if (!name) throw new Error("workflow preview name is missing");
    const range = document.createRange();
    range.selectNodeContents(name);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    link.click();
  });
  await expect(dashboard).toHaveURL(boardUrl);
  await expect.poll(() => dashboard.evaluate(() => window.getSelection()?.toString() ?? ""))
    .not.toBe("");
  await dashboard.evaluate(() => window.getSelection()?.removeAllRanges());
  await workflowRunLink.click();
  await expect(dashboard).toHaveURL(`${daemon.baseURL}/#/runs/${runId}`);
  await expect(dashboard.locator(".wf-run-reader")).toContainText("E2E action run preview");
});
