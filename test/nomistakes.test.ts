import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAxiStatus, resetRunClock, summarize, timeRun, ulidTime } from "../src/server/nomistakes.ts";
import { duration } from "../src/web/lib/format.ts";
import type { NmRunSummary } from "@shared/types.ts";

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

// ---- run duration ----

// The card's live duration hangs off the id alone: `axi status` prints no
// timestamps, so if the ULID stops dating the run, every strip silently loses its
// timer. Pinned against a real run id captured from the binary.
test("a run's start time comes out of its own ULID id", () => {
  assert.equal(ulidTime("01KXJS1PRAXW5F2W4G48YJCVTT"), 1784115419914);
  assert.equal(new Date(ulidTime("01KW1AW3NR19DV8EXM8DNPASGK")!).toISOString(), "2026-06-26T06:46:29.304Z");
  // Anything that isn't a ULID leaves the card undated rather than misdated:
  // 26 chars but with Crockford's excluded letters (I/L/O/U), and wrong lengths.
  assert.equal(ulidTime("01KW1AW3NR19DV8EXM8DNPASGI"), null);
  assert.equal(ulidTime("run-42"), null);
  assert.equal(ulidTime(""), null);
});

test("the run's start survives the whole status -> card path", () => {
  const run = summarize(parseAxiStatus(REVIEW_GATE));
  assert.equal(run?.startedAt, 1782456389304);
  assert.equal(run?.endedAt, null); // summarize is pure; the poller's clock stamps the end
});

function run(over: Partial<NmRunSummary> = {}): NmRunSummary {
  return {
    id: "01KXJS1PRAXW5F2W4G48YJCVTT",
    status: "running",
    branch: "feature/x",
    startedAt: 1784115419914,
    endedAt: null,
    awaitingAgent: null,
    findingsSummary: null,
    gateStep: null,
    gateSummary: null,
    gateRisk: null,
    steps: [],
    findings: [],
    outcome: null,
    ...over,
  };
}

test("a run that finishes under watch is stamped at the poll that saw it stop", () => {
  resetRunClock();
  assert.equal(timeRun(run(), 1000).endedAt, null); // still going
  const done = timeRun(run({ status: "completed", outcome: "passed" }), 5000);
  assert.equal(done.endedAt, 5000);
  // Idempotent: every worktree on the branch reports the run each poll, and the
  // duration must not creep upward for the rest of the daemon's life.
  assert.equal(timeRun(run({ status: "completed", outcome: "passed" }), 9000).endedAt, 5000);
  assert.equal(timeRun(run({ status: "completed", outcome: "passed" }), 60_000).endedAt, 5000);
});

// `axi status` keeps reporting the last run forever, so a restarted daemon meets
// runs that ended long ago. Stamping one on sight would date it to the restart and
// show a 4-minute run as having taken hours - a wrong duration reads as truth.
test("a run already over when we first see it is never stamped", () => {
  resetRunClock();
  const seen = timeRun(run({ status: "completed", outcome: "passed" }), 5000);
  assert.equal(seen.endedAt, null);
  assert.equal(timeRun(run({ status: "completed", outcome: "passed" }), 60_000).endedAt, null);
});

test("a parked run is still running: its clock keeps going", () => {
  resetRunClock();
  const parked = timeRun(run({ awaitingAgent: "parked 1m30s", gateStep: "review" }), 5000);
  assert.equal(parked.endedAt, null);
});

test("elapsed time reads in two units and holds its width as it ticks", () => {
  assert.equal(duration(0), "0s");
  assert.equal(duration(42_000), "42s");
  assert.equal(duration(187_000), "3m 07s");
  assert.equal(duration(3_600_000), "1h 00m");
  assert.equal(duration(7_740_000), "2h 09m");
  assert.equal(duration(90_000_000), "1d 01h");
  assert.equal(duration(-5000), "0s"); // a clock skewed backwards must not print "-1s"
});
