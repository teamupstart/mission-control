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
    nomistakesGated: true,
    pid: 1,
    tty: null,
    wezterm: null,
    tmux: null,
    startedAt: 0,
    ...over,
  };
}

function runOn(branch: string): NmRunSummary {
  return {
    status: "running",
    branch,
    awaitingAgent: null,
    findingsSummary: null,
    gateStep: null,
    gateSummary: null,
    gateRisk: null,
    steps: [],
    findings: [],
    outcome: null,
  };
}

test("applyNomistakes decorates only sessions on the run's branch", () => {
  const reg = new Registry();
  reg.applyDiscovery([
    disco({ syntheticId: "main-1", pid: 101, cwd: "/repo", gitBranch: "main" }),
    disco({ syntheticId: "feat-1", pid: 102, cwd: "/repo", gitBranch: "chore/health-version" }),
    disco({ syntheticId: "elsewhere", pid: 103, cwd: "/other", gitBranch: "chore/health-version" }),
  ]);

  // A repo-wide poll surfaces the active run, which is on chore/health-version.
  const run = runOn("chore/health-version");
  reg.applyNomistakes("/repo", run);

  // The bug: a run on another branch must NOT leak onto same-repo main sessions.
  assert.equal(reg.getSession("main-1")!.nomistakes, null);
  // The worktree session actually on that branch shows it.
  assert.deepEqual(reg.getSession("feat-1")!.nomistakes, run);
  // A session in a different repo dir is untouched by this cwd's poll.
  assert.equal(reg.getSession("elsewhere")!.nomistakes, null);
});

test("applyNomistakes clears a run when it ends", () => {
  const reg = new Registry();
  reg.applyDiscovery([disco({ syntheticId: "feat-1", cwd: "/repo", gitBranch: "feat" })]);
  reg.applyNomistakes("/repo", runOn("feat"));
  assert.deepEqual(reg.getSession("feat-1")!.nomistakes, runOn("feat"));
  reg.applyNomistakes("/repo", null);
  assert.equal(reg.getSession("feat-1")!.nomistakes, null);
});
