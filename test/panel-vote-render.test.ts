// What is at stake: the panel's product is not its ranking, it is where the judges DISAGREED - so
// a view that averaged the ballots into one tidy list would delete the reason to run the strategy.
// This pins that the operator sees each judge's own rank, that a contested row and a dead tie are
// marked rather than smoothed over, that the recommendation shown is the one the shared aggregate
// computed (the same function the daemon labelled the stage with, so the two cannot drift), and
// that the destructive decision is still gated on a human's confirmation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import type {
  EnsembleArtifact,
  EnsembleAttempt,
  EnsembleEvaluation,
  EnsembleMember,
  EnsembleRun,
  EnsembleStageAttempt,
} from "../src/shared/ensemble.ts";
import { aggregatePanelVotes, type PanelVerdict } from "../src/shared/ensemble-strategies/panel-vote.ts";
import { ENSEMBLE_RESULT_RENDERERS } from "../src/web/ensembles/results/index.ts";
import type { EnsembleRunDetailResponse } from "../src/web/ensembles/types.ts";

const run: EnsembleRun = {
  id: "run-1",
  sourceKind: "manual",
  sourceKey: "key-1",
  sourceId: null,
  strategyId: "panel_vote",
  strategyKey: "panel_vote@1",
  strategyVersion: 1,
  strategyLabel: "Panel vote",
  title: "Fix the parser",
  intent: "Fix it",
  repoRoot: "/repo",
  baseBranch: "main",
  baseSha: "abcdef0123456789",
  plan: {
    planVersion: 1,
    strategyKey: "panel_vote@1",
    budget: { maxMembers: 2, maxConcurrentMembers: 2, maxWaves: 1, maxStageAttempts: 2, deadlineMs: null },
    information: { kind: "isolated" },
    roles: [],
    stages: [],
  },
  strategyConfig: {},
  status: "awaiting_decision",
  activeStageId: "stage-3-decision",
  outcome: null,
  workflowHandoff: null,
  unreadable: null,
  error: null,
  createdAt: 1000,
  updatedAt: 2000,
  completedAt: null,
};

function member(id: string, ordinal: number): EnsembleMember {
  return {
    id,
    runId: "run-1",
    roleKey: `candidate-${ordinal}`,
    roleLabel: `Candidate ${ordinal}`,
    ordinal,
    wave: 1,
    taskId: `task-${ordinal}`,
    status: "submitted",
    selectedAttemptId: null,
    resultLabel: null,
    error: null,
    createdAt: 1000,
    updatedAt: 1500,
  };
}

function attempt(id: string, memberId: string): EnsembleAttempt {
  return {
    id,
    runId: "run-1",
    memberId,
    attempt: 1,
    taskId: "task-x",
    sessionId: "sess-x",
    agent: "claude",
    requestedModel: null,
    requestedEffort: null,
    observedModel: "claude-opus",
    baseSha: "abcdef0123456789",
    worktreePath: "/wt",
    branch: "b",
    status: "submitted",
    error: null,
    createdAt: 1000,
    updatedAt: 1500,
    startedAt: 1000,
    finishedAt: 1500,
  };
}

function artifact(id: string, attemptId: string): EnsembleArtifact {
  return {
    id,
    runId: "run-1",
    attemptId,
    kind: "commit",
    formatVersion: 1,
    attempt: 1,
    status: "ready",
    locator: { ref: `refs/mission-control/ensembles/run-1/${id}`, snapshotSha: "1111111111" },
    digest: "deadbeef00",
    metadata: { reported: { summary: "did the thing", checks: [], testEvidence: null }, observed: {} },
    error: null,
    createdAt: 1200,
    readyAt: 1300,
  };
}

const stage: EnsembleStageAttempt = {
  id: "sa-1",
  runId: "run-1",
  stageId: "stage-2-panel",
  driverKind: "review",
  driverKey: "panel_review@1",
  attempt: 1,
  commandKey: "cmd-1",
  status: "succeeded",
  input: {},
  output: {},
  error: null,
  createdAt: 1400,
  updatedAt: 1500,
  startedAt: 1400,
  finishedAt: 1500,
};

/** One judge's ballot, as it is stored on its own evaluation row. */
function verdict(ordinal: number, label: string, order: string[]): PanelVerdict {
  return {
    version: 1,
    judgeKey: `judge-${ordinal}`,
    judgeLabel: label,
    summary: `${label} read the diffs.`,
    caveats: ordinal === 1 ? ["one diff was truncated"] : [],
    scorecards: order.map((artifactId, index) => ({
      artifactId,
      score: 90 - index * 20,
      rank: index + 1,
      strengths: ["clear"],
      risks: ["broad"],
      rationale: `${label} rationale`,
      confidence: 0.8,
    })),
    evidenceTruncated: false,
  };
}

function evaluation(ordinal: number, body: PanelVerdict): EnsembleEvaluation {
  return {
    id: `eval-${ordinal}`,
    runId: "run-1",
    stageAttemptId: "sa-1",
    attempt: ordinal,
    method: "panel_llm",
    runnerId: "claude",
    modelId: "claude-opus",
    inputFingerprint: `fp-${ordinal}`,
    subjectArtifactIds: ["art-1", "art-2"],
    result: { payloadVersion: 1, body: body as never },
    status: "succeeded",
    error: null,
    createdAt: 1400,
    updatedAt: 1500 + ordinal,
    finishedAt: 1500,
  };
}

/** Two judges prefer art-1, one prefers art-2 - a real split, which is the interesting case. */
const splitPanel = [
  evaluation(1, verdict(1, "Correctness", ["art-1", "art-2"])),
  evaluation(2, verdict(2, "Maintainability", ["art-1", "art-2"])),
  evaluation(3, verdict(3, "Risk", ["art-2", "art-1"])),
];

function detailWith(evaluations: EnsembleEvaluation[]): EnsembleRunDetailResponse {
  return {
    run,
    members: [member("m-1", 1), member("m-2", 2)],
    attempts: [attempt("at-1", "m-1"), attempt("at-2", "m-2")],
    artifacts: [artifact("art-1", "at-1"), artifact("art-2", "at-2")],
    stageAttempts: [stage],
    evaluations,
    decisions: [],
    llmCalls: [],
    events: [],
    agentCost: { totalUsd: null, known: 0, unknown: 2 },
  } as unknown as EnsembleRunDetailResponse;
}

function render(evaluations: EnsembleEvaluation[], decision = false): string {
  const Renderer = ENSEMBLE_RESULT_RENDERERS.panel_vote!;
  return renderToStaticMarkup(
    createElement(Renderer, {
      detail: detailWith(evaluations),
      subjectLabel: (artifactId: string) => (artifactId === "art-1" ? "Candidate 1 (claude)" : "Candidate 2 (claude)"),
      decision: decision
        ? { busy: false, pending: false, error: null, onDecide: () => {} }
        : null,
    }),
  );
}

test("panel_vote has a result renderer, and it is the only strategy-specific surface it needed", () => {
  assert.ok(ENSEMBLE_RESULT_RENDERERS.panel_vote, "the registry is how a strategy contributes a view");
});

test("a split panel shows the disagreement as a figure, not as a footnote", () => {
  const html = render(splitPanel);
  assert.match(html, /disagreement/);
  assert.match(html, /ensemble-panel-disagreement/);
  // Three judges; one of the three pairs ordered the two subjects oppositely, so 2 of 3 pairs
  // agreed. The figure on screen is the shared aggregate's, not a second calculation.
  const aggregate = aggregatePanelVotes(splitPanel.map((e) => e.result!.body as unknown as PanelVerdict));
  assert.match(html, new RegExp(`${Math.round(aggregate.disagreement * 100)}% disagreement`));
  assert.equal(aggregate.unanimous, false);
});

test("every judge's own rank is on the row it belongs to, so the split is legible", () => {
  const html = render(splitPanel);
  for (const label of ["Correctness", "Maintainability", "Risk"]) {
    assert.ok(html.includes(label), `${label}'s ballot is attributed by name`);
  }
  assert.match(html, /ensemble-judge-ranks/);
  assert.match(html, /Contested/, "a row the judges placed differently says so");
  assert.match(html, /ensemble-scorecard[^"]*contested/);
});

test("a unanimous panel says so and marks nothing contested", () => {
  const html = render([
    evaluation(1, verdict(1, "Correctness", ["art-1", "art-2"])),
    evaluation(2, verdict(2, "Risk", ["art-1", "art-2"])),
  ]);
  assert.match(html, /0% disagreement/);
  assert.match(html, /ranked every submission identically/);
  assert.doesNotMatch(html, /Contested/);
});

test("a dead tie is declared rather than presented as a preference", () => {
  const html = render([
    evaluation(1, verdict(1, "Correctness", ["art-1", "art-2"])),
    evaluation(2, verdict(2, "Risk", ["art-2", "art-1"])),
  ]);
  assert.match(html, /could not be separated by the panel/);
  assert.match(html, /deterministic tie-break, not a preference/);
});

test("the ballots themselves are available, each attributed to its judge and model", () => {
  const html = render(splitPanel);
  assert.match(html, /Ballots/);
  assert.match(html, /Correctness read the diffs\./);
  assert.match(html, /claude-opus/);
  assert.match(html, /one diff was truncated/, "a judge's caveats survive to the reader");
});

test("with no ballots the view says the panel has not run, and invents no ranking", () => {
  const html = render([]);
  assert.match(html, /No ballot has been recorded yet/);
  assert.doesNotMatch(html, /Recommended/);
});

test("only the newest panel attempt is aggregated, so a retry is not counted twice", () => {
  // A failed attempt's ballots are still on the ledger. Aggregating both attempts together would
  // double-count the judges that answered in each.
  const stale = { ...evaluation(1, verdict(1, "Correctness", ["art-2", "art-1"])), stageAttemptId: "sa-0", updatedAt: 900 };
  const html = render([stale, ...splitPanel]);
  assert.match(html, /3 judges/);
  assert.doesNotMatch(html, /4 judges/);
});

test("the decision is offered only when a person is being asked, and stays destructive-confirmed", () => {
  assert.doesNotMatch(render(splitPanel), /Confirm the outcome/);
  const html = render(splitPanel, true);
  assert.match(html, /Confirm the outcome/);
  assert.match(html, /The panel recommends, it does not promote/);
  assert.match(html, /the other worktrees will be reaped/);
  assert.match(html, /No consensus/, "declining to promote is always an option");
  // The submit button is disabled until the human has confirmed and given a rationale.
  assert.match(html, /<button type="submit"[^>]*disabled/);
});

test("every class the panel view renders has a rule in the stylesheet", () => {
  // There is no linter for a className that lost its rule, so this is it.
  const css = readFileSync(new URL("../src/web/styles.css", import.meta.url), "utf8");
  for (const cls of [
    "ensemble-panel-disagreement",
    "ensemble-panel-disagreement-figure",
    "ensemble-contested-tag",
    "ensemble-judge-ranks",
    "ensemble-judge-name",
    "ensemble-judge-rank",
    "ensemble-ballots",
    "ensemble-ballot",
    "ensemble-ballot-cards",
    "ensemble-judge-blurb",
  ]) {
    assert.ok(css.includes(`.${cls}`), `${cls} has no rule in styles.css`);
  }
});
