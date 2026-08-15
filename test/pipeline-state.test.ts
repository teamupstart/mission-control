import { after, test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readConductState,
  readDaemon,
  readDone,
  readGateVerdicts,
  readHalt,
  readWorktrees,
} from "../src/server/pipelines/conductor/state.ts";
import { tailConductorEvents, tokensIn } from "../src/server/pipelines/conductor/tail.ts";
import {
  conductorWorktree,
  seedConductorDaemon,
  seedConductorRun,
} from "../e2e/fixtures/conductor.ts";

// What is at stake: every reader here parses files another program writes, concurrently,
// with atomic renames - so a caller that arrives mid-write meets a path that has just
// vanished, and one that arrives after a conductor release meets a shape it has never seen.
// The engine's own reader may treat a corrupt state file as a hard error because it is about
// to ACT on it; this one is only going to draw it, and a daemon that stopped projecting over
// one truncated JSON file would take every other repository's runs down with it.
//
// So the claim under test is uniform: every function is TOTAL. Missing, empty, truncated,
// wrong-typed and wrong-shaped inputs all degrade, and none of them throws.
//
// The fixtures come from `e2e/fixtures/conductor.ts` rather than from literals here, on
// purpose: that module is what the browser suite seeds with too, so a reader that passes
// against a shape the real engine never writes fails in both layers or neither.

const home = mkdtempSync(join(tmpdir(), "mission-pipeline-state-"));
after(() => rmSync(home, { recursive: true, force: true }));

/** A throwaway repository root, one per case, so no test can see another's tree. */
function repo(name: string): string {
  const root = join(home, name);
  mkdirSync(root, { recursive: true });
  return root;
}

// ---- conduct-state.json --------------------------------------------------------------

test("a well-formed state file yields its steps, tier, track and pull request", () => {
  const root = repo("well-formed");
  const worktree = seedConductorRun(root, "add-widgets", {
    steps: { worktree: "done", memory: "done", explore: "in_progress", plan: "pending" },
    lastStep: "explore",
    tier: "M",
    track: "product",
    prUrl: "https://github.com/acme/demo/pull/7",
    worktreeBranch: "feat/daemon-add-widgets",
  });

  const state = readConductState(worktree);
  assert.equal(state.read, true);
  assert.equal(state.steps.get("worktree"), "done");
  assert.equal(state.steps.get("explore"), "in_progress");
  assert.equal(state.lastStep, "explore");
  assert.equal(state.tier, "M");
  assert.equal(state.track, "product");
  assert.equal(state.prUrl, "https://github.com/acme/demo/pull/7");
  assert.equal(state.worktreeBranch, "feat/daemon-add-widgets");
  assert.equal(state.complete, false);
});

test("metadata keys are never read as steps, and a step this build does not know is kept", () => {
  // The engine stores per-step statuses as FLAT TOP-LEVEL KEYS beside its metadata, so the
  // reader separates them by exclusion. Both halves of that decision are pinned here: a
  // metadata field must not appear on the strip as a phantom step, and a step name from a
  // NEWER engine must survive - dropping it is the degradation the whole unknown-step rule
  // exists to prevent.
  const root = repo("metadata");
  const worktree = conductorWorktree(root, "mixed");
  mkdirSync(join(worktree, ".pipeline"), { recursive: true });
  writeFileSync(
    join(worktree, ".pipeline", "conduct-state.json"),
    JSON.stringify({
      feature_desc: "a description, which is not a step",
      bootstrap_mode: "new",
      run_started_at: 1_700_000_000_000,
      artifact_approvals: { "docs/plan.md": { sha256: "abc", approved_at: "2026-01-01" } },
      build: "done",
      a_step_from_the_future: "in_progress",
    }),
  );

  const state = readConductState(worktree);
  assert.equal(state.steps.get("build"), "done");
  assert.equal(state.steps.get("a_step_from_the_future"), "in_progress");
  for (const key of ["feature_desc", "bootstrap_mode", "run_started_at", "artifact_approvals"]) {
    assert.equal(state.steps.has(key), false, `${key} is metadata, not a step`);
  }
});

test("a status word this build does not know is dropped rather than guessed at", () => {
  const root = repo("unknown-status");
  const worktree = conductorWorktree(root, "odd");
  mkdirSync(join(worktree, ".pipeline"), { recursive: true });
  writeFileSync(
    join(worktree, ".pipeline", "conduct-state.json"),
    JSON.stringify({ build: "quantum", plan: "done" }),
  );
  const state = readConductState(worktree);
  assert.equal(state.steps.has("build"), false);
  assert.equal(state.steps.get("plan"), "done");
});

test("missing, empty, truncated and wrong-shaped state files all degrade without throwing", () => {
  const root = repo("degraded");
  const missing = conductorWorktree(root, "missing");
  assert.equal(readConductState(missing).read, false);
  assert.equal(readConductState(missing).steps.size, 0);

  for (const [slug, body] of [
    ["empty", ""],
    ["truncated", '{"build": "do'],
    ["array", "[1, 2, 3]"],
    ["scalar", '"not an object"'],
    ["null", "null"],
  ] as const) {
    const worktree = conductorWorktree(root, slug);
    mkdirSync(join(worktree, ".pipeline"), { recursive: true });
    writeFileSync(join(worktree, ".pipeline", "conduct-state.json"), body);
    const state = readConductState(worktree);
    assert.equal(state.read, false, `${slug} should not read as a state file`);
    assert.equal(state.steps.size, 0);
    assert.equal(state.tier, null);
  }
});

// ---- gates/<step>.json ----------------------------------------------------------------

test("gate verdicts carry their reason, their kickback, and whether they are a skip", () => {
  const root = repo("gates");
  const worktree = seedConductorRun(root, "gated", {
    gates: {
      plan: { satisfied: true, reason: "plan approved" },
      // The engine writes a SKIPPED step as satisfied with a `skipped: ` reason, so a
      // surface reading `satisfied` alone would draw a tier-S run as having passed nine
      // gates it never ran.
      conflict_check: { satisfied: true, reason: "skipped: tier S" },
      build_review: { satisfied: false, reason: "two findings", kickbackFrom: "build" },
    },
  });

  const verdicts = new Map(readGateVerdicts(worktree).map((v) => [v.step, v]));
  assert.equal(verdicts.get("plan")?.satisfied, true);
  assert.equal(verdicts.get("plan")?.skipped, false);
  assert.equal(verdicts.get("conflict_check")?.skipped, true);
  assert.equal(verdicts.get("build_review")?.satisfied, false);
  assert.equal(verdicts.get("build_review")?.kickbackFrom, "build");
});

test("a verdict caught mid-write is skipped, not defaulted in either direction", () => {
  // `satisfied` is the one field the gate exists to answer, so a file without a boolean
  // there is not a verdict. Defaulting it true would report a gate as passed; defaulting it
  // false would report a passing run as blocked. Both are inventions.
  const root = repo("gate-midwrite");
  const worktree = seedConductorRun(root, "half", { gates: { plan: { satisfied: true } } });
  writeFileSync(join(worktree, ".pipeline", "gates", "half.json"), '{"satisf');
  writeFileSync(join(worktree, ".pipeline", "gates", "nobool.json"), '{"satisfied": "yes"}');
  const steps = readGateVerdicts(worktree).map((v) => v.step);
  assert.deepEqual(steps, ["plan"]);
});

test("a worktree with no gates directory reads as no verdicts", () => {
  const root = repo("no-gates");
  const worktree = seedConductorRun(root, "bare", {});
  assert.deepEqual(readGateVerdicts(worktree), []);
});

// ---- HALT / HALT.class / DONE -----------------------------------------------------------

test("a halt reads its first non-empty line and its class", () => {
  const root = repo("halt");
  const worktree = seedConductorRun(root, "stuck", {
    halt: "\n\nthe PRD audit found an unaligned requirement\nmore detail nobody reads on a chip",
    haltClass: "needs-human",
  });
  const halt = readHalt(worktree);
  assert.equal(halt?.class, "needs-human");
  assert.equal(halt?.reason, "the PRD audit found an unaligned requirement");
});

test("a halt with no class, or an unrecognised one, is unclassified rather than guessed", () => {
  const root = repo("halt-class");
  const bare = seedConductorRun(root, "bare-halt", { halt: "something went wrong" });
  assert.equal(readHalt(bare)?.class, "unclassified");

  const odd = seedConductorRun(root, "odd-halt", {
    halt: "something went wrong",
    haltClass: "a-class-from-the-future",
  });
  assert.equal(readHalt(odd)?.class, "unclassified");

  // And one this build DOES know, so the assertions above are not passing for the wrong
  // reason - `unclassified` has to be the answer to an unreadable class, not to every class.
  const known = seedConductorRun(root, "known-halt", {
    halt: "a protected artifact changed",
    haltClass: "protected-artifact",
  });
  assert.equal(readHalt(known)?.class, "protected-artifact");
});

test("a run with no halt marker has no halt, and DONE is read as a marker", () => {
  const root = repo("markers");
  const running = seedConductorRun(root, "running", {});
  assert.equal(readHalt(running), null);
  assert.equal(readDone(running), false);

  const finished = seedConductorRun(root, "finished", { done: true });
  assert.equal(readDone(finished), true);
});

// ---- .daemon/ -----------------------------------------------------------------------------

test("the daemon directory is read at the REPOSITORY root, once, for every slug", () => {
  // The engine resolves `.daemon/` against the main checkout, so one park and grant
  // namespace is shared by every feature. A reader that looked inside a worktree would find
  // nothing and report every run as unparked - which is a wrong answer that looks healthy.
  const root = repo("daemon");
  seedConductorRun(root, "one", {});
  seedConductorRun(root, "two", {});
  seedConductorDaemon(root, {
    pid: process.pid,
    parked: ["two"],
    granted: ["one"],
    processed: { one: { prUrl: "https://github.com/acme/demo/pull/3" } },
  });

  const daemon = readDaemon(root);
  assert.equal(daemon.pid, process.pid);
  assert.equal(daemon.paused, false);
  assert.equal(daemon.parked.has("two"), true);
  assert.equal(daemon.parked.has("one"), false);
  assert.equal(daemon.granted.has("one"), true);
  assert.equal(daemon.processed.get("one")?.prUrl, "https://github.com/acme/demo/pull/3");
});

test("a pidfile whose process is gone reads as stopped, not running", () => {
  // The pidfile outlives the process it names, so its presence proves nothing. A crashed
  // engine daemon reported as running is exactly the state that makes an operator wait for
  // a step that will never start.
  const root = repo("dead-pid");
  // 2^22 is above every default `pid_max` on Linux and macOS, so nothing can hold it.
  seedConductorDaemon(root, { pid: 4_194_304 });
  assert.equal(readDaemon(root).pid, null);
});

test("PAUSED is read from its existence, and a missing .daemon reads as an empty one", () => {
  const paused = repo("paused");
  seedConductorDaemon(paused, { pid: process.pid, paused: true });
  assert.equal(readDaemon(paused).paused, true);

  const none = repo("no-daemon-dir");
  const daemon = readDaemon(none);
  assert.equal(daemon.pid, null);
  assert.equal(daemon.paused, false);
  assert.equal(daemon.parked.size, 0);
  assert.equal(daemon.processed.size, 0);
});

// ---- worktree enumeration -------------------------------------------------------------

test("only directories holding a .pipeline are runs, and the slug is the directory name", () => {
  // The engine cuts spec-authoring (`engineer-<slug>`) and autoresolve (`resolve-<slug>`)
  // worktrees in the same place, and neither is a pipeline run. Without the `.pipeline`
  // test they would each appear as a run with no steps and no state - a permanent empty row.
  const root = repo("enumerate");
  seedConductorRun(root, "beta", {});
  seedConductorRun(root, "alpha", {});
  mkdirSync(join(root, ".worktrees", "engineer-something"), { recursive: true });

  assert.deepEqual(
    readWorktrees(root, ".worktrees")?.map((w) => w.slug),
    ["alpha", "beta"],
  );
});

test("a repository with no .worktrees reads as no runs, and an unlistable one as null", () => {
  // The one reader where empty and null are expensively different. Empty means the engine is
  // driving nothing here, and the caller retires everything it was projecting; null means we
  // could not look, and the same response would delete a whole projection over a transient
  // permission error. Absent must be the first of those, not the second.
  assert.deepEqual(readWorktrees(repo("no-worktrees"), ".worktrees"), []);

  // A `.worktrees` that is a FILE cannot be listed, and is not an empty directory.
  const broken = repo("unlistable-worktrees");
  writeFileSync(join(broken, ".worktrees"), "not a directory");
  assert.equal(readWorktrees(broken, ".worktrees"), null);
});

// ---- the events tail ---------------------------------------------------------------------

test("the tail resumes at the byte it stopped at, across what would be a restart", () => {
  const root = repo("tail");
  const worktree = seedConductorRun(root, "tailed", {
    events: [{ type: "step_started", step: "build", index: 12 }],
  });
  const first = tailConductorEvents(worktree, 0);
  assert.equal(first.records.length, 1);
  assert.equal(first.records[0]?.type, "step_started");
  assert.equal(first.restarted, false);

  // A second pass from the same offset sees nothing, which is what makes the offset worth
  // persisting at all.
  assert.deepEqual(tailConductorEvents(worktree, first.offset).records, []);

  appendFileSync(
    join(worktree, ".pipeline", "events.jsonl"),
    `${JSON.stringify({ type: "step_completed", step: "build", status: "done" })}\n`,
  );
  // The stored offset is all a fresh process needs - this is the restart case.
  const resumed = tailConductorEvents(worktree, first.offset);
  assert.equal(resumed.records.length, 1);
  assert.equal(resumed.records[0]?.type, "step_completed");
  assert.equal(resumed.records[0]?.offset, first.offset);
});

test("a partial last line is not consumed, and is read whole on the next pass", () => {
  const root = repo("tail-partial");
  const worktree = seedConductorRun(root, "partial", {
    events: [{ type: "step_started", step: "plan" }],
  });
  const path = join(worktree, ".pipeline", "events.jsonl");
  const complete = tailConductorEvents(worktree, 0);
  assert.equal(complete.records.length, 1);

  // A writer caught between the append and its flush.
  appendFileSync(path, '{"type":"step_comp');
  const midWrite = tailConductorEvents(worktree, complete.offset);
  assert.deepEqual(midWrite.records, []);
  assert.equal(midWrite.offset, complete.offset, "a fragment must not advance the offset");

  appendFileSync(path, 'leted","step":"plan","status":"done"}\n');
  const settled = tailConductorEvents(worktree, midWrite.offset);
  assert.equal(settled.records.length, 1);
  assert.equal(settled.records[0]?.type, "step_completed");
});

test("a ledger shorter than the stored offset restarts at zero rather than reading garbage", () => {
  // The file is append-only and never rotated, but a worktree can be torn down and re-cut
  // under the same slug - which produces a shorter file under a stored offset, and a reader
  // that trusted the offset would resume in the middle of a line for ever.
  const root = repo("tail-rewritten");
  const worktree = seedConductorRun(root, "recut", {
    events: [
      { type: "step_started", step: "build" },
      { type: "step_completed", step: "build", status: "done" },
    ],
  });
  const first = tailConductorEvents(worktree, 0);
  assert.equal(first.records.length, 2);

  writeFileSync(
    join(worktree, ".pipeline", "events.jsonl"),
    `${JSON.stringify({ type: "step_started", step: "worktree" })}\n`,
  );
  const restarted = tailConductorEvents(worktree, first.offset);
  assert.equal(restarted.restarted, true);
  assert.equal(restarted.records.length, 1);
  assert.equal(restarted.records[0]?.body.step, "worktree");
});

test("an unparseable line is dropped without stopping the pass or losing the offset", () => {
  const root = repo("tail-garbage");
  const worktree = seedConductorRun(root, "garbled", {});
  const path = join(worktree, ".pipeline", "events.jsonl");
  writeFileSync(
    path,
    ["not json at all", JSON.stringify({ type: "step_started", step: "plan" }), "[1,2,3]", ""].join(
      "\n",
    ),
  );
  const reading = tailConductorEvents(worktree, 0);
  assert.deepEqual(
    reading.records.map((r) => r.type),
    ["step_started"],
  );
});

test("the record cap holds the offset at the first record it declined to read", () => {
  // The cap bounds how much ONE pass does; it must not skip work. An offset that advanced to
  // the end of the chunk would leave every record past the cap unread for ever - and their
  // token usage permanently absent from the run's cost, which is a number an operator reads.
  const root = repo("tail-capped");
  const worktree = seedConductorRun(root, "busy", {});
  const path = join(worktree, ".pipeline", "events.jsonl");
  const total = 5200; // above MAX_TAIL_RECORDS
  writeFileSync(
    path,
    `${Array.from({ length: total }, (_, i) =>
      JSON.stringify({ type: "step_completed", step: `s${i}`, tokenUsage: { input: 1 } }),
    ).join("\n")}\n`,
  );

  const first = tailConductorEvents(worktree, 0);
  assert.equal(first.records.length, 5000, "the cap bounds one pass");
  // The offset is the START of the first record it did not read, so nothing is skipped.
  assert.equal(
    first.offset,
    first.records.at(-1)!.offset +
      Buffer.byteLength(
        JSON.stringify({ type: "step_completed", step: "s4999", tokenUsage: { input: 1 } }),
        "utf8",
      ) +
      1,
  );

  // And the rest arrives on the next pass rather than being lost.
  const second = tailConductorEvents(worktree, first.offset);
  assert.equal(second.records.length, total - 5000);
  assert.equal(second.records[0]?.body.step, "s5000");
  // Every record, exactly once, across the two passes.
  assert.equal(
    (tokensIn(first.records) ?? 0) + (tokensIn(second.records) ?? 0),
    total,
    "no record is read twice and none is skipped",
  );
});

test("a missing ledger is an empty pass at the offset it was handed", () => {
  const root = repo("tail-missing");
  const worktree = seedConductorRun(root, "silent", {});
  const reading = tailConductorEvents(worktree, 128);
  assert.deepEqual(reading.records, []);
  assert.equal(reading.offset, 128);
});

test("token totals sum every numeric leaf, and stay null when nothing reported any", () => {
  // Summed rather than named field by field, because the engine's usage shape varies by
  // provider - a reader that named `input`/`output` would silently under-count a third one.
  assert.equal(
    tokensIn([
      { type: "step_completed", ts: null, offset: 0, body: { tokenUsage: { input: 10, output: 5 } } },
      { type: "step_completed", ts: null, offset: 1, body: { tokenUsage: { input: 2, cacheRead: 3 } } },
    ]),
    20,
  );
  // Null, not zero: a run whose ledger has not reached a completion has an UNKNOWN spend,
  // and a chip reading `0 tokens` would be a claim nobody made.
  assert.equal(tokensIn([{ type: "step_started", ts: null, offset: 0, body: {} }]), null);
  assert.equal(tokensIn([]), null);
});
