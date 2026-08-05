import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import type { WorkflowRunSummary } from "../src/shared/workflow.ts";
import {
  WorkflowChip,
  WorkflowRailMark,
  workflowRunTone,
} from "../src/web/components/session-bits.tsx";
import { SessionCard } from "../src/web/components/SessionCard.tsx";
import { mkSession } from "./helpers/session-fixture.ts";

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
  assert.match(card, /<WorkflowChip/);
  assert.match(detail, /<WorkflowChip/);
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
    createElement(SessionCard, { session: idle, expanded: false, workflowRun: run }),
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
    }),
  );
  assert.doesNotMatch(asking, /is-held/);

  // Both card-shaped surfaces read the ONE shared sentence, so they cannot drift.
  const card = readFileSync(new URL("../src/web/components/SessionCard.tsx", import.meta.url), "utf8");
  const tile = readFileSync(new URL("../src/web/components/layouts/SessionTile.tsx", import.meta.url), "utf8");
  assert.match(card, /sessionIsHeld\(/);
  assert.match(tile, /sessionIsHeld\(/);
});
