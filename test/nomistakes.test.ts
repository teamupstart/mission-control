import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAxiStatus, summarize } from "../src/server/nomistakes.ts";

// Fixtures are verbatim `no-mistakes axi status` output captured from the real
// binary / the project's recorded evidence.

const REVIEW_GATE = `run:
  id: "01KW1AW3NR19DV8EXM8DNPASGK"
  branch: feature/park-evidence
  status: running
  awaiting_agent: parked 0s
  head: ea863f88
  findings: 1 awaiting
  steps[9]{step,status,findings,duration_ms}:
    intent,completed,0,0
    rebase,completed,0,87
    review,awaiting_approval,1,316
    test,pending,0,0
    document,pending,0,0
    lint,pending,0,0
    push,pending,0,0
    pr,pending,0,0
    ci,pending,0,0
gate:
  step: review
  status: awaiting_approval
  summary: found 1 issue
  risk: medium
  findings[1]{id,severity,file,action,description}:
    axi-1,warning,feature.txt,ask-user,potential nil deref
help[4]: Run \`no-mistakes axi respond --action approve\` to accept this step and continue,Run \`no-mistakes axi respond --action skip\` to skip this step`;

const COMPLETED = `run:
  id: "01KW1AW3NR19DV8EXM8DNPASGK"
  branch: feature/park-evidence
  status: completed
  head: ea863f88
  findings: 1 awaiting
  steps[9]{step,status,findings,duration_ms}:
    intent,completed,0,0
    rebase,completed,0,87
    review,completed,1,316
    test,completed,0,18
    document,completed,0,23
    lint,completed,0,17
    push,completed,0,71
    pr,skipped,0,0
    ci,skipped,0,0
outcome: passed`;

const ERROR = `error: repo not initialized (run 'no-mistakes init' first)
help[1]: Run \`no-mistakes init\` to set up the gate in this repository`;

test("parses a run parked at the review gate", () => {
  const run = parseAxiStatus(REVIEW_GATE);
  assert.ok(run);
  assert.equal(run.id, "01KW1AW3NR19DV8EXM8DNPASGK");
  assert.equal(run.status, "running");
  assert.equal(run.branch, "feature/park-evidence");
  assert.equal(run.awaitingAgent, "parked 0s");
  assert.equal(run.findingsSummary, "1 awaiting");
  assert.equal(run.steps.length, 9);
  assert.deepEqual(run.steps[2], { step: "review", status: "awaiting_approval", findings: 1 });
  assert.ok(run.gate);
  assert.equal(run.gate.step, "review");
  assert.equal(run.gate.risk, "medium");
  assert.equal(run.gate.findings.length, 1);
  assert.deepEqual(run.gate.findings[0], {
    id: "axi-1",
    severity: "warning",
    file: "feature.txt",
    action: "ask-user",
    description: "potential nil deref",
  });
});

test("parses a completed run with an outcome", () => {
  const run = parseAxiStatus(COMPLETED);
  assert.ok(run);
  assert.equal(run.id, "01KW1AW3NR19DV8EXM8DNPASGK");
  assert.equal(run.status, "completed");
  assert.equal(run.outcome, "passed");
  assert.equal(run.gate, null);
  assert.equal(run.steps.filter((s) => s.status === "completed").length, 7);
  assert.equal(run.steps.filter((s) => s.status === "skipped").length, 2);
});

// The id is what a reset keys a dismissal on, so it has to survive all the way to
// the card - summarize() dropping it would silently resurrect retired strips.
test("the run id survives the whole status -> card path", () => {
  for (const out of [REVIEW_GATE, COMPLETED]) {
    assert.equal(summarize(parseAxiStatus(out))?.id, "01KW1AW3NR19DV8EXM8DNPASGK");
  }
  assert.equal(summarize(parseAxiStatus(ERROR)), null);
});

test("returns null for the error / not-initialized case", () => {
  assert.equal(parseAxiStatus(ERROR), null);
  assert.equal(parseAxiStatus("error: not in a git repository"), null);
  assert.equal(parseAxiStatus(""), null);
});
