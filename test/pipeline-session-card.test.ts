import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PipelineRun } from "../src/shared/pipeline.ts";
import { pipelineRunKeyOf } from "../src/shared/pipeline.ts";
import { SessionCard } from "../src/web/components/SessionCard.tsx";
import { ConsoleDetail } from "../src/web/components/layouts/ConsoleDetail.tsx";
import { fleetBlocks, orderSessions } from "../src/web/lib/fleet-order.ts";
import { mkMemberSession, mkSession } from "./helpers/session-fixture.ts";
import { mkSessionView } from "./helpers/session-view.ts";

// What an engine-driven session LOOKS like on the fleet, and what it no longer offers.
//
// The hazard this covers is that a conductor-driven agent is indistinguishable from an
// ordinary one by construction: the engine spawns a real claude into a real tmux pane, so the
// name, the state badge, the transcript and the action row are all drawn from the same facts.
// The only things that separate the two are asserted here - a chip, a frame, and a composer
// that has been replaced by a sentence rather than merely disabled.

const REPO = "/repo/demo";
const LINK = {
  provider: "ai-conductor" as const,
  repoRoot: REPO,
  slug: "add-widgets",
  step: "build",
};

function mkRun(over: Partial<PipelineRun> = {}): PipelineRun {
  return {
    provider: "ai-conductor",
    repoRoot: REPO,
    slug: "add-widgets",
    worktree: `${REPO}/.worktrees/add-widgets`,
    tier: "M",
    track: "product",
    steps: [{ name: "build", state: "in_progress" }],
    lastStep: "build",
    halt: null,
    group: "building",
    prUrl: null,
    costTokens: null,
    updatedAt: 1000,
    ...over,
  };
}

const driven = mkSession({ id: "s-driven", name: "driven", pipeline: LINK });
const ordinary = mkSession({ id: "s-plain", name: "plain" });

function cardHtml(session: ReturnType<typeof mkSession>): string {
  return renderToStaticMarkup(createElement(SessionCard, { session, expanded: true }));
}

test("a correlated card wears a chip naming the run and the step it is on", () => {
  const html = cardHtml(driven);
  assert.match(html, /pipeline-chip/);
  assert.match(html, /add-widgets/);
  // The step's LABEL from the frozen table, not the engine's raw key: "Build", not "build".
  assert.match(html, /Build/);
  // And the tooltip says what the chip cannot fit - who is driving, and that this agent is
  // not reading anything typed at it.
  assert.match(html, /ai-conductor is driving add-widgets/);
  assert.match(html, /reads no input here/);
});

test("a correlated card has no composer - it has a sentence and a way out", () => {
  // The distinction the whole phase turns on. A DISABLED box says "not right now", which is
  // what a busy agent's looks like, so an operator waits for it to come back; this one never
  // does, because the process is running under `--print`.
  const html = cardHtml(driven);
  assert.match(html, /compose-notice/);
  assert.match(html, /Driven by ai-conductor - act through its run in Runs/);
  assert.match(html, /href="#\/runs\/pipeline\/[^"]+\/add-widgets"/);
  assert.doesNotMatch(html, /transcript-input/);
  assert.doesNotMatch(html, /btn-send/);
});

test("an uncorrelated card is byte-identical to what it was", () => {
  // The fail-open guarantee, asserted on the surface an operator with no engine installed
  // looks at all day: no chip, no notice, and the composer exactly where it was.
  const html = cardHtml(ordinary);
  assert.doesNotMatch(html, /pipeline-chip/);
  assert.doesNotMatch(html, /compose-notice/);
  assert.match(html, /transcript-input/);
  assert.match(html, /btn-send/);
});

test("the permission posture stays on the card, and stops being a control", () => {
  // "Honest posture" is two claims. The mode the session actually has is still SHOWN - an
  // engine-driven agent under `--dangerously-skip-permissions` must not look safer than it
  // is - and it is no longer PICKABLE, because the picker drives a TUI that reads nothing.
  const bypass = mkSession({
    id: "s-bypass",
    name: "bypass",
    pipeline: LINK,
    permissionMode: "bypassPermissions",
  });
  const html = cardHtml(bypass);
  assert.match(html, /mode mode-/, "the posture chip is still drawn");
  assert.doesNotMatch(html, /mode-btn/, "and it is no longer a button");
  // The mode itself, not a neutral placeholder: the WORD is what makes it honest.
  assert.match(html, /bypass/i);

  // The same session without the correlation keeps its picker, so the gate above is the
  // pipeline's doing and not the mode's.
  const pickable = mkSession({ id: "s-pick", name: "pick", permissionMode: "bypassPermissions" });
  assert.match(cardHtml(pickable), /mode-btn/);
});

test("the conversation window's header carries the chip too", () => {
  const html = renderToStaticMarkup(
    createElement(ConsoleDetail, { session: driven, view: mkSessionView(driven) }),
  );
  assert.match(html, /pipeline-chip/);
  assert.match(html, /add-widgets/);
});

test("sessions of one pipeline run cluster under it, as ensemble members do", () => {
  // The board and the console rail draw a frame around a cluster and head it with the run.
  // A pipeline cluster is usually ONE card - the engine runs one step at a time - and it
  // still gets a frame, because the header is what says which feature this agent is on.
  const second = mkSession({ id: "s-driven-2", name: "driven-2", pipeline: LINK });
  const elsewhere = mkSession({
    id: "s-other",
    name: "other",
    pipeline: { ...LINK, slug: "fix-the-thing" },
  });
  const ordered = orderSessions([driven, elsewhere, second]);
  const clusters = ordered.groups.flatMap((group) => group.clusters);

  assert.deepEqual(
    clusters.map((cluster) => ({ kind: cluster.kind, length: cluster.length })),
    [
      { kind: "pipeline", length: 2 },
      { kind: "pipeline", length: 1 },
    ],
    "each run frames its own sessions and absorbs nobody else's",
  );
  assert.equal(clusters[0]?.runId, pipelineRunKeyOf(mkRun()));

  // And the blocks a view renders carry the discriminant, so the board draws the pipeline
  // header rather than an ensemble one over a run that has no candidates.
  const blocks = ordered.groups.flatMap((group) => fleetBlocks(group));
  const frames = blocks.filter((block) => block.kind === "cluster");
  assert.deepEqual(frames.map((frame) => frame.cluster), ["pipeline", "pipeline"]);
  // Keys are distinct even though both frames are pipelines of one provider.
  assert.notEqual(frames[0]?.key, frames[1]?.key);
});

test("an ensemble membership outranks a pipeline correlation", () => {
  // A member dispatched into a repository an engine also drives satisfies both. A session can
  // only be in one frame, so the precedence is a decision rather than an accident: the
  // ensemble is an explicit binding Mission Control made, the correlation is a path
  // coincidence the engine's worktree layout produced.
  const both = mkMemberSession({ id: "s-both", name: "both", pipeline: LINK });
  const clusters = orderSessions([both]).groups.flatMap((group) => group.clusters);
  assert.deepEqual(clusters.map((cluster) => cluster.kind), ["ensemble"]);
  assert.equal(clusters[0]?.runId, "run-1");
});
