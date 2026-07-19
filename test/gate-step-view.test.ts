import { test } from "node:test";
import assert from "node:assert/strict";
import { gateStepView } from "../src/web/lib/format.ts";
import type { NmRunSummary, NmStep } from "../src/shared/types.ts";

// gateStepView is the rule behind the board tile's labeled gate line: given a run, which
// single step should the tile name, and in what tone. It's pure, so it's tested here without
// a DOM - the tile just renders whatever this returns.

function step(name: string, status: string, findings = 0): NmStep {
  return { step: name, status, findings };
}

function nm(over: Partial<NmRunSummary> = {}): NmRunSummary {
  return {
    id: "run1",
    status: "running",
    branch: "b",
    startedAt: 0,
    endedAt: null,
    awaitingAgent: null,
    findingsSummary: null,
    gateStep: null,
    gateSummary: null,
    gateRisk: null,
    steps: [],
    activeSteps: [],
    findings: [],
    outcome: null,
    ...over,
  };
}

const PIPE = ["review", "test", "lint", "document", "push", "ci"];
const build = (statuses: Record<string, string>): NmStep[] =>
  PIPE.map((s) => step(s, statuses[s] ?? "pending"));

test("names the running step, in working tone, with its 1-based position", () => {
  const v = gateStepView(nm({ steps: build({ review: "completed", test: "running" }) }));
  assert.equal(v.label, "test");
  assert.equal(v.tone, "working");
  assert.equal(v.pos, 2);
  assert.equal(v.total, 6);
  assert.equal(v.done, false);
});

test("a parked gate wins over anything running, in attention tone", () => {
  // gateStep is no-mistakes' own word for where it's parked; trust it over status scanning.
  const v = gateStepView(
    nm({ gateStep: "review", steps: build({ review: "awaiting_approval", test: "running" }) }),
  );
  assert.equal(v.label, "review");
  assert.equal(v.tone, "attention");
  assert.equal(v.pos, 1);
});

test("falls back to the parked status when gateStep is absent", () => {
  const v = gateStepView(nm({ steps: build({ review: "completed", test: "fix_review" }) }));
  assert.equal(v.label, "test");
  assert.equal(v.tone, "attention");
});

test("a failed step is the headline, in danger tone", () => {
  const v = gateStepView(
    nm({ status: "failed", steps: build({ review: "completed", test: "failed" }) }),
  );
  assert.equal(v.label, "test");
  assert.equal(v.tone, "danger");
  assert.equal(v.pos, 2);
});

test("a landed run names its outcome in idle tone, with no step position", () => {
  const v = gateStepView(
    nm({
      status: "completed",
      outcome: "passed",
      steps: build({ review: "completed", test: "completed", lint: "completed", document: "completed", push: "completed", ci: "completed" }),
    }),
  );
  assert.equal(v.label, "passed");
  assert.equal(v.tone, "idle");
  assert.equal(v.done, true);
  assert.equal(v.pos, 6); // pos is present but the tile hides it while done
});

test("gateStep naming no step we hold still falls back to the parked status", () => {
  // gateStep and steps[] are parsed from separate blocks, so they can disagree. A name
  // that doesn't place must not drop the run to working tone and lose the attention signal.
  const v = gateStepView(
    nm({ gateStep: "deploy", steps: build({ review: "completed", test: "awaiting_approval" }) }),
  );
  assert.equal(v.label, "test");
  assert.equal(v.tone, "attention");
  assert.equal(v.pos, 2);
});

test("a run that landed failed or cancelled keeps the danger tone", () => {
  for (const outcome of ["failed", "cancelled", "canceled"]) {
    const v = gateStepView(nm({ status: "completed", outcome, steps: build({}) }));
    assert.equal(v.label, outcome);
    assert.equal(v.tone, "danger", `${outcome} should not read as a clean landing`);
    assert.equal(v.done, true);
  }
});

test("checks-passed is a clean landing, in idle tone", () => {
  const v = gateStepView(nm({ status: "completed", outcome: "checks-passed", steps: build({}) }));
  assert.equal(v.tone, "idle");
  assert.equal(v.done, true);
});

test("a skip out of order doesn't move the frontier past a pending step", () => {
  // `--step <name> --action skip` can settle a later step while an earlier one still owes
  // work, so the settled steps are not always a prefix.
  const v = gateStepView(nm({ steps: build({ review: "completed", lint: "skipped" }) }));
  assert.equal(v.label, "test");
  assert.equal(v.pos, 2);
  assert.equal(v.tone, "working");
});

test("between steps, names the next unsettled step (skipped counts as settled)", () => {
  const v = gateStepView(nm({ steps: build({ review: "completed", test: "skipped" }) }));
  assert.equal(v.label, "lint");
  assert.equal(v.pos, 3);
  assert.equal(v.tone, "working");
});

test("an empty pipeline can't be placed - pos is null, and it never throws", () => {
  const v = gateStepView(nm({ steps: [] }));
  assert.equal(v.pos, null);
  assert.equal(v.total, 0);
  assert.equal(v.done, false);
});

test("a run with no steps and no status still names something", () => {
  // The parser initialises `status` to "" and only fills it from a `status:` line, so a
  // run summary that carries neither leaves the label empty - and since the tile head
  // drops its own diamond whenever a run exists, the row would be a lone ◇ and no word.
  const v = gateStepView(nm({ status: "", steps: [] }));
  assert.notEqual(v.label, "");
  assert.equal(v.tone, "working");
  assert.equal(v.pos, null);
});
