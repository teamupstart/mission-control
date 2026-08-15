import { mkdirSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * The reader pane as a worklist rather than an archive.
 *
 * Measured on a live No-Mistakes run at round 10 of a 9-round budget, the section this replaces
 * rendered 11,445 characters to convey about 480. Three structural things were wrong and only a
 * browser can show that all three are fixed at once: a pass cost the same as a failure, a change
 * raised in round 1 and still open in round 10 looked identical to one raised a minute ago, and
 * the fact that two reviewers had failed every round was in the payload and on no screen.
 *
 * The markup test pins the shape from hand-built details. This drives a real dispatch, a real
 * published workflow, two real review rounds, and reads the rail a person actually lands on -
 * including the one assertion no fixture can make: that a resolved row and an unconfirmed row
 * sit on the same rail as a stalemate card and none of the three contradicts the others.
 *
 * No model tokens: every reviewer is answered by `e2e/fixtures/fake-claude.mjs`, which returns
 * schema-valid verdicts for the `E2E_*_VERDICT` markers the published guidance carries.
 */

const NODE = {
  session: "session-node",
  settling: "settling-node",
  restating: "restating-node",
  agreeable: "agreeable-node",
  join: "join-node",
  end: "end-node",
};

const REVIEWER = {
  /** Fails round 1, then an operator directive turns it into a pass. */
  settling: "E2E settling reviewer",
  /** Fails round 1, then an operator directive makes it restate the same objection. */
  restating: "E2E restating reviewer",
  /** Passes every round, and costs a count rather than a card. */
  agreeable: "E2E agreeable reviewer",
};

const EVIDENCE = artifactsDir("workflow-run-blocker-worklist");
const WORKFLOW = "E2E blocker worklist";

async function api<T>(daemon: DaemonHandle, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

async function shoot(target: Page | Locator, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await target.screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/workflow-run-blocker-worklist/${name}.png`);
}

async function dispatch(page: Page, daemon: DaemonHandle): Promise<string> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?")
    .fill("hold a session for the blocker worklist spec");
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();

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

/**
 * A round-1 run where two reviewers object in the SAME words and a third approves.
 *
 * The shared title is deliberate. A change's identity leads with the node that raised it, so two
 * reviewers asking for the same thing are two rows with two rationales, two sets of evidence and
 * two different reviewers to disable - and folding them into one would make the loser's
 * objection un-actionable from this rail.
 */
async function seedFailedRound(page: Page, daemon: DaemonHandle): Promise<string> {
  const sessionId = await dispatch(page, daemon);
  const personaId = async (name: string, marker: string): Promise<string> =>
    (await api<{ id: string }>(daemon, "/api/personas", {
      name,
      guidanceMarkdown: `# ${name}\n\n${marker}`,
    })).id;
  const settling = await personaId(REVIEWER.settling, "E2E_FAIL_VERDICT");
  const restating = await personaId(REVIEWER.restating, "E2E_FAIL_VERDICT");
  const agreeable = await personaId(REVIEWER.agreeable, "E2E_PASS_VERDICT");
  const workflow = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", {
    name: WORKFLOW,
    draft: {
      nodes: [
        { id: NODE.session, kind: "session", position: { x: 0, y: 0 } },
        { id: NODE.settling, kind: "persona", personaId: settling, position: { x: 220, y: 0 } },
        { id: NODE.restating, kind: "persona", personaId: restating, position: { x: 220, y: 140 } },
        { id: NODE.agreeable, kind: "persona", personaId: agreeable, position: { x: 220, y: 280 } },
        { id: NODE.join, kind: "all_pass", position: { x: 440, y: 140 } },
        { id: NODE.end, kind: "end", outcome: "Approved", position: { x: 660, y: 140 } },
      ],
      edges: [
        ...[NODE.settling, NODE.restating, NODE.agreeable].flatMap((node, index) => [
          { id: `e-activate-${index}`, source: NODE.session, sourcePort: "submitted", target: node, targetPort: "activate" },
          { id: `e-pass-${index}`, source: node, sourcePort: "pass", target: NODE.join, targetPort: "result" },
          { id: `e-fail-${index}`, source: node, sourcePort: "fail", target: NODE.join, targetPort: "result" },
        ]),
        { id: "e-join-pass", source: NODE.join, sourcePort: "pass", target: NODE.end, targetPort: "terminal" },
        { id: "e-join-fail", source: NODE.join, sourcePort: "fail", target: NODE.session, targetPort: "return_for_changes" },
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
    maxRepairRounds: 5,
  });
  const submitted = await api<{ run: { id: string } }>(
    daemon,
    `/api/workflow-bindings/${binding.id}/submit`,
    { requestId: "e2e-blocker-worklist" },
  );
  await expect
    .poll(async () =>
      (await api<{ run: { status: string } }>(
        daemon,
        `/api/workflow-runs/${submitted.run.id}`,
      )).run.status,
    { message: "two scripted objections should park the run for repair", timeout: 40_000 })
    .toBe("waiting_for_session");
  return submitted.run.id;
}

/*
 * The two-column widget itself, NOT the section around it.
 *
 * The section also holds the join packet and the gate packet, two `<details>` that print the
 * runtime's raw JSON - verdict text and all. A negative assertion made against the section
 * would be answered by that JSON rather than by the rail, so "round 1 does not know about
 * round 2's objection" would fail on a page that is perfectly correct.
 */
const worklistOf = (page: Page): Locator =>
  page.locator("section.wf-run-section")
    .filter({ has: page.getByRole("heading", { name: "Review worklist" }) })
    .locator(".wf-run-worklist");

/** Give one reviewer a run-scoped directive from its own worklist row. */
async function directReviewer(page: Page, reviewer: string, marker: string): Promise<void> {
  const worklist = worklistOf(page);
  await worklist.getByRole("button", { name: new RegExp(`^Blocker.*${reviewer}`) }).first().click();
  await worklist.getByRole("button", { name: "Give this reviewer feedback" }).click();
  const editor = page.getByRole("dialog", { name: "Guide this reviewer's future rounds" });
  await expect(editor).toBeVisible();
  await editor.getByLabel(`Feedback for ${reviewer}`).fill(`${marker}. Apply the exception.`);
  await editor.getByRole("button", { name: "Save for future rounds" }).click();
  await expect(editor).toBeHidden();
}

/** The header's own resubmission, which is how a person opens the next round with no edits. */
async function openNextRound(page: Page): Promise<void> {
  const primary = page.locator("header.wf-run-head button.btn-primary");
  await expect(primary).toHaveText("Preview fresh evidence");
  await primary.click();
  await expect(primary).toHaveText("Preview unchanged", { timeout: 40_000 });
  await primary.click();
  await page.getByRole("dialog").getByRole("button", { name: "Preview unchanged" }).click();
}

test("the worklist leads with what the run asks for, and a pass costs a count", async ({
  dashboard,
  daemon,
}) => {
  const runId = await seedFailedRound(dashboard, daemon);
  await dashboard.goto(`${daemon.baseURL}/#/runs/${runId}`);
  const worklist = worklistOf(dashboard);
  await expect(worklist).toBeVisible({ timeout: 40_000 });

  const segments = worklist.getByRole("group", { name: "Worklist segment" });
  await expect(segments.getByRole("button", { name: "Blocking 2" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(segments.getByRole("button", { name: "Passed 1" })).toBeVisible();
  await expect(segments.getByRole("button", { name: "Archive 0" })).toBeVisible();

  /*
   * Two reviewers, the same words, two rows. The fixture gives both objections the identical
   * title, so a key without the owning reviewer in it would have folded them into one - and the
   * per-row Disable and feedback actions act on that reviewer.
   */
  const rows = worklist.getByRole("button", { name: /^Blocker/ });
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: REVIEWER.settling })).toHaveCount(1);
  await expect(rows.filter({ hasText: REVIEWER.restating })).toHaveCount(1);

  // The selected one, in full, with the reviewer's own rationale rather than a summary of it.
  await expect(worklist).toContainText("This reviewer is scripted to ask for changes");
  await expect(worklist).toContainText("First raised");
  // The e2e fixture's change cites no file at all, which the type allows and the mockup did not
  // draw. It says so rather than leaving an empty monospace slot, and offers nothing to open.
  await expect(worklist).toContainText("No file cited");
  await expect(worklist.getByRole("button", { name: "Open file" })).toHaveCount(0);

  // The three things a person can do about one change without leaving the rail. The disable
  // names the reviewer the SELECTED row belongs to, which is what makes two identically-worded
  // objections separately actionable.
  await expect(worklist.getByRole("button", { name: "Copy this change" })).toBeVisible();
  await expect(worklist.getByRole("button", { name: "Give this reviewer feedback" })).toBeVisible();
  await expect(worklist.getByRole("button", { name: /^Disable E2E / })).toBeVisible();

  // The approval is one line behind a count, not a card. This is the 1,984 characters of
  // header, summary, rationale and evidence list the redesign was measured against.
  await expect(worklist).not.toContainText("This reviewer is scripted to approve");
  await expect(worklist).not.toContainText(REVIEWER.agreeable);
  await dashboard.mouse.move(0, 0);
  await shoot(worklist, "01-blocking-leads-with-the-change");

  await segments.getByRole("button", { name: "Passed 1" }).click();
  await expect(worklist.locator("button.wf-run-worklist-row")).toHaveCount(1);
  await expect(worklist).toContainText(REVIEWER.agreeable);
  // And asked for, it is all still there.
  await expect(worklist).toContainText("This reviewer is scripted to approve");
  await dashboard.mouse.move(0, 0);
  await shoot(worklist, "02-passes-behind-the-count");

  // Walking the list is what a worklist is for, and it stays inside the segment. Each step
  // re-points every per-change action at the reviewer whose row is now selected.
  await segments.getByRole("button", { name: "Blocking 2" }).click();
  await expect(worklist).toContainText("1 of 2");
  const firstDisabled = await worklist.getByRole("button", { name: /^Disable E2E / })
    .textContent();
  await worklist.getByRole("button", { name: "Next item" }).click();
  await expect(worklist).toContainText("2 of 2");
  await expect(worklist.getByRole("button", { name: /^Disable E2E / }))
    .not.toHaveText(firstDisabled ?? "");
});

test("a second round sorts each change by what its own reviewer said, and names the stalemate", async ({
  dashboard,
  daemon,
}) => {
  const runId = await seedFailedRound(dashboard, daemon);
  await dashboard.goto(`${daemon.baseURL}/#/runs/${runId}`);
  const worklist = worklistOf(dashboard);
  await expect(worklist).toBeVisible({ timeout: 40_000 });
  const segments = worklist.getByRole("group", { name: "Worklist segment" });

  // One reviewer is told to accept the work; the other is told to restate its objection in
  // different words. Both directives go in from the change's own row.
  await directReviewer(dashboard, REVIEWER.settling, "E2E_DIRECTIVE_PASS_VERDICT");
  await directReviewer(dashboard, REVIEWER.restating, "E2E_DIRECTIVE_REWORD_VERDICT");
  await openNextRound(dashboard);
  await expect(dashboard.locator(".wf-run-scrubber")).toContainText("Round 2", { timeout: 40_000 });

  /*
   * Round 2, and the three states the rail can tell apart.
   *
   * The reworded objection is the case the third state exists for. Its old key stopped being
   * raised, but the reviewer that raised it never passed - so nothing knows whether the work is
   * fixed, and the row has to claim neither outcome. Green there would say a reviewer is
   * satisfied on the same rail as a card calling it a repeat offender.
   */
  await expect(segments.getByRole("button", { name: "Blocking 1" })).toBeVisible({ timeout: 40_000 });
  await expect(segments.getByRole("button", { name: "Passed 2" })).toBeVisible();
  await expect(segments.getByRole("button", { name: "Archive 2" })).toBeVisible();
  await expect(worklist).toContainText("E2E reworded change");

  // The fact that was in the payload and on no screen, worded exactly as the ladder words it.
  await expect(worklist.locator(".wf-run-worklist-stalemate")).toContainText(
    `${REVIEWER.restating} has failed 2 rounds running.`,
  );
  // And it names only the reviewer that actually kept failing.
  await expect(worklist.locator(".wf-run-worklist-stalemate")).not.toContainText(REVIEWER.settling);
  await dashboard.mouse.move(0, 0);
  await shoot(worklist, "03-round-two-with-the-stalemate");

  await segments.getByRole("button", { name: "Archive 2" }).click();
  const resolved = worklist.locator("button.wf-run-worklist-row.is-resolved");
  const unconfirmed = worklist.locator("button.wf-run-worklist-row.is-unconfirmed");
  await expect(resolved).toHaveCount(1);
  await expect(unconfirmed).toHaveCount(1);
  // Resolved names the round its OWN reviewer confirmed in, not the round the run moved on.
  await expect(resolved).toContainText("Resolved in round 2");
  await expect(resolved).toContainText(REVIEWER.settling);
  /*
   * And the two rows' left accents say the same thing their chips do.
   *
   * Asserted as a class rather than left to the eye because the accent is read from the row's
   * tone rather than from its kind, and the whole point of the amber is that an operator must
   * not see a satisfied-looking row above a card calling that reviewer a repeat offender.
   */
  await expect(resolved).toHaveClass(/is-tone-passed/);
  await expect(unconfirmed).toHaveClass(/is-tone-waiting/);
  await expect(unconfirmed).not.toHaveClass(/is-tone-passed/);
  // Unconfirmed claims neither outcome, and says which reviewer left it unknown.
  await expect(unconfirmed).toContainText("Last raised in round 1");
  await expect(unconfirmed).toContainText(
    `${REVIEWER.restating} has not passed since, so this was never confirmed fixed.`,
  );
  await expect(unconfirmed).not.toContainText("Resolved");
  await dashboard.mouse.move(0, 0);
  await shoot(worklist, "04-archive-tells-the-two-apart");

  /*
   * The scrub, which is the whole reason the derivation takes a round at all.
   *
   * Everything above the worklist is scoped to the viewed round, so a whole-run worklist beside
   * it would put three counts from two different moments on one control. Round 1 knows nothing
   * about round 2's reworded objection, and its rail says so.
   */
  await dashboard.locator(".wf-run-scrubber").getByRole("button", { name: /^Round 1/ }).click();
  await expect(segments.getByRole("button", { name: "Blocking 2" })).toBeVisible();
  await expect(segments.getByRole("button", { name: "Passed 1" })).toBeVisible();
  await expect(segments.getByRole("button", { name: "Archive 0" })).toBeVisible();
  await expect(worklist).not.toContainText("E2E reworded change");
  // One failing round is not a stalemate, and round 1 is never told round 2's streak.
  await expect(worklist.locator(".wf-run-worklist-stalemate")).toHaveCount(0);
});
