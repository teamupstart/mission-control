import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const home = mkdtempSync(join(tmpdir(), "mission-pipeline-workspace-"));
process.env.HARNESS_HOME = join(home, "state");

const { openDb } = await import("../src/server/db.ts");
const {
  applyEngineerEvent,
  bindPipelineCommissionAttempt,
  createPipelineCommission,
} = await import("../src/server/pipelines/commissions.ts");
const { resolvePipelineWorkspace } = await import("../src/server/pipelines/workspace.ts");

const db = openDb();
after(() => rmSync(home, { recursive: true, force: true }));

function git(repo: string, ...args: string[]): string {
  return execFileSync("/usr/bin/git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

test("a registered live authoring worktree is valid without an optional marker", async () => {
  const repo = join(home, "repo");
  const worktree = join(home, "engineer-worktree");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q");
  git(repo, "branch", "-M", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  writeFileSync(join(repo, "base.txt"), "base\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base");
  git(repo, "worktree", "add", "-qb", "spec/live-workspace", worktree);
  writeFileSync(join(worktree, "plan.md"), "truthful workspace\n");
  git(worktree, "add", "-A");
  git(worktree, "commit", "-qm", "authoring work");

  db.prepare(
    `INSERT INTO tasks
       (id, title, intent, kind, agent, repo_root, status, created_at, updated_at)
     VALUES ('task-live', 'Live workspace', 'Validate workspace', 'ship', 'codex', ?, 'running', 1, 1)`,
  ).run(repo);
  const created = createPipelineCommission({
    taskId: "task-live",
    provider: "ai-conductor",
    repoRoot: repo,
    id: "commission-live",
    correlationId: "correlation-live",
    launchKey: "launch-live",
  });
  bindPipelineCommissionAttempt({
    commissionId: created.id,
    attempt: 1,
    engineerRunId: "engineer-live",
    providerAttempt: 1,
    attemptKey: "launch-live",
    previousEngineerRunId: null,
  });
  const base = {
    schemaVersion: 1 as const,
    engineerRunId: "engineer-live",
    correlationId: "correlation-live",
    attemptKey: "launch-live",
    attempt: 1,
    previousEngineerRunId: null,
    repoRoot: repo,
  };
  const createdEvent = applyEngineerEvent({
    ...base,
    revision: 1,
    ts: new Date(1_700_000_000_001).toISOString(),
    type: "engineer_run_created",
    idea: "workspace",
  });
  assert.equal(createdEvent.outcome, "stored");
  assert.ok(createdEvent.commission);

  const reportedBeforeProviderMetadata = await resolvePipelineWorkspace({
    task: { pipelineWorkspacePath: worktree },
    commission: createdEvent.commission!,
    linkedRun: null,
  });
  assert.equal(reportedBeforeProviderMetadata.view.availability, "available");
  assert.equal(reportedBeforeProviderMetadata.liveRoot, realpathSync(worktree));
  assert.equal(reportedBeforeProviderMetadata.view.branch, "spec/live-workspace");

  const worktreeEvent = applyEngineerEvent({
    ...base,
    revision: 2,
    ts: new Date(1_700_000_000_002).toISOString(),
    type: "engineer_worktree_created",
    worktreePath: worktree,
    branch: "spec/live-workspace",
    planSlug: "live-workspace",
  });
  assert.equal(worktreeEvent.outcome, "stored");
  assert.ok(worktreeEvent.commission);

  const live = await resolvePipelineWorkspace({
    task: { pipelineWorkspacePath: worktree },
    commission: worktreeEvent.commission!,
    linkedRun: null,
  });
  assert.equal(live.view.availability, "available");
  assert.equal(live.liveRoot, realpathSync(worktree));
  assert.equal(live.view.branch, "spec/live-workspace");
  assert.equal(live.view.capabilities.write, true);
  assert.equal(live.view.commit, git(worktree, "rev-parse", "HEAD"));

  git(repo, "worktree", "remove", "--force", worktree);
  const missing = await resolvePipelineWorkspace({
    task: { pipelineWorkspacePath: worktree },
    commission: live.commission,
    linkedRun: null,
  });
  assert.equal(missing.view.availability, "missing");
  assert.equal(missing.view.capabilities.diff, true);
  assert.equal(missing.view.capabilities.files, true);
  assert.equal(missing.view.capabilities.write, false);
});

test("Git validation yields to the event loop instead of blocking registry work", async () => {
  const repo = join(home, "slow-repo");
  const bin = join(home, "slow-bin");
  mkdirSync(repo, { recursive: true });
  mkdirSync(bin, { recursive: true });
  git(repo, "init", "-q");
  git(repo, "branch", "-M", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  writeFileSync(join(repo, "base.txt"), "base\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base");
  const slowGit = join(bin, "git");
  writeFileSync(slowGit, '#!/bin/sh\n/bin/sleep 0.2\nexec /usr/bin/git "$@"\n');
  chmodSync(slowGit, 0o700);

  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  let settled = false;
  try {
    const resolving = resolvePipelineWorkspace({
      task: { pipelineWorkspacePath: repo },
      commission: {
        id: "slow",
        taskId: "slow-task",
        provider: "ai-conductor",
        repoRoot: repo,
        correlationId: "slow",
        lifecycle: "authoring",
        attempts: [{
          attempt: 1,
          origin: "mission_control",
          launchKey: "slow",
          engineerRunId: null,
          previousEngineerRunId: null,
          providerRevision: 0,
          state: "authoring",
          terminalReason: null,
          evidenceCommit: null,
          evidenceCommitProvenance: null,
          evidenceFrozenAt: null,
          updatedAt: 1,
        }],
        activeAttempt: 1,
        steps: [],
        currentStep: null,
        tier: null,
        track: null,
        project: null,
        authoringWorktree: repo,
        authoringBranch: "main",
        planSlug: "slow",
        handoff: null,
        linkedRun: null,
        blocker: null,
        error: null,
        createdAt: 1,
        updatedAt: 1,
      },
      linkedRun: null,
    }).finally(() => { settled = true; });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    assert.equal(settled, false, "the delayed Git child must not stall timers");
    await resolving;
  } finally {
    process.env.PATH = previousPath;
  }
});
