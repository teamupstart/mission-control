import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { mkTask } from "./helpers/session-fixture.ts";

const home = mkdtempSync(join(tmpdir(), "mission-pipeline-workspace-"));
process.env.HARNESS_HOME = join(home, "state");

const { openDb } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const {
  applyEngineerEvent,
  bindPipelineCommissionAttempt,
  createPipelineCommission,
} = await import("../src/server/pipelines/commissions.ts");
const { projectPipelineWorkspace, resolvePipelineWorkspace } = await import(
  "../src/server/pipelines/workspace.ts"
);

const db = openDb();
after(() => rmSync(home, { recursive: true, force: true }));
const gitBin = execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();

function git(repo: string, ...args: string[]): string {
  return execFileSync(gitBin, ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

test("a registered live authoring worktree is valid without an optional marker", async () => {
  const repo = join(home, "repo");
  const worktree = join(repo, ".worktrees", "engineer-worktree");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q");
  git(repo, "branch", "-M", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  writeFileSync(join(repo, "base.txt"), "base\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base");
  mkdirSync(join(repo, ".worktrees"), { recursive: true });
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

  const unsupportedCommission = {
    ...live.commission,
    lifecycle: "unsupported" as const,
    error: "provider workspace identity changed within one attempt",
  };
  const projectedUnsupported = projectPipelineWorkspace({
    task: { pipelineWorkspacePath: worktree },
    commission: unsupportedCommission,
    linkedRun: null,
  });
  assert.equal(projectedUnsupported.liveRoot, null);
  assert.equal(projectedUnsupported.view.reason, "identity_conflict");
  assert.deepEqual(projectedUnsupported.view.capabilities, {
    diff: false,
    files: false,
    write: false,
    comment: false,
    shell: false,
    externalOpen: false,
    manualWorkflow: false,
  });

  const unsupported = await resolvePipelineWorkspace({
    task: { pipelineWorkspacePath: worktree },
    commission: unsupportedCommission,
    linkedRun: null,
  });
  assert.equal(unsupported.liveRoot, null);
  assert.equal(unsupported.view.availability, "missing");
  assert.equal(unsupported.view.reason, "identity_conflict");
  assert.deepEqual(unsupported.view.capabilities, {
    diff: true,
    files: true,
    write: false,
    comment: false,
    shell: false,
    externalOpen: false,
    manualWorkflow: false,
  });

  const registry = new Registry();
  const host = registry.registerSdkSession({
    id: "sdk:unsupported-workspace",
    agent: "codex",
    name: "unsupported workspace",
    cwd: repo,
    agentSessionId: "unsupported-workspace",
    gitBranch: null,
    gitRoot: repo,
    repoRoot: repo,
  });
  registry.upsertTask(mkTask({
    id: "task-live",
    kind: "pipeline",
    agent: "codex",
    repoRoot: repo,
    status: "running",
    sessionId: host.id,
    pipelineCommissionId: live.commission.id,
    pipelineWorkspacePath: worktree,
  }));
  registry.initializePipelineCommissions([live.commission]);
  await registry.resolveSessionWorkspace(host.id);
  assert.equal(registry.getSession(host.id)?.workspaceRoot, realpathSync(worktree));
  assert.equal(registry.getSession(host.id)?.workspace?.capabilities.write, true);

  registry.upsertPipelineCommission(unsupportedCommission);
  assert.equal(registry.getSession(host.id)?.workspaceRoot, null);
  assert.equal(registry.getSession(host.id)?.workspace?.reason, "identity_conflict");
  assert.equal(registry.getSession(host.id)?.workspace?.capabilities.write, false);

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

test("only provider worktrees under the repository's canonical root receive live capabilities", async () => {
  const repo = join(home, "identity-repo");
  const canonical = join(repo, ".worktrees", "canonical");
  const outside = join(home, "outside-linked-worktree");
  mkdirSync(join(repo, ".worktrees"), { recursive: true });
  git(repo, "init", "-q");
  git(repo, "branch", "-M", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  writeFileSync(join(repo, "base.txt"), "base\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base");
  git(repo, "worktree", "add", "-qb", "spec/canonical", canonical);
  git(repo, "worktree", "add", "-qb", "spec/outside", outside);

  const commission = {
    id: "identity",
    taskId: "identity-task",
    provider: "ai-conductor" as const,
    repoRoot: repo,
    correlationId: "identity",
    lifecycle: "authoring" as const,
    attempts: [{
      attempt: 1,
      origin: "mission_control" as const,
      launchKey: "identity",
      engineerRunId: null,
      previousEngineerRunId: null,
      providerRevision: 0,
      state: "authoring" as const,
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
    planSlug: "identity",
    handoff: null,
    linkedRun: null,
    blocker: null,
    error: null,
    createdAt: 1,
    updatedAt: 1,
  };
  for (const [reportedPath, branch] of [[repo, "main"], [outside, "spec/outside"]] as const) {
    const resolved = await resolvePipelineWorkspace({
      task: { pipelineWorkspacePath: reportedPath },
      commission: { ...commission, authoringWorktree: reportedPath, authoringBranch: branch },
      linkedRun: null,
    });
    assert.equal(resolved.liveRoot, null);
    assert.equal(resolved.view.reason, "identity_conflict");
    assert.deepEqual(resolved.view.capabilities, {
      diff: false,
      files: false,
      write: false,
      comment: false,
      shell: false,
      externalOpen: false,
      manualWorkflow: false,
    });
  }
});

test("Git validation yields to the event loop instead of blocking registry work", async () => {
  const repo = join(home, "slow-repo");
  const worktree = join(repo, ".worktrees", "slow");
  const bin = join(home, "slow-bin");
  mkdirSync(join(repo, ".worktrees"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  git(repo, "init", "-q");
  git(repo, "branch", "-M", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  writeFileSync(join(repo, "base.txt"), "base\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base");
  git(repo, "worktree", "add", "-qb", "spec/slow", worktree);
  const slowGit = join(bin, "git");
  writeFileSync(slowGit, `#!/bin/sh\nsleep 0.2\nexec ${JSON.stringify(gitBin)} "$@"\n`);
  chmodSync(slowGit, 0o700);

  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  let settled = false;
  try {
    const resolving = resolvePipelineWorkspace({
      task: { pipelineWorkspacePath: worktree },
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
        authoringWorktree: worktree,
        authoringBranch: "spec/slow",
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

test("a cached live workspace survives an equivalent symlinked provider path", async () => {
  const repo = join(home, "symlink-repo");
  const worktree = join(repo, ".worktrees", "canonical");
  const reportedPath = join(repo, ".worktrees", "reported");
  mkdirSync(join(repo, ".worktrees"), { recursive: true });
  git(repo, "init", "-q");
  git(repo, "branch", "-M", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  writeFileSync(join(repo, "base.txt"), "base\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base");
  git(repo, "worktree", "add", "-qb", "spec/symlink", worktree);
  symlinkSync(worktree, reportedPath);

  const commit = git(worktree, "rev-parse", "HEAD");
  const commission = {
    id: "symlink",
    taskId: "symlink-task",
    provider: "ai-conductor" as const,
    repoRoot: repo,
    correlationId: "symlink",
    lifecycle: "authoring" as const,
    attempts: [{
      attempt: 1,
      origin: "mission_control" as const,
      launchKey: "symlink",
      engineerRunId: null,
      previousEngineerRunId: null,
      providerRevision: 1,
      state: "authoring" as const,
      terminalReason: null,
      evidenceCommit: commit,
      evidenceCommitProvenance: "live_validation" as const,
      evidenceFrozenAt: 1,
      updatedAt: 1,
    }],
    activeAttempt: 1,
    steps: [],
    currentStep: null,
    tier: null,
    track: null,
    project: null,
    authoringWorktree: reportedPath,
    authoringBranch: "spec/symlink",
    planSlug: "symlink",
    handoff: null,
    linkedRun: null,
    blocker: null,
    error: null,
    createdAt: 1,
    updatedAt: 1,
  };
  const registry = new Registry();
  const host = registry.registerSdkSession({
    id: "sdk:symlink",
    agent: "codex",
    name: "symlink workspace",
    cwd: repo,
    agentSessionId: "symlink",
    gitBranch: null,
    gitRoot: repo,
    repoRoot: repo,
  });
  registry.upsertTask(mkTask({
    id: commission.taskId,
    kind: "pipeline",
    agent: "codex",
    repoRoot: repo,
    status: "running",
    sessionId: host.id,
    pipelineCommissionId: commission.id,
    pipelineWorkspacePath: reportedPath,
  }));
  registry.initializePipelineCommissions([commission]);

  await registry.resolveSessionWorkspace(host.id);
  assert.equal(registry.getSession(host.id)?.workspaceRoot, realpathSync(worktree));

  registry.upsertPipelineCommission({ ...commission, updatedAt: 2 });
  assert.equal(registry.getSession(host.id)?.workspaceRoot, realpathSync(worktree));
  assert.equal(registry.getSession(host.id)?.workspace?.availability, "available");
});

test("a newer provider revision supersedes an in-flight workspace projection", async () => {
  const repo = join(home, "revision-race-repo");
  const commission = {
    id: "revision-race",
    taskId: "revision-race-task",
    provider: "ai-conductor" as const,
    repoRoot: repo,
    correlationId: "revision-race",
    lifecycle: "authoring" as const,
    attempts: [{
      attempt: 1,
      origin: "mission_control" as const,
      launchKey: "revision-race",
      engineerRunId: "engineer-revision-race",
      previousEngineerRunId: null,
      providerRevision: 2,
      state: "authoring" as const,
      terminalReason: null,
      evidenceCommit: null,
      evidenceCommitProvenance: null,
      evidenceFrozenAt: null,
      updatedAt: 2,
    }],
    activeAttempt: 1,
    steps: [],
    currentStep: null,
    tier: null,
    track: null,
    project: null,
    authoringWorktree: null,
    authoringBranch: null,
    planSlug: null,
    handoff: null,
    linkedRun: null,
    blocker: null,
    error: null,
    createdAt: 1,
    updatedAt: 2,
  };
  const registry = new Registry();
  const host = registry.registerSdkSession({
    id: "sdk:revision-race",
    agent: "codex",
    name: "revision race",
    cwd: repo,
    agentSessionId: "revision-race",
    gitBranch: null,
    gitRoot: repo,
    repoRoot: repo,
  });
  registry.upsertTask(mkTask({
    id: commission.taskId,
    kind: "pipeline",
    agent: "codex",
    repoRoot: repo,
    status: "running",
    sessionId: host.id,
    pipelineCommissionId: commission.id,
  }));
  registry.initializePipelineCommissions([commission]);

  const newer = {
    ...commission,
    attempts: commission.attempts.map((attempt) => ({
      ...attempt,
      providerRevision: 3,
      updatedAt: 3,
    })),
    updatedAt: 3,
  };
  registry.upsertPipelineCommission(newer);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(registry.pipelineCommission(commission.id)?.attempts[0]?.providerRevision, 3);
  assert.equal(registry.getSession(host.id)?.workspace?.providerRevision, 3);
});
