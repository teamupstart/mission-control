import type { EnsembleArtifactKind } from "@shared/ensemble.ts";
import { gitSnapshotAdapter } from "./git-snapshot.ts";
import type { ArtifactAdapter, ArtifactAdapterRegistry } from "./types.ts";

export type {
  ArtifactAdapter,
  ArtifactAdapterRegistry,
  ArtifactCaptureInput,
  ArtifactMaterialization,
  ArtifactLocator,
  CapturedArtifact,
} from "./types.ts";
export { gitSnapshotAdapter, gitSnapshotSnapshotSha } from "./git-snapshot.ts";

/**
 * Every artifact adapter this build ships, keyed by the artifact kind it captures.
 *
 * `Record<EnsembleArtifactKind, ArtifactAdapter | null>` is the enforcement: a kind appended to
 * the shared tuple does not compile until this record says either how to capture it or, honestly,
 * `null` - "named for a later phase, no adapter yet". Only `commit` is implemented in this phase
 * (the Git snapshot); the rest are declared null so the member and stage tables never widen when
 * one lands. A `null` here is what makes a stage that declared an unimplemented artifact kind a
 * visible refusal rather than a silent no-op.
 */
export const ARTIFACT_ADAPTERS: ArtifactAdapterRegistry = {
  patch: null,
  commit: gitSnapshotAdapter,
  branch: null,
  worktree: null,
  summary: null,
  test_report: null,
  evaluation: null,
};

/** The adapter for one kind, or null when this build cannot capture it. */
export function artifactAdapterFor(kind: EnsembleArtifactKind): ArtifactAdapter | null {
  return ARTIFACT_ADAPTERS[kind];
}
