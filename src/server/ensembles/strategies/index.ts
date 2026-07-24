import { ENSEMBLE_STRATEGY_IDS, type EnsembleStrategyId } from "@shared/ensemble.ts";
import { bestOfNStrategy } from "./best-of-n.ts";
import { descriptorFor, type StrategyCatalog, type StrategyDescriptor } from "./types.ts";

export type {
  StrategyCatalog,
  StrategyCompileContext,
  StrategyCompileResult,
  StrategyDescriptor,
  StrategyIssue,
} from "./types.ts";
export { defineStrategy, descriptorFor } from "./types.ts";

/**
 * Every ensemble strategy this build can compile, keyed by id.
 *
 * ## The extension contract
 *
 * **Append-only ids.** `ENSEMBLE_STRATEGY_IDS`, `ENSEMBLE_DRIVER_KEYS`,
 * `ENSEMBLE_ARTIFACT_KINDS`, `ENSEMBLE_SOURCE_KINDS` and every status vocabulary in
 * `@shared/ensemble.ts` are persisted in an operator's SQLite file. Renaming one does not
 * migrate the rows written under the old spelling, it orphans them: the row stops matching
 * anything registered and becomes a run nobody can execute, cancel or explain. A new
 * behaviour is a NEW id beside the old one, and a driver's new behaviour is `@2` beside
 * `@1`.
 *
 * **What a strategy contributes, and what it does not.** A strategy supplies validation,
 * compilation and presentation metadata - a config schema, a form, a launch estimate, and
 * one pure `compile`. It does NOT get persistence or execution: the generic engine owns the
 * tables, the transactions, the barriers, the recovery and the events, and it dispatches on
 * a compiled plan's stage kinds and driver keys. No execution code may branch on a strategy
 * id, and a strategy that needs a column, a route, a `ServerEvent` or a session field is
 * evidence that it introduced a new PRIMITIVE rather than a new strategy.
 *
 * **A compiled plan is immutable for the life of its run.** Recovery executes the stored
 * snapshot; it never recompiles with today's defaults, because a compiler whose defaults
 * moved would silently re-aim a run that is already half-launched. Retries create attempts,
 * not plan rewrites. Bumping `currentVersion` here is therefore always safe for in-flight
 * runs - they carry their own `strategyKey`.
 *
 * `Record<EnsembleStrategyId, StrategyDescriptor>` is the enforcement: an id appended to the
 * shared tuple does not compile until something here can validate and compile it.
 */
export const ENSEMBLE_STRATEGIES: Record<EnsembleStrategyId, StrategyDescriptor> = {
  best_of_n: bestOfNStrategy,
};

/** The one production catalog, as the generic `StrategyCatalog` a reader should take. */
export const ensembleStrategyCatalog: StrategyCatalog<EnsembleStrategyId> = ENSEMBLE_STRATEGIES;

/** Resolve a strategy id that may have come off disk or out of a request body. */
export function strategyFor(id: string): StrategyDescriptor | null {
  return descriptorFor(ensembleStrategyCatalog, id);
}

/** Every strategy this build can compile for in-process creation, in declaration order. */
export function creatableStrategyDescriptors(): StrategyDescriptor[] {
  return ENSEMBLE_STRATEGY_IDS.map((id) => ENSEMBLE_STRATEGIES[id]).filter((s) => s.enabled);
}
