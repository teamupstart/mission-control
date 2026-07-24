import {
  ENSEMBLE_LIMITS,
  ENSEMBLE_SOURCE_KINDS,
  ensemblePayload,
  ensembleStrategyKey,
  readEnsembleEnum,
  type CompiledEnsemblePlan,
  type EnsembleArtifact,
  type EnsembleCreateInput,
  type EnsembleDecision,
  type EnsembleJson,
  type EnsembleRun,
  type EnsembleRunDetail,
  type EnsembleSummary,
  type TaskEnsembleLink,
} from "@shared/ensemble.ts";
import {
  EnsembleCreateInputSchema,
  type EnsembleSubmissionClaims,
} from "@shared/protocol.ts";
import type { Registry } from "../registry.ts";
import { AGENT_TYPES, type AgentType } from "@shared/types.ts";
import { supportsEffort } from "@shared/harness-capabilities.ts";
import { agentBinPresent } from "../dispatcher.ts";
import { resolveDispatchEffort } from "../harnesses.ts";
import { harnessFor } from "../harness/index.ts";
import { missionMcpDescriptor } from "../mission-mcp.ts";
import { resolveTaskRepoRoot } from "../repos.ts";
import { run } from "../util/exec.ts";
import {
  EnsembleStore,
  type EnsembleDecisionInsert,
  type EnsembleMemberInsert,
} from "./store.ts";
import {
  EnsembleEngine,
  type EnsembleSubmitRefusal,
  type EnsembleTaskGateway,
} from "./engine.ts";
import type { ArtifactAdapterRegistry } from "./artifacts/index.ts";
import { ARTIFACT_ADAPTERS } from "./artifacts/index.ts";
import {
  descriptorFor,
  ensembleStrategyCatalog,
  type StrategyCatalog,
  type StrategyCompileContext,
  type StrategyDescriptor,
  type StrategyIssue,
} from "./strategies/index.ts";

/**
 * Validation, compilation, strategy-neutral execution and the compact projection.
 *
 * This is the daemon-facing boundary for ensembles. It compiles and persists immutable plans,
 * preflights and pins launch inputs, delegates ordinary Task lifecycle through the injected
 * gateway, captures submissions through artifact adapters, recovers non-terminal runs, and
 * publishes the compact summaries the browser's live state receives. Production deliberately
 * exposes no CREATE route yet: review, decision and finalization drivers park until their
 * implementations land, so a half-built Best-of-N orchestration cannot be reached by a user.
 *
 * The catalog and the store are constructor arguments rather than module globals so a test
 * can drive a descriptor of its own against a temp database - and so the production catalog
 * can stay one exhaustive `Record<EnsembleStrategyId, …>` instead of a registry things
 * mutate at import time.
 */

/** Why a create was refused, in the terms a form can act on. */
export type EnsembleCreateRefusal =
  | "unknown_strategy"
  | "strategy_disabled"
  | "version_unavailable"
  | "invalid_config"
  | "preflight_failed";

export type EnsembleCreateOutcome =
  | { ok: true; run: EnsembleRun; summary: EnsembleSummary; created: boolean }
  | { ok: false; reason: EnsembleCreateRefusal; issues: StrategyIssue[] };

/** A resolved, pinned repository state a run's members will all be cut from. */
interface PreflightResult {
  repoRoot: string;
  baseSha: string;
  baseBranch: string | null;
}

/** Why a submission was refused, on top of the engine's own capture refusals. */
export type EnsembleSubmitReason = EnsembleSubmitRefusal | "no_session" | "no_engine";

export type EnsembleSubmitResult =
  | { ok: true; artifact: EnsembleArtifact; replayed: boolean }
  | { ok: false; reason: EnsembleSubmitReason; detail: string };

export interface EnsembleManagerOptions {
  catalog?: StrategyCatalog;
  /**
   * Resolve the Persona a strategy asked to judge with, to an exact revision.
   *
   * Injected rather than imported so compilation stays pure and the manager takes no
   * dependency on the Persona store it does not otherwise need. Absent means no Persona can
   * be resolved, and a config that names one is refused rather than quietly downgraded to a
   * built-in rubric.
   */
  resolvePersona?: (personaId: string) => { id: string; revision: number } | null;
  /**
   * The bridge the engine launches member Tasks through. Present only when the daemon wired one
   * in: without it the manager still validates, compiles and persists runs, but launches nothing -
   * which is exactly what the phases before this one did, and what the read-only tests rely on.
   */
  tasks?: EnsembleTaskGateway;
  /** Artifact adapters, for tests that drive capture against a fake instead of real Git. */
  adapters?: ArtifactAdapterRegistry;
  agentBinPresent?: (agent: AgentType) => Promise<boolean>;
  missionMcpAvailable?: () => Promise<boolean>;
  now?: () => number;
  log?: (level: "info" | "warn" | "error", fields: Record<string, unknown>) => void;
}

export class EnsembleManager {
  private readonly catalog: StrategyCatalog;
  private readonly resolvePersona: (personaId: string) => { id: string; revision: number } | null;
  private readonly engine: EnsembleEngine | null;
  private readonly adapters: ArtifactAdapterRegistry;
  private readonly hasAgentBin: (agent: AgentType) => Promise<boolean>;
  private readonly hasMissionMcp: () => Promise<boolean>;
  private readonly now: () => number;
  private unsubscribe: (() => void) | null = null;

  /**
   * taskId -> member link, rebuilt from the store on every write.
   *
   * A map rather than a query per call because the reader is `Registry.taskSummaryFor`,
   * which runs once per session on every 1.5s discovery sweep. The daemon is the only writer
   * of these rows, so a cache this class invalidates itself cannot go stale behind its back.
   */
  private links = new Map<string, TaskEnsembleLink>();

  constructor(
    private readonly registry: Registry,
    readonly store = new EnsembleStore(),
    options: EnsembleManagerOptions = {},
  ) {
    this.catalog = options.catalog ?? ensembleStrategyCatalog;
    this.resolvePersona = options.resolvePersona ?? (() => null);
    this.now = options.now ?? (() => Date.now());
    this.adapters = options.adapters ?? ARTIFACT_ADAPTERS;
    this.hasAgentBin = options.agentBinPresent ?? agentBinPresent;
    this.hasMissionMcp = options.missionMcpAvailable ?? (async () => (await missionMcpDescriptor()) !== null);
    // The engine exists only when a Task gateway was wired in. It calls back into `publish` after
    // every step, so the two are constructed together with the manager holding the reference.
    this.engine = options.tasks
      ? new EnsembleEngine({
          store: this.store,
          tasks: options.tasks,
          publish: (runId) => this.publish(runId),
          adapters: options.adapters,
          now: this.now,
          log: options.log,
        })
      : null;
    // Boot-time catalog install, before SSE is served, so no incremental emit is needed -
    // the same shape `initializePersonas` / `initializeWorkflows` use.
    this.registry.initializeEnsembles(this.summaries());
    // The task projection is REGISTERED rather than imported by the Registry, which keeps
    // the registry free of an ensemble dependency and keeps the lookup on the daemon side of
    // one seam. It is an in-memory map read, not a query: `taskSummaryFor` runs for every
    // session on every discovery sweep.
    this.store.onTaskLinksChanged(() => this.refreshLinks());
    this.refreshProjection();
    // A member Task changing durable state is the engine's wake signal: a task going idle is not a
    // submission and a task dying is not a completion, so the engine recomputes from durable rows on
    // every wake rather than trusting the event. Only wired when there is an engine to wake.
    if (this.engine) {
      this.unsubscribe = this.registry.subscribe((event) => {
        if (event.type !== "task_upsert" && event.type !== "task_remove") return;
        const taskId = event.type === "task_upsert" ? event.task.id : event.id;
        const member = this.store.memberForTask(taskId);
        if (member) void this.engine!.wake(member.runId);
      });
    }
  }

  /** Detach the wake subscription. The daemon owns the single process; tests call this to be tidy. */
  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** Rebuilt rather than patched: a member LOSING its task matters as much as gaining one. */
  private refreshLinks(): void {
    this.links = new Map(this.store.listTaskLinks().map((row) => [row.taskId, row.link]));
  }

  private refreshProjection(): void {
    this.refreshLinks();
    this.registry.registerEnsembleProjection((taskId) => this.links.get(taskId) ?? null);
  }

  /** Every run, as the compact projection. */
  summaries(): EnsembleSummary[] {
    return this.store.listSummaries();
  }

  detail(id: string): EnsembleRunDetail | null {
    return this.store.detail(id);
  }

  recordDecision(
    input: Omit<EnsembleDecisionInsert, "selection"> & { selection: EnsembleJson },
    now = Date.now(),
  ): EnsembleDecision {
    return this.store.recordDecision(
      { ...input, selection: ensemblePayload(input.selection) },
      now,
    );
  }

  /**
   * Runs a restart would have to reconcile.
   *
   * This is the single definition of "not finished" the startup recovery pass consumes;
   * keeping it on the manager prevents a caller from re-encoding the terminal-status set.
   */
  nonTerminalRuns(): EnsembleRun[] {
    return this.store.listNonTerminalRuns();
  }

  /**
   * Validate, compile and persist one run as a draft. Launches nothing.
   *
   * The order matters and is the invariant the plan states: the run, its immutable strategy
   * snapshot and its whole roster are durable BEFORE anything could be dispatched. A crash
   * after this point leaves rows a later action surface can expose and cancel; a crash before
   * it leaves nothing at all. There is no third outcome where agents exist and the group
   * does not.
   *
   * This path pins no base and launches nothing - `createAndLaunch` is the runtime one. It stays
   * here as the compile-and-persist building block and as the read-only door the earlier phases
   * proved.
   */
  create(input: EnsembleCreateInput, now = Date.now()): EnsembleCreateOutcome {
    const existing = this.existingRun(input);
    if (existing) return existing;
    const compiled = this.compile(input, now);
    if (!compiled.ok) return compiled.outcome;
    const write = this.persistRun(compiled.value, null, null, "planning", now);
    return this.published(write);
  }

  /**
   * The runtime create: preflight, pin one base, persist, and launch the first wave.
   *
   * Preflight resolves and PINS one full commit before anything is written, so every member of the
   * run - this wave and any later one - is cut from byte-identical state even if the source branch
   * moves mid-launch. The persisted run, its whole roster and (through the engine) its first stage
   * attempt all exist before the first dispatch. Idempotent on the source key: a response-loss retry
   * returns the original run and resumes it rather than launching a second fleet.
   */
  async createAndLaunch(input: EnsembleCreateInput, now = this.now()): Promise<EnsembleCreateOutcome> {
    if (!this.engine) {
      return {
        ok: false,
        reason: "preflight_failed",
        issues: [{ path: "", message: "this build has no launch gateway wired in" }],
      };
    }
    const existing = this.existingRun(input);
    if (existing) {
      // A duplicate request returns the original run and resumes it - the engine's own idempotency
      // keys make a second advance harmless, and a run that crashed mid-launch is picked back up.
      if (existing.ok) void this.engine.launch(existing.run.id);
      return existing;
    }
    const compiled = this.compile(input, now);
    if (!compiled.ok) return compiled.outcome;

    const preflight = await this.preflight(compiled.value.plan, input.repoRoot);
    if (!preflight.ok) return { ok: false, reason: "preflight_failed", issues: preflight.issues };

    const write = this.persistRun(
      compiled.value,
      preflight.value.baseSha,
      preflight.value.baseBranch,
      "running",
      now,
      preflight.value.repoRoot,
    );
    const outcome = this.published(write);
    if (write.created) await this.engine.launch(write.run.id);
    else void this.engine.launch(write.run.id);
    return outcome;
  }

  private existingRun(input: EnsembleCreateInput): EnsembleCreateOutcome | null {
    const sourceKind = readEnsembleEnum(ENSEMBLE_SOURCE_KINDS, input.sourceKind);
    const sourceKey =
      typeof input.sourceKey === "string" &&
      input.sourceKey.length > 0 &&
      input.sourceKey.length <= ENSEMBLE_LIMITS.sourceKey
        ? input.sourceKey
        : null;
    const existing =
      sourceKind !== null && sourceKey !== null ? this.store.runBySource(sourceKind, sourceKey) : null;
    if (!existing) return null;
    const summary = this.publish(existing.id);
    if (!summary) throw new Error(`ensemble ${existing.id} has no summary for its source claim`);
    return { ok: true, run: existing, summary, created: false };
  }

  /** Parse, resolve the descriptor, and compile - the pure half both create paths share. */
  private compile(
    input: EnsembleCreateInput,
    now: number,
  ):
    | { ok: true; value: { descriptor: StrategyDescriptor; plan: CompiledEnsemblePlan; config: EnsembleJson; request: ReturnType<typeof EnsembleCreateInputSchema.parse> } }
    | { ok: false; outcome: EnsembleCreateOutcome } {
    const parsed = EnsembleCreateInputSchema.safeParse(input);
    if (!parsed.success) {
      return {
        ok: false,
        outcome: {
          ok: false,
          reason: "invalid_config",
          issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
        },
      };
    }
    const request = parsed.data;
    const descriptor = descriptorFor(this.catalog, request.strategyId);
    if (!descriptor) {
      return {
        ok: false,
        outcome: {
          ok: false,
          reason: "unknown_strategy",
          issues: [{ path: "strategyId", message: `unknown strategy ${request.strategyId}` }],
        },
      };
    }
    if (!descriptor.enabled) {
      return {
        ok: false,
        outcome: {
          ok: false,
          reason: "strategy_disabled",
          issues: [{ path: "strategyId", message: `${descriptor.label} cannot be created by this build` }],
        },
      };
    }
    // A pinned version this build does not compile is a refusal, never a silent upgrade: the
    // operator asked for a specific behaviour, and running a newer one would be a different
    // ensemble wearing the version they chose.
    if (request.strategyVersion !== undefined && request.strategyVersion !== descriptor.compilesVersion) {
      return {
        ok: false,
        outcome: {
          ok: false,
          reason: "version_unavailable",
          issues: [
            {
              path: "strategyVersion",
              message: `this build compiles ${descriptor.id} at version ${descriptor.compilesVersion}`,
            },
          ],
        },
      };
    }
    const config = request.strategyConfig ?? {};
    const context = this.compileContext(request.repoRoot, config, now);
    if (!context.ok) return { ok: false, outcome: { ok: false, reason: "invalid_config", issues: context.issues } };
    const compiled = descriptor.compile(config, context.value);
    if (!compiled.ok) return { ok: false, outcome: { ok: false, reason: "invalid_config", issues: compiled.issues } };
    return { ok: true, value: { descriptor, plan: compiled.plan, config: compiled.config, request } };
  }

  private persistRun(
    compiled: { descriptor: StrategyDescriptor; plan: CompiledEnsemblePlan; config: EnsembleJson; request: ReturnType<typeof EnsembleCreateInputSchema.parse> },
    baseSha: string | null,
    baseBranch: string | null,
    status: "planning" | "running",
    now: number,
    repoRoot?: string,
  ) {
    const { descriptor, plan, config, request } = compiled;
    const members: EnsembleMemberInsert[] = plan.roles.map((role) => ({
      roleKey: role.key,
      roleLabel: role.label,
      ordinal: role.ordinal,
      wave: role.wave,
    }));
    return this.store.createRun(
      {
        sourceKind: request.sourceKind,
        sourceKey: request.sourceKey,
        sourceId: request.sourceId,
        strategyId: descriptor.id,
        strategyVersion: descriptor.compilesVersion,
        strategyKey: ensembleStrategyKey(descriptor.id, descriptor.compilesVersion),
        strategyLabel: descriptor.label,
        title: request.title,
        intent: request.intent,
        repoRoot: repoRoot ?? request.repoRoot,
        baseBranch,
        baseSha,
        plan,
        strategyConfig: config,
        status,
        members,
      },
      now,
    );
  }

  private published(write: { run: EnsembleRun; created: boolean }): EnsembleCreateOutcome {
    const summary = this.publish(write.run.id);
    if (!summary) throw new Error(`ensemble ${write.run.id} has no summary immediately after creation`);
    return { ok: true, run: write.run, summary, created: write.created };
  }

  /**
   * Canonicalize the repository, pin one full commit, and prove every member's harness is installed.
   *
   * The base is `git rev-parse HEAD^{commit}` resolved ONCE and stored full: comparison between
   * members is meaningless if their starting points differ, and a ref name would mean something
   * different an hour later. The branch is recorded separately and is informational. A missing
   * harness binary fails the whole create up front rather than one member at a time after launch.
   */
  private async preflight(
    plan: CompiledEnsemblePlan,
    repoRoot: string,
  ): Promise<{ ok: true; value: PreflightResult } | { ok: false; issues: StrategyIssue[] }> {
    const resolved = await resolveTaskRepoRoot(repoRoot);
    if (!resolved.ok) return { ok: false, issues: [{ path: "repoRoot", message: resolved.error }] };
    const canonical = resolved.repoRoot;

    const head = await run("git", ["-C", canonical, "rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
    const baseSha = head.stdout.trim();
    if (head.code !== 0 || !/^[0-9a-f]{40}$/.test(baseSha)) {
      return {
        ok: false,
        issues: [{ path: "repoRoot", message: `could not resolve a base commit in ${canonical}` }],
      };
    }
    const branchRun = await run("git", ["-C", canonical, "rev-parse", "--abbrev-ref", "HEAD"]);
    const branch = branchRun.stdout.trim();
    const baseBranch = branchRun.code === 0 && branch && branch !== "HEAD" ? branch : null;

    const agents = new Set<AgentType>();
    for (const [index, role] of plan.roles.entries()) {
      const agent = role.agent ?? AGENT_TYPES[0];
      agents.add(agent);
      // Model is deliberately NOT validated against MODEL_CATALOG: that catalog is documented
      // incomplete, and ordinary dispatch preserves a valid off-catalog model id rather than
      // rejecting it. Preflight matches that - it refuses only DEMONSTRABLE harness
      // incompatibilities (effort below, and a missing binary), never a model the catalog merely
      // does not list, which would silently strip the off-catalog support dispatch already gives.
      const effort = resolveDispatchEffort(agent, role.effort);
      if (effort !== null && !supportsEffort(agent, effort)) {
        return {
          ok: false,
          issues: [{ path: `roles.${index}.effort`, message: `reasoning effort ${effort} is not supported by ${agent}` }],
        };
      }
      for (const kind of role.requiredArtifacts) {
        if (kind !== "commit" || this.adapters[kind] === null) {
          return {
            ok: false,
            issues: [{ path: `roles.${index}.requiredArtifacts`, message: `artifact ${kind} cannot be submitted by this runtime` }],
          };
        }
      }
      if (harnessFor(agent).mcp === null) {
        return {
          ok: false,
          issues: [{ path: `roles.${index}.agent`, message: `${agent} cannot carry the required submission tool` }],
        };
      }
    }
    for (const agent of agents) {
      if (!(await this.hasAgentBin(agent))) {
        return { ok: false, issues: [{ path: "strategyConfig", message: `the ${agent} binary is not installed` }] };
      }
    }
    if (!(await this.hasMissionMcp())) {
      return {
        ok: false,
        issues: [{ path: "strategyConfig", message: "the Mission MCP bundle required for member submission is unavailable" }],
      };
    }
    return { ok: true, value: { repoRoot: canonical, baseSha, baseBranch } };
  }

  // ---- submission ----

  /**
   * Attribute an MCP submission to its member, server-side, then capture it.
   *
   * The whole security of the submission tool is that a member never names itself: the caller's
   * authenticated runtime - pane token, agent session id, or a unique cwd - resolves to ONE live
   * session, that session to the Task it is running, and that Task to at most one ensemble member.
   * A guessed id reaches nothing. The session's cwd must be the member's live worktree, which is
   * what stops a session in the wrong tree from submitting for a member it merely shares a repo with.
   */
  async submitFromSession(input: {
    env: Parameters<Registry["findSessionByEnv"]>[0];
    sessionId: string | null;
    cwd: string | null;
    claims: EnsembleSubmissionClaims;
  }): Promise<EnsembleSubmitResult> {
    if (!this.engine) return { ok: false, reason: "no_engine", detail: "this build cannot accept submissions" };
    const session = this.registry.findSessionByEnv(
      input.env,
      input.sessionId ?? undefined,
      input.cwd ?? undefined,
    );
    if (!session || session.state === "exited") {
      return { ok: false, reason: "no_session", detail: "no live session matched this request" };
    }
    const task = this.registry.taskForSession(session.id, session.cwd);
    if (!task) return { ok: false, reason: "no_member", detail: "this session is not running an ensemble member" };
    const member = this.store.memberForTask(task.id);
    if (!member) return { ok: false, reason: "no_member", detail: "this session's task is not an ensemble member" };
    return this.engine.submit({
      runId: member.runId,
      memberId: member.id,
      claims: input.claims,
      source: "mcp",
      requireWorktree: session.cwd,
    });
  }

  /**
   * The manual submission fallback: an explicit operator act that names the member in the URL.
   *
   * Named rather than attributed, but not trusted for it: the daemon still runs the same capture
   * service, so the member must be active and hold a live worktree or the submission is refused.
   * The result is labelled `operator`; it never borrows a session's provenance.
   */
  async submitManual(runId: string, memberId: string, claims: EnsembleSubmissionClaims): Promise<EnsembleSubmitResult> {
    if (!this.engine) return { ok: false, reason: "no_engine", detail: "this build cannot accept submissions" };
    const member = this.store.getMember(memberId);
    if (!member || member.runId !== runId) {
      return { ok: false, reason: "no_member", detail: "no such member in this run" };
    }
    return this.engine.submit({ runId, memberId, claims, source: "operator", requireWorktree: null });
  }

  // ---- internal recovery actions (Phase 6 exposes the complete action API) ----

  async cancelRun(runId: string, reason: string | null): Promise<boolean> {
    return this.engine ? this.engine.cancelRun(runId, reason) : false;
  }

  async withdrawMember(runId: string, memberId: string, reason: string | null = null): Promise<boolean> {
    return this.engine ? this.engine.withdrawMember(runId, memberId, reason) : false;
  }

  async retryMember(runId: string, memberId: string): Promise<boolean> {
    return this.engine ? this.engine.retryMember(runId, memberId) : false;
  }

  async retryStage(runId: string, stageId: string): Promise<boolean> {
    return this.engine ? this.engine.retryStage(runId, stageId) : false;
  }

  async restoreArtifact(runId: string, artifactId: string): Promise<{ ok: boolean; detail?: string }> {
    return this.engine ? this.engine.restoreArtifact(runId, artifactId) : { ok: false, detail: "no engine" };
  }

  /**
   * Resume every non-terminal run after a restart.
   *
   * Called once the Task registry has been reconstructed, so the engine's reconcile sees real Task
   * state rather than an empty one. Each run recovers under its own lock and republishes; because
   * every command carries a durable idempotency key, resuming cannot duplicate a Task, member,
   * attempt, artifact or wave.
   */
  async recoverNonTerminalRuns(): Promise<void> {
    if (!this.engine) return;
    for (const run of this.store.listNonTerminalRuns()) {
      try {
        await this.engine.recover(run.id);
      } catch (err) {
        console.error(`[ensemble] recovery failed for run ${run.id}:`, err);
      }
    }
  }

  /**
   * Re-read one run and push its compact summary onto the live channel.
   *
   * After the transaction, never inside it: an SSE emission cannot be rolled back, so a
   * write that can still fail must not be the thing that announced itself.
   */
  publish(id: string): EnsembleSummary | null {
    this.refreshProjection();
    const summary = this.store.summary(id);
    if (summary) this.registry.upsertEnsemble(summary);
    return summary;
  }

  /** Drop one run's history and stop describing it on the live channel. */
  remove(id: string): boolean {
    const removed = this.store.deleteRun(id);
    if (removed) {
      this.refreshLinks();
      this.registry.removeEnsemble(id);
    }
    return removed;
  }

  private compileContext(
    repoRoot: string,
    config: unknown,
    now: number,
  ): { ok: true; value: StrategyCompileContext } | { ok: false; issues: StrategyIssue[] } {
    // The only impure part of compilation, lifted out of it: a Persona id in the config is
    // resolved to an exact revision here, and the descriptor either receives that resolution
    // or refuses. Reading the id out of the raw blob is deliberate - the descriptor owns the
    // config's type, and this only needs to know whether a name was mentioned.
    const personaId =
      config && typeof config === "object" && "evaluator" in config
        ? readPersonaId((config as { evaluator: unknown }).evaluator)
        : null;
    if (personaId === null) {
      return { ok: true, value: { repoRoot, persona: null, now } };
    }
    const persona = this.resolvePersona(personaId);
    if (!persona) {
      return {
        ok: false,
        issues: [{ path: "strategyConfig.evaluator.personaId", message: `no Persona ${personaId}` }],
      };
    }
    return { ok: true, value: { repoRoot, persona, now } };
  }
}

function readPersonaId(evaluator: unknown): string | null {
  if (!evaluator || typeof evaluator !== "object" || !("personaId" in evaluator)) return null;
  const value = (evaluator as { personaId: unknown }).personaId;
  return typeof value === "string" && value !== "" ? value : null;
}
