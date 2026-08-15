import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  PIPELINE_RUN_GROUPS,
  PIPELINE_STEPS,
  pipelineRunKeyOf,
  type PipelineGateVerdict,
  type PipelineRepoStatus,
  type PipelineRun,
} from "../src/shared/pipeline.ts";
import {
  PIPELINE_GROUP_ORDER,
  pipelineAttempts,
  pipelineEyebrow,
  pipelineKickbackRule,
  pipelineLeadRun,
  pipelinePhaseStatus,
  pipelineRail,
  pipelineRunLine,
  pipelineStrip,
  pipelineVerdictStatus,
} from "../src/web/pipelines/pipeline-run-model.ts";
import { PipelineRunView } from "../src/web/pipelines/PipelineRunView.tsx";
import { fetchPipelineRepos, fetchPipelineRunDetail } from "../src/web/lib/api.ts";

// What is at stake: the Pipelines detail is a picture of a run somebody is about to act on,
// drawn from an engine Mission Control does not own. Three things have to hold whatever that
// engine reports next.
//
//  1. Nothing is invented. Attempts ARE recorded kickbacks, the eyebrow's position is counted
//     over the run's own steps, and a gate that says "skipped" is never drawn as a pass.
//  2. Nothing is dropped. A step this build has no entry for is rendered, in the state the
//     engine reported, after every step it does know.
//  3. The strip is the workflow diagram's grammar rather than a lookalike, so the two cannot
//     drift into two dialects.
//
// The render assertions are `renderToStaticMarkup` because what they pin is markup SHAPE -
// which class the strip's cards carry, and that a skipped step wears the same disabled
// treatment a disabled command does. What a person can reach and read is `e2e/`'s question.

function run(over: Partial<PipelineRun> = {}): PipelineRun {
  return {
    provider: "ai-conductor",
    repoRoot: "/repo/demo",
    slug: "add-widgets",
    worktree: "/repo/demo/.worktrees/add-widgets",
    tier: "M",
    track: "product",
    steps: [
      { name: "worktree", state: "done" },
      { name: "memory", state: "done" },
      { name: "explore", state: "in_progress" },
    ],
    lastStep: "explore",
    halt: null,
    group: "building",
    prUrl: null,
    costTokens: null,
    updatedAt: 1_700_000_000_000,
    ...over,
  };
}

function verdict(over: Partial<PipelineGateVerdict> = {}): PipelineGateVerdict {
  return {
    step: "plan",
    satisfied: true,
    reason: null,
    checkedAt: 1_700_000_000_000,
    kickbackFrom: null,
    skipped: false,
    ...over,
  };
}

function repo(over: Partial<PipelineRepoStatus> = {}): PipelineRepoStatus {
  return {
    provider: "ai-conductor",
    repoRoot: "/repo/demo",
    daemon: "running",
    runs: 0,
    halted: 0,
    lastReadAt: 1_700_000_000_000,
    error: null,
    ...over,
  };
}

// ---- the rail ---------------------------------------------------------------------------

test("the rail groups runs under the repositories being read, urgent group first", () => {
  const sections = pipelineRail(
    [
      run({ slug: "b-building", group: "building" }),
      run({ slug: "a-halted", group: "halted", halt: { class: "needs-human", reason: "gate" } }),
      run({ slug: "c-done", group: "processed" }),
    ],
    [repo()],
  );
  assert.equal(sections.length, 1);
  assert.deepEqual(
    sections[0]!.groups.map((group) => group.group),
    ["halted", "building", "processed"],
    "halted leads: it is the only group waiting on a person",
  );
  assert.equal(sections[0]!.total, 3);
  assert.equal(sections[0]!.daemon, "running");
});

test("a consented repository with no runs keeps its heading", () => {
  // "Nothing here yet" and "we are not looking at this" are different answers, and the
  // heading with its daemon chip is the only thing that can tell them apart.
  const sections = pipelineRail([], [repo({ daemon: "stopped" })]);
  assert.equal(sections.length, 1);
  assert.deepEqual(sections[0]!.groups, []);
  assert.equal(sections[0]!.total, 0);
});

test("a run whose repository is missing from the status list is still drawn", () => {
  // Consent withdrawal drops the runs and the status in one request, so the two disagreeing
  // means a response is in flight. A run nobody can see is worse than a heading that
  // outlives its status by a tick.
  const sections = pipelineRail([run()], []);
  assert.equal(sections.length, 1);
  assert.equal(sections[0]!.total, 1);
  assert.equal(sections[0]!.daemon, "unknown");
});

test("runs sort by slug inside a group, not by time", () => {
  // A rail that re-ordered itself whenever a step finished would move the row somebody was
  // reaching for. The groups carry the urgency; within one, stability is the answer.
  const sections = pipelineRail(
    [
      run({ slug: "zebra", updatedAt: 3 }),
      run({ slug: "alpha", updatedAt: 1 }),
      run({ slug: "middle", updatedAt: 2 }),
    ],
    [repo()],
  );
  assert.deepEqual(
    sections[0]!.groups[0]!.runs.map((entry) => entry.slug),
    ["alpha", "middle", "zebra"],
  );
});

// ---- which run the bare tab opens on -----------------------------------------------------

test("the bare tab opens on the most urgent run on the FLEET, not in the first repository", () => {
  // The defect this exists for: the rail is grouped per repository, so flattening it in
  // order picks the first repository's merely-building run over a second repository's
  // halted one. Urgency does not stop at a repository boundary - halted is the only group
  // waiting on a person, wherever it is.
  const sections = pipelineRail(
    [
      run({ repoRoot: "/repo/first", slug: "just-building", group: "building" }),
      run({
        repoRoot: "/repo/second",
        slug: "needs-somebody",
        group: "halted",
        halt: { class: "needs-human", reason: "a gate refused" },
      }),
    ],
    [repo({ repoRoot: "/repo/first" }), repo({ repoRoot: "/repo/second" })],
  );
  assert.deepEqual(
    sections.map((section) => section.repoRoot),
    ["/repo/first", "/repo/second"],
    "the rail still lists repositories in the operator's own order",
  );
  assert.equal(pipelineLeadRun(sections)?.slug, "needs-somebody");
});

test("repository order breaks a tie inside one group, and slug order inside that", () => {
  const sections = pipelineRail(
    [
      run({ repoRoot: "/repo/second", slug: "aaa-first-alphabetically", group: "building" }),
      run({ repoRoot: "/repo/first", slug: "zzz-last-alphabetically", group: "building" }),
      run({ repoRoot: "/repo/first", slug: "mmm-middle", group: "building" }),
    ],
    [repo({ repoRoot: "/repo/first" }), repo({ repoRoot: "/repo/second" })],
  );
  // The earlier repository wins the tie, and inside it the slug order the rail already draws.
  assert.equal(pipelineLeadRun(sections)?.slug, "mmm-middle");
});

test("a fleet with nothing in flight leads with nothing rather than throwing", () => {
  assert.equal(pipelineLeadRun(pipelineRail([], [repo()])), null);
  assert.equal(pipelineLeadRun([]), null);
});

/**
 * The reading order has to be a PERMUTATION of the persisted vocabulary, never a subset.
 *
 * `pipelineRail` only emits a group that appears in `PIPELINE_GROUP_ORDER`, so a member left
 * out of it is not a mis-sorted rail - it is a run that is invisible, uncounted, and
 * unreachable. The derivation makes that a compile error, and this makes it a test failure
 * as well, because the next change here might be someone replacing the derivation with a
 * hand-written list again. The other test below walks `PIPELINE_GROUP_ORDER` itself, so it
 * cannot see an omission from it - this is the one that can.
 */
test("the reading order carries every run group the vocabulary defines", () => {
  assert.deepEqual(
    [...PIPELINE_GROUP_ORDER].sort(),
    [...PIPELINE_RUN_GROUPS].sort(),
    "a group in the vocabulary but not in the reading order vanishes from the rail entirely",
  );
  assert.equal(
    new Set(PIPELINE_GROUP_ORDER).size,
    PIPELINE_GROUP_ORDER.length,
    "a duplicated group would draw its runs twice",
  );
  // And the order itself is the reading order, not the vocabulary's append-only one.
  assert.equal(PIPELINE_GROUP_ORDER[0], "halted", "halted leads: it is what wants a person");
  assert.deepEqual(PIPELINE_GROUP_ORDER.slice(-2), ["parked", "processed"], "outcomes last");
});

test("every group can lead, in the order an operator should meet them", () => {
  // Walks the whole vocabulary so a group added later cannot quietly rank above `halted`.
  for (const [index, group] of PIPELINE_GROUP_ORDER.entries()) {
    const rest = PIPELINE_GROUP_ORDER.slice(index);
    const sections = pipelineRail(
      rest.map((each) => run({ slug: `run-${each}`, group: each })),
      [repo()],
    );
    assert.equal(
      pipelineLeadRun(sections)?.slug,
      `run-${group}`,
      `${group} should lead a fleet holding ${rest.join(", ")}`,
    );
  }
});

test("a rail row says what a run is doing, or why it stopped", () => {
  assert.equal(pipelineRunLine(run()), "Explore");
  assert.equal(
    pipelineRunLine(run({ halt: { class: "needs-human", reason: "two blocking defects" } })),
    "two blocking defects",
  );
  assert.equal(pipelineRunLine(run({ lastStep: null })), "no step recorded yet");
});

// ---- the live eyebrow -------------------------------------------------------------------

test("the eyebrow counts position over the run's OWN steps", () => {
  // Not over the frozen table's 22. The two differ whenever the engine's vocabulary has
  // moved, and the projection is what actually exists.
  assert.equal(pipelineEyebrow(run()), "DECIDE · Explore · step 3 of 3");
  assert.equal(pipelineEyebrow(run({ lastStep: null })), "Not started");
  assert.equal(
    pipelineEyebrow(
      run({ steps: [{ name: "vibe_check", state: "in_progress" }], lastStep: "vibe_check" }),
    ),
    "Unknown step · vibe_check · step 1 of 1",
    "a step this build cannot place is still a step the run is on",
  );
});

test("an out-of-band step does not count toward the sequence", () => {
  // It is dispatched in response to something rather than in sequence, so counting it would
  // report a run as further along a path it was never on.
  const withRemediate = run({
    steps: [
      { name: "worktree", state: "done" },
      { name: "remediate", state: "done" },
    ],
    lastStep: "worktree",
  });
  assert.equal(pipelineEyebrow(withRemediate), "SETUP · Worktree · step 1 of 1");
});

// ---- the strip --------------------------------------------------------------------------

test("the strip places known steps by phase and carries unknown ones after them", () => {
  const strip = pipelineStrip(
    "ai-conductor",
    [
      { name: "worktree", state: "done" },
      { name: "build", state: "in_progress" },
      { name: "vibe_check", state: "pending" },
      { name: "remediate", state: "failed" },
    ],
    [],
  );
  assert.deepEqual(
    strip.phases.map((card) => [card.phase, card.steps.map((step) => step.name)]),
    [
      ["SETUP", ["worktree"]],
      ["UNDERSTAND", []],
      ["DECIDE", []],
      ["BUILD", ["build"]],
      ["SHIP", []],
    ],
  );
  assert.deepEqual(strip.unknown.map((step) => step.name), ["vibe_check"]);
  assert.deepEqual(strip.outOfBand.map((step) => step.name), ["remediate"]);
  assert.equal(strip.unknown[0]!.unknown, true);
  assert.equal(strip.unknown[0]!.state, "pending", "in the state the engine reported");
});

test("a step's gate verdict rides its row, and a skip is not a pass", () => {
  const strip = pipelineStrip(
    "ai-conductor",
    [{ name: "complexity", state: "skipped" }],
    [verdict({ step: "complexity", satisfied: true, reason: "skipped: tier S", skipped: true })],
  );
  const row = strip.phases.find((card) => card.phase === "DECIDE")!.steps[0]!;
  assert.equal(row.verdict?.skipped, true);
  assert.equal(pipelineVerdictStatus(row.verdict!).label, "Gate skipped");
  assert.equal(pipelineVerdictStatus(row.verdict!).tone, "stopped");
  assert.equal(pipelineVerdictStatus(verdict()).label, "Gate passed");
  assert.equal(pipelineVerdictStatus(verdict({ satisfied: false })).tone, "failed");
});

test("the retained no-op keeps its slot in the strip", () => {
  // The engine's own state still has it, and a strip that hid it would not match the file.
  const strip = pipelineStrip("ai-conductor", [{ name: "wiring_check", state: "done" }], []);
  const row = strip.phases.find((card) => card.phase === "BUILD")!.steps[0]!;
  assert.equal(row.deprecated, true);
});

test("a phase card folds its steps, and says when a pass was not fully earned", () => {
  const of = (states: string[]) =>
    pipelineStrip(
      "ai-conductor",
      states.map((state, i) => ({
        name: PIPELINE_STEPS["ai-conductor"][i]!.name,
        state: state as PipelineRun["steps"][number]["state"],
      })),
      [],
    );
  const stepsOf = (states: string[]) => of(states).phases.flatMap((card) => card.steps);

  assert.equal(pipelinePhaseStatus(stepsOf(["failed", "in_progress"]))?.tone, "failed");
  assert.equal(pipelinePhaseStatus(stepsOf(["in_progress", "pending"]))?.tone, "running");
  assert.equal(pipelinePhaseStatus(stepsOf(["stale", "pending"]))?.label, "Re-running");
  assert.equal(pipelinePhaseStatus(stepsOf(["done", "done"]))?.label, "Done");
  assert.equal(pipelinePhaseStatus(stepsOf(["pending", "pending"]))?.label, "Pending");

  const partlySkipped = pipelinePhaseStatus(stepsOf(["done", "skipped"]));
  assert.equal(partlySkipped?.label, "Done, 1 skipped");
  assert.equal(partlySkipped?.degraded, true, "a reader comparing two runs needs that difference");
  assert.equal(pipelinePhaseStatus([]), null);
});

// ---- attempts ---------------------------------------------------------------------------

test("a run with no kickback has exactly one attempt, and nothing is drawn for it", () => {
  assert.deepEqual(pipelineAttempts([]), [{ index: 1, kickback: null, current: true }]);
});

test("each recorded kickback opens an attempt, in the order they were answered", () => {
  const attempts = pipelineAttempts([
    verdict({ step: "plan", kickbackFrom: "build_review", checkedAt: 200 }),
    verdict({ step: "prd", kickbackFrom: "manual_test", checkedAt: 100 }),
  ]);
  assert.deepEqual(
    attempts.map((attempt) => [attempt.index, attempt.kickback?.from ?? null, attempt.current]),
    [
      [1, null, false],
      [2, "manual_test", false],
      [3, "build_review", true],
    ],
  );
});

test("one refusal that re-opened several gates is one attempt, not several", () => {
  // The engine writes a file per invalidated gate for one decision, so counting files would
  // report a run as having gone round four times when it went round once.
  const attempts = pipelineAttempts([
    verdict({ step: "plan", kickbackFrom: "build_review", checkedAt: 500 }),
    verdict({ step: "stories", kickbackFrom: "build_review", checkedAt: 500 }),
    verdict({ step: "prd", kickbackFrom: "build_review", checkedAt: 500 }),
  ]);
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts[1]!.kickback?.to, ["plan", "stories", "prd"]);
});

test("two refusals whose step and time run together stay two attempts", () => {
  // The merge key's own collision pair: `("build_review", 12)` and `("build_review1", 2)`
  // concatenate to one string. Merging them would report a run as having gone round once
  // when it went round twice, and step names come from an engine whose vocabulary this build
  // does not control.
  const attempts = pipelineAttempts([
    verdict({ step: "plan", kickbackFrom: "build_review", checkedAt: 12 }),
    verdict({ step: "prd", kickbackFrom: "build_review1", checkedAt: 2 }),
  ]);
  assert.equal(attempts.length, 3, "one for the first pass, and one per distinct refusal");
  assert.deepEqual(
    attempts.map((attempt) => attempt.kickback?.from ?? null),
    [null, "build_review1", "build_review"],
    "sorted by when each was answered, and neither swallowed the other",
  );
});

test("an undated kickback still opens an attempt, sorted last and stably", () => {
  const attempts = pipelineAttempts([
    verdict({ step: "plan", kickbackFrom: "no-clock", checkedAt: null }),
    verdict({ step: "prd", kickbackFrom: "build_review", checkedAt: 10 }),
  ]);
  assert.deepEqual(
    attempts.map((attempt) => attempt.kickback?.from ?? null),
    [null, "build_review", "no-clock"],
  );
});

// ---- the footer -------------------------------------------------------------------------

test("the kickback rule names the steps a refusal returns to", () => {
  const rule = pipelineKickbackRule("ai-conductor");
  for (const label of ["PRD", "Architecture Review", "Stories", "Plan"]) {
    assert.ok(rule.includes(label), `the footer should name ${label}`);
  }
});

// ---- what it renders --------------------------------------------------------------------

function markup(over: Partial<PipelineRun> = {}, gates: PipelineGateVerdict[] = []): string {
  return renderToStaticMarkup(
    createElement(PipelineRunView, {
      run: run(over),
      detail: {
        state: "ready",
        detail: {
          provider: "ai-conductor",
          repoRoot: "/repo/demo",
          slug: "add-widgets",
          gates,
          readAt: 1_700_000_000_000,
        },
      },
    }),
  );
}

test("the detail draws the workflow diagram's own strip, not a lookalike", () => {
  const html = markup();
  // The leaves from `pipeline-bits.tsx`, which is what makes this the same picture as the
  // workflow run monitor rather than a second stage-rendering dialect.
  assert.match(html, /class="wf-pipeline"/);
  assert.match(html, /class="wf-pipeline-strip"/);
  assert.match(html, /class="wf-pipeline-stage[ "]/);
  assert.match(html, /class="wf-pipeline-terminus is-session"/);
  assert.match(html, /class="wf-pipeline-terminus is-end"/);
  assert.match(html, /class="wf-pipeline-seam"/);
  // Both termini, the five phases, and the footer that states the kickback rule.
  for (const word of ["Spec", "SETUP", "UNDERSTAND", "DECIDE", "BUILD", "SHIP", "Pull request"]) {
    assert.ok(html.includes(word), `the strip should carry ${word}`);
  }
  assert.match(html, /class="wf-pipeline-repair"/);
  // And the wires say what they cross.
  assert.match(html, /class="wf-pipeline-gate">plan filed</);
  assert.match(html, /class="wf-pipeline-gate">spec approved</);
});

test("a skipped step is drawn dashed, like a disabled command", () => {
  const html = markup({ steps: [{ name: "complexity", state: "skipped" }] });
  assert.match(html, /class="wf-pipeline-reviewer is-persona is-disabled"/);
  assert.match(html, /wf-pipeline-disabled-mark/);
});

test("an unknown step is rendered rather than dropped", () => {
  const html = markup({ steps: [{ name: "vibe_check", state: "in_progress" }] });
  assert.match(html, /Unknown steps/);
  assert.match(html, /pipelines-unknown-mark/);
  assert.ok(html.includes("vibe_check"), "the engine's own name for it, verbatim");
});

/**
 * The wire into the pull request says "run finished". The Unknown steps card is where steps
 * this build cannot place are parked rather than a boundary the run crossed, so the wire into
 * IT says nothing - otherwise one handoff is claimed on two different wires, and the card
 * between them reads as a stage the run walked through.
 */
test("the run-finished wire is the one entering the pull request, and only that one", () => {
  const plain = markup();
  assert.equal(
    plain.split(`class="wf-pipeline-gate">run finished<`).length - 1,
    1,
    "one labelled wire into the pull request",
  );

  const withUnknown = markup({ steps: [{ name: "vibe_check", state: "in_progress" }] });
  assert.equal(
    withUnknown.split(`class="wf-pipeline-gate">run finished<`).length - 1,
    1,
    "still exactly one, drawn after the Unknown steps card rather than before it",
  );
  const unknownAt = withUnknown.indexOf("Unknown steps");
  assert.ok(
    withUnknown.indexOf(`class="wf-pipeline-gate">run finished<`) > unknownAt,
    "the labelled wire follows the unknown card, so the unlabelled one leads into it",
  );
});

test("a halted run leads with the halt, in words rather than in colour", () => {
  const html = markup({
    group: "halted",
    halt: { class: "needs-human", reason: "the review found two blocking defects" },
  });
  assert.match(html, /pipelines-run-halt/);
  assert.ok(html.includes("Needs a human"));
  assert.ok(html.includes("the review found two blocking defects"));
});

test("the gate verdicts section carries each answer, its reason and its kickback", () => {
  const html = markup({}, [
    verdict({ step: "plan", satisfied: false, reason: "the plan skips migrations" }),
    verdict({ step: "prd", kickbackFrom: "build_review" }),
  ]);
  assert.match(html, /aria-label="Gate verdicts"/);
  assert.match(html, /class="pipelines-verdict is-refused"/);
  assert.ok(html.includes("the plan skips migrations"));
  assert.ok(html.includes("Re-opened by Build Review"));
});

test("the header reserves its action slot without drawing a dead control", () => {
  // Phase 4 fills it with the engine's control verbs. Until then there is nothing in it: a
  // greyed-out button that cannot do anything is worse than no button.
  const html = markup();
  assert.match(html, /class="pipelines-run-head"/);
  assert.equal(/<button/.test(html), false, "no control on a read-only surface");
});

test("attempt cards appear only once a run has been round more than once", () => {
  assert.equal(/pipelines-attempts/.test(markup()), false);
  const kicked = markup({}, [verdict({ step: "plan", kickbackFrom: "build_review" })]);
  assert.match(kicked, /aria-label="Attempts"/);
  assert.match(kicked, /class="pipelines-attempt is-current"/);
  assert.ok(kicked.includes("Build Review sent it back to Plan"));
});

/**
 * Two runs whose repository root and slug concatenate to the same string.
 *
 * `("/repo/foo", "1-fix")` and `("/repo/foo1", "-fix")` are the pair `pipelineRunKey` exists
 * for. The rail keys its rows and its "active" mark by run identity, so a collision here is
 * not cosmetic: one click would mark two rows active, and React would reconcile two rows
 * under one key. The rail has to draw both, separately, and `pipelineRunKeyOf` has to tell
 * them apart.
 */
test("two runs whose repo and slug run together are still two runs", () => {
  const first = run({ repoRoot: "/repo/foo", slug: "1-fix" });
  const second = run({ repoRoot: "/repo/foo1", slug: "-fix" });
  assert.notEqual(
    pipelineRunKeyOf(first),
    pipelineRunKeyOf(second),
    "the shared key helper is what keeps these apart; a plain join does not",
  );

  const sections = pipelineRail(
    [first, second],
    [repo({ repoRoot: "/repo/foo" }), repo({ repoRoot: "/repo/foo1" })],
  );
  assert.deepEqual(
    sections.map((section) => section.total),
    [1, 1],
    "one run under each repository, not two under one and none under the other",
  );
});

// ---- what the two hooks rest on: both reads are TOTAL ------------------------------------

/**
 * Neither Pipelines read may reject, because both callers rely on that in their own way.
 *
 * `usePipelineRepos` awaits its read with no catch, on the documented promise that a failed
 * one leaves the previous rail standing. `usePipelineRunDetail` fires a detached
 * `void ...then(...)`. If either read could reject, the first would leave the poll's promise
 * unhandled and the second would raise an unhandled rejection and strand the reader on
 * "Reading the engine's gates...". Both are safe only because `fetchJson` is total - so that
 * totality is the thing to pin, rather than adding a catch at each call site that would be
 * dead code today and would hide the change if it ever stopped being true.
 */
test("a dropped connection resolves both pipeline reads to null rather than rejecting", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (() => Promise.reject(new TypeError("Failed to fetch"))) as typeof fetch;
  try {
    assert.equal(await fetchPipelineRepos(), null, "the rail's read survives a dead socket");
    assert.equal(
      await fetchPipelineRunDetail("ai-conductor", "/repo/demo", "add-widgets"),
      null,
      "the detail's read survives a dead socket",
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a 5xx from the daemon resolves to null too, rather than throwing on the body", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("<html>gateway</html>", {
      status: 502,
      headers: { "content-type": "text/html" },
    })) as typeof fetch;
  try {
    assert.equal(await fetchPipelineRepos(), null);
    assert.equal(await fetchPipelineRunDetail("ai-conductor", "/repo/demo", "add-widgets"), null);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---- the styling discipline this surface inherits ---------------------------------------

test("this surface's own chip container gives the chip a track of its own", () => {
  // The lesson `workflow-pipeline-label-width.test.ts` pins next door, applied here: a chip
  // is `flex: none` and carries a whole phrase, so on a shared flex line it takes its width
  // out of the label beside it - which is how a run once drew a step name one letter per
  // line. This surface's one chip-beside-a-label container has to be a grid.
  const css = readFileSync(
    fileURLToPath(new URL("../src/web/styles.css", import.meta.url)),
    "utf8",
  );
  const body = /\.pipelines-verdict-head\s*\{([^}]*)\}/.exec(css)?.[1];
  assert.ok(body, "the .pipelines-verdict-head rule is gone");
  assert.match(body, /display:\s*grid/);
  assert.match(body, /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto/);
});

/**
 * The strip's cards hang on a midline here rather than stretching to the tallest.
 *
 * This engine's phases are 1, 1, 9, 5 and 6 steps, so the shared `align-items: stretch` gave
 * SETUP a card nine rows tall holding one row of content. The override has to stay scoped to
 * `.pipelines-run`: unscoped, it would relayout the workflow run's strip, which is the one
 * thing this surface promises never to touch.
 */
test("the shared strip is re-aligned for this surface only, never globally", () => {
  const css = readFileSync(
    fileURLToPath(new URL("../src/web/styles.css", import.meta.url)),
    "utf8",
  );
  const scoped = /\.pipelines-run\s+\.wf-pipeline-strip\s*\{([^}]*)\}/.exec(css)?.[1];
  assert.ok(scoped, "the scoped strip alignment rule is gone");
  assert.match(scoped, /align-items:\s*center/);

  // And the shared rule it overrides still says what the workflow surface depends on.
  const shared = /\n\.wf-pipeline-strip\s*\{([^}]*)\}/.exec(css)?.[1];
  assert.ok(shared, "the shared .wf-pipeline-strip rule is gone");
  assert.match(
    shared,
    /align-items:\s*stretch/,
    "the workflow strip must keep stretching; only the pipelines surface opts out",
  );
});
