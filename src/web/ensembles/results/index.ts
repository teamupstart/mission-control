import type { EnsembleStrategyId, EnsembleJson } from "@shared/ensemble.ts";
import type { EnsembleRunDetailResponse } from "../types.ts";
import { BestOfNResult } from "./BestOfN.tsx";
import { ConsensusResultView } from "./Consensus.tsx";
import { PanelVoteResult } from "./PanelVote.tsx";

/**
 * The strategy result-renderer registry. Generic run detail shows stages, members, artifacts
 * and evaluations the same way for every strategy; the strategy-specific PRESENTATION of the
 * result - Best-of-N's scorecards, a future panel's agreement view, a tournament's bracket -
 * lives behind this seam, keyed by the run's strategy id. A new strategy that reuses the
 * existing tables and routes adds a renderer here and nothing else, which is the Phase 8
 * extension contract: no new page, no new session field, no new engine branch.
 */

/** Everything a strategy result view needs, supplied by the generic detail. */
export interface EnsembleResultContext {
  detail: EnsembleRunDetailResponse;
  /**
   * The operator-facing identity of a subject artifact, revealed AFTER evaluation. The judge
   * ranked anonymously; this maps an artifact id back to "Candidate N (agent · model)".
   */
  subjectLabel: (artifactId: string) => string;
  /** Open one artifact's on-demand evidence/diff. */
  onOpenArtifact?: (artifactId: string) => void;
  /**
   * Present only while the run awaits a human decision and an action may be posted. The
   * strategy view builds the selection in its own vocabulary; the generic action surface wraps
   * it with the idempotency key, expected status, and destructive confirmation.
   *
   * `selection` is generic JSON because a decision is answered in the compiled DECISION POLICY's
   * vocabulary, not in one strategy's: Best-of-N posts a winner, a consensus run posts an answer
   * per question. The server re-validates it against the compiled driver whatever the browser
   * sends, so widening it here loosens no guarantee - narrowing it would just mean the second
   * decision shape had to be smuggled through a cast.
   */
  decision: {
    busy: boolean;
    pending: boolean;
    error: string | null;
    onDecide: (selection: EnsembleJson, rationale: string) => void;
  } | null;
}

export type EnsembleResultRenderer = (ctx: EnsembleResultContext) => React.JSX.Element | null;

export const ENSEMBLE_RESULT_RENDERERS: Partial<Record<EnsembleStrategyId, EnsembleResultRenderer>> = {
  best_of_n: BestOfNResult,
  consensus: ConsensusResultView,
  panel_vote: PanelVoteResult,
};
