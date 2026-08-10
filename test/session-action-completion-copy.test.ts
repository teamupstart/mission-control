import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import {
  SESSION_ACTION_COMPLETION_CAPABILITIES,
  SESSION_ACTION_COMPLETION_KINDS,
  sessionActionCompletionLabel,
} from "../src/shared/workflow.ts";

// What a completion PROVES, as every surface says it - and the one shape that cannot say it.
//
// `SESSION_ACTION_COMPLETION_KINDS` is append-only, so the failure mode here is not a surface
// going out of date. It is a two-armed `kind === "pull_request" ? … : …` whose `else` ABSORBS
// the new kind and states the wrong proof confidently: a `repo_commit` action captioned as one
// that finishes with the turn reads as complete while it sits waiting for a commit. Silence
// would be better; a confident wrong sentence is what these tests exist to prevent.

test("every completion kind has its own sentence, and none falls back to the wire spelling", () => {
  const labels = SESSION_ACTION_COMPLETION_KINDS.map((kind) => sessionActionCompletionLabel({ kind }));
  assert.equal(new Set(labels).size, labels.length, "two kinds would print the same promise");
  for (const [index, kind] of SESSION_ACTION_COMPLETION_KINDS.entries()) {
    const label = labels[index]!;
    // The fallback arm returns the wire spelling. It exists for a daemon a version ahead, and
    // reaching it for a kind THIS build ships means a capability entry was forgotten.
    assert.notEqual(label, kind, `${kind} has no capability label of its own`);
    assert.equal(label, SESSION_ACTION_COMPLETION_CAPABILITIES[kind].label);
  }
});

test("the derived sentence reads as a clause every surface can embed", () => {
  for (const kind of SESSION_ACTION_COMPLETION_KINDS) {
    const clause = `Completes when ${sessionActionCompletionLabel({ kind }).toLocaleLowerCase("en-US")}`;
    assert.match(clause, /^Completes when \S/);
    assert.ok(!clause.endsWith("."), "the surfaces punctuate this, so the clause must not");
  }
});

/**
 * The guard the round-2 finding earned.
 *
 * Three surfaces - the graph rail, the canvas node subtitle and the version-history snapshot
 * line - each carried their own two-armed ternary, and widening the tuple to `repo_commit` made
 * all three lie at once. Nothing failed: a ternary that grows a wrong arm still compiles and
 * still renders. A scan is the only thing that catches the shape itself, so the next adapter
 * cannot reintroduce it one file at a time.
 *
 * Scoped to the browser surface, because that is where this sentence is PRINTED. The server's
 * adapter registry legitimately branches on the kind - exhaustively, through a `Record` the
 * compiler checks - and `session-action-adapters.ts` is where that belongs.
 */
test("no browser surface re-derives the completion sentence from a two-armed test", () => {
  const root = join(process.cwd(), "src", "web");
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (![".ts", ".tsx"].includes(extname(entry.name))) continue;
      const text = readFileSync(path, "utf8");
      // Any equality test against a single completion kind, in either direction. A surface
      // that needs to know "is this the pull request one" for a REASON other than printing
      // its promise does not exist today; if one ever does, it should say so here rather than
      // be waved through by a looser pattern.
      if (/completion\.kind\s*[=!]==\s*"/.test(text)) {
        offenders.push(relative(process.cwd(), path));
      }
    }
  };
  walk(root);
  assert.deepEqual(
    offenders,
    [],
    "these surfaces must call sessionActionCompletionLabel instead of branching on the kind: "
      + offenders.join(", "),
  );
});
