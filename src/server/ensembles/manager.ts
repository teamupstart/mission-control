import { createHash } from "node:crypto";
import {
  ENSEMBLE_LIMITS,
  canonicalEnsembleJson,
  ensembleIsTerminal,
  ensemblePayload,
  ensembleStrategyKey,
  type CompiledEnsemblePlan,
  type EnsembleAction,
  type EnsembleArtifact,
  type EnsembleCreateInput,
  type EnsembleDecision,
  type EnsembleJson,
  type EnsembleLaunchEstimate,
  type EnsembleReviewPersona,
  type EnsembleRun,
  type EnsembleRunDetail,
  type EnsembleSummary,
  type EnsembleWorkflowHandoff,
  type TaskEnsembleLink,
} from "@shared/ensemble.ts";
import type { LlmRunnerId } from "@shared/llm.ts";
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
  ENSEMBLE_REF_PREFIX,
  ensembleSnapshotRef,
  resolveEnsembleRef,
} from "../git/ensemble-snapshot.ts";
import {
  EnsembleStore,
  type EnsembleDecisionInsert,
  type EnsembleMemberInsert,
} from "./store.ts";
import {
  EnsembleEngine,
  type EnsembleDecideOutcome,
  type EnsembleFinalizeDeps,
  type EnsembleReviewDeps,
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
 * publishes the compact summaries the browser's live state receives. The public create, preview,
 * action and delete routes all enter through this boundary; production creation is enabled only
 * because every driver in the compiled Best-of-N plan has an executable implementation.
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
  | "workflow_unavailable"
  | "request_conflict"
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

/**
 * A Persona looked up for review guidance, as the injected resolver reads it off the store.
 *
 * The whole live record's guidance fields plus whether it is archived - the manager, not the
 * resolver, owns the policy over those (archived is a refusal, a pinned revision that no
 * longer matches is a refusal). Untruncated: the manager caps the guidance to the plan's
 * byte budget when it snapshots it.
 */
export interface ResolvedReviewPersona {
  id: string;
  revision: number;
  name: string;
  guidanceMarkdown: string;
  runner: LlmRunnerId | null;
  model: string | null;
  archived: boolean;
}

export interface EnsembleManagerOptions {
  catalog?: StrategyCatalog;
  /**
   * Resolve the Persona a strategy asked to judge with, to its live record.
   *
   * Injected rather than imported so compilation stays pure and the manager takes no
   * dependency on the Persona store it does not otherwise need. Absent means no Persona can
   * be resolved, and a config that names one is refused rather than quietly downgraded to a
   * built-in rubric. The manager applies the archived / revision-conflict policy; the
   * resolver only reads.
   */
  resolvePersona?: (personaId: string) => ResolvedReviewPersona | null;
  /**
   * The bridge the engine launches member Tasks through. Present only when the daemon wired one
   * in: without it the manager still validates, compiles and persists runs, but launches nothing -
   * which is exactly what the phases before this one did, and what the read-only tests rely on.
   */
  tasks?: EnsembleTaskGateway;
  /** Artifact adapters, for tests that drive capture against a fake instead of real Git. */
  adapters?: ArtifactAdapterRegistry;
  /**
   * The comparison executor - the shared review scheduler, the runner/model resolver, and the
   * provider call. Present in the daemon; absent, a review stage parks at `evaluating` rather than
   * running, which is exactly what the launch-only phases before this one did.
   */
  review?: EnsembleReviewDeps;
  /**
   * The finalization authorities - exact restore, replacement Task materialization, pane injection,
   * and the Workflow handoff boundary. Present in the daemon; absent, a finalize stage parks at
   * `finalizing`, which is exactly what the phases before this one reached. Passed straight to the
   * engine, which owns the destructive step order and idempotency.
   */
  finalize?: EnsembleFinalizeDeps;
  /**
   * Resolve an operator-selected Workflow to its immutable published version and a support verdict.
   *
   * Injected rather than imported so the manager never depends on the Workflow store: it hands back
   * the pinned display snapshot plus whether this build can EXECUTE the chosen mode as an
   * after-selection handoff. On this baseline only Preview + manual is executable, so a Live/Foreman
   * selection comes back `supported: false` with a reason, and creation refuses it - never a silent
   * Preview downgrade.
   */
  resolveWorkflowVersion?: (workflowId: string, version: number) => ResolvedWorkflowVersion | null;
  agentBinPresent?: (agent: AgentType) => Promise<boolean>;
  missionMcpAvailable?: () => Promise<boolean>;
  now?: () => number;
  log?: (level: "info" | "warn" | "error", fields: Record<string, unknown>) => void;
}

/**
 * A Workflow version resolved to an immutable snapshot at ensemble creation, plus whether this
 * build can run its chosen mode. `supported` is the load-bearing field: an unsupported mode is a
 * typed creation refusal here, so a run is never pinned to a handoff it cannot execute.
 */
export interface ResolvedWorkflowVersion {
  workflowId: string;
  workflowVersionId: string;
  workflowVersion: number;
  workflowName: string;
  triggerMode: string;
  deliveryMode: string;
  maxRepairRounds: number;
  completionPolicy: string;
  supported: boolean;
  /** One sentence when unsupported (Live/Foreman on this baseline), else null. */
  unsupportedReason: string | null;
}

/** The result of one generic operator action, mapped to an HTTP status by the route. */
export type EnsembleActionResult =
  | { ok: true; summary: EnsembleSummary | null; decision?: EnsembleDecision; replayed?: boolean }
  | { ok: false; reason: "not_found" | "conflict" | "invalid" | "unavailable"; detail: string };

/** A side-effect-free create estimate the preview endpoint returns. */
export interface EnsemblePreviewResult {
  ok: boolean;
  reason: EnsembleCreateRefusal | null;
  issues: StrategyIssue[];
  estimate: EnsembleLaunchEstimate | null;
  workflow: ResolvedWorkflowVersion | null;
}

export class EnsembleManager {
  private readonly catalog: StrategyCatalog;
  private readonly resolvePersona: (personaId: string) => ResolvedReviewPersona | null;
  private readonly resolveWorkflowVersion: ((workflowId: string, version: number) => ResolvedWorkflowVersion | null) | null;
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
    this.resolveWorkflowVersion = options.resolveWorkflowVersion ?? null;
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
          review: options.review,
          finalize: options.finalize,
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
        if (member) {
          void this.engine!.wake(member.runId);
          return;
        }
        // A non-member Task change may be a finalizing run's replacement winner coming up - that
        // Task is a normal Task, so it fires no member event, and the handoff waiting on its
        // session would otherwise never resume. Waking the (rare, transient) finalizing runs on
        // such a change is the wake signal the member subscription cannot give.
        for (const run of this.store.listFinalizingRuns()) void this.engine!.wake(run.id);
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
    const handoff = this.resolveHandoff(compiled.value.request.workflow);
    if (!handoff.ok) return handoff.outcome;
    const write = this.persistRun(compiled.value, null, null, "planning", now, undefined, handoff.value);
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
    // The SAME validation projection preview runs, so a draft preview claims is launchable is one
    // create actually launches - compile, resolve the Workflow handoff, and run the read-only
    // preflight. Only after it passes is anything persisted or dispatched.
    const validated = await this.validateDraft(input, now);
    if (!validated.ok) return { ok: false, reason: validated.reason, issues: validated.issues };

    const write = this.persistRun(
      validated.compiled,
      validated.preflight.baseSha,
      validated.preflight.baseBranch,
      "running",
      now,
      validated.preflight.repoRoot,
      validated.handoff,
    );
    const outcome = this.published(write);
    if (write.created) await this.engine.launch(write.run.id);
    else void this.engine.launch(write.run.id);
    return outcome;
  }

  /**
   * The ONE validation/preflight projection preview and create share, so their verdicts cannot drift.
   *
   * Compile the strategy, resolve an optional Workflow handoff to an immutable version (a Live/Foreman
   * mode or an archived version is a refusal, never a silent downgrade), and run the read-only launch
   * preflight (repository, one pinned base commit, agent binaries, effort support, Mission MCP).
   * Everything here is side-effect-free: it pins no base into the store and dispatches nothing, so it
   * is safe to call on every keystroke - and because create runs exactly this, a preview that says
   * "launchable" cannot become a create that refuses.
   */
  private async validateDraft(
    input: EnsembleCreateInput,
    now: number,
  ): Promise<
    | {
        ok: true;
        compiled: { descriptor: StrategyDescriptor; plan: CompiledEnsemblePlan; config: EnsembleJson; request: ReturnType<typeof EnsembleCreateInputSchema.parse> };
        estimate: EnsembleLaunchEstimate | null;
        workflow: ResolvedWorkflowVersion | null;
        handoff: EnsembleWorkflowHandoff | null;
        preflight: PreflightResult;
      }
    | { ok: false; reason: EnsembleCreateRefusal; issues: StrategyIssue[]; estimate: EnsembleLaunchEstimate | null; workflow: ResolvedWorkflowVersion | null }
  > {
    const compiled = this.compile(input, now);
    if (!compiled.ok) {
      const outcome = compiled.outcome;
      return {
        ok: false,
        reason: outcome.ok ? "invalid_config" : outcome.reason,
        issues: outcome.ok ? [] : outcome.issues,
        estimate: null,
        workflow: null,
      };
    }
    const estimate = compiled.value.descriptor.estimate(compiled.value.config);
    const placement = compiled.value.request.workflow ?? null;
    let workflow: ResolvedWorkflowVersion | null = null;
    let handoff: EnsembleWorkflowHandoff | null = null;
    if (placement !== null) {
      workflow = this.resolveWorkflowVersion?.(placement.workflowId, placement.workflowVersion) ?? null;
      const resolved = this.resolveHandoff(placement);
      if (!resolved.ok) {
        return {
          ok: false,
          reason: resolved.outcome.ok ? "workflow_unavailable" : resolved.outcome.reason,
          issues: resolved.outcome.ok ? [] : resolved.outcome.issues,
          estimate,
          workflow,
        };
      }
      handoff = resolved.value;
    }
    const preflight = await this.preflight(compiled.value.plan, input.repoRoot);
    if (!preflight.ok) {
      return { ok: false, reason: "preflight_failed", issues: preflight.issues, estimate, workflow };
    }
    return { ok: true, compiled: compiled.value, estimate, workflow, handoff, preflight: preflight.value };
  }

  /**
   * Turn an operator's Workflow placement into a pinned handoff snapshot, or a typed create refusal.
   *
   * The one place a Live/Foreman selection is refused rather than downgraded: `resolveWorkflowVersion`
   * reports whether this build can execute the chosen mode, and an unsupported one comes back as a
   * `workflow_unavailable` refusal with a sentence for the form. Absent placement is `{ ok, value: null }` -
   * most runs choose no handoff.
   */
  private resolveHandoff(
    placement: { workflowId: string; workflowVersion: number } | null,
  ): { ok: true; value: EnsembleWorkflowHandoff | null } | { ok: false; outcome: EnsembleCreateOutcome } {
    if (placement === null) return { ok: true, value: null };
    if (!this.resolveWorkflowVersion) {
      return {
        ok: false,
        outcome: { ok: false, reason: "workflow_unavailable", issues: [{ path: "workflow", message: "this build cannot resolve a workflow handoff" }] },
      };
    }
    const resolved = this.resolveWorkflowVersion(placement.workflowId, placement.workflowVersion);
    if (!resolved) {
      return {
        ok: false,
        outcome: { ok: false, reason: "workflow_unavailable", issues: [{ path: "workflow", message: `no published workflow ${placement.workflowId} version ${placement.workflowVersion}` }] },
      };
    }
    if (!resolved.supported) {
      return {
        ok: false,
        outcome: { ok: false, reason: "workflow_unavailable", issues: [{ path: "workflow", message: resolved.unsupportedReason ?? "this workflow mode is not available on this build" }] },
      };
    }
    return {
      ok: true,
      value: {
        workflowId: resolved.workflowId,
        workflowVersionId: resolved.workflowVersionId,
        workflowVersion: resolved.workflowVersion,
        workflowName: resolved.workflowName,
        triggerMode: resolved.triggerMode,
        deliveryMode: resolved.deliveryMode,
        maxRepairRounds: resolved.maxRepairRounds,
        completionPolicy: resolved.completionPolicy,
        state: "pending",
        sourceKey: null,
        expectedHeadSha: null,
        bindingId: null,
        runId: null,
        submissionId: null,
        error: null,
      },
    };
  }

  private existingRun(input: EnsembleCreateInput): EnsembleCreateOutcome | null {
    const parsed = EnsembleCreateInputSchema.safeParse(input);
    if (!parsed.success) return null;
    const request = parsed.data;
    const existing = this.store.runBySource(request.sourceKind, request.sourceKey);
    if (!existing) return null;
    // A source key is a per-submission idempotency key: a retry that reuses it must be the SAME
    // request. Any difference - a different repository, title, source id, strategy version, config,
    // or workflow placement - is a conflict, never a silent adoption of the old run. The whole
    // normalized request is compared through one durable fingerprint, so no field is left out (a
    // field-by-field check missed repoRoot, whose stored value is canonicalized and cannot be
    // compared to the raw request directly). An unreadable existing run cannot be proven equivalent.
    const descriptor = descriptorFor(this.catalog, request.strategyId);
    const parsedConfig = descriptor?.configSchema.safeParse(request.strategyConfig);
    const fingerprint = parsedConfig?.success
      ? createRequestFingerprint(request, parsedConfig.data as EnsembleJson)
      : null;
    const equivalent =
      existing.unreadable === null && fingerprint !== null && fingerprint === this.store.requestFingerprint(existing.id);
    if (!equivalent) {
      return {
        ok: false,
        reason: "request_conflict",
        issues: [
          {
            path: "sourceKey",
            message: "this source key is already bound to a different ensemble request",
          },
        ],
      };
    }
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
    const context = this.compileContext(descriptor, request.repoRoot, config, now);
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
    workflowHandoff: EnsembleWorkflowHandoff | null = null,
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
        workflowHandoff,
        requestFingerprint: createRequestFingerprint(request, config),
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

  // ---- operator actions ----

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

  /** Record a human decision and move the run into finalization. Delegates to the engine's one door. */
  async decide(input: {
    runId: string;
    requestId: string;
    expectedStatus: EnsembleRun["status"];
    selection: EnsembleJson;
    rationale: string;
    actorId: string | null;
  }): Promise<EnsembleDecideOutcome> {
    if (!this.engine) return { ok: false, reason: "no_run", detail: "this build cannot finalize", status: null };
    if (input.expectedStatus === null) {
      return { ok: false, reason: "wrong_state", detail: "a decision must state the run state it expects", status: null };
    }
    return this.engine.decide({
      runId: input.runId,
      requestId: input.requestId,
      expectedStatus: input.expectedStatus,
      selection: input.selection,
      rationale: input.rationale,
      actorId: input.actorId,
    });
  }

  async resolveFinalization(runId: string, skipWorkflowHandoff: boolean): Promise<{ ok: boolean; detail?: string }> {
    return this.engine ? this.engine.resolveFinalization(runId, skipWorkflowHandoff) : { ok: false, detail: "no engine" };
  }

  /**
   * The one generic action door the `/actions` route goes through.
   *
   * A discriminated dispatch over `EnsembleAction`, mapping each verb's engine result to a typed
   * refusal the route turns into an HTTP status - never a second route family per verb. The summary
   * is re-read after the act so the response and the SSE channel agree.
   */
  async applyAction(runId: string, action: EnsembleAction): Promise<EnsembleActionResult> {
    if (!this.engine) return { ok: false, reason: "unavailable", detail: "this build cannot act on ensembles" };
    switch (action.kind) {
      case "retry_stage": {
        const ok = await this.retryStage(runId, action.stageId);
        return ok ? { ok: true, summary: this.store.summary(runId) } : { ok: false, reason: "invalid", detail: "that stage cannot be retried right now" };
      }
      case "retry_member": {
        const ok = await this.retryMember(runId, action.memberId);
        return ok ? { ok: true, summary: this.store.summary(runId) } : { ok: false, reason: "invalid", detail: "that member cannot be retried right now" };
      }
      case "withdraw_member": {
        const ok = await this.withdrawMember(runId, action.memberId, null);
        return ok ? { ok: true, summary: this.store.summary(runId) } : { ok: false, reason: "invalid", detail: "that member cannot be withdrawn right now" };
      }
      case "decide": {
        const decided = await this.decide({
          runId,
          requestId: action.requestId,
          expectedStatus: action.expectedStatus,
          selection: action.selection,
          rationale: action.rationale,
          actorId: null,
        });
        if (decided.ok) return { ok: true, summary: this.store.summary(runId), decision: decided.decision, replayed: decided.replayed };
        const reason =
          decided.reason === "no_run" ? "not_found" : decided.reason === "wrong_state" || decided.reason === "conflict" ? "conflict" : "invalid";
        return { ok: false, reason, detail: decided.detail };
      }
      case "resolve_finalization": {
        const result = await this.resolveFinalization(runId, action.skipWorkflowHandoff);
        return result.ok ? { ok: true, summary: this.store.summary(runId) } : { ok: false, reason: "invalid", detail: result.detail ?? "finalization could not be resumed" };
      }
      case "cancel": {
        const ok = await this.cancelRun(runId, action.reason);
        return ok ? { ok: true, summary: this.store.summary(runId) } : { ok: false, reason: "invalid", detail: "that run cannot be cancelled right now" };
      }
      case "restore_artifact": {
        const result = await this.restoreArtifact(runId, action.artifactId);
        return result.ok ? { ok: true, summary: this.store.summary(runId) } : { ok: false, reason: "invalid", detail: result.detail ?? "that artifact cannot be restored" };
      }
    }
  }

  /**
   * Whether a live session may acquire a normal Workflow binding, backed by the ensemble store.
   *
   * The narrow guard the daemon injects into WorkflowManager: it answers with a REASON (ineligible)
   * or null (eligible) and nothing else, so the Workflow module never imports the ensemble store. A
   * session running an ACTIVE ensemble member is refused - binding it manually would race the
   * finalization that reads it. A settled member no longer owns the session, which is exactly why the
   * server-owned after-selection handoff marks the winner retained BEFORE it binds: by then this
   * returns null and the ensemble's own external bind goes through the same boundary.
   */
  canBindSessionToWorkflow(sessionId: string): string | null {
    const session = this.registry.getSession(sessionId);
    if (!session) return null;
    const task = this.registry.taskForSession(session.id, session.cwd);
    if (!task) return null;
    const member = this.store.memberForTask(task.id);
    if (!member) return null;
    if (member.status === null) {
      return "this session belongs to an ensemble member whose status this build cannot classify";
    }
    const active =
      member.status === "pending" ||
      member.status === "launching" ||
      member.status === "active" ||
      member.status === "submitted" ||
      member.status === "reviewing";
    return active
      ? "this session is running an active ensemble member and cannot be bound to a workflow until the ensemble finalizes"
      : null;
  }

  /**
   * Side-effect-free validation and estimate for a draft, sharing create's exact projection.
   *
   * Preview and create resolve the same way - the strategy compiles, the Workflow placement resolves
   * to the same support verdict - so a preview can never promise a launch create would refuse. It
   * pins no base and touches no repository beyond what compilation needs, so it is safe to call on
   * every keystroke.
   */
  async preview(input: EnsembleCreateInput, now = this.now()): Promise<EnsemblePreviewResult> {
    // Exactly the projection create runs (compile + Workflow resolution + read-only preflight), so a
    // draft can never preview as launchable and then be refused on create. It persists nothing.
    const validated = await this.validateDraft(input, now);
    if (!validated.ok) {
      return { ok: false, reason: validated.reason, issues: validated.issues, estimate: validated.estimate, workflow: validated.workflow };
    }
    return { ok: true, reason: null, issues: [], estimate: validated.estimate, workflow: validated.workflow };
  }

  /**
   * Explicitly delete one terminal run's history AND its generated private refs.
   *
   * The one destructive-to-evidence act, gated on the run being terminal and on the caller echoing
   * its id. Deletion intent is persisted first, then every validated generated ref is deleted, then
   * the rows - so a crash mid-deletion resumes the same remaining refs (the intent cascades with the
   * run, so recovery only ever finds one whose run still exists). It never deletes a Task or any
   * linked Workflow state: those have their own owners and retention.
   */
  async deleteRun(
    id: string,
    confirmId: string,
  ): Promise<{ ok: boolean; reason?: "not_found" | "mismatch" | "not_terminal" | "incomplete"; detail?: string }> {
    if (id !== confirmId) return { ok: false, reason: "mismatch", detail: "the confirmation id does not match the run id" };
    const run = this.store.getRun(id);
    if (!run) return { ok: false, reason: "not_found", detail: "no such ensemble" };
    // Terminal-only: an in-flight run holds live Tasks a delete must never orphan. Cancel it first.
    if (run.status === null || !ensembleIsTerminal(run.status)) {
      return {
        ok: false,
        reason: "not_terminal",
        detail: `run is ${run.status ?? "unreadable"}; cancel it before deleting its history`,
      };
    }
    this.store.beginDeletionIntent(id, this.now());
    const outcome = await this.executeDeletion(id);
    return outcome.ok ? { ok: true } : { ok: false, reason: "incomplete", detail: outcome.detail };
  }

  /**
   * Resume any deletion interrupted by a crash. Called at startup after run recovery.
   *
   * A deletion intent exists only while its run still exists (it cascades), so every intent found
   * here is a deletion that did not reach `deleteRun`, and re-running it deletes the remaining refs
   * and the rows. Deleting a ref twice is a no-op, so this is safe to repeat.
   */
  async recoverDeletions(): Promise<void> {
    for (const intent of this.store.listDeletionIntents()) {
      try {
        await this.executeDeletion(intent.runId);
      } catch (err) {
        console.error(`[ensemble] deletion recovery failed for run ${intent.runId}:`, err);
      }
    }
  }

  /** Delete every generated private ref of a run, then its rows, then emit `ensemble_remove`. */
  private async executeDeletion(id: string): Promise<{ ok: boolean; detail?: string }> {
    const record = this.store.getRun(id);
    if (!record) return { ok: true };
    this.store.setDeletionStatus(id, "deleting_refs", null, this.now());
    for (const ref of this.generatedRefsFor(id)) {
      await run("git", ["-C", record.repoRoot, "update-ref", "-d", ref]).catch(() => undefined);
      let still: string | null;
      try {
        still = await resolveEnsembleRef(record.repoRoot, ref);
      } catch (err) {
        const detail = `could not verify private ref ${ref}: ${err instanceof Error ? err.message : String(err)}`;
        this.store.setDeletionStatus(id, "failed", detail, this.now());
        return { ok: false, detail };
      }
      if (still !== null) {
        const detail = `could not delete private ref ${ref}`;
        this.store.setDeletionStatus(id, "failed", detail, this.now());
        return { ok: false, detail };
      }
    }
    const removed = this.store.deleteRun(id);
    if (removed) {
      this.refreshLinks();
      this.registry.removeEnsemble(id);
    }
    return removed ? { ok: true } : { ok: false, detail: "the ensemble rows could not be deleted" };
  }

  /**
   * The generated private refs a run owns, validated as the exact `refs/mission-control/ensembles/…`
   * shape this build creates - never a ref name read off anywhere but the run's own artifacts.
   */
  private generatedRefsFor(id: string): string[] {
    const prefix = `${ENSEMBLE_REF_PREFIX}/${id}/`;
    const refs = new Set<string>();
    for (const artifact of this.store.listArtifacts(id)) {
      if (artifact.kind === "commit") {
        try {
          refs.add(ensembleSnapshotRef(id, artifact.id));
        } catch (err) {
          void err;
        }
      }
      const locator = artifact.locator;
      const ref =
        locator && typeof locator === "object" && !Array.isArray(locator) && typeof locator.ref === "string"
          ? locator.ref
          : null;
      if (ref !== null && ref.startsWith(prefix) && /^[\w./-]+$/.test(ref)) refs.add(ref);
    }
    return [...refs];
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
    descriptor: StrategyDescriptor,
    repoRoot: string,
    config: unknown,
    now: number,
  ): { ok: true; value: StrategyCompileContext } | { ok: false; issues: StrategyIssue[] } {
    // The only impure part of compilation, lifted out of it: every Persona the config names is
    // resolved to an immutable snapshot here, and the descriptor either receives those snapshots
    // or refuses. WHICH ids a config names is the descriptor's own answer (`personaRefs`) rather
    // than a path this method knows: one strategy spells it `evaluator.personaId` and the next
    // spells it once per judge, and a manager that hard-coded the first spelling would silently
    // resolve nothing for the second. Every refusal lands BEFORE any member Task exists.
    const personas = new Map<string, EnsembleReviewPersona>();
    const personaRefs = descriptor.personaRefs(config);
    const guidanceBytesPerReference = Math.floor(
      ENSEMBLE_LIMITS.reviewGuidanceBytes / Math.max(1, personaRefs.length),
    );
    for (const ref of personaRefs) {
      const path = `strategyConfig.${ref.path}`;
      // The same Persona named twice is ONE lookup, and deliberately so: a second read could only
      // return the same bytes or - if the operator edited it between the two - a different
      // revision, which would put two snapshots of "the same" judge in one plan.
      const already = personas.get(ref.personaId);
      const revision = already?.revision ?? null;
      if (already === undefined) {
        const resolved = this.resolvePersona(ref.personaId);
        if (!resolved) {
          return { ok: false, issues: [{ path, message: `no Persona ${ref.personaId}` }] };
        }
        // Archived is a refusal, not a downgrade: a run whose judge has been retired must not fall
        // back to a built-in rubric under the operator's Persona choice.
        if (resolved.archived) {
          return {
            ok: false,
            issues: [{ path, message: `Persona ${ref.personaId} is archived and cannot judge` }],
          };
        }
        personas.set(ref.personaId, {
          id: resolved.id,
          revision: resolved.revision,
          name: resolved.name,
          // Truncated to the plan's shared guidance budget HERE, once, so the plan cannot burst its
          // cap and so the truncation is disclosed at the boundary that made it rather than at
          // persistence.
          guidanceMarkdown: truncateUtf8(resolved.guidanceMarkdown, guidanceBytesPerReference),
          runner: resolved.runner,
          model: resolved.model,
        });
      }
      // A pinned revision that no longer matches is a refusal too: the operator built the request
      // against guidance that has since changed, and snapshotting the new text under the old
      // request is the silent substitution the whole resolve step exists to prevent.
      const live = revision ?? personas.get(ref.personaId)!.revision;
      if (ref.revision !== null && ref.revision !== live) {
        return {
          ok: false,
          issues: [
            {
              path,
              message: `Persona ${ref.personaId} is at revision ${live}, not the requested ${ref.revision}`,
            },
          ],
        };
      }
    }
    return { ok: true, value: { repoRoot, personas, now } };
  }
}

/**
 * A stable fingerprint of a create request, for source-key replay-conflict detection.
 *
 * Built from the RAW parsed request (a legitimate idempotent retry is byte-identical, so its
 * fingerprint matches), and from the descriptor-parsed config rather than the raw config blob so
 * that key ordering and defaults do not spuriously differ. `repoRoot` is the raw request value, not
 * the canonicalized one stored on the row - a different repository yields a different fingerprint,
 * while the same retry yields the same one. Any differing field makes the fingerprint differ, which
 * is exactly the conflict this detects.
 */
function createRequestFingerprint(
  request: ReturnType<typeof EnsembleCreateInputSchema.parse>,
  config: EnsembleJson,
): string {
  const material: EnsembleJson = {
    sourceKind: request.sourceKind,
    sourceId: request.sourceId,
    title: request.title.trim(),
    intent: request.intent,
    repoRoot: request.repoRoot,
    strategyId: request.strategyId,
    strategyVersion: request.strategyVersion ?? null,
    config,
    workflow: request.workflow
      ? { workflowId: request.workflow.workflowId, workflowVersion: request.workflow.workflowVersion }
      : null,
  };
  return createHash("sha256").update(canonicalEnsembleJson(material)).digest("hex");
}

/** Truncate a string to at most `maxBytes` UTF-8 bytes without splitting a code point. */
function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  // Slice by code points until the byte budget is reached; a surrogate pair never straddles
  // the cut because iteration is over whole code points.
  let bytes = 0;
  let out = "";
  for (const ch of value) {
    const chBytes = Buffer.byteLength(ch, "utf8");
    if (bytes + chBytes > maxBytes) break;
    bytes += chBytes;
    out += ch;
  }
  return out;
}
