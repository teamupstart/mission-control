import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { QueueManager } from "../src/server/queue.ts";
import type { ReviewManager } from "../src/server/reviews.ts";
import type { SdkSupervisor } from "../src/server/sdk/supervisor.ts";
import type { PipelineRun } from "../src/shared/pipeline.ts";

const home = mkdtempSync(join(tmpdir(), "mission-pipeline-adoption-http-"));
process.env.MISSION_HOME = home;

const { ensureToken } = await import("../src/server/auth.ts");
const { Dispatcher } = await import("../src/server/dispatcher.ts");
const { Registry } = await import("../src/server/registry.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const {
  PIPELINE_CALLER_CREDENTIAL_HEADER,
} = await import("../src/shared/pipeline.ts");
const { mkTask } = await import("./helpers/session-fixture.ts");
const { pipelineCredentialFromDescriptor } = await import("./helpers/pipeline-credential.ts");

after(() => rmSync(home, { recursive: true, force: true }));

let workspaceFixtureOrdinal = 0;

function workspaceRepo(label: string): string {
  const ordinal = workspaceFixtureOrdinal++;
  const repoRoot = realpathSync(mkdtempSync(join(home, `${label}-${ordinal}-`)));
  execFileSync("git", ["init", "-q", "-b", "main", repoRoot], { stdio: "pipe" });
  writeFileSync(join(repoRoot, ".gitignore"), ".worktrees/\n");
  execFileSync("git", ["-C", repoRoot, "add", ".gitignore"], { stdio: "pipe" });
  execFileSync(
    "git",
    [
      "-C",
      repoRoot,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-qm",
      "base",
    ],
    { stdio: "pipe" },
  );
  mkdirSync(join(repoRoot, ".worktrees"), { recursive: true });
  return repoRoot;
}

function linkedWorktree(repoRoot: string, path: string): string {
  execFileSync("git", ["-C", repoRoot, "worktree", "add", "-q", "--detach", path, "HEAD"], {
    stdio: "pipe",
  });
  return realpathSync(path);
}

function fixture() {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const target: PipelineRun = {
    provider: "ai-conductor",
    repoRoot: "/repo/pipeline-adoption",
    slug: "existing-run",
    worktree: "/repo/pipeline-adoption/.worktrees/existing-run",
    tier: "M",
    track: "technical",
    steps: [{ name: "build", state: "in_progress" }],
    lastStep: "build",
    halt: null,
    group: "building",
    prUrl: null,
    costTokens: null,
    updatedAt: 1,
  };
  registry.initializePipelineRuns([target]);
  const host = registry.registerSdkSession({
    id: "sdk:pipeline-adoption-http",
    agent: "codex",
    name: "pipeline adoption",
    cwd: target.repoRoot,
    agentSessionId: "codex-pipeline-adoption-http",
    gitBranch: null,
    gitRoot: target.repoRoot,
    repoRoot: target.repoRoot,
  });
  const task = mkTask({
    id: "pipeline-adoption-http",
    agent: "codex",
    kind: "pipeline",
    repoRoot: target.repoRoot,
    status: "running",
    sessionId: host.id,
    pipelineRun: {
      provider: target.provider,
      repoRoot: target.repoRoot,
      slug: "reserved-run",
    },
  });
  registry.upsertTask(task);
  const callerCredential = "pipeline-adoption-http-credential";
  registry.registerManagedPipelineCaller(task.id, host.id, target.repoRoot, callerCredential);
  registry.registerSdkSession({
    id: "sdk:pipeline-adoption-same-cwd",
    agent: "codex",
    name: "same cwd, different host",
    cwd: target.repoRoot,
    agentSessionId: "codex-pipeline-adoption-same-cwd",
  });
  const app = buildApp({ registry, reviews: {} as ReviewManager, tasks, queues: {} as QueueManager });
  const payload = {
    slug: target.slug,
  };
  return { app, registry, task, target, payload, callerCredential };
}

test("the shared daemon token cannot authorize Pipeline adoption without its launch capability", async () => {
  const { app, registry, task, payload } = fixture();
  const response = await app.request("/mcp/pipelines/adopt", {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": ensureToken() },
    body: JSON.stringify(payload),
  });

  assert.equal(response.status, 403);
  assert.equal(registry.getTask(task.id)?.pipelineRun?.slug, "reserved-run");
});

test("the authenticated adoption route derives provider and repository from its launch task", async () => {
  const { app, registry, task, target, payload, callerCredential } = fixture();
  const response = await app.request("/mcp/pipelines/adopt", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-harness-token": ensureToken(),
      [PIPELINE_CALLER_CREDENTIAL_HEADER]: callerCredential,
    },
    body: JSON.stringify(payload),
  });

  assert.equal(response.status, 200, await response.text());
  assert.deepEqual(registry.getTask(task.id)?.pipelineRun, {
    provider: target.provider,
    repoRoot: target.repoRoot,
    slug: target.slug,
  });
  assert.equal(registry.getSession(task.sessionId!)?.pipeline, null);
});

test("the authenticated adoption route accepts its preallocated managed host before SDK registration", async () => {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const repoRoot = "/repo/pipeline-adoption-preallocated";
  const target: PipelineRun = {
    provider: "ai-conductor",
    repoRoot,
    slug: "existing-preallocated-run",
    worktree: `${repoRoot}/.worktrees/existing-preallocated-run`,
    tier: "M",
    track: "technical",
    steps: [{ name: "build", state: "in_progress" }],
    lastStep: "build",
    halt: null,
    group: "building",
    prUrl: null,
    costTokens: null,
    updatedAt: 1,
  };
  registry.initializePipelineRuns([target]);
  const task = mkTask({
    id: "pipeline-adoption-preallocated",
    agent: "codex",
    kind: "pipeline",
    repoRoot,
    intent: "Resume the observed Pipeline run",
  });
  registry.upsertTask(task);

  let preallocatedSessionId = "";
  let callerCredential = "";
  let markStarted!: () => void;
  let rejectStart!: (error: Error) => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const supervisor = {
    start: (input: Parameters<SdkSupervisor["start"]>[0]) => {
      preallocatedSessionId = input.sessionId!;
      callerCredential = pipelineCredentialFromDescriptor(input.mcp);
      assert.ok(callerCredential);
      assert.equal(registry.getTask(task.id)?.sessionId, preallocatedSessionId);
      assert.equal(registry.getSession(preallocatedSessionId), undefined);
      return new Promise((_resolve, reject) => {
        rejectStart = reject;
        markStarted();
      });
    },
    taskLiveness: () => null,
  } as unknown as SdkSupervisor;
  const dispatcher = new Dispatcher(registry, undefined, {
    supervisor,
    missionMcpDescriptor: async () => ({
      serverName: "mission-control",
      command: "/usr/bin/node",
      args: ["/dist/mcp/server.mjs"],
      env: {},
    }),
    verifyMissionMcpTools: async () => ({ ok: true }),
    pipelineLaunch: async () => ({
      ok: true,
      launchRuntime: "agent-sdk",
      cwd: repoRoot,
      pipelineRun: {
        provider: target.provider,
        repoRoot,
        slug: "reserved-preallocated-run",
      },
    }),
  });
  const app = buildApp({ registry, reviews: {} as ReviewManager, tasks, queues: {} as QueueManager });

  const dispatch = dispatcher.dispatch(task.id);
  await started;
  const response = await app.request("/mcp/pipelines/adopt", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-harness-token": ensureToken(),
      [PIPELINE_CALLER_CREDENTIAL_HEADER]: callerCredential,
    },
    body: JSON.stringify({ slug: target.slug }),
  });
  const responseBody = await response.text();
  rejectStart(new Error("SDK start rejected after adoption request"));
  await dispatch;

  assert.equal(registry.managedPipelineLaunch(preallocatedSessionId), null);
  assert.equal(response.status, 200, responseBody);
  assert.deepEqual(registry.getTask(task.id)?.pipelineRun, {
    provider: target.provider,
    repoRoot: target.repoRoot,
    slug: target.slug,
  });
});

test("pre-registration managed adoption refuses missing or forged launch capability", async () => {
  for (const mode of ["missing-capability", "forged-capability"] as const) {
    const registry = new Registry();
    const tasks = new TaskManager(registry);
    const repoRoot = `/repo/pipeline-adoption-preallocated-${mode}`;
    const reservedSlug = `reserved-preallocated-${mode}`;
    const target: PipelineRun = {
      provider: "ai-conductor",
      repoRoot,
      slug: `existing-preallocated-${mode}`,
      worktree: `${repoRoot}/.worktrees/existing-preallocated-${mode}`,
      tier: "M",
      track: "technical",
      steps: [{ name: "build", state: "in_progress" }],
      lastStep: "build",
      halt: null,
      group: "building",
      prUrl: null,
      costTokens: null,
      updatedAt: 1,
    };
    registry.initializePipelineRuns([target]);
    const task = mkTask({
      id: `pipeline-adoption-preallocated-${mode}`,
      agent: "codex",
      kind: "pipeline",
      repoRoot,
      intent: "Keep the reserved run when caller identity is wrong",
    });
    registry.upsertTask(task);

    let preallocatedSessionId = "";
    let markStarted!: () => void;
    let rejectStart!: (error: Error) => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const supervisor = {
      start: (input: Parameters<SdkSupervisor["start"]>[0]) => {
        preallocatedSessionId = input.sessionId!;
        assert.equal(registry.getTask(task.id)?.sessionId, preallocatedSessionId);
        assert.equal(registry.getSession(preallocatedSessionId), undefined);
        return new Promise((_resolve, reject) => {
          rejectStart = reject;
          markStarted();
        });
      },
      taskLiveness: () => null,
    } as unknown as SdkSupervisor;
    const dispatcher = new Dispatcher(registry, undefined, {
      supervisor,
      missionMcpDescriptor: async () => ({
        serverName: "mission-control",
        command: "/usr/bin/node",
        args: ["/dist/mcp/server.mjs"],
        env: {},
      }),
      verifyMissionMcpTools: async () => ({ ok: true }),
      pipelineLaunch: async () => ({
        ok: true,
        launchRuntime: "agent-sdk",
        cwd: repoRoot,
        pipelineRun: {
          provider: target.provider,
          repoRoot,
          slug: reservedSlug,
        },
      }),
    });
    const app = buildApp({ registry, reviews: {} as ReviewManager, tasks, queues: {} as QueueManager });

    const dispatch = dispatcher.dispatch(task.id);
    await started;
    const response = await app.request("/mcp/pipelines/adopt", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-harness-token": ensureToken(),
        ...(mode === "forged-capability"
          ? { [PIPELINE_CALLER_CREDENTIAL_HEADER]: "forged-pipeline-capability" }
          : {}),
      },
      body: JSON.stringify({ slug: target.slug }),
    });
    const responseBody = await response.text();
    const pipelineRun = registry.getTask(task.id)?.pipelineRun;
    rejectStart(new Error("SDK start rejected after mismatched adoption request"));
    await dispatch;

    assert.deepEqual({ status: response.status, slug: pipelineRun?.slug }, {
      status: 403,
      slug: reservedSlug,
    }, `${mode}: ${responseBody}`);
  }
});

test("the adoption route requires authentication and exact launch identity", async () => {
  for (const mode of ["unauthenticated", "missing-capability", "forged-capability"] as const) {
    const { app, registry, task, payload, callerCredential } = fixture();
    const response = await app.request("/mcp/pipelines/adopt", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(mode === "unauthenticated" ? {} : { "x-harness-token": ensureToken() }),
        ...(mode === "missing-capability"
          ? {}
          : {
              [PIPELINE_CALLER_CREDENTIAL_HEADER]: mode === "forged-capability"
                ? "forged-pipeline-capability"
                : callerCredential,
            }),
      },
      body: JSON.stringify(payload),
    });

    assert.equal(response.status, mode === "unauthenticated" ? 401 : 403, mode);
    assert.equal(registry.getTask(task.id)?.pipelineRun?.slug, "reserved-run", mode);
  }
});

test("the adoption route rejects caller-selected provider and repository identity", async () => {
  const { app, registry, task, payload, callerCredential } = fixture();
  const response = await app.request("/mcp/pipelines/adopt", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-harness-token": ensureToken(),
      [PIPELINE_CALLER_CREDENTIAL_HEADER]: callerCredential,
    },
    body: JSON.stringify({
      ...payload,
      provider: "other",
      repoRoot: "/repo/other",
      taskId: task.id,
      hostSessionId: task.sessionId,
      cwd: task.repoRoot,
    }),
  });

  assert.equal(response.status, 400);
  assert.equal(registry.getTask(task.id)?.pipelineRun?.slug, "reserved-run");
});

test("the adoption route rejects a different live caller", async () => {
  const { app, registry, task, target, payload } = fixture();
  const other = registry.registerSdkSession({
    id: "sdk:pipeline-adoption-other",
    agent: "codex",
    name: "other host",
    cwd: "/repo/other-host",
    agentSessionId: "codex-pipeline-adoption-other",
  });
  const otherCredential = "pipeline-adoption-other-credential";
  registry.registerManagedPipelineCaller(task.id, other.id, "/repo/other-host", otherCredential);
  const response = await app.request("/mcp/pipelines/adopt", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-harness-token": ensureToken(),
      [PIPELINE_CALLER_CREDENTIAL_HEADER]: otherCredential,
    },
    body: JSON.stringify(payload),
  });

  assert.equal(response.status, 403);
  assert.equal(registry.getTask(task.id)?.pipelineRun?.slug, "reserved-run");
  assert.equal(registry.listPipelineRuns()[0]?.slug, target.slug);
});

test("Pipeline workspace reports reject escaped locations and foreign Git ownership", () => {
  const repoRoot = workspaceRepo("pipeline-workspace-containment");
  const worktreesRoot = join(repoRoot, ".worktrees");
  const valid = linkedWorktree(repoRoot, join(worktreesRoot, "engineer-valid"));
  const outside = linkedWorktree(repoRoot, join(home, "pipeline-workspace-outside"));
  const symlinkEscape = join(worktreesRoot, "engineer-symlink-escape");
  symlinkSync(outside, symlinkEscape, "dir");

  const foreignRepo = workspaceRepo("pipeline-workspace-foreign-owner");
  const foreign = linkedWorktree(foreignRepo, join(worktreesRoot, "engineer-foreign"));
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const task = mkTask({
    id: "pipeline-workspace-containment",
    agent: "codex",
    kind: "pipeline",
    repoRoot,
    status: "running",
    pipelineRun: {
      provider: "ai-conductor",
      repoRoot,
      slug: "workspace-containment",
    },
  });
  registry.upsertTask(task);

  for (const [name, path] of [
    ["same-repository worktree outside .worktrees", outside],
    ["symlink resolving outside .worktrees", symlinkEscape],
    ["direct child owned by another Git repository", foreign],
  ] as const) {
    assert.deepEqual(tasks.reportPipelineWorkspace(task.id, path), {
      ok: false,
      status: 409,
      error: "the Pipeline workspace must be a direct .worktrees checkout of this task repository",
    }, name);
    assert.equal(registry.getTask(task.id)?.pipelineWorkspacePath ?? null, null, name);
  }

  const accepted = tasks.reportPipelineWorkspace(task.id, valid);
  assert.equal(accepted.ok, true);
  assert.equal(registry.getTask(task.id)?.pipelineWorkspacePath, valid);
});

test("the Pipeline workspace route rejects unauthenticated, mismatched, and conflicting callers", async () => {
  const repoRoot = workspaceRepo("pipeline-workspace-route");
  const workspace = linkedWorktree(repoRoot, join(repoRoot, ".worktrees", "engineer-route"));
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const host = registry.registerSdkSession({
    id: "sdk:pipeline-workspace-route",
    agent: "codex",
    name: "pipeline workspace route",
    cwd: repoRoot,
    agentSessionId: "codex-pipeline-workspace-route",
    gitBranch: "main",
    gitRoot: repoRoot,
    repoRoot,
  });
  const other = registry.registerSdkSession({
    id: "sdk:pipeline-workspace-route-other",
    agent: "codex",
    name: "other pipeline workspace host",
    cwd: repoRoot,
    agentSessionId: "codex-pipeline-workspace-route-other",
  });
  const task = mkTask({
    id: "pipeline-workspace-route",
    agent: "codex",
    kind: "pipeline",
    repoRoot,
    status: "running",
    sessionId: host.id,
    pipelineRun: {
      provider: "ai-conductor",
      repoRoot,
      slug: "workspace-route",
    },
  });
  registry.upsertTask(task);
  registry.registerManagedPipelineCaller(task.id, host.id, repoRoot, "workspace-route-valid");
  registry.registerManagedPipelineCaller("missing-task", host.id, repoRoot, "workspace-route-missing-task");
  registry.registerManagedPipelineCaller(task.id, other.id, repoRoot, "workspace-route-other-host");
  registry.registerManagedPipelineCaller(task.id, host.id, join(repoRoot, "wrong"), "workspace-route-wrong-cwd");
  const app = buildApp({ registry, reviews: {} as ReviewManager, tasks, queues: {} as QueueManager });

  const cases = [
    {
      name: "unauthenticated",
      headers: { [PIPELINE_CALLER_CREDENTIAL_HEADER]: "workspace-route-valid" },
      status: 401,
      error: "unauthorized",
    },
    {
      name: "missing launch capability",
      headers: { "x-harness-token": ensureToken() },
      status: 403,
      error: "the caller has no managed Pipeline launch capability",
    },
    {
      name: "capability whose task disappeared",
      headers: {
        "x-harness-token": ensureToken(),
        [PIPELINE_CALLER_CREDENTIAL_HEADER]: "workspace-route-missing-task",
      },
      status: 404,
      error: "no matching Pipeline task",
    },
    {
      name: "different task owner",
      headers: {
        "x-harness-token": ensureToken(),
        [PIPELINE_CALLER_CREDENTIAL_HEADER]: "workspace-route-other-host",
      },
      status: 403,
      error: "the caller does not own this Pipeline task",
    },
    {
      name: "mismatched host cwd",
      headers: {
        "x-harness-token": ensureToken(),
        [PIPELINE_CALLER_CREDENTIAL_HEADER]: "workspace-route-wrong-cwd",
      },
      status: 403,
      error: "the caller does not match the managed Pipeline host",
    },
  ] as const;
  for (const entry of cases) {
    const response = await app.request("/mcp/pipelines/workspace", {
      method: "POST",
      headers: { "content-type": "application/json", ...entry.headers },
      body: JSON.stringify({ path: workspace }),
    });
    assert.equal(response.status, entry.status, entry.name);
    assert.deepEqual(await response.json(), { error: entry.error }, entry.name);
    assert.equal(registry.getTask(task.id)?.pipelineWorkspacePath ?? null, null, entry.name);
  }

  const outside = await app.request("/mcp/pipelines/workspace", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-harness-token": ensureToken(),
      [PIPELINE_CALLER_CREDENTIAL_HEADER]: "workspace-route-valid",
    },
    body: JSON.stringify({ path: repoRoot }),
  });
  assert.equal(outside.status, 409);
  assert.deepEqual(await outside.json(), {
    error: "the Pipeline workspace must be a direct .worktrees checkout of this task repository",
  });

  const owner = mkTask({
    id: "pipeline-workspace-route-owner",
    agent: "codex",
    kind: "pipeline",
    repoRoot,
    status: "running",
    pipelineWorkspacePath: workspace,
  });
  registry.upsertTask(owner);
  const conflict = await app.request("/mcp/pipelines/workspace", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-harness-token": ensureToken(),
      [PIPELINE_CALLER_CREDENTIAL_HEADER]: "workspace-route-valid",
    },
    body: JSON.stringify({ path: workspace }),
  });
  assert.equal(conflict.status, 409);
  assert.deepEqual(await conflict.json(), {
    error: `the Pipeline workspace is already owned by active task ${owner.id}`,
  });
  assert.equal(registry.getTask(task.id)?.pipelineWorkspacePath ?? null, null);
});
