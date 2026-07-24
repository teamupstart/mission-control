import type { EnsembleArtifactKind, EnsembleJson } from "@shared/ensemble.ts";

/**
 * How a member's work becomes an immutable, comparable, restorable artifact.
 *
 * The generic engine never knows what a diff or a commit is; an adapter does. A submission
 * hands the compiled stage's declared artifact kind to `artifactAdapterFor`, and the adapter
 * it returns owns everything specific to that kind: how to capture it without disturbing the
 * member, how its locator is spelled, how to re-materialize bounded evidence on demand, how to
 * prove its private ref still resolves, and how to put it back. First and only implementation
 * is `git_snapshot` (`commit`); the rest of the append-only kind list is declared here as `null`
 * so appending an adapter later never widens the member, stage or artifact tables.
 *
 * The split from the capture SERVICE (`submission.ts`) is deliberate: an adapter produces the
 * OBSERVED half of an artifact's evidence - git facts nobody's claim can contradict - and the
 * service assembles the member's REPORTED claims around it, labelled as claims. Neither half may
 * be read as the other.
 */

/** Where the bytes live and what they are, in the adapter's own versioned shape. */
export type ArtifactLocator = EnsembleJson;

/** What one capture produced: a locator, a content fingerprint, and observed git evidence. */
export interface CapturedArtifact {
  /** The adapter's versioned locator - a ref, a commit, a path. Never the bytes. */
  locator: ArtifactLocator;
  /** Content digest, so a later read can prove it is the same artifact. */
  fingerprint: string;
  /** Observed facts about the captured work. Assembled into evidence by the caller. */
  observed: EnsembleJson;
}

export interface ArtifactCaptureInput {
  /** The run, which is also the ref namespace. A generated UUID. */
  runId: string;
  /** The artifact's own id, which is also its ref component. A generated UUID. */
  artifactId: string;
  /** The member's live worktree, read but never written. */
  worktreePath: string;
  /** The run's pinned base, the other end of the exact diff this artifact reports. */
  baseSha: string;
  /** Cap for any patch this capture materializes for its own evidence. */
  maxPatchBytes?: number;
}

export interface ArtifactRecoveryInput {
  runId: string;
  artifactId: string;
  repoPath: string;
  baseSha: string;
  maxPatchBytes?: number;
}

/** Bounded, on-demand evidence for one ready artifact - re-derived, never stored. */
export interface ArtifactMaterialization {
  files: Array<{
    path: string;
    oldPath: string | null;
    insertions: number;
    deletions: number;
    binary: boolean;
  }>;
  filesChanged: number;
  insertions: number;
  deletions: number;
  /** The patch, up to the caller's budget. */
  patch: string;
  truncated: boolean;
  omittedBytes: number;
}

export interface ArtifactAdapter {
  kind: EnsembleArtifactKind;
  /** Append-only per kind. Persisted on the artifact row so a later build knows this shape. */
  formatVersion: number;
  /** Turn a member's worktree into an immutable artifact WITHOUT disturbing it. */
  capture(input: ArtifactCaptureInput): Promise<CapturedArtifact>;
  recover(input: ArtifactRecoveryInput): Promise<CapturedArtifact | null>;
  /** Re-derive bounded evidence from a ready locator. Reads the immutable artifact, never a live worktree. */
  materialize(
    locator: ArtifactLocator,
    input: { repoPath: string; maxPatchBytes?: number },
  ): Promise<ArtifactMaterialization>;
  /** Whether the artifact's private ref still resolves to exactly the commit it recorded. */
  verify(locator: ArtifactLocator, input: { repoPath: string }): Promise<boolean>;
  /** Put the artifact back into a worktree, exactly. */
  restore(locator: ArtifactLocator, input: { worktreePath: string }): Promise<void>;
}

/** A typed, exhaustive registry keyed by artifact kind. `null` is "no adapter yet". */
export type ArtifactAdapterRegistry = Record<EnsembleArtifactKind, ArtifactAdapter | null>;
