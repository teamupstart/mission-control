/**
 * What is at stake: whether a change raised in round 1 and still raised in round 10 is ONE
 * grievance or ten.
 *
 * `RequestedChange` carries no id, so identity has to be derived, and every wrong answer here
 * is a confident sentence about a run that is not true: a finding re-raised on every edit
 * because the key moved with the line, two reviewers folded into one row so the loser's
 * evidence disappears, or - the worst of them - a change filed under Archive as "resolved"
 * because some OTHER reviewer advanced the round while its own never looked again.
 *
 * The stalemate half is pinned against `repeatOffenders` itself rather than against
 * hand-written expectations. The two derivations are deliberate duplicates - one server-side
 * for the ladder and the alert engine, one windowed for the browser - and duplication that is
 * not pinned is duplication that drifts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  PersonaSnapshot,
  RequestedChange,
  WorkflowNodeAttempt,
  WorkflowNodeAttemptState,
  WorkflowRunDetail,
  WorkflowSubmission,
} from "../src/shared/workflow.ts";
import { repeatOffenders } from "../src/server/workflows/repeat-offender.ts";
import type { ChangeWorklistRow } from "../src/web/workflows/run-model.ts";
import {
  requestedChangeKey,
  runChangeWorklist,
  runStalemates,
} from "../src/web/workflows/run-model.ts";

const RISK = "risk-review";
const EVIDENCE = "evidence-review";
const PERSONA_NAMES: Record<string, string> = {
  [RISK]: "Code Risk Reviewer",
  [EVIDENCE]: "Test Evidence Auditor",
};

function personaOf(nodeId: string): PersonaSnapshot {
  return {
    sourcePersonaId: `persona-${nodeId}`,
    sourceRevision: 1,
    name: PERSONA_NAMES[nodeId] ?? nodeId,
    description: "",
    guidanceMarkdown: "Review it.",
    runner: null,
    model: null,
  };
}

function change(title: string, extra: Partial<RequestedChange> = {}): RequestedChange {
  return {
    title,
    rationale: `Why: ${title}`,
    evidence: [{ kind: "diff", quote: `Evidence for ${title}` }],
    ...extra,
  };
}

/** A fail verdict, strict-schema valid, carrying exactly the changes handed to it. */
function fail(...changes: RequestedChange[]): unknown {
  return {
    verdict: "fail",
    summary: "Changes requested.",
    requestedChanges: changes,
    confidence: 0.8,
  };
}

const PASS = {
  verdict: "pass",
  summary: "Everything asked for is present.",
  approvalDetails: { reason: "The fix is in the diff.", evidence: [] },
  confidence: 0.9,
};

interface AttemptSpec {
  round: number;
  /** The evidence segment inside the round. A session action opens `segment + 1`. */
  segment?: number;
  node?: string;
  attempt?: number;
  state?: WorkflowNodeAttemptState;
  /** `null` models a Check node, which records an attempt with no Persona snapshot. */
  persona?: PersonaSnapshot | null;
  verdict?: unknown;
}

function submissionOf(round: number, segment: number): WorkflowSubmission {
  return {
    id: `s${round}-${segment}`,
    runId: "run",
    round,
    segment,
    parentSubmissionId: segment === 0 ? null : `s${round}-${segment - 1}`,
    continuationNodeId: null,
    continuationNodeAttemptId: null,
    mode: "full_workflow",
    triggerSource: "manual",
    triggerKey: `manual:run:${round}:${segment}`,
    evidenceFingerprint: `evidence-${round}-${segment}`,
    context: {},
    evidence: {},
    prHeadSha: null,
    status: "completed",
    createdAt: round * 10 + segment,
    updatedAt: round * 10 + segment,
    completedAt: round * 10 + segment,
  };
}

function attemptOf(spec: AttemptSpec): WorkflowNodeAttempt {
  const segment = spec.segment ?? 0;
  const nodeId = spec.node ?? RISK;
  const attempt = spec.attempt ?? 1;
  return {
    id: `a-${spec.round}-${segment}-${nodeId}-${attempt}`,
    submissionId: `s${spec.round}-${segment}`,
    nodeId,
    attempt,
    state: spec.state ?? "completed",
    persona: spec.persona === undefined ? personaOf(nodeId) : spec.persona,
    sessionAction: null,
    runner: "claude",
    model: "reviewer",
    verdict: (spec.verdict ?? null) as WorkflowNodeAttempt["verdict"],
    output: null,
    retryAt: null,
    inputFingerprint: `input-${spec.round}-${segment}`,
    error: null,
    createdAt: spec.round * 10 + segment,
    updatedAt: spec.round * 10 + segment,
    startedAt: spec.round * 10 + segment,
    finishedAt: spec.round * 10 + segment,
  };
}

/**
 * A run detail from a list of attempts, with the submissions they imply.
 *
 * `repeatOffenders` is filled by the SERVER derivation, exactly as `WorkflowStore.runDetail`
 * fills it, so every parity assertion in this file compares the browser twin against the real
 * thing rather than against a second guess at what it should say.
 */
function detailOf(specs: AttemptSpec[], emptyRounds: number[] = []): WorkflowRunDetail {
  const keys = new Set<string>();
  for (const spec of specs) keys.add(`${spec.round}:${spec.segment ?? 0}`);
  for (const round of emptyRounds) keys.add(`${round}:0`);
  const submissions = [...keys]
    .map((key) => {
      const [round, segment] = key.split(":").map(Number) as [number, number];
      return submissionOf(round, segment);
    })
    .sort((left, right) => left.round - right.round || left.segment - right.segment);
  const attempts = specs.map(attemptOf);
  return {
    submissions,
    attempts,
    events: [],
    receipts: [],
    deliveries: [],
    summary: { round: submissions.at(-1)?.round ?? 0 },
    run: { status: "running" },
    repeatOffenders: repeatOffenders(submissions, attempts),
  } as unknown as WorkflowRunDetail;
}

function rowFor(rows: ChangeWorklistRow[], title: string): ChangeWorklistRow {
  const found = rows.filter((row) => row.title === title);
  assert.equal(found.length, 1, `expected exactly one row titled ${title}`);
  return found[0]!;
}

// ---- identity ----------------------------------------------------------------------------

test("case, backticks, emphasis, whitespace and trailing punctuation are one change", () => {
  const base = requestedChangeKey(RISK, change("Attach the test output", { path: "src/a.ts" }));
  for (const title of [
    "attach the test output",
    "ATTACH THE TEST OUTPUT",
    "Attach the `test` output",
    "Attach the **test** output.",
    "  Attach   the test   output.  ",
    "Attach the \"test\" output!?",
  ]) {
    assert.equal(
      requestedChangeKey(RISK, change(title, { path: "src/a.ts" })),
      base,
      `${title} should key the same as the plain sentence`,
    );
  }
});

test("the line number is excluded, because the next edit moves it", () => {
  assert.equal(
    requestedChangeKey(RISK, change("Attach the test output", { path: "src/a.ts", line: 12 })),
    requestedChangeKey(RISK, change("Attach the test output", { path: "src/a.ts", line: 480 })),
  );
});

test("the path is part of identity, and so is the reviewer", () => {
  const here = requestedChangeKey(RISK, change("Attach the test output", { path: "src/a.ts" }));
  assert.notEqual(
    here,
    requestedChangeKey(RISK, change("Attach the test output", { path: "src/b.ts" })),
  );
  assert.notEqual(here, requestedChangeKey(RISK, change("Attach the test output")));
  // The divergence from `marker.ts`: one Inspector cannot collide with itself, several
  // Personas reviewing at once can.
  assert.notEqual(
    here,
    requestedChangeKey(EVIDENCE, change("Attach the test output", { path: "src/a.ts" })),
  );
});

test("a change with no path keys, and does not collide with another pathless change", () => {
  assert.notEqual(
    requestedChangeKey(RISK, change("Attach the test output")),
    requestedChangeKey(RISK, change("Explain the retry loop")),
  );
  const detail = detailOf([
    { round: 1, verdict: fail(change("Attach the test output")) },
    { round: 2, verdict: fail(change("Attach the test output"), change("Explain the retry loop")) },
  ]);
  const rows = runChangeWorklist(detail, null);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.path), [null, null]);
  assert.equal(rowFor(rows, "Attach the test output").roundsOpen, 2);
});

// ---- folding rounds ----------------------------------------------------------------------

test("one title raised in two rounds is one row, open since the first of them", () => {
  const detail = detailOf([
    { round: 1, verdict: fail(change("Attach the test output", { path: "src/a.ts" })) },
    { round: 2, verdict: fail(change("Attach the test output", { path: "src/a.ts" })) },
  ]);
  const rows = runChangeWorklist(detail, null);
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.equal(row.firstRound, 1);
  assert.equal(row.lastRound, 2);
  assert.equal(row.roundsOpen, 2);
  assert.equal(row.state, "open");
  assert.equal(row.nodeId, RISK);
  assert.equal(row.personaName, "Code Risk Reviewer");
  assert.equal(row.path, "src/a.ts");
  assert.equal(row.confidence, 0.8);
  assert.equal(row.evidence.length, 1);
  // The row's key IS the exported identity, so Phase 2's selection and its React key are the
  // same string this function grouped on.
  assert.equal(
    row.key,
    requestedChangeKey(RISK, change("Attach the test output", { path: "src/a.ts" })),
  );
});

test("two segments of one round are ONE round, here and in the repeat-offender streak", () => {
  // The regression the shared folding rule exists for: a session action splits a round into
  // several evidence segments, and counting submissions would call this three rounds.
  const detail = detailOf([
    { round: 1, segment: 0, verdict: fail(change("Attach the test output")) },
    { round: 1, segment: 1, verdict: fail(change("Attach the test output")) },
    { round: 2, segment: 0, verdict: fail(change("Attach the test output")) },
  ]);
  const row = runChangeWorklist(detail, null)[0]!;
  assert.equal(row.roundsOpen, 2);
  assert.equal(row.firstRound, 1);
  assert.equal(row.lastRound, 2);
  assert.deepEqual(runStalemates(detail, null), detail.repeatOffenders);
  assert.equal(runStalemates(detail, null)[0]?.rounds, 2);
});

test("a round the reviewer stayed silent in is not counted as open", () => {
  const detail = detailOf([
    { round: 1, verdict: fail(change("Attach the test output")) },
    { round: 2, verdict: fail(change("Explain the retry loop")) },
    { round: 3, verdict: fail(change("Attach the test output")) },
  ]);
  const row = rowFor(runChangeWorklist(detail, null), "Attach the test output");
  // A span would say 3. `roundsOpen` counts appearances, so it never claims round 2.
  assert.equal(row.roundsOpen, 2);
  assert.equal(row.firstRound, 1);
  assert.equal(row.lastRound, 3);
  assert.equal(row.state, "open");
});

test("the shared fold decides which attempt ends a round, and both derivations agree", () => {
  // A retry inside segment 0, then a re-run in segment 1. The rule keeps the higher-numbered
  // attempt, which is the corner where the server module's guard and its own prose disagree.
  // Whatever it answers, this file has to answer the same - that is the whole point of
  // duplicating the rule rather than inventing a second one.
  const detail = detailOf([
    { round: 1, verdict: fail(change("Attach the test output")) },
    { round: 2, segment: 0, attempt: 1, state: "error", verdict: null },
    { round: 2, segment: 0, attempt: 2, verdict: fail(change("Attach the test output")) },
    { round: 2, segment: 1, attempt: 1, verdict: PASS },
  ]);
  assert.deepEqual(runStalemates(detail, null), detail.repeatOffenders);
  const row = runChangeWorklist(detail, null)[0]!;
  assert.equal(row.roundsOpen, 2);
  assert.equal(row.state, "open");
});

test("the newest round's wording, rationale and confidence win", () => {
  const detail = detailOf([
    { round: 1, verdict: fail(change("attach the output", { path: "src/a.ts" })) },
    {
      round: 2,
      verdict: {
        ...fail(change("Attach the output.", {
          path: "src/a.ts",
          rationale: "The sharpened sentence.",
          evidence: [{ kind: "transcript", quote: "the newer citation" }],
        })) as Record<string, unknown>,
        confidence: 0.42,
      },
    },
  ]);
  const rows = runChangeWorklist(detail, null);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.title, "Attach the output.");
  assert.equal(rows[0]!.rationale, "The sharpened sentence.");
  assert.equal(rows[0]!.confidence, 0.42);
  assert.deepEqual(rows[0]!.evidence.map((ref) => ref.quote), ["the newer citation"]);
});

// ---- what "resolved" is allowed to mean --------------------------------------------------

test("a change its own reviewer stopped raising, and then passed, is resolved", () => {
  const detail = detailOf([
    { round: 1, verdict: fail(change("Attach the test output")) },
    { round: 2, verdict: fail(change("Attach the test output")) },
    { round: 3, verdict: PASS },
  ]);
  const row = runChangeWorklist(detail, null)[0]!;
  assert.equal(row.state, "resolved");
  assert.equal(row.lastRound, 2);
  assert.equal(row.resolvedRound, 3);
  assert.equal(row.roundsOpen, 2);
});

test("a resolved change names the round its reviewer passed in, not the round it was raised", () => {
  // The sentence Phase 2 puts on an Archive row is "Resolved in round N". `lastRound` is the
  // last round the change was still being ASKED FOR, so using it there would name a round the
  // change was open in - here, round 2, three rounds before anybody confirmed anything.
  const detail = detailOf([
    { round: 1, verdict: fail(change("Attach the test output")) },
    { round: 2, verdict: fail(change("Attach the test output")) },
    { round: 3, verdict: fail(change("Name the retry budget")) },
    { round: 4, verdict: fail(change("Name the retry budget")) },
    { round: 5, verdict: PASS },
  ]);
  const rows = runChangeWorklist(detail, null);
  const resolved = rowFor(rows, "Attach the test output");
  assert.equal(resolved.state, "resolved");
  assert.equal(resolved.lastRound, 2);
  assert.equal(resolved.resolvedRound, 5);
  assert.equal(rowFor(rows, "Name the retry budget").resolvedRound, 5);
});

test("an open or unconfirmed change has no resolving round to name", () => {
  const detail = detailOf([
    { round: 1, verdict: fail(change("Attach the test output")) },
    { round: 2, verdict: fail(change("Name the retry budget")) },
  ]);
  const rows = runChangeWorklist(detail, null);
  assert.equal(rowFor(rows, "Attach the test output").state, "unconfirmed");
  assert.equal(rowFor(rows, "Attach the test output").resolvedRound, null);
  assert.equal(rowFor(rows, "Name the retry budget").state, "open");
  assert.equal(rowFor(rows, "Name the retry budget").resolvedRound, null);
});

test("a reviewer that has not re-run leaves its change open, never resolved", () => {
  // Round 3 is in flight: Code Risk has posted a fail, Test Evidence has no attempt at all.
  const detail = detailOf([
    { round: 1, node: RISK, verdict: fail(change("Reduce the blast radius")) },
    { round: 1, node: EVIDENCE, verdict: fail(change("Attach the test output")) },
    { round: 2, node: RISK, verdict: fail(change("Reduce the blast radius")) },
    { round: 2, node: EVIDENCE, verdict: fail(change("Attach the test output")) },
    { round: 3, node: RISK, verdict: fail(change("Reduce the blast radius")) },
  ]);
  const rows = runChangeWorklist(detail, null);
  assert.equal(rowFor(rows, "Reduce the blast radius").state, "open");
  // The whole reason resolution is decided per owning node: another reviewer advancing the
  // round says nothing about this one's finding.
  assert.equal(rowFor(rows, "Attach the test output").state, "open");
});

test("a reviewer whose later attempt has not finished has not spoken yet", () => {
  const detail = detailOf([
    { round: 1, node: EVIDENCE, verdict: fail(change("Attach the test output")) },
    { round: 2, node: RISK, verdict: fail(change("Reduce the blast radius")) },
    { round: 2, node: EVIDENCE, state: "running", verdict: null },
  ]);
  assert.equal(rowFor(runChangeWorklist(detail, null), "Attach the test output").state, "open");
});

test("a change resolves only when its OWN reviewer passes", () => {
  const detail = detailOf([
    { round: 1, node: RISK, verdict: fail(change("Reduce the blast radius")) },
    { round: 1, node: EVIDENCE, verdict: fail(change("Attach the test output")) },
    { round: 2, node: RISK, verdict: fail(change("Reduce the blast radius")) },
    { round: 2, node: EVIDENCE, verdict: PASS },
  ]);
  const rows = runChangeWorklist(detail, null);
  assert.equal(rowFor(rows, "Attach the test output").state, "resolved");
  assert.equal(rowFor(rows, "Reduce the blast radius").state, "open");
});

test("a latest round with no attempts at all resolves nothing", () => {
  const detail = detailOf(
    [
      { round: 1, verdict: fail(change("Attach the test output")) },
      { round: 2, verdict: fail(change("Attach the test output")) },
    ],
    [3],
  );
  const rows = runChangeWorklist(detail, null);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.state, "open");
  // The just-opened round: both anchors bail out rather than reporting the previous round's
  // stalemate under segments describing round 3.
  assert.deepEqual(detail.repeatOffenders, []);
  assert.deepEqual(runStalemates(detail, null), []);
});

// ---- the third state ---------------------------------------------------------------------

test("a reworded finding is unconfirmed, not resolved", () => {
  const specs: AttemptSpec[] = [];
  for (let round = 1; round <= 5; round += 1) {
    specs.push({ round, verdict: fail(change("Attach the test output")) });
  }
  for (let round = 6; round <= 10; round += 1) {
    specs.push({ round, verdict: fail(change("Attach completed test output")) });
  }
  const detail = detailOf(specs);
  const rows = runChangeWorklist(detail, null);
  const dropped = rowFor(rows, "Attach the test output");
  assert.equal(dropped.state, "unconfirmed");
  assert.equal(dropped.lastRound, 5);
  assert.equal(dropped.roundsOpen, 5);
  assert.equal(rowFor(rows, "Attach completed test output").state, "open");
});

test("a repeat offender never has a change filed as resolved", () => {
  // The on-screen contradiction this state exists to prevent: an Archive row reading
  // "Resolved in round 5" directly above a card reading "failed 10 rounds running", about one
  // reviewer. Pinned against a fixture that really does produce a repeat-offender entry.
  const specs: AttemptSpec[] = [];
  for (let round = 1; round <= 5; round += 1) {
    specs.push({ round, verdict: fail(change("Attach the test output")) });
  }
  for (let round = 6; round <= 10; round += 1) {
    specs.push({ round, verdict: fail(change("Attach completed test output")) });
  }
  const detail = detailOf(specs);
  const offenders = new Set((detail.repeatOffenders ?? []).map((entry) => entry.nodeId));
  assert.equal(offenders.has(RISK), true);
  for (const row of runChangeWorklist(detail, null)) {
    if (offenders.has(row.nodeId)) assert.notEqual(row.state, "resolved");
  }
});

test("fixing one thing while raising another leaves the first unconfirmed, not resolved", () => {
  // Nothing here proves the first change was fixed, and nothing proves it was reworded into
  // the second either. `unconfirmed` says only what is known: the reviewer never passed.
  const detail = detailOf([
    { round: 1, verdict: fail(change("Attach the test output")) },
    { round: 2, verdict: fail(change("Attach the test output")) },
    { round: 3, verdict: fail(change("Name the retry budget")) },
  ]);
  const rows = runChangeWorklist(detail, null);
  assert.equal(rowFor(rows, "Attach the test output").state, "unconfirmed");
  assert.equal(rowFor(rows, "Name the retry budget").state, "open");
});

test("a change stops being raised, but its reviewer never re-ran: open, not unconfirmed", () => {
  const detail = detailOf([
    { round: 1, node: EVIDENCE, verdict: fail(change("Attach the test output")) },
    { round: 2, node: EVIDENCE, verdict: fail(change("Attach the test output")) },
    { round: 3, node: RISK, verdict: fail(change("Reduce the blast radius")) },
  ]);
  const row = rowFor(runChangeWorklist(detail, null), "Attach the test output");
  assert.notEqual(row.state, "unconfirmed");
  assert.equal(row.state, "open");
});

// ---- two reviewers, one sentence ---------------------------------------------------------

test("two reviewers asking for the same thing are two rows, both actionable", () => {
  const detail = detailOf([
    {
      round: 1,
      node: RISK,
      verdict: fail(change("Attach the test output", {
        path: "src/a.ts",
        rationale: "Risk needs the proof.",
        evidence: [{ kind: "diff", quote: "the risky hunk" }],
      })),
    },
    {
      round: 1,
      node: EVIDENCE,
      verdict: fail(change("attach the test output.", {
        path: "src/a.ts",
        rationale: "Evidence needs the proof.",
        evidence: [{ kind: "transcript", quote: "the missing run" }],
      })),
    },
  ]);
  const rows = runChangeWorklist(detail, null);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.nodeId).sort(), [EVIDENCE, RISK]);
  assert.deepEqual(
    rows.map((row) => row.personaName).sort(),
    ["Code Risk Reviewer", "Test Evidence Auditor"],
  );
  assert.deepEqual(
    rows.map((row) => row.rationale).sort(),
    ["Evidence needs the proof.", "Risk needs the proof."],
  );
  assert.deepEqual(
    rows.flatMap((row) => row.evidence.map((ref) => ref.quote)).sort(),
    ["the missing run", "the risky hunk"],
  );
});

test("one reviewer resolving a colliding change leaves the other's row open", () => {
  const detail = detailOf([
    { round: 1, node: RISK, verdict: fail(change("Attach the test output", { path: "src/a.ts" })) },
    {
      round: 1,
      node: EVIDENCE,
      verdict: fail(change("Attach the test output", { path: "src/a.ts" })),
    },
    { round: 2, node: RISK, verdict: PASS },
    {
      round: 2,
      node: EVIDENCE,
      verdict: fail(change("Attach the test output", { path: "src/a.ts" })),
    },
  ]);
  const rows = runChangeWorklist(detail, null);
  assert.equal(rows.length, 2);
  assert.equal(rows.find((row) => row.nodeId === RISK)?.state, "resolved");
  assert.equal(rows.find((row) => row.nodeId === EVIDENCE)?.state, "open");
});

// ---- what is not a row -------------------------------------------------------------------

test("a failing Check is not a change row - the reader keeps its own outcome path", () => {
  const detail = detailOf([
    { round: 1, verdict: fail(change("Attach the test output")) },
    {
      round: 1,
      node: "lint",
      persona: null,
      verdict: fail(change("Fix the failing lint check", {
        evidence: [{ kind: "check", quote: "1 error" }],
      })),
    },
  ]);
  const rows = runChangeWorklist(detail, null);
  assert.deepEqual(rows.map((row) => row.nodeId), [RISK]);
});

test("an unreadable verdict is skipped rather than thrown", () => {
  const detail = detailOf([
    { round: 1, verdict: fail(change("Attach the test output")) },
    { round: 2, verdict: { verdict: "fail" } },
  ]);
  const rows = runChangeWorklist(detail, null);
  assert.equal(rows.length, 1);
  // A row nobody can parse says nothing about the finding, so it cannot resolve it either.
  assert.equal(rows[0]!.state, "open");
  assert.deepEqual(runStalemates(detail, null), detail.repeatOffenders);
});

test("an empty run is an empty worklist", () => {
  const empty = detailOf([]);
  assert.deepEqual(runChangeWorklist(empty, null), []);
  assert.deepEqual(runStalemates(empty, null), []);
});

// ---- the window --------------------------------------------------------------------------

test("the same run answers honestly for two different rounds", () => {
  const specs: AttemptSpec[] = [];
  for (let round = 1; round <= 4; round += 1) {
    specs.push({ round, verdict: fail(change("Attach the test output")) });
  }
  specs.push({ round: 5, verdict: PASS });
  const detail = detailOf(specs);

  const atFour = runChangeWorklist(detail, 4)[0]!;
  assert.equal(atFour.state, "open");
  assert.equal(atFour.roundsOpen, 4);
  assert.equal(atFour.lastRound, 4);

  for (const asOf of [5, null]) {
    const later = runChangeWorklist(detail, asOf)[0]!;
    assert.equal(later.state, "resolved", `as of ${asOf}`);
    assert.equal(later.roundsOpen, 4);
  }
});

test("a round above the run behaves like the default, not like an empty run", () => {
  const detail = detailOf([
    { round: 1, verdict: fail(change("Attach the test output")) },
    { round: 2, verdict: fail(change("Attach the test output")) },
  ]);
  assert.deepEqual(runChangeWorklist(detail, 99), runChangeWorklist(detail, null));
  assert.deepEqual(runStalemates(detail, 99), runStalemates(detail, null));
  assert.equal(runChangeWorklist(detail, 99).length, 1);
});

test("a round before anything was raised is empty rather than a crash", () => {
  const detail = detailOf([
    { round: 1, verdict: fail(change("Attach the test output")) },
    { round: 2, verdict: fail(change("Attach the test output")) },
  ]);
  assert.deepEqual(runChangeWorklist(detail, 0), []);
  assert.deepEqual(runStalemates(detail, 0), []);
});

// ---- stalemates --------------------------------------------------------------------------

function tenRoundRun(): WorkflowRunDetail {
  const specs: AttemptSpec[] = [];
  for (let round = 1; round <= 10; round += 1) {
    specs.push({ round, node: RISK, verdict: fail(change("Reduce the blast radius")) });
    specs.push({
      round,
      node: EVIDENCE,
      verdict: round <= 3 ? PASS : fail(change("Attach the test output")),
    });
  }
  return detailOf(specs);
}

test("at the default window the browser twin equals the server derivation", () => {
  const detail = tenRoundRun();
  assert.deepEqual(runStalemates(detail, null), detail.repeatOffenders);
  assert.deepEqual(detail.repeatOffenders, [
    { nodeId: EVIDENCE, personaName: "Test Evidence Auditor", rounds: 7 },
    { nodeId: RISK, personaName: "Code Risk Reviewer", rounds: 10 },
  ]);
});

test("a windowed stalemate counts only the rounds inside the window", () => {
  const detail = tenRoundRun();
  // Test Evidence passed round 3, so at round 4 its streak is one round long - not a
  // stalemate yet, however loudly the latest-anchored payload field says seven.
  assert.deepEqual(runStalemates(detail, 4), [
    { nodeId: RISK, personaName: "Code Risk Reviewer", rounds: 4 },
  ]);
  assert.deepEqual(runStalemates(detail, 5), [
    { nodeId: EVIDENCE, personaName: "Test Evidence Auditor", rounds: 2 },
    { nodeId: RISK, personaName: "Code Risk Reviewer", rounds: 5 },
  ]);
});

test("a member passing the round before the horizon is not in a stalemate", () => {
  const detail = detailOf([
    { round: 1, verdict: fail(change("Reduce the blast radius")) },
    { round: 2, verdict: PASS },
    { round: 3, verdict: fail(change("Reduce the blast radius")) },
  ]);
  assert.deepEqual(runStalemates(detail, null), []);
  assert.deepEqual(runStalemates(detail, null), detail.repeatOffenders);
});

// ---- order -------------------------------------------------------------------------------

test("rows arrive sorted by how much the reader still has to care", () => {
  const detail = detailOf([
    { round: 1, node: RISK, verdict: fail(change("Old risk finding")) },
    { round: 1, node: EVIDENCE, verdict: fail(change("Old evidence finding")) },
    { round: 2, node: RISK, verdict: fail(change("Newer risk finding")) },
    { round: 2, node: EVIDENCE, verdict: PASS },
    { round: 3, node: RISK, verdict: fail(change("Newer risk finding")) },
  ]);
  assert.deepEqual(
    runChangeWorklist(detail, null).map((row) => [row.title, row.state, row.firstRound]),
    [
      ["Newer risk finding", "open", 2],
      ["Old risk finding", "unconfirmed", 1],
      ["Old evidence finding", "resolved", 1],
    ],
  );
});
