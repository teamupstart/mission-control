// The hook installer bakes absolute paths into ~/.claude/settings.json, and Claude
// runs them on every hook event of every session on the machine. These tests pin the
// two preflights that keep those paths durable: the node binary must survive a
// version bump, and a transient pool checkout must be recognized for what it is.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { stableNodePath, transientCheckoutRoot } from "../hooks/install-checks.mjs";

/**
 * A scratch dir, realpath'd up front: macOS's tmpdir sits behind a symlink
 * (/var -> /private/var), and `stableNodePath` compares realpaths - fixtures reached
 * through that symlink would all read as aliases by accident.
 */
function withTempDir(fn: (dir: string) => void): void {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "install-checks-")));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A Homebrew-shaped layout: a versioned Cellar binary and a stable symlink to it. */
function brewLayout(dir: string): { cellar: string; bin: string } {
  const cellar = join(dir, "Cellar", "node", "25.9.0_1", "bin");
  const bin = join(dir, "bin");
  mkdirSync(cellar, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(cellar, "node"), "#!fake-binary\n");
  symlinkSync(join(cellar, "node"), join(bin, "node"), "file");
  return { cellar, bin };
}

// ---- stableNodePath ----

test("prefers a symlinked node over the versioned dir the binary lives in", () => {
  withTempDir((dir) => {
    const { cellar, bin } = brewLayout(dir);
    // The Cellar dir first, the way npm prepends dirname(process.execPath) to PATH.
    const path = [cellar, bin].join(delimiter);
    assert.equal(stableNodePath(join(cellar, "node"), path), join(bin, "node"));
  });
});

test("falls back to execPath when no alias to the same binary is on PATH", () => {
  withTempDir((dir) => {
    const { cellar } = brewLayout(dir);
    // Only the versioned dir itself: its own realpath, so no more durable than
    // execPath - answering it would only dress the same fragility up as a fix.
    assert.equal(stableNodePath(join(cellar, "node"), cellar), join(cellar, "node"));
    assert.equal(stableNodePath(join(cellar, "node"), ""), join(cellar, "node"));
  });
});

test("never picks a node that is not the running binary", () => {
  withTempDir((dir) => {
    const { cellar, bin } = brewLayout(dir);
    // A different install, and an alias to it, both ahead of ours on PATH. The hook
    // was proven against the runtime that ran the installer, not against whatever
    // else the machine has lying around.
    const other = join(dir, "other");
    const otherBin = join(dir, "other-bin");
    mkdirSync(other, { recursive: true });
    mkdirSync(otherBin, { recursive: true });
    writeFileSync(join(other, "node"), "#!different-binary\n");
    symlinkSync(join(other, "node"), join(otherBin, "node"), "file");
    const path = [other, otherBin, bin].join(delimiter);
    assert.equal(stableNodePath(join(cellar, "node"), path), join(bin, "node"));
    assert.equal(stableNodePath(join(cellar, "node"), [other, otherBin].join(delimiter)), join(cellar, "node"));
  });
});

test("answers execPath unchanged when it does not resolve at all", () => {
  withTempDir((dir) => {
    const { bin } = brewLayout(dir);
    const missing = join(dir, "gone", "node");
    assert.equal(stableNodePath(missing, bin), missing);
  });
});

test("ignores relative PATH entries", () => {
  withTempDir((dir) => {
    const { cellar } = brewLayout(dir);
    assert.equal(stableNodePath(join(cellar, "node"), ["bin", "."].join(delimiter)), join(cellar, "node"));
  });
});

// ---- transientCheckoutRoot ----

test("finds the pool root above a slot checkout", () => {
  withTempDir((dir) => {
    const pool = join(dir, "pool");
    const checkout = join(pool, "3", "repo", "hooks");
    mkdirSync(checkout, { recursive: true });
    writeFileSync(join(pool, "treehouse-state.json"), "{}\n");
    assert.deepEqual(transientCheckoutRoot(checkout), {
      root: pool,
      reason: "legacy Treehouse worktree pool",
    });
    // The marker beside you counts too - installing from the pool root itself is
    // no more durable than installing from a slot.
    assert.deepEqual(transientCheckoutRoot(pool), {
      root: pool,
      reason: "legacy Treehouse worktree pool",
    });
  });
});

test("answers null for a checkout with no pool above it", () => {
  withTempDir((dir) => {
    const checkout = join(dir, "workspace", "repo", "hooks");
    mkdirSync(checkout, { recursive: true });
    assert.equal(transientCheckoutRoot(checkout), null);
  });
});
