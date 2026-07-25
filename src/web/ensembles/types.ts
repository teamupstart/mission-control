import type { EnsembleLaunchEstimate, EnsembleRunDetail } from "@shared/ensemble.ts";

/**
 * Wire shapes the ensemble HTTP routes return that the daemon did NOT export to `@shared`.
 *
 * They are mirrored here rather than imported from `src/server`, on purpose: the browser
 * bundle must never reach a `node:`-importing module, and the preview/materialization
 * responses are server-only types (`EnsemblePreviewResult`, `ArtifactMaterialization`,
 * `StrategyIssue`, `ResolvedWorkflowVersion`) built above that boundary. Keep these in step
 * with `src/server/ensembles/manager.ts` and `src/server/ensembles/artifacts/types.ts`; a
 * render test over a fixture is the guard that they stay legible, not a compiler contract.
 */

/** One refusal, addressed to a config field so the form can put it where the operator typed. */
export interface StrategyIssue {
  /** Dotted path into the strategy's own config (`members.1.effort`); empty for the whole. */
  path: string;
  message: string;
}

/** The immutable published Workflow a run's optional handoff would pin, resolved by preview. */
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
  /** One sentence when unsupported (a Live/Foreman mode on this baseline), else null. */
  unsupportedReason: string | null;
}

/** The side-effect-free `POST /api/ensembles/preview` body. `ok` is the draft's validity. */
export interface EnsemblePreviewResult {
  ok: boolean;
  /** An `EnsembleCreateRefusal` discriminant, or null when the draft is launchable. */
  reason: string | null;
  issues: StrategyIssue[];
  estimate: EnsembleLaunchEstimate | null;
  workflow: ResolvedWorkflowVersion | null;
}

/** The bounded events/attempts window the detail read reports alongside the full record. */
export interface EnsembleDetailPagination {
  eventsTotal: number;
  eventsReturned: number;
  attemptsTotal: number;
  attemptsReturned: number;
}

/** `GET /api/ensembles/:id` - the full durable record plus its pagination window. */
export type EnsembleRunDetailResponse = EnsembleRunDetail & {
  pagination: EnsembleDetailPagination;
};

/** One changed file inside an on-demand artifact diff. */
export interface EnsembleArtifactFile {
  path: string;
  /** The rename source, or null when the file was not renamed. */
  oldPath: string | null;
  insertions: number;
  deletions: number;
  binary: boolean;
}

/** `GET /api/ensembles/:id/artifacts/:artifactId/patch` - bounded, re-derived, never stored. */
export interface EnsembleArtifactPatch {
  files: EnsembleArtifactFile[];
  filesChanged: number;
  insertions: number;
  deletions: number;
  /** The patch text, up to the caller's byte budget. */
  patch: string;
  truncated: boolean;
  omittedBytes: number;
}

/** The acknowledgement a manual (or MCP) member submission returns. */
export interface EnsembleSubmitAck {
  replayed: boolean;
  artifact: {
    id: string;
    kind: string | null;
    fingerprint: string;
    shortSha: string;
  };
}
