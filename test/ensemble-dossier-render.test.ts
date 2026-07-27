/**
 * What is at stake: the decision is the one moment the operator cannot undo, and until now the
 * material to make it was scattered across three sections of the page.
 *
 * A candidate's own claims lived under Members, its score and the judge's reasoning under
 * Result, its diff under Artifacts. Comparing two of five meant scrolling among them and
 * holding the difference in your head - and then confirming a winner reset one checkout and
 * reaped the others. So this pins the dossier's promises: what was at stake is stated (the run
 * intent, which appeared NOWHERE before), each column composes claims, observed diffstat, cost
 * and score, unknown cost stays unknown rather than reading as free, the panel's disagreement is
 * a matrix and a quoted dissent rather than five ballots to open, and after the fact the record
 * says what was chosen, why, and that the losers' work was kept rather than deleted.
 *
 * The one-shot rule (`expectedStatus`) is the server's and is not re-implemented here; what is
 * pinned is that the operator is TOLD before the click rather than by a 409 after it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import type {
  EnsembleArtifact,
  EnsembleAttempt,
  EnsembleDecision,
  EnsembleEvaluation,
  EnsembleMember,
  EnsembleRun,
  EnsembleStageAttempt,
} from "../src/shared/ensemble.ts";
import type { PanelVerdict } from "../src/shared/ensemble-strategies/panel-vote.ts";
import { ENSEMBLE_RESULT_RENDERERS } from "../src/web/ensembles/results/index.ts";
import type { EnsembleRunDetailResponse } from "../src/web/ensembles/types.ts";

const run: EnsembleRun = {
  id: "run-1",
  sourceKind: "manual",
  sourceKey: "key-1",
  sourceId: null,
  strategyId: "best_of_n",
  strategyKey: "best_of_n@1",
  strategyVersion: 1,
  strategyLabel: "Best of N",
  title: "Fix the parser",
  intent: "Stop the tokenizer dropping trailing newlines",
  repoRoot: "/repo",
  baseBranch: "main",
  baseSha: "abcdef0123456789",
  plan: {
    planVersion: 1,
    strategyKey: "best_of_n@1",
    budget: { maxMembers: 2, maxConcurrentMembers: 2, maxWaves: 1, maxStageAttempts: 2, deadlineMs: null },
    information: { kind: "isolated" },
    roles: [],
    stages: [],
  },
  strategyConfig: {},
  status: "awaiting_decision",
  activeStageId: "decide",
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

/** A submitted snapshot: claims, the diffstat we measured ourselves, and its agent cost. */
function artifact(
  id: string,
  attemptId: string,
  over: { cost?: number | null; summary?: string } = {},
): EnsembleArtifact {
  const cost = over.cost === undefined ? 0.4 : over.cost;
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
    metadata: {
      reported: { summary: over.summary ?? `${id} did the thing`, checks: ["npm test"] },
      observed: { filesChanged: 2, insertions: 10, deletions: 3 },
      ...(cost === null ? {} : { agentCostUsd: cost }),
    },
    error: null,
    createdAt: 1200,
    readyAt: 1300,
  };
}

const stage: EnsembleStageAttempt = {
  id: "sa-1",
  runId: "run-1",
  stageId: "compare",
  driverKind: "review",
  driverKey: "comparative_review@1",
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

const comparison: EnsembleEvaluation = {
  id: "eval-1",
  runId: "run-1",
  stageAttemptId: "sa-1",
  attempt: 1,
  method: "comparative_review",
  runnerId: "claude",
  modelId: "claude-opus",
  inputFingerprint: "fp",
  subjectArtifactIds: ["art-1", "art-2"],
  result: {
    payloadVersion: 1,
    body: {
      version: 1,
      recommendedArtifactId: "art-1",
      comparison: "Both compile; the first is cleaner.",
      caveats: [],
      scorecards: [
        { artifactId: "art-1", score: 90, rank: 1, strengths: ["clean"], risks: [], rationale: "clear fix", confidence: 0.8 },
        { artifactId: "art-2", score: 70, rank: 2, strengths: [], risks: ["broad"], rationale: "works but risky", confidence: 0.5 },
      ],
      evidenceTruncated: false,
    },
  },
  status: "succeeded",
  error: null,
  createdAt: 1400,
  updatedAt: 1500,
  finishedAt: 1500,
};

function decision(over: Partial<EnsembleDecision> = {}): EnsembleDecision {
  return {
    id: "dec-1",
    runId: "run-1",
    version: 1,
    actor: "human",
    actorId: "operator",
    status: "applied",
    selection: { payloadVersion: 1, body: { kind: "selected", artifactId: "art-1" } },
    rationale: "The second one rewrote the lexer for no reason.",
    finalizationStageAttemptId: "sa-2",
    createdAt: 2000,
    updatedAt: 2100,
    ...over,
  };
}

function detail(over: Partial<EnsembleRunDetailResponse> = {}): EnsembleRunDetailResponse {
  return {
    run,
    members: [member("m-1", 1), member("m-2", 2)],
    attempts: [attempt("at-1", "m-1"), attempt("at-2", "m-2")],
    artifacts: [artifact("art-1", "at-1"), artifact("art-2", "at-2")],
    stageAttempts: [stage],
    evaluations: [comparison],
    decisions: [],
    llmCalls: [],
    events: [],
    pagination: { eventsTotal: 0, eventsReturned: 0, attemptsTotal: 2, attemptsReturned: 2 },
    ...over,
  };
}

const subjectLabel = (artifactId: string): string =>
  artifactId === "art-1" ? "Candidate 1 (claude · claude-opus)" : "Candidate 2 (claude · claude-opus)";

function renderBestOfN(
  over: Partial<EnsembleRunDetailResponse> = {},
  ctx: {
    decision?: boolean;
    onRestoreArtifact?: (artifactId: string) => void;
    restorePendingArtifactId?: string | null;
  } = {},
): string {
  return renderToStaticMarkup(
    createElement(ENSEMBLE_RESULT_RENDERERS.best_of_n!, {
      detail: detail(over),
      subjectLabel,
      onOpenArtifact: () => {},
      onRestoreArtifact: ctx.onRestoreArtifact,
      restorePendingArtifactId: ctx.restorePendingArtifactId ?? null,
      decision: ctx.decision
        ? { busy: false, pending: false, error: null, onDecide: () => {} }
        : null,
    }),
  );
}

// ---- At stake ----

test("the dossier leads with what the run was FOR, which the page never showed anywhere", () => {
  const html = renderBestOfN({}, { decision: true });
  assert.match(html, /At stake/);
  assert.match(html, /Stop the tokenizer dropping trailing newlines/);
  // The three facts that qualify the choice: one base commit (which is what makes the
  // candidates comparable at all), elapsed, and what the fleet spent getting here.
  assert.match(html, /Every candidate started at/);
  assert.match(html, /abcdef0123/);
  assert.match(html, /Candidate spend/);
  assert.match(html, /\$0\.80/);
});

test("a candidate that reported no cost is unknown, never $0.00", () => {
  // "$0.00" over a member whose runner reported nothing reads as "this candidate was free",
  // which is the one wrong answer a cost figure can give.
  const silent = renderBestOfN(
    { artifacts: [artifact("art-1", "at-1", { cost: null }), artifact("art-2", "at-2", { cost: null })] },
    { decision: true },
  );
  assert.match(silent, /Candidate spend[\s\S]*?not reported/);
  assert.doesNotMatch(silent, /\$0\.00/);
  assert.match(silent, /cost not reported/, "the column says so too, not just the header");

  // One reported, one silent: a partial total says how partial it is instead of under-counting.
  const partial = renderBestOfN(
    { artifacts: [artifact("art-1", "at-1", { cost: 0.4 }), artifact("art-2", "at-2", { cost: null })] },
    { decision: true },
  );
  assert.match(partial, /\$0\.40 · 1 of 2 reported/);
});

test("the dossier framing appears at the decision, not over a run still working", () => {
  // Mid-run the columns are the same columns - they are strictly richer than the scorecards
  // they replaced - but "At stake" and the decision belong to the moment there is a stake.
  const working = renderBestOfN({ run: { ...run, status: "evaluating" } });
  assert.doesNotMatch(working, /At stake/);
  assert.doesNotMatch(working, /Confirm the outcome/);
  assert.match(working, /Candidate 1 \(claude · claude-opus\)/);
});

// ---- the candidate columns ----

test("one column composes what the candidate claims, what we observed, and how it scored", () => {
  // G16: these three facts were in three different sections of the page.
  const html = renderBestOfN({}, { decision: true });
  assert.match(html, /Reported by this candidate/);
  assert.match(html, /art-1 did the thing/);
  assert.match(html, /npm test/);
  assert.match(html, /Claims, not verified by Mission Control/);
  assert.match(html, /Observed by Mission Control/);
  assert.match(html, /2 files · \+10 \/ -3/);
  assert.match(html, /score 90\/100 · confidence 80%/);
  assert.match(html, /Recommended/);
  assert.match(html, /Evidence/);
});

// ---- the decision form ----

test("the one-shot rule is stated before the click, not delivered as a 409 after it", () => {
  const html = renderBestOfN({}, { decision: true });
  assert.match(html, /Confirm the outcome/);
  assert.match(html, /cannot be replayed or revised/);
  assert.match(html, /No consensus/);
  assert.match(html, /the other worktrees will be reaped/);
  assert.match(html, /<button type="submit"[^>]*disabled/);
});

test("the override warning survives the hoist, and fires only against a real recommendation", () => {
  const panel = readFileSync(
    new URL("../src/web/ensembles/results/DecisionPanel.tsx", import.meta.url),
    "utf8",
  );
  // Both callers word the override in their own vocabulary; the CONDITION is one, and it is
  // guarded on there being something to override - a tied panel recommends nothing.
  assert.match(panel, /recommendedArtifactId !== null &&/);
  assert.match(panel, /artifactId !== recommendedArtifactId/);
  const bestOfN = readFileSync(
    new URL("../src/web/ensembles/results/BestOfN.tsx", import.meta.url),
    "utf8",
  );
  assert.match(bestOfN, /overrideWarning="You are overriding the recommendation/);
  // And the form itself exists once. A second copy is what drifted before.
  for (const file of ["BestOfN.tsx", "PanelVote.tsx"]) {
    const src = readFileSync(new URL(`../src/web/ensembles/results/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(src, /useState<"select" \| "no_consensus">/, `${file} re-implements the form`);
  }
});

// ---- the record, after the fact ----

test("a decided run keeps the dossier as the durable record of why", () => {
  const html = renderBestOfN(
    { run: { ...run, status: "completed", completedAt: 3000 }, decisions: [decision()] },
    { onRestoreArtifact: () => {} },
  );
  assert.doesNotMatch(html, /Confirm the outcome/, "a decision cannot be made twice");
  assert.match(html, /The decision/);
  assert.match(html, /Promoted <strong>Candidate 1/);
  assert.match(html, /The second one rewrote the lexer for no reason\./);
  assert.match(html, /not revisable/);
});

test("Restore is offered beside the LOSING columns, and never over the winner", () => {
  // G17: that the losers' snapshot refs survive finalization was discoverable only by knowing
  // what Reset checkout did in a different section. Beside the column it belongs to, it
  // explains itself - and offering it on the winner would invite resetting a promoted
  // checkout to the state it was already restored to.
  const html = renderBestOfN(
    { run: { ...run, status: "completed", completedAt: 3000 }, decisions: [decision()] },
    { onRestoreArtifact: () => {} },
  );
  assert.equal((html.match(/>Restore</g) ?? []).length, 1);
  const loser = html.slice(html.indexOf("Candidate 2 (claude"));
  assert.match(loser, /Restore/);
  assert.match(html, /snapshots were kept/);

  // Pending is per-artifact, read off the generic action surface the Artifacts section uses.
  const pending = renderBestOfN(
    { run: { ...run, status: "completed", completedAt: 3000 }, decisions: [decision()] },
    { onRestoreArtifact: () => {}, restorePendingArtifactId: "art-2" },
  );
  assert.match(pending, /Restoring…/);
});

test("a no-consensus decision says every snapshot was kept, and offers every one back", () => {
  const html = renderBestOfN(
    {
      run: { ...run, status: "completed", completedAt: 3000 },
      decisions: [
        decision({
          selection: { payloadVersion: 1, body: { kind: "no_consensus", reason: "both broke the build" } },
        }),
      ],
    },
    { onRestoreArtifact: () => {} },
  );
  assert.match(html, /No consensus - every snapshot was kept/);
  assert.match(html, /both broke the build/);
  assert.equal((html.match(/>Restore</g) ?? []).length, 2, "nothing was promoted, so nothing is excluded");
});

test("a finalization in flight is not presented as the settled record", () => {
  // The operator's answer is recorded but the destructive step is mid-run: offering Restore
  // here would ask to reset a checkout the finalizer is at that moment resetting itself.
  const html = renderBestOfN(
    { run: { ...run, status: "finalizing" }, decisions: [decision({ status: "recorded" })] },
    { onRestoreArtifact: () => {} },
  );
  assert.doesNotMatch(html, /The decision<\/h4>/);
  assert.doesNotMatch(html, />Restore</);
});

test("a decision in a vocabulary this build cannot read still says one was made", () => {
  // A newer build's selection shape must degrade to "a decision exists" - never to a guess
  // about which column lost, which is what decides who gets a Restore button.
  const html = renderBestOfN(
    {
      run: { ...run, status: "completed", completedAt: 3000 },
      decisions: [decision({ selection: { payloadVersion: 1, body: { kind: "elected", winners: ["art-1"] } } })],
    },
    { onRestoreArtifact: () => {} },
  );
  assert.match(html, /vocabulary this build cannot read/);
  assert.doesNotMatch(html, />Restore</);
});

test("the newest non-superseded decision is the one on the record", () => {
  const html = renderBestOfN(
    {
      run: { ...run, status: "completed", completedAt: 3000 },
      decisions: [
        decision({ id: "dec-1", version: 1, status: "superseded", rationale: "first thoughts" }),
        decision({
          id: "dec-2",
          version: 2,
          selection: { payloadVersion: 1, body: { kind: "selected", artifactId: "art-2" } },
          rationale: "on reflection, the second",
        }),
      ],
    },
    { onRestoreArtifact: () => {} },
  );
  assert.match(html, /on reflection, the second/);
  assert.doesNotMatch(html, /first thoughts/);
  assert.match(html, /Promoted <strong>Candidate 2/);
});

// ---- panel vote: the matrix and the dissent ----

function verdict(ordinal: number, label: string, order: string[]): PanelVerdict {
  return {
    version: 1,
    judgeKey: `judge-${ordinal}`,
    judgeLabel: label,
    summary: `${label} read the diffs.`,
    caveats: [],
    scorecards: order.map((artifactId, index) => ({
      artifactId,
      score: 90 - index * 20,
      rank: index + 1,
      strengths: [],
      risks: [],
      rationale: `${label} on ${artifactId}`,
      confidence: 0.8,
    })),
    evidenceTruncated: false,
  };
}

function ballot(ordinal: number, body: PanelVerdict): EnsembleEvaluation {
  return {
    ...comparison,
    id: `eval-${ordinal}`,
    attempt: ordinal,
    method: "panel_llm",
    result: { payloadVersion: 1, body: body as never },
    updatedAt: 1500 + ordinal,
  };
}

const panelRun: EnsembleRun = { ...run, strategyId: "panel_vote", strategyLabel: "Panel vote" };
const panelStage: EnsembleStageAttempt = { ...stage, stageId: "panel", driverKey: "panel_review@1" };

/** Two judges prefer art-1, the third prefers art-2 - a real split, the interesting case. */
const splitPanel = [
  ballot(1, verdict(1, "Correctness", ["art-1", "art-2"])),
  ballot(2, verdict(2, "Maintainability", ["art-1", "art-2"])),
  ballot(3, verdict(3, "Risk", ["art-2", "art-1"])),
];

function renderPanel(evaluations: EnsembleEvaluation[], withDecision = true): string {
  return renderToStaticMarkup(
    createElement(ENSEMBLE_RESULT_RENDERERS.panel_vote!, {
      detail: detail({ run: panelRun, stageAttempts: [panelStage], evaluations }),
      subjectLabel,
      decision: withDecision
        ? { busy: false, pending: false, error: null, onDecide: () => {} }
        : null,
    }),
  );
}

test("the rank matrix draws every judge's cell, marking where one broke with the panel", () => {
  // G18: the ballots always carried this, but reading "where did the panel split" meant
  // opening all of them. `entry.ranks` is a re-projection - no new wire, and no second
  // opinion about who won.
  const html = renderPanel(splitPanel);
  const matrix = html.slice(html.indexOf('class="dossier-matrix"'));
  assert.match(matrix, /Judge/);
  for (const judge of ["Correctness", "Maintainability", "Risk"]) {
    assert.ok(matrix.includes(judge), `${judge} has no row in the matrix`);
  }
  // 3 judges x 2 candidates, plus the panel's own aggregate row.
  const cells = matrix.slice(0, matrix.indexOf("</table>")).match(/class="dossier-cell/g) ?? [];
  assert.equal(cells.length, 8);
  // Risk ranked art-1 second where the panel ranked it first, and art-2 first where the panel
  // ranked it second: two split cells, and only Risk's.
  const split = matrix.slice(0, matrix.indexOf("</table>")).match(/dossier-cell is-split/g) ?? [];
  assert.equal(split.length, 2);
});

test("a unanimous panel draws a matrix with nothing marked", () => {
  const html = renderPanel([
    ballot(1, verdict(1, "Correctness", ["art-1", "art-2"])),
    ballot(2, verdict(2, "Risk", ["art-1", "art-2"])),
  ]);
  assert.match(html, /dossier-matrix/);
  assert.doesNotMatch(html, /dossier-cell is-split/);
  assert.doesNotMatch(html, /Dissent on the recommendation/, "nobody dissented");
});

test("the dissent quotes the ballot that liked the winner least, in its own words", () => {
  const html = renderPanel(splitPanel);
  assert.match(html, /Dissent on the recommendation/);
  // Risk put the winner last, and this is Risk's rationale for THAT candidate - not its
  // summary, and not its rationale for the one it preferred.
  assert.match(
    html,
    /Risk<\/span> ranked Candidate 1 \(claude · claude-opus\) #2: &quot;Risk on art-1&quot;/,
  );
  assert.doesNotMatch(html, /Correctness<\/span> ranked/, "the judges who agreed are not dissenters");
});

test("a single ballot draws neither a matrix nor a dissent", () => {
  // One judge is not a disagreement, and a one-row matrix would present it as consensus.
  const html = renderPanel([ballot(1, verdict(1, "Correctness", ["art-1", "art-2"]))]);
  assert.doesNotMatch(html, /dossier-matrix/);
  assert.doesNotMatch(html, /Dissent on the recommendation/);
});

test("a tied panel preselects nothing and warns about no recommendation it does not have", () => {
  const html = renderPanel([
    ballot(1, verdict(1, "Correctness", ["art-1", "art-2"])),
    ballot(2, verdict(2, "Risk", ["art-2", "art-1"])),
  ]);
  assert.match(html, /could not be separated by the panel/);
  assert.doesNotMatch(html, /ensemble-recommended-tag|\(recommended\)|checked=""/);
  assert.doesNotMatch(html, /Dissent on the recommendation/);
});

test("every class the dossier renders has a rule in the stylesheet", () => {
  // There is no linter for a className that lost its rule, so this is it.
  const css = readFileSync(new URL("../src/web/styles.css", import.meta.url), "utf8");
  for (const cls of [
    "dossier-at-stake",
    "dossier-intent",
    "dossier-facts",
    "dossier-cols",
    "dossier-col",
    "dossier-claims",
    "dossier-cost",
    "dossier-col-actions",
    "dossier-matrix",
    "dossier-cell",
    "dossier-cell.is-split",
    "dossier-cell.is-absent",
    "dossier-matrix-aggregate",
    "dossier-dissent",
    "dossier-dissent-line",
    "dossier-record",
    "dossier-record-line",
    "dossier-record-rationale",
    "dossier-record-note",
    "ensemble-decision-oneshot",
  ]) {
    assert.ok(css.includes(`.${cls}`), `${cls} has no rule in styles.css`);
  }
});
