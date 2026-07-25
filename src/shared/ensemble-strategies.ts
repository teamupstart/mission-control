import { ENSEMBLE_STRATEGY_IDS, type EnsembleStrategyId } from "./ensemble.ts";
import {
  BEST_OF_N_CAPABILITIES,
  BEST_OF_N_FORM,
  BestOfNConfigSchema,
  bestOfNEstimate,
} from "./ensemble-strategies/best-of-n.ts";
import {
  CONSENSUS_CAPABILITIES,
  CONSENSUS_FORM,
  ConsensusConfigSchema,
  consensusEstimate,
} from "./ensemble-strategies/consensus.ts";
import type { EnsembleStrategyInfo } from "./ensemble-strategies/types.ts";

export type {
  EnsembleStrategyCapabilities,
  EnsembleStrategyInfo,
  StrategyFormField,
  StrategyFormSpec,
} from "./ensemble-strategies/types.ts";

/**
 * Every strategy's browser-safe half, keyed by id.
 *
 * `Record<EnsembleStrategyId, …>` is the enforcement: an id appended to
 * `ENSEMBLE_STRATEGY_IDS` does not compile until it has said what it is called, what it
 * does, what its configuration looks like, how the form is drawn, and how many agents it
 * will start. The server's `ENSEMBLE_STRATEGIES` catalog is the second half - it spreads
 * these entries in and adds compilation - so neither record restates the other.
 *
 * **The version here is the version this build COMPILES AT.** It is not what a stored run
 * executes: a run persists its own `strategyKey` (`best_of_n@1`) and its compiled plan, and
 * recovery runs that, never a fresh compilation with today's defaults. Bumping
 * `currentVersion` is therefore always safe for in-flight runs and always append-only for
 * the id itself.
 */
export const ENSEMBLE_STRATEGY_INFO: Record<EnsembleStrategyId, EnsembleStrategyInfo> = {
  best_of_n: {
    id: "best_of_n",
    currentVersion: 1,
    label: "Best of N",
    blurb: "Two to five agents implement the same task alone, then one comparison ranks them.",
    explanation:
      "Every candidate starts from one pinned commit in its own worktree and works without " +
      "seeing the others. None may push or open a pull request. When they have all finished, " +
      "one tool-less comparison ranks the submitted snapshots and recommends a winner - it " +
      "cannot promote one. You confirm the winner; the losers give back their worktrees and " +
      "their snapshots are kept.",
    capabilities: BEST_OF_N_CAPABILITIES,
    configSchema: BestOfNConfigSchema,
    form: BEST_OF_N_FORM,
    estimate: bestOfNEstimate,
    enabled: true,
  },
  consensus: {
    id: "consensus",
    currentVersion: 1,
    label: "Consensus",
    blurb: "Three to five agents attempt the task alone, then one pass mines what they disagreed about.",
    explanation:
      "Every attempt starts from one pinned commit in its own worktree and works without seeing " +
      "the others. None may push or open a pull request. When they have all finished, one " +
      "tool-less pass compares what they DECIDED: what all of them did the same way is filed as " +
      "agreement, and each thing they did differently becomes a question with the positions the " +
      "attempts actually took. You answer the questions. Nothing is promoted and nothing is " +
      "reaped - every snapshot is kept, and the run's product is your recorded answers.",
    capabilities: CONSENSUS_CAPABILITIES,
    configSchema: ConsensusConfigSchema,
    form: CONSENSUS_FORM,
    estimate: consensusEstimate,
    enabled: true,
  },
};

/** The strategies this build can compile for in-process creation, in declaration order. */
export function creatableStrategies(): EnsembleStrategyInfo[] {
  return ENSEMBLE_STRATEGY_IDS.map((id) => ENSEMBLE_STRATEGY_INFO[id]).filter(
    (info) => info.enabled,
  );
}

/**
 * The display label for a persisted strategy key, whoever wrote it.
 *
 * Falls back to the raw key rather than to a known strategy's label: a run written by a
 * newer build has to be nameable on screen so it can be cancelled, and labelling it
 * "Best of N" because that is the only strategy this build has would be a lie about what
 * an operator is looking at.
 */
export function strategyLabelFor(id: string, fallback: string): string {
  return (ENSEMBLE_STRATEGY_IDS as readonly string[]).includes(id)
    ? ENSEMBLE_STRATEGY_INFO[id as EnsembleStrategyId].label
    : fallback;
}

/** Narrow a persisted strategy id string to one this build knows, or null. */
export function knownStrategyId(id: string | null | undefined): EnsembleStrategyId | null {
  return id != null && (ENSEMBLE_STRATEGY_IDS as readonly string[]).includes(id)
    ? (id as EnsembleStrategyId)
    : null;
}
