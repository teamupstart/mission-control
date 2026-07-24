import {
  ENSEMBLE_LIMITS,
  ENSEMBLE_SOURCE_KINDS,
  ensembleStrategyKey,
  readEnsembleEnum,
  type EnsembleCreateInput,
  type EnsembleRun,
  type EnsembleRunDetail,
  type EnsembleSummary,
  type TaskEnsembleLink,
} from "@shared/ensemble.ts";
import { EnsembleCreateInputSchema } from "@shared/protocol.ts";
import type { Registry } from "../registry.ts";
import { EnsembleStore, type EnsembleMemberInsert } from "./store.ts";
import {
  descriptorFor,
  ensembleStrategyCatalog,
  type StrategyCatalog,
  type StrategyCompileContext,
  type StrategyIssue,
} from "./strategies/index.ts";

/**
 * Validation, compilation and the compact projection - and nothing that launches.
 *
 * This is the whole daemon-facing boundary for ensembles as of this phase. It can compile a
 * request into an immutable plan and persist the run and its roster, and it can publish the
 * compact summaries the dashboard receives. It cannot dispatch a task, provision a worktree,
 * capture an artifact, run an evaluator or finalize anything: those are later phases, and
 * NOTHING routes to `create` yet, so a half-built orchestration cannot be reached by a user.
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
  | "invalid_config";

export type EnsembleCreateOutcome =
  | { ok: true; run: EnsembleRun; summary: EnsembleSummary; created: boolean }
  | { ok: false; reason: EnsembleCreateRefusal; issues: StrategyIssue[] };

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
}

export class EnsembleManager {
  private readonly catalog: StrategyCatalog;
  private readonly resolvePersona: (personaId: string) => { id: string; revision: number } | null;

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
    // Boot-time catalog install, before SSE is served, so no incremental emit is needed -
    // the same shape `initializePersonas` / `initializeWorkflows` use.
    this.registry.initializeEnsembles(this.summaries());
    // The task projection is REGISTERED rather than imported by the Registry, which keeps
    // the registry free of an ensemble dependency and keeps the lookup on the daemon side of
    // one seam. It is an in-memory map read, not a query: `taskSummaryFor` runs for every
    // session on every discovery sweep.
    this.store.onTaskLinksChanged(() => this.refreshLinks());
    this.refreshProjection();
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

  /**
   * Runs a restart would have to reconcile.
   *
   * Exposed, not executed. Phase 3 launches nothing, so there is nothing in flight to
   * resume; this is the read the recovery pass starts from, and having it here means the
   * later phase adds a caller rather than a second definition of "not finished".
   */
  nonTerminalRuns(): EnsembleRun[] {
    return this.store.listNonTerminalRuns();
  }

  /**
   * Validate, compile and persist one run as a draft. Launches nothing.
   *
   * The order matters and is the invariant the plan states: the run, its immutable strategy
   * snapshot and its whole roster are durable BEFORE anything could be dispatched. A crash
   * after this point leaves rows an operator can see and cancel; a crash before it leaves
   * nothing at all. There is no third outcome where agents exist and the group does not.
   */
  create(input: EnsembleCreateInput, now = Date.now()): EnsembleCreateOutcome {
    const sourceKind = readEnsembleEnum(ENSEMBLE_SOURCE_KINDS, input.sourceKind);
    const sourceKey =
      typeof input.sourceKey === "string" &&
      input.sourceKey.length > 0 &&
      input.sourceKey.length <= ENSEMBLE_LIMITS.sourceKey
        ? input.sourceKey
        : null;
    const existing =
      sourceKind !== null && sourceKey !== null
        ? this.store.runBySource(sourceKind, sourceKey)
        : null;
    if (existing) {
      const summary = this.publish(existing.id);
      if (!summary) throw new Error(`ensemble ${existing.id} has no summary for its source claim`);
      return { ok: true, run: existing, summary, created: false };
    }

    const parsed = EnsembleCreateInputSchema.safeParse(input);
    if (!parsed.success) {
      return {
        ok: false,
        reason: "invalid_config",
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      };
    }
    const request = parsed.data;
    const descriptor = descriptorFor(this.catalog, request.strategyId);
    if (!descriptor) {
      return {
        ok: false,
        reason: "unknown_strategy",
        issues: [{ path: "strategyId", message: `unknown strategy ${request.strategyId}` }],
      };
    }
    if (!descriptor.enabled) {
      return {
        ok: false,
        reason: "strategy_disabled",
        issues: [
          { path: "strategyId", message: `${descriptor.label} cannot be created by this build` },
        ],
      };
    }
    // A pinned version this build does not compile is a refusal, never a silent upgrade: the
    // operator asked for a specific behaviour, and running a newer one would be a different
    // ensemble wearing the version they chose.
    if (
      request.strategyVersion !== undefined &&
      request.strategyVersion !== descriptor.compilesVersion
    ) {
      return {
        ok: false,
        reason: "version_unavailable",
        issues: [
          {
            path: "strategyVersion",
            message: `this build compiles ${descriptor.id} at version ${descriptor.compilesVersion}`,
          },
        ],
      };
    }

    const config = request.strategyConfig ?? {};
    const context = this.compileContext(request.repoRoot, config, now);
    if (!context.ok) return { ok: false, reason: "invalid_config", issues: context.issues };
    const compiled = descriptor.compile(config, context.value);
    if (!compiled.ok) return { ok: false, reason: "invalid_config", issues: compiled.issues };

    const members: EnsembleMemberInsert[] = compiled.plan.roles.map((role) => ({
      roleKey: role.key,
      roleLabel: role.label,
      ordinal: role.ordinal,
      wave: role.wave,
    }));
    const write = this.store.createRun(
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
        repoRoot: request.repoRoot,
        baseBranch: null,
        // Pinned by the launch runtime, which is a later phase. Until then a run has no
        // base, and the column says so rather than holding a plausible HEAD that nothing
        // verified.
        baseSha: null,
        plan: compiled.plan,
        strategyConfig: compiled.config,
        status: "planning",
        members,
      },
      now,
    );
    const summary = this.publish(write.run.id);
    if (!summary) {
      throw new Error(`ensemble ${write.run.id} has no summary immediately after creation`);
    }
    return { ok: true, run: write.run, summary, created: write.created };
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
