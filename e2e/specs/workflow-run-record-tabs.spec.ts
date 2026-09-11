import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";

const EVIDENCE = artifactsDir("workflow-run-record-tabs");

/**
 * The run record, offered rather than stacked.
 *
 * Measured on one real No-Mistakes run, the sections below the round scrubber came to 7,997px -
 * 8.9 screens at a 900px viewport - to carry three sentences of verdict. Repair delivery alone
 * was four cards of exactly 560px, and nine human decision bodies were 2,996px of uncapped
 * prose. The Review worklist was the only section already behaving: a bounded rail and detail
 * at 220px. So the worklist keeps its place as the first and default tab and Deliveries and
 * Intent join it as siblings, each rewritten from a stack of cards into a ledger.
 *
 * Only a browser proves any of this. `test/workflow-runs-model.test.ts` pins the counts and the
 * selection order as pure functions, and `test/workflow-runs-render.test.ts` pins the markup a
 * detail produces - neither one can click a tab, press an arrow key, watch the hash change,
 * open a disclosure, or drive a delivery recovery through its confirm dialog to the daemon.
 * That is what this file does.
 *
 * The load-bearing assertion is the one about FIRST PAINT: a run whose blocking state is not in
 * the worklist opens on the pane holding it, with its sentence, its durable error and its
 * recovery buttons already on screen. An amber badge on a tab nobody clicks would still leave
 * the thing that stopped the run one click away, which is the constraint the tab design had to
 * answer and the reason the container resolves an initial pane at all.
 *
 * No model tokens: the one real review round is answered by `e2e/fixtures/fake-agents.ts`, and
 * the deliveries and the captured context are seeded rows behind the daemon. What the ledger
 * and the panes derive from them stays entirely real.
 */

const NOTE_KEY = "e2e-run-record-tabs";

/** Two decisions, one of them multi-line, so the collapsed row's first line is a real claim. */
const DECISIONS = [
  {
    decision: "Tabs under Review worklist, with counts and an amber badge on every tab label."
      + "\nThe ledger treatment of Deliveries applies too.",
    rationale: "One place to look, and the page below the worklist stops existing.",
    source: { kind: "review", id: "d944b3b2" },
  },
  {
    decision: "One summary row per human decision, expanding on click.",
    rationale: null,
    source: { kind: "foreman_episode", id: "17" },
  },
];

const REFINED_GOAL = "Consolidate the run record into one tab bar so a round reads without"
  + " nine screens of scrolling";

async function shoot(page: Page, target: Page | Locator, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  // Off every control first: `Tooltip` portals a visible bubble on hover, and a capture taken
  // where the last click left the pointer photographs that bubble over the thing under test.
  await page.mouse.move(0, 0);
  await target.screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/workflow-run-record-tabs/${name}.png`);
}

async function api<T>(daemon: DaemonHandle, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: body === undefined ? "GET" : "POST",
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
  // The repo combobox portals its listbox over the fields below, so close it before filling
  // the next one. Its handler stops propagation, so this closes the list, not the modal.
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?")
    .fill("hold a session for the run record tabs spec");
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();

  let sessionId = "";
  await expect.poll(async () => {
    const sessions = await api<Array<{ id: string; state: string }>>(daemon, "/api/sessions");
    const live = sessions.find((session) => session.state !== "exited");
    sessionId = live?.id ?? "";
    return live?.state ?? "";
  }, { message: "the dispatched session should settle before the workflow is bound" }).toBe("idle");
  return sessionId;
}

/**
 * One single-reviewer run that PASSES, built through the routes the dashboard itself uses.
 *
 * Passing matters: the worklist has to be clean, because the case under test is a run whose
 * blocking state is somewhere else. A run that also has an open change would select the
 * worklist instead, which is correct behaviour and the wrong fixture for this spec.
 */
async function seedRun(page: Page, daemon: DaemonHandle): Promise<{
  runId: string;
  sessionId: string;
}> {
  const sessionId = await dispatch(page, daemon);
  const persona = await api<{ id: string }>(daemon, "/api/personas", {
    name: "Record reviewer",
    guidanceMarkdown: "# Record reviewer\n\nE2E_PASS_VERDICT",
  });
  const workflow = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", {
    name: "E2E run record tabs",
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
    { requestId: NOTE_KEY },
  );
  try {
    await expect.poll(async () =>
      (await api<{ run: { status: string } }>(
        daemon,
        `/api/workflow-runs/${submitted.run.id}`,
      )).run.status,
    { message: "the seeded round should settle completed", timeout: 40_000 }).toBe("completed");
  } catch (caught) {
    // The seeding failure that matters here is server-side and invisible to a browser trace.
    // eslint-disable-next-line no-console
    console.log(`DAEMON LOG TAIL:\n${daemon.readLog().split("\n").slice(-60).join("\n")}`);
    throw caught;
  }
  return { runId: submitted.run.id, sessionId };
}

/**
 * The three packets and the captured intent the panes are read from.
 *
 * Written behind the daemon because getting a real refusal and a real uncertain outcome means
 * breaking a pane mid-write, which is a session-runtime fault rather than the shape under test.
 * Everything the ledger and the panes DERIVE from these rows - the counts, the stat strip, the
 * state sentences, which recovery buttons are offered, the collapsed decision summaries - is
 * computed by the real code from real records.
 */
function seedRecord(
  daemon: DaemonHandle,
  runId: string,
  sessionId: string,
  relationship: "steer" | null = "steer",
  openingAsk = "Please make the run easier to read.",
): void {
  withDaemonDb(daemon, (db) => {
    const submission = db.prepare(
      `SELECT id, created_at FROM workflow_submissions WHERE run_id = ? ORDER BY round, segment LIMIT 1`,
    ).get(runId) as { id: string; created_at: number } | undefined;
    if (!submission) throw new Error("the seeded run should already hold its submission");
    const insert = db.prepare(
      `INSERT INTO workflow_deliveries (
         id, run_id, submission_id, kind, node_attempt_id, session_id, note_key, payload,
         payload_sha256, state, error, created_at, updated_at, delivered_at, payload_pruned_at
       ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    );
    const packets: [id: string, state: string, error: string | null, payload: string][] = [
      ["record-delivered", "delivered", null, "PACKET ONE reached the session."],
      ["record-uncertain", "uncertain", "outcome_unknown", "PACKET TWO may have landed."],
      ["record-refused", "refused", "pane_blocked", "PACKET THREE was never written."],
    ];
    for (const [index, [id, state, error, payload]] of packets.entries()) {
      insert.run(
        id,
        runId,
        submission.id,
        "persona_feedback",
        sessionId,
        NOTE_KEY,
        payload,
        createHash("sha256").update(payload).digest("hex"),
        state,
        error,
        submission.created_at + index,
        submission.created_at + index,
        state === "delivered" ? submission.created_at + index : null,
      );
    }
    // A snapshot the real `readCapturedContext` accepts, so the Intent pane parses it exactly
    // as it parses a daemon-written one rather than through some looser fixture path.
    db.prepare(`UPDATE workflow_submissions SET context_json = ? WHERE id = ?`).run(
      JSON.stringify({
        primaryGoal: {
          rawPrompt: "DURABLE OBJECTIVE BODY, frozen before review.",
          openingAsk,
          intentSource: {
            objectiveVersion: 2,
            promptRevision: relationship === null ? 4 : 3,
            resolvedPromptRevision: 3,
            relationship,
          },
          refined: REFINED_GOAL,
          sourceNoteKey: NOTE_KEY,
        },
        humanDecisions: DECISIONS,
        constraints: ["Reuse .workflow-tabs rather than a second tab family"],
        acceptanceCriteria: ["Every field and every action stays reachable"],
        priorPersonaFeedback: [],
        session: { agent: "claude", name: "record", cwd: null, branch: "main" },
        evidence: {
          headSha: "1665b769cafefeed",
          diffFingerprint: "diff",
          diff: "PATCH BODY",
          diffTruncated: false,
          workingTreeDirty: true,
          workingTreeStatus: [" M src/web/workflows/WorkflowRuns.tsx"],
          workingTreeStatusTruncated: false,
          transcript: [],
          transcriptAnchor: null,
          transcriptTruncated: true,
          standards: [],
          standardsTruncated: false,
        },
        compaction: { status: "model", runner: "claude", model: "claude-haiku-4-5", error: null },
      }),
      submission.id,
    );
  });
}

const tab = (page: Page, name: RegExp): Locator => page.getByRole("tab", { name });

test("the run record is one tab bar, and a blocking pane opens itself", async ({
  dashboard,
  daemon,
}) => {
  const { runId, sessionId } = await seedRun(dashboard, daemon);
  seedRecord(daemon, runId, sessionId);
  await dashboard.goto(`${daemon.baseURL}/#/runs/${runId}`);

  const bar = dashboard.getByRole("tablist", { name: "Run record" });
  await expect(bar).toBeVisible({ timeout: 30_000 });

  // THE COUNTS, on labels a reader trusts without opening the pane behind them. Three packets,
  // two of them blocking, so the Deliveries label is amber; two captured decisions, which is
  // not an attention fact, so the Intent label is plain.
  await expect(tab(dashboard, /^Review worklist/)).toBeVisible();
  await expect(tab(dashboard, /^Deliveries 3$/)).toBeVisible();
  await expect(tab(dashboard, /^Intent 2$/)).toBeVisible();
  await expect(tab(dashboard, /^Deliveries 3$/).locator(".workflow-tab-badge"))
    .toHaveText("3");
  await expect(tab(dashboard, /^Intent 2$/).locator(".workflow-tab-badge")).toHaveCount(0);
  await expect(tab(dashboard, /^Intent 2$/).locator(".wf-run-tab-count")).toHaveText("2");

  // FIRST PAINT, and this is the assertion the whole design had to answer. The worklist is
  // clean on this run and two packets are not, so the container opens on Deliveries - and the
  // refused packet's own sentence, its durable error code and its recovery buttons are on
  // screen with no click. A badge alone would leave all of that one click away.
  await expect(tab(dashboard, /^Deliveries 3$/)).toHaveAttribute("aria-selected", "true");
  const ledger = dashboard.getByRole("tabpanel", { name: /^Deliveries/ });
  await expect(ledger).toBeVisible();
  await expect(ledger).toContainText("pane refused before a single character was typed");
  await expect(ledger).toContainText("pane could not take the write");
  await expect(ledger).toContainText("The write was lost or may have landed");
  await expect(ledger.getByRole("button", { name: "Retry refused delivery" })).toBeVisible();
  await expect(ledger.getByRole("button", { name: "Mark delivered" })).toBeVisible();
  // Four 560px cards became rows. The delivered packet is ONE line: no sentence, no fact list,
  // nothing forced open, because nothing about it stopped the run.
  await expect(ledger.locator("tr.wf-run-ledger-row")).toHaveCount(3);
  await expect(ledger.locator("tr.wf-run-ledger-alert")).toHaveCount(2);
  await expect(ledger).toContainText("Delivered");
  await shoot(dashboard, dashboard.locator("section.wf-run-record"), "01-deliveries-blocking");

  // The payload is behind the row's own control rather than printed into a card. Nothing is
  // dropped: opening it prints the exact packet and its whole transition record.
  await expect(ledger).not.toContainText("PACKET ONE reached the session");
  await ledger.locator("tr.wf-run-ledger-row").first()
    .getByRole("button", { name: "Show packet" }).click();
  await expect(ledger.locator("tr.wf-run-ledger-detail")).toHaveCount(1);
  await expect(ledger.locator("tr.wf-run-ledger-detail")).toContainText("PACKET ONE reached the session");
  await expect(ledger.locator("tr.wf-run-ledger-detail")).toContainText("Conversation");
  await expect(ledger.locator("tr.wf-run-ledger-detail")).toContainText("Payload hash");
  await ledger.locator("tr.wf-run-ledger-row").first()
    .getByRole("button", { name: "Hide packet" }).click();
  await expect(ledger.locator("tr.wf-run-ledger-detail")).toHaveCount(0);

  // Clicking a tab is a ROUTE change, because three of the panes are invisible until clicked
  // and a link that does not carry which one is showing is a link to a different page.
  await tab(dashboard, /^Review worklist/).click();
  await expect(dashboard).toHaveURL(new RegExp(`#/runs/${runId}\\?pane=worklist$`));
  await expect(dashboard.getByRole("region", { name: "Review worklist" })).toBeVisible();
  await expect(dashboard.getByRole("tabpanel", { name: /^Deliveries/ })).toHaveCount(0);
  // The worklist's own rail and segment control came with it, untouched.
  await expect(dashboard.getByRole("group", { name: "Worklist segment" })).toBeVisible();

  // ARROW KEYS move between tabs, which is the half of `role="tablist"` a row of buttons does
  // not get for nothing. The move selects as well as focusing, and it routes.
  await tab(dashboard, /^Review worklist/).focus();
  await dashboard.keyboard.press("ArrowRight");
  await expect(tab(dashboard, /^Deliveries 3$/)).toBeFocused();
  await expect(dashboard).toHaveURL(new RegExp(`#/runs/${runId}\\?pane=deliveries$`));
  await dashboard.keyboard.press("End");
  await expect(tab(dashboard, /^Intent 2$/)).toBeFocused();
  await expect(dashboard).toHaveURL(new RegExp(`#/runs/${runId}\\?pane=intent$`));

  // INTENT leads with the refined goal - the one sentence answering what this round was for -
  // and every body under it is a disclosure whose closed state states what opening it costs.
  const intent = dashboard.getByRole("tabpanel", { name: /^Intent/ });
  await expect(intent).toBeVisible();
  await expect(intent.locator(".wf-run-lead-text")).toHaveText(REFINED_GOAL);
  await expect(intent).toContainText("Compacted by claude-haiku-4-5");
  await expect(intent).toContainText("Objective version 2 · prompt revision 3 · resolved revision 3 · steer");
  await expect(intent).toContainText("HEAD 1665b769");
  await expect(intent).toContainText("tree dirty");
  await expect(intent).toContainText("transcript truncated");
  await expect(intent).toContainText("2 recorded, 247 characters in total");
  await shoot(dashboard, dashboard.locator("section.wf-run-record"), "02-intent-collapsed");

  // Nine uncapped decision bodies were 2,996px - the largest single block on the page. Each is
  // now one row carrying its source, its size and its first line, and opens on click. Nothing
  // is truncated on expansion; the body was never anywhere else.
  const decisionsDisclosure = intent.locator("details.wf-run-disclosure")
    .filter({ hasText: "Human decisions and rationale" }).first();
  const decisions = intent.locator("details.wf-run-decision");
  // Closed on arrival: not one of the nine bodies is drawn until somebody asks for them, which
  // is the whole of the 2,996px this decision removes.
  await expect(decisions.first()).toBeHidden();
  await decisionsDisclosure.locator("> summary").click();
  await expect(decisions).toHaveCount(2);
  await expect(decisions.first()).toBeVisible();
  const firstSummary = decisions.first().locator("summary");
  await expect(firstSummary).toContainText(
    "Tabs under Review worklist, with counts and an amber badge on every tab label.",
  );
  await expect(firstSummary).toContainText("review:d944b3b2");
  await expect(firstSummary).toContainText("192 characters · has rationale");
  // Still ONE ROW each: the body behind it is present but not drawn, and the row's own title
  // is the first line rather than the whole 126-character decision.
  const firstBody = decisions.first().locator(".wf-run-disclosure-body");
  await expect(firstBody).toBeHidden();
  await expect(firstSummary).not.toContainText("The ledger treatment of Deliveries applies too");
  await firstSummary.click();
  // Nothing is truncated on expansion. The body was never anywhere else.
  await expect(firstBody).toBeVisible();
  await expect(firstBody).toContainText("The ledger treatment of Deliveries applies too");
  await expect(firstBody).toContainText(
    "Rationale: One place to look, and the page below the worklist stops existing.",
  );
  // The decision with no rationale says nothing about one rather than printing an empty label.
  await expect(decisions.nth(1).locator("summary")).toContainText("foreman_episode:17");
  await expect(decisions.nth(1).locator("summary")).not.toContainText("has rationale");
  await expect(decisions.nth(1).locator(".wf-run-disclosure-body")).toBeHidden();
  await shoot(dashboard, dashboard.locator("section.wf-run-record"), "03-intent-decision-open");

  // The original goal, the criteria, the constraints and the evidence snapshot are all still
  // here in full - one disclosure each, closed, with its own size on the closed row.
  const original = intent.locator("details.wf-run-disclosure")
    .filter({ hasText: "Review contract" }).first();
  await expect(original.locator("> summary")).toContainText("45 characters");
  await expect(original.locator(".wf-run-disclosure-body")).toBeHidden();
  await original.locator("> summary").click();
  await expect(original.locator(".wf-run-disclosure-body"))
    .toContainText("DURABLE OBJECTIVE BODY, frozen before review.");
  const opening = intent.locator("details.wf-run-disclosure")
    .filter({ hasText: "Opening request" }).first();
  await opening.locator("> summary").click();
  await expect(opening.locator("pre")).toHaveText("Please make the run easier to read.");
  await shoot(dashboard, dashboard.locator("section.wf-run-record"), "04-review-contract-opening-request");
  const snapshot = intent.locator("details.wf-run-disclosure")
    .filter({ hasText: "Evidence snapshot" }).first();
  await snapshot.locator("> summary").click();
  await expect(snapshot.locator(".wf-run-disclosure-body")).toContainText("PATCH BODY");
  await expect(snapshot.locator(".wf-run-disclosure-body")).toContainText("1665b769cafe");
  await expect(intent).toContainText("Reuse .workflow-tabs rather than a second tab family");
  await expect(intent).toContainText("Every field and every action stays reachable");

  // A LINK naming the worklist opens on the worklist, even though Deliveries blocks. An
  // explicit pane wins over a blocking one, or the back button and every shared link lie.
  await dashboard.goto(`${daemon.baseURL}/#/runs/${runId}?pane=worklist`);
  await expect(tab(dashboard, /^Review worklist/)).toHaveAttribute("aria-selected", "true");
  await expect(dashboard.getByRole("region", { name: "Review worklist" })).toBeVisible();

  // And a name this build does not offer lands on a real pane rather than an empty container:
  // the selection falls through to the initial order, which puts the reader back on the pane
  // holding the refused packet. The router drops the unknown value from the address bar the
  // same way it already drops an unknown `status`, through `replaceState` - so no history
  // entry is spent and the back button still works, which is the constraint that matters.
  await dashboard.goto(`${daemon.baseURL}/#/runs/${runId}?pane=completion`);
  await expect(bar).toBeVisible();
  await expect(tab(dashboard, /^Deliveries 3$/)).toHaveAttribute("aria-selected", "true");
  await expect(dashboard).toHaveURL(new RegExp(`#/runs/${runId}$`));
  await dashboard.goBack();
  await expect(dashboard).toHaveURL(new RegExp(`#/runs/${runId}\\?pane=worklist$`));
  await expect(tab(dashboard, /^Review worklist/)).toHaveAttribute("aria-selected", "true");
  await dashboard.goForward();

  // EVERY ACTION STILL REACHES ITS ROUTE from its new home, confirm dialog included. This is
  // the one thing the ledger rewrite was not allowed to cost, so it is driven all the way to
  // the daemon rather than asserted as a button that exists.
  await dashboard.getByRole("tabpanel", { name: /^Deliveries/ })
    .getByRole("button", { name: "Mark delivered" }).click();
  const confirm = dashboard.getByRole("dialog", { name: "Mark this packet delivered" });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Mark delivered" }).click();
  await expect(confirm).toBeHidden();
  await expect.poll(async () => {
    const detail = await api<{ deliveries: { id: string; state: string }[] }>(
      daemon,
      `/api/workflow-runs/${runId}`,
    );
    return detail.deliveries.find((row) => row.id === "record-uncertain")?.state;
  }, { message: "the resolution should reach the daemon from the ledger row" }).toBe("delivered");
  // The ledger follows: one blocking row left, and the count on the label is unchanged because
  // three packets still exist - resolving one is not deleting it.
  await expect(dashboard.locator("tr.wf-run-ledger-alert")).toHaveCount(1);
  await expect(tab(dashboard, /^Deliveries 3$/)).toBeVisible();
});

test("a run with nothing blocking opens on the worklist, and offers no empty tabs", async ({
  dashboard,
  daemon,
}) => {
  // The ordinary run, which is most of them: a clean worklist, no packets, and a captured
  // context. The worklist is the primary object and the final fallback, and a pane whose
  // `render` returns null is not in the bar at all - "Deliveries 0" would be a control
  // answering a question nobody asked, and Phase 3's Completion pane depends on that rule.
  const { runId } = await seedRun(dashboard, daemon);
  await dashboard.goto(`${daemon.baseURL}/#/runs/${runId}`);

  const bar = dashboard.getByRole("tablist", { name: "Run record" });
  await expect(bar).toBeVisible({ timeout: 30_000 });
  await expect(tab(dashboard, /^Review worklist/)).toHaveAttribute("aria-selected", "true");
  // Three, not four: this run sent no packets, so Deliveries is absent. Evidence is offered on
  // every round that has a submission - a round that froze nothing still has an answer to what
  // it proved, and "nothing was frozen for this submission" is that answer rather than a
  // missing tab.
  await expect(bar.getByRole("tab")).toHaveCount(3);
  await expect(tab(dashboard, /^Deliveries/)).toHaveCount(0);
  await expect(tab(dashboard, /^Evidence$/)).toBeVisible();
  // No count on a clean worklist either: this label answers "is anything still being asked
  // for", and a bare `0` on it reads as "no reviewers".
  await expect(tab(dashboard, /^Review worklist$/)).toBeVisible();
  // No amber anywhere: nothing on this run stops it.
  await expect(bar.locator(".workflow-tab-badge")).toHaveCount(0);
  // The address bar is untouched on arrival. The initial pane is resolved, not written - a
  // reader who has just landed keeps their back button.
  await expect(dashboard).toHaveURL(new RegExp(`#/runs/${runId}$`));
  await shoot(dashboard, dashboard.locator("section.wf-run-record"), "04-clean-run");

  // The round scrubber still governs, and changing rounds does not change which pane is read.
  await tab(dashboard, /^Intent/).click();
  await expect(dashboard).toHaveURL(new RegExp(`#/runs/${runId}\\?pane=intent$`));
  await dashboard.getByRole("group", { name: "Select a round" })
    .getByRole("button", { name: /Round 1/ }).click();
  await expect(tab(dashboard, /^Intent/)).toHaveAttribute("aria-selected", "true");

  /*
   * THE BARE RAIL, which is how the Runs page opens from the Line and from the nav.
   *
   * `#/runs` carries no run id, and the rail auto-selects the newest run and draws its reader
   * anyway. The tabs have to work there too, and the route is the only thing that can carry
   * which pane is showing - so the host has to resolve the run the rail picked rather than
   * reading one out of a hash that does not have it. Without that, `missionRouteHash` drops a
   * pane it cannot attach to a run, the hash never changes, and every tab on the bare rail is
   * a control that does nothing.
   */
  await dashboard.goto(`${daemon.baseURL}/#/runs`);
  await expect(dashboard.getByRole("tablist", { name: "Run record" }))
    .toBeVisible({ timeout: 30_000 });
  await expect(dashboard).toHaveURL(/#\/runs$/);
  await tab(dashboard, /^Intent/).click();
  // The run the rail picked reaches the hash WITH the pane, so the link is whole.
  await expect(dashboard).toHaveURL(new RegExp(`#/runs/${runId}\\?pane=intent$`));
  await expect(tab(dashboard, /^Intent/)).toHaveAttribute("aria-selected", "true");
  await expect(dashboard.getByRole("tabpanel", { name: /^Intent/ })).toBeVisible();
});


test("the Intent pane labels a pending relationship as unresolved", async ({ dashboard, daemon }) => {
  const { runId, sessionId } = await seedRun(dashboard, daemon);
  seedRecord(daemon, runId, sessionId, null);
  await dashboard.goto(`${daemon.baseURL}/#/runs/${runId}`);
  await tab(dashboard, /^Intent/).click();
  const provenance = dashboard.getByText(
    "Objective version 2 · prompt revision 4 · resolved revision 3 · unresolved",
    { exact: true },
  );
  await expect(provenance).toBeVisible();
  await shoot(dashboard, dashboard.getByRole("tabpanel", { name: /^Intent/ }), "05-unresolved-relationship");
});


test("the Intent pane retains a long opening request verbatim", async ({ dashboard, daemon }) => {
  const { runId, sessionId } = await seedRun(dashboard, daemon);
  const openingAsk = "\n  Opening request before clamp\n"
    + "Preserve every detail.\n".repeat(1_000) + "\nFINAL VERBATIM REQUIREMENT  \n";
  seedRecord(daemon, runId, sessionId, "steer", openingAsk);
  await dashboard.goto(`${daemon.baseURL}/#/runs/${runId}`);
  await tab(dashboard, /^Intent/).click();
  const intent = dashboard.getByRole("tabpanel", { name: /^Intent/ });
  const opening = intent.locator("details.wf-run-disclosure").filter({ hasText: "Opening request" });
  await opening.locator("> summary").click();
  await expect(opening.locator("pre")).toHaveJSProperty("textContent", openingAsk);
  await expect(opening.locator("> summary")).toContainText(`${openingAsk.length.toLocaleString()} characters`);
  const contract = intent.locator("details.wf-run-disclosure").filter({ hasText: "Review contract" });
  await contract.locator("> summary").click();
  await shoot(dashboard, dashboard.locator("section.wf-run-record"), "06-verbatim-long-opening");
});
