import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import {
  WORKFLOW_RUN_STATUSES,
  workflowRunIsOpen,
  type WorkflowRunSummary,
} from "../src/shared/workflow.ts";
import {
  WorkflowChip,
  WorkflowChips,
  WorkflowRailMark,
  workflowRunTone,
} from "../src/web/components/session-bits.tsx";
import { SessionCard } from "../src/web/components/SessionCard.tsx";
import { ConsoleDetail } from "../src/web/components/layouts/ConsoleDetail.tsx";
import { RailRow } from "../src/web/components/layouts/RailRow.tsx";
import { mkSession } from "./helpers/session-fixture.ts";
import { mkSessionView } from "./helpers/session-view.ts";

const run: WorkflowRunSummary = {
  id: "run",
  bindingId: "binding",
  workflowId: "workflow",
  workflowName: "Review",
  workflowVersion: 3,
  sessionId: "session",
  noteKey: "note",
  status: "waiting_for_session",
  phase: "persona_feedback",
  round: 2,
  maxRepairRounds: 5,
  activePersonaNames: [],
  failedPersonaCount: 1,
  bypassedPersonaReview: false,
  gate: "none",
  gatePrNumber: null,
  gateHeadShort: null,
  reviewPosture: null,
  updatedAt: 1,
};

test("workflow status helper drives card, rail, and Board disclosure vocabularies", () => {
  assert.equal(workflowRunTone(run), "waiting");
  assert.equal(workflowRunTone({ ...run, status: "waiting_for_pr", gate: "waiting_pr" }), "waiting");
  assert.equal(workflowRunTone({
    ...run,
    status: "waiting_for_inspector",
    gate: "waiting_inspector",
  }), "waiting");
  assert.equal(workflowRunTone({
    ...run,
    status: "waiting_for_new_head",
    gate: "findings",
  }), "waiting");
  assert.equal(workflowRunTone({ ...run, status: "completed" }), "passed");
  assert.equal(workflowRunTone({ ...run, status: "blocked" }), "blocked");
  assert.match(renderToStaticMarkup(createElement(WorkflowChip, { run })), /workflow-waiting/);
  assert.match(renderToStaticMarkup(createElement(WorkflowRailMark, { run })), /rail-workflow/);

  const card = readFileSync(new URL("../src/web/components/SessionCard.tsx", import.meta.url), "utf8");
  const detail = readFileSync(new URL("../src/web/components/layouts/ConsoleDetail.tsx", import.meta.url), "utf8");
  const tile = readFileSync(new URL("../src/web/components/layouts/SessionTile.tsx", import.meta.url), "utf8");
  const rail = readFileSync(new URL("../src/web/components/layouts/RailRow.tsx", import.meta.url), "utf8");
  // The fan-out component, not the single chip: a card that drew one run would hide a
  // multi-repo task's other repository behind whichever run updated last.
  assert.match(card, /<WorkflowChips/);
  assert.match(detail, /<WorkflowChips/);
  assert.match(tile, /<WorkflowLadderPanel/);
  assert.match(tile, /tileDisclosure=/);
  assert.doesNotMatch(tile, /<WorkflowTileFlag/);
  assert.match(rail, /<WorkflowRailMark/);
});

test("Cards wears the held mark the Board tile wears, off the same predicate", () => {
  // Cards has no idle column to split and no section rule to draw, so the card's spine and
  // tag are the ONLY way that layout says an open run owns this agent's next turn. A card
  // without them shows a held session as indistinguishable from a genuinely free one.
  const idle = mkSession({ state: "idle", activity: null });
  const held = renderToStaticMarkup(
    createElement(SessionCard, {
      session: idle,
      expanded: false,
      workflowRun: run,
      workflowRuns: [run],
    }),
  );
  assert.match(held, /class="card [^"]*is-held/);
  assert.match(held, /class="card-held"[^>]*>held</);
  assert.match(held, /Held by Review - the run owns this session/);

  // A finished run releases the mark the same instant it releases the Board's section rule.
  const released = renderToStaticMarkup(
    createElement(SessionCard, {
      session: idle,
      expanded: false,
      workflowRun: { ...run, status: "completed" as const },
      workflowRuns: [{ ...run, status: "completed" as const }],
    }),
  );
  assert.doesNotMatch(released, /is-held/);
  assert.doesNotMatch(released, /card-held/);

  // A held session that stopped to ask a question reads as attention, not as held - the mark
  // must not argue with the tone the card is drawn in.
  const asking = renderToStaticMarkup(
    createElement(SessionCard, {
      session: mkSession({ state: "awaiting_input", activity: null }),
      expanded: false,
      workflowRun: run,
      workflowRuns: [run],
    }),
  );
  assert.doesNotMatch(asking, /is-held/);

  // Both card-shaped surfaces read the ONE shared sentence, so they cannot drift.
  const card = readFileSync(new URL("../src/web/components/SessionCard.tsx", import.meta.url), "utf8");
  const tile = readFileSync(new URL("../src/web/components/layouts/SessionTile.tsx", import.meta.url), "utf8");
  assert.match(card, /sessionIsHeld\(/);
  assert.match(tile, /sessionIsHeld\(/);
});

/**
 * The two session surfaces that offer to bind a workflow, and the run states they offer it in.
 *
 * These two gates used to ask `!workflowRun` - "has this session EVER had a run" - so a session
 * whose review had finished hid the chip forever, and could never be reviewed again from the card
 * or the console detail header. The question they have to ask is whether a run still OWNS the
 * session, which is what `sessionCanBindWorkflow` spells, and it is the same reading `held.ts`
 * already gives the held mark and `BacklogColumn` already gives the drop target.
 */

/** The chip itself, at the one class both surfaces draw it with. */
const BIND_CHIP = /class="workflow-bind-chip"[^>]*>＋ workflow</;

/** The outcome chip, matched inside its own element so a tooltip's copy cannot stand in for it. */
const outcomeChip = (tone: string, label: string): RegExp =>
  new RegExp(`class="workflow-chip workflow-${tone}"[^>]*>.*?${label}<`);

const idle = (): ReturnType<typeof mkSession> => mkSession({ state: "idle", activity: null });

function cardWith(bound: WorkflowRunSummary | null): string {
  return renderToStaticMarkup(
    createElement(SessionCard, {
      session: idle(),
      expanded: false,
      workflowRun: bound,
      workflowRuns: bound ? [bound] : null,
      onOpenWorkflowRun: () => {},
      onBindWorkflow: () => {},
    }),
  );
}

function detailWith(bound: WorkflowRunSummary | null): string {
  const session = idle();
  return renderToStaticMarkup(
    createElement(ConsoleDetail, {
      session,
      view: mkSessionView(session, {
        workflowRunsBySession: new Map(
          bound ? [[session.id, [{ ...bound, sessionId: session.id }]]] : [],
        ),
        onOpenWorkflowRun: () => {},
        onBindWorkflow: () => {},
      }),
    }),
  );
}

const BIND_SURFACES: [string, (bound: WorkflowRunSummary | null) => string][] = [
  ["the card", cardWith],
  ["the console detail header", detailWith],
];

test("an OPEN run withholds the bind chip from both session surfaces", () => {
  // Derived from the shared union rather than hand-listed, for the reason `workflowRunIsOpen`'s
  // own docstring gives: `WORKFLOW_RUN_STATUSES` is append-only, and a fifth waiting status has
  // to reach this assertion at the same moment it reaches the gate.
  const open = WORKFLOW_RUN_STATUSES.filter((status) => workflowRunIsOpen(status));
  assert.ok(open.length >= 8, "the open statuses should still be the bulk of the union");
  for (const status of open) {
    for (const [name, render] of BIND_SURFACES) {
      assert.doesNotMatch(
        render({ ...run, status }),
        BIND_CHIP,
        `${name} should withhold the chip while a run is ${status}`,
      );
    }
  }
});

test("a TERMINAL run gives the bind chip back, beside the outcome it left behind", () => {
  // The pairing is the point. The outcome is history and the bind chip is the next move, so a
  // finished run shows BOTH - which is why the fix lives at these gates and not in
  // `workflowRunsBySession`, whose terminal runs are what the outcome chip is drawn from.
  const outcomes: [WorkflowRunSummary["status"], string, string][] = [
    ["completed", "passed", "Approved"],
    ["cancelled", "failed", "Preview cancelled"],
    ["failed", "failed", "Preview failed"],
  ];
  for (const [status, tone, label] of outcomes) {
    for (const [name, render] of BIND_SURFACES) {
      const html = render({ ...run, status });
      assert.match(html, BIND_CHIP, `${name} should offer the chip again after a ${status} run`);
      assert.match(
        html,
        outcomeChip(tone, label),
        `${name} should still read "${label}" beside it`,
      );
    }
  }

  // And with no run at all, which is the state the chip has always been offered in.
  for (const [name, render] of BIND_SURFACES) {
    const html = render(null);
    assert.match(html, BIND_CHIP, `${name} should offer the chip when nothing is bound`);
    assert.doesNotMatch(html, /class="workflow-chip/, `${name} should draw no outcome chip`);
  }
});

test("a terminal run releases the held mark and the offer together, off one shared reading", () => {
  // Pins that this change did not narrow `workflowRunsBySession`: the summary is still there for
  // a finished run - the outcome chip proves it - and the two things that are about OWNERSHIP
  // both let go. Both surfaces read the shared helpers rather than a terminal-status list of
  // their own, so a fourth terminal status lands on all of them at once.
  const done = cardWith({ ...run, status: "completed" });
  assert.doesNotMatch(done, /is-held/);
  assert.doesNotMatch(done, /card-held/);
  assert.match(done, outcomeChip("passed", "Approved"));
  assert.match(done, BIND_CHIP);

  const card = readFileSync(new URL("../src/web/components/SessionCard.tsx", import.meta.url), "utf8");
  const detail = readFileSync(new URL("../src/web/components/layouts/ConsoleDetail.tsx", import.meta.url), "utf8");
  for (const [name, source] of [["the card", card], ["the console detail", detail]] as const) {
    assert.match(source, /sessionCanBindWorkflow\(/, `${name} should read the shared predicate`);
    assert.doesNotMatch(
      source,
      /WORKFLOW_RUN_TERMINAL_STATUSES|"cancelled"/,
      `${name} should carry no copy of the terminal-status list`,
    );
  }
});

test("a conversation reviewing two repositories draws a chip for each, named", () => {
  // One workflow run is one repository, and two of a session's runs share a conversation, a
  // workflow, a version and usually a status. The repository name is the only thing that
  // tells them apart, so a fan-out that drew two identical chips would be worse than one.
  const second: WorkflowRunSummary = {
    ...run,
    id: "run-2",
    bindingId: "binding-2",
    status: "completed",
    repoRoot: "/checkouts/second-repo",
  };
  const both = renderToStaticMarkup(createElement(WorkflowChips, {
    runs: [{ ...run, repoRoot: "/checkouts/demo-repo" }, second],
  }));
  assert.match(both, /class="workflow-chip-repo">demo-repo<\/span> Review changes/);
  assert.match(both, /class="workflow-chip-repo">second-repo<\/span> Approved/);
  // Each chip keeps its own tone, which is the whole reason both are drawn: one repository
  // can be approved while its sibling is still being repaired.
  assert.match(both, /workflow-chip workflow-waiting/);
  assert.match(both, /workflow-chip workflow-passed/);

  // The single-run session - which is nearly every session - draws the chip that was drawn
  // before any of this existed, down to the byte. Tooltip ids are React's own per-render
  // `useId` output and are normalized away; everything else has to match exactly, because a
  // repository name creeping onto a one-run chip would rewrite the accessible name every
  // existing spec selects by.
  const ids = (markup: string): string => markup.replaceAll(/_R_[a-z0-9]+_/g, "_id_");
  assert.equal(
    ids(renderToStaticMarkup(createElement(WorkflowChips, { runs: [run] }))),
    ids(renderToStaticMarkup(createElement(WorkflowChip, { run }))),
  );
});

test("the rail row wears the held mark at rail density, on the state's own line", () => {
  // The rail shows more rows per screen than any other surface, so the section rule
  // scrolls away soonest there - a held row must read held on its own, and must do it
  // without spending the row's two-line budget on a third line.
  const rowProps = { selected: false, onSelect: () => {} };
  const heldRow = renderToStaticMarkup(
    createElement(RailRow, {
      ...rowProps,
      session: mkSession({ state: "idle", activity: null }),
      workflowRun: run,
      workflowRuns: [run],
    }),
  );
  assert.match(heldRow, /class="rail-row [^"]*is-held/);
  assert.match(heldRow, /class="rail-state-line"/);
  assert.match(heldRow, /class="rail-held"[^>]*>held</);
  assert.match(heldRow, /Held by Review - the run owns this session/);

  const released = renderToStaticMarkup(
    createElement(RailRow, {
      ...rowProps,
      session: mkSession({ state: "idle", activity: null }),
      workflowRun: { ...run, status: "completed" as const },
      workflowRuns: [{ ...run, status: "completed" as const }],
    }),
  );
  assert.doesNotMatch(released, /is-held/);
  assert.doesNotMatch(released, /rail-held/);

  // The third surface reads the same shared sentence as the tile and the card.
  const rail = readFileSync(
    new URL("../src/web/components/layouts/RailRow.tsx", import.meta.url),
    "utf8",
  );
  assert.match(rail, /sessionIsHeld\(/);
});
