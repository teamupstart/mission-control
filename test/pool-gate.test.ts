/**
 * The two named predicates that answer "is the treehouse pool usable here?", and the
 * DELIBERATE difference between them.
 *
 * The gate has two halves - the binary is installed, and this repository committed a
 * `treehouse.toml` - and until now it existed exactly once, spelled inline at
 * `provisionWorktree`'s single call site. The Workflow check path needs the same answer and
 * therefore never asked it at all, which is the defect this pair closes.
 *
 * A check asks the BINARY half alone. That is a recorded decision, not an oversight, and it
 * is the reason `treehouseInstalled` exists as a name rather than only as the left operand of
 * a `&&`: `treehouse get` succeeds in a repository with no `treehouse.toml`, creating a pool
 * from its own defaults, so a check that asked the full gate would stop getting a pooled tree
 * in every such repository - a real behaviour change, and one that would silently answer a
 * design question (what counts as opting in?) that is filed separately on purpose.
 *
 * So the split is asserted here as a property, in both directions, and the case that pins it
 * says why. Someone who later "tidies" the check call site into the conjunction has to delete
 * an assertion that explains itself.
 *
 * Nothing here needs treehouse installed, and nothing here runs it. The binary-present arm
 * puts a stub on PATH, because `treehouseInstalled` asks the system resolver where the name
 * points and never spawns what it finds - so a stub is a complete answer to the only question
 * being asked, and the suite behaves identically on a developer's machine and on CI.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

// A fresh state dir BEFORE anything that resolves it is imported - static imports hoist above
// assignments, so every module below arrives through a dynamic import (see db-isolation.test.ts).
const home = realpathSync(mkdtempSync(join(tmpdir(), "mission-pool-gate-")));
process.env.HARNESS_HOME = home;

const { isTreehouseRepo, poolAvailableFor, treehouseInstalled } =
  await import("../src/server/pool.ts");
const { onPath } = await import("../src/server/util/exec.ts");

after(() => rmSync(home, { recursive: true, force: true }));

/** A repository root that opted in, and one that did not. The opt-in IS the file. */
function mkRepo(name: string, optIn: boolean): string {
  const repo = join(home, name);
  mkdirSync(repo, { recursive: true });
  if (optIn) writeFileSync(join(repo, "treehouse.toml"), "max_trees = 4\n");
  return repo;
}

const OPTED_IN = mkRepo("opted-in", true);
const NOT_OPTED_IN = mkRepo("not-opted-in", false);

/**
 * PATH with every directory that actually holds a `treehouse` removed - not a PATH emptied
 * down to a hand-built bin dir.
 *
 * `treehouseInstalled` resolves the name by spawning `which`, so a suite that stripped PATH
 * wholesale would fail for want of `which` and prove nothing about treehouse.
 */
function pathWithoutTreehouse(): string {
  return (process.env.PATH ?? "")
    .split(delimiter)
    .filter((dir) => dir && !existsSync(join(dir, "treehouse")))
    .join(delimiter);
}

/** A directory holding an executable named `treehouse` that does nothing at all. */
function stubBinDir(): string {
  const dir = join(home, "stub-bin");
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, "treehouse");
  writeFileSync(bin, "#!/bin/sh\nexit 0\n");
  // `which` reports a name only when it is executable, which is the whole reason this is a
  // real file with a mode rather than an empty one.
  chmodSync(bin, 0o755);
  return dir;
}

async function withTreehouse<T>(fn: () => Promise<T>): Promise<T> {
  const original = process.env.PATH;
  process.env.PATH = [stubBinDir(), pathWithoutTreehouse()].join(delimiter);
  try {
    assert.ok(onPath("treehouse"), "the stub must be reachable or this arm proves nothing");
    return await fn();
  } finally {
    process.env.PATH = original;
  }
}

async function withoutTreehouse<T>(fn: () => Promise<T>): Promise<T> {
  const original = process.env.PATH;
  process.env.PATH = pathWithoutTreehouse();
  try {
    // Stated out loud, because a suite that silently still had treehouse on PATH would pass
    // the assertions below for the wrong reason on a developer's machine.
    assert.equal(onPath("treehouse"), false, "this arm is about a machine with no treehouse");
    return await fn();
  } finally {
    process.env.PATH = original;
  }
}

// ---- the fixture says what it claims ---------------------------------------

test("the opt-in is the file, so the two fixture repositories differ in exactly one way", () => {
  assert.equal(isTreehouseRepo(OPTED_IN), true);
  assert.equal(isTreehouseRepo(NOT_OPTED_IN), false);
});

// ---- the binary half -------------------------------------------------------

test("the binary half is answered without a repository at all", async () => {
  // It takes no argument, and that is structural rather than incidental: there is no repo it
  // could consult, so it cannot accidentally grow the opt-in question later. With the binary
  // reachable it is true while the only repositories on disk include one that never opted in.
  await withTreehouse(async () => {
    assert.equal(await treehouseInstalled(), true);
  });
  await withoutTreehouse(async () => {
    assert.equal(await treehouseInstalled(), false);
  });
});

// ---- the full gate ---------------------------------------------------------

test("the full gate needs the binary AND the opt-in", async () => {
  await withTreehouse(async () => {
    assert.equal(await poolAvailableFor(OPTED_IN), true, "binary plus opt-in is the pool arm");
    assert.equal(await poolAvailableFor(NOT_OPTED_IN), false, "a repo that never opted in");
  });
});

test("no binary fails the full gate whatever the repository asked for", async () => {
  await withoutTreehouse(async () => {
    assert.equal(await poolAvailableFor(OPTED_IN), false);
    assert.equal(await poolAvailableFor(NOT_OPTED_IN), false);
  });
});

// ---- the adopted split, pinned on purpose ----------------------------------

test("the two predicates disagree for a repository that never opted in - deliberately", async () => {
  // THE CASE THAT PINS THE RECORDED DECISION, so it is worth being explicit about what it
  // protects. On this machine the binary is there and the repository has no `treehouse.toml`:
  //
  //   - dispatch (`poolAvailableFor`) takes a plain `git worktree`.
  //   - a check (`treehouseInstalled`) still takes a pooled tree, from a pool treehouse
  //     creates out of its own defaults.
  //
  // That difference is today's behaviour and it is preserved on purpose. Collapsing the check
  // path onto the conjunction would look like a tidy-up and would in fact decide the deferred
  // opt-in question - taking pooled trees away from every repository in this state - inside a
  // change whose whole claim is that it fixed a missing binary check and nothing else.
  await withTreehouse(async () => {
    assert.equal(await treehouseInstalled(), true, "the half a check asks");
    assert.equal(await poolAvailableFor(NOT_OPTED_IN), false, "the half dispatch adds");
  });

  // And where the halves agree, they agree: an absent binary is the one fact that refuses
  // both, which is what makes it the fact the check path was missing.
  await withoutTreehouse(async () => {
    assert.equal(await treehouseInstalled(), false);
    assert.equal(await poolAvailableFor(OPTED_IN), false);
  });
});
