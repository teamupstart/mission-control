import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { gateSelectionKey, NomistakesStrip } from "../src/web/components/NomistakesStrip.tsx";
import type { NmActiveStep, NmRunSummary } from "@shared/types.ts";

// What the strip SAYS about the step it's on, rendered.
//
// The complaint these pin: a run pushed, opened a PR, went green on CI - and the
// last dot stayed blue for hours. Nothing was broken. `ci` watches an open PR until
// it merges or closes, so "running" was true; the strip just had no way to say so,
// and a blue dot with a ticking clock reads as work in flight. The fix is words, not
// a new colour: the step already explains itself, and the card threw that away.
//
// So the failure mode that matters here is the strip inventing a verdict of its own
// rather than quoting no-mistakes. It renders what the run says, and nothing else.
//
// Rendered rather than driven through a browser: the dashboard's SSE stream holds
// the connection open, which hangs headless automation. Static markup is enough for
// a question about words.

const WATCHING = "quiet 1h17m ago: log: all CI checks passed - still monitoring until merged or closed";

function active(over: Partial<NmActiveStep> = {}): NmActiveStep {
  return { step: "ci", status: "running", activeFor: "2h26m", lastActivity: WATCHING, ...over };
}

/** A run that pushed, opened its PR, and is now sitting on `ci`. */
function run(over: Partial<NmRunSummary> = {}): NmRunSummary {
  return {
    id: "01KXNAB6G2H92SN09FBYX1Z13A",
    status: "running",
    branch: "mancej/custom-skills",
    startedAt: 1784200665602,
    endedAt: null,
    prUrl: null,
    awaitingAgent: null,
    findingsSummary: null,
    gateStep: null,
    gateSummary: null,
    gateRisk: null,
    steps: [
      { step: "push", status: "completed", findings: 0 },
      { step: "pr", status: "completed", findings: 0 },
      { step: "ci", status: "running", findings: 0 },
    ],
    activeSteps: [active()],
    findings: [],
    outcome: null,
    ...over,
  };
}

function render(nm: NmRunSummary, needsYou = false): string {
  return renderToStaticMarkup(
    createElement(NomistakesStrip, { sessionId: "s1", nm, needsYou }),
  );
}

test("the strip says why a pushed, green, PR-opened run is still on ci", () => {
  // The entire complaint, answered in one line the card already had access to.
  assert.match(render(run()), /all CI checks passed - still monitoring until merged or closed/);
});

// A monitor idling between polls is not a broken one: `ci` sits quiet for hours and
// then completes the moment the PR merges. The strip must not upgrade "quiet" into a
// verdict - it has no way to know, and no-mistakes never said it.
test("a quiet step is quoted, never diagnosed", () => {
  const html = render(run());
  assert.doesNotMatch(html, /stalled|stuck|dead|orphan/i);
  assert.match(html, /nm-dot nm-run/); // still running, because it is
});

test("a step with no active_steps entry keeps its old rendering", () => {
  // An older no-mistakes prints no such block: lose the explanation, not the dots.
  const html = render(run({ activeSteps: [] }));
  assert.doesNotMatch(html, /nm-lastact/);
  assert.match(html, /nm-dot nm-run/);
});

test("only the running step's activity is shown", () => {
  // A leftover entry for a finished step must not narrate the wrong dot.
  const html = render(run({ activeSteps: [active({ step: "push", lastActivity: "log: pushed" })] }));
  assert.doesNotMatch(html, /nm-lastact/);
});

test("the full log line is in the title, since the line itself is clipped to one row", () => {
  assert.match(render(run()), /title="ci · active 2h26m · quiet 1h17m ago/);
});

test("a dashboard fix names the submitted round while the terminal can still show the prior question", () => {
  const html = render(
    run({
      awaitingAgent: "parked 10s",
      gateStep: "review",
      findings: [
        { id: "follow-up", severity: "warning", file: "db.ts", action: "auto-fix", description: "later" },
      ],
      response: {
        responseId: 1,
        runId: "01KXNAB6G2H92SN09FBYX1Z13A",
        step: "review",
        action: "fix",
        findingIds: ["codex-unsupported-max-effort", "agent-switch-retains-overrides"],
        status: "submitting",
        error: null,
      },
    }),
    true,
  );
  assert.match(html, /Fix submitted/);
  assert.match(html, /codex-unsupported-max-effort, agent-switch-retains-overrides/);
  assert.match(html, /terminal can still show the earlier question/);
  assert.doesNotMatch(html, />Fix</, "the same-looking action must not remain clickable in flight");
});

test("a follow-up gate distinguishes its findings from the earlier terminal question", () => {
  const html = render(
    run({
      awaitingAgent: "parked 10s",
      gateStep: "review",
      findings: [
        { id: "later-auto-fix", severity: "warning", file: "db.ts", action: "auto-fix", description: "later" },
      ],
      response: {
        responseId: 1,
        runId: "01KXNAB6G2H92SN09FBYX1Z13A",
        step: "review",
        action: "fix",
        findingIds: ["codex-unsupported-max-effort", "agent-switch-retains-overrides"],
        status: "submitted",
        error: null,
      },
    }),
    true,
  );
  assert.match(html, /Previous fix submitted/);
  assert.match(html, /codex-unsupported-max-effort, agent-switch-retains-overrides/);
  assert.match(html, /findings above are a newer review round/);
  assert.match(html, />Fix</, "the newer round remains independently actionable");
});

test("a response from an earlier step is not described as a newer review round", () => {
  const html = render(
    run({
      awaitingAgent: "parked 10s",
      gateStep: "test",
      findings: [
        { id: "test-failure", severity: "error", file: "test/a.test.ts", action: "auto-fix", description: "later" },
      ],
      response: {
        responseId: 1,
        runId: "01KXNAB6G2H92SN09FBYX1Z13A",
        step: "review",
        action: "fix",
        findingIds: ["review-finding"],
        status: "submitted",
        error: null,
      },
    }),
    true,
  );
  assert.doesNotMatch(
    html,
    /newer review round/,
    "a later pipeline step is not another round of the review gate",
  );
});

test("an asynchronous gate response failure is visible and retryable", () => {
  const html = render(
    run({
      awaitingAgent: "parked 10s",
      gateStep: "review",
      findings: [
        { id: "f1", severity: "error", file: "a.ts", action: "ask-user", description: "why" },
      ],
      response: {
        responseId: 1,
        runId: "01KXNAB6G2H92SN09FBYX1Z13A",
        step: "review",
        action: "fix",
        findingIds: ["f1"],
        status: "failed",
        error: "the gate already moved",
      },
    }),
    true,
  );
  assert.match(html, /last response was not delivered: the gate already moved/i);
  assert.match(html, />Fix</, "the operator can retry after seeing the failure");
});

test("a repeated gate with the same finding ids gets a fresh selection identity", () => {
  const finding = {
    id: "same-finding",
    severity: "warning",
    file: "a.ts",
    action: "ask-user",
    description: "still applies",
  };
  const first = run({ gateStep: "review", findings: [finding] });
  const repeated = run({
    gateStep: "review",
    findings: [finding],
    response: {
      responseId: 7,
      runId: first.id,
      step: "review",
      action: "fix",
      findingIds: [finding.id],
      status: "submitted",
      error: null,
    },
  });

  assert.notEqual(gateSelectionKey(first), gateSelectionKey(repeated));
});
