import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";

// Isolate the daemon's SQLite DB before anything reads config/db.
process.env.HARNESS_HOME = mkdtempSync(join(tmpdir(), "harness-pr-"));
const { Registry, prNumberFromUrl } = await import("../src/server/registry.ts");

function disco(over: Partial<DiscoveredSession>): DiscoveredSession {
  return {
    syntheticId: "s",
    agent: "claude",
    name: "n",
    nameSource: "process",
    cwd: "/wt",
    gitBranch: "feat/x",
    gitRoot: null,
    repoRoot: null,
    nomistakesGated: false,
    pid: 1,
    tty: null,
    wezterm: null,
    tmux: null,
    startedAt: 0,
    ...over,
  };
}

const PR = "https://github.com/o/r/pull/42";

test("reconcilePrs sets the open PR on the matching session", () => {
  const reg = new Registry();
  reg.applyDiscovery([disco({ syntheticId: "feat", gitBranch: "feat/x" })]);

  reg.reconcilePrs(new Map([["feat", { url: PR, number: 42, state: "open", checks: null }]]), new Set());

  assert.equal(reg.getSession("feat")!.prUrl, PR);
  assert.equal(reg.getSession("feat")!.prNumber, 42);
  assert.equal(reg.getSession("feat")!.prState, "open");
  assert.equal(reg.getSession("feat")!.prChecks, null);
});

test("reconcilePrs tracks the PR's CI check status as it changes", () => {
  const reg = new Registry();
  reg.applyDiscovery([disco({ syntheticId: "feat", gitBranch: "feat/x" })]);

  // Checks start pending, then one fails: the card keys its alert off "failing".
  reg.reconcilePrs(new Map([["feat", { url: PR, number: 42, state: "open", checks: "pending" }]]), new Set());
  assert.equal(reg.getSession("feat")!.prChecks, "pending");

  reg.reconcilePrs(new Map([["feat", { url: PR, number: 42, state: "open", checks: "failing" }]]), new Set());
  assert.equal(reg.getSession("feat")!.prChecks, "failing");

  // A re-run turns them green again -> the alert clears.
  reg.reconcilePrs(new Map([["feat", { url: PR, number: 42, state: "open", checks: "passing" }]]), new Set());
  assert.equal(reg.getSession("feat")!.prChecks, "passing");
});

test("a merged PR flips the chip to merged and lingers while on the branch", () => {
  const reg = new Registry();
  reg.applyDiscovery([disco({ syntheticId: "feat", gitBranch: "feat/x" })]);
  reg.reconcilePrs(new Map([["feat", { url: PR, number: 42, state: "open", checks: null }]]), new Set());

  // The PR merges: the poller still finds it (state=all) and reports it merged.
  reg.reconcilePrs(new Map([["feat", { url: PR, number: 42, state: "merged", checks: null }]]), new Set());
  assert.equal(reg.getSession("feat")!.prUrl, PR);
  assert.equal(reg.getSession("feat")!.prState, "merged");

  // A later sweep still reporting it merged keeps the chip (no branch change yet).
  reg.reconcilePrs(new Map([["feat", { url: PR, number: 42, state: "merged", checks: null }]]), new Set());
  assert.equal(reg.getSession("feat")!.prState, "merged");
});

test("reconcilePrs clears the chip once the branch has no matching PR", () => {
  const reg = new Registry();
  reg.applyDiscovery([disco({ syntheticId: "feat", gitBranch: "feat/x" })]);
  reg.reconcilePrs(new Map([["feat", { url: PR, number: 42, state: "open", checks: null }]]), new Set());
  assert.equal(reg.getSession("feat")!.prUrl, PR);

  // Next sweep: gh finds no open/merged PR for the branch (branch moved, or the
  // PR was closed unmerged) -> absent from `found` -> cleared.
  reg.reconcilePrs(new Map(), new Set());

  assert.equal(reg.getSession("feat")!.prUrl, null);
  assert.equal(reg.getSession("feat")!.prNumber, null);
  assert.equal(reg.getSession("feat")!.prState, null);
});

test("reconcilePrs leaves the chip untouched when gh errored (session in skip)", () => {
  const reg = new Registry();
  reg.applyDiscovery([disco({ syntheticId: "feat", gitBranch: "feat/x" })]);
  reg.reconcilePrs(new Map([["feat", { url: PR, number: 42, state: "merged", checks: null }]]), new Set());

  // gh missing/unauthenticated this tick -> skip -> a transient failure must not
  // wipe a real chip (even a merged one).
  reg.reconcilePrs(new Map(), new Set(["feat"]));

  assert.equal(reg.getSession("feat")!.prUrl, PR);
  assert.equal(reg.getSession("feat")!.prState, "merged");
});

test("a reset-and-reused session drops the old chip, then shows the new PR", () => {
  const reg = new Registry();
  reg.applyDiscovery([disco({ syntheticId: "s1", gitBranch: "feat/x" })]);
  reg.reconcilePrs(new Map([["s1", { url: PR, number: 42, state: "merged", checks: null }]]), new Set());
  assert.equal(reg.getSession("s1")!.prUrl, PR);

  // The session is reset onto a fresh branch: discovery updates the branch, and
  // the next reconcile (branch's PR not in `found`) retracts the merged chip.
  reg.applyDiscovery([disco({ syntheticId: "s1", gitBranch: "feat/y" })]);
  reg.reconcilePrs(new Map(), new Set());
  assert.equal(reg.getSession("s1")!.prUrl, null);
  assert.equal(reg.getSession("s1")!.prState, null);

  // A PR is opened on the new branch -> the chip repopulates.
  const pr2 = "https://github.com/o/r/pull/43";
  reg.reconcilePrs(new Map([["s1", { url: pr2, number: 43, state: "open", checks: null }]]), new Set());
  assert.equal(reg.getSession("s1")!.prUrl, pr2);
  assert.equal(reg.getSession("s1")!.prNumber, 43);
  assert.equal(reg.getSession("s1")!.prState, "open");
});

test("prPollTargets drops sessions without a cwd and exited sessions", () => {
  const reg = new Registry();
  reg.applyDiscovery([
    disco({ syntheticId: "ok", cwd: "/wt", gitBranch: "feat/x" }),
    disco({ syntheticId: "nocwd", cwd: null, gitBranch: "feat/x" }),
  ]);
  // Drop "ok" from discovery so it transitions to the exited state.
  reg.applyDiscovery([disco({ syntheticId: "nocwd", cwd: null, gitBranch: "feat/x" })]);

  const targets = reg.prPollTargets();
  assert.equal(
    targets.find((t) => t.id === "ok"),
    undefined,
  );
  assert.equal(
    targets.find((t) => t.id === "nocwd"),
    undefined,
  );
});

test("prNumberFromUrl parses the PR number, else null", () => {
  assert.equal(prNumberFromUrl("https://github.com/o/r/pull/123"), 123);
  assert.equal(prNumberFromUrl("https://github.com/o/r/tree/main"), null);
});
