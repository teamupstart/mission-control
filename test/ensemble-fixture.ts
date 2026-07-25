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
  EnsembleFinalizeDeps,
  EnsembleTaskGateway,
  EnsembleWorkflowHandoffDeps,
  MemberDispatchRequest,
  MemberTaskRequest,
  ReplacementTaskRequest,
  TaskGatewayStatus,
} from "../src/server/ensembles/engine.ts";
import type { EnsembleJson } from "../src/shared/ensemble.ts";
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
  readonly dispatchFailures = new Set<string>();
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

  private allDispatchFail = false;

  async dispatch(request: MemberDispatchRequest): Promise<void> {
    if (this.allDispatchFail || this.dispatchFailures.has(request.taskId)) {
      throw new Error(`dispatch refused for ${request.taskId}`);
    }
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
  failDispatch(taskId: string): void {
    this.dispatchFailures.add(taskId);
  }
  failAllDispatches(): void {
    this.allDispatchFail = true;
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

/** The `snapshotSha` off a git_snapshot locator, so a fake verify can echo the real artifact. */
export function locatorSnapshotSha(locator: EnsembleJson): string | null {
  return locator && typeof locator === "object" && !Array.isArray(locator) && typeof locator.snapshotSha === "string"
    ? locator.snapshotSha
    : null;
}

/** A fake Workflow handoff boundary a test drives and inspects. Defaults make a handoff succeed. */
export class FakeWorkflow implements EnsembleWorkflowHandoffDeps {
  readonly bindings: Array<{ sessionId: string; workflowVersionId: string; sourceId: string; resultId: string }> = [];
  readonly submits: Array<{ bindingId: string; expectedHeadSha: string }> = [];
  bindResult: { ok: true; bindingId: string; created: boolean } | { ok: false; reason: "conflict" | "unavailable" | "ineligible" | "other"; detail: string } = {
    ok: true,
    bindingId: "binding-1",
    created: true,
  };
  submitResult: { ok: true; runId: string; submissionId: string } | { ok: false; reason: "mismatch" | "conflict" | "unavailable" | "other"; detail: string } = {
    ok: true,
    runId: "wfrun-1",
    submissionId: "wfsub-1",
  };
  ensureBinding(input: { sessionId: string; workflowVersionId: string; sourceId: string; resultId: string }) {
    this.bindings.push(input);
    return this.bindResult;
  }
  async submit(input: { bindingId: string; sourceId: string; resultId: string; expectedHeadSha: string }) {
    this.submits.push({ bindingId: input.bindingId, expectedHeadSha: input.expectedHeadSha });
    return this.submitResult;
  }
}

/**
 * A fake finalize-deps a test drives and inspects. Defaults make the restored-winner path succeed;
 * set `safeIdle = false` for the replacement path, and attach a `FakeWorkflow` for the handoff.
 */
export class FakeFinalize implements EnsembleFinalizeDeps {
  readonly restored: Array<{ sessionId: string; snapshotSha: string }> = [];
  readonly continuations: Array<{ sessionId: string; text: string }> = [];
  readonly materialized: ReplacementTaskRequest[] = [];
  verify: (locator: EnsembleJson) => string | null = locatorSnapshotSha;
  safeIdle = true;
  restoreOk = true;
  headClean = true;
  /** When set, the next `worktreeHead` reports the checkout drifted; a restore clears it. */
  driftPending = false;
  deliverOk = true;
  deliverRetryable = true;
  materializeOk = true;
  /** When true, a materialized replacement starts `dispatching` (no session) - the async-launch case. */
  materializeAsDispatching = false;
  private lastRestoredSha: string | null = null;
  private readonly replacements = new Map<string, { status: TaskGatewayStatus | null; sessionId: string | null; worktreePath: string | null }>();
  workflow?: EnsembleWorkflowHandoffDeps;

  async verifyArtifact({ locator }: { locator: EnsembleJson; repoPath: string }) {
    return this.verify(locator);
  }
  async sessionSafeToRebind() {
    return this.safeIdle;
  }
  async restoreWinner(input: { sessionId: string; snapshotSha: string; ref: string }) {
    this.restored.push({ sessionId: input.sessionId, snapshotSha: input.snapshotSha });
    this.lastRestoredSha = input.snapshotSha;
    this.driftPending = false; // a successful restore returns the checkout to its snapshot
    return this.restoreOk ? { ok: true as const } : { ok: false as const, detail: "restore failed" };
  }
  async worktreeHead() {
    if (this.driftPending) return { headSha: this.lastRestoredSha, clean: false };
    return { headSha: this.lastRestoredSha, clean: this.headClean };
  }
  async deliverContinuation(input: { sessionId: string; text: string }) {
    this.continuations.push(input);
    return this.deliverOk
      ? { ok: true as const }
      : {
          ok: false as const,
          retryable: this.deliverRetryable,
          detail: "the pane was busy",
        };
  }
  async materializeReplacement(request: ReplacementTaskRequest) {
    this.materialized.push(request);
    if (!this.materializeOk) return { ok: false as const, detail: "materialize failed" };
    const existing = this.replacements.get(request.taskId);
    if (!existing || existing.status === "backlog") {
      this.replacements.set(
        request.taskId,
        this.materializeAsDispatching
          ? { status: "dispatching", sessionId: null, worktreePath: null }
          : { status: "running", sessionId: `repl-${request.taskId}`, worktreePath: `/repl/${request.taskId}` },
      );
    }
    return { ok: true as const };
  }
  seedReplacement(taskId: string, status: TaskGatewayStatus) {
    this.replacements.set(taskId, {
      status,
      sessionId: status === "running" ? `repl-${taskId}` : null,
      worktreePath: status === "running" ? `/repl/${taskId}` : null,
    });
  }
  /** The task update that brings a `dispatching` replacement up to a live `running` session. */
  bringReplacementUp(taskId: string) {
    this.replacements.set(taskId, { status: "running", sessionId: `repl-${taskId}`, worktreePath: `/repl/${taskId}` });
  }
  replacementStatus(taskId: string) {
    return this.replacements.get(taskId) ?? { status: null, sessionId: null, worktreePath: null };
  }
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

/**
 * A plan that reaches a human decision WITHOUT a review executor: member wave, then a decision
 * stage gated straight on the members-settled barrier, then a select-one finalize gated on the
 * human decision. It lets a finalization test drive `awaiting_decision` -> `decide` -> `finalizing`
 * without standing up a comparative-review model call, which is exercised elsewhere.
 */
export function decidePlan(count = 2, minEligible = 2): CompiledEnsemblePlan {
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
        id: "stage-decide",
        ordinal: 2,
        label: "Decision",
        driverKind: "decision",
        driverKey: "human_decision@1",
        dependsOn: ["stage-1"],
        barrier: { kind: "members_settled", roleKeys, minEligible, requiredArtifacts: ["commit"] },
        maxAttempts: 1,
        decision: { kind: "select_one", eligibleArtifactKind: "commit", minEligibleSubjects: minEligible },
      },
      {
        id: "stage-finalize",
        ordinal: 3,
        label: "Promotion",
        driverKind: "finalize",
        driverKey: "select_one_finalize@1",
        dependsOn: ["stage-decide"],
        barrier: { kind: "human_decision" },
        maxAttempts: 2,
        finalization: { kind: "select_one", requiresHumanDecision: true, loserPolicy: "reap_worktrees" },
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
    workflowHandoff: null,
    requestFingerprint: "",
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
