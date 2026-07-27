import { z } from "zod";
import { run } from "../../util/exec.ts";
import {
  DEFAULT_MAX_PATCH_BYTES,
  captureWorktreeSnapshot,
  ensembleSnapshotRef,
  materializeSnapshotDiff,
  resolveEnsembleRef,
  restoreSnapshotIntoWorktree,
} from "../../git/ensemble-snapshot.ts";
import type {
  ArtifactAdapter,
  ArtifactCaptureInput,
  ArtifactLocator,
  ArtifactMaterialization,
  ArtifactRecoveryInput,
  CapturedArtifact,
} from "./types.ts";

/**
 * The `commit` artifact: a member's whole worktree, captured as an immutable private Git commit.
 *
 * All the delicate Git work lives one level down in `src/server/git/ensemble-snapshot.ts` - the
 * temporary-index capture that leaves the member's own index and branch byte-identical, the exact
 * base-to-snapshot diff, and the reset-to-commit restore. This adapter is the thin, kind-specific
 * shell around it: it names the locator shape, decides which git facts count as OBSERVED evidence,
 * and re-derives that evidence on demand from the immutable commit rather than a live worktree.
 */

const FORMAT_VERSION = 1;

/** The empty tree, so an unborn-branch snapshot can still report whether it holds anything. */
const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const SHA = /^[0-9a-f]{40}$/;

/**
 * The versioned locator, validated on the way back out.
 *
 * Parsed rather than cast because a locator read from SQLite has crossed a trust boundary and a
 * malformed one must fail its own detail read, not send a bad ref name to `update-ref` three calls
 * later. `formatVersion` is a literal so a future shape is unreadable here rather than half-parsed.
 */
const GitSnapshotLocatorSchema = z.object({
  kind: z.literal("git_snapshot"),
  formatVersion: z.literal(FORMAT_VERSION),
  ref: z.string().min(1),
  snapshotSha: z.string().regex(SHA),
  baseSha: z.string().regex(SHA),
  parentSha: z.string().regex(SHA).nullable(),
  treeSha: z.string().regex(SHA),
});
type GitSnapshotLocator = z.infer<typeof GitSnapshotLocatorSchema>;

function parseLocator(locator: ArtifactLocator): GitSnapshotLocator {
  const parsed = GitSnapshotLocatorSchema.safeParse(locator);
  if (!parsed.success) throw new Error(`git_snapshot locator is unreadable: ${parsed.error.message}`);
  return parsed.data;
}

/**
 * Whether the captured tree differs from the member's HEAD - "did the member have uncommitted
 * work when it submitted". One cheap comparison of trees rather than a re-diff: an unborn branch
 * is dirty exactly when its tree is not the empty tree, and any other HEAD is dirty exactly when
 * its tree is not the snapshot's.
 */
async function computeDirty(
  worktreePath: string,
  parentSha: string | null,
  treeSha: string,
): Promise<boolean> {
  if (parentSha === null) return treeSha !== EMPTY_TREE_SHA;
  const parentTree = await run("git", ["-C", worktreePath, "rev-parse", `${parentSha}^{tree}`]);
  const resolved = parentTree.stdout.trim();
  // If we cannot read the parent's tree, report dirty rather than a false clean: a false clean is
  // the reading that would let a submission look pristine when it was not.
  if (parentTree.code !== 0 || !SHA.test(resolved)) return true;
  return resolved !== treeSha;
}

async function capture(input: ArtifactCaptureInput): Promise<CapturedArtifact> {
  const snapshot = await captureWorktreeSnapshot({
    worktreePath: input.worktreePath,
    ensembleId: input.runId,
    artifactId: input.artifactId,
  });
  const diff = await materializeSnapshotDiff({
    repoPath: input.worktreePath,
    baseSha: input.baseSha,
    snapshotSha: snapshot.snapshotSha,
    maxPatchBytes: input.maxPatchBytes ?? DEFAULT_MAX_PATCH_BYTES,
  });
  const dirty = await computeDirty(input.worktreePath, snapshot.parentSha, snapshot.treeSha);

  const locator: GitSnapshotLocator = {
    kind: "git_snapshot",
    formatVersion: FORMAT_VERSION,
    ref: snapshot.ref,
    snapshotSha: snapshot.snapshotSha,
    baseSha: input.baseSha,
    parentSha: snapshot.parentSha,
    treeSha: snapshot.treeSha,
  };

  // The patch itself is deliberately absent from `observed` - it never enters SQLite, and the
  // detail route re-materializes it on demand. What is stored is the honest, bounded shape of the
  // change: counts, binary markers, and the truncation disclosure that goes with them.
  const observed = {
    headSha: snapshot.parentSha,
    baseSha: input.baseSha,
    snapshotSha: snapshot.snapshotSha,
    treeSha: snapshot.treeSha,
    ref: snapshot.ref,
    dirty,
    filesChanged: diff.filesChanged,
    insertions: diff.insertions,
    deletions: diff.deletions,
    binaryFiles: diff.files.filter((file) => file.binary).length,
    patchTruncated: diff.truncated,
    patchOmittedBytes: diff.omittedBytes,
  };

  return { locator, fingerprint: snapshot.treeSha, observed };
}

async function recover(input: ArtifactRecoveryInput): Promise<CapturedArtifact | null> {
  const ref = ensembleSnapshotRef(input.runId, input.artifactId);
  const snapshotSha = await resolveEnsembleRef(input.repoPath, ref);
  if (!snapshotSha) return null;
  const shape = await run("git", ["-C", input.repoPath, "show", "-s", "--format=%T%n%P", snapshotSha]);
  if (shape.code !== 0) return null;
  const [treeSha, parents = ""] = shape.stdout.trim().split("\n");
  const parentSha = parents.split(" ").filter(Boolean)[0] ?? null;
  if (!treeSha || !SHA.test(treeSha) || (parentSha !== null && !SHA.test(parentSha))) return null;
  const diff = await materializeSnapshotDiff({
    repoPath: input.repoPath,
    baseSha: input.baseSha,
    snapshotSha,
    maxPatchBytes: input.maxPatchBytes ?? DEFAULT_MAX_PATCH_BYTES,
  });
  const dirty = await computeDirty(input.repoPath, parentSha, treeSha);
  const locator: GitSnapshotLocator = {
    kind: "git_snapshot",
    formatVersion: FORMAT_VERSION,
    ref,
    snapshotSha,
    baseSha: input.baseSha,
    parentSha,
    treeSha,
  };
  return {
    locator,
    fingerprint: treeSha,
    observed: {
      headSha: parentSha,
      baseSha: input.baseSha,
      snapshotSha,
      treeSha,
      ref,
      dirty,
      filesChanged: diff.filesChanged,
      insertions: diff.insertions,
      deletions: diff.deletions,
      binaryFiles: diff.files.filter((file) => file.binary).length,
      patchTruncated: diff.truncated,
      patchOmittedBytes: diff.omittedBytes,
    },
  };
}

async function materialize(
  locator: ArtifactLocator,
  input: { repoPath: string; maxPatchBytes?: number; paths?: string[]; patch?: boolean },
): Promise<ArtifactMaterialization> {
  const parsed = parseLocator(locator);
  // `paths` and `patch` are passed straight down: the primitive owns the `--` separation, the
  // literal-pathspec env and the per-path refusal, because it is the one place that builds the
  // argv. Duplicating any of that here would be a second answer that agrees only by luck.
  const diff = await materializeSnapshotDiff({
    repoPath: input.repoPath,
    baseSha: parsed.baseSha,
    snapshotSha: parsed.snapshotSha,
    maxPatchBytes: input.maxPatchBytes ?? DEFAULT_MAX_PATCH_BYTES,
    paths: input.paths,
    patch: input.patch,
  });
  return {
    files: diff.files,
    filesChanged: diff.filesChanged,
    insertions: diff.insertions,
    deletions: diff.deletions,
    patch: diff.patch,
    truncated: diff.truncated,
    omittedBytes: diff.omittedBytes,
    patchPaths: diff.patchPaths,
  };
}

async function verify(locator: ArtifactLocator, input: { repoPath: string }): Promise<boolean> {
  const parsed = parseLocator(locator);
  const resolved = await resolveEnsembleRef(input.repoPath, parsed.ref);
  return resolved === parsed.snapshotSha;
}

async function restore(locator: ArtifactLocator, input: { worktreePath: string }): Promise<void> {
  const parsed = parseLocator(locator);
  await restoreSnapshotIntoWorktree({
    worktreePath: input.worktreePath,
    ref: parsed.ref,
    snapshotSha: parsed.snapshotSha,
  });
}

export const gitSnapshotAdapter: ArtifactAdapter = {
  kind: "commit",
  formatVersion: FORMAT_VERSION,
  capture,
  recover,
  materialize,
  verify,
  restore,
};

/** The commit an artifact's ready locator points at, for a caller that only needs the sha. */
export function gitSnapshotSnapshotSha(locator: ArtifactLocator): string {
  return parseLocator(locator).snapshotSha;
}
