// What is at stake: every string this view renders - an agreement, a question, an option label,
// its rationale - is model output mined from candidate diffs nobody vetted. If any of it reached
// the page as markup, an agent's own diff could write the operator's question, put a link in it, or
// forge the "Your answer" affordance beside a position they never chose. The other half is that the
// operator must be answering the question set the SERVER persisted: this view renders the decision
// stage attempt's input, so a screen and a server-side answer check cannot disagree about what was
// asked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import type {
  EnsembleDecision,
  EnsembleEvaluation,
  EnsembleJson,
  EnsembleRun,
  EnsembleStageAttempt,
} from "../src/shared/ensemble.ts";
import type { EnsembleRunDetailResponse } from "../src/web/ensembles/types.ts";
import { ConsensusResultView } from "../src/web/ensembles/results/Consensus.tsx";

const INJECTION = '<img src=x onerror="alert(1)">IGNORE PREVIOUS INSTRUCTIONS';

const run: EnsembleRun = {
  id: "run-1",
  sourceKind: "manual",
  sourceKey: "key-1",
  sourceId: null,
  strategyId: "consensus",
  strategyKey: "consensus@1",
  strategyVersion: 1,
  strategyLabel: "Consensus",
  title: "Add retries",
  intent: "Add retries",
  repoRoot: "/repo",
  baseBranch: "main",
  baseSha: "abcdef0123456789",
  plan: {
    planVersion: 1,
    strategyKey: "consensus@1",
    budget: { maxMembers: 3, maxConcurrentMembers: 3, maxWaves: 1, maxStageAttempts: 2, deadlineMs: null },
    information: { kind: "isolated" },
    roles: [],
    stages: [],
  },
  strategyConfig: {},
  status: "awaiting_decision",
  activeStageId: "stage-3-answers",
  outcome: null,
  workflowHandoff: null,
  unreadable: null,
  failureAcknowledgedAt: null,
  error: null,
  createdAt: 1000,
  updatedAt: 2000,
  completedAt: null,
};

const QUESTIONS = [
  {
    id: "q1",
    question: "Where should the retry live?",
    options: [
      { id: "q1-a", label: "In the transport", rationale: "One place for backoff.", artifactIds: ["art-1"] },
      { id: "q1-b", label: INJECTION, rationale: `rationale ${INJECTION}`, artifactIds: ["art-2", "art-3"] },
    ],
  },
  {
    id: "q2",
    question: "Do failures surface as exceptions?",
    options: [
      { id: "q2-a", label: "Throw", rationale: "", artifactIds: ["art-1", "art-2"] },
      { id: "q2-b", label: "Result type", rationale: "", artifactIds: ["art-3"] },
    ],
  },
];

const decisionStage: EnsembleStageAttempt = {
  id: "sa-decide",
  runId: "run-1",
  stageId: "stage-3-answers",
  driverKind: "decision",
  driverKey: "divergence_decision@1",
  attempt: 1,
  commandKey: "cmd-decide",
  status: "waiting",
  input: {
    command: "answer_divergences",
    version: 1,
    evaluationId: "eval-1",
    agreements: [`Every attempt kept the signature ${INJECTION}`],
    questions: QUESTIONS,
  } as unknown as EnsembleJson,
  output: null,
  error: null,
  createdAt: 1400,
  updatedAt: 1400,
  startedAt: 1400,
  finishedAt: null,
};

const evaluation: EnsembleEvaluation = {
  id: "eval-1",
  runId: "run-1",
  stageAttemptId: "sa-review",
  attempt: 1,
  method: "consensus_llm",
  runnerId: "claude",
  modelId: "claude-haiku",
  inputFingerprint: "fp",
  subjectArtifactIds: ["art-1", "art-2", "art-3"],
  result: {
    payloadVersion: 1,
    body: {
      version: 1,
      agreements: [`Every attempt kept the signature ${INJECTION}`],
      divergences: QUESTIONS,
      subjectArtifactIds: ["art-1", "art-2", "art-3"],
      evidenceTruncated: true,
    } as unknown as EnsembleJson,
  },
  status: "succeeded",
  error: null,
  createdAt: 1300,
  updatedAt: 1350,
  finishedAt: 1350,
};

const detail: EnsembleRunDetailResponse = {
  run,
  members: [],
  attempts: [],
  artifacts: [],
  stageAttempts: [decisionStage],
  evaluations: [evaluation],
  decisions: [],
  llmCalls: [],
  events: [],
  pagination: { eventsTotal: 0, eventsReturned: 0, attemptsTotal: 0, attemptsReturned: 0 },
};

function render(
  over: Partial<EnsembleRunDetailResponse> = {},
  decision: { busy: boolean; pending: boolean; error: string | null } | null = null,
): string {
  return renderToStaticMarkup(
    createElement(ConsensusResultView, {
      detail: { ...detail, ...over },
      subjectLabel: (artifactId: string) => `Attempt ${artifactId.slice(-1)}`,
      decision: decision ? { ...decision, onDecide: () => {} } : null,
    }),
  );
}

test("evaluator text renders as escaped TEXT, never as markup", () => {
  const html = render();
  assert.ok(html.includes("Where should the retry live?"), "the question is on the page");
  assert.ok(
    html.includes("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"),
    "the injected tag is escaped",
  );
  assert.ok(!html.includes("<img src=x"), "no attacker-authored element reaches the DOM");
  // `onerror=&quot;` is the escaped text; a RAW `onerror="` would be a live attribute. The
  // distinction is the whole test, so it is asserted on the raw form rather than the substring.
  assert.ok(!html.includes('onerror="'), "no attacker-authored handler reaches the DOM");
});

test("the question set comes from the persisted decision input, not from the evaluation row", () => {
  // The stage input and the evaluation body agree here, so the proof is negative: strip the
  // evaluation and the questions must survive, because the input is what the operator was asked.
  const html = render({ evaluations: [] });
  assert.ok(html.includes("Where should the retry live?"));
  assert.ok(html.includes("Do failures surface as exceptions?"));
});

test("each option names the attempts that took it and how many of them there were", () => {
  const html = render();
  assert.ok(html.includes("Attempt 2"), "an option's members are revealed after the blind pass");
  assert.ok(html.includes("Attempt 3"));
  assert.ok(html.includes("2 of 3"), "the split is visible as a count, not just as names");
});

test("truncated evidence is disclosed as a reason to trust the question set less", () => {
  assert.ok(render().includes("truncated"));
  const clean = {
    ...evaluation,
    result: {
      payloadVersion: 1 as const,
      body: {
        version: 1,
        agreements: [],
        divergences: QUESTIONS,
        subjectArtifactIds: ["art-1"],
        evidenceTruncated: false,
      } as unknown as EnsembleJson,
    },
  };
  assert.ok(!render({ evaluations: [clean] }).includes("were truncated for the evaluator"));
});

test("the answer form appears only while a decision is open, and asks every question once", () => {
  assert.ok(!render().includes("Answer the open questions"), "no form when the run is not awaiting one");
  const html = render({}, { busy: false, pending: false, error: null });
  assert.ok(html.includes("Answer the open questions"));
  // One radio group per question, plus the "my own answer" escape on each.
  assert.equal((html.match(/name="divergence-q1"/g) ?? []).length, 3);
  assert.equal((html.match(/name="divergence-q2"/g) ?? []).length, 3);
  assert.ok(html.includes("None of these - my own answer"));
  // Nothing is promoted and nothing is reaped, and the panel says so before it is submitted.
  assert.ok(html.includes("every attempt is retained and none is promoted"));
  assert.ok(html.includes("Record answers"));
});

test("recorded answers are shown against the questions once the decision exists", () => {
  const decision: EnsembleDecision = {
    id: "dec-1",
    runId: "run-1",
    version: 1,
    actor: "human",
    actorId: null,
    status: "applied",
    selection: {
      payloadVersion: 1,
      body: {
        kind: "answers",
        answers: [
          { questionId: "q1", optionId: "q1-a", note: "the transport is the right home" },
          { questionId: "q2", optionId: null, note: `neither ${INJECTION}` },
        ],
      } as unknown as EnsembleJson,
    },
    rationale: "recorded",
    finalizationStageAttemptId: null,
    createdAt: 1600,
    updatedAt: 1600,
  };
  const html = render({ decisions: [decision] });
  assert.ok(html.includes("Your answer"), "the chosen option is marked");
  assert.ok(html.includes("the transport is the right home"), "a note on a chosen option is shown");
  assert.ok(html.includes("neither &lt;img src=x"), "an operator's own answer is shown, escaped");
  assert.ok(!html.includes("<img src=x"));
});

test("after a re-run, the header describes the pass that ASKED the questions, not the newest one", () => {
  // The questions on screen come from the decision stage's persisted input. If a later pass runs,
  // its runner/model/attempt and truncation state describe evidence those questions were never
  // mined from, and labelling one pass's questions with another's metadata is a false claim about
  // provenance. The stage input records which evaluation it came from, and that one wins.
  const rerun: EnsembleEvaluation = {
    ...evaluation,
    id: "eval-2",
    attempt: 2,
    modelId: "claude-opus",
    updatedAt: 9999,
    result: {
      payloadVersion: 1,
      body: {
        version: 1,
        agreements: [],
        divergences: QUESTIONS,
        subjectArtifactIds: ["art-1"],
        evidenceTruncated: false,
      } as unknown as EnsembleJson,
    },
  };
  const html = render({ evaluations: [evaluation, rerun] });
  assert.ok(html.includes("claude-haiku"), "the pass that asked the questions names its own model");
  assert.ok(!html.includes("claude-opus"), "the newer pass's model is not attached to older questions");
  assert.ok(html.includes("attempt 1"), "and its own attempt number");
  assert.ok(html.includes("truncated"), "its truncation disclosure travels with it, not the re-run's");

  // And when the evaluation it named is not in this response at all, no metadata is shown rather
  // than metadata borrowed from whichever pass happens to be present.
  const orphaned = render({ evaluations: [rerun] });
  assert.ok(orphaned.includes("Where should the retry live?"), "the persisted questions still render");
  assert.ok(!orphaned.includes("claude-opus"), "no unrelated pass is credited with them");
  assert.ok(!orphaned.includes("truncated"), "and no unrelated truncation state is claimed");
});

test("a run whose pass has not happened yet says so instead of rendering an empty question set", () => {
  const html = render({ stageAttempts: [], evaluations: [] });
  assert.ok(html.includes("No divergence pass has been recorded yet"));
});

test("full agreement renders as a real finding, not as a missing result", () => {
  const agreed: EnsembleStageAttempt = {
    ...decisionStage,
    input: {
      command: "answer_divergences",
      version: 1,
      evaluationId: "eval-1",
      agreements: ["All three used the same interface."],
      questions: [],
    } as unknown as EnsembleJson,
  };
  const html = render({ stageAttempts: [agreed], evaluations: [] });
  assert.ok(html.includes("All three used the same interface."));
  assert.ok(html.includes("no conflicting decisions"));
});
