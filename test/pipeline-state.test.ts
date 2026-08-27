import { after, test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MAX_RUNS_PER_REPO,
  readConductState,
  readDaemon,
  readDone,
  readGateVerdicts,
  readHalt,
  readShippedCost,
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

test("a refused step is retained as refused rather than disappearing", () => {
  const root = repo("refused-status");
  const worktree = seedConductorRun(root, "refused", {
    steps: { build: "done", architecture_review_as_built: "refused" },
    lastStep: "architecture_review_as_built",
  });

  const state = readConductState(worktree);
  assert.equal(state.steps.get("architecture_review_as_built"), "refused");
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

  const planGap = seedConductorRun(root, "plan-gap", {
    halt: "the approved plan cannot deliver the stated outcome",
    haltClass: "plan-gap",
  });
  assert.equal(readHalt(planGap)?.class, "plan-gap");
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

  const listing = readWorktrees(root, ".worktrees");
  assert.deepEqual(
    listing?.worktrees.map((w) => w.slug),
    ["alpha", "beta"],
  );
  // Two pipelines and a non-pipeline directory is not a truncated read, and saying it was
  // would stop the caller retiring stale runs in this repository.
  assert.equal(listing?.truncated, false);
});

test("sitting exactly at the cap is not a truncated read; one over it is", () => {
  // `truncated` is what makes the caller call a pass incomplete, and an incomplete pass
  // stops retiring runs whose worktrees are gone. Inferred from `worktrees.length >= cap`
  // it cannot tell "cut off" from "exactly at it", so a repository holding precisely 200
  // pipelines would have stopped pruning permanently while reporting a truncation that
  // never happened.
  const pipelines = (root: string, count: number): void => {
    for (let i = 0; i < count; i++) {
      // Zero-padded so readdir's sort order is the numeric one and `n` names the entry
      // actually dropped rather than whichever sorted last.
      mkdirSync(join(root, ".worktrees", `feat-${String(i).padStart(4, "0")}`, ".pipeline"), {
        recursive: true,
      });
    }
  };

  const atCap = repo("worktrees-at-cap");
  pipelines(atCap, MAX_RUNS_PER_REPO);
  const at = readWorktrees(atCap, ".worktrees");
  assert.equal(at?.worktrees.length, MAX_RUNS_PER_REPO);
  assert.equal(at?.truncated, false);

  const overCap = repo("worktrees-over-cap");
  pipelines(overCap, MAX_RUNS_PER_REPO + 1);
  const over = readWorktrees(overCap, ".worktrees");
  assert.equal(over?.worktrees.length, MAX_RUNS_PER_REPO);
  assert.equal(over?.truncated, true);

  // And directories that are not pipelines never count toward the cap, however many the
  // engine has cut beside them - so its spec-authoring worktrees cannot manufacture one.
  const mixed = repo("worktrees-mixed-at-cap");
  pipelines(mixed, MAX_RUNS_PER_REPO);
  for (let i = 0; i < 20; i++) {
    mkdirSync(join(mixed, ".worktrees", `engineer-${i}`), { recursive: true });
  }
  const both = readWorktrees(mixed, ".worktrees");
  assert.equal(both?.worktrees.length, MAX_RUNS_PER_REPO);
  assert.equal(both?.truncated, false);
});

test("a repository with no .worktrees reads as no runs, and an unlistable one as null", () => {
  // The one reader where empty and null are expensively different. Empty means the engine is
  // driving nothing here, and the caller retires everything it was projecting; null means we
  // could not look, and the same response would delete a whole projection over a transient
  // permission error. Absent must be the first of those, not the second.
  assert.deepEqual(readWorktrees(repo("no-worktrees"), ".worktrees"), {
    worktrees: [],
    truncated: false,
  });

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

test("the cap resumes at a real record, never at a line it is committed to dropping", () => {
  // The cap is checked after the parse, so a malformed line sitting exactly on the boundary
  // is consumed rather than becoming the resume point. A boundary on a dropped line is not
  // fatal - the next pass consumes it and moves on, which a probe confirmed - but it is a
  // resume point that has to be re-read and re-dropped, and an offset that points at
  // something no pass will ever return is the wrong thing to persist.
  const root = repo("tail-cap-garbage");
  const worktree = seedConductorRun(root, "mixed", {});
  const valid = (i: number) =>
    JSON.stringify({ type: "step_completed", step: `s${i}`, tokenUsage: { input: 1 } });
  writeFileSync(
    join(worktree, ".pipeline", "events.jsonl"),
    `${[
      ...Array.from({ length: 5000 }, (_, i) => valid(i)),
      "{not json at all",
      ...Array.from({ length: 10 }, (_, i) => valid(5000 + i)),
    ].join("\n")}\n`,
  );

  const first = tailConductorEvents(worktree, 0);
  assert.equal(first.records.length, 5000);
  // The resume point is the first VALID record past the cap - the malformed line before it
  // was consumed by this pass.
  const second = tailConductorEvents(worktree, first.offset);
  assert.equal(second.records.length, 10);
  assert.equal(second.records[0]?.offset, first.offset, "the offset names a real record");
  assert.equal(second.records[0]?.body.step, "s5000");
  // Every valid record exactly once across the two passes, and the malformed one dropped.
  assert.equal((tokensIn(first.records) ?? 0) + (tokensIn(second.records) ?? 0), 5010);
});

test("a missing ledger is an empty pass at the offset it was handed", () => {
  const root = repo("tail-missing");
  const worktree = seedConductorRun(root, "silent", {});
  const reading = tailConductorEvents(worktree, 128);
  assert.deepEqual(reading.records, []);
  assert.equal(reading.offset, 128);
});

test("a replacement is detected even when the filesystem hands back the same inode", () => {
  // The case CI caught and macOS could not: Linux reuses an inode number when a file is
  // deleted and another is created immediately, so `dev:ino` reported the replacement as the
  // same file and the whole check silently did nothing there. The identity is anchored in
  // the ledger's HEAD instead, which an append never changes and a different run's ledger
  // always does.
  //
  // Simulated rather than waited for, so this holds on any filesystem: the identity is asked
  // for the SAME file at the same size with different content, which is exactly what an
  // inode-reusing recreate looks like to `stat`.
  const root = repo("tail-identity");
  const worktree = seedConductorRun(root, "feat", {});
  const path = join(worktree, ".pipeline", "events.jsonl");
  const line = (step: string, tokens: number) =>
    `${JSON.stringify({ type: "step_completed", step, tokenUsage: { input: tokens } })}\n`;

  writeFileSync(path, line("aaaa", 700));
  const first = tailConductorEvents(worktree, 0, null);
  assert.equal(first.records.length, 1);
  assert.ok(first.identity.length > 0, "a readable ledger always has an identity");

  // An APPEND must not look like a replacement, or every tick would re-read the whole file.
  appendFileSync(path, line("bbbb", 1));
  const appended = tailConductorEvents(worktree, first.offset, first.identity);
  assert.equal(appended.restarted, false, "an append is not a replacement");
  assert.equal(appended.identity, first.identity, "the head is unchanged, so the identity is");
  assert.equal(appended.records.length, 1);

  // A different ledger of the same length at the same path IS one, whatever the inode says.
  writeFileSync(path, line("cccc", 701));
  const replaced = tailConductorEvents(worktree, appended.offset, appended.identity);
  assert.equal(replaced.restarted, true, "a different head is a different ledger");
  assert.notEqual(replaced.identity, first.identity);
  assert.equal(replaced.records.length, 1, "and it is read from the start");
  assert.equal(replaced.records[0]?.body.step, "cccc");
});

test("a stored offset with no recorded identity is rebuilt, not resumed", () => {
  // The upgrade case. A row written before identities were recorded carries an offset and an
  // empty identity, and there is no way to tell that cursor from one pointing into a ledger
  // that has since been replaced by an equal-or-larger file - so it is not trusted. The pass
  // restarts at zero and recomputes from the whole ledger, which costs one extra read per
  // projected run, once, and cannot silently resume in the middle of a different file.
  const root = repo("tail-unverifiable");
  const worktree = seedConductorRun(root, "feat", {
    events: [
      { type: "step_completed", step: "a", tokenUsage: { input: 5 } },
      { type: "step_completed", step: "b", tokenUsage: { input: 7 } },
    ],
  });

  const whole = tailConductorEvents(worktree, 0, null);
  assert.equal(whole.records.length, 2);

  // An offset past zero with no identity beside it: unverifiable, so read it all again.
  const upgraded = tailConductorEvents(worktree, whole.offset, "");
  assert.equal(upgraded.restarted, true, "an uncheckable cursor is not a cursor");
  assert.equal(upgraded.records.length, 2, "and the whole ledger is re-read");
  assert.equal(tokensIn(upgraded.records), 12, "so the total is recomputed, not lost");

  // Offset ZERO with no identity is not unverifiable - there is nothing to verify, and a
  // first pass must not be reported as a restart or every new run would claim to be one.
  const fresh = tailConductorEvents(worktree, 0, "");
  assert.equal(fresh.restarted, false);

  // And once an identity IS recorded, an append resumes normally rather than re-reading.
  appendFileSync(
    join(worktree, ".pipeline", "events.jsonl"),
    `${JSON.stringify({ type: "step_completed", step: "c", tokenUsage: { input: 1 } })}\n`,
  );
  const resumed = tailConductorEvents(worktree, upgraded.offset, upgraded.identity);
  assert.equal(resumed.restarted, false);
  assert.equal(resumed.records.length, 1);
});

test("token totals add the five tiers, and stay null when nothing reported any", () => {
  // Named tiers rather than every numeric leaf. Each tier is exercised, so a table that
  // dropped one is a failure here rather than a chip that is quietly low.
  assert.equal(
    tokensIn([
      { type: "step_completed", ts: null, offset: 0, body: { tokenUsage: { input: 10, output: 5 } } },
      {
        type: "step_completed",
        ts: null,
        offset: 1,
        body: { tokenUsage: { input: 2, cacheRead: 3, cacheCreation: 4, reasoningOutput: 6 } },
      },
    ]),
    30,
  );
  // Null, not zero: a run whose ledger has not reached a completion has an UNKNOWN spend,
  // and a chip reading `0 tokens` would be a claim nobody made.
  assert.equal(tokensIn([{ type: "step_started", ts: null, offset: 0, body: {} }]), null);
  assert.equal(tokensIn([]), null);
});

test("a dollar figure and a duration in the usage object are not tokens", () => {
  // The engine's `TokenUsage` carries `costUsd`, `numTurns` and `durationMs` in the same
  // object as its tiers. Summing every numeric leaf - which this reader used to do - turned a
  // two-minute step into 120,000 tokens.
  assert.equal(
    tokensIn([
      {
        type: "step_completed",
        ts: null,
        offset: 0,
        body: {
          tokenUsage: { input: 10, output: 5, costUsd: 0.42, numTurns: 3, durationMs: 120_000 },
        },
      },
    ]),
    15,
  );
  // A tier this build has never heard of is ignored rather than absorbed, for the same
  // reason: nobody has said whether it is tokens.
  assert.equal(
    tokensIn([
      { type: "step_completed", ts: null, offset: 0, body: { tokenUsage: { input: 4, quantumTokens: 900 } } },
    ]),
    4,
  );
});

test("one dispatch reported twice is counted once", () => {
  // The engine emits the attempt that ran a dispatch AND the completion of the step it
  // satisfied, both carrying the same `tokenUsage`. Its own rollup skips the completion when
  // an attempt covered it; this reader is incremental, so it uses the completion's
  // `actualProvider` as the stateless equivalent of that skip.
  const attempt = {
    type: "provider_attempt",
    ts: null,
    offset: 0,
    body: { invoked: true, step: "build", tokenUsage: { input: 100, output: 50 } },
  } as const;
  const completion = {
    type: "step_completed",
    ts: null,
    offset: 1,
    body: { step: "build", actualProvider: "claude", tokenUsage: { input: 100, output: 50 } },
  } as const;
  assert.equal(tokensIn([attempt, completion]), 150, "the pair is one dispatch, not two");
  // And the halves count on their own: an attempt that landed in an earlier pass than its
  // completion must not go missing, and a completion with no provider named is a step the
  // attempt path never reported.
  assert.equal(tokensIn([attempt]), 150);
  assert.equal(
    tokensIn([
      { type: "step_completed", ts: null, offset: 0, body: { tokenUsage: { input: 7 } } },
    ]),
    7,
  );
  // An attempt the engine recorded but never invoked spent nothing.
  assert.equal(
    tokensIn([
      {
        type: "provider_attempt",
        ts: null,
        offset: 0,
        body: { invoked: false, tokenUsage: { input: 100 } },
      },
    ]),
    null,
  );
});

// ---- .docs/shipped/<slug>.md, the engine's own cost record ------------------------------

test("a shipped record yields the engine's own figures, and skips what is not one", () => {
  const root = repo("shipped");
  const worktree = seedConductorRun(root, "feat", {
    steps: { finish: "done" },
    done: true,
    shipped: {
      input: 1200,
      output: 340,
      cacheRead: 90,
      cacheWrite: 10,
      costUsd: 0.421,
      dispatches: 6,
    },
  });
  const cost = readShippedCost(worktree, "feat");
  assert.equal(cost?.input, 1200);
  assert.equal(cost?.output, 340);
  assert.equal(cost?.cacheRead, 90);
  assert.equal(cost?.cacheWrite, 10);
  assert.equal(cost?.costUsd, 0.421);
  assert.equal(cost?.dispatches, 6);
  // Both completeness counters, which together decide whether the dollar figure may be
  // presented as a total at all.
  assert.equal(cost?.unmetered, 0);
  assert.equal(cost?.costUnmetered, 0);
  // The record's own mtime, so a feature that shipped yesterday lands in yesterday's window
  // rather than in the window of whichever restart happened to read it.
  assert.ok((cost?.writtenAt ?? 0) > 0);
  assert.ok((cost?.writtenAt ?? 0) <= Date.now() + 1000);
});

test("the cost block stops at the next heading, and ignores the per-provider breakdown", () => {
  // Two ways a naive parser reads a number that is not a cost. The fixture writes an
  // INDENTED provider line inside the block and an `input:` line in the `## Time` section
  // after it; both are in the engine's own rendering, and neither is this feature's cost.
  const root = repo("shipped-bounds");
  const worktree = seedConductorRun(root, "feat", {
    steps: { finish: "done" },
    shipped: { input: 5, output: 7 },
  });
  const cost = readShippedCost(worktree, "feat");
  assert.equal(cost?.input, 5, "not the provider breakdown's 1, and not the ## Time section's");
  assert.equal(cost?.output, 7);
});

test("an unpriced or partly-metered feature says so rather than rounding it away", () => {
  const root = repo("shipped-partial");
  const worktree = seedConductorRun(root, "feat", {
    steps: { finish: "done" },
    shipped: { input: 100, output: 50, costUsd: 0.02, unmetered: 2, costUnmetered: 3 },
  });
  const cost = readShippedCost(worktree, "feat");
  // The counts survive as counts. Whether they make the dollars unpriced is the caller's
  // decision - see `usageFrom` - but a reader that dropped them would take the evidence away.
  assert.equal(cost?.unmetered, 2);
  assert.equal(cost?.costUnmetered, 3);
  assert.equal(cost?.costUsd, 0.02);
});

test("a record with no price line reports no price, rather than a price of zero", () => {
  // The one field where absent and zero are different claims. An engine release that predates
  // the line, or a rollup that could price nothing, writes real token counts and no
  // `cost_usd` - and a reader that defaulted it to 0 would hand the ledger an exact $0.00 for
  // work that certainly cost something. Every other missing line is a COUNT, where the same
  // default is the honest reading, so those stay at zero here.
  const root = repo("shipped-priceless");
  const worktree = seedConductorRun(root, "feat", {
    steps: { finish: "done" },
    done: true,
    shipped: { input: 900, output: 120, costUsd: null },
  });
  const cost = readShippedCost(worktree, "feat");
  assert.equal(cost?.costUsd, null);
  assert.equal(cost?.input, 900, "the tokens are real and stay");
  assert.equal(cost?.output, 120);
  assert.equal(cost?.cacheRead, 0);
  assert.equal(cost?.unmetered, 0);

  // A price line that does not parse is the same answer: `-1`, an empty value and a word are
  // all "this record does not tell us what it cost".
  const dir = join(worktree, ".docs", "shipped");
  for (const raw of ["nonsense", "", "-1"]) {
    writeFileSync(join(dir, "feat.md"), `# feat\n\n## Cost\n\ninput: 4\noutput: 2\ncost_usd: ${raw}\n`);
    assert.equal(readShippedCost(worktree, "feat")?.costUsd, null, raw);
  }
  // And a price that IS there survives all of that, including an explicit zero - which is a
  // claim the engine is entitled to make.
  writeFileSync(join(dir, "feat.md"), "# feat\n\n## Cost\n\ninput: 4\noutput: 2\ncost_usd: 0\n");
  assert.equal(readShippedCost(worktree, "feat")?.costUsd, 0);
});

test("no record, no cost block, and an unreadable one are all just null", () => {
  const root = repo("shipped-absent");
  const worktree = seedConductorRun(root, "feat", { steps: { build: "in_progress" } });
  assert.equal(readShippedCost(worktree, "feat"), null, "a feature that has not shipped");

  // The engine writes the record without a cost block when its own rollup failed.
  const dir = join(worktree, ".docs", "shipped");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "feat.md"), "# feat\n\n## Time\n\nwall_ms: 12\n");
  assert.equal(readShippedCost(worktree, "feat"), null, "a record with no cost block");

  // A block whose two required figures are missing is not a cost reading, whatever else it
  // carries: a row of zeroes entering the spend ledger would be a claim nobody made.
  writeFileSync(join(dir, "feat.md"), "# feat\n\n## Cost\n\ncost_usd: 0.10\n");
  assert.equal(readShippedCost(worktree, "feat"), null);
  writeFileSync(join(dir, "feat.md"), "# feat\n\n## Cost\n\ninput: nonsense\noutput: 4\n");
  assert.equal(readShippedCost(worktree, "feat"), null);

  // And a record belonging to another feature is not this feature's.
  assert.equal(readShippedCost(worktree, "other"), null);
});
