import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  classifyGroup,
  foldSteps,
  normalizeConductorRun,
  type NormalizeInput,
} from "../src/server/pipelines/conductor/normalize.ts";
import {
  readConductState,
  readDaemon,
  readDone,
  readHalt,
} from "../src/server/pipelines/conductor/state.ts";
import { seedConductorDaemon, seedConductorRun } from "../e2e/fixtures/conductor.ts";

// What is at stake: the group is the ONE derived fact in this projection - everything else
// is a field copied out of a file - and it is what the rail will sort runs by. Two of its
// six values, `waiting` and `eligible`, look identical from the state file and differ only
// by what `.daemon/` says, which is exactly the distinction an operator acts on: one means
// "give it a moment" and the other means "your engine daemon is not running".
//
// So this file pins the precedence explicitly, including each pair where two conditions are
// true at once. A halted run whose last step is still `in_progress` is the case that decides
// whether the rail says "working" about something that stopped.

const home = mkdtempSync(join(tmpdir(), "mission-pipeline-normalize-"));
after(() => rmSync(home, { recursive: true, force: true }));

function repo(name: string): string {
  const root = join(home, name);
  mkdirSync(root, { recursive: true });
  return root;
}

/** Read one seeded run exactly as the provider's own pass does. */
function inputFor(root: string, slug: string, worktree: string): NormalizeInput {
  return {
    repoRoot: root,
    slug,
    worktree,
    state: readConductState(worktree),
    halt: readHalt(worktree),
    done: readDone(worktree),
    daemon: readDaemon(root),
    costTokens: null,
    now: 1_700_000_000_000,
  };
}

test("a run with a step in progress under a live daemon is building", () => {
  const root = repo("building");
  const worktree = seedConductorRun(root, "feat", {
    steps: { worktree: "done", build: "in_progress" },
    lastStep: "build",
  });
  seedConductorDaemon(root, { pid: process.pid });
  assert.equal(classifyGroup(inputFor(root, "feat", worktree)), "building");
});

test("a step left in progress by a daemon that died is waiting, not building", () => {
  // The marker in `conduct-state.json` outlives the process that wrote it, so an engine
  // daemon killed mid-step leaves `in_progress` behind forever. Reading that as `building`
  // shows an operator a run that is working when nothing is going to advance it - the exact
  // "give it a moment" / "your daemon is not running" confusion the waiting group exists to
  // resolve. No daemon written at all here: `readDaemon` reports pid null.
  const dead = repo("in-progress-no-daemon");
  const worktree = seedConductorRun(dead, "feat", {
    steps: { worktree: "done", build: "in_progress" },
    lastStep: "build",
  });
  assert.equal(classifyGroup(inputFor(dead, "feat", worktree)), "waiting");

  // A PAUSED daemon is deliberately the other way. The engine honours a pause between
  // steps, so a step already in flight really is still running, and calling it waiting
  // would be the same lie pointed the other direction.
  const paused = repo("in-progress-paused");
  const pausedWorktree = seedConductorRun(paused, "feat", {
    steps: { worktree: "done", build: "in_progress" },
    lastStep: "build",
  });
  seedConductorDaemon(paused, { pid: process.pid, paused: true });
  assert.equal(classifyGroup(inputFor(paused, "feat", pausedWorktree)), "building");
});

test("nothing running under a live daemon is eligible; under none, or paused, it is waiting", () => {
  // The distinction this whole classification exists for. Both look identical in the state
  // file; only `.daemon/` tells them apart, which is why the daemon reading is an input to
  // the fold rather than a decoration on the panel.
  const root = repo("eligible");
  const worktree = seedConductorRun(root, "feat", { steps: { worktree: "done" } });

  seedConductorDaemon(root, { pid: process.pid });
  assert.equal(classifyGroup(inputFor(root, "feat", worktree)), "eligible");

  const stopped = repo("waiting-stopped");
  const stoppedWorktree = seedConductorRun(stopped, "feat", { steps: { worktree: "done" } });
  assert.equal(classifyGroup(inputFor(stopped, "feat", stoppedWorktree)), "waiting");

  const paused = repo("waiting-paused");
  const pausedWorktree = seedConductorRun(paused, "feat", { steps: { worktree: "done" } });
  seedConductorDaemon(paused, { pid: process.pid, paused: true });
  assert.equal(classifyGroup(inputFor(paused, "feat", pausedWorktree)), "waiting");
});

test("a halt outranks an in-progress step: a run that stopped is not still working", () => {
  // The engine halts DURING a step, so the state file keeps saying `in_progress` after it
  // stopped. Reading that as `building` would put a spinner on a run that needs a human.
  const root = repo("halt-beats-building");
  const worktree = seedConductorRun(root, "feat", {
    steps: { build: "in_progress" },
    halt: "the build review found two blocking defects",
    haltClass: "needs-human",
  });
  seedConductorDaemon(root, { pid: process.pid });
  const input = inputFor(root, "feat", worktree);
  assert.equal(classifyGroup(input), "halted");
  assert.deepEqual(normalizeConductorRun(input).halt, {
    class: "needs-human",
    reason: "the build review found two blocking defects",
  });
});

test("a halt outranks a converged run: finished and then refused is not finished", () => {
  const root = repo("halt-beats-done");
  const worktree = seedConductorRun(root, "feat", {
    steps: { finish: "done" },
    done: true,
    halt: "the land-time coherence gate refused",
  });
  seedConductorDaemon(root, { pid: process.pid });
  assert.equal(classifyGroup(inputFor(root, "feat", worktree)), "halted");
});

test("parking outranks everything, including a halt", () => {
  // An operator who parks a halted run has already seen the halt. A rail that re-surfaced it
  // under `halted` would be arguing with the decision they just made.
  const root = repo("parked");
  const worktree = seedConductorRun(root, "feat", {
    steps: { build: "in_progress" },
    halt: "something needs a human",
  });
  seedConductorDaemon(root, { pid: process.pid, parked: ["feat"] });
  assert.equal(classifyGroup(inputFor(root, "feat", worktree)), "parked");
});

test("processed is reached three ways, and each of them alone is enough", () => {
  const byMarker = repo("processed-marker");
  const markerTree = seedConductorRun(byMarker, "feat", { done: true });
  seedConductorDaemon(byMarker, { pid: process.pid });
  assert.equal(classifyGroup(inputFor(byMarker, "feat", markerTree)), "processed");

  const byState = repo("processed-state");
  const stateTree = seedConductorRun(byState, "feat", { complete: true });
  seedConductorDaemon(byState, { pid: process.pid });
  assert.equal(classifyGroup(inputFor(byState, "feat", stateTree)), "processed");

  const byDaemon = repo("processed-daemon");
  const daemonTree = seedConductorRun(byDaemon, "feat", {});
  seedConductorDaemon(byDaemon, {
    pid: process.pid,
    processed: { feat: { prUrl: "https://github.com/acme/demo/pull/9" } },
  });
  assert.equal(classifyGroup(inputFor(byDaemon, "feat", daemonTree)), "processed");
});

test("the pull request comes from the state file, or from the daemon's record after it", () => {
  const fromState = repo("pr-state");
  const stateTree = seedConductorRun(fromState, "feat", {
    prUrl: "https://github.com/acme/demo/pull/1",
  });
  assert.equal(
    normalizeConductorRun(inputFor(fromState, "feat", stateTree)).prUrl,
    "https://github.com/acme/demo/pull/1",
  );

  // The fallback matters for a run torn down past the point its state file described.
  const fromDaemon = repo("pr-daemon");
  const daemonTree = seedConductorRun(fromDaemon, "feat", {});
  seedConductorDaemon(fromDaemon, {
    processed: { feat: { prUrl: "https://github.com/acme/demo/pull/2" } },
  });
  assert.equal(
    normalizeConductorRun(inputFor(fromDaemon, "feat", daemonTree)).prUrl,
    "https://github.com/acme/demo/pull/2",
  );
});

test("the strip carries all 22 sequential steps even when the state file names three", () => {
  // Otherwise a run's diagram grows a box at a time as the engine walks it, and there is no
  // way to see how much is left - which is the one thing a pipeline diagram is for.
  const state = readConductState(
    seedConductorRun(repo("fold"), "feat", {
      steps: { worktree: "done", memory: "done", explore: "in_progress" },
    }),
  );
  const steps = foldSteps(state);
  assert.equal(steps.length, 22);
  assert.equal(steps[0]?.name, "worktree");
  assert.equal(steps[0]?.state, "done");
  assert.equal(steps.at(-1)?.name, "finish");
  assert.equal(steps.at(-1)?.state, "pending", "a step nothing has said anything about");
  assert.equal(steps.find((s) => s.name === "explore")?.state, "in_progress");
});

test("the strip preserves a refused step instead of synthesizing pending", () => {
  const state = readConductState(
    seedConductorRun(repo("fold-refused"), "feat", {
      steps: { architecture_review_as_built: "refused" },
      lastStep: "architecture_review_as_built",
    }),
  );

  assert.equal(
    foldSteps(state).find((step) => step.name === "architecture_review_as_built")?.state,
    "refused",
  );
});

test("an out-of-band step appears only when it actually ran", () => {
  // `remediate` is dispatched in RESPONSE to a failing SHIP gate. Drawing it as a pending
  // box on every healthy run would promise a step that mostly never happens.
  const quiet = readConductState(seedConductorRun(repo("oob-quiet"), "feat", {
    steps: { build: "done" },
  }));
  assert.equal(foldSteps(quiet).some((s) => s.name === "remediate"), false);

  const ran = readConductState(seedConductorRun(repo("oob-ran"), "feat", {
    steps: { build: "done", remediate: "done" },
  }));
  const folded = foldSteps(ran);
  assert.equal(folded.find((s) => s.name === "remediate")?.state, "done");
  assert.equal(folded.length, 23);
});

test("a step from a newer engine is carried, in state, after every step this build knows", () => {
  const state = readConductState(
    seedConductorRun(repo("fold-unknown"), "feat", {
      steps: { build: "done", quantum_check: "failed" },
    }),
  );
  const steps = foldSteps(state);
  const unknown = steps.at(-1);
  assert.equal(unknown?.name, "quantum_check");
  assert.equal(unknown?.state, "failed");
});

test("a run whose worktree holds no state file still projects, with everything unknown", () => {
  // A worktree the engine has only just cut. It must appear - a run nobody can see is worse
  // than one drawn with nothing in it - and it must claim nothing.
  const root = repo("bare");
  const worktree = seedConductorRun(root, "fresh", {});
  rmSync(join(worktree, ".pipeline", "conduct-state.json"));
  const run = normalizeConductorRun(inputFor(root, "fresh", worktree));
  assert.equal(run.slug, "fresh");
  assert.equal(run.tier, null);
  assert.equal(run.track, null);
  assert.equal(run.lastStep, null);
  assert.equal(run.prUrl, null);
  assert.equal(run.costTokens, null);
  assert.equal(run.group, "waiting");
  assert.ok(run.steps.every((s) => s.state === "pending"));
});
