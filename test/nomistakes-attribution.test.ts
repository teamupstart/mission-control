import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { NmRunSummary } from "@shared/types.ts";

// Isolate the daemon's SQLite DB before anything reads config/db.
process.env.HARNESS_HOME = mkdtempSync(join(tmpdir(), "harness-nm-"));
const { Registry } = await import("../src/server/registry.ts");

function disco(over: Partial<DiscoveredSession>): DiscoveredSession {
  return {
    syntheticId: "s",
    agent: "claude",
    name: "n",
    nameSource: "process",
    cwd: "/repo",
    gitBranch: "main",
    gitRoot: null,
    repoRoot: null,
    nomistakesGated: true,
    pid: 1,
    tty: null,
    terminals: [],
    startedAt: 0,
    ...over,
  };
}

function runOn(branch: string): NmRunSummary {
  return {
    id: `01RUN_${branch}`,
    status: "running",
    branch,
    startedAt: null,
    endedAt: null,
    prUrl: null,
    awaitingAgent: null,
    findingsSummary: null,
    gateStep: null,
    gateSummary: null,
    gateRisk: null,
    steps: [],
    activeSteps: [],
    findings: [],
    outcome: null,
  };
}

test("reconcileNomistakes decorates only the session on the run's branch", () => {
  const reg = new Registry();
  reg.applyDiscovery([
    disco({ syntheticId: "main-1", pid: 101, cwd: "/repo", gitBranch: "main" }),
    disco({ syntheticId: "feat-1", pid: 102, cwd: "/wt", gitBranch: "chore/health-version" }),
    disco({ syntheticId: "elsewhere", pid: 103, cwd: "/other", gitBranch: "chore/health-version" }),
  ]);

  const run = runOn("chore/health-version");
  reg.reconcileNomistakes([run]);

  // A run on another branch must NOT leak onto the same-repo main session.
  assert.equal(reg.getSession("main-1")!.nomistakes, null);
  // The session actually checked out on that branch shows it - even in a diff dir.
  assert.deepEqual(reg.getSession("feat-1")!.nomistakes, run);
  assert.deepEqual(reg.getSession("elsewhere")!.nomistakes, run);
});

test("a worktree run attaches to its launcher, never idle same-checkout siblings", () => {
  const reg = new Registry();
  // Three terminals share /repo on main (AI1/AI2/AI3). AI2 launched a run into a
  // sibling worktree on a feature branch - discovery saw its `axi run` process.
  reg.applyDiscovery([
    disco({ syntheticId: "ai1", pid: 201, cwd: "/repo", gitBranch: "main" }),
    disco({
      syntheticId: "ai2",
      pid: 202,
      cwd: "/repo",
      gitBranch: "main",
      nomistakesRuns: [{ cwd: "/wt-autopilot", branch: "mancej/auto-pilot" }],
    }),
    disco({ syntheticId: "ai3", pid: 203, cwd: "/repo", gitBranch: "main" }),
  ]);

  const run = runOn("mancej/auto-pilot");
  reg.reconcileNomistakes([run]);

  // Only the launcher gets it; the idle siblings on the same checkout get nothing.
  assert.deepEqual(reg.getSession("ai2")!.nomistakes, run);
  assert.equal(reg.getSession("ai1")!.nomistakes, null);
  assert.equal(reg.getSession("ai3")!.nomistakes, null);
});

test("two concurrent runs each attach to their own launcher, no clobber", () => {
  const reg = new Registry();
  reg.applyDiscovery([
    disco({
      syntheticId: "ai2",
      pid: 302,
      cwd: "/repo",
      gitBranch: "main",
      nomistakesRuns: [{ cwd: "/wt-a", branch: "mancej/auto-pilot" }],
    }),
    disco({
      syntheticId: "ai3",
      pid: 303,
      cwd: "/repo",
      gitBranch: "main",
      nomistakesRuns: [{ cwd: "/wt-b", branch: "mancej/nomistakes-narration" }],
    }),
    disco({ syntheticId: "web", pid: 304, cwd: "/repo", gitBranch: "main" }),
    disco({ syntheticId: "mainsess", pid: 305, cwd: "/repo", gitBranch: "main" }),
  ]);

  const runA = runOn("mancej/auto-pilot");
  const runB = runOn("mancej/nomistakes-narration");
  // Applied together in one pass - the two runs must not fight over the sessions.
  reg.reconcileNomistakes([runA, runB]);

  assert.deepEqual(reg.getSession("ai2")!.nomistakes, runA);
  assert.deepEqual(reg.getSession("ai3")!.nomistakes, runB);
  assert.equal(reg.getSession("web")!.nomistakes, null);
  assert.equal(reg.getSession("mainsess")!.nomistakes, null);
});

test("a launcher binding survives a sweep with no live driver (parked gate)", () => {
  const reg = new Registry();
  const withDriver = disco({
    syntheticId: "ai2",
    pid: 402,
    cwd: "/repo",
    gitBranch: "main",
    nomistakesRuns: [{ cwd: "/wt", branch: "feat" }],
  });
  reg.applyDiscovery([withDriver]);
  reg.reconcileNomistakes([runOn("feat")]);
  assert.deepEqual(reg.getSession("ai2")!.nomistakes, runOn("feat"));

  // Next sweep the `axi run` process is gone (gate parked) - no nomistakesRuns.
  reg.applyDiscovery([disco({ syntheticId: "ai2", pid: 402, cwd: "/repo", gitBranch: "main" })]);
  // The remembered binding still attributes the parked run to its launcher.
  reg.reconcileNomistakes([runOn("feat")]);
  assert.deepEqual(reg.getSession("ai2")!.nomistakes, runOn("feat"));
});

test("reconcileNomistakes clears a run when it ends", () => {
  const reg = new Registry();
  reg.applyDiscovery([disco({ syntheticId: "feat-1", cwd: "/wt", gitBranch: "feat" })]);
  reg.reconcileNomistakes([runOn("feat")]);
  assert.deepEqual(reg.getSession("feat-1")!.nomistakes, runOn("feat"));
  reg.reconcileNomistakes([]);
  assert.equal(reg.getSession("feat-1")!.nomistakes, null);
});

test("nomistakesPollCwds covers gated checkouts and remembered launcher worktrees", () => {
  const reg = new Registry();
  reg.applyDiscovery([
    disco({
      syntheticId: "ai2",
      pid: 502,
      cwd: "/repo",
      gitBranch: "main",
      nomistakesRuns: [{ cwd: "/wt-a", branch: "feat-a" }],
    }),
    disco({ syntheticId: "ungated", pid: 503, cwd: "/plain", gitBranch: "main", nomistakesGated: false }),
  ]);

  const cwds = reg.nomistakesPollCwds().sort();
  assert.deepEqual(cwds, ["/repo", "/wt-a"]); // gated checkout + launcher worktree, not /plain
});
