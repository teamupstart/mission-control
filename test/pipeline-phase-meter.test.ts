import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { PipelineRun, PipelineStep, SessionPipelineLink } from "../src/shared/pipeline.ts";
import {
  pipelineEyebrow,
  pipelinePhaseMeter,
  pipelinePhaseStatus,
  pipelineSequentialSteps,
  pipelineStrip,
} from "../src/web/pipelines/pipeline-run-model.ts";
import { PipelinePhaseMeter } from "../src/web/pipelines/PipelinePhaseMeter.tsx";
import { Tooltip } from "../src/web/components/Tooltip.tsx";

/**
 * The board card's phase meter, from the fold up.
 *
 * WHAT IS AT STAKE. A correlated card said one word about a 22-step feature, and the meter is
 * what makes "how far, what failed, what got skipped" readable from the board. Every claim it
 * makes is arithmetic over a projection this repository does not own: ai-conductor builds its
 * effective step list per repository, and its own config disables one step and inserts two
 * custom SHIP ones. So the cases below are mostly about TOLERANCE - a run whose steps this
 * build cannot place, a run that dispatched something out of band - and about the one rule
 * that ties them together: **anything the meter counts must be readable somewhere on it.**
 *
 * The fold is exercised directly rather than through the markup wherever it can be, because a
 * claim that can only be checked by rendering is one nobody checks the edges of. The markup
 * assertions below are the ones only a rendering can make: which class carries which tone,
 * that the segment widths come from the run, and that nothing draws when there is no run.
 */

const REPO = "/repo";

function run(over: Partial<PipelineRun> = {}): PipelineRun {
  return {
    provider: "ai-conductor",
    repoRoot: REPO,
    slug: "add-widgets",
    worktree: `${REPO}/.worktrees/add-widgets`,
    tier: "M",
    track: "product",
    steps: [],
    lastStep: null,
    halt: null,
    group: "building",
    prUrl: null,
    costTokens: null,
    updatedAt: 0,
    ...over,
  };
}

/** `{ name: state }` in the engine's own order, as the projection reports it. */
function steps(table: Record<string, PipelineStep["state"]>): PipelineStep[] {
  return Object.entries(table).map(([name, state]) => ({ name, state }));
}

const link: SessionPipelineLink = {
  provider: "ai-conductor",
  repoRoot: REPO,
  slug: "add-widgets",
  step: null,
};

function render(r: PipelineRun): string {
  return renderToStaticMarkup(createElement(PipelinePhaseMeter, { run: r, link }));
}

/** A run mid-DECIDE: two phases finished, one running, two untouched. */
const MID_DECIDE = run({
  steps: steps({
    worktree: "done",
    memory: "done",
    explore: "done",
    complexity: "done",
    prd: "done",
    architecture_diagram: "done",
    architecture_review: "done",
    stories: "in_progress",
    conflict_check: "pending",
    plan: "pending",
    build: "pending",
    test_suite: "pending",
    finish: "pending",
  }),
  lastStep: "stories",
});

/** A halted run: BUILD's review refused, and the engine stopped for a person. */
const HALTED = run({
  steps: steps({
    worktree: "done",
    memory: "done",
    explore: "done",
    plan: "done",
    acceptance_specs: "done",
    build: "done",
    wiring_check: "skipped",
    test_suite: "done",
    build_review: "failed",
    finish: "pending",
  }),
  lastStep: "build_review",
  halt: { class: "needs-human", reason: "Scope widened past the approved plan" },
  group: "halted",
});

// ---- the fold ---------------------------------------------------------------------------

test("the meter is five segments in phase order, sized by the run's own steps", () => {
  const view = pipelinePhaseMeter(MID_DECIDE)!;
  assert.deepEqual(
    view.segments.map((segment) => segment.phase),
    ["SETUP", "UNDERSTAND", "DECIDE", "BUILD", "SHIP"],
  );
  // The width driver, and the whole reason a hardcoded 1/1/9/5/6 split is a bug: these
  // totals are what THIS run's state file mentioned, which on a repository with custom
  // steps is a different shape entirely.
  assert.deepEqual(
    view.segments.map((segment) => segment.total),
    [1, 1, 8, 2, 1],
  );
  assert.deepEqual(
    view.segments.map((segment) => segment.finished),
    [1, 1, 5, 0, 0],
  );
});

test("the segment tones are the phase fold's, not a second map of this component's", () => {
  // The test that stops a private tone table appearing here later. Asserted by equality
  // against `pipelinePhaseStatus` over the same rows rather than against literals, so it
  // keeps holding when that precedence changes.
  for (const r of [MID_DECIDE, HALTED]) {
    const view = pipelinePhaseMeter(r)!;
    const strip = pipelineStrip(r.provider, r.steps, []);
    for (const [index, segment] of view.segments.entries()) {
      const expected = pipelinePhaseStatus(strip.phases[index]!.steps);
      assert.deepEqual(
        segment.status,
        expected ?? { tone: "stopped", label: "Not started" },
        `${segment.phase} was toned by something other than pipelinePhaseStatus`,
      );
    }
  }
});

test("the caption names the phase the run is in, and counts the run's own steps", () => {
  const view = pipelinePhaseMeter(MID_DECIDE)!;
  assert.equal(view.caption, "DECIDE");
  assert.equal(view.captionTone, "running");
  // 13 sequential steps, 7 of them finished. `N` agrees with the eyebrow's own denominator,
  // which is the point of them sharing `pipelineSequentialSteps`.
  assert.equal(view.total, 13);
  assert.equal(view.done, 7);
  assert.match(pipelineEyebrow(MID_DECIDE), /step 8 of 13$/);
});

test("a failing phase carries the halt's own sentence, and the caption turns with it", () => {
  const view = pipelinePhaseMeter(HALTED)!;
  assert.equal(view.caption, "BUILD");
  assert.equal(view.captionTone, "failed");
  const build = view.segments.find((segment) => segment.phase === "BUILD")!;
  assert.equal(build.status.tone, "failed");
  assert.equal(build.current, true);
  assert.equal(build.footer, "Needs a human - Scope widened past the approved plan");
  // Only the phase that failed. A halt sentence repeated under five popovers would say the
  // whole run failed, which is not what a halt is.
  assert.deepEqual(
    view.segments.filter((segment) => segment.footer !== null).map((segment) => segment.phase),
    ["BUILD"],
  );
});

/**
 * The case that made the halt sentence conditional on a coincidence.
 *
 * `pipelinePhaseStatus` is a function of step STATES and knows nothing about `run.halt`, so a
 * run that halted DURING a step - the halting step still `in_progress` - has no phase whose
 * tone resolves to `failed`. This is not a hypothetical shape the type system merely permits:
 * `classifyGroup` in `src/server/pipelines/conductor/normalize.ts` names it as the reason
 * `halted` outranks `building` - "a run with a HALT marker AND an in-progress step halted
 * DURING that step; drawing it as `building` would say work is happening that stopped."
 *
 * The meter's first cut said exactly that: no failed phase meant no halt sentence anywhere and
 * a blue running segment on the phase the run had stopped in.
 */
const HALTED_MID_STEP = run({
  steps: steps({
    worktree: "done",
    memory: "done",
    explore: "done",
    plan: "done",
    acceptance_specs: "done",
    build: "in_progress",
    test_suite: "pending",
    finish: "pending",
  }),
  lastStep: "build",
  halt: { class: "needs-human", reason: "the scope widened past the approved plan" },
  group: "halted",
});

test("a run that halted mid-step still states the halt, with no failed phase to hang it on", () => {
  const view = pipelinePhaseMeter(HALTED_MID_STEP)!;
  // The precondition: nothing here is `failed`, which is what used to silence the halt.
  assert.equal(
    view.segments.some((segment) => segment.status.tone === "failed"),
    false,
    "the fixture no longer reproduces the case - a phase resolved to failed",
  );
  assert.equal(
    view.segments.find((segment) => segment.phase === "BUILD")!.status.tone,
    "running",
    "the phase's own tone stays pipelinePhaseStatus's answer about its steps",
  );

  // ...and the halt is stated anyway, at the run's own level, read straight off `run.halt`.
  assert.deepEqual(view.halt, {
    label: "Needs a human",
    reason: "the scope widened past the approved plan",
    blurb: "Only an operator can clear this one; the engine will not re-kick it.",
  });
  // The caption is the ONE place a run-level fact outranks the phase arithmetic, because the
  // caption is the run's own line. A halted run's word is never blue.
  assert.equal(view.captionTone, "failed");
  // And the phase the run stopped in carries the sentence, since no phase failed to claim it.
  assert.equal(
    view.segments.find((segment) => segment.phase === "BUILD")!.footer,
    "Needs a human - the scope widened past the approved plan",
  );
});

test("the halt reaches the card as a word, not only as the caption's colour", () => {
  const html = render(HALTED_MID_STEP);
  assert.match(html, /class="tpm-halt workflow-failed"/);
  assert.match(html, />halted</);
  assert.match(html, /class="tpm-now workflow-failed">BUILD</);
  // The reason is its own wrapping element, not a one-line step row that would ellipsise the
  // engine's sentence into "the scope widened past the approved ...".
  assert.doesNotMatch(html, /tpm-pop-row[^>]*>[^<]*<span class="n">the scope widened/);
  // Reachable without a pointer: the halt class, the reason and what it means for whoever
  // has to clear it are all in the always-rendered description.
  assert.ok(
    html.includes(
      "Halted - Needs a human. the scope widened past the approved plan. "
        + "Only an operator can clear this one; the engine will not re-kick it.",
    ),
    "the halt marker has no plain-text description",
  );
});

test("a run with no halt draws no halt marker and keeps its phase's own tone", () => {
  // The other direction, so the marker cannot become permanent furniture.
  const view = pipelinePhaseMeter(MID_DECIDE)!;
  assert.equal(view.halt, null);
  assert.equal(view.captionTone, "running");
  const html = render(MID_DECIDE);
  assert.doesNotMatch(html, /tpm-halt/);
  assert.doesNotMatch(html, /halted/);
  // No segment invents a footer either.
  assert.deepEqual(
    view.segments.map((segment) => segment.footer),
    [null, null, null, null, null],
  );
});

test("a halted run on no placeable phase states the halt without blaming a phase for it", () => {
  // ai-conductor's own config inserts custom SHIP steps, so a halt on a step this build cannot
  // place is reachable. There is no phase to attribute it to, and inventing one would say the
  // run failed somewhere it did not - so the caption marker is the only home, which is the
  // same rule the extras marker exists for.
  const view = pipelinePhaseMeter(
    run({
      steps: steps({ worktree: "done", build: "done", "release-disposition": "in_progress" }),
      lastStep: "release-disposition",
      halt: { class: "mechanical", reason: "the release checklist could not be read" },
      group: "halted",
    }),
  )!;
  assert.equal(view.caption, "Unknown step");
  assert.equal(view.captionTone, "failed");
  assert.equal(view.halt?.label, "Mechanical");
  assert.deepEqual(
    view.segments.map((segment) => segment.footer),
    [null, null, null, null, null],
    "a phase was blamed for a halt it cannot be shown to own",
  );
});

test("a phase that finished having skipped things is degraded, not a plain pass", () => {
  // The S-tier case: the run really did finish, and it really did not do everything a
  // full-ceremony run would have. "Done" and "Done, 5 skipped" must not be one reading.
  const view = pipelinePhaseMeter(
    run({
      steps: steps({
        worktree: "done",
        memory: "done",
        explore: "done",
        complexity: "done",
        prd: "skipped",
        architecture_diagram: "skipped",
        architecture_review: "skipped",
        stories: "done",
        conflict_check: "skipped",
        plan: "done",
        coherence_check: "skipped",
        finish: "done",
      }),
      lastStep: "finish",
      group: "processed",
    }),
  )!;
  const decide = view.segments.find((segment) => segment.phase === "DECIDE")!;
  assert.equal(decide.status.tone, "passed");
  assert.equal(decide.status.degraded, true);
  assert.equal(decide.status.label, "Done, 5 skipped");
  assert.equal(decide.finished, decide.total, "a degraded phase is still a FINISHED phase");
  assert.match(decide.footer ?? "", /skipped those steps for this run's tier or track/);
  // And a skip counts as finished in the caption too, because the run is not going back for it.
  assert.equal(view.done, view.total);
});

test("a kicked-back phase reads as re-running rather than as already passed", () => {
  const view = pipelinePhaseMeter(
    run({
      steps: steps({
        worktree: "done",
        memory: "done",
        explore: "done",
        plan: "stale",
        build: "done",
        finish: "pending",
      }),
      lastStep: "plan",
    }),
  )!;
  const decide = view.segments.find((segment) => segment.phase === "DECIDE")!;
  assert.equal(decide.status.tone, "waiting");
  assert.equal(decide.status.label, "Re-running");
  assert.equal(view.captionTone, "waiting");
});

test("a step this build cannot place is counted in the total AND readable in the extras", () => {
  // The specific defect this case exists to catch is counted-but-invisible. ai-conductor's
  // own config inserts custom SHIP steps, so these names are what a card watching THAT
  // repository actually sees - not a hypothetical.
  const custom = run({
    steps: steps({
      worktree: "done",
      memory: "done",
      explore: "done",
      build: "done",
      "maintain-documentation": "done",
      "release-disposition": "in_progress",
    }),
    lastStep: "release-disposition",
  });
  const view = pipelinePhaseMeter(custom)!;
  assert.equal(view.segments.length, 5, "the five phase segments still draw");
  assert.equal(view.total, 6, "an unknown step is a step the run really has");
  assert.deepEqual(
    view.extras.unknown.map((step) => step.name),
    ["maintain-documentation", "release-disposition"],
  );
  // No segment claims one. An unknown step has no phase, so putting it in a segment would
  // invent one.
  for (const segment of view.segments) {
    assert.equal(
      segment.steps.some((step) => step.unknown),
      false,
      `${segment.phase} adopted a step with no phase`,
    );
  }
  // And the caption stays honest about sitting on one, rather than guessing a nearby phase.
  assert.equal(view.caption, "Unknown step");
  assert.equal(view.captionTone, "stopped");

  const html = render(custom);
  assert.match(html, /class="tpm-extras"/);
  assert.match(html, /maintain-documentation/);
  assert.match(html, /release-disposition/);
  assert.match(html, /Counted in the 6/);
});

test("an out-of-band step the run ran gets no segment, is not in the total, and is still readable", () => {
  // `foldSteps` includes one only when the run ACTUALLY RAN it, which for `remediate` means
  // a SHIP gate blocked - exactly the state worth seeing from a board.
  const remediated = run({
    steps: steps({
      worktree: "done",
      memory: "done",
      explore: "done",
      build: "done",
      prd_audit: "failed",
      remediate: "in_progress",
    }),
    lastStep: "remediate",
    group: "halted",
  });
  const view = pipelinePhaseMeter(remediated)!;
  assert.equal(view.total, 5, "an out-of-band step was never on the sequence, so it is not in N");
  assert.deepEqual(
    view.extras.outOfBand.map((step) => step.name),
    ["remediate"],
  );
  for (const segment of view.segments) {
    assert.equal(
      segment.steps.some((step) => step.name === "remediate"),
      false,
      `${segment.phase} drew a step the run never walked past`,
    );
  }
  const html = render(remediated);
  assert.match(html, /Remediate/);
  assert.match(html, /Not counted in the 5/);
});

test("a run with neither pile draws no extras marker at all, rather than an empty one", () => {
  const view = pipelinePhaseMeter(MID_DECIDE)!;
  assert.deepEqual(view.extras, { unknown: [], outOfBand: [] });
  const html = render(MID_DECIDE);
  assert.doesNotMatch(html, /tpm-extras/);
  // Not "+0" either, under any spelling.
  assert.doesNotMatch(html, /\+0/);
});

test("a run whose sequential list is empty draws nothing rather than an empty bar", () => {
  // A worktree the engine has only just cut. Five empty segments would claim a shape the
  // projection has not reported.
  assert.equal(pipelinePhaseMeter(run()), null);
  assert.equal(render(run()), "");
  // An out-of-band step ALONE is still an empty sequence, which is the arm a length check on
  // `run.steps` would have got wrong.
  assert.equal(pipelinePhaseMeter(run({ steps: steps({ remediate: "done" }) })), null);
});

test("pipelineSequentialSteps drops known out-of-band steps and keeps unplaceable ones", () => {
  // The shared denominator, stated on its own: both callers depend on this exact asymmetry.
  const mixed = run({
    steps: steps({ worktree: "done", remediate: "done", "release-disposition": "done" }),
  });
  assert.deepEqual(
    pipelineSequentialSteps(mixed).map((step) => step.name),
    ["worktree", "release-disposition"],
  );
});

// ---- the markup -------------------------------------------------------------------------

test("each segment's width is its own step count and its fill is its finished fraction", () => {
  const html = render(MID_DECIDE);
  // DECIDE holds eight of this run's thirteen steps and has finished five of them.
  assert.match(html, /flex-grow:8[;"]/);
  assert.match(html, /width:62\.5%/);
  // SETUP and UNDERSTAND hold one step each and are complete.
  assert.match(html, /flex-grow:1[;"]/);
  assert.match(html, /width:100%/);
  // A phase with nothing done draws a zero-width fill rather than being omitted, so the
  // segment stays a hover target for its own pending steps.
  assert.match(html, /width:0%/);
});

test("the one-step phase's floor is in the stylesheet rather than left to flex", () => {
  // SETUP and UNDERSTAND hold one step each against DECIDE's nine, so at strictly
  // proportional width they are slivers nobody can hover. The floor is what keeps them a
  // usable target, and it is asserted here because no markup assertion can see it.
  const css = readFileSync(
    fileURLToPath(new URL("../src/web/styles.css", import.meta.url)),
    "utf8",
  );
  const rule = css.slice(css.indexOf(".tpm-seg {"), css.indexOf(".tpm-seg > i"));
  assert.match(rule, /min-width:\s*\d+px/, ".tpm-seg lost its minimum width");
});

test("the tone class on a segment is the shared workflow vocabulary", () => {
  const html = render(HALTED);
  // Not a private `.plm-fail`: these are the classes the Runs page and the fleet's chips
  // already carry, which is what stops two surfaces from meaning different things by red.
  assert.match(html, /class="tpm-seg workflow-failed is-now"/);
  assert.match(html, /class="tpm-seg workflow-passed"/);
});

test("the current phase is marked with a ring class, not by colour alone", () => {
  const html = render(MID_DECIDE);
  assert.match(html, /class="tpm-seg workflow-running is-now"/);
  assert.equal(html.match(/is-now/g)?.length, 1, "exactly one segment is the current one");
});

test("a run sitting on no step rings nothing rather than defaulting to a phase", () => {
  const html = render(run({ steps: steps({ worktree: "pending", build: "pending" }) }));
  assert.doesNotMatch(html, /is-now/);
  assert.match(html, /Not started/);
});

test("a degraded phase is hatched in the markup, so done and done-with-skips differ", () => {
  const html = render(
    run({
      steps: steps({ worktree: "done", memory: "skipped", explore: "done", finish: "done" }),
      lastStep: "finish",
    }),
  );
  assert.match(html, /class="tpm-seg workflow-passed is-degraded"/);
});

// The popover BUBBLE is hover-only and lives in a portal, so `renderToStaticMarkup` never
// paints it - which is why its laid-out rows are asserted in `e2e/specs/board-card-phase-meter
// .spec.ts` and not here. What IS always rendered, for every segment, is `Tooltip`'s hidden
// description node: the plain-text twin of the same content. That node is the accessible
// answer for a reader who is not hovering, so asserting on it is not a proxy for the popover -
// it is the layer at which "this segment says what it means" is a checkable claim at all.

test("every segment states its phase, its arithmetic and its steps in plain text", () => {
  const html = render(MID_DECIDE);
  for (const phrase of [
    "SETUP: Done. 1 of 1 steps finished. Worktree done.",
    "BUILD: Pending. 0 of 2 steps finished. Build pending, Test Suite pending.",
    // The current step is named as such in words, which is the single fact the popover
    // exists to deliver and the one that must not depend on a tone.
    "Stories running (current)",
    "This is the phase the run is in.",
  ]) {
    assert.ok(html.includes(phrase), `no plain-text description for: ${phrase}`);
  }
  assert.match(html, /aria-label="add-widgets pipeline phases"/);
});

test("a skipped step and a failed one are named as such, not folded into the count", () => {
  const html = render(HALTED);
  assert.ok(html.includes("Wiring Check skipped"), "a skipped step vanished from the description");
  assert.ok(html.includes("Build Review failed (current)"));
  assert.ok(html.includes("Needs a human - Scope widened past the approved plan"));
});

test("a phase the run's state file never mentioned says so rather than drawing empty", () => {
  const html = render(run({ steps: steps({ worktree: "done" }), lastStep: "worktree" }));
  assert.match(html, /The engine has recorded nothing for this phase yet\./);
  // Four such phases here, and each still gets a segment: the meter is the engine's whole
  // sequence, so a reader can see what has not started.
  assert.equal(html.match(/class="tpm-seg workflow-stopped"/g)?.length, 4);
});

// ---- the Tooltip widening ----------------------------------------------------------------

test("the rich Tooltip arm paints its content and keeps its description plain text", () => {
  const html = renderToStaticMarkup(
    createElement(Tooltip, {
      label: {
        content: createElement("span", { className: "rows" }, "two rows"),
        description: "Two rows, in a sentence.",
      },
      children: createElement("button", null, "hover me"),
    }),
  );
  // The description node is what `aria-describedby` resolves to, so markup here would put
  // a tag name into an accessible name.
  assert.match(html, /<span id="[^"]+" class="tt-desc">Two rows, in a sentence\.<\/span>/);
  assert.doesNotMatch(html, /class="tt-desc"><span/);
  assert.match(html, /aria-describedby="[^"]+"/);
  // The bubble itself is hover-only, so `renderToStaticMarkup` sees no `tt-rich` node. That
  // the class is reachable at all is what the stylesheet needs.
  assert.doesNotMatch(html, /tooltip tt-/);
});

test("the string Tooltip arm is byte-for-byte what it was before the widening", () => {
  // Every existing call site passes a string. This is an additive widening, not a migration,
  // and the check is the markup rather than the intent.
  const html = renderToStaticMarkup(
    createElement(Tooltip, {
      label: "Open pull request",
      children: createElement("button", null, "PR"),
    }),
  );
  assert.match(html, /<span id="[^"]+" class="tt-desc">Open pull request<\/span>/);
  assert.match(html, /<button aria-describedby="[^"]+">PR<\/button>/);
});
