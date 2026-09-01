import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ServerEvent } from "../src/shared/types.ts";
import type { PipelineCommission, PipelineRun } from "../src/shared/pipeline.ts";
import {
  ENGINEER_STEP_NAMES,
  PIPELINE_STEPS,
  pipelineCommissionKey,
  pipelineRunKeyOf,
} from "../src/shared/pipeline.ts";

// What is at stake: the pipeline projection is SSE state, not a second polling subsystem. A
// reconnect snapshot and the incremental stream have to converge on the same set, and the
// browser has to REPLACE a run rather than merge it - a strip drawn from two instants would
// show four steps from one pass and two from another, which is a picture of a run that never
// existed.
//
// The source-parity assertions at the bottom check the shape of the browser's handling,
// which the `never` exhaustiveness check cannot see: it proves an arm EXISTS, not that the
// arm keys the collection correctly or that nobody added a poll beside it.

const home = mkdtempSync(join(tmpdir(), "mission-pipeline-sse-"));
process.env.HARNESS_HOME = join(home, "state");

const { openDb } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");

const db = openDb();
after(() => rmSync(home, { recursive: true, force: true }));

/** A projection row, as the watcher would hand one over. */
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
      { name: "build", state: "in_progress" },
    ],
    lastStep: "build",
    halt: null,
    group: "building",
    prUrl: null,
    costTokens: null,
    updatedAt: 1_700_000_000_000,
    ...over,
  };
}

function commission(over: Partial<PipelineCommission> = {}): PipelineCommission {
  return {
    id: "commission-1",
    taskId: "task-1",
    provider: "ai-conductor",
    repoRoot: "/repo/demo",
    correlationId: "correlation-1",
    lifecycle: "authoring",
    attempts: [
      {
        attempt: 1,
        launchKey: "launch-1",
        engineerRunId: "engineer-1",
        previousEngineerRunId: null,
        providerRevision: 12,
        state: "authoring",
        terminalReason: null,
        updatedAt: 1_700_000_000_000,
      },
    ],
    activeAttempt: 1,
    steps: ENGINEER_STEP_NAMES.map((name) => ({ name, state: "pending" })),
    currentStep: "architecture_review",
    tier: "M",
    track: "product",
    project: "mission-control",
    authoringWorktree: "/repo/demo/.worktrees/spec",
    handoff: null,
    linkedRun: null,
    error: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...over,
    blocker: over.blocker ?? null,
  };
}

test("an untouched fleet carries an empty collection, not an absent one", () => {
  // The shipped state, and the one every existing surface has to keep behaving under: an
  // array the browser holds and never renders. An absent field would make a build without
  // this feature and a fleet with nothing enabled indistinguishable on the wire.
  db.exec("DELETE FROM pipeline_runs");
  const snapshot = new Registry().snapshot();
  assert.deepEqual(snapshot.pipelineRuns, []);
  assert.deepEqual(snapshot.pipelineCommissions, []);
});

test("commission snapshot, upsert and remove converge and support server-owned joins", () => {
  const registry = new Registry();
  const events: ServerEvent[] = [];
  const unsubscribe = registry.subscribe((event) => events.push(event));
  registry.upsertPipelineCommission(commission());
  registry.upsertPipelineCommission(commission({ lifecycle: "awaiting_spec_merge" }));
  unsubscribe();

  const opening = registry.snapshot().pipelineCommissions;
  assert.equal(registry.pipelineCommission("commission-1")?.taskId, "task-1");
  assert.equal(registry.pipelineCommissionForTask("task-1")?.id, "commission-1");
  assert.equal(registry.pipelineCommissionForRun(run()), null);
  assert.deepEqual(events.map((event) => event.type), [
    "pipeline_commission_upsert",
    "pipeline_commission_upsert",
  ]);

  const reduced = new Map(opening.map((entry) => [pipelineCommissionKey(entry.id), entry]));
  const removeEvents: ServerEvent[] = [];
  const stop = registry.subscribe((event) => removeEvents.push(event));
  registry.removePipelineCommission("commission-1");
  registry.removePipelineCommission("commission-1");
  stop();
  for (const event of removeEvents) {
    if (event.type === "pipeline_commission_remove") {
      reduced.delete(pipelineCommissionKey(event.id));
    }
  }
  assert.deepEqual(removeEvents.map((event) => event.type), ["pipeline_commission_remove"]);
  assert.deepEqual([...reduced.values()], registry.snapshot().pipelineCommissions);
});

test("one commission projection stays bounded on the reconnect snapshot", () => {
  const registry = new Registry();
  registry.upsertPipelineCommission(
    commission({
      error: "x".repeat(400),
      handoff: {
        planSlug: "2026-08-28-a-realistic-feature-plan-stem",
        branch: "spec/2026-08-28-a-realistic-feature-plan-stem",
        prUrl: "https://github.com/acme/a-fairly-long-repository-name/pull/1234",
        outcome: "pr_opened",
      },
      linkedRun: {
        provider: "ai-conductor",
        repoRoot: "/repo/demo",
        slug: "2026-08-28-a-realistic-feature-plan-stem",
      },
    }),
  );
  const bytes = new TextEncoder().encode(
    JSON.stringify(registry.snapshot().pipelineCommissions),
  ).byteLength;
  assert.ok(bytes < 4_096, `one commission is ${bytes} bytes on the reconnect snapshot`);
});

test("snapshot, upsert and remove converge on one catalog, keyed not sequenced", () => {
  db.exec("DELETE FROM pipeline_runs");
  const registry = new Registry();
  const opening = registry.snapshot().pipelineRuns;

  const events: ServerEvent[] = [];
  const unsubscribe = registry.subscribe((event) => events.push(event));
  registry.upsertPipelineRun(run());
  registry.upsertPipelineRun(run({ slug: "fix-things", group: "eligible" }));
  registry.upsertPipelineRun(run({ group: "halted", halt: { class: "needs-human", reason: "gate" } }));
  registry.removePipelineRun("ai-conductor", "/repo/demo", "fix-things");
  // A remove for a run nobody is holding publishes nothing: every open window would
  // otherwise redraw a collection that never moved.
  registry.removePipelineRun("ai-conductor", "/repo/demo", "never-existed");
  unsubscribe();

  assert.deepEqual([...new Set(events.map((e) => e.type))], [
    "pipeline_upsert",
    "pipeline_remove",
  ]);

  // Reduce the frames onto the opening snapshot the way the browser does, and the result
  // must be what a freshly connected dashboard is handed.
  const reduced = new Map(opening.map((r) => [pipelineRunKeyOf(r), r]));
  for (const event of events) {
    if (event.type === "pipeline_upsert") reduced.set(pipelineRunKeyOf(event.run), event.run);
    if (event.type === "pipeline_remove") {
      reduced.delete(pipelineRunKeyOf({ provider: event.provider, repoRoot: event.repoRoot, slug: event.slug }));
    }
  }
  assert.deepEqual(
    [...reduced.values()],
    registry.snapshot().pipelineRuns,
    "the stream and the snapshot must describe the same catalog",
  );
});

test("a run is replaced whole, never merged", () => {
  // A step list assembled from two passes would draw a run that never existed. This is the
  // registry half of the rule the browser's `case` arm states.
  db.exec("DELETE FROM pipeline_runs");
  const registry = new Registry();
  registry.upsertPipelineRun(run({ steps: [{ name: "build", state: "in_progress" }] }));
  registry.upsertPipelineRun(run({ steps: [{ name: "build", state: "done" }] }));
  assert.deepEqual(registry.snapshot().pipelineRuns[0]?.steps, [{ name: "build", state: "done" }]);
});

test("two repositories with the same slug are two runs", () => {
  // The engine's slug is a plan stem, and two checkouts can hold the same plan. A key that
  // was the slug alone would silently fold them onto one row.
  db.exec("DELETE FROM pipeline_runs");
  const registry = new Registry();
  registry.upsertPipelineRun(run({ repoRoot: "/repo/a" }));
  registry.upsertPipelineRun(run({ repoRoot: "/repo/b" }));
  assert.equal(registry.snapshot().pipelineRuns.length, 2);
  registry.removePipelineRun("ai-conductor", "/repo/a", "add-widgets");
  assert.deepEqual(
    registry.snapshot().pipelineRuns.map((r) => r.repoRoot),
    ["/repo/b"],
  );
});

test("the browser handles both frames, keys them by the engine's identity, and polls nothing", () => {
  const source = readFileSync(
    resolve(import.meta.dirname, "..", "src", "web", "useEventStream.ts"),
    "utf8",
  );
  assert.match(source, /case "pipeline_upsert":/);
  assert.match(source, /case "pipeline_remove":/);
  assert.match(source, /case "pipeline_commission_upsert":/);
  assert.match(source, /case "pipeline_commission_remove":/);
  // Keyed through the SHARED helper rather than an inline template, so the browser and the
  // daemon cannot come to disagree about what identifies a run.
  assert.match(source, /setPipelineRuns\(\(prev\) => new Map\(prev\)\.set\(pipelineRunKeyOf\(msg\.run\), msg\.run\)\)/);
  assert.match(source, /next\.delete\(pipelineRunKey\(msg\.provider, msg\.repoRoot, msg\.slug\)\)/);
  // Seeded from the snapshot, wholesale, with the version-skew guard an older daemon needs.
  assert.match(source, /new Map\(\(msg\.pipelineRuns \?\? \[\]\)\.map\(\(run\) => \[pipelineRunKeyOf\(run\), run\]\)\)/);
  // The exhaustiveness check is what makes a THIRD frame impossible to add silently.
  assert.match(source, /const unhandled: never = msg;/);
  // And nothing polls the pipelines route from the stream hook.
  assert.equal(/setInterval[^\n]*pipelines/.test(source), false);
});

test("one run stays small enough that a whole fleet of them rides the snapshot", () => {
  // The budget this collection answers to, expressed PER RUN rather than per fleet, because
  // per-run size is the thing a later phase can move and the fleet total is then arithmetic
  // anybody can do. A run is dominated by its step list, so this is measured against the
  // real 26-name vocabulary plus the longest realistic halt reason and worktree path - a
  // synthetic list of same-length names would answer a question about the fixture.
  //
  // Measured today: ~1.7kB per run, so the extreme fleet this integration can produce -
  // four consented repositories with ten features in flight each - is ~70kB on a reconnect,
  // beside a snapshot that already carries every session, task and workflow run. That is
  // affordable, and it is the ceiling. A `PipelineRun` that grew past 2kB would take a
  // realistic fleet past 80kB, and the answer then is to fetch step detail on demand for
  // the Pipelines detail view and leave the rail's fields on the wire - NOT to widen this
  // number, which is why the failure message says so.
  db.exec("DELETE FROM pipeline_runs");
  const registry = new Registry();
  registry.upsertPipelineRun(
    run({
      repoRoot: "/Users/someone/workspace/a-fairly-long-repository-name",
      worktree:
        "/Users/someone/workspace/a-fairly-long-repository-name/.worktrees/2026-08-14-a-realistic-feature-plan-stem",
      slug: "2026-08-14-a-realistic-feature-plan-stem",
      steps: PIPELINE_STEPS["ai-conductor"].map((step) => ({
        name: step.name,
        state: "in_progress" as const,
      })),
      prUrl: "https://github.com/acme/a-fairly-long-repository-name/pull/1234",
      halt: {
        class: "needs-human",
        reason:
          "the as-built architecture review found code that violates an APPROVED ADR: fix the code or supersede the ADR",
      },
    }),
  );
  const bytes = new TextEncoder().encode(
    JSON.stringify(registry.snapshot().pipelineRuns),
  ).byteLength;
  assert.ok(
    bytes < 2_048,
    `one pipeline run is ${bytes} bytes on the wire; fetch step detail on demand rather than widening the snapshot`,
  );
});

test("pipeline frames are deliberately not Line inputs", () => {
  // The Line folds Mission Control's OWN execution. A pipeline run is a second engine's, and
  // the fold has no input for it - it would either be ignored or double-count the session the
  // engine spawned, which the strip already sees as a session. Pinned because
  // `LINE_INPUT_EVENTS` is a `Set` literal: the compiler cannot ask, so this does.
  const source = readFileSync(
    resolve(import.meta.dirname, "..", "src", "server", "registry.ts"),
    "utf8",
  );
  const block = source.slice(
    source.indexOf("const LINE_INPUT_EVENTS"),
    source.indexOf("]);", source.indexOf("const LINE_INPUT_EVENTS")),
  );
  assert.ok(block.length > 0, "LINE_INPUT_EVENTS should still be a literal Set");
  assert.equal(/"pipeline_upsert"/.test(block), false);
  assert.equal(/"pipeline_remove"/.test(block), false);
  assert.equal(/"pipeline_commission_upsert"/.test(block), false);
  assert.equal(/"pipeline_commission_remove"/.test(block), false);
});
