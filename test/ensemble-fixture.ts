import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ENSEMBLE_PLAN_VERSION,
  type CompiledEnsemblePlan,
  type EnsembleRoleSpec,
  type EnsembleStageSpec,
} from "../src/shared/ensemble.ts";
import type { EnsembleRunInsert } from "../src/server/ensembles/store.ts";
import type {
  EnsembleTaskGateway,
  MemberDispatchRequest,
  MemberTaskRequest,
  TaskGatewayStatus,
} from "../src/server/ensembles/engine.ts";
import type {
  ArtifactAdapter,
  ArtifactAdapterRegistry,
  ArtifactCaptureInput,
} from "../src/server/ensembles/artifacts/index.ts";
import { ARTIFACT_ADAPTERS } from "../src/server/ensembles/artifacts/index.ts";

/**
 * The shared bench for Phase 4's engine, submission, recovery and artifact tests.
 *
 * Nothing here spawns a real agent: a `FakeGateway` stands in for TaskManager so a test can move a
 * member's Task through its whole life by hand, and a stub artifact adapter captures a deterministic
 * fake commit so the engine's barrier and wave logic can be exercised without touching Git. The
 * tests that DO need real Git (the git_snapshot adapter, real evidence) use `gitRepo` and the real
 * adapters instead.
 */

/** A deterministic 40-hex sha derived from any string, so a stub capture has a stable snapshot id. */
export function fakeSha(seed: string): string {
  return createHash("sha1").update(seed).digest("hex");
}

/** A real, one-commit Git repository, for the tests that capture and diff for real. */
export function gitRepo(): { path: string; baseSha: string } {
  const path = mkdtempSync(join(tmpdir(), "mission-ensemble-repo-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", path, ...args], { encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "test@localhost");
  git("config", "user.name", "Test");
  writeFileSync(join(path, "README.md"), "base\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  const baseSha = git("rev-parse", "HEAD").trim();
  return { path, baseSha };
}

/**
 * A TaskManager stand-in the tests drive by hand.
 *
 * `create` mints a task id and records what the engine asked for; `dispatch` records the launch and
 * moves the task to `dispatching`. A test then calls `running`/`fail`/`vanish` to say what happened
 * to the process, and `engine.wake` folds that into member state - which is exactly the "observe
 * durable Task state, never trust the dispatch call" the engine is built around.
 */
export class FakeGateway implements EnsembleTaskGateway {
  readonly created: Array<MemberTaskRequest & { taskId: string }> = [];
  readonly dispatched: MemberDispatchRequest[] = [];
  readonly cancelled: string[] = [];
  readonly cancelFailures = new Set<string>();
  /** Every create/dispatch in order, so a test can prove a whole wave existed before a dispatch. */
  readonly log: string[] = [];
  private readonly state = new Map<
    string,
    { status: TaskGatewayStatus; worktreePath: string | null; sessionId: string | null }
  >();

  create(request: MemberTaskRequest): void {
    const taskId = request.taskId;
    if (this.state.has(taskId)) return;
    this.created.push({ ...request, taskId });
    this.log.push(`create:${taskId}`);
    this.state.set(taskId, { status: "backlog", worktreePath: null, sessionId: null });
  }

  dispatch(request: MemberDispatchRequest): void {
    this.dispatched.push(request);
    this.log.push(`dispatch:${request.taskId}`);
    const t = this.state.get(request.taskId);
    if (t) t.status = "dispatching";
  }

  async cancel(taskId: string): Promise<void> {
    if (this.cancelFailures.has(taskId)) throw new Error(`cannot cancel ${taskId}`);
    this.cancelled.push(taskId);
    const t = this.state.get(taskId);
    if (t) t.status = "cancelled";
  }

  status(taskId: string): TaskGatewayStatus | null {
    return this.state.get(taskId)?.status ?? null;
  }
  worktreePath(taskId: string): string | null {
    return this.state.get(taskId)?.worktreePath ?? null;
  }
  sessionId(taskId: string): string | null {
    return this.state.get(taskId)?.sessionId ?? null;
  }
  observedModel(): string | null {
    return null;
  }

  // ---- test controls ----

  /** Mark a dispatched member's task live, at a worktree and session. */
  running(taskId: string, worktreePath: string, sessionId = `sess-${taskId}`): void {
    this.state.set(taskId, { status: "running", worktreePath, sessionId });
  }
  fail(taskId: string): void {
    const t = this.state.get(taskId);
    if (t) t.status = "failed";
  }
  vanish(taskId: string): void {
    this.state.delete(taskId);
  }
  failCancel(taskId: string): void {
    this.cancelFailures.add(taskId);
  }
  /** The most recent task id created for a given member id. */
  taskFor(memberOrdinalTitle: string): string | undefined {
    return this.created.find((c) => c.title.includes(memberOrdinalTitle))?.taskId;
  }
}

/**
 * A stub artifact adapter that captures a deterministic fake commit without touching Git.
 *
 * The snapshot sha is derived from the artifact id, so a parent-wave member's snapshot is a stable,
 * assertable value a second wave can be checked to have started from. The real registry's other
 * kinds are kept, so only `commit` is faked.
 */
export function stubAdapters(): ArtifactAdapterRegistry {
  const commit: ArtifactAdapter = {
    kind: "commit",
    formatVersion: 1,
    async capture(input: ArtifactCaptureInput) {
      const snapshotSha = fakeSha(`snapshot:${input.artifactId}`);
      return {
        locator: {
          kind: "git_snapshot",
          formatVersion: 1,
          ref: `refs/mission-control/ensembles/${input.runId}/${input.artifactId}`,
          snapshotSha,
          baseSha: input.baseSha,
          parentSha: input.baseSha,
          treeSha: fakeSha(`tree:${input.artifactId}`),
        },
        fingerprint: fakeSha(`tree:${input.artifactId}`),
        observed: { filesChanged: 1, insertions: 1, deletions: 0, dirty: true },
      };
    },
    async recover() {
      return null;
    },
    async materialize() {
      return { files: [], filesChanged: 0, insertions: 0, deletions: 0, patch: "", truncated: false, omittedBytes: 0 };
    },
    async verify() {
      return true;
    },
    async restore() {},
  };
  return { ...ARTIFACT_ADAPTERS, commit };
}

/** A stub whose capture always throws, for the "capture failed, member stays active" case. */
export function failingAdapters(): ArtifactAdapterRegistry {
  return {
    ...ARTIFACT_ADAPTERS,
    commit: {
      kind: "commit",
      formatVersion: 1,
      async capture() {
        throw new Error("stub capture failure");
      },
      async recover() {
        return null;
      },
      async materialize() {
        return { files: [], filesChanged: 0, insertions: 0, deletions: 0, patch: "", truncated: false, omittedBytes: 0 };
      },
      async verify() {
        return true;
      },
      async restore() {},
    },
  };
}

// ---- plan builders ----

function role(over: Partial<EnsembleRoleSpec> & { key: string; ordinal: number }): EnsembleRoleSpec {
  return {
    label: `Candidate ${over.ordinal}`,
    wave: 1,
    agent: null,
    model: null,
    effort: null,
    approach: null,
    promptTemplate: "work alone",
    requiredArtifacts: ["commit"],
    input: { kind: "run_base" },
    ...over,
  };
}

function memberStage(over: Partial<Extract<EnsembleStageSpec, { driverKind: "member" }>> & { id: string; ordinal: number; roleKeys: string[] }): EnsembleStageSpec {
  return {
    label: "Candidates",
    driverKind: "member",
    driverKey: "member_wave@1",
    dependsOn: [],
    barrier: { kind: "none" },
    maxAttempts: 1,
    wave: 1,
    ...over,
  };
}

/** A one-wave plan of N members, each from the run base, no downstream stage. */
export function singleWavePlan(count: number, budget: Partial<CompiledEnsemblePlan["budget"]> = {}): CompiledEnsemblePlan {
  const roles = Array.from({ length: count }, (_, i) => role({ key: `candidate-${i + 1}`, ordinal: i + 1 }));
  return {
    planVersion: ENSEMBLE_PLAN_VERSION,
    strategyKey: "best_of_n@1",
    budget: { maxMembers: count, maxConcurrentMembers: count, maxWaves: 1, maxStageAttempts: 2, deadlineMs: null, ...budget },
    information: { kind: "isolated" },
    roles,
    stages: [memberStage({ id: "stage-1", ordinal: 1, roleKeys: roles.map((r) => r.key) })],
  };
}

/**
 * A two-wave plan: wave 1 has `first` run-base members, wave 2 has one member that starts from the
 * FIRST wave-1 member's parent artifact and is gated on the wave-1 barrier.
 */
export function twoWavePlan(first = 2): CompiledEnsemblePlan {
  const waveA = Array.from({ length: first }, (_, i) => role({ key: `a-${i + 1}`, ordinal: i + 1, wave: 1 }));
  const waveB = role({
    key: "b-1",
    ordinal: first + 1,
    wave: 2,
    label: "Reviser",
    input: { kind: "parent_artifacts", roleKeys: ["a-1"] },
  });
  return {
    planVersion: ENSEMBLE_PLAN_VERSION,
    strategyKey: "best_of_n@1",
    budget: { maxMembers: first + 1, maxConcurrentMembers: first + 1, maxWaves: 2, maxStageAttempts: 2, deadlineMs: null },
    information: { kind: "isolated" },
    roles: [...waveA, waveB],
    stages: [
      memberStage({ id: "stage-1", ordinal: 1, roleKeys: waveA.map((r) => r.key) }),
      memberStage({
        id: "stage-2",
        ordinal: 2,
        wave: 2,
        label: "Second wave",
        roleKeys: ["b-1"],
        dependsOn: ["stage-1"],
        barrier: { kind: "members_settled", roleKeys: waveA.map((r) => r.key), minEligible: 1, requiredArtifacts: ["commit"] },
      }),
    ],
  };
}

/** A one-wave plan whose downstream review stage parks (its driver is not executable this phase). */
export function reviewPlan(count = 2, minEligible = 2): CompiledEnsemblePlan {
  const roles = Array.from({ length: count }, (_, i) => role({ key: `candidate-${i + 1}`, ordinal: i + 1 }));
  const roleKeys = roles.map((r) => r.key);
  return {
    planVersion: ENSEMBLE_PLAN_VERSION,
    strategyKey: "best_of_n@1",
    budget: { maxMembers: count, maxConcurrentMembers: count, maxWaves: 1, maxStageAttempts: 2, deadlineMs: null },
    information: { kind: "isolated" },
    roles,
    stages: [
      memberStage({ id: "stage-1", ordinal: 1, roleKeys }),
      {
        id: "stage-2",
        ordinal: 2,
        label: "Comparison",
        driverKind: "review",
        driverKey: "comparative_review@1",
        dependsOn: ["stage-1"],
        barrier: { kind: "members_settled", roleKeys, minEligible, requiredArtifacts: ["commit"] },
        maxAttempts: 2,
        evaluator: {
          kind: "comparative_llm",
          guidance: { kind: "builtin", rubricId: "best_of_n_v1" },
          runner: null,
          model: null,
          anonymizeSubjects: true,
          materialBudgetBytes: 400 * 1024,
        },
        subjects: { kind: "ready_artifacts", artifactKind: "commit", minSubjects: 2, maxSubjects: count },
      },
    ],
  };
}

/** An EnsembleRunInsert around a plan, ready to launch (a pinned base, status running). */
export function runInsert(
  plan: CompiledEnsemblePlan,
  over: Partial<EnsembleRunInsert> = {},
): EnsembleRunInsert {
  return {
    sourceKind: "manual",
    sourceKey: `manual:${Math.abs(hash(JSON.stringify(plan.roles)))}`,
    sourceId: null,
    strategyId: "best_of_n",
    strategyVersion: 1,
    strategyKey: plan.strategyKey,
    strategyLabel: "Best of N",
    title: "Try approaches",
    intent: "Implement the feature",
    repoRoot: "/repo",
    baseBranch: "main",
    baseSha: fakeSha("base"),
    plan,
    strategyConfig: {},
    status: "running",
    members: plan.roles.map((r) => ({ roleKey: r.key, roleLabel: r.label, ordinal: r.ordinal, wave: r.wave })),
    ...over,
  };
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

export { ARTIFACT_ADAPTERS };
