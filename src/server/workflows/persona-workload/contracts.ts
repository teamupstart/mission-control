import type {
  PersonaWorkloadRequest,
  PersonaWorkloadEvent,
  PersonaWorkloadReconciliation,
  RepositoryViewDescriptor,
} from "@shared/repository-access.ts";

export interface PersonaWorkloadExecutor {
  readonly repositoryEvidenceCapability?: string;
  dispatch(
    request: PersonaWorkloadRequest,
    signal: AbortSignal,
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
