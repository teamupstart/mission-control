import type {
  PersonaWorkloadRequest,
  PersonaWorkloadEvent,
  PersonaWorkloadReconciliation,
  RepositoryViewDescriptor,
} from "@shared/repository-access.ts";

/**
 * Supervisor-owned sinks an in-process executor calls synchronously at a boundary that must
 * survive the supervisor's own process. An executor in another process reports the same facts
 * only through its event stream and replay.
 */
export interface PersonaWorkloadSinks {
  /**
   * The provider returned. Called with the stamped event before it is queued for the stream,
   * in the same tick the reply arrives, so a daemon that dies before reading the stream has
   * already recorded that the execution was spent. `history` is every event emitted before it,
   * in order, so the supervisor can hold the return to the same ordering rule as the stream.
   * A throw here never stops the workload.
   */
  returned?(
    event: Extract<PersonaWorkloadEvent, { type: "persona_returned" }>,
    history: readonly PersonaWorkloadEvent[],
  ): void;
}
export interface PersonaWorkloadExecutor {
  readonly repositoryEvidenceCapability?: string;
  dispatch(
    request: PersonaWorkloadRequest,
    signal: AbortSignal,
    sinks?: PersonaWorkloadSinks,
  ): AsyncIterable<PersonaWorkloadEvent>;
  reconcile(
    workloadId: string,
    afterSequence: number,
  ): Promise<PersonaWorkloadReconciliation>;
  cancel(workloadId: string, generation: number): Promise<void>;
}
export interface RepositoryMaterializationRequest {
  submissionId: string;
  workloadId: string;
  attemptId: string;
  locator: string;
  digest: string;
}
export interface RepositoryViewLease {
  identity: RepositoryMaterializationRequest;
  descriptor: RepositoryViewDescriptor;
  objectDirectory: string;
  release(): Promise<void>;
}
/** Implementations must check all identity fields and active ownership before filesystem access. */
export interface RepositoryArtifactMaterializer {
  materialize(
    request: RepositoryMaterializationRequest,
    signal: AbortSignal,
  ): Promise<RepositoryViewLease>;
}
