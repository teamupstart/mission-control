import type { WorkflowContextSnapshot } from "./workflow.ts";

type Evidence = WorkflowContextSnapshot["evidence"];

/** A projection is usable only with a retained receipt for every omitted artifact. */
export function workflowPublicationRetained(evidence: Evidence): boolean {
  return !!evidence.publication && evidence.publication.localArtifacts.every((local) =>
    evidence.artifacts?.some((artifact) => artifact.displayName === local.path
      && artifact.sha256 === local.sha256 && artifact.bytes === local.bytes
      && artifact.availability === "retained"));
}

export function workflowPublicationTree(evidence: Evidence): string | null {
  return workflowPublicationRetained(evidence)
    ? evidence.publication!.treeOid : evidence.contentTreeOid ?? null;
}

export function workflowHasUnpublishedChanges(evidence: Evidence): boolean {
  return workflowPublicationRetained(evidence)
    ? evidence.publication!.pathsTruncated || evidence.publication!.unpublishedPaths.length > 0
    : evidence.workingTreeDirty;
}
