import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NomistakesStrip } from "../src/web/components/NomistakesStrip.tsx";
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

function render(nm: NmRunSummary): string {
  return renderToStaticMarkup(
    createElement(NomistakesStrip, { sessionId: "s1", nm, needsYou: false }),
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
